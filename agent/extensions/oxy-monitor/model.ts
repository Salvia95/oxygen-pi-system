/**
 * 모니터 보기 모델 (docs/monitor-tui-spec.md §3 · §4, M1 (a)).
 * 상태 파일(jobs state.json · flow.json · live.json)을 읽은 결과로 "무엇을 어떤 순서로 보일지"를 정한다.
 * 그리기(글자 폭에 맞춘 자르기, 기호, 색, 스피너, 경과 시간)는 oxy-tui 의 모니터 모드가 한다. 여기에는 색 코드를 넣지 않는다.
 * 높이 안에서 어느 줄을 보일지(스크롤)와 좁은 폭에서 뺄 열은 여기서 정해, 화면 프로그램은 받은 줄을 그대로 그린다.
 */
import type { JobSnapshot, JobsState } from "../oxy-jobs/state.ts";
import { type WaitReason, pendingText } from "../oxy-rate/limiter.ts";
import { commandHead } from "../oxygen-pi-tui/tools/basic.ts";
import { type PlanItem, clock, itemDuration } from "../oxy-flow/plan.ts";
import type { LiveState } from "./live.ts";

/** 상태 기호 이름 (기호 자체는 exe 가 정한다: spinner = 점자 스피너, todo ·, done ✓, failed ×, blocked !, stopped ■, dropped -) */
export type Marker = "spinner" | "todo" | "done" | "failed" | "blocked" | "stopped" | "dropped" | "none";
export interface Row {
  key?: string;          // 고를 수 있는 줄 (Enter · s 의 대상)
  marker: Marker;
  text: string;
  right?: string;        // 오른쪽 정렬 글 (since 가 있으면 exe 가 경과로 바꿔 그린다)
  since?: number;        // 경과 시작 시각 (ms). exe 가 1초마다 m:ss 로 그린다
  indent: number;
  prefix?: string;
  badge?: string;        // 오른쪽 열 앞에 붙는 짧은 표시 (Subagent 구역의 "셸 N"). 폭이 모자라면 exe 가 뺀다       // 트리 바 ("├ " · "└ " · "│ "). 들여쓰기 다음, 기호 앞에 흐린 색으로 (flow-view-spec §2)
  emphasis?: boolean;    // 진행 중 · 제목 줄
  error?: boolean;       // 실패 · 오류색
}
export interface Section { title?: string; rows: Row[] }
/** 확인 팝업 (jobs 의 중지 확인, docs/jobs-view-spec.md §2). focus 는 buttons 의 위치 */
export interface Popup { title: string; lines: string[]; buttons: string[]; focus: number; danger?: number }   // danger: 경고 모양으로 그릴 버튼의 위치
export interface MonitorModel {
  op: "monitor";
  kind: "flow" | "jobs";
  title: string;
  right: string;
  now: Row[];            // 지금 (flow: 맨 위 · jobs: 맨 아래). 빈 배열이면 그리지 않는다
  nowAt: "top" | "bottom";
  sections: Section[];   // 사이에 가로줄을 긋는다
  selected: string | null;
  keys: string[];        // 키 안내 줄 (폭에 맞춰 이미 나눈 것)
  popup?: Popup;         // 있으면 exe 가 화면 가운데에 팝업을 그린다
}

export const NARROW = 30;               // 이 폭 미만이면 커밋 번호 · 종류 열을 뺀다 (80×24 의 오른쪽 열은 23칸)
export const LIVE_STALE_MS = 10000;     // live.json 은 5초마다 갱신된다. 두 번 놓치면 상태를 모른다고 본다
export const MANUAL_HOLD_MS = 10000;    // 사용자가 움직인 뒤 이 동안은 진행 중 항목으로 스크롤을 옮기지 않는다

export { clock };

/** 키 안내를 폭에 맞춰 줄로 나눈다 (한 줄에 다 들어가지 않으면 두 줄 이상) */
export function keyLines(keys: string[], width: number, w: (s: string) => number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const k of keys) {
    const next = cur ? `${cur}  ${k}` : k;
    if (!cur || w(next) <= width) cur = next;
    else { lines.push(cur); cur = k; }
  }
  if (cur) lines.push(cur);
  return lines;
}

// ------------------------------------------------------------------ 지금 (live.json)

const STATE_TEXT: Record<string, string> = { idle: "대기 중", thinking: "응답 생성 중", tool: "도구 실행 중", compacting: "compaction 중" };

/** pi 의 지금 상태 한 줄. live 가 없거나 오래되면 "알 수 없음" */
export function stateRow(live: LiveState | null, now: number): Row {
  if (!live || live.closed || now - live.updatedAt > LIVE_STALE_MS) return { marker: "none", text: "pi 상태를 알 수 없습니다", indent: 0 };
  const st = live.agent.state;
  if (st === "idle") return { marker: "none", text: STATE_TEXT.idle, indent: 0 };
  return { marker: "spinner", text: STATE_TEXT[st] ?? st, since: live.agent.since, indent: 0, emphasis: true };
}

