// 모니터 프로그램 (모니터 pane 안에서 실행, docs/monitor-spec.md §5 · docs/monitor-tui-spec.md §4). pi 의 extension 으로 로드되지 않는다 (pi 는 폴더의 index.ts 만 로드).
//   node monitor.ts <jobs|flow> --pi-pid <pid> --cwd <폴더> [--agent <agent 폴더>] [--root <하네스>]
// 화면: bin/oxy-tui.exe 가 모니터 모드를 지원하면(--version 에 monitor) 보기 모델(model.ts)을 보내 exe 가 그린다.
//   지원하지 않거나 없으면(예전 번들의 exe) 번들의 pi-tui 로 그린다 (view.ts, M5). OXY_MONITOR_TUI=pi 면 늘 pi-tui.
//   jobs: pi 의 실행 폴더(agent/jobs/run-<pid>-*)의 state.json · 로그. 중지는 control/ 요청 (oxy-jobs/state.ts)
//   flow: 프로젝트의 .oxy/flow/flow.json (읽기만). 두 화면 모두 같은 실행 폴더의 live.json 으로 pi 의 지금 상태를 보인다
// pi 가 끝나면(pid 가 사라지면) 스스로 종료한다.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, watch, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { harnessHome } from "../_lib/common.ts";
import { type JobsState, findRun, readState, readSubStates, sendControl, subRunDir } from "../oxy-jobs/state.ts";
import { flowKeep, projectRoot, readCompleted } from "../oxy-flow/store.ts";
import type { LiveState } from "./live.ts";
import { type FlowHistory, type FlowRequest, type FlowUiState, type JobsUiState, type StopTarget, flowModel, jobOrder, jobsModel, jobsUiInit } from "./model.ts";
import { KEYS, type MonitorKey, flowKeyEx, jobsKey, monitorTheme, supportsMonitor } from "./controller.ts";
import { type Fit, type FlowLike, type FlowUi, type JobsUi, flowKeys, flowView, jobsView } from "./view.ts";

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

// ------------------------------------------------------------------ 데이터 (두 화면 공통)
let jobs: { runDir: string; state: JobsState } | null = null;
let subs = new Map<string, JobsState>();   // subagent 들의 상태 (실행 폴더/sub/<작업 id>, docs/jobs-view-spec.md §3)
let flow: FlowLike | null = null;
let live: LiveState | null = null;
let flowFile: string | null = null;

function loadJobs() {
  const runDir = findRun(join(agentDir, "jobs"), piPid);
  const state = runDir ? readState(runDir) : null;
  jobs = runDir && state ? { runDir, state } : null;
  subs = runDir && kind === "jobs" ? readSubStates(runDir) : new Map();
  live = null;
  if (runDir) { try { live = JSON.parse(readFileSync(join(runDir, "live.json"), "utf8")); } catch { /* 아직 없음 */ } }
}

function loadFlow() {
  flowFile ??= join(projectRoot(cwd), ".oxy", "flow", "flow.json");
  try {
    const f = JSON.parse(readFileSync(flowFile, "utf8"));
    flow = { id: f.id, goal: f.goal ?? "", next: f.next, blocked: f.blocked, status: f.status, plan: Array.isArray(f.plan) ? f.plan : [], nodes: f.nodes ?? [],
      rollbacks: Array.isArray(f.rollbacks) ? f.rollbacks : [],
      buffer: { decisions: [], files: [], failures: [], ...f.buffer } };
  } catch { flow = null; }
  loadHistory();
}

/** Completed Flow (docs/flow-rollback-spec.md §3): archive/ 의 끝난 Flow · oxy-flow 가 쓴 기호(marks.json) · 마지막 되돌리기 결과 */
let history: FlowHistory | null = null;
let rollbackResult: { at: number; ok: boolean; text: string } | null = null;
function loadHistory() {
  if (!flowFile) return;
  const dir = join(flowFile, "..");
  let marks: FlowHistory["marks"] = {};
  try { marks = JSON.parse(readFileSync(join(dir, "marks.json"), "utf8")).flows ?? {}; } catch { /* 아직 없음 */ }
  const completed = readCompleted(dir, flowKeep()).map((x) => ({ id: x.id, goal: x.goal, updatedAt: x.updatedAt, plan: x.plan ?? [] }));
  history = { completed, marks };
  try { rollbackResult = JSON.parse(readFileSync(join(dir, "rollback-result.json"), "utf8")); } catch { rollbackResult = null; }
}

/** 확인한 되돌리기 요청을 pi(oxy-flow)에 넘긴다: .oxy/flow/requests/<시각>.json */
function sendFlowRequest(req: FlowRequest): number {
  const at = Date.now();
  if (!flowFile) return at;
  const dir = join(flowFile, "..", "requests");
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `${at}.tmp`);
    writeFileSync(tmp, JSON.stringify({ ...req, at }));
    renameSync(tmp, join(dir, `${at}.json`));   // 다 쓴 뒤에만 보이게
  } catch { /* 못 쓰면 알림만 */ }
  return at;
}

