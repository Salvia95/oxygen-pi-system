// LLM 연결 편집 (설치 TUI · Tweak 공용 로직. 화면 문구는 install.mjs · tweak.mjs 에 있다). docs/tui-spec.md §11
//   화면에서 받은 연결 하나(초안)를 agent/llm.json 에 합치고, 기본 모델 · 작업 수준이 없는 모델이나
//   지원하지 않는 thinking 을 가리키지 않게 맞춘다. 외부 의존성 없음.
import { DEFAULT_LEVELS, LLM_KINDS, THINKING_LEVELS, findConnection, findModel, thinkingChoices } from "../scripts/llm-connections.mjs";

/** 주소 정리: 끝의 / 를 떼고, OpenAI 호환 형식은 경로가 없으면 /v1 을 붙인다 */
export function normalizeBaseUrl(kind, u) {
  let s = String(u ?? "").trim().replace(/\/+$/, "");
  if (LLM_KINDS[kind]?.api !== "openai-completions") return s;
  try { const url = new URL(s); if (url.pathname === "" || url.pathname === "/") s += "/v1"; } catch { /* 검증은 화면에서 */ }
  return s;
}

/** 지원하는 수준 중 want 에 가장 가까운 것 (pi 처럼 낮은 쪽으로) */
export function closestThinking(choices, want) {
  if (choices.includes(want)) return want;
  const at = THINKING_LEVELS.indexOf(want);
  const lower = choices.filter((c) => THINKING_LEVELS.indexOf(c) <= at);
  return lower.at(-1) ?? choices[0] ?? "off";
}

/** 새로 정할 때의 thinking: 종류의 thinkingDefault (지원하지 않으면 가장 가까운 수준) */
export function defaultThinking(root, conn, modelId) {
  return closestThinking(thinkingChoices(root, conn, modelId), LLM_KINDS[conn?.kind]?.thinkingDefault ?? "off");
}

/** 저장할 연결: 종류에 있는 요청 설정 항목만 남긴다 */
export function cleanConnection(conn) {
  const kind = LLM_KINDS[conn.kind];
  const request = {};
  for (const k of kind?.request ?? []) {
    if (k === "retries") request.retries = Number(conn.request?.retries) || 0;
    if (k === "dropParams") request.dropParams = [...(conn.request?.dropParams ?? [])];
  }
  const out = { id: conn.id, kind: conn.kind, name: conn.name || kind?.label || conn.id };
  if (conn.baseUrl) out.baseUrl = conn.baseUrl;
  if (kind?.workspace && conn.workspaceId) out.workspaceId = conn.workspaceId;
  out.maxConcurrent = Number(conn.maxConcurrent) || kind?.maxConcurrent || 1;
  out.request = request;
  out.models = (conn.models ?? []).map((m) => ({ id: m.id, ...(m.family ? { family: m.family } : {}), contextWindow: m.contextWindow, maxOutput: m.maxOutput }));
  return out;
}

/**
 * 연결 초안을 llm 에 합친다 → 새 llm (base 는 바꾸지 않는다)
 *   origId: 편집 전 연결 id (이름을 바꾸면 기본 모델 · 작업 수준이 따라간다) · main: 기본 모델을 새로 정했으면 { model, thinking }
 * 기본 모델이 없으면 이 연결의 첫 모델, 작업 수준이 없으면 기본 세 개를 모두 기본 모델로 만든다.
 */
export function mergeConnection(root, base, draft, { origId = draft.id, main = null } = {}) {
  const llm = structuredClone(base ?? { version: 1, connections: [], levels: [] });
  llm.version = 1;
  llm.levels ??= [];
  const conn = cleanConnection(draft);
  const i = llm.connections.findIndex((c) => c.id === origId);
  if (i >= 0) llm.connections[i] = conn; else llm.connections.push(conn);
  const rename = (p) => (p && p.connection === origId ? { ...p, connection: conn.id } : p);
  llm.main = rename(llm.main);
  llm.levels = llm.levels.map(rename);
  if (main) llm.main = { connection: conn.id, model: main.model, thinking: main.thinking ?? "off" };
  return fixPointers(root, llm);
}

/** 기본 모델 · 작업 수준이 있는 연결 · 모델 · 지원하는 thinking 을 가리키게 맞춘다 */
export function fixPointers(root, src) {
  const llm = structuredClone(src);
  llm.levels ??= [];
  const first = llm.connections.find((c) => c.models?.length);
  const valid = (p) => Boolean(p && findModel(findConnection(llm, p.connection), p.model));
  if (!valid(llm.main)) {
    llm.main = first ? { connection: first.id, model: first.models[0].id, thinking: defaultThinking(root, first, first.models[0].id) } : undefined;
    if (!llm.main) delete llm.main;
  }
  const fit = (p) => {
    if (!valid(p)) {
      if (!llm.main) return p;
      // 그 연결에 다른 모델이 남아 있어도 기본 모델로 되돌린다 (어느 모델이 맞는지 알 수 없으므로)
      p = { ...p, connection: llm.main.connection, model: llm.main.model, thinking: llm.main.thinking };
    }
    const choices = thinkingChoices(root, findConnection(llm, p.connection), p.model);
    return { ...p, thinking: closestThinking(choices, p.thinking ?? "off") };
  };
  if (llm.main) llm.main = fit(llm.main);
  llm.levels = llm.levels.map(fit);
  if (!llm.levels.length && llm.main) {
    llm.levels = DEFAULT_LEVELS.map((l) => ({ ...l, connection: llm.main.connection, model: llm.main.model, thinking: llm.main.thinking }));
  }
  // 파일에서 읽기 쉬운 순서 (docs/tui-spec.md §11 의 형식): version · connections · main · levels
  const { version, connections, main, levels, ...rest } = llm;
  return { version, connections, ...(main ? { main } : {}), levels, ...rest };
}

/** 사용량 제한(분당 토큰)이 이 값 이하인 연결에는 맞춤 설정을 제안한다 */
export const RATE_LIMITED_TPM = 30000;
/** 분당 토큰 한도에 맞춘 설정: 연결의 재시도 · 모델마다 응답 최대 길이 · 연결의 동시 요청 수 */
export function endpointPreset(tpm) {
  return { retries: 4, maxOut: Math.max(512, Math.min(4096, Math.floor(tpm / 8))), concurrency: 1 };
}

// ------------------------------------------------------------------ Anthropic 워크스페이스 (docs/tui-spec.md §11 Anthropic 워크스페이스)
/** 모델 목록 실패가 워크스페이스 화면으로 이어지는지: 종류가 워크스페이스를 쓰고, 미지정(400) · 형식 오류(400) · 없는 워크스페이스(404) */
export function needsWorkspace(kind, e) {
  return Boolean(LLM_KINDS[kind]?.workspace && ["unscoped", "invalid", "not-found"].includes(e?.workspace));
}

/** 워크스페이스 선택 목록의 순서: 기본 워크스페이스 먼저, 나머지는 받은 순서. 같은 ID 는 한 번만 */
export function sortWorkspaces(list) {
  const seen = new Set();
  const uniq = (list ?? []).filter((w) => w?.id && !seen.has(w.id) && seen.add(w.id));
  return [...uniq.filter((w) => w.isDefault), ...uniq.filter((w) => !w.isDefault)];
}