const planMarker = (s: string): Marker =>
  s === "doing" ? "spinner" : s === "done" ? "done" : s === "blocked" ? "blocked" : s === "dropped" ? "dropped" : "todo";

/** 진행 중인 할 일 (첫 번째 doing 할 일, 없으면 doing 항목) */
export function doingItem(plan: PlanItem[]): PlanItem | null {
  for (const p of plan) {
    const c = p.children.find((x) => x.status === "doing");
    if (c) return c;
    if (p.status === "doing" && !p.children.length) return p;
  }
  return plan.find((p) => p.status === "doing") ?? null;
}

// ------------------------------------------------------------------ flow

export interface FlowLike {
  id?: string;
  goal: string; plan?: PlanItem[];
  rollbacks?: RollbackLike[];   // 이 Flow 에서 한 되돌리기 (docs/flow-rollback-spec.md §3: ↶ 줄)
  next?: string;      // 모델이 flow_note(kind=next) 로 남긴 다음 단계
  blocked?: string;   // flow_note(kind=blocked) 로 남긴 막힘 (할 일을 다시 시작하면 oxy-flow 가 지운다)
  nodes: Array<{ id: string; commit: string; title: string; decisions: Array<{ text: string; why?: string }>; files: string[] }>;
  buffer: { decisions: Array<{ text: string; why?: string }>; files: string[]; failures: Array<{ command: string }> };
}
export interface FlowUiState {
  sel: string | null; open: Set<string>; manualAt: number;
  confirm?: FlowConfirm | null;   // 되돌리기 · 되돌리기 취소 확인 (§3.1, 처음 포커스는 취소)
  notice?: string;                // 키 안내 줄 위에 잠시 보이는 알림
}

// ------------------------------------------------------------------ Completed Flow · 되돌리기 (docs/flow-rollback-spec.md §3)

export type RollMark = "ok" | "partial" | "conflict" | "none";
export interface TaskMark { mark: RollMark; files?: number }
export interface RollbackLike { at: number; flow: string; task: string; text: string; undone?: number; files?: string[] }
/** 계획에서 항목 · 할 일 찾기 */
export function findPlanItem(plan: PlanItem[], id: string): PlanItem | null {
  for (const p of plan) { if (p.id === id) return p; const c = p.children.find((x) => x.id === id); if (c) return c; }
  return null;
}
export interface CompletedFlowLike { id: string; goal: string; updatedAt: number; plan: PlanItem[] }
/** 모니터가 읽는 되돌리기 정보: 끝난 Flow (archive/) · 기호(oxy-flow 가 쓴 marks.json) */
export interface FlowHistory { completed: CompletedFlowLike[]; marks: Record<string, Record<string, TaskMark>> }
export interface FlowConfirm { op: "rollback" | "undo"; flow: string; task: string; label: string; files: number; partial: boolean; focus: "yes" | "no" }
/** 모니터 → pi 요청 (oxy-flow 가 .oxy/flow/requests/ 에서 읽어 실행) */
export interface FlowRequest { op: "rollback" | "undo"; flow: string; task: string }

export const COMPLETED_TITLE = "Completed Flow";
/** D12: 사용자 문구 그대로 (oxy-flow/rollback-ui.ts 와 같은 글) */
export const PARTIAL_LINE = "원격저장소에 없는 변경은 작업기록을 토대로 에이전트가 되돌리기를 시도합니다.";

/** 기호 → 화면 기호: ✓ ok · ! partial · × conflict (D4 의 X) · 되돌릴 지점이 없으면 계획 상태 그대로 */
export function markMarker(m: RollMark | undefined, status: string): Marker {
  if (status === "dropped") return "dropped";
  return m === "conflict" ? "failed" : m === "partial" ? "blocked" : m === "ok" ? "done" : planMarker(status);
}
/** Flow 의 기호: 가장 나쁜 Task 의 것 */
export function worstMark(marks: Record<string, TaskMark> | undefined): RollMark {
  const v = Object.values(marks ?? {}).map((x) => x.mark);
  return v.includes("conflict") ? "conflict" : v.includes("partial") ? "partial" : v.includes("ok") ? "ok" : "none";
}
const mmdd = (t: number) => { const d = new Date(t); return String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
const hhmm = (t: number) => { const d = new Date(t); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); };
/** 같은 단계 안의 위치가 붙은 Task 이름 */
export function taskLabelOf(plan: PlanItem[], id: string): string {
  for (const [i, p] of plan.entries()) {
    if (p.id === id) return "[" + (i + 1) + "/" + plan.length + "] " + p.text;
    const j = p.children.findIndex((c) => c.id === id);
    if (j >= 0) return "[" + (j + 1) + "/" + p.children.length + "] " + p.children[j].text;
  }
  return id;
}
/** 되돌리기 줄: ↶ [2/5] 까지 되돌림 10:20 (취소했으면 표시) */
/**
 * 되돌리기 줄: 되돌린 Task 바로 아래에 둔다 (사용자 2026-11-14: "되돌리기한 원본 아래 있게 해줘").
 * 되돌리기 취소한 것은 그 Task 를 펼쳤을 때만 보인다 ("되돌리기 취소 시 … 펼쳤을 때만 보이게"). label 이 있으면 (접힌 항목 아래) 위치를 붙인다
 */
