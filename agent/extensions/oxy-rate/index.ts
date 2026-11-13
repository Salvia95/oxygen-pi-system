/**
 * oxy-rate: 연결별 요청 한도 대기 (docs/rate-limit-spec.md).
 * 사용자 (2026-11-14): "한도 대기기능 만들자" — 앞선 분석: pi 는 요청 직전 이벤트(before_provider_request)를 기다려 주므로
 * 1분 슬라이딩 윈도우에 여유가 생길 때까지 요청을 붙잡아 둘 수 있다.
 *
 *   설정: agent/llm.json 연결의 request.rpm · request.tpm (없거나 0 이면 제한 없음)
 *   센다: 요청마다 1 (재시도 포함) · 토큰은 보낼 때 어림(지금 컨텍스트) → 응답이 끝나면 실제 입력 + 출력으로
 *   기다린다: 윈도우가 한도면 여유가 생길 때까지 (Esc 로 멈추면 바로 보낸다 · 최대 5분). 기다리는 동안 푸터에 `요청 대기 중 · rpm 한도 · 12초`
 *   429: Retry-After · x-ratelimit-reset-* 시각까지 이 연결의 모든 프로세스가 기다린다 (pi 의 재시도도 그 뒤에 나간다)
 *   공유: agent/rate/<연결>/<pid>.json — 본 대화 · subagent · 다른 oxy 세션이 함께 센다 (store.ts)
 * 끄기: OXY_RATE=off
 */
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { enabled } from "../_lib/common.ts";
import { type Limits, type RateEvent, type WaitReason, planWait, retryAt, usage } from "./limiter.ts";
import { RateStore } from "./store.ts";

/** 한 요청이 기다릴 수 있는 최대 시간 (넘으면 보내고 서버 · pi 재시도에 맡긴다) */
export const MAX_WAIT_MS = 5 * 60_000;
const REASON: Record<WaitReason, string> = { rpm: "rpm 한도", tpm: "tpm 한도", blocked: "서버 요청 제한" };

export function waitStatus(reason: WaitReason, waitMs: number): string {
  return `요청 대기 중 · ${REASON[reason]} · ${Math.max(1, Math.ceil(waitMs / 1000))}초`;
}

/** 응답 usage → 입력 + 출력 토큰 (캐시 포함) */
const usageTokens = (u: any): number => {
  const n = Number(u?.input ?? 0) + Number(u?.output ?? 0) + Number(u?.cacheRead ?? 0) + Number(u?.cacheWrite ?? 0);
  return Number.isFinite(n) && n > 0 ? n : Number(u?.totalTokens ?? 0) || 0;
};

/** 보낼 요청의 어림 토큰: 지금 컨텍스트 토큰 (모르면 요청 본문 길이 / 4) */
function estimate(payload: unknown, ctx: any): number {
  try { const t = ctx.getContextUsage?.()?.tokens; if (Number(t) > 0) return Number(t); } catch { /* 모름 */ }
  try { return Math.ceil(JSON.stringify(payload ?? "").length / 4); } catch { return 0; }
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((r) => {
  const t = setTimeout(r, ms);
  signal?.addEventListener?.("abort", () => { clearTimeout(t); r(); }, { once: true });
});

export default function (pi: ExtensionAPI) {
  if (!enabled("RATE")) return;
  const agentDir = process.env.PI_CODING_AGENT_DIR || getAgentDir();
  const llm = () => (globalThis as any)[Symbol.for("oxy.llm")]?.llm;
  const connOf = (provider: string | undefined): any => (provider?.startsWith("oxy-") ? llm()?.connections?.find((c: any) => c?.id === provider.slice(4)) ?? null : null);
  const stores = new Map<string, RateStore>();
  const store = (id: string) => { let s = stores.get(id); if (!s) { s = new RateStore(agentDir, id); stores.set(id, s); } return s; };
  const pending: Array<{ connId: string; ev: RateEvent }> = [];

  // 푸터(oxygen-pi-tui)가 읽는다: 모든 프로세스를 더한 1분 값과 한도. 푸터는 자주 그려지므로 1초 동안은 앞서 읽은 값을 쓴다
  const cache = new Map<string, { at: number; v: { rpm: number; tpm: number; limits: Limits } }>();
  (globalThis as any)[Symbol.for("oxy.rate")] = {
    stats(provider: string | undefined): { rpm: number; tpm: number; limits: Limits } | null {
      const conn = connOf(provider);
      if (!conn) return null;
      const now = Date.now();
      const hit = cache.get(conn.id);
      if (hit && now - hit.at < 1000) return hit.v;
      const v = { ...usage(store(conn.id).readAll(now).events, now), limits: { rpm: Number(conn.request?.rpm) || 0, tpm: Number(conn.request?.tpm) || 0 } };
      cache.set(conn.id, { at: now, v });
      return v;
    },
  };

  pi.on("before_provider_request", async (event: any, ctx: any) => {
    const conn = connOf(ctx.model?.provider);
    if (!conn) return undefined;
    const st = store(conn.id);
    const limits: Limits = { rpm: Number(conn.request?.rpm) || 0, tpm: Number(conn.request?.tpm) || 0 };
    const est = estimate(event.payload, ctx);
    if (limits.rpm || limits.tpm) {
      const t0 = Date.now();
      let shown = false;
      for (;;) {
        const now = Date.now();
        const all = st.readAll(now);
        const plan = planWait(all.events, now, limits, est, all.blockedUntil);
        if (!plan.waitMs || ctx.signal?.aborted || now - t0 >= MAX_WAIT_MS) break;
        if (ctx.hasUI) { ctx.ui.setStatus("oxy-rate", waitStatus(plan.reason!, plan.waitMs)); shown = true; }
        await sleep(Math.min(plan.waitMs, 1000), ctx.signal);
      }
      if (shown && ctx.hasUI) ctx.ui.setStatus("oxy-rate", undefined);
    }
    pending.push({ connId: conn.id, ev: st.add(Date.now(), est) });
    return undefined;
  });

  // 응답이 끝나면 어림 토큰을 실제 값으로 (같은 연결의 가장 오래된 대기 중 요청)
  pi.on("message_end", async (event: any) => {
    const m = event?.message;
    if (m?.role !== "assistant") return;
    const conn = connOf(m.provider);
    if (!conn) return;
    const i = pending.findIndex((p) => p.connId === conn.id);
    if (i < 0) return;
    const [p] = pending.splice(i, 1);
    store(conn.id).settle(p.ev, usageTokens(m.usage), Date.now());
  });

  // 429: 서버가 알려 준 시각까지 이 연결의 요청을 멈춘다 (pi 의 재시도 · 다른 프로세스도)
  pi.on("after_provider_response", async (event: any, ctx: any) => {
    if (event?.status !== 429) return;
    const conn = connOf(ctx.model?.provider);
    if (!conn) return;
    const now = Date.now();
    store(conn.id).block(retryAt(event.headers, now), now);
  });
}
