// 도구 줄 공통 틀 (docs/pi-tui-spec.md §4) 순수 함수.
//    ✓ grep /registerTool/ in agent/extensions                0.2s     ← 첫 줄 (renderCall)
//    └ 3개 파일에서 7개 결과                                           ← 요약 (renderResult)
//      agent/extensions/oxy-flow/index.ts                       3     ← 본문 (3칸 들여)
import type { Glyphs } from "../glyphs.ts";
import { type Measure, spread } from "../layout.ts";

export type ToolStatus = "running" | "ok" | "fail";

/** 테마의 일부 (pi Theme 과 같은 모양). 단위 시험은 글을 그대로 돌려주는 것을 넘긴다 */
export interface ToolPaint { fg(token: string, s: string): string; bold(s: string): string; bg?(token: string, s: string): string }

/** 본문 한 줄: 글, 또는 쓸 수 있는 칸 수를 받아 글을 만드는 함수 (오른쪽 맞춤 등) */
export type BodyLine = string | ((width: number) => string);

/** 처음(펼치기 전) 보이는 본문 줄 수 (사용자, 2026-11-13: "화면에 최초 노출되는 것은 3줄이면 충분") */
export const COLLAPSED_LINES = 3;

/** 0.4s · 12.4s · 1m 3s */
export function fmtDuration(ms: number | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "";
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function statusOf(c: { isPartial?: boolean; isError?: boolean; executionStarted?: boolean; hasResult?: boolean }): ToolStatus {
  if (c.isError) return "fail";
  return c.isPartial || !c.hasResult ? "running" : "ok";
}

/** 첫 줄: ` <기호> <제목> <인자>` + 오른쪽 끝 걸린 시간 */
export function callLine(m: Measure, g: Glyphs, width: number, v: { status: ToolStatus; title: string; args: string; durationMs?: number; right?: string }, p: ToolPaint): string {
  const glyph = v.status === "running" ? p.fg("warning", g.running) : v.status === "fail" ? p.fg("error", g.fail) : p.fg("success", g.ok);
  const left = ` ${glyph} ${p.fg("toolTitle", p.bold(v.title))}${v.args ? ` ${p.fg("accent", v.args)}` : ""}`;
  // right: 이미 만든 오른쪽 글 (background 알림의 걸린 시간 등). 없으면 끝난 뒤의 durationMs
  const dur = v.right ?? (v.status === "running" ? "" : fmtDuration(v.durationMs));
  const right = dur ? `${p.fg("muted", dur)} ` : "";
  // 넘치면 시간은 남기고 인자를 자른다
  const room = width - (right ? m.width(right) + 1 : 0);
  const l = m.width(left) > room ? m.trunc(left, Math.max(1, room), "…") : left;
  return spread(m, l, right, width);
}

export interface ResultView {
  /** 요약 글 (이미 색을 입힌 것) */
  summary: string;
  /** 본문 줄 전체 (색을 입힌 것, 들여쓰기 없이). 줄 수가 너비에 따라 바뀌면 (너비) → 줄 함수 */
  body: BodyLine[] | ((width: number) => string[]);
  /** 접혔을 때 앞(head) 을 보일지 뒤(tail) 를 보일지. 로그는 tail */
  keep: "head" | "tail";
  /** 펼쳤을 때의 상한 */
  max: number;
  /** 숨은 수의 단위 (영어 단수): line · file · folder */
  unit: string;
}

/** 키 이름을 안내 글로: `ctrl+o` → `Ctrl + O` */
export function keyLabel(key: string): string {
  return key.split("+").map((k) => (k.length === 1 ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1))).join(" + ");
}

/** 단위의 단 · 복수: `line` · `lines` */
export function plural(n: number, unit: string): string {
  return `${unit}${n === 1 ? "" : "s"}`;
}

/**
 * 요약 줄 + 본문 (docs/pi-tui-spec.md §4).
 *   기본: 본문 COLLAPSED_LINES 줄, 넘치면 `...34 more lines (Ctrl + O for opening, Ctrl + K to fold)`
 *   펼침(Ctrl + O): 본문 max 줄까지, 넘치면 `...34 more lines`
 *   접음(Ctrl + K, folded): 요약 줄만 (본문을 그리지 않는다)
 */
export function resultLines(m: Measure, g: Glyphs, width: number, v: ResultView, expanded: boolean,
  keys: { open: string; fold: string }, p: ToolPaint, folded = false): string[] {
  const out = [m.trunc(` ${p.fg("muted", g.elbow)} ${v.summary}`, width, "…")];
  if (folded) return out;
  const inner = Math.max(1, width - 3);
  const all = typeof v.body === "function" ? v.body(inner) : v.body.map((l) => (typeof l === "function" ? l(inner) : l));
  const limit = expanded ? v.max : COLLAPSED_LINES;
  const body = v.keep === "tail" ? all.slice(-limit) : all.slice(0, limit);
  const hidden = all.length - body.length;
  const more = hidden > 0
    ? `   ${p.fg("text", `...${hidden} more ${plural(hidden, v.unit)}${expanded ? "" : ` (${keyLabel(keys.open)} for opening, ${keyLabel(keys.fold)} to fold)`}`)}`
    : "";
  if (more && v.keep === "tail") out.push(m.trunc(more, width, ""));
  for (const line of body) out.push(m.trunc(`   ${line}`, width, "…"));
  if (more && v.keep === "head") out.push(m.trunc(more, width, ""));
  return out;
}