function rollbackRowsFor(all: RollbackLike[], flowId: string | undefined, taskId: string, opened: boolean, prefix: string | undefined, indent: number, label?: string): Row[] {
  return all.filter((r) => r.flow === flowId && r.task === taskId && (!r.undone || opened)).map((r) => ({ marker: "none" as Marker, indent, prefix,
    text: "↶ " + (label ? label + " 까지" : "여기까지") + " 되돌림" + (r.undone ? " (취소함)" : ""), right: hhmm(r.at) }));
}

/**
 * Completed Flow 영역 (§3): 끝난 Flow 한 줄씩(최근 것 위, 기호는 가장 나쁜 Task 의 것, 오른쪽 날짜). Enter 로 펼치면 Task 와 되돌리기 기호.
 * 키: c:<flow> · t:<flow>:<task>
 */
export function completedRows(h: FlowHistory | null, open: Set<string>, rollbacks: RollbackLike[] = []): Row[] {
  const rows: Row[] = [];
  for (const fl of h?.completed ?? []) {
    const marks = h?.marks[fl.id];
    const fm = worstMark(marks);
    rows.push({ key: "c:" + fl.id, marker: fm === "none" ? "done" : markMarker(fm, "done"), text: fl.goal || fl.id, right: mmdd(fl.updatedAt), indent: 0 });
    if (!open.has("c:" + fl.id)) continue;
    const items = fl.plan.flatMap((p, i) => [{ p, i, c: null as PlanItem | null, j: -1 }, ...p.children.map((c, j) => ({ p, i, c, j }))]);
    items.forEach((x, k) => {
      const it = x.c ?? x.p;
      const lastTop = !x.c && x.i === fl.plan.length - 1 && !x.p.children.length;
      const lastAll = k === items.length - 1;
      const prefix = x.c ? (x.j === x.p.children.length - 1 ? "│ └ " : "│ ├ ") : lastTop || lastAll ? "└ " : "├ ";
      const label = x.c ? "[" + (x.j + 1) + "/" + x.p.children.length + "] " + it.text : "[" + (x.i + 1) + "/" + fl.plan.length + "] " + it.text;
      const key = "t:" + fl.id + ":" + it.id;
      rows.push({ key, marker: markMarker(marks?.[it.id]?.mark, it.status), text: label, indent: 0, prefix });
      // 이 Task 아래 되돌리기 줄 (트리 바는 이어지게)
      const under = x.c ? (x.j === x.p.children.length - 1 ? "│   " : "│ │ ") : lastTop || lastAll ? "  " : "│ ";
      rows.push(...rollbackRowsFor(rollbacks, fl.id, it.id, open.has(key), under, 0));
    });
  }
  return rows;
}

/** 되돌리기 확인 팝업 (§3.1): 버튼 [ 취소 ] [ 되돌리기 ], 처음 포커스 취소 */
export function flowPopup(c: FlowConfirm): Popup {
  if (c.op === "undo") {
    return { title: "되돌리기 취소", lines: ["마지막 되돌리기(\"" + c.label + "\" 까지)를 취소합니다.", "파일 " + c.files + "개가 바뀌거나 삭제됩니다.", "계속할까요?"],
      buttons: ["닫기", "되돌리기 취소"], focus: c.focus === "yes" ? 1 : 0, danger: 1 };
  }
  return { title: "되돌리기", lines: ["\"" + c.label + "\" 이 끝난 상태로", "되돌립니다.", "파일 " + c.files + "개가 바뀌거나 삭제됩니다.", ...(c.partial ? [PARTIAL_LINE] : []), "계속할까요?"],
    buttons: ["취소", "되돌리기"], focus: c.focus === "yes" ? 1 : 0, danger: 1 };
}

export const FLOW_TITLE = "Flow Monitor";
/** 화면 프로그램이 제목 앞에 붙이는 `◆ ` 의 칸 수 (docs/ui-unify-spec.md §2.3). 제목을 줄일지 정할 때 함께 센다 */
export const TITLE_MARK_WIDTH = 2;
export const STATE_ROW_MIN_HEIGHT = 14;   // 이보다 낮으면 Current Task 아래 pi 상태 줄을 뺀다 (flow-view-spec §2, R1)

const leavesOf = (plan: PlanItem[]) => plan.flatMap((p) => (p.children.length ? p.children : [p]));

/** 다음에 할 일: 진행 중인 할 일 뒤의 첫 todo 할 일 (진행 중인 것이 없으면 첫 todo). 할 일이 없는 항목은 그 항목 */
export function nextItem(plan: PlanItem[]): PlanItem | null {
  const leaves = leavesOf(plan);
  const cur = doingItem(plan);
  const from = cur ? leaves.indexOf(cur) + 1 : 0;
  return leaves.slice(Math.max(0, from)).find((x) => x.status === "todo") ?? null;
}

/** 지금 할 일의 키 (기본 포커스) */
export const currentKey = (plan: PlanItem[]): string | null => { const d = doingItem(plan); return d ? "p:" + d.id : null; };

