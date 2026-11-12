// 모니터 프로그램 (모니터 pane 안에서 실행, docs/monitor-spec.md §5). pi 의 extension 으로 로드되지 않는다 (pi 는 폴더의 index.ts 만 로드).
//   node monitor.ts <jobs|flow> --pi-pid <pid> --cwd <폴더>
// 화면은 번들의 pi-tui(TuiAltScreen)로 그리고, 무엇을 그릴지는 view.ts 의 순수 함수가 정한다.
//   jobs: pi 의 실행 폴더(agent/jobs/run-<pid>-*)의 state.json · 로그. 중지는 control/ 요청 (oxy-jobs/state.ts)
//   flow: 프로젝트의 .oxy/flow/flow.json (읽기만)
// pi 가 끝나면(pid 가 사라지면) 스스로 종료한다.
import { existsSync, readFileSync, statSync, watch } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { harnessHome } from "../_lib/common.ts";
import { type JobsState, findRun, readState, sendControl } from "../oxy-jobs/state.ts";
import { projectRoot } from "../oxy-flow/store.ts";
import { type Fit, type FlowLike, type FlowUi, type JobsUi, flowKeys, flowView, jobOrder, jobsView } from "./view.ts";

const args = process.argv.slice(2);
const kind = args[0] === "flow" ? "flow" : "jobs";
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const piPid = Number(opt("--pi-pid"));
const cwd = opt("--cwd") ?? process.cwd();

/** pi 가 살아 있는지 (pid 를 모르면 살아 있는 것으로 본다) */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; }
}

// pane 은 psmux 서버의 환경을 물려받으므로 pi 가 넘긴 인자를 먼저 쓴다
const root = opt("--root") ?? harnessHome(resolve(import.meta.dirname, "..", "..", ".."))!;
const agentDir = opt("--agent") ?? process.env.PI_CODING_AGENT_DIR ?? join(root, "agent");
const tui: any = await import(pathToFileURL(join(root, "vendor", "pi", "node_modules", "@earendil-works", "pi-tui", "dist", "index.js")).href);
const fit: Fit = {
  width: (s) => tui.visibleWidth(s),
  trunc: (s, w) => (tui.visibleWidth(s) <= w ? s : tui.truncateToWidth(s, w, "…")),
  wrap: (s, w) => (s ? tui.wrapTextWithAnsi(s, Math.max(1, w)) : [""]),
};

// ------------------------------------------------------------------ 데이터
let jobs: { runDir: string; state: JobsState } | null = null;
let flow: FlowLike | null = null;
let logLines: string[] = [];
const jobsUi: JobsUi = { sel: 0, mode: "list", scroll: 0 };
const flowUi: FlowUi = { sel: 0, open: new Set() };
let pendingStop: { seq: string; id: string } | null = null;
let flowFile: string | null = null;

function loadJobs() {
  const runDir = findRun(join(agentDir, "jobs"), piPid);
  const state = runDir ? readState(runDir) : null;
  jobs = runDir && state ? { runDir, state } : null;
  if (pendingStop && jobs?.state.control?.seq === pendingStop.seq) {
    jobsUi.notice = jobs.state.control.ok ? `${pendingStop.id} 작업을 중지했습니다.` : `중지하지 못했습니다: ${jobs.state.control.message}`;
    pendingStop = null;
  }
  const sel = currentJob();
  if (jobsUi.mode === "log" && sel && jobs) {
    try { logLines = readFileSync(join(jobs.runDir, sel.log), "utf8").split(/\r?\n/).slice(-500); } catch { logLines = []; }
  }
}

function loadFlow() {
  flowFile ??= join(projectRoot(cwd), ".oxy", "flow", "flow.json");
  try {
    const f = JSON.parse(readFileSync(flowFile, "utf8"));
    flow = { goal: f.goal ?? "", next: f.next, status: f.status, plan: Array.isArray(f.plan) ? f.plan : [], nodes: f.nodes ?? [],
      buffer: { decisions: [], files: [], failures: [], ...f.buffer } };
  } catch { flow = null; }
}

const currentJob = () => (jobs ? jobOrder(jobs.state.jobs)[jobsUi.sel] : undefined);
const reload = () => (kind === "jobs" ? loadJobs() : loadFlow());

