// oxy-flow 세션 넘기기 점검: compaction 직후 (사용률을 모를 때) 보낸 메시지 (pi RPC 모드, docs/flow-spec.md §1-6)
//   node tests/rpc-flow.mjs <pi cli.js> <작업 폴더> <mock 요청 로그>
// 1) 여러 턴 뒤 compaction 한다(사용률이 낮아도) 2) 다음 응답 전에 새 메시지를 보내면 → 사용률을 모르므로 새 세션으로 넘겨야 한다 (전에는 넘기지 않았다).
//    작업 폴더 설정의 keepRecentTokens 가 작아야 한다 (e2e 가 50 으로 둔 동안 실행)
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
send({ id: "p1", type: "prompt", message: "scenario:flow-big refactor the parser" });
result.firstTurn = Boolean(await waitFor(settled(1), 30000));
// 응답 뒤 compaction (mock 에서는 응답 직후 자동 compaction 이 일어나지 않아 명령으로 한다). 그 뒤로는 다음 응답 전까지 사용률을 모른다
// 대화를 조금 더 쌓는다 (사용률은 낮다 → 이 메시지는 넘어가지 않는다)
send({ id: "p1b", type: "prompt", message: "scenario:tui-tools more work" });
await waitFor(settled(2), 30000);
await new Promise((r) => setTimeout(r, 500));
send({ id: "c1", type: "compact" });
const c = await waitFor((e) => e.type === "response" && e.id === "c1", 30000);
result.compacted = Boolean(c?.success);
await new Promise((r) => setTimeout(r, 500));
send({ id: "p2", type: "prompt", message: "scenario:env next-step" });
await waitFor(settled(3), 30000);
await new Promise((r) => setTimeout(r, 500));

const reqs = readFileSync(reqlog, "utf8").trim().split("\n").map((l) => JSON.parse(l).body);
const last = reqs.findLast((b) => b.messages.some((m) => m.role === "user" && text(m.content).includes("scenario:env next-step")));
const msgs = last?.messages ?? [];
result.newSession = Boolean(last) && !msgs.some((m) => m.role === "assistant" && text(m.content).includes("tools checked"));
// 시스템 프롬프트에도 같은 말이 있으므로 작업 상태 메시지 자체(맨 앞)를 찾는다
result.stateInjected = msgs.some((m) => text(m.content).trimStart().startsWith("[oxy-flow] Task state"));
// 앞 세션의 마지막 답이 새 세션에 넘어간다 (답의 선택지에 대답하며 넘어가는 경우, docs/flow-spec.md §1-5)
result.lastReplyCarried = msgs.some((m) => text(m.content).includes("You replied: tools checked"));
const injectedText = msgs.map((m) => text(m.content)).find((t) => t.trimStart().startsWith("[oxy-flow] Task state")) ?? "(작업 상태 메시지 없음)";
if (!result.lastReplyCarried) console.error("injected tail: " + injectedText.slice(-400).split("\n").join(" | "));
if (!result.compacted) console.error("compact response: " + JSON.stringify(c ?? null).slice(0, 300));
console.log(JSON.stringify(result));
pi.kill();
process.exit(Object.values(result).every(Boolean) ? 0 : 1);
