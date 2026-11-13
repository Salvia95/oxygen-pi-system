// 푸터 (docs/pi-tui-spec.md §6) 순수 함수.
//    ~/workspace/oxygen-pi-system  main          flow n4 · 할 일 2/5  ·  작업 1개 실행 중
import { type Measure, lastSegment, middle } from "./layout.ts";

/** 푸터에 그리지 않는 상태 키: oxy-ctx 는 입력창 아랫줄에, psmux 하단 바가 켜져 있으면 flow · jobs 는 바에 */
export function footerStatuses(statuses: ReadonlyMap<string, string>, barMode: boolean): string[] {
  const skip = new Set(["oxy-ctx", ...(barMode ? ["oxy-flow", "oxy-jobs"] : [])]);
  const order = (k: string) => (k === "oxy-flow" ? 0 : k === "oxy-jobs" ? 1 : 2);
  return [...statuses.entries()]
    .filter(([k, v]) => !skip.has(k) && v && v.trim())
    .sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b))
    .map(([, v]) => v.replace(/[\r\n]+/g, " ").trim());
}

/** muted: 폴더 · 구분자 (회색), text: 상태 글 (한글이 많아 회색으로 쓰지 않는다) */
export interface FooterPaint { muted(s: string): string; text?(s: string): string; accent(s: string): string; sep: string }

/**
 * 한 줄 (width 칸 이하). 왼쪽: ` <폴더>  <브랜치>`, 오른쪽: 상태 글을 ` · ` 로.
 * 넘치면 (1) 폴더를 `…/<마지막 단계>` 로 (2) 상태 글을 뒤에서부터 자르고 (3) 그래도 8칸이 안 되면 상태를 뺀 뒤
 * (4) 폴더를 가운데 말줄임. 브랜치는 끝까지 남긴다. 상태(바뀌는 정보)를 폴더 전체 경로보다 먼저 지킨다.
 */
export function footerLine(m: Measure, width: number, cwd: string, branch: string | undefined, statuses: string[], p: FooterPaint): string {
  if (width <= 0) return "";
  const br = branch ? `  ${branch}` : "";
  const gap = 2;
  const leftW = (d: string) => 1 + m.width(d) + m.width(br);
  const right = statuses.join(`  ${p.sep}  `);
  let dir = cwd;
  let r = right;
  const fits = () => leftW(dir) + (r ? gap + m.width(r) : 0) <= width;
  if (!fits()) dir = lastSegment(cwd);
  if (!fits() && r) {
    const room = width - leftW(dir) - gap;
    r = room >= 8 ? m.trunc(r, room, "…") : "";
  }
  if (leftW(dir) > width) dir = middle(m, dir, Math.max(1, width - 1 - m.width(br)));
  const left = ` ${p.muted(dir)}${br ? `  ${p.accent(branch!)}` : ""}`;
  const pad = r ? Math.max(gap, width - leftW(dir) - m.width(r)) : 0;
  const styledRight = r ? r.split(`  ${p.sep}  `).map((x) => (p.text ?? p.muted)(x)).join(`  ${p.muted(p.sep)}  `) : "";
  const line = left + " ".repeat(pad) + styledRight;
  return m.width(line) > width ? m.trunc(line, width, "") : line;
}
