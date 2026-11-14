// oxy-flow compaction 이 남길 최근 대화의 경계 (docs/flow-spec.md §1-6). 순수 함수.
// 2026-11-14 설치본: pi 는 최근 대화를 keepRecentTokens(20K) 이상, 대화 단위로 남겨 compaction 뒤에도 약 72K(128K 창)가 남았고,
// compaction 시작점(약 79K)까지 여유가 9K 뿐이라 42초에 4번 compaction 했다. oxy-flow 요약에는 작업 기록(계획 · 결정 · 최근 요청)이 있으므로
// 최근 대화는 더 적게(기본 8K) 남겨도 이어 갈 수 있다.

/** 남길 최근 대화의 어림 토큰 (OXY_FLOW_COMPACT_KEEP_TOKENS) */
export const KEEP_TOKENS_DEFAULT = 8000;

/** 항목의 어림 토큰: 글자 수 / 3 (한글이 섞이면 / 4 보다 많다) */
export function entryTokens(e: any): number {
  if (!e || (e.type !== "message" && e.type !== "custom_message")) return 0;
  try { return Math.ceil(JSON.stringify(e.message ?? e.content ?? "").length / 3); } catch { return 0; }
}

/** 여기서 잘라도 되는가: 도구 결과 앞에서는 자르지 않는다 (호출과 결과가 떨어지면 모델 요청이 깨진다) */
export function isCutPoint(e: any): boolean {
  if (e?.type === "custom_message") return true;
  if (e?.type !== "message") return false;
  const role = e.message?.role;
  return role === "user" || role === "assistant" || role === "bashExecution";
}

/**
 * pi 가 고른 경계(firstKeptId)보다 뒤에서, 끝에서부터 keepTokens 만큼만 남기는 경계. 더 줄일 수 없으면 firstKeptId 그대로.
 * entries: 지금 가지(branch)의 항목 (시간순)
 */
export function tighterCut(entries: any[], firstKeptId: string, keepTokens = KEEP_TOKENS_DEFAULT): string {
  const k = entries.findIndex((e) => e?.id === firstKeptId);
  if (k < 0) return firstKeptId;
  let sum = 0;
  for (let i = entries.length - 1; i > k; i--) {
    sum += entryTokens(entries[i]);
    if (sum >= keepTokens && isCutPoint(entries[i])) return entries[i].id;
  }
  return firstKeptId;
}
