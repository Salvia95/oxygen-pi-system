// 실제 pi + 실제 모델 시나리오 평가 (run.sh 가 env.sh 를 읽은 뒤 실행한다)
//   node run.mjs <label> [--only a,b] [--model [연결/]모델] [--level id] [--thinking 수준] [--rev git-rev] [--tools a,b,c] [--set K=V]...
//                [--max-calls N] [--minutes N] [--rebuild] [--base-url URL] [--suite base|combo] [--llm-from <agent 폴더>]
// --suite combo: 여러 skill 을 함께 쓰는 상황 시나리오(combo.mjs). 결과는 results-combo.jsonl, 읽은 SKILL.md · 실행한 명령 · 비용을 함께 남긴다.
// --llm-from: LLM 연결(llm.json)과 키(secrets.json, DPAPI)를 이 agent 폴더에서 읽는다 (기본: 저장소 agent/). 예: 설치본의 agent 폴더
// 모델: agent/llm.json 의 LLM 연결 (docs/tui-spec.md §11). 기본은 기본 모델(main). --level 은 그 작업 수준의 연결 · 모델 · thinking.
//   --model 이 연결에 없는 모델이면 스냅샷의 llm.json 에만 더한다. --base-url 은 스냅샷에서 그 연결의 주소만 바꾼다.
//   키는 스냅샷에 복사하지 않는다: 저장소의 secrets.json(DPAPI)에서 한 번 복호화해 pi 에 OXY_LLM_INHERIT_KEYS 로 넘기고 pi 가 받자마자 지운다.
// label 마다 agent 구성을 임시 폴더에 한 번 만들어 두고(스냅샷) 그 구성으로 시나리오를 돌린다.
//   기본은 "지금 작업 트리", --rev 를 주면 그 커밋의 agent/ (bin 은 git 에 없으므로 작업 트리 것).
//   실제 설치와 같은 배치(agent/ 와 vendor/ 가 나란히)가 되도록 pi 패키지의 문서·자원을 <임시>/vendor 아래에 복사하고
//   PI_PACKAGE_DIR 로 그쪽을 가리킨다. (프롬프트에 찍히는 pi 문서 경로가 agent 폴더와 같은 뿌리에 있어야 설치본과 같다)
// 결과는 results.jsonl 에 한 줄씩 추가하며, 같은 label+model+scenario 가 이미 있으면 건너뛴다.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeFixture } from "./fixture.mjs";
import { SCENARIOS } from "./scenarios.mjs";
import { COMBO } from "./combo.mjs";
import { scrub } from "./scrub.mjs";
import * as L from "../../scripts/llm-connections.mjs";
import { getSecrets } from "../../installer/secrets.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const WORK = path.join(os.tmpdir(), "oxy-scenario-eval");

const argv = process.argv.slice(2);
const label = argv.shift();
if (!label || label.startsWith("--")) { console.error("usage: run.mjs <label> [options]"); process.exit(2); }
const opt = { only: null, model: null, level: null, thinking: null, tools: null, set: {}, minutes: null, rebuild: false, baseUrl: null, rev: null, maxCalls: null, suite: "base", llmFrom: null };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--only") opt.only = argv[++i].split(",");
  else if (a === "--model") opt.model = argv[++i];
  else if (a === "--level") opt.level = argv[++i];
  else if (a === "--thinking") opt.thinking = argv[++i];
  else if (a === "--tools") opt.tools = argv[++i].split(",");
  else if (a === "--set") { const [k, ...v] = argv[++i].split("="); opt.set[k] = v.join("="); }
  else if (a === "--minutes") opt.minutes = Number(argv[++i]);
  else if (a === "--rebuild") opt.rebuild = true;
  else if (a === "--rev") opt.rev = argv[++i];
  else if (a === "--max-calls") opt.maxCalls = Number(argv[++i]);
  else if (a === "--base-url") opt.baseUrl = argv[++i];
  else if (a === "--suite") opt.suite = argv[++i];
  else if (a === "--llm-from") opt.llmFrom = argv[++i];
  else { console.error(`unknown option ${a}`); process.exit(2); }
}

