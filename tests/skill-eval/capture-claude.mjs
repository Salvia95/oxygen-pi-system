// Anthropic(Claude) 판정용 첫 요청 잡기: before(지금) / after(후보 description = SKILL_EVAL_CANDIDATES 또는 candidates.json, 후보 AGENTS.md = SKILL_EVAL_AGENTS 또는 candidate-AGENTS.md 가 있으면) 구성으로
// pi 를 mock-anthropic 에 붙여 첫 /v1/messages 본문을 <variant>-claude-request.json 으로 남긴다. 실제 모델에는 보내지 않는다.
//   node capture-claude.mjs <llm 연결을 읽을 agent 폴더> <연결/모델[:thinking]>    (run-claude.sh 가 env.sh 를 읽은 뒤 부른다)
// 키는 쓰지 않는다: mock 에는 가짜 키 "k" 를 OXY_LLM_INHERIT_KEYS 로 넘긴다.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as L from "../../scripts/llm-connections.mjs";

const E = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(E, "../..");
const [llmFrom, target] = process.argv.slice(2);
if (!llmFrom || !target) { console.error("usage: capture-claude.mjs <agent 폴더> <연결/모델[:thinking]>"); process.exit(2); }
const [connId, rest] = [target.slice(0, target.indexOf("/")), target.slice(target.indexOf("/") + 1)];
const [model, thinking = "off"] = rest.split(":");
const fwd = (p) => p.replace(/\\/g, "/");
const PORT = 18173;
const BODY = path.join(E, "mock-claude-body.jsonl");

fs.writeFileSync(BODY, "");
const mock = spawn(process.env.OXY_NODE, [path.join(ROOT, "tests/mock-anthropic.mjs"), String(PORT), path.join(E, "mock-claude.jsonl")],
  { env: { ...process.env, MOCK_ANTHROPIC_BODY: BODY }, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));
try {
  for (const v of ["before", "after"]) {
    const T = path.join(E, `${v}-claude`);
    fs.rmSync(T, { recursive: true, force: true });
    fs.mkdirSync(path.join(T, "work"), { recursive: true });
    for (const n of ["AGENTS.md", "templates", "bin", "extensions", "skill-library", "agents"]) fs.cpSync(path.join(ROOT, "agent", n), path.join(T, "agent", n), { recursive: true });
    const candAgents = process.env.SKILL_EVAL_AGENTS ?? path.join(E, "candidate-AGENTS.md");
    if (v === "after" && fs.existsSync(candAgents)) fs.copyFileSync(candAgents, path.join(T, "agent", "AGENTS.md"));
    const envText = fs.existsSync(path.join(ROOT, "agent/oxy.env")) ? fs.readFileSync(path.join(ROOT, "agent/oxy.env"), "utf8") : "";
    fs.writeFileSync(path.join(T, "agent", "oxy.env"), L.removeEnvKeys(envText, L.LEGACY_ENV_KEYS));
    const llm = L.loadLlm(path.resolve(llmFrom));
    const conn = L.findConnection(llm, connId);
    if (!conn || !L.findModel(conn, model)) throw new Error(`${connId}/${model} 이 ${llmFrom}/llm.json 에 없음`);
    conn.baseUrl = `http://127.0.0.1:${PORT}`;
    llm.main = { connection: connId, model, thinking };
    L.saveLlm(path.join(T, "agent"), llm);
    const c = spawnSync("bash", [fwd(path.join(ROOT, "scripts/configure.sh"))], { env: { ...process.env, OXY_AGENT_DIR: fwd(path.join(T, "agent")) }, encoding: "utf8" });
    if (c.status !== 0) throw new Error(`configure 실패: ${c.stderr}`);
    if (v === "after") spawnSync(process.env.OXY_NODE, [path.join(E, "apply-desc.mjs"), path.join(T, "agent", "skills")], { stdio: "inherit" });
    const before = fs.readFileSync(BODY, "utf8").split("\n").filter(Boolean).length;
    spawnSync("git", ["init", "-q"], { cwd: path.join(T, "work") });
    const keys = Buffer.from(JSON.stringify({ [L.secretKey(connId)]: "k" })).toString("base64");
    spawnSync(process.env.OXY_NODE, [process.env.OXY_PI_CLI, "--no-session", "--provider", L.providerId(connId), "--model", model, "--thinking", thinking, "-p", "hi"],
      { cwd: path.join(T, "work"), env: { ...process.env, PI_CODING_AGENT_DIR: fwd(path.join(T, "agent")), OXY_LLM_INHERIT_KEYS: keys, OXY_FLOW: "off" }, stdio: "ignore", timeout: 120000 });
    const line = fs.readFileSync(BODY, "utf8").split("\n").filter(Boolean)[before];
    if (!line) throw new Error(`${v}: pi 의 요청을 잡지 못함`);
    const { body, headers } = JSON.parse(line);
    // __headers: pi 가 보낸 anthropic-beta 등 (eval.mjs 가 요청 헤더로 쓰고 본문에서 뺀다). 키는 없다
    fs.writeFileSync(path.join(E, `${v}-claude-request.json`), JSON.stringify({ ...body, __headers: headers }, null, 1));
    const sys = typeof body.system === "string" ? body.system : (body.system ?? []).map((b) => b.text ?? "").join("");
    console.log(`captured ${v}: beta ${headers["anthropic-beta"]}, system ${sys.length}자, skills ${(sys.match(/<name>/g) ?? []).length}개, tools ${(body.tools ?? []).length}개, thinking ${JSON.stringify(body.thinking)} ${JSON.stringify(body.output_config ?? null)}`);
  }
} finally { mock.kill(); }
