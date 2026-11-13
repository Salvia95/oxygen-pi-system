// grep (rg) 결과를 파일별로 묶는다 (docs/pi-tui-spec.md §7.1) 순수 함수. 모델이 받는 글은 그대로다.
// pi 1.5.0 core/tools/grep.js 의 결과 글: 일치 `경로:줄: 내용`, 문맥 `경로-줄- 내용`, 끝에 `\n\n[안내]`, 없으면 `No matches found`.
import { type Measure, middle, spread } from "../layout.ts";
import type { BodyLine, ToolPaint } from "./frame.ts";

export interface GrepLine { n: number; text: string; match: boolean }
export interface GrepFile { path: string; matches: number; lines: GrepLine[] }
export interface GrepParsed { files: GrepFile[]; matches: number }

const LINE = /^(.*?)([:-])(\d+)\2 (.*)$/;

export function parseGrep(text: string): GrepParsed | null {
  let t = text.replace(/\r\n/g, "\n");
  if (t.trim() === "No matches found") return { files: [], matches: 0 };
  t = t.replace(/\n\n\[[^\n]*\]\s*$/, "");                 // 끝의 안내 (결과 수 제한 · 크기 제한 · 줄 잘림)
  const files: GrepFile[] = [];
  const byPath = new Map<string, { f: GrepFile; seen: Map<number, GrepLine> }>();
  for (const raw of t.split("\n")) {
    if (!raw.trim()) continue;
    const m = raw.match(LINE);
    if (!m) return null;                                    // 모르는 모양 → pi 기본 그리기
    const [, path, sep, num, body] = m;
    let e = byPath.get(path);
    if (!e) { e = { f: { path, matches: 0, lines: [] }, seen: new Map() }; byPath.set(path, e); files.push(e.f); }
    const n = Number(num);
    const prev = e.seen.get(n);
    if (prev) { if (sep === ":" && !prev.match) { prev.match = true; e.f.matches++; } continue; }   // 문맥이 겹쳐 같은 줄이 다시 나옴
    const line = { n, text: body, match: sep === ":" };
    e.seen.set(n, line);
    e.f.lines.push(line);
    if (line.match) e.f.matches++;
  }
  for (const f of files) f.lines.sort((a, b) => a.n - b.n);
  return { files, matches: files.reduce((s, f) => s + f.matches, 0) };
}

export interface GrepDetails { matchLimitReached?: number; linesTruncated?: boolean; truncation?: { truncated?: boolean } }

/** 요약 글 (색 없이): `3개 파일에서 7개 결과` · `결과 없음`, 그리고 잘림 안내 */
export function grepSummary(g: GrepParsed, d: GrepDetails | undefined): { text: string; warn: string } {
  const text = g.matches === 0 ? "결과 없음" : `${g.files.length}개 파일에서 ${g.matches}개 결과`;
  const warn = [
    d?.matchLimitReached ? `결과 ${d.matchLimitReached}개에서 멈춤` : "",
    d?.truncation?.truncated ? "크기 제한으로 잘림" : "",
    d?.linesTruncated ? "일부 줄 잘림" : "",
  ].filter(Boolean).join(" · ");
  return { text, warn };
}

/** 패턴 → 강조용 정규식 (만들 수 없으면 null) */
export function matcher(pattern: unknown, opts: { literal?: boolean; ignoreCase?: boolean }): RegExp | null {
  if (typeof pattern !== "string" || !pattern) return null;
  const src = opts.literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern;
  try { return new RegExp(src, `g${opts.ignoreCase ? "i" : ""}`); } catch { return null; }
}

/** 일치 부분만 칠한다 (빈 일치는 건너뜀) */
export function highlight(text: string, re: RegExp | null, paint: (s: string) => string): string {
  if (!re) return text;
  let out = "", last = 0;
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (!m[0]) { re.lastIndex++; continue; }
    out += text.slice(last, m.index) + paint(m[0]);
    last = m.index + m[0].length;
  }
  return out + text.slice(last);
}

/** 접힌 본문: 파일마다 한 줄, 오른쪽 끝에 결과 수 */
export function grepCollapsed(m: Measure, g: GrepParsed, p: ToolPaint): BodyLine[] {
  return g.files.map((f) => (w: number) => {
    const count = String(f.matches);
    const path = middle(m, f.path, Math.max(4, w - m.width(count) - 2));
    return spread(m, p.fg("accent", path), p.fg("muted", count), w);
  });
}

/** 펼친 본문: 파일 이름 아래 `<줄 번호> │ <내용>`. 일치 부분 강조, 문맥 줄은 muted */
export function grepExpanded(m: Measure, g: GrepParsed, re: RegExp | null, vbar: string, p: ToolPaint): BodyLine[] {
  const out: BodyLine[] = [];
  const digits = Math.max(1, ...g.files.flatMap((f) => f.lines.filter((l) => l.n > 0).map((l) => String(l.n).length)));
  const hit = (s: string) => (p.bg ? p.bg("searchMatchBg", p.fg("searchMatchText", s)) : p.bold(s));
  for (const f of g.files) {
    out.push((w: number) => p.fg("accent", middle(m, f.path, Math.max(4, w))));
    for (const l of f.lines) {
      const num = l.n > 0 ? String(l.n).padStart(digits) : " ".repeat(digits);   // rg 를 -n 없이 부르면 줄 번호가 없다
      const body = l.match ? highlight(l.text, re, hit) : p.fg("muted", l.text);
      out.push(`  ${p.fg(l.match ? "muted" : "dim", num)} ${p.fg("muted", vbar)} ${body}`);
    }
  }
  return out;
}

/** 첫 줄 인자: `/<패턴>/[i] in <경로>` + ` (<glob>)` · ` ±<문맥>` · ` limit <n>` */
export function grepArgs(a: any, path: string): string {
  const pat = typeof a?.pattern === "string" ? a.pattern : "";
  let s = a?.literal ? `"${pat}"` : `/${pat}/${a?.ignoreCase ? "i" : ""}`;
  s += ` in ${path || "."}`;
  if (a?.glob) s += ` (${a.glob})`;
  if (Number(a?.context) > 0) s += ` ±${Number(a.context)}`;
  if (a?.limit != null) s += ` limit ${a.limit}`;
  return s;
}