if (!["base", "combo"].includes(opt.suite)) { console.error(`unknown suite ${opt.suite} (base | combo)`); process.exit(2); }
const COMBO_SUITE = opt.suite === "combo";
// 여러 단계 작업이라 도구 호출 · 시간 한도를 넉넉히 (기본 suite 는 예전 값 그대로)
opt.maxCalls ??= COMBO_SUITE ? 25 : 8;
opt.minutes ??= COMBO_SUITE ? 40 : 8;
const RESULTS = path.join(HERE, COMBO_SUITE ? "results-combo.jsonl" : "results.jsonl");
const LLM_SRC = path.resolve(opt.llmFrom ?? path.join(ROOT, "agent"));
const fwd = (p) => p.replace(/\\/g, "/");
const T = path.join(WORK, label);
const AGENT = path.join(T, "agent");
const VENDOR = path.join(T, "vendor");
const msys = (p) => fwd(p).replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
const TRACKED = ["AGENTS.md", "templates", "extensions", "skill-library", "agents"];
const PI_PKG = path.resolve(process.env.OXY_PI_CLI, "../../..");
const PI_PKG_COPY = path.join(VENDOR, path.relative(path.join(ROOT, "vendor"), PI_PKG));

function build() {
  if (fs.existsSync(path.join(T, "meta.json")) && !opt.rebuild) return JSON.parse(fs.readFileSync(path.join(T, "meta.json"), "utf8"));
  fs.rmSync(T, { recursive: true, force: true });
  fs.mkdirSync(AGENT, { recursive: true });
  if (opt.rev) {
    const cmd = `git -C "${msys(ROOT)}" archive "${opt.rev}" ${TRACKED.map((n) => `agent/${n}`).join(" ")} | tar -x -C "${msys(T)}"`;
    const a = spawnSync("bash", ["-c", `set -o pipefail; ${cmd}`], { encoding: "utf8" });
    if (a.status !== 0) { console.error(a.stdout, a.stderr); throw new Error("git archive 실패"); }
  } else {
    for (const n of TRACKED) fs.cpSync(path.join(ROOT, "agent", n), path.join(AGENT, n), { recursive: true });
  }
  fs.cpSync(path.join(ROOT, "agent/bin"), path.join(AGENT, "bin"), { recursive: true });
  fs.cpSync(PI_PKG, PI_PKG_COPY, { recursive: true, filter: (src) => path.basename(src) !== "node_modules" });
  // LLM 연결은 llm.json 을 그대로 쓴다 (키는 복사하지 않는다). oxy.env 에 예전 LLM 값이 남아 있으면 스냅샷에서 옮겨지지 않게 뺀다
  const llm = L.loadLlm(LLM_SRC);
  if (!llm) throw new Error("agent/llm.json 이 없음 → just configure 또는 tweak.cmd 의 LLM 연결에서 연결을 등록하세요");
  L.saveLlm(AGENT, llm);
  const envText = fs.existsSync(path.join(ROOT, "agent/oxy.env")) ? fs.readFileSync(path.join(ROOT, "agent/oxy.env"), "utf8") : "";
  fs.writeFileSync(path.join(AGENT, "oxy.env"), L.removeEnvKeys(envText, L.LEGACY_ENV_KEYS));
  const tools = configure(opt.tools);
  const git = (...a) => spawnSync("git", ["-C", ROOT, ...a], { encoding: "utf8" }).stdout.trim();
  const meta = { label, builtAt: new Date().toISOString(), head: git("rev-parse", "--short", opt.rev ?? "HEAD"), dirty: opt.rev ? "" : git("status", "--short"), tools, toolsOverride: opt.tools, set: opt.set };
  fs.writeFileSync(path.join(T, "meta.json"), JSON.stringify(meta, null, 2));
  return meta;
}

// 스냅샷의 templates + oxy.env 로 settings.json / models.json 을 만든다. 도구 목록을 바꾸는 실험이면 그 뒤에 덮어쓴다.
function configure(toolsOverride) {
  const r = spawnSync("bash", [fwd(path.join(ROOT, "scripts/configure.sh"))], { env: { ...process.env, OXY_AGENT_DIR: fwd(AGENT) }, encoding: "utf8" });
  if (r.status !== 0) { console.error(r.stdout, r.stderr); throw new Error("configure 실패"); }
  const sp = path.join(AGENT, "settings.json");
  const settings = JSON.parse(fs.readFileSync(sp, "utf8"));
  if (toolsOverride) { settings.defaultTools = toolsOverride; fs.writeFileSync(sp, JSON.stringify(settings, null, 2)); }
  return settings.defaultTools;
}