/**
 * Overall Task 의 줄 (flow-view-spec §2): 항목 → 할 일("├" · "└") 트리, 이름 앞 [i/n], 오른쪽에 걸린 시간 · 지금 할 일 "◀ Current Task".
 * 끝난 항목의 할 일은 접힘(open 이면 반대). 펼친 커밋의 결정 · 파일 → 계획 밖 커밋 → 커밋 전 작업
 */
export function planRows(flow: FlowLike, open: Set<string>, width: number, marks?: Record<string, TaskMark>): Row[] {
  const rows: Row[] = [];
  // 끝난 Task 앞 기호는 되돌리기 기호 (D8: 지금 Flow 도 같은 규칙. 지금 Flow 에는 충돌이 없다)
  const mk = (x: PlanItem): Marker => (x.status === "done" && marks?.[x.id] ? markMarker(marks[x.id].mark, x.status) : planMarker(x.status));
  const plan = flow.plan ?? [];
  const narrow = width < NARROW;
  const cur = doingItem(plan);
  const nodeById = new Map(flow.nodes.map((n) => [n.id, n]));
  const right = (x: PlanItem): string | undefined => {
    if (x === cur && !x.children.length) return narrow ? "◀" : "◀ Current Task";
    const d = itemDuration(x);
    return d === null ? undefined : clock(d);
  };
  const commitRows = (ids: string[], prefix: string | undefined, indent: number) => {
    for (const id of ids) {
      const n = nodeById.get(id);
      if (!n) continue;
      rows.push({ key: "n:" + id, marker: "done", text: id + " " + n.title, indent, prefix });
      if (!open.has("n:" + id)) continue;
      for (const d of n.decisions) rows.push({ marker: "none", text: d.text + (d.why ? " (" + d.why + ")" : ""), indent: indent + 2, prefix });
      if (n.files.length) rows.push({ marker: "none", text: "파일 " + n.files.length + "개: " + n.files.slice(0, 5).join(", ") + (n.files.length > 5 ? " …" : ""), indent: indent + 2, prefix });
    }
  };
  const rbs = flow.rollbacks ?? [];
  plan.forEach((p, i) => {
    rows.push({ key: "p:" + p.id, marker: mk(p), text: "[" + (i + 1) + "/" + plan.length + "] " + p.text, right: right(p), indent: 0,
      emphasis: p.status === "doing" });
    const folded = (p.status === "done") !== open.has("p:" + p.id);
    // 되돌리기 줄은 되돌린 Task 바로 아래 (취소한 것은 펼쳤을 때만)
    rows.push(...rollbackRowsFor(rbs, flow.id, p.id, open.has("p:" + p.id), p.children.length && !folded ? "│ " : undefined, p.children.length && !folded ? 0 : 2));
    if (folded) {
      // 접힌 항목의 할 일을 되돌렸으면 그 항목 아래에 위치를 붙여 보인다 (취소한 것은 숨김)
      p.children.forEach((c, j) => rows.push(...rollbackRowsFor(rbs, flow.id, c.id, false, undefined, 2, "[" + (j + 1) + "/" + p.children.length + "]")));
      return;
    }
    if (open.has("p:" + p.id)) commitRows(p.nodes, p.children.length ? "│ " : undefined, p.children.length ? 0 : 2);
    p.children.forEach((c, j) => {
      const last = j === p.children.length - 1;
      rows.push({ key: "p:" + c.id, marker: mk(c), text: "[" + (j + 1) + "/" + p.children.length + "] " + c.text, right: right(c), indent: 0,
        prefix: last ? "└ " : "├ ", emphasis: c.status === "doing" });
      rows.push(...rollbackRowsFor(rbs, flow.id, c.id, open.has("p:" + c.id), last ? "  " : "│ ", 2));
      if (open.has("p:" + c.id)) commitRows(c.nodes, last ? "  " : "│ ", 2);
    });
  });
  if (!plan.length && flow.goal) rows.push({ marker: "none", text: flow.goal, indent: 0 });
  const linked = new Set(plan.flatMap((p) => [...p.nodes, ...p.children.flatMap((c) => c.nodes)]));
  const outside = flow.nodes.filter((n) => !linked.has(n.id)).map((n) => n.id);
  if (outside.length) {
    rows.push({ marker: "none", text: plan.length ? "계획 밖 커밋" : "커밋", indent: 0, emphasis: true });
    commitRows(outside.slice(-20), undefined, 2);
  }
  if (!rows.length) rows.push({ marker: "none", text: "작업 기록이 없습니다.", indent: 0 });
  return rows;
}

/** 고른 줄: 사용자가 움직인 뒤 MANUAL_HOLD_MS 동안은 사용자 위치, 그 밖에는 늘 지금 할 일 (없으면 사용자 위치 · 첫 줄) */
export function flowSelection(rows: Row[], plan: PlanItem[], ui: FlowUiState, now: number): string | null {
  const has = (k: string | null) => Boolean(k && rows.some((r) => r.key === k));
  const cur = currentKey(plan);
  if (now - ui.manualAt < MANUAL_HOLD_MS && has(ui.sel)) return ui.sel;
  if (has(cur)) return cur;
  if (has(ui.sel)) return ui.sel;
  return rows.find((r) => r.key)?.key ?? null;
}

