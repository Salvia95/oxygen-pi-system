/**
 * 모니터 화면의 키 처리 (docs/monitor-tui-spec.md §4, 4단계). oxy-tui 모니터 모드가 보내는 키 이벤트로 선택 · 펼침 · 화면 모드를 바꾼다.
 * 선택은 Node 가 정해 보기 모델의 selected 로 보낸다 (exe 는 선택을 기억하지 않는다). 파일 · 프로세스를 건드리지 않는 순수 함수다.
 */
import type { JobsState } from "../oxy-jobs/state.ts";
import { type FlowHistory, type FlowLike, type FlowRequest, type FlowUiState, type JobsUiState, type StopTarget, completedRows, findPlanItem, flowSelection, isActive,
  jobLists, planRows, taskLabelOf } from "./model.ts";

export type MonitorKey = "up" | "down" | "left" | "right" | "enter" | "esc" | "s" | "q" | "r" | "u";
export const KEYS: readonly MonitorKey[] = ["up", "down", "left", "right", "enter", "esc", "s", "q", "r", "u"];

/** exe 의 --version 출력에 모니터 모드 표시가 있는가 (예전 v0.1.0 exe 는 --mode 를 모르고 설치 화면 규약으로 기다린다) */
export const supportsMonitor = (versionOutput: string): boolean => /^oxy-tui \S+ .*\bmonitor\b/m.test(versionOutput);

/**
 * 모니터 exe 의 팔레트 (OXY_TUI_THEME): 사용자가 정한 값(light 등)이 있으면 그대로, 아니면 기본(Oxygen 세이지) 팔레트.
 * pi 테마는 oxygen 하나라 따로 맞출 것이 없다 (Tokyo Night 는 걷어냈다, docs/ui-unify-spec.md §2.0). settingsText 는 예전 호출 모양을 지키려고 받는다
 */
export function monitorTheme(_settingsText: string | null, envTheme: string | undefined): string | undefined {
  return envTheme || undefined;
}

/** 목록에서 key 를 기준으로 한 칸 이동 (없으면 첫 줄) */
function move(keys: string[], cur: string | null, step: number): string | null {
  if (!keys.length) return null;
  const i = cur ? keys.indexOf(cur) : -1;
  if (i < 0) return keys[0];
  return keys[Math.min(keys.length - 1, Math.max(0, i + step))];
}

/** flow 화면: ▲▼ 선택 이동(사용자 위치를 잠시 둔다), Enter 펼치기 · 접기. 움직임은 지금 고른 줄(기본: 지금 할 일)에서 시작한다 */
export function flowKey(ui: FlowUiState, flow: FlowLike | null, width: number, key: MonitorKey, now: number, history: FlowHistory | null = null): FlowUiState {
  return flowKeyEx(ui, flow, width, key, now, history).ui;
}

/**
 * flow 화면의 키 (docs/flow-rollback-spec.md §3): 위 + r 되돌리기 · u 되돌리기 취소 (확인 팝업, 처음 포커스 취소).
 * 팝업에서 되돌리기를 고르면 request 를 돌려준다 (모니터가 .oxy/flow/requests/ 에 쓰고 pi 의 oxy-flow 가 실행)
 */