/** 화면에 필요한 것을 다시 읽는다 (flow 화면도 지금 상태 · 실행 폴더를 위해 jobs 를 읽는다) */
const reload = () => { loadJobs(); if (kind === "flow") loadFlow(); };
const readLog = (id: string | null, sub?: string): string[] => {
  if (!jobs || !id) return [];
  const dir = sub ? subRunDir(jobs.runDir, sub) : jobs.runDir;
  const j = (sub ? subs.get(sub)?.jobs : jobs.state.jobs)?.find((x) => x.id === id);
  if (!j) return [];
  try { return readFileSync(join(dir, j.log), "utf8").split(/\r?\n/).slice(-500); } catch { return []; }
};

// ------------------------------------------------------------------ 시작: 어느 화면으로 그릴지
const exe = join(root, "bin", "oxy-tui.exe");
function exeOk(): boolean {
  if (process.env.OXY_MONITOR_TUI === "pi" || !process.stdout.isTTY || !existsSync(exe)) return false;
  try { return supportsMonitor(spawnSync(exe, ["--version"], { encoding: "utf8", timeout: 5000, windowsHide: true }).stdout ?? ""); } catch { return false; }
}

reload();
if (exeOk()) await runExe(); else await runPiTui();

const NOTICE_MS = 5000;

// ------------------------------------------------------------------ oxy-tui 모니터 모드
async function runExe() {
  const { ExeLink, displayWidth } = await import(pathToFileURL(join(root, "installer", "tui.mjs")).href);
  // 모니터 팔레트: 사용자가 OXY_TUI_THEME 을 정했으면 그것, 아니면 exe 의 기본(Oxygen 세이지) 팔레트
  let settingsText: string | null = null;
  try { settingsText = readFileSync(join(agentDir, "settings.json"), "utf8"); } catch { /* 없음 */ }
  const theme = monitorTheme(settingsText, process.env.OXY_TUI_THEME);
  if (theme) process.env.OXY_TUI_THEME = theme;
  let size = { width: process.stdout.columns || 30, height: process.stdout.rows || 24 };
  let flowUi: FlowUiState = { sel: null, open: new Set(), manualAt: 0 };
  let jobsUi: JobsUiState = jobsUiInit();
  let scroll = 0;
  let pendingStop: { seq: string; target: StopTarget } | null = null;
  let pendingFlow: number | null = null;   // 보낸 되돌리기 요청 시각 (결과를 기다림)
  let flowNoticeAt = 0;
  let notice: { text: string; at: number } | null = null;   // 키 안내 줄의 알림은 잠시만 (docs/jobs-view-spec.md §2)
  let last = "";
  let quitting = false;

  const model = () => {
    const now = Date.now();
    if (kind === "flow") {
      // pi 가 되돌리기를 마치면 결과를 알림 줄에 잠시 보인다
      if (pendingFlow && rollbackResult && rollbackResult.at >= pendingFlow) {
        flowUi = { ...flowUi, notice: rollbackResult.text };
        flowNoticeAt = now;
        pendingFlow = null;
      }
      if (flowUi.notice && now - flowNoticeAt > NOTICE_MS && !pendingFlow) flowUi = { ...flowUi, notice: undefined };
      const m = flowModel(flow, live, flowUi, size.width, size.height, now, displayWidth, history, jobs?.state.jobs ?? []);
      if (!flowUi.sel && m.selected) flowUi = { ...flowUi, sel: m.selected };
      return m;
    }
    if (pendingStop) {
      const t = pendingStop.target;
      const control = t.scope === "child" ? subs.get(t.sub!)?.control : jobs?.state.control;
      if (control?.seq === pendingStop.seq) {
        jobsUi = { ...jobsUi, notice: control.ok ? `${t.label} 작업을 중지했습니다.` : `중지하지 못했습니다: ${control.message}` };
        pendingStop = null;
      }
    }
    if (!jobsUi.notice) notice = null;
    else if (jobsUi.notice !== notice?.text) notice = { text: jobsUi.notice, at: now };
    if (jobsUi.notice && notice && now - notice.at > NOTICE_MS) jobsUi = { ...jobsUi, notice: undefined };
    const logs = jobsUi.mode === "log" && jobsUi.log ? readLog(jobsUi.log.id, jobsUi.log.scope === "child" ? jobsUi.log.sub : undefined) : [];
    const m = jobsModel(jobs?.state ?? null, subs, live, jobsUi, size.width, size.height, now, displayWidth, logs.slice(0, Math.max(0, logs.length - scroll)));
    if (m.selected && jobsUi.sel !== m.selected && jobsUi.mode !== "log") jobsUi = { ...jobsUi, sel: m.selected };
    return m;
  };
  /** 바뀐 것이 있을 때만 보낸다 (스피너 · 경과는 exe 가 혼자 그린다) */
  const push = (force = false) => {
    if (quitting) return;
    const m = JSON.stringify(model());
    if (!force && m === last) return;
    last = m;
    link.send(JSON.parse(m));
  };
  const quit = (code = 0) => {
    if (quitting) return;
    quitting = true;
    link.send({ op: "quit", code });
    setTimeout(() => { link.killAndRestore(process.stdout); process.exit(code); }, 1500).unref();
  };
  const onKey = (key: MonitorKey) => {
    if (key === "q" && !(kind === "jobs" && jobsUi.confirm) && !(kind === "flow" && flowUi.confirm)) return quit(0);   // 팝업이 떠 있으면 q 는 취소
    if (kind === "flow") {
      const r = flowKeyEx(flowUi, flow, size.width, key, Date.now(), history);
      flowUi = r.ui;
      if (flowUi.notice) flowNoticeAt = Date.now();
      if (r.request) pendingFlow = sendFlowRequest(r.request);
    }
    else {
      const r = jobsKey(jobsUi, scroll, jobs?.state ?? null, subs, key);
      jobsUi = r.ui; scroll = r.scroll;
      if (r.stop && jobs) {
        const dir = r.stop.scope === "child" ? subRunDir(jobs.runDir, r.stop.sub!) : jobs.runDir;
        pendingStop = { seq: sendControl(dir, "stop", r.stop.id), target: r.stop };
      }
    }
    push();
  };
  const link = new ExeLink(exe, (m: any) => {
    if (m.event === "resize" && m.width > 0 && m.height > 0) { size = { width: m.width, height: m.height }; push(true); }
    else if (m.event === "key" && (KEYS as readonly string[]).includes(m.key)) onKey(m.key);
    else if (m.event === "interrupt") quit(0);
  }, ["--mode", "monitor"]);
  link.exited.then((code: number | null) => process.exit(quitting ? 0 : code ?? 1));
  push(true);
  // 파일이 바뀌면 바로, 그 밖에는 1초마다 (live.json 이 오래됐는지 · 사용자 위치를 둔 시간이 지났는지). pi 가 끝나면 종료
  setInterval(() => { if (!pidAlive(piPid)) return quit(0); reload(); push(); }, 1000);
  const watchDir = (dir: string) => { try { watch(dir, () => { reload(); push(); }); } catch { /* 1초 폴링으로 */ } };
  if (kind === "flow" && flowFile && existsSync(join(flowFile, ".."))) watchDir(join(flowFile, ".."));
  if (jobs?.runDir) watchDir(jobs.runDir);
}

