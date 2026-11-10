// 실제 pi + 실제 모델 시나리오 평가 (run.sh 가 env.sh 를 읽은 뒤 실행한다)
//   node run.mjs <label> [--only a,b] [--model id] [--rev git-rev] [--tools a,b,c] [--set K=V]... [--max-calls N] [--minutes N] [--rebuild] [--base-url URL]
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
import { scrub } from "./scrub.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const RESULTS = path.join(HERE, "results.jsonl");
const WORK = path.join(os.tmpdir(), "oxy-scenario-eval");

const argv = process.argv.slice(2);
const label = argv.shift();
if (!label || label.startsWith("--")) { console.error("usage: run.mjs <label> [options]"); process.exit(2); }
const opt = { only: null, model: process.env.OXY_DEFAULT_MODEL, tools: null, set: {}, minutes: 8, rebuild: false, baseUrl: null, rev: null, maxCalls: 8 };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--only") opt.only = argv[++i].split(",");
  else if (a === "--model") opt.model = argv[++i];
  else if (a === "--tools") opt.tools = argv[++i].split(",");
  else if (a === "--set") { const [k, ...v] = argv[++i].split("="); opt.set[k] = v.join("="); }
  else if (a === "--minutes") opt.minutes = Number(argv[++i]);
  else if (a === "--rebuild") opt.rebuild = true;
  else if (a === "--rev") opt.rev = argv[++i];
  else if (a === "--max-calls") opt.maxCalls = Number(argv[++i]);
  else if (a === "--base-url") opt.baseUrl = argv[++i];
  else { console.error(`unknown option ${a}`); process.exit(2); }
}

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
  // 키는 복사하지 않는다 (실행 시 환경변수로만 전달)
  let env = fs.readFileSync(path.join(ROOT, "agent/oxy.env"), "utf8").split(/\r?\n/).filter((l) => !/^OXY_VLLM_API_KEY=/.test(l)).join("\n");
  if (opt.baseUrl) env = env.split("\n").filter((l) => !/^OXY_VLLM_BASE_URL=/.test(l)).join("\n") + `\nOXY_VLLM_BASE_URL=${opt.baseUrl}\n`;
  fs.writeFileSync(path.join(AGENT, "oxy.env"), env);
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

// oxy.env 의 두 모델(coder/general) 밖의 모델로 재 보려면 general 자리에 넣고 설정을 다시 만든다
function ensureModel(meta) {
  if (fs.readFileSync(path.join(AGENT, "models.json"), "utf8").includes(`"id": "${opt.model}"`)) return;
  const ep = path.join(AGENT, "oxy.env");
  const env = fs.readFileSync(ep, "utf8").split("\n").filter((l) => !/^OXY_MODEL_GENERAL(_FAMILY)?=/.test(l)).join("\n");
  fs.writeFileSync(ep, `${env.trimEnd()}\nOXY_MODEL_GENERAL=${opt.model}\n`);
  configure(meta.toolsOverride);
}

const textOf = (content) => typeof content === "string" ? content : (content ?? []).filter((c) => c?.type === "text").map((c) => c.text).join("");
const short = (v, n = 160) => { const s = (typeof v === "string" ? v : JSON.stringify(v)).replace(/org_[A-Za-z0-9]+/g, "org_***"); return s.length > n ? `${s.slice(0, n)}…` : s; };