/**
 * 이번 실행의 대상: --level → 그 수준, --model [연결/]모델 → 그 연결(연결을 안 쓰면 모델이 있는 첫 연결), 없으면 기본 모델.
 * 연결에 없는 모델이면 스냅샷 llm.json 에만 더하고(길이는 그 연결의 첫 모델과 같게) 설정을 다시 만든다. --base-url 도 스냅샷에만.
 */
function resolveTarget(meta) {
  const llm = L.loadLlm(AGENT);
  let conn, model, thinking;
  if (opt.level) {
    const r = L.resolveLevel(llm, opt.level);
    if (!r) throw new Error(`작업 수준 ${opt.level} 이 없음 (있는 것: ${(llm.levels ?? []).map((l) => l.id).join(", ")})`);
    conn = L.findConnection(llm, r.connection); model = r.id; thinking = r.thinking;
  } else if (opt.model) {
    const i = opt.model.indexOf("/");
    const named = i > 0 ? L.findConnection(llm, opt.model.slice(0, i)) : null;
    model = named ? opt.model.slice(i + 1) : opt.model;
    conn = named ?? llm.connections.find((c) => L.findModel(c, model)) ?? L.findConnection(llm, llm.main?.connection);
    thinking = conn && L.findModel(conn, model) && llm.main?.model === model ? llm.main.thinking : "off";
  } else {
    conn = L.findConnection(llm, llm.main?.connection); model = llm.main?.model; thinking = llm.main?.thinking;
  }
  if (!conn || !model) throw new Error("대상 연결 · 모델을 정하지 못함 (llm.json 의 기본 모델 확인)");
  if (opt.thinking) thinking = opt.thinking;
  let changed = false;
  if (!L.findModel(conn, model)) {
    const first = conn.models?.[0] ?? { contextWindow: 131072, maxOutput: 16384 };
    conn.models = [...(conn.models ?? []), { id: model, ...(L.LLM_KINDS[conn.kind].catalog === "families" ? { family: L.detectFamily(model) } : {}),
      contextWindow: first.contextWindow, maxOutput: first.maxOutput }];
    changed = true;
  }
  if (opt.baseUrl && conn.baseUrl !== opt.baseUrl) { conn.baseUrl = opt.baseUrl; changed = true; }
  if (changed) { L.saveLlm(AGENT, llm); configure(meta.toolsOverride); }
  return { connection: conn.id, provider: L.providerId(conn.id), model, thinking: thinking || "off",
    key: `${conn.id}/${model}${thinking && thinking !== "off" ? `:${thinking}` : ""}` };
}

/** 키: 저장소 secrets.json 에서 한 번 복호화해 pi 에만 넘긴다 (스냅샷 · 결과 파일 · 화면에는 남기지 않는다) */
function inheritKeys() {
  const llm = L.loadLlm(AGENT);
  const keys = getSecrets(LLM_SRC, llm.connections.map((c) => L.secretKey(c.id)));
  return Object.keys(keys).length ? Buffer.from(JSON.stringify(keys)).toString("base64") : "";
}

const textOf = (content) => typeof content === "string" ? content : (content ?? []).filter((c) => c?.type === "text").map((c) => c.text).join("");
const short = (v, n = 160) => { const s = (typeof v === "string" ? v : JSON.stringify(v)).replace(/org_[A-Za-z0-9]+/g, "org_***"); return s.length > n ? `${s.slice(0, n)}…` : s; };