/**
 * Current Task 구역: 지금 할 일(이름 · 경과) · pi 상태 줄(높이가 되면) · Next Task.
 * 진행 중인 할 일이 없으면 (2026-11-14, 계획이 끝난 뒤 새 일을 메모로만 남겨 모니터가 "없음"만 보였다)
 *   막힘(blocked)이 있으면 `! <막힘>`, 없으면 모델이 남긴 다음 단계(next)를 지금 할 일 자리에 보인다
 */
export function currentRows(live: LiveState | null, plan: PlanItem[], height: number, now: number,
  notes: { next?: string; blocked?: string } = {}): Row[] {
  const cur = doingItem(plan);
  const nextNote = (notes.next ?? "").trim();
  const blocked = (notes.blocked ?? "").trim();
  const rows: Row[] = [cur
    ? { marker: "spinner", text: cur.text, since: cur.startedAt ?? cur.at, indent: 0, emphasis: true }
    : blocked ? { marker: "blocked", text: blocked, indent: 0, emphasis: true }
    : nextNote ? { marker: "todo", text: nextNote, indent: 0, emphasis: true }
    : { marker: "none", text: "진행 중인 할 일이 없습니다", indent: 0 }];
  if (height >= STATE_ROW_MIN_HEIGHT) {
    const st = stateRow(live, now);
    const tools = st.text === STATE_TEXT.tool ? live?.tools ?? [] : [];
    const t = tools[0];
    const what = t ? (t.summary ? t.name + " " + t.summary : t.name) + (tools.length > 1 ? " 외 " + (tools.length - 1) + "개" : "") : "";
    rows.push({ marker: "none", text: what ? st.text + " · " + what : st.text, indent: 2 });
  }
  // 다음 할 일: 계획의 다음 항목. 없으면, 지금 할 일 자리에 쓰지 않은 다음 단계 메모
  const next = nextItem(plan);
  const shownNote = !cur && !blocked && nextNote;
  rows.push({ marker: "none", text: "Next Task: " + (next ? next.text : !shownNote && nextNote ? nextNote : "없음"), indent: 0 });
  return rows;
}

/** 높이 room 안에 보일 구간: target 줄이 보이게 (가능하면 가운데보다 조금 위) */
export function windowAround(total: number, room: number, target: number): number {
  if (total <= room || target < 0) return 0;
  return Math.min(Math.max(0, target - Math.floor(room / 3)), total - room);
}

/** Current Task 구역의 높이 (내용이 없으면 가운데에 "-") */
export const CURRENT_ROWS = 3;
export const OVERALL_TITLE = "Overall Flow";

/** 도구 이름 → 하는 일 (명령어는 보이지 않는다) */
const TOOL_WORK: Record<string, string> = {
  bash: "셸 명령", read: "파일 읽기", write: "파일 쓰기", edit: "파일 고치기", grep: "검색",
  background: "백그라운드 작업 시작", subagent: "subagent 맡기기", flow_plan: "작업 기록", flow_note: "작업 기록", flow_show: "작업 기록 보기",
};

/**
 * Current Task 구역 (사용자 2026-11-14: "Current Task는 현재 진행 중인 셸 실행이나 작업들을 요약한 정보를 보여주도록 하자(명령어는 안보여줘도 될 것 같아)
 * 그리고 current Task도 내용이 없을때는 중앙에 정렬된 - 로 표시되도록 하자"). 계획 항목 · Next Task 는 보이지 않는다 (Overall Flow 의 반복이었다).
 *   실행 중인 도구를 하는 일별로 세고(가장 먼저 시작한 것의 경과), 백그라운드 작업 · subagent, 도구가 없으면 응답 생성 · compaction.
 *   높이는 CURRENT_ROWS 로 고정, 비면 가운데 "-"
 */
