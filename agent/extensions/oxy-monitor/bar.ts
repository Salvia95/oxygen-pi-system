// 하단 바 (docs/monitor-spec.md §2): 입력창 아래 한 줄. 항목 jobs · flow 를 키보드(빈 입력창에서 ↓ → ←→ → Enter)나 클릭으로 켜고 끈다.
// 상태 → 항목 · 줄 · 클릭 범위를 만드는 순수 함수만 둔다 (색과 폭 계산은 받는다).

export type BarKind = "jobs" | "flow";
export interface JobsSummary { active: number; recent: number }          // 실행 중 · 대기 / 최근 2분 안에 끝남
export interface FlowSummary { hasContent: boolean; done: number; total: number; node: string }
export interface BarItem { kind: BarKind; label: string; open: boolean }
export interface BarRange { kind: BarKind; start: number; end: number }  // 표시 열 [start, end)

/**
 * 바에 보일 항목. jobs: 실행 중이거나 최근 2분 안에 끝난 작업이 있을 때, flow: 기록이 있을 때.
 * 모니터가 열려 있으면 내용이 없어도 보인다 (닫을 수 있게).
 */
export function barItems(jobs: JobsSummary | null, flow: FlowSummary | null, open: Set<string>): BarItem[] {
  const items: BarItem[] = [];
  if (jobs && (jobs.active || jobs.recent) || open.has("jobs")) {
    const parts = [jobs?.active ? `${jobs.active} 실행 중` : "", jobs?.recent ? `${jobs.recent} 완료` : ""].filter(Boolean);
    items.push({ kind: "jobs", label: `jobs${parts.length ? ` ${parts.join(" · ")}` : ""}`, open: open.has("jobs") });
  }
  if (flow?.hasContent || open.has("flow")) {
    const p = flow?.total ? `${flow.done}/${flow.total}` : flow?.node ?? "";
    items.push({ kind: "flow", label: `flow${p ? ` ${p}` : ""}`, open: open.has("flow") });
  }
  return items;
}

export interface BarStyle {
  width: (s: string) => number;
  item: (text: string, open: boolean) => string;   // 열린 모니터는 강조색
  focus: (text: string) => string;                 // 키보드로 선택한 항목
  hint: (text: string) => string;
}

const GAP = "   ";

/** 한 줄과 클릭 범위. focus: 키보드로 선택한 항목 (-1 = 없음). 바에 들어온 동안에는 오른쪽에 키 안내 */
export function barLine(items: BarItem[], focus: number, width: number, s: BarStyle): { line: string; ranges: BarRange[] } {
  const ranges: BarRange[] = [];
  let col = 0;
  let line = "";
  items.forEach((it, i) => {
    const plain = `▸ ${it.label}`;
    const w = s.width(plain);
    if (col + (i ? GAP.length : 0) + w > width) return;
    if (i) { line += GAP; col += GAP.length; }
    ranges.push({ kind: it.kind, start: col, end: col + w });
    line += i === focus ? s.focus(plain) : s.item(plain, it.open);
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
