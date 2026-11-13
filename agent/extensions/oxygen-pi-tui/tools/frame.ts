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

/** 접힌 상태에서 보이는 본문 줄 수 */
export const COLLAPSED_LINES = 8;

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
export function callLine(m: Measure, g: Glyphs, width: number, v: { status: ToolStatus; title: string; args: string; durationMs?: number }, p: ToolPaint): string {
  const glyph = v.status === "running" ? p.fg("warning", g.running) : v.status === "fail" ? p.fg("error", g.fail) : p.fg("success", g.ok);
  const left = ` ${glyph} ${p.fg("toolTitle", p.bold(v.title))}${v.args ? ` ${p.fg("accent", v.args)}` : ""}`;
  const dur = v.status === "running" ? "" : fmtDuration(v.durationMs);
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
  /** "개" · "줄" · "개 파일" 등 숨은 수의 단위 */
  unit: string;
}

/** 요약 줄 + 본문. 접힘은 COLLAPSED_LINES 줄, 넘치면 `… <n><단위> 더 (<키> 펼치기)` */
export function resultLines(m: Measure, g: Glyphs, width: number, v: ResultView, expanded: boolean, expandKey: string, p: ToolPaint): string[] {
  const out = [m.trunc(` ${p.fg("muted", g.elbow)} ${v.summary}`, width, "…")];
  const inner = Math.max(1, width - 3);
  const all = typeof v.body === "function" ? v.body(inner) : v.body.map((l) => (typeof l === "function" ? l(inner) : l));
  const limit = expanded ? v.max : COLLAPSED_LINES;
  const body = v.keep === "tail" ? all.slice(-limit) : all.slice(0, limit);
  const hidden = all.length - body.length;
  const more = hidden > 0
    ? `   ${p.fg("text", `${g.more} ${v.keep === "tail" ? "앞 " : ""}${hidden}${v.unit} 더${expanded ? "" : ` (${expandKey} 펼치기)`}`)}`
    : "";
  if (more && v.keep === "tail") out.push(m.trunc(more, width, ""));
  for (const line of body) out.push(m.trunc(`   ${line}`, width, "…"));
  if (more && v.keep === "head") out.push(m.trunc(more, width, ""));
  return out;
}