export function currentWorkRows(live: LiveState | null, jobs: JobSnapshot[], width: number, now: number, rowsMax = CURRENT_ROWS): Row[] {
  const out: Row[] = [];
  const fresh = live && !live.closed && now - live.updatedAt <= LIVE_STALE_MS ? live : null;
  const groups = new Map<string, { n: number; since: number }>();
  for (const t of fresh?.tools ?? []) {
    const k = TOOL_WORK[t.name] ?? t.name;
    const g = groups.get(k);
    groups.set(k, g ? { n: g.n + 1, since: Math.min(g.since, t.startedAt) } : { n: 1, since: t.startedAt });
  }
  for (const [k, g] of groups) out.push({ marker: "spinner", text: k + (g.n > 1 ? " " + g.n + "개" : "") + " 실행 중", since: g.since, indent: 0, emphasis: true });
  const active = jobs.filter((j) => j.state === "running" || j.state === "queued");
  const bg = active.filter((j) => j.kind !== "agent"), ag = active.filter((j) => j.kind === "agent");
  const first = (xs: JobSnapshot[]) => Math.min(...xs.map((j) => j.startedAt ?? j.createdAt));
  if (bg.length) out.push({ marker: "spinner", text: "백그라운드 " + bg.length + "개 실행 중", since: first(bg), indent: 0 });
  if (ag.length) out.push({ marker: "spinner", text: "subagent " + ag.length + "개 작업 중", since: first(ag), indent: 0 });
  if (!groups.size && fresh && (fresh.agent.state === "thinking" || fresh.agent.state === "compacting")) {
    out.unshift({ marker: "spinner", text: STATE_TEXT[fresh.agent.state], since: fresh.agent.since, indent: 0, emphasis: true });
  }
  // 요청 한도 대기 (oxy-rate): 맨 위에 남은 시간과 함께 (사용자 2026-11-14: "Pending for n sec: RPM Limit")
  if (fresh?.pending && fresh.pending.until > now) {
    out.unshift({ marker: "spinner", text: pendingText(fresh.pending.reason as WaitReason, fresh.pending.until - now), indent: 0, emphasis: true });
  }
  const h = Math.max(1, rowsMax);
  if (!out.length) return Array.from({ length: h }, (_, i) => (i === Math.floor((h - 1) / 2) ? { marker: "none" as Marker, text: "-", indent: Math.floor((width - 1) / 2) } : { marker: "none" as Marker, text: "", indent: 0 }));
  const shown = out.slice(0, h);
  return [...shown, ...Array.from({ length: h - shown.length }, () => ({ marker: "none" as Marker, text: "", indent: 0 }))];
}

/** flow 화면 (flow-view-spec §2): 맨 윗줄 "Flow Monitor" · "Total d/t", Current Task(지금 돌고 있는 일), Overall Flow, Completed Flow */
export function flowModel(flow: FlowLike | null, live: LiveState | null, ui: FlowUiState, width: number, height: number, now: number,
  w: (s: string) => number, history: FlowHistory | null = null, jobs: JobSnapshot[] = []): MonitorModel {
  const plan = flow?.plan ?? [];
  const leaves = leavesOf(plan).filter((x) => x.status !== "dropped");
  const right = leaves.length ? "Total " + leaves.filter((x) => x.status === "done").length + "/" + leaves.length : "";
  const title = !right || TITLE_MARK_WIDTH + w(FLOW_TITLE) + 1 + w(right) <= width ? FLOW_TITLE : "Flow";
  const noticeLines = ui.notice ? [ui.notice] : [];
  const keys = [...noticeLines, ...keyLines(ui.confirm ? ["←→ 이동", "Enter 선택", "Esc 취소"] : ["▲▼ 이동", "Enter 펼치기", "r 되돌리기", "u 되돌리기 취소", "q 닫기"], width, w)];
  const top = currentWorkRows(live, jobs, width, now, height >= STATE_ROW_MIN_HEIGHT ? CURRENT_ROWS : 2);
  const rows = flow ? planRows(flow, ui.open, width, history?.marks[flow.id ?? ""]) : [{ marker: "none" as Marker, text: "작업 기록이 없습니다.", indent: 0 }];
  const done = completedRows(history, ui.open, flow?.rollbacks ?? []);
  // 높이: 맨 윗줄 1 + Current Task 가로줄 1 + 그 줄들 + Overall Task 가로줄 1 + 트리 + (Completed Flow 가로줄 1 + 그 줄들) + 키 안내.
  // Completed Flow 는 남는 자리의 40% 까지 (최소 2줄, 트리는 최소 1줄). 고른 줄이 그 안에 있으면 그 줄이 보이게 자른다
  const free = Math.max(0, height - 3 - top.length - keys.length);
  const compRoom = done.length ? Math.min(done.length, Math.max(2, Math.floor((free - 1) * 0.4)), Math.max(0, free - 2)) : 0;
  const room = Math.max(1, free - (compRoom ? 1 + compRoom : 0));
  const all = [...rows, ...done];
  const selected = flowSelection(all, plan, ui, now);
  const selIdx = selected ? rows.findIndex((r) => r.key === selected) : -1;
  const startAt = windowAround(rows.length, room, selIdx >= 0 ? selIdx : 0);
  const compIdx = selected ? done.findIndex((r) => r.key === selected) : -1;
  const compAt = windowAround(done.length, compRoom, compIdx);
  const popup = ui.confirm ? { popup: flowPopup(ui.confirm) } : {};
  return {
    op: "monitor", kind: "flow", title, right, now: [], nowAt: "top",
    sections: [{ title: "Current Task", rows: top }, { title: OVERALL_TITLE, rows: rows.slice(startAt, startAt + room) },
      ...(compRoom ? [{ title: COMPLETED_TITLE, rows: done.slice(compAt, compAt + compRoom) }] : [])],
    selected, keys, ...popup,
  };
}

// ------------------------------------------------------------------ jobs (docs/jobs-view-spec.md §2)