function runPi(prompt, cwd, eventsFile) {
  return new Promise((resolve) => {
    const args = [process.env.OXY_PI_CLI, "--no-session", "--mode", "json", "--provider", target.provider, "--model", target.model, "--thinking", target.thinking, prompt];
    // 시험 조건: oxy-flow 끔(추가 턴 방지), 도구 출력 상한을 낮춤(Groq 분당 8000 토큰 = 요청 1건 크기 제한 때문). 모든 구성에 동일.
    const env = { ...process.env, PI_CODING_AGENT_DIR: fwd(AGENT), OXY_FLOW: "off", OXY_TOOL_OUTPUT_MAX_CHARS: "4000", OXY_READ_MAX_CHARS: "6000",
      PI_PACKAGE_DIR: fwd(PI_PKG_COPY), ...(keysB64 ? { OXY_LLM_INHERIT_KEYS: keysB64 } : {}), ...meta.set, ...opt.set };
    const child = spawn(process.env.OXY_NODE, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const out = fs.createWriteStream(eventsFile);
    const m = { requests: 0, inTok: 0, outTok: 0, firstIn: 0, cost: 0, calls: [], reads: [], cmds: [], retries: [], errors: [], text: "", timedOut: false, capped: false };
    const pending = new Map();
    let buf = "", stderr = "";
    const onEvent = (e) => {
      if (e.type === "message_end" && e.message?.role === "assistant") {
        const u = e.message.usage ?? {};
        if (u.input > 0 || u.output > 0) {
          const inN = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);   // Claude 는 프롬프트 캐시에 쓴 몫이 cacheWrite 로 따로 온다
          m.requests++; m.inTok += inN; m.outTok += u.output ?? 0;
          if (!m.firstIn) m.firstIn = inN;
          m.cost += Number(u.cost?.total ?? 0) || 0;
        }
        if (e.message.errorMessage) m.errors.push(short(e.message.errorMessage, 300));
        const t = textOf(e.message.content);
        if (t.trim()) m.text = t;
      } else if (e.type === "tool_execution_start") {
        pending.set(e.toolCallId, { name: e.toolName, args: short(e.args, 240) });
        if (e.toolName === "read") m.reads.push(String(e.args?.path ?? e.args?.file_path ?? ""));
        if (e.toolName === "bash") m.cmds.push(String(e.args?.command ?? ""));
        // 헤매는 실행이 하루 토큰 한도를 다 쓰지 않게 도구 호출 수에 상한을 둔다 (상한에 걸리면 실패로 기록)
        if (m.calls.length >= opt.maxCalls) { m.capped = true; child.kill(); }
      } else if (e.type === "tool_execution_end") {
        const c = pending.get(e.toolCallId) ?? { name: e.toolName, args: "" };
        const t = textOf(e.result?.content);
        const om = t.match(/\[oxy: (\d+) characters omitted/);
        m.calls.push({ ...c, out: t.length, raw: t.length + (om ? Number(om[1]) : 0), err: !!e.isError, head: short(t.replace(/\s+/g, " "), 120) });
      } else if (e.type === "auto_retry_start") {
        m.retries.push(short(e.errorMessage ?? "", 160));
      }
    };
    child.stdout.on("data", (d) => {
      out.write(d);
      buf += d.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, ""); buf = buf.slice(i + 1);
        if (!line) continue;
        try { onEvent(JSON.parse(line)); } catch { /* 깨진 줄은 무시 */ }
      }
    });
    child.stderr.on("data", (d) => { stderr += d.toString("utf8"); });
    const timer = setTimeout(() => { m.timedOut = true; child.kill(); }, 7 * 60 * 1000);
    child.on("close", (code) => {
      clearTimeout(timer); out.end();
      if (code !== 0 && !m.capped && !m.timedOut) m.errors.push(`exit ${code}: ${short(stderr.trim().split("\n").slice(-3).join(" | "), 300)}`);
      resolve(m);
    });
  });
}

const done = new Set(fs.existsSync(RESULTS)
  ? fs.readFileSync(RESULTS, "utf8").split("\n").filter(Boolean).map((l) => { const r = JSON.parse(l); return `${r.label}|${r.model}|${r.scenario}`; })
  : []);

