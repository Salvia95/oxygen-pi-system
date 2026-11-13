// 줄 배치 순수 함수 (docs/pi-tui-spec.md §2). 폭 계산은 받는다 (pi-tui 의 visibleWidth · truncateToWidth, 테스트는 같은 것을 주입).

export interface Measure {
  /** 보이는 칸 수 (ANSI 제외, 한글 2칸) */
  width(s: string): number;
  /** 보이는 칸 수 w 이하로 자른다. 잘렸으면 끝에 ellipsis */
  trunc(s: string, w: number, ellipsis?: string): string;
}

export type WidthClass = "wide" | "normal" | "narrow";

/** 넓음 ≥ 100칸, 보통 64–99칸, 좁음 < 64칸 (psmux 안 80×24 = 56칸) */
export function widthClass(width: number): WidthClass {
  return width >= 100 ? "wide" : width >= 64 ? "normal" : "narrow";
}

/**
 * 왼쪽 글과 오른쪽 글을 한 줄(정확히 width 칸)에. 사이는 fill 로 채우고 최소 gap 칸을 둔다.
 * 넘치면 오른쪽부터 줄이고(없어질 때까지), 그래도 넘치면 왼쪽을 자른다.
 */
export function spread(m: Measure, left: string, right: string, width: number, fill = " ", gap = 1): string {
  if (width <= 0) return "";
  let r = right;
  const room = () => width - m.width(left) - gap;
  if (r && m.width(r) > room()) r = room() >= 2 ? m.trunc(r, room(), "…") : "";
  let l = left;
  if (m.width(l) + (r ? gap + m.width(r) : 0) > width) l = m.trunc(l, width - (r ? gap + m.width(r) : 0), "…");
  const pad = Math.max(0, width - m.width(l) - m.width(r));
  return l + fill.repeat(pad) + r;
}

/** 글자 하나의 칸 수 (ANSI 없는 글 기준) */
function cells(m: Measure, ch: string): number { return m.width(ch); }

/**
 * 가운데 말줄임 (ANSI 없는 글, 주로 경로). max 칸 이하로. 앞쪽을 조금 더 남긴다.
 *   "C:/Users/kim/workspace/app/src/db" → "C:/Users/…/src/db"
 */
export function middle(m: Measure, s: string, max: number, ell = "…"): string {
  if (m.width(s) <= max) return s;
  const ew = m.width(ell);
  if (max <= ew) return m.trunc(s, max, "");
  const chars = [...s];
  const budget = max - ew;
  const headBudget = Math.ceil(budget / 2);
  let head = "", hw = 0, i = 0;
  while (i < chars.length && hw + cells(m, chars[i]) <= headBudget) { hw += cells(m, chars[i]); head += chars[i]; i++; }
  let tail = "", tw = 0, j = chars.length - 1;
  while (j >= i && hw + tw + cells(m, chars[j]) <= budget) { tw += cells(m, chars[j]); tail = chars[j] + tail; j--; }
  return head + ell + tail;
}

/** 경로 표시: 역슬래시를 / 로, 홈 아래면 ~ 로 (대소문자 무시) */
export function homePath(cwd: string, home: string | undefined): string {
  const p = cwd.replace(/\\/g, "/");
  const h = home?.replace(/\\/g, "/").replace(/\/+$/, "");
  if (h && (p.toLowerCase() === h.toLowerCase() || p.toLowerCase().startsWith(`${h.toLowerCase()}/`))) return `~${p.slice(h.length)}`;
  return p;
}

/** 마지막 한 단계만: "…/oxygen-pi-system" (단계가 하나뿐이면 그대로) */
export function lastSegment(path: string, ell = "…"): string {
  const parts = path.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  return parts.length <= 1 ? path : `${ell}/${parts.at(-1)}`;
}