const jobMarker = (s: string): Marker => (s === "running" ? "spinner" : s === "queued" ? "todo" : s === "done" ? "done" : s === "failed" ? "failed" : "stopped");
export const isActive = (j?: JobSnapshot | null): boolean => Boolean(j && (j.state === "running" || j.state === "queued"));

/** 목록 순서: 실행 중 · 대기 → 최근에 끝난 것 */
export function jobOrder(jobs: JobSnapshot[]): JobSnapshot[] {
  return [...jobs].sort((a, b) => Number(isActive(b)) - Number(isActive(a)) || (b.endedAt ?? b.createdAt) - (a.endedAt ?? a.createdAt));
}

export const JOBS_TITLE = "Job Monitor";

/** 중지할 대상: main = 본 대화의 작업(셸 · subagent), child = subagent 가 띄운 셸 (sub = 그 subagent 의 작업 id) */
export interface StopTarget { scope: "main" | "child"; id: string; sub?: string; label: string; agent?: boolean }
export interface JobsUiState {
  mode: "list" | "sub" | "log";
  sel: string | null;                       // 목록: "m:<id>" · "s:<id>", subagent 화면: "sublog" · "c:<id>"
  sub: string | null;                       // 연 subagent 의 작업 id
  log: { scope: "main" | "child"; id: string; sub?: string } | null;
  back: "list" | "sub";                     // 로그를 닫으면 돌아갈 화면
  confirm: (StopTarget & { focus: "yes" | "no" }) | null;   // 중지 확인 팝업 (J3, 처음 포커스는 no)
  notice?: string;
}
export const jobsUiInit = (): JobsUiState => ({ mode: "list", sel: null, sub: null, log: null, back: "list", confirm: null });

/** 본 대화 · subagent 들의 진행 중인 작업 (J4: 끝난 작업은 목록에서 뺀다) */
export function jobLists(state: JobsState | null, subs: Map<string, JobsState>) {
  const all = state ? jobOrder(state.jobs) : [];
  const main = all.filter((j) => j.kind !== "agent" && isActive(j));
  const agents = all.filter((j) => j.kind === "agent" && isActive(j));
  const children = (sub: string) => jobOrder(subs.get(sub)?.jobs ?? []).filter(isActive);
  return { main, agents, children, find: (id: string) => all.find((j) => j.id === id) ?? null,
    findChild: (sub: string, id: string) => subs.get(sub)?.jobs.find((j) => j.id === id) ?? null };
}

const jobRow = (key: string, j: JobSnapshot, badge?: string): Row => ({ key, marker: jobMarker(j.state), text: j.label, indent: 0,
  ...(badge ? { badge } : {}), ...(isActive(j) ? { since: j.startedAt ?? j.createdAt } : { right: clock((j.endedAt ?? Date.now()) - (j.startedAt ?? j.createdAt)) }) });

/** 높이 h 의 영역: 작업이 없으면 가로 · 세로 가운데에 "-" (사용자 결정), 있으면 고른 줄이 보이게 잘라 빈 줄로 채운다 */
export function areaRows(rows: Row[], h: number, width: number, sel: string | null): Row[] {
  if (h <= 0) return [];
  const blank = (): Row => ({ marker: "none", text: "", indent: 0 });
  if (!rows.length) return Array.from({ length: h }, (_, i) => (i === Math.floor((h - 1) / 2) ? { marker: "none", text: "-", indent: Math.floor((width - 1) / 2) } : blank()));
  const idx = sel ? rows.findIndex((r) => r.key === sel) : -1;
  const start = windowAround(rows.length, h, idx);
  const shown = rows.slice(start, start + h);
  return [...shown, ...Array.from({ length: h - shown.length }, blank)];
}

/** 두 영역의 높이: 반씩 (홀수면 Main 이 한 줄 더). 작업이 있는 영역이 짧으면 넘치는 다른 영역에 남는 줄을 넘긴다. 빈 영역은 몫을 그대로 */
export function splitAreas(room: number, a: number, b: number): [number, number] {
  let ha = Math.ceil(room / 2), hb = room - ha;
  if (a && a < ha && b > hb) { const g = Math.min(ha - a, b - hb); ha -= g; hb += g; }
  if (b && b < hb && a > ha) { const g = Math.min(hb - b, a - ha); hb -= g; ha += g; }
  return [ha, hb];
}

const firstName = (j: JobSnapshot) => j.agent ?? j.label.split(":")[0];

function popupOf(c: NonNullable<JobsUiState["confirm"]>): Popup {
  return { title: "작업 중지", lines: [`${c.label} 작업을 중지할까요?`, c.agent ? "그 subagent 와 그것이 띄운 셸이 모두 끝납니다." : "실행 중인 명령과 그 하위 프로세스가 끝납니다."],
    buttons: ["중지", "취소"], focus: c.focus === "yes" ? 0 : 1, danger: 0 };
}