// ------------------------------------------------------------------ 대체 화면: pi-tui (exe 가 모니터 모드를 모를 때)
async function runPiTui() {
  const tui: any = await import(pathToFileURL(join(root, "vendor", "pi", "node_modules", "@earendil-works", "pi-tui", "dist", "index.js")).href);
  const fit: Fit = {
    width: (s) => tui.visibleWidth(s),
    trunc: (s, w) => (tui.visibleWidth(s) <= w ? s : tui.truncateToWidth(s, w, "…")),
    wrap: (s, w) => (s ? tui.wrapTextWithAnsi(s, Math.max(1, w)) : [""]),
  };
  let logLines: string[] = [];
  const jobsUi: JobsUi = { sel: 0, mode: "list", scroll: 0 };
  const flowUi: FlowUi = { sel: 0, open: new Set() };
  let pendingStop: { seq: string; id: string } | null = null;
  const currentJob = () => (jobs ? jobOrder(jobs.state.jobs)[jobsUi.sel] : undefined);
  const reloadAll = () => {
    reload();
    if (pendingStop && jobs?.state.control?.seq === pendingStop.seq) {
      jobsUi.notice = jobs.state.control.ok ? `${pendingStop.id} 작업을 중지했습니다.` : `중지하지 못했습니다: ${jobs.state.control.message}`;
      pendingStop = null;
    }
    if (jobsUi.mode === "log") logLines = readLog(currentJob()?.id ?? null);
  };

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
  const quit = () => {
    try { screen.stop(); } catch { /* 이미 멈춤 */ }
    process.exit(0);
  };
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
    else if ((is(data, "enter") || is(data, "right")) && j) { jobsUi.mode = "log"; jobsUi.scroll = 0; reloadAll(); }
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

  reloadAll();
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
  setInterval(() => {
    if (!pidAlive(piPid)) return quit();
    reloadAll();
    const s = stamp();
    if (s !== lastStamp || kind === "jobs") { lastStamp = s; screen.requestRender(); }
  }, 1000);
  if (kind === "flow" && flowFile) {
    try { watch(join(flowFile, ".."), () => { reloadAll(); screen.requestRender(); }); } catch { /* 1초 폴링으로 */ }
  }
}