const meta = build();
const target = resolveTarget(meta);
const keysB64 = inheritKeys();
console.log(`[${label}] tools=${meta.tools.join(",")} model=${target.key}`);
const started = Date.now();
const SUITE = COMBO_SUITE ? COMBO : SCENARIOS;
const todo = SUITE.filter((s) => (!opt.only || opt.only.includes(s.id)) && !done.has(`${label}|${target.key}|${s.id}`));
for (const [i, s] of todo.entries()) {
  if ((Date.now() - started) / 60000 > opt.minutes) { console.log(`시간 한도(${opt.minutes}분) → 남은 ${todo.length - i}건은 다음 실행에서`); break; }
  if (i > 0) await new Promise((r) => setTimeout(r, 15000));
  const dir = path.join(T, `work-${s.id}`);
  let ctx = {};
  if (s.setup) { fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true }); ctx = (await s.setup(dir, ROOT)) ?? {}; }
  else makeFixture(dir);
  spawnSync("git", ["init", "-q"], { cwd: dir });
  const prompt = typeof s.prompt === "function" ? s.prompt(ctx) : s.prompt;
  const t0 = Date.now();
  const m = await runPi(prompt, dir, path.join(T, `events-${s.id}.jsonl`));
  let verdict;
  try { verdict = await s.check({ text: m.text, dir, calls: m.calls, ctx }); } catch (e) { verdict = { pass: false, note: `check 오류: ${e.message}` }; }
  try { ctx.close?.(); } catch { /* 이미 닫힘 */ }
  const usage = s.skills ? skillUsage(s.skills, m) : null;
  // 한도 초과로 끝난 실행은 판정하지 않는다 (다시 돌릴 수 있게 기록하지 않음)
  const quota = m.errors.some((e) => /429|rate limit|Request too large|413/i.test(e)) && !m.text;
  const rec = {
    label, model: target.key, scenario: s.id, group: s.group, tools: meta.tools, at: new Date().toISOString(),
    pass: verdict.pass && !m.capped, note: m.capped ? `도구 호출 ${opt.maxCalls}회 상한에서 중단` : verdict.note, requests: m.requests, firstIn: m.firstIn, inTok: m.inTok, outTok: m.outTok,
    toolOut: m.calls.reduce((a, c) => a + c.out, 0), toolRaw: m.calls.reduce((a, c) => a + c.raw, 0),
    calls: m.calls, retries: m.retries.length, errors: m.errors, timedOut: m.timedOut, capped: m.capped, seconds: Math.round((Date.now() - t0) / 1000),
    cost: Number(m.cost.toFixed(5)), ...(usage ? { skills: usage, skillsUsed: usage.filter((u) => u.ran).length, skillsExpected: usage.length } : {}),
    text: short(m.text, 600),
  };
  if (usage) console.log(`         skills ${usage.map((u) => `${u.skill}:${u.read ? "읽음" : "-"}/${u.ran ? "실행" : "-"}`).join(" ")} cost=${rec.cost}`);
  console.log(`${s.id.padEnd(6)} ${rec.pass ? "PASS" : "FAIL"} req=${rec.requests} in=${rec.inTok} first=${rec.firstIn} toolOut=${rec.toolOut}/${rec.toolRaw} ${rec.seconds}s | ${m.calls.map((c) => `${c.name}${c.err ? "!" : ""}`).join(",") || "-"} | ${rec.note}${m.errors.length ? ` | ERR ${short(m.errors[0], 200)}` : ""}`);
  if (quota) { console.log("  → 한도 오류로 끝남: 기록하지 않음"); if (/tokens per day|TPD/i.test(m.errors.join(" "))) break; continue; }
  fs.appendFileSync(RESULTS, scrub(JSON.stringify(rec)) + "\n");
}

/**
 * skill 마다 쓴 흔적: read = 그 skill 의 SKILL.md 를 읽음, ran = 그 skill 의 명령을 bash 로 실행함 (명령 머리 낱말로 판정).
 * 판정의 기준은 ran 이다 (읽지 않고 바로 써도 쓴 것). docs/skill-combo-spec.md §3
 */
function skillUsage(skills, m) {
  const BIN = { "sql-querying": ["usql"], "json-querying": ["jq"], "http-api-testing": ["hurl"], "structural-code-search": ["ast-grep", "sg"],
    "project-task-running": ["just"], "find-code": ["rg", "fd"], "web-page-reading": ["obscura"], "web-page-automation": ["agent-browser"],
    "terminal-session-control": ["psmux"], "github-workflow": ["gh"], "gitlab-workflow": ["glab"], "oracle-db-querying": ["sql"] };
  const heads = new Set();
  for (const c of m.cmds) {
    for (const seg of c.split(/&&|\|\||[;|\n]|\$\(|`/)) {
      const words = seg.trim().split(/\s+/).filter((w) => !/^[A-Z_][A-Z0-9_]*=/.test(w));
      const w = (words[0] ?? "").replace(/^.*[\\/]/, "").replace(/\.exe$/i, "");
      if (w) heads.add(w);
    }
  }
  return skills.map((skill) => ({ skill, read: m.reads.some((r) => new RegExp(`skills[\\\\/]${skill}[\\\\/]SKILL\\.md$`, "i").test(r)),
    ran: (BIN[skill] ?? []).some((b) => heads.has(b)) }));
}
