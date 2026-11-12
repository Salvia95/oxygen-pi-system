/**
 * 모니터 화면의 키 처리 (docs/monitor-tui-spec.md §4, 4단계). oxy-tui 모니터 모드가 보내는 키 이벤트로 선택 · 펼침 · 화면 모드를 바꾼다.
 * 선택은 Node 가 정해 보기 모델의 selected 로 보낸다 (exe 는 선택을 기억하지 않는다). 파일 · 프로세스를 건드리지 않는 순수 함수다.
 */
import type { JobSnapshot } from "../oxy-jobs/state.ts";
import { type FlowLike, type FlowUiState, type JobsUiState, jobOrder, planRows } from "./model.ts";

export type MonitorKey = "up" | "down" | "enter" | "esc" | "s" | "q";
export const KEYS: readonly MonitorKey[] = ["up", "down", "enter", "esc", "s", "q"];

/** exe 의 --version 출력에 모니터 모드 표시가 있는가 (예전 v0.1.0 exe 는 --mode 를 모르고 설치 화면 규약으로 기다린다) */
export const supportsMonitor = (versionOutput: string): boolean => /^oxy-tui \S+ .*\bmonitor\b/m.test(versionOutput);

/** 목록에서 key 를 기준으로 한 칸 이동 (없으면 첫 줄) */
function move(keys: string[], cur: string | null, step: number): string | null {
  if (!keys.length) return null;
  const i = cur ? keys.indexOf(cur) : -1;
  if (i < 0) return keys[0];
  return keys[Math.min(keys.length - 1, Math.max(0, i + step))];
}

/** flow 화면: ▲▼ 선택 이동(사용자 위치를 잠시 둔다), Enter 펼치기 · 접기 */
export function flowKey(ui: FlowUiState, flow: FlowLike | null, width: number, key: MonitorKey, now: number): FlowUiState {
  if (!flow) return ui;
  const keys = planRows(flow, ui.open, width).filter((r) => r.key).map((r) => r.key!);
  if (key === "up" || key === "down") return { ...ui, sel: move(keys, ui.sel, key === "up" ? -1 : 1), manualAt: now };
  if (key === "enter") {
    const k = ui.sel && keys.includes(ui.sel) ? ui.sel : keys[0];
    if (!k) return ui;
    const open = new Set(ui.open);
    if (open.has(k)) open.delete(k); else open.add(k);
    return { ...ui, sel: k, open, manualAt: now };
  }
  return ui;
}

export interface JobsKeyResult { ui: JobsUiState; scroll: number; stop?: string }

/** jobs 화면: ▲▼ 이동 · 로그에서는 스크롤, Enter 로그, Esc 목록, s 두 번 중지 (stop 에 작업 id) */
export function jobsKey(ui: JobsUiState, scroll: number, jobs: JobSnapshot[], key: MonitorKey): JobsKeyResult {
  const list = jobOrder(jobs);
  const sel = list.find((j) => j.id === ui.sel) ?? list[0];
  const active = Boolean(sel && (sel.state === "running" || sel.state === "queued"));
  const base: JobsUiState = { ...ui, notice: undefined };
  if (ui.mode === "confirm") {
    if (key === "s" && sel && active) return { ui: { ...base, mode: "list", notice: `${sel.id} 작업의 중지를 요청했습니다.` }, scroll, stop: sel.id };
    return { ui: { ...base, mode: "list" }, scroll };   // s 가 아닌 키(Esc 등)는 취소
  }
  if (ui.mode === "log") {
    if (key === "esc") return { ui: { ...base, mode: "list" }, scroll: 0 };
    if (key === "up") return { ui: base, scroll: scroll + 1 };
    if (key === "down") return { ui: base, scroll: Math.max(0, scroll - 1) };
    if (key === "s" && active) return { ui: { ...base, mode: "confirm" }, scroll };
    return { ui: base, scroll };
  }
  if (key === "up" || key === "down") return { ui: { ...base, sel: move(list.map((j) => j.id), sel?.id ?? null, key === "up" ? -1 : 1) }, scroll };
  if (key === "enter" && sel) return { ui: { ...base, sel: sel.id, mode: "log" }, scroll: 0 };
  if (key === "s" && active) return { ui: { ...base, sel: sel!.id, mode: "confirm" }, scroll };
  return { ui: base, scroll };
}
