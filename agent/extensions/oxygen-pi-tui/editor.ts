// 입력창 테두리 (docs/pi-tui-spec.md §5) 순수 함수. 색 · 폭 계산은 받는다.
//   ╭─ 입력 ───────────────────────── vllm · qwen3-30b · low ─╮
//    › 다음 할 일을 정리해줘
//   ╰────────────────────────────────────── ctx 23% · 29K/128K ─╯
import type { Glyphs } from "./glyphs.ts";
import { type Measure, type WidthClass } from "./layout.ts";

export type Paint = (s: string) => string;

/**
 * 테두리 한 줄: <왼쪽 모서리>─ <왼쪽 글> ───…─── <오른쪽 글> ─<오른쪽 모서리>. 정확히 width 칸.
 * 넘치면 오른쪽 글부터 줄이고(없앨 때까지), 그다음 왼쪽 글을 자른다. 글이 없으면 그 자리는 선으로 채운다.
 */
export function borderLine(m: Measure, g: Glyphs, width: number, corner: [string, string], left: string, right: string, paint: Paint): string {
  if (width <= 0) return "";
  if (width < 4) return paint(g.hline.repeat(width));
  const fixed = 4;                                   // 모서리 2 + 양끝 ─ 2
  const slot = (s: string) => (s ? m.width(s) + 2 : 0); // 글 양옆 빈칸
  let l = m.width(left) > 0 ? left : "", r = m.width(right) > 0 ? right : "";   // 색 코드만 있는 글은 빈 글
  if (fixed + slot(l) + slot(r) + 1 > width && r) {
    const room = width - fixed - slot(l) - 1 - 2;
    r = room >= 3 ? m.trunc(r, room, "…") : "";
  }
  if (fixed + slot(l) + slot(r) > width && l) {
    const room = width - fixed - slot(r) - 2;
    l = room >= 1 ? m.trunc(l, room, "…") : "";
  }
  const fill = Math.max(0, width - fixed - slot(l) - slot(r));
  return paint(corner[0] + g.hline) + (l ? ` ${l} ` : "") + paint(g.hline.repeat(fill)) + (r ? ` ${r} ` : "") + paint(g.hline + corner[1]);
}

export interface ModelInfo { provider?: string; id?: string; thinking?: string; reasoning?: boolean }

/** oxy-llm 연결 이름: provider `oxy-<이름>` → `<이름>` (그 밖은 그대로) */
export function connectionName(provider: string | undefined): string {
  return (provider ?? "").replace(/^oxy-/, "");
}

/** 윗줄 오른쪽: `<연결> · <모델> · <생각 수준>` (좁음: 연결 이름 뺌). 생각을 못 하는 모델이면 수준을 뺀다 */
export function modelLabel(info: ModelInfo, wc: WidthClass, sep = "·"): string {
  const parts = [wc === "narrow" ? "" : connectionName(info.provider), info.id ?? "모델 없음", info.reasoning === false ? "" : (info.thinking ?? "")];
  return parts.filter(Boolean).join(` ${sep} `);
}

export function formatTokens(n: number): string {
  return n < 1000 ? String(Math.round(n)) : `${Math.round(n / 1000)}K`;
}

export interface UsageInfo { tokens?: number | null; contextWindow?: number | null; percent?: number | null; cost?: number; rate?: string }
export type Level = "normal" | "warning" | "error";

/** 컨텍스트 색 기준 (D6): 50% 이상 warning (oxy-flow 가 다음 메시지에서 새 세션으로 넘어감) · 85% 이상 error */
export function usageLevel(percent: number | null | undefined): Level {
  if (percent == null) return "normal";
  return percent >= 85 ? "error" : percent >= 50 ? "warning" : "normal";
}

/** 아랫줄 오른쪽: `ctx 23% · 29K/128K · $0.012` (좁음: `ctx 23%`). 퍼센트를 모르면 `ctx ?`. vLLM 연결이면 금액 대신 `3 rpm · 12K tpm` (§6.1) */
export function usageLabel(u: UsageInfo, wc: WidthClass, sep = "·"): string {
  if (u.percent == null) return "ctx ?";
  const pct = `ctx ${Math.round(u.percent)}%`;
  if (wc === "narrow") return pct;
  const parts = [pct];
  if (u.tokens != null && u.contextWindow) parts.push(`${formatTokens(u.tokens)}/${formatTokens(u.contextWindow)}`);
  if (u.rate) parts.push(u.rate);
  else if (u.cost && u.cost > 0) parts.push(`$${u.cost.toFixed(3)}`);
  return parts.join(` ${sep} `);
}

/** 윗줄 왼쪽: 쉬는 중 `입력`, 작업 중 `<스피너> 작업 중 <n>초`. 위로 숨은 줄이 있으면 ` · ▲ <n>줄 더` */
export function topLeftLabel(working: { frame: string; seconds: number } | null, hiddenAbove: number): string {
  const base = working ? `${working.frame} 작업 중 ${working.seconds}초` : "입력";
  return hiddenAbove > 0 ? `${base} · ▲ ${hiddenAbove}줄 더` : base;
}

/** 아랫줄 왼쪽: 아래로 숨은 줄이 있으면 `▼ <n>줄 더` */
export function bottomLeftLabel(hiddenBelow: number): string {
  return hiddenBelow > 0 ? `▼ ${hiddenBelow}줄 더` : "";
}

/** 첫 내용 줄의 왼쪽 여백(3칸)을 ` › ` 로. 여백이 공백 3칸이 아니면 그대로 */
export function withPrompt(line: string, prompt: string): string {
  return line.startsWith("   ") ? ` ${prompt} ${line.slice(3)}` : line;
}
