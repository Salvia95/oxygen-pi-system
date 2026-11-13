// 하단 바 (docs/monitor-spec.md §2, 모양은 docs/ui-unify-spec.md §2.2): 입력창 아래 한 줄.
// 항목 Jobs · Flow 를 키보드(빈 입력창에서 ↓ → ←→ → Enter)나 클릭으로 켜고 끈다.
//    ◐ Flow: 2/5   ◐ Jobs: 1
// 상태 → 항목 · 줄 · 클릭 범위를 만드는 순수 함수만 둔다 (색 · 기호 · 폭 계산은 받는다).

export type BarKind = "jobs" | "flow";
/** 실행 중 · 대기 / 최근 2분 안에 끝남 / 그 가운데 실패 */
export interface JobsSummary { active: number; recent: number; failed?: number }
export interface FlowSummary { hasContent: boolean; done: number; total: number; node: string }
/** 항목 앞 기호가 보일 상태: 진행 중(스피너) · 끝남(✓) · 실패(×) · 할 것 없음(·) */
export type BarState = "running" | "ok" | "fail" | "idle";
export interface BarItem { kind: BarKind; label: string; open: boolean; state: BarState }
export interface BarRange { kind: BarKind; start: number; end: number }  // 표시 열 [start, end)

/**
 * 바에 보일 항목 (사용자, 2026-11-13: "Flow: n/n Jobs: n 과 같이 콜론 … Jobs 가 0 일 때도 표시"):
 *   Flow: 기록이 있을 때 `Flow: 3/7` (계획이 없으면 마지막 단계 `Flow: n4`)
 *   Jobs: oxy-jobs 가 있으면 늘 `Jobs: <실행 중 · 대기 수>` (0 이어도 보여 Job Monitor 를 열 수 있다)
 * 모니터가 열려 있으면 내용이 없어도 보인다 (닫을 수 있게). 순서는 Flow → Jobs.
 */
export function barItems(jobs: JobsSummary | null, flow: FlowSummary | null, open: Set<string>): BarItem[] {
  const items: BarItem[] = [];
  if (flow?.hasContent || open.has("flow")) {
    const p = flow?.total ? `${flow.done}/${flow.total}` : flow?.node || "-";
    const state: BarState = flow?.total ? (flow.done < flow.total ? "running" : "ok") : "idle";
    items.push({ kind: "flow", label: `Flow: ${p}`, open: open.has("flow"), state });
  }
  if (jobs || open.has("jobs")) {
    const state: BarState = jobs?.active ? "running" : jobs?.failed ? "fail" : jobs?.recent ? "ok" : "idle";
    items.push({ kind: "jobs", label: `Jobs: ${jobs?.active ?? 0}`, open: open.has("jobs"), state });
  }
  return items;
}

export interface BarStyle {
  width: (s: string) => number;
  glyph: (state: BarState) => string;              // 색을 입힌 1칸 기호
  item: (text: string, open: boolean) => string;   // 열린 모니터는 시그니처 색
  focus: (text: string) => string;                 // 키보드로 선택한 항목
  hint: (text: string) => string;
}

const GAP = "   ";
const LEAD = 1;   // 왼쪽 여백 1칸 (푸터 · 도구 줄과 같은 시작 칸)

/** 한 줄과 클릭 범위. focus: 키보드로 선택한 항목 (-1 = 없음). 바에 들어온 동안에는 오른쪽에 키 안내 */
export function barLine(items: BarItem[], focus: number, width: number, s: BarStyle): { line: string; ranges: BarRange[] } {
  const ranges: BarRange[] = [];
  let col = LEAD;
  let line = " ".repeat(LEAD);
  items.forEach((it, i) => {
    const w = 2 + s.width(it.label);                // 기호 1칸 + 빈칸 + 이름
    if (col + (i ? GAP.length : 0) + w > width) return;
    if (i) { line += GAP; col += GAP.length; }
    ranges.push({ kind: it.kind, start: col, end: col + w });
    const text = `${s.glyph(it.state)} ${i === focus ? it.label : s.item(it.label, it.open)}`;
    line += i === focus ? s.focus(text) : text;
    col += w;
  });
  if (focus >= 0) {
    const hint = "←→ 이동  Enter 열기·닫기  ↑ 입력창";
    if (col + 4 + s.width(hint) <= width) line += `    ${s.hint(hint)}`;
  }
  return { line, ranges };
}

/** 클릭한 열의 항목 */
export const itemAt = (ranges: BarRange[], x: number): BarKind | undefined => ranges.find((r) => x >= r.start && x < r.end)?.kind;