export function flowKeyEx(ui: FlowUiState, flow: FlowLike | null, width: number, key: MonitorKey, now: number,
  history: FlowHistory | null = null): { ui: FlowUiState; request?: FlowRequest } {
  const base: FlowUiState = { ...ui, notice: undefined };
  if (ui.confirm) {
    const c = ui.confirm;
    if (key === "left" || key === "right") return { ui: { ...base, confirm: { ...c, focus: c.focus === "yes" ? "no" : "yes" } } };
    if (key === "enter" && c.focus === "yes") {
      return { ui: { ...base, confirm: null, notice: c.op === "undo" ? "되돌리기 취소를 요청했습니다." : "되돌리기를 요청했습니다." },
        request: { op: c.op, flow: c.flow, task: c.task } };
    }
    if (key === "enter" || key === "esc" || key === "q") return { ui: { ...base, confirm: null } };
    return { ui };
  }
  if (!flow) return { ui };
  const rows = [...planRows(flow, ui.open, width, history?.marks[flow.id ?? ""]), ...completedRows(history, ui.open, flow.rollbacks ?? [])];
  const keys = rows.filter((r) => r.key).map((r) => r.key!);
  const cur = flowSelection(rows, flow.plan ?? [], ui, now);
  if (key === "r") {
    const target = rollbackTarget(cur, flow, history);
    if (typeof target === "string") return { ui: { ...base, notice: target } };
    return { ui: { ...base, confirm: { op: "rollback", ...target, focus: "no" } } };
  }
  if (key === "u") {
    const last = [...(flow.rollbacks ?? [])].reverse().find((r) => !r.undone);
    if (!last) return { ui: { ...base, notice: "취소할 되돌리기가 없습니다." } };
    const plan = last.flow === flow.id ? flow.plan ?? [] : history?.completed.find((x) => x.id === last.flow)?.plan ?? [];
    const files = (last as any).files?.length ?? 0;
    return { ui: { ...base, confirm: { op: "undo", flow: last.flow, task: last.task, label: taskLabelOf(plan, last.task), files, partial: false, focus: "no" } } };
  }
  return { ui: flowMove(base, keys, cur, key, now) };
}

/** 고른 줄의 되돌리기 대상 (안 되면 그 이유) */
function rollbackTarget(cur: string | null, flow: FlowLike, history: FlowHistory | null): { flow: string; task: string; label: string; files: number; partial: boolean } | string {
  let flowId: string, taskId: string, plan;
  if (cur?.startsWith("p:")) { flowId = flow.id ?? ""; taskId = cur.slice(2); plan = flow.plan ?? []; }
  else if (cur?.startsWith("t:")) {
    const rest = cur.slice(2), i = rest.lastIndexOf(":");
    flowId = rest.slice(0, i); taskId = rest.slice(i + 1);
    plan = history?.completed.find((x) => x.id === flowId)?.plan ?? [];
  } else return "되돌릴 Task 를 고르세요.";
  const item = findPlanItem(plan, taskId);
  if (!item || !item.snaps || !Object.keys(item.snaps).length) return "이 Task 에는 되돌릴 지점이 없습니다.";
  const m = history?.marks[flowId]?.[taskId];
  if (m?.mark === "conflict") return "되돌리면 뒤의 작업과 충돌합니다.";
  return { flow: flowId, task: taskId, label: taskLabelOf(plan, taskId), files: m?.files ?? 0, partial: m?.mark === "partial" };
}

function flowMove(ui: FlowUiState, keys: string[], cur: string | null, key: MonitorKey, now: number): FlowUiState {
  if (key === "up" || key === "down") return { ...ui, sel: move(keys, cur, key === "up" ? -1 : 1), manualAt: now };
  if (key === "enter") {
    const k = cur && keys.includes(cur) ? cur : keys[0];
    if (!k) return ui;
    const open = new Set(ui.open);
    if (open.has(k)) open.delete(k); else open.add(k);
    return { ...ui, sel: k, open, manualAt: now };
  }
  return ui;
}

export interface JobsKeyResult { ui: JobsUiState; scroll: number; stop?: StopTarget }

/**
 * jobs 화면 (docs/jobs-view-spec.md §2): 목록(Main Background · Subagent) ▲▼ 이동, Enter 셸 로그 · subagent 화면, s 중지 확인 팝업.
 * subagent 화면: 대화 로그 · 그 셸, Enter 로그, Esc 목록. 로그: ▲▼ 스크롤, Esc 돌아가기. 팝업: ←→ 이동, Enter 선택, Esc · q 취소 (처음 포커스 취소)
 */
