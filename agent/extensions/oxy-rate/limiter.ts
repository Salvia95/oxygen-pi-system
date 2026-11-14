// 연결별 요청 한도 (docs/rate-limit-spec.md §3): 1분 슬라이딩 윈도우의 요청 수(RPM) · 토큰 수(TPM)로 다음 요청을 얼마나 기다릴지 정한다.
// 순수 함수만 둔다 (파일 · 시간은 store.ts · index.ts).

export const WINDOW_MS = 60_000;

const LIMIT_NAME: Record<WaitReason, string> = { rpm: "RPM Limit", tpm: "TPM Limit", blocked: "Server Limit" };
/** 기다리는 동안의 글 (사용자 2026-11-14: "Pending for n sec: RPM Limit으로 하고 남은시간도 보여주자"): n 은 남은 초 */
export function pendingText(reason: WaitReason, waitMs: number): string {
  return `Pending for ${Math.max(1, Math.ceil(waitMs / 1000))} sec: ${LIMIT_NAME[reason] ?? reason}`;
}

export interface RateEvent { at: number; tokens: number }
export interface Limits { rpm?: number; tpm?: number }
export type WaitReason = "rpm" | "tpm" | "blocked";
export interface WaitPlan { waitMs: number; reason: WaitReason | null; overLimit?: boolean }

const inWindow = (events: RateEvent[], now: number, win: number) => events.filter((e) => e.at > now - win && e.at <= now).sort((a, b) => a.at - b.at);

/** 지금 기준 1분 동안의 요청 수 · 토큰 수 */
export function usage(events: RateEvent[], now: number, win = WINDOW_MS): { rpm: number; tpm: number } {
  const w = inWindow(events, now, win);
  return { rpm: w.length, tpm: w.reduce((s, e) => s + Math.max(0, e.tokens), 0) };
}

/**
 * 다음 요청(어림 토큰 est)을 보내기 전에 기다릴 시간.
 *   blockedUntil: 서버가 429 로 알려 준 시각 (다른 프로세스가 받은 것도 함께 지킨다)
 *   rpm: 윈도우 안 요청이 한도면, 가장 오래된 것 중 하나가 빠질 때까지
 *   tpm: 윈도우 안 토큰 + est 가 한도를 넘으면, 넘지 않을 만큼 오래된 것이 빠질 때까지. est 하나만으로 한도를 넘으면 기다려도 소용없으므로 보낸다 (overLimit)
 */
export function planWait(events: RateEvent[], now: number, limits: Limits, est: number, blockedUntil = 0, win = WINDOW_MS): WaitPlan {
  if (blockedUntil > now) return { waitMs: blockedUntil - now, reason: "blocked" };
  const w = inWindow(events, now, win);
  let wait = 0;
  let reason: WaitReason | null = null;
  const rpm = Number(limits.rpm) || 0;
  if (rpm > 0 && w.length >= rpm) {
    const t = w[w.length - rpm].at + win - now;   // 이 요청이 빠지면 rpm-1 개가 남는다
    if (t > wait) { wait = t; reason = "rpm"; }
  }
  const tpm = Number(limits.tpm) || 0;
  let overLimit = false;
  if (tpm > 0) {
    if (est > tpm) overLimit = true;
    else {
      let used = w.reduce((s, e) => s + Math.max(0, e.tokens), 0);
      let i = 0;
      while (used + est > tpm && i < w.length) { used -= Math.max(0, w[i].tokens); i++; }
      if (i > 0) {
        const t = w[i - 1].at + win - now;
        if (t > wait) { wait = t; reason = "tpm"; }
      }
    }
  }
  return { waitMs: Math.max(0, Math.ceil(wait)), reason: wait > 0 ? reason : null, ...(overLimit ? { overLimit } : {}) };
}

/**
 * 429 응답의 대기 시각: Retry-After (초 또는 HTTP 날짜), 없으면 x-ratelimit-reset-requests · -tokens ("6m0s" · "1.5s" · 초), 그것도 없으면 fallbackMs
 */
export function retryAt(headers: Record<string, string> | undefined, now: number, fallbackMs = 10_000): number {
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) h[k.toLowerCase()] = String(v);
  const ra = h["retry-after"];
  if (ra) {
    const n = Number(ra);
    if (Number.isFinite(n) && n >= 0) return now + n * 1000;
    const d = Date.parse(ra);
    if (Number.isFinite(d)) return Math.max(now, d);
  }
  const resets = [h["x-ratelimit-reset-requests"], h["x-ratelimit-reset-tokens"]].map(parseDuration).filter((x): x is number => x !== null);
  if (resets.length) return now + Math.max(...resets);
  return now + fallbackMs;
}

/** "6m0s" · "1.5s" · "250ms" · "12" (초) → ms */
export function parseDuration(s: string | undefined): number | null {
  if (!s) return null;
  const t = s.trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t) * 1000;
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let ms = 0, hit = false;
  for (const m of t.matchAll(re)) {
    hit = true;
    const n = Number(m[1]);
    ms += m[2] === "h" ? n * 3_600_000 : m[2] === "m" ? n * 60_000 : m[2] === "s" ? n * 1000 : n;
  }
  return hit ? ms : null;
}