function runPi(prompt, cwd, eventsFile) {
  return new Promise((resolve) => {
    const args = [process.env.OXY_PI_CLI, "--no-session", "--mode", "json", "--model", opt.model, prompt];
    // 시험 조건: oxy-flow 끔(추가 턴 방지), 도구 출력 상한을 낮춤(Groq 분당 8000 토큰 = 요청 1건 크기 제한 때문). 모든 구성에 동일.
    const env = { ...process.env, PI_CODING_AGENT_DIR: fwd(AGENT), OXY_FLOW: "off", OXY_TOOL_OUTPUT_MAX_CHARS: "4000", OXY_READ_MAX_CHARS: "6000",
      PI_PACKAGE_DIR: fwd(PI_PKG_COPY), ...meta.set, ...opt.set };
    const child = spawn(process.env.OXY_NODE, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const out = fs.createWriteStream(eventsFile);
    const m = { requests: 0, inTok: 0, outTok: 0, firstIn: 0, calls: [], retries: [], errors: [], text: "", timedOut: false, capped: false };
    const pending = new Map();
    let buf = "", stderr = "";
    const onEvent = (e) => {
      if (e.type === "message_end" && e.message?.role === "assistant") {
        const u = e.message.usage ?? {};
        if (u.input > 0 || u.output > 0) {
          m.requests++; m.inTok += (u.input ?? 0) + (u.cacheRead ?? 0); m.outTok += u.output ?? 0;
          if (!m.firstIn) m.firstIn = (u.input ?? 0) + (u.cacheRead ?? 0);
        }
        if (e.message.errorMessage) m.errors.push(short(e.message.errorMessage, 300));
        const t = textOf(e.message.content);
        if (t.trim()) m.text = t;
      } else if (e.type === "tool_execution_start") {
        pending.set(e.toolCallId, { name: e.toolName, args: short(e.args, 240) });
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
ensureModel(meta);
console.log(`[${label}] tools=${meta.tools.join(",")} model=${opt.model}`);
const started = Date.now();
const todo = SCENARIOS.filter((s) => (!opt.only || opt.only.includes(s.id)) && !done.has(`${label}|${opt.model}|${s.id}`));
for (const [i, s] of todo.entries()) {
  if ((Date.now() - started) / 60000 > opt.minutes) { console.log(`시간 한도(${opt.minutes}분) → 남은 ${todo.length - i}건은 다음 실행에서`); break; }
  if (i > 0) await new Promise((r) => setTimeout(r, 15000));
  const dir = path.join(T, `work-${s.id}`);
  makeFixture(dir);
  spawnSync("git", ["init", "-q"], { cwd: dir });
  const t0 = Date.now();
  const m = await runPi(s.prompt, dir, path.join(T, `events-${s.id}.jsonl`));
  let verdict;
  try { verdict = s.check({ text: m.text, dir, calls: m.calls }); } catch (e) { verdict = { pass: false, note: `check 오류: ${e.message}` }; }
  // 한도 초과로 끝난 실행은 판정하지 않는다 (다시 돌릴 수 있게 기록하지 않음)
  const quota = m.errors.some((e) => /429|rate limit|Request too large|413/i.test(e)) && !m.text;
  const rec = {
    label, model: opt.model, scenario: s.id, group: s.group, tools: meta.tools, at: new Date().toISOString(),
    pass: verdict.pass && !m.capped, note: m.capped ? `도구 호출 ${opt.maxCalls}회 상한에서 중단` : verdict.note, requests: m.requests, firstIn: m.firstIn, inTok: m.inTok, outTok: m.outTok,
    toolOut: m.calls.reduce((a, c) => a + c.out, 0), toolRaw: m.calls.reduce((a, c) => a + c.raw, 0),
    calls: m.calls, retries: m.retries.length, errors: m.errors, timedOut: m.timedOut, capped: m.capped, seconds: Math.round((Date.now() - t0) / 1000),
    text: short(m.text, 600),
  };
  console.log(`${s.id.padEnd(6)} ${rec.pass ? "PASS" : "FAIL"} req=${rec.requests} in=${rec.inTok} first=${rec.firstIn} toolOut=${rec.toolOut}/${rec.toolRaw} ${rec.seconds}s | ${m.calls.map((c) => `${c.name}${c.err ? "!" : ""}`).join(",") || "-"} | ${rec.note}${m.errors.length ? ` | ERR ${short(m.errors[0], 200)}` : ""}`);
  if (quota) { console.log("  → 한도 오류로 끝남: 기록하지 않음"); if (/tokens per day|TPD/i.test(m.errors.join(" "))) break; continue; }
  fs.appendFileSync(RESULTS, scrub(JSON.stringify(rec)) + "\n");
}
