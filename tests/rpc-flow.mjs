// oxy-flow 세션 넘기기 점검 (pi RPC 모드)
//   node tests/rpc-flow.mjs <pi cli.js> <작업 폴더> <mock 요청 로그>
// 1) 사용량이 큰 응답(57%)을 받은 뒤 2) 새 메시지를 보내면 → 새 세션에서 작업 상태 + 그 메시지로 시작해야 한다.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const [cli, cwd, reqlog] = process.argv.slice(2);
const pi = spawn(process.execPath, [cli, "--mode", "rpc", "--no-session"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
const events = [];
let buf = "";
const send = (m) => pi.stdin.write(JSON.stringify(m) + "\n");
pi.stdout.on("data", (d) => {
  buf += d;
  const lines = buf.split("\n");
  buf = lines.pop();
  for (const l of lines) { try { events.push(JSON.parse(l)); } catch { /* 무시 */ } }
});
const waitFor = (pred, ms) => new Promise((ok) => {
  const t0 = Date.now();
  const iv = setInterval(() => { const e = events.find(pred); if (e || Date.now() - t0 > ms) { clearInterval(iv); ok(e); } }, 50);
});
const settled = (n) => (e) => e.type === "agent_end" && events.filter((x) => x.type === "agent_end").length >= n;
const text = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => p.text ?? "").join("") : "");

const result = {};
send({ id: "p1", type: "prompt", message: "scenario:flow-half build the report page" });
result.firstTurn = Boolean(await waitFor(settled(1), 30000));
await new Promise((r) => setTimeout(r, 500));
send({ id: "p2", type: "prompt", message: "scenario:env next-step" });
await waitFor(settled(2), 30000);
await new Promise((r) => setTimeout(r, 500));

const reqs = readFileSync(reqlog, "utf8").trim().split("\n").map((l) => JSON.parse(l).body);
const last = reqs.findLast((b) => b.messages.some((m) => m.role === "user" && text(m.content).includes("scenario:env next-step")));
const msgs = last?.messages ?? [];
result.newSession = Boolean(last) && !msgs.some((m) => m.role === "assistant" && text(m.content).includes("half-full"));
result.stateInjected = msgs.some((m) => text(m.content).includes("[oxy-flow] Task state"));
console.log(JSON.stringify(result));
pi.kill();
process.exit(Object.values(result).every(Boolean) ? 0 : 1);