export function jobsKey(ui: JobsUiState, scroll: number, state: JobsState | null, subs: Map<string, JobsState>, key: MonitorKey): JobsKeyResult {
  const L = jobLists(state, subs);
  const base: JobsUiState = { ...ui, notice: undefined };
  if (ui.confirm) {
    const c = ui.confirm;
    if (key === "left" || key === "right") return { ui: { ...base, confirm: { ...c, focus: c.focus === "yes" ? "no" : "yes" } }, scroll };
    if (key === "enter" && c.focus === "yes") {
      const { focus: _f, ...target } = c;
      return { ui: { ...base, confirm: null, notice: `${c.label} 중지를 요청했습니다.` }, scroll, stop: target };
    }
    if (key === "enter" || key === "esc" || key === "q") return { ui: { ...base, confirm: null }, scroll };
    return { ui, scroll };
  }
  const ask = (t: StopTarget): JobsKeyResult => ({ ui: { ...base, confirm: { ...t, focus: "no" } }, scroll });

  if (ui.mode === "log" && ui.log) {
    if (key === "esc") return { ui: { ...base, mode: ui.back, log: null }, scroll: 0 };
    if (key === "up") return { ui: base, scroll: scroll + 1 };
    if (key === "down") return { ui: base, scroll: Math.max(0, scroll - 1) };
    if (key === "s") {
      const lg = ui.log;
      const j = lg.scope === "child" ? L.findChild(lg.sub!, lg.id) : L.find(lg.id);
      if (j && isActive(j)) return ask({ scope: lg.scope, id: lg.id, sub: lg.sub, label: j.label, agent: j.kind === "agent" });
    }
    return { ui: base, scroll };
  }

  const agent = ui.mode === "sub" && ui.sub ? L.agents.find((j) => j.id === ui.sub) : undefined;
  if (ui.mode === "sub" && !agent) return { ui: { ...base, mode: "list", sub: null, sel: ui.sub ? `s:${ui.sub}` : null }, scroll: 0 };   // subagent 가 끝났다
  if (agent) {
    const kids = L.children(agent.id);
    const keys = ["sublog", ...kids.map((c) => `c:${c.id}`)];
    const cur = ui.sel && keys.includes(ui.sel) ? ui.sel : "sublog";
    if (key === "up" || key === "down") return { ui: { ...base, sel: move(keys, cur, key === "up" ? -1 : 1) }, scroll };
    if (key === "esc") return { ui: { ...base, mode: "list", sub: null, sel: `s:${agent.id}` }, scroll: 0 };
    if (key === "enter") {
      const log = cur === "sublog" ? { scope: "main" as const, id: agent.id } : { scope: "child" as const, id: cur.slice(2), sub: agent.id };
      return { ui: { ...base, sel: cur, mode: "log", log, back: "sub" }, scroll: 0 };
    }
    if (key === "s" && cur.startsWith("c:")) {
      const c = kids.find((x) => `c:${x.id}` === cur)!;
      return ask({ scope: "child", id: c.id, sub: agent.id, label: c.label });
    }
    return { ui: base, scroll };
  }

  const keys = [...L.main.map((j) => `m:${j.id}`), ...L.agents.map((j) => `s:${j.id}`)];
  const cur = ui.sel && keys.includes(ui.sel) ? ui.sel : keys[0] ?? null;
  if (key === "up" || key === "down") return { ui: { ...base, sel: move(keys, cur, key === "up" ? -1 : 1) }, scroll };
  if (!cur) return { ui: base, scroll };
  const j = L.find(cur.slice(2))!;
  if (key === "enter") {
    if (cur.startsWith("s:")) return { ui: { ...base, sel: "sublog", mode: "sub", sub: j.id }, scroll: 0 };
    return { ui: { ...base, sel: cur, mode: "log", log: { scope: "main", id: j.id }, back: "list" }, scroll: 0 };
  }
  if (key === "s") return ask({ scope: "main", id: j.id, label: j.label, agent: j.kind === "agent" });
  return { ui: { ...base, sel: cur }, scroll };
}