export function jobsModel(state: JobsState | null, subs: Map<string, JobsState>, live: LiveState | null, ui: JobsUiState, width: number, height: number,
  now: number, w: (s: string) => number, logLines: string[] = []): MonitorModel {
  const L = jobLists(state, subs);
  const narrow = width < NARROW;
  const popup = ui.confirm ? { popup: popupOf(ui.confirm) } : {};
  const noticeLines = ui.notice ? [ui.notice] : [];
  const keysFor = (k: string[]) => [...noticeLines, ...keyLines(ui.confirm ? ["←→ 이동", "Enter 선택", "Esc 취소"] : k, width, w)];
  const titled = (full: string, right: string) => (TITLE_MARK_WIDTH + w(full) + 1 + w(right) <= width ? full : "Jobs");

  // 로그 화면
  if (ui.mode === "log" && ui.log) {
    const j = ui.log.scope === "child" ? L.findChild(ui.log.sub!, ui.log.id) : L.find(ui.log.id);
    const keys = keysFor(["▲▼ 스크롤", "Esc 돌아가기", ...(isActive(j) ? ["s 중지"] : [])]);
    const room = Math.max(1, height - 1 - keys.length);
    const lines = logLines.slice(-room).map((l) => ({ marker: "none" as Marker, text: l, indent: 0 }));
    return { op: "monitor", kind: "jobs", title: `${j ? j.label : ui.log.id} 로그`, right: j?.state ?? "", now: [], nowAt: "bottom",
      sections: [{ rows: lines }], selected: null, keys, ...popup };
  }

  // subagent 화면
  const agent = ui.mode === "sub" && ui.sub ? L.agents.find((j) => j.id === ui.sub) : undefined;
  if (agent) {
    const kids = L.children(agent.id);
    const rows = kids.map((c) => jobRow(`c:${c.id}`, c));
    const keyList = ["sublog", ...rows.map((r) => r.key!)];
    const sel = ui.sel && keyList.includes(ui.sel) ? ui.sel : "sublog";
    const selJob = sel.startsWith("c:") ? kids.find((c) => `c:${c.id}` === sel) : undefined;
    const keys = keysFor(["▲▼ 이동", "Enter 로그", ...(selJob ? ["s 중지"] : []), "Esc 목록"]);
    const right = `Processing ${kids.length}`;
    const status: Row = { marker: agent.state === "running" ? "spinner" : "todo", text: `${firstName(agent)} ${agent.state === "running" ? "실행 중" : "대기 중"}`,
      since: agent.startedAt ?? agent.createdAt, indent: 0, emphasis: agent.state === "running" };
    // 높이: 맨 윗줄 1 + 구역 가로줄 1 + (대화 로그 1 + 셸 영역) + 가로줄 1 + 상태 1 + 키 안내
    const room = Math.max(2, height - 4 - keys.length);
    return { op: "monitor", kind: "jobs", title: titled(firstName(agent), right), right, now: [status], nowAt: "bottom",
      sections: [{ title: agent.label, rows: [{ key: "sublog", marker: "none", text: "대화 로그", indent: 2 }, ...areaRows(rows, room - 1, width, sel)] }],
      selected: sel, keys, ...popup };
  }

  // 목록: Main Background · Subagent
  const mainRows = L.main.map((j) => jobRow(`m:${j.id}`, j));
  const subRows = L.agents.map((j) => { const n = L.children(j.id).length; return jobRow(`s:${j.id}`, j, n && !narrow ? `셸 ${n}` : undefined); });
  const keyList = [...mainRows, ...subRows].map((r) => r.key!);
  const sel = ui.sel && keyList.includes(ui.sel) ? ui.sel : keyList[0] ?? null;
  const right = state ? `Processing ${L.main.length + L.agents.length}` : "";
  const keys = keysFor(keyList.length ? ["▲▼ 이동", "Enter 열기", "s 중지", "q 닫기"] : ["q 닫기"]);
  // 높이: 맨 윗줄 1 + 가로줄 2 (Main · Sub) + 영역 + 가로줄 1 + 지금 1 + 키 안내
  const room = Math.max(2, height - 5 - keys.length);
  const [hm, hs] = splitAreas(room, mainRows.length, subRows.length);
  return {
    op: "monitor", kind: "jobs", title: titled(JOBS_TITLE, right), right, now: [stateRow(live, now)], nowAt: "bottom",
    sections: [{ title: "Main Background", rows: areaRows(mainRows, hm, width, sel) }, { title: "Subagent", rows: areaRows(subRows, hs, width, sel) }],
    selected: sel, keys, ...popup,
  };
}

/** 모델이 차지하는 줄 수 (화면 프로그램이 그리는 규칙과 같다: 제목 · 지금 · 구역 사이 가로줄 · 구역 제목 · 키 안내) */
export function modelHeight(m: MonitorModel): number {
  const sections = m.sections.reduce((a, s) => a + s.rows.length + (s.title ? 1 : 0), 0);
  // 가로줄: 지금과 첫 구역 사이 1 (지금이 있을 때), 구역 사이 (구역 수 - 1). 구역 제목은 가로줄 자리에 함께 쓴다
  const rules = (m.now.length ? 1 : 0) + Math.max(0, m.sections.length - 1);
  const titles = m.sections.filter((s, i) => s.title && i > 0).length;
  return 1 + m.now.length + rules + sections - titles + m.keys.length;
}