// ------------------------------------------------------------------ 화면
const terminal = new tui.ProcessTerminal();
const screen = new tui.TuiAltScreen(terminal, false, undefined, { mouse: false });
const view = {
  render(width: number): string[] {
    const height = Math.max(3, terminal.rows || 24);
    return kind === "jobs" ? jobsView(fit, jobs?.state ?? null, jobsUi, width, height, Date.now(), logLines) : flowView(fit, flow, flowUi, width, height);
  },
  handleInput(data: string) { onKey(data); },
  invalidate() {},
};

function quit() {
  try { screen.stop(); } catch { /* 이미 멈춤 */ }
  process.exit(0);
}

const is = (data: string, key: string) => tui.matchesKey(data, key);

function onKey(data: string) {
  if (is(data, "q") || is(data, "ctrl+c")) return quit();
  if (kind === "jobs") onJobsKey(data); else onFlowKey(data);
  screen.requestRender();
}

function onJobsKey(data: string) {
  const list = jobs ? jobOrder(jobs.state.jobs) : [];
  const j = currentJob();
  jobsUi.notice = undefined;
  if (jobsUi.mode === "confirm") {
    if (is(data, "s") && j && jobs) {
      pendingStop = { seq: sendControl(jobs.runDir, "stop", j.id), id: j.id };
      jobsUi.notice = `${j.id} 작업의 중지를 요청했습니다.`;
    }
    jobsUi.mode = "list";
    return;
  }
  if (jobsUi.mode === "log") {
    if (is(data, "escape") || is(data, "left")) { jobsUi.mode = "list"; jobsUi.scroll = 0; }
    else if (is(data, "up")) jobsUi.scroll += 1;
    else if (is(data, "down")) jobsUi.scroll = Math.max(0, jobsUi.scroll - 1);
    else if (is(data, "pageUp")) jobsUi.scroll += 10;
    else if (is(data, "pageDown")) jobsUi.scroll = Math.max(0, jobsUi.scroll - 10);
    else if (is(data, "end")) jobsUi.scroll = 0;
    else if (is(data, "s") && j && (j.state === "running" || j.state === "queued")) jobsUi.mode = "confirm";
    return;
  }
  if (is(data, "up")) jobsUi.sel = Math.max(0, jobsUi.sel - 1);
  else if (is(data, "down")) jobsUi.sel = Math.min(Math.max(0, list.length - 1), jobsUi.sel + 1);
  else if ((is(data, "enter") || is(data, "right")) && j) { jobsUi.mode = "log"; jobsUi.scroll = 0; loadJobs(); }
  else if (is(data, "s") && j && (j.state === "running" || j.state === "queued")) jobsUi.mode = "confirm";
}

function onFlowKey(data: string) {
  if (!flow) return;
  const keys = flowKeys(flow, flowUi.open);
  if (is(data, "up")) flowUi.sel = Math.max(0, flowUi.sel - 1);
  else if (is(data, "down")) flowUi.sel = Math.min(Math.max(0, keys.length - 1), flowUi.sel + 1);
  else if (is(data, "enter") || is(data, "right") || is(data, "left") || is(data, "space")) {
    const k = keys[flowUi.sel];
    if (k) { if (flowUi.open.has(k)) flowUi.open.delete(k); else flowUi.open.add(k); }
  }
}

// ------------------------------------------------------------------ 시작
reload();
screen.addChild(view);
screen.setFocus(view);
screen.start();
// 파일이 바뀌면 바로, 그 밖에는 1초마다 다시 읽는다 (경과 시간 표시 · watch 가 놓친 변경). pi 가 끝나면 종료
let lastStamp = "";
const stamp = () => {
  try {
    const f = kind === "jobs" ? (jobs ? join(jobs.runDir, "state.json") : "") : flowFile ?? "";
    return f && existsSync(f) ? String(statSync(f).mtimeMs) : "";
  } catch { return ""; }
};
const tick = () => {
  if (!pidAlive(piPid)) return quit();
  reload();
  const s = stamp();
  if (s !== lastStamp || kind === "jobs") { lastStamp = s; screen.requestRender(); }
};
setInterval(tick, 1000);
if (kind === "flow" && flowFile) {
  try { watch(join(flowFile, ".."), () => { reload(); screen.requestRender(); }); } catch { /* 1초 폴링으로 */ }
}
