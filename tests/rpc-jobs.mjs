// oxy-jobs 대화형 경로 점검 (pi RPC 모드: hasUI=true, extension UI 호출이 이벤트로 나온다)
//   node tests/rpc-jobs.mjs <pi cli.js> <작업 폴더>     (PI_CODING_AGENT_DIR·mock vLLM 은 호출한 쪽에서 준비)
// 확인: 작업 패널(setWidget)·상태줄(setStatus) 표시 / 작업이 끝나면 sendMessage 로 새 턴 시작 / /jobs → 로그 보기
import { spawn } from "node:child_process";

const [cli, cwd] = process.argv.slice(2);
const pi = spawn(process.execPath, [cli, "--mode", "rpc", "--no-session"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
const events = [];
let buf = "";
const send = (m) => pi.stdin.write(JSON.stringify(m) + "\n");
pi.stdout.on("data", (d) => {
  buf += d;
  const lines = buf.split("\n");
  buf = lines.pop();
  for (const l of lines) {
    let e;
    try { e = JSON.parse(l); } catch { continue; }
    events.push(e);
    if (e.type !== "extension_ui_request") continue;
    // /jobs 메뉴 자동 응답: 작업 선택 → "로그 보기" → 편집기 닫기
    if (e.method === "select" && /^작업/.test(e.title ?? "")) send({ type: "extension_ui_response", id: e.id, value: e.options[0] });
    else if (e.method === "select") send({ type: "extension_ui_response", id: e.id, value: e.options.find((o) => o.startsWith("로그 보기")) });
    else if (e.method === "editor") send({ type: "extension_ui_response", id: e.id, cancelled: true });
    else if (e.method === "confirm") send({ type: "extension_ui_response", id: e.id, confirmed: false });
  }
});
const waitFor = (pred, ms) => new Promise((ok) => {
  const t0 = Date.now();
  const iv = setInterval(() => { const e = events.find(pred); if (e || Date.now() - t0 > ms) { clearInterval(iv); ok(e); } }, 50);
});
const ui = (m) => (e) => e.type === "extension_ui_request" && e.method === m;
const result = {};

send({ id: "p1", type: "prompt", message: "scenario:bg-start" });
result.widgetRunning = Boolean(await waitFor((e) => ui("setWidget")(e) && JSON.stringify(e.widgetLines ?? e).includes("⏳ job-1"), 15000));
result.statusRunning = Boolean(await waitFor((e) => ui("setStatus")(e) && /jobs 1/.test(JSON.stringify(e)), 15000));
// 작업 완료 → sendMessage(triggerTurn) → 모델이 결과를 받아 다시 응답 (mock: "MOCK-DONE user: [oxy-jobs] ...")
result.followUpTurn = Boolean(await waitFor((e) => JSON.stringify(e).includes("MOCK-DONE user: [oxy-jobs] job-1 done"), 30000));
result.widgetDone = Boolean(await waitFor((e) => ui("setWidget")(e) && JSON.stringify(e).includes("✓ job-1"), 15000));

send({ id: "p2", type: "prompt", message: "/jobs" });
const editor = await waitFor(ui("editor"), 15000);
result.jobsLogView = Boolean(editor && JSON.stringify(editor).includes("bg-finished-ok"));

console.log(JSON.stringify(result));
pi.kill();
process.exit(Object.values(result).every(Boolean) ? 0 : 1);
