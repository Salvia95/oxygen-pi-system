// oxy-jobs 대화형 경로 점검 (pi RPC 모드: hasUI=true, extension UI 호출이 이벤트로 나온다)
//   node tests/rpc-jobs.mjs <pi cli.js> <작업 폴더>     (PI_CODING_AGENT_DIR·mock vLLM 은 호출한 쪽에서 준비)
// 확인: 작업 패널(setWidget)·상태줄(setStatus) 표시 / 작업이 끝나면 sendMessage 로 새 턴 시작 / /jobs → 로그 보기
//       모니터용 상태 파일(state.json) 내용 / 모니터 쪽 중지 요청(control/) → 작업 중지 · 결과 기록 · 모델에 알림
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findRun, readState, sendControl } from "../agent/extensions/oxy-jobs/state.ts";

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

// ---------------------------------------------------------------- 모니터용 상태 파일 (docs/monitor-spec.md §3)
const jobsDir = join(process.env.PI_CODING_AGENT_DIR ?? "", "jobs");
const poll = async (fn, ms) => { const t0 = Date.now(); for (;;) { const v = fn(); if (v || Date.now() - t0 > ms) return v; await new Promise((r) => setTimeout(r, 100)); } };
const runDir = await poll(() => findRun(jobsDir, pi.pid), 5000);
// 상태 파일은 변경을 0.25초 단위로 묶어 쓰므로, 화면(위젯)보다 조금 늦게 바뀔 수 있다
const j1 = runDir && await poll(() => { const j = readState(runDir)?.jobs.find((x) => x.id === "job-1"); return j?.state === "done" ? j : null; }, 3000);
result.stateFile = Boolean(j1 && j1.state === "done" && j1.kind === "bash" && j1.task === "sleep 2; echo bg-finished-ok"
  && j1.last === "[exit 0]" && readFileSync(join(runDir, j1.log), "utf8").includes("bg-finished-ok"));

send({ id: "p3", type: "prompt", message: "scenario:bg-long" });
const j2 = await poll(() => { const j = readState(runDir)?.jobs.find((x) => x.id === "job-2"); return j?.state === "running" && j.last === "bg-long-started" ? j : null; }, 15000);
result.stateRunning = Boolean(j2);
const seq = sendControl(runDir, "stop", "job-2");
const ctl = await poll(() => { const s = readState(runDir); return s?.control?.seq === seq ? s : null; }, 5000);
result.monitorStop = Boolean(ctl?.control?.ok && ctl.jobs.find((x) => x.id === "job-2")?.state === "stopped");
result.monitorStopNotice = Boolean(await waitFor((e) => e.type === "extension_ui_request" && e.method === "notify" && JSON.stringify(e).includes("job-2 중지 (모니터)"), 5000));
result.stopReported = Boolean(await waitFor((e) => JSON.stringify(e).includes("MOCK-DONE user: [oxy-jobs] job-2 stopped"), 15000));
const bad = sendControl(runDir, "stop", "job-2");   // 이미 끝난 작업: 실패 결과
result.monitorStopRejected = Boolean(await poll(() => { const c = readState(runDir)?.control; return c?.seq === bad && !c.ok ? c : null; }, 5000));

console.log(JSON.stringify(result));
pi.kill();
process.exit(Object.values(result).every(Boolean) ? 0 : 1);
