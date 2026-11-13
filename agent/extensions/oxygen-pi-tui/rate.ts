// vLLM 연결의 요청 속도 표시 (docs/pi-tui-spec.md §6.1). 순수 부분만 둔다.
// 사용자 (2026-11-14): "vllm 연결에 대해서는 rpm(request per minite, tpm(token per minute) 표시 기능(1분 슬라이딩 윈도우를 사용할거야)을 추가해줘
//   위치는 푸터에 컨텍스트 윈도우 토큰 뒤 api 금액 위치야(vllm은 보통 private llm 연결시 사용할거니 api 요금 대신 이걸 표시하는거야)"
//   RPM: 최근 60초 동안 보낸 요청 수 (재시도 포함, before_provider_request 마다 1)
//   TPM: 최근 60초 동안 끝난 응답의 입력 + 출력 토큰 (assistant message_end 의 usage)
// 이 pi 프로세스의 요청만 센다 (subagent 는 다른 프로세스라 들어가지 않는다).

export const RATE_WINDOW_MS = 60_000;

export class RateWindow {
  private reqs: number[] = [];
  private toks: Array<{ at: number; n: number }> = [];
  readonly windowMs: number;
  constructor(windowMs = RATE_WINDOW_MS) { this.windowMs = windowMs; }

  request(at: number): void { this.reqs.push(at); this.prune(at); }
  tokens(at: number, n: number): void { if (n > 0) this.toks.push({ at, n }); this.prune(at); }

  private prune(now: number): void {
    const from = now - this.windowMs;
    while (this.reqs.length && this.reqs[0] <= from) this.reqs.shift();
    while (this.toks.length && this.toks[0].at <= from) this.toks.shift();
  }

  /** 지금 기준 1분 슬라이딩 윈도우 */
  stats(now: number): { rpm: number; tpm: number } {
    this.prune(now);
    return { rpm: this.reqs.length, tpm: this.toks.reduce((s, x) => s + x.n, 0) };
  }

  /** 윈도우 안에 남은 것이 있는가 (값이 줄어드는 동안 화면을 다시 그린다) */
  active(now: number): boolean { this.prune(now); return this.reqs.length > 0 || this.toks.length > 0; }
}

const kfmt = (n: number) => (n < 1000 ? String(n) : n < 100_000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K` : `${Math.round(n / 1000)}K`);

/** 푸터 글: `3 rpm · 12.4K tpm`, 한도가 있으면 `3/20 rpm · 12.4K/100K tpm` (docs/rate-limit-spec.md) */
export function rateLabel(r: { rpm: number; tpm: number; limits?: { rpm?: number; tpm?: number } }, sep = "·"): string {
  const lr = Number(r.limits?.rpm) || 0, lt = Number(r.limits?.tpm) || 0;
  return `${r.rpm}${lr ? `/${lr}` : ""} rpm ${sep} ${kfmt(r.tpm)}${lt ? `/${kfmt(lt)}` : ""} tpm`;
}

/** 한도가 있는 값이 한도에 닿았는가 (푸터를 경고색으로) */
export function rateFull(r: { rpm: number; tpm: number; limits?: { rpm?: number; tpm?: number } }): boolean {
  const lr = Number(r.limits?.rpm) || 0, lt = Number(r.limits?.tpm) || 0;
  return (lr > 0 && r.rpm >= lr) || (lt > 0 && r.tpm >= lt);
}

/** oxy-rate 가 있으면 모든 프로세스를 더한 값 · 한도, 없으면 이 프로세스의 값 */
export function sharedStats(provider: string | undefined): { rpm: number; tpm: number; limits?: { rpm?: number; tpm?: number } } | null {
  try { return (globalThis as any)[Symbol.for("oxy.rate")]?.stats?.(provider) ?? null; } catch { return null; }
}

/** 응답 usage → 입력 + 출력 토큰 (캐시 읽기 · 쓰기도 입력에 든다) */
export function usageTokens(u: any): number {
  if (!u) return 0;
  const n = Number(u.input ?? 0) + Number(u.output ?? 0) + Number(u.cacheRead ?? 0) + Number(u.cacheWrite ?? 0);
  return Number.isFinite(n) && n > 0 ? n : Number(u.totalTokens ?? 0) || 0;
}

/** provider id (oxy-<연결 id>) 가 vLLM 연결인가. llm: agent/llm.json (oxy-llm 이 globalThis 에 둔 것) */
export function isVllmProvider(provider: string | undefined, llm: any): boolean {
  if (!provider || !provider.startsWith("oxy-")) return false;
  const id = provider.slice(4);
  return Boolean(llm?.connections?.some((c: any) => c?.id === id && c?.kind === "vllm"));
}
