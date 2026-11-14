// LLM 연결 (docs/tui-spec.md §11): 연결 종류 표 · agent/llm.json 형식 · pi provider 설정 · settings.json 기본값 · 작업 수준.
// 설치 TUI · Tweak · 설정 생성(render-config) · pi extension(oxy-llm) · oxy-jobs · 상태 점검이 같은 코드를 쓴다. 외부 의존성 없음.
//   agent/llm.json     연결 목록 · 기본 모델 · 작업 수준 (비밀값 없음)
//   agent/secrets.json API 키 (DPAPI, 키 이름 llm/<연결 id>, installer/secrets.mjs)
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ------------------------------------------------------------------ 모델 계열 (OpenAI 호환 종류)
/**
 * OpenAI 표준이 아닌 vLLM 확장 파라미터. vLLM 은 받지만, 앞단 게이트웨이(LiteLLM 등)가 거부하는 경우가 있다.
 * 설치 TUI·Tweak 의 vLLM 단계가 하나씩 테스트해서, 거부된 것만 연결의 request.dropParams 에 적는다.
 */
export const VLLM_EXTRA_PARAMS = ["top_k", "repetition_penalty", "min_p", "chat_template_kwargs", "reasoning_effort"];

/**
 * 모델 계열 프리셋: thinking(추론) 제어 방식과 권장 샘플링 값.
 *   qwen-coder    : Qwen Coder 계열, thinking 없음
 *   qwen-thinking : Qwen3 하이브리드 thinking — chat_template_kwargs.enable_thinking 으로 켜고 끔 (vLLM --reasoning-parser qwen3)
 *   gpt-oss       : OpenAI gpt-oss — reasoning_effort (끌 수 없으므로 off 는 low 로 보냄)
 *   generic       : 그 밖의 OpenAI 호환 모델 — thinking 제어 없음, temperature 만
 * thinking: 이 계열에서 선택할 수 있는 pi thinking 수준 (TUI 선택지 · 작업 수준 검증)
 */
export const MODEL_FAMILIES = {
  "qwen-coder": { label: "Qwen Coder (thinking 없음)", thinking: ["off"], preset: {
    reasoning: false, samplingParams: { temperature: 0.7, top_p: 0.8, top_k: 20, repetition_penalty: 1.05 } } },
  "qwen-thinking": { label: "Qwen3 하이브리드 thinking (chat_template_kwargs)", thinking: ["off", "high"], preset: {
    reasoning: true, compat: { thinkingFormat: "qwen-chat-template" },
    samplingParams: { temperature: 0.6, top_p: 0.95, top_k: 20 },
    samplingParamsByThinkingLevel: { off: { temperature: 0.7, top_p: 0.8 } } } },
  "gpt-oss": { label: "OpenAI gpt-oss (reasoning_effort)", thinking: ["low", "medium", "high"], preset: {
    reasoning: true, compat: { supportsReasoningEffort: true },
    thinkingLevelMap: { off: "low", minimal: "low", low: "low", medium: "medium", high: "high" },
    samplingParams: { temperature: 1.0, top_p: 1.0 } } },
  generic: { label: "기타 OpenAI 호환 모델 (thinking 제어 없음)", thinking: ["off"], preset: {
    reasoning: false, samplingParams: { temperature: 0.7 } } },
};

/** 모델 id 로 계열 추정 (설치 TUI 의 기본 선택값, 계열을 적지 않은 기존 설치의 기본값) */
export function detectFamily(id) {
  const s = String(id ?? "").toLowerCase();
  if (/gpt-oss/.test(s)) return "gpt-oss";
  if (/qwen/.test(s)) return /coder/.test(s) ? "qwen-coder" : "qwen-thinking";
  return "generic";
}

/**
 * 계열 프리셋을 적용한 pi 모델 항목. dropParams 에 든 파라미터는 요청에서 뺀다:
 *   top_k · repetition_penalty · min_p → samplingParams 에서 삭제
 *   chat_template_kwargs / reasoning_effort → 그 방식으로 thinking 을 제어하는 모델은 thinking 제어를 끈다
 *     (reasoning:false, thinking 끈 상태의 샘플링 사용)
 */
export function familyModel(m, dropParams = []) {
  const family = MODEL_FAMILIES[m.family] ? m.family : detectFamily(m.id);
  const out = {
    id: m.id, name: `${m.id} (${family})`, input: ["text"], contextWindow: m.contextWindow, maxTokens: m.maxOutput,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ...structuredClone(MODEL_FAMILIES[family].preset),
  };
  const drop = dropParams.filter((k) => VLLM_EXTRA_PARAMS.includes(k));
  for (const k of drop) {
    delete out.samplingParams?.[k];
    for (const lv of Object.values(out.samplingParamsByThinkingLevel ?? {})) delete lv[k];
  }
  const thinkingParam = out.compat?.thinkingFormat === "qwen-chat-template" ? "chat_template_kwargs"
    : out.compat?.supportsReasoningEffort ? "reasoning_effort" : null;
  if (thinkingParam && drop.includes(thinkingParam)) {
    delete out.compat.thinkingFormat;
    delete out.compat.supportsReasoningEffort;
    if (!Object.keys(out.compat).length) delete out.compat;
    out.reasoning = false;
    delete out.thinkingLevelMap;
    if (out.samplingParamsByThinkingLevel?.off) out.samplingParams = { ...out.samplingParams, ...out.samplingParamsByThinkingLevel.off };
    delete out.samplingParamsByThinkingLevel;
    out.name += " · thinking 제어 없음";
  }
  return out;
}

// ------------------------------------------------------------------ 연결 종류
const OPENAI_COMPAT = { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, supportsUsageInStreaming: true, maxTokensField: "max_tokens" };

/**
 * 연결 종류 표 (화면에 보이는 순서). 종류를 더할 때: 이 표 한 행 (+ listModels · check 형식이 다르면 그 함수).
 *   catalog   : "families" (계열 프리셋으로 모델 항목을 만듦) · "pi:<파일>" (pi 내장 카탈로그 vendor/pi/.../providers/data/<파일>.json)
 *   listModels: 모델 목록 형식 "openai" (GET <주소>/models) · "anthropic" (GET <주소>/v1/models, x-api-key)
 *   keyRequired: false 면 키 없이도 연결 (pi 에는 noKey 값을 보낸다)
 *   workspace : 연결의 workspaceId 를 anthropic-workspace-id 헤더로 보내는지 (조직 API 키, docs/tui-spec.md §11 Anthropic 워크스페이스)
 *   urlExample · contextNote: 설치 TUI · Tweak 의 서버 주소 · 컨텍스트 길이 화면 문구 (기본 주소가 있는 종류는 urlExample 이 없다)
 */
export const LLM_KINDS = {
  vllm: {
    label: "사내 vLLM", hint: "사내 LLM 서버 (OpenAI 호환 API)",
    detail: ["vLLM 같은 OpenAI 호환 서버에 연결합니다.", "모델 계열에 맞는 샘플링 값과 thinking 제어 방식을 사용합니다."],
    api: "openai-completions", catalog: "families", families: Object.keys(MODEL_FAMILIES), baseUrl: null, listModels: "openai",
    probe: ["top_k", "repetition_penalty", "min_p", "chat_template_kwargs"], request: ["retries", "dropParams", "rpm", "tpm"],
    rateLimitHeader: null, thinkingDefault: "off", maxConcurrent: 2, keyRequired: false, noKey: "EMPTY", workspace: false,
    provider: { authHeader: true, compat: OPENAI_COMPAT },
    hints: { toolCall: "vLLM의 --enable-auto-tool-choice, --tool-call-parser 설정을 확인하세요", models: "vLLM의 --served-model-name을 확인하세요" },
    urlExample: "http://vllm.example.internal:8000/v1", contextNote: "vLLM의 --max-model-len 값과 맞추세요.",
  },
  openai: {
    label: "OpenAI 호환 서비스", hint: "외부망 테스트용",
    detail: ["Groq 같은 외부 OpenAI 호환 서비스에 연결합니다.", "vLLM 확장 파라미터는 보내지 않습니다."],
    api: "openai-completions", catalog: "families", families: ["generic", "gpt-oss"], baseUrl: null, listModels: "openai",
    probe: [], request: ["retries", "rpm", "tpm"], rateLimitHeader: "x-ratelimit-limit-tokens", thinkingDefault: "off", maxConcurrent: 1,
    keyRequired: true, workspace: false, provider: { authHeader: true, compat: OPENAI_COMPAT },
    hints: { toolCall: "서비스가 이 모델의 tool calling을 지원하는지 확인하세요", models: "서비스의 모델 이름을 확인하세요" },
    urlExample: "https://api.groq.com/openai/v1", contextNote: "사내 vLLM과 같은 조건으로 테스트하려면 사내 컨텍스트 길이를 입력하세요.",
  },
  anthropic: {
    label: "Anthropic Claude", hint: "외부망 테스트용",
    detail: ["Anthropic API로 Claude 모델에 연결합니다.", "thinking 수준은 effort로 보냅니다."],
    api: "anthropic-messages", catalog: "pi:anthropic", families: [], baseUrl: "https://api.anthropic.com", listModels: "anthropic",
    probe: [], request: ["retries", "rpm", "tpm"], rateLimitHeader: "anthropic-ratelimit-input-tokens-limit", thinkingDefault: "low", maxConcurrent: 2,
    keyRequired: true, workspace: true, provider: {},
    hints: { toolCall: "API 키의 권한과 모델 이름을 확인하세요", models: "Anthropic 콘솔에서 이 키로 쓸 수 있는 모델을 확인하세요" },
    contextNote: "사내 vLLM과 같은 조건으로 테스트하려면 사내 컨텍스트 길이를 입력하세요.",
  },
};

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export const LLM_FILE = "llm.json";
export const ID_RE = /^[a-z][a-z0-9_-]{0,30}$/;
export const secretKey = (id) => `llm/${id}`;
export const providerId = (id) => `oxy-${id}`;

/** 작업 수준 기본값 (설치 때 모두 기본 모델로 만든다). use 는 본 모델이 수준을 정할 때 읽는 설명 */
export const DEFAULT_LEVELS = [
  { id: "light", label: "가벼운 작업", use: "file search, reading, short reports" },
  { id: "normal", label: "보통 작업", use: "defined code changes, test runs" },
  { id: "deep", label: "깊은 작업", use: "reviews, design decisions, hard bugs" },
];

// ------------------------------------------------------------------ llm.json
export function loadLlm(agentDir) {
  try {
    const j = JSON.parse(readFileSync(join(agentDir, LLM_FILE), "utf8"));
    return j && j.version === 1 && Array.isArray(j.connections) ? j : null;
  } catch { return null; }
}

export function saveLlm(agentDir, llm) {
  const file = join(agentDir, LLM_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(llm, null, 2) + "\n");
  renameSync(tmp, file);
}

export const findConnection = (llm, id) => llm?.connections.find((c) => c.id === id);
export const findModel = (conn, id) => conn?.models?.find((m) => m.id === id);

// ------------------------------------------------------------------ pi 내장 카탈로그
const catalogCache = new Map();
/** pi 내장 카탈로그의 모델 목록 (root = 하네스 루트). 파일이 없으면 [] */
export function catalogModels(root, catalog) {
  const name = String(catalog ?? "").replace(/^pi:/, "");
  if (!name || !/^[a-z0-9-]+$/.test(name)) return [];
  const file = join(root, "vendor", "pi", "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "data", `${name}.json`);
  if (catalogCache.has(file)) return catalogCache.get(file);
  const all = [];
  try {
    const walk = (o) => {
      if (Array.isArray(o)) o.forEach(walk);
      else if (o && typeof o === "object") { if (typeof o.id === "string" && typeof o.api === "string") all.push(o); else Object.values(o).forEach(walk); }
    };
    walk(JSON.parse(readFileSync(file, "utf8")));
  } catch { /* 없음 */ }
  catalogCache.set(file, all);
  return all;
}

/** 모델이 지원하는 thinking 수준 (pi 수준 이름). TUI 선택지와 작업 수준 검증에 쓴다 */
export function thinkingChoices(root, conn, modelId) {
  const kind = LLM_KINDS[conn?.kind];
  if (!kind) return ["off"];
  if (kind.catalog === "families") {
    const m = findModel(conn, modelId) ?? { id: modelId };
    const fam = MODEL_FAMILIES[m.family] ? m.family : detectFamily(modelId);
    const built = familyModel({ ...m, contextWindow: 0, maxOutput: 0 }, conn.request?.dropParams ?? []);
    return built.reasoning ? MODEL_FAMILIES[fam].thinking : ["off"];
  }
  const base = catalogModels(root, kind.catalog).find((x) => x.id === modelId);
  if (!base?.reasoning) return ["off"];
  const map = base.thinkingLevelMap ?? {};
  return THINKING_LEVELS.filter((lv) => lv === "off" || (lv in map ? map[lv] !== null : ["low", "medium", "high"].includes(lv)));
}

// ------------------------------------------------------------------ pi provider 설정 (extension 이 registerProvider 로 등록)
/** pi 의 apiKey 치환 규칙: $NAME 은 환경변수, 앞의 ! 는 명령 → 글자 그대로 넘기려면 $$ · $! 로 바꾼다 */
export const escapeKey = (k) => String(k).replace(/\$/g, "$$$$").replace(/^!/, "$$!");

/**
 * 연결 하나의 pi provider 설정. apiKey: 복호화한 키 (없으면 종류의 noKey).
 * → { config, missing: [카탈로그에 없어 뺀 모델 id] }
 */
export function providerConfig(root, conn, apiKey) {
  const kind = LLM_KINDS[conn.kind];
  if (!kind) throw new Error(`알 수 없는 연결 종류: ${conn.kind}`);
  const key = apiKey || kind.noKey;
  if (!key) throw new Error(`${conn.id}: API 키가 없습니다`);
  const missing = [];
  let models;
  if (kind.catalog === "families") {
    models = (conn.models ?? []).map((m) => familyModel(m, conn.request?.dropParams ?? []));
  } else {
    const cat = catalogModels(root, kind.catalog);
    models = [];
    for (const m of conn.models ?? []) {
      const base = cat.find((x) => x.id === m.id);
      if (!base) { missing.push(m.id); continue; }
      const { provider: _p, baseUrl: _b, ...meta } = base;
      models.push({ ...structuredClone(meta), contextWindow: m.contextWindow, maxTokens: m.maxOutput });
    }
  }
  // pi.registerProvider 는 provider 단위 compat 를 모델에 적용하지 않는다 (2026-11-12 실측: max_completion_tokens · store 가 나감).
  // 그래서 종류의 compat 를 모델마다 합친다 (모델 계열의 값이 우선)
  const { compat: kindCompat, ...providerRest } = structuredClone(kind.provider);
  if (kindCompat) models = models.map((m) => ({ ...m, compat: { ...kindCompat, ...m.compat } }));
  const config = {
    name: conn.name || conn.id, baseUrl: conn.baseUrl || kind.baseUrl, api: kind.api, apiKey: escapeKey(key),
    ...providerRest, ...(Object.keys(workspaceHeaders(conn)).length ? { headers: workspaceHeaders(conn) } : {}), models,
  };
  return { config, missing };
}

// ------------------------------------------------------------------ Anthropic 워크스페이스 (워크스페이스가 지정되지 않은 조직 API 키)
export const WORKSPACE_HEADER = "anthropic-workspace-id";
export const WORKSPACE_RE = /^wrkspc_[A-Za-z0-9]+$/;
/** 연결의 워크스페이스 헤더 (종류가 쓰고 값이 있을 때만) */
export function workspaceHeaders(conn) {
  return LLM_KINDS[conn?.kind]?.workspace && conn.workspaceId ? { [WORKSPACE_HEADER]: conn.workspaceId } : {};
}
/**
 * 실패한 요청이 워크스페이스 문제인지 → "unscoped" (키에 워크스페이스가 없어 헤더 필요) · "invalid" (ID 형식) · "not-found" · null
 * 문구는 공식 문서의 오류 메시지 (2026-11-12 확인)
 */
export function workspaceProblem(status, text) {
  const t = String(text ?? "");
  if (status === 400 && /not scoped to a workspace/i.test(t)) return "unscoped";
  if (status === 400 && /anthropic-workspace-id header must be a valid workspace id/i.test(t)) return "invalid";
  if (status === 404 && /Workspace .* not found/i.test(t)) return "not-found";
  return null;
}

// ------------------------------------------------------------------ 서버 요청 (모델 목록 · 상태 점검). listModels 형식마다
const trimSlash = (u) => String(u ?? "").replace(/\/+$/, "");
const REQUESTS = {
  openai: {
    headers: (key) => ({ Authorization: `Bearer ${key || "EMPTY"}`, "Content-Type": "application/json" }),
    modelsUrl: (base) => `${base}/models`,
    /** → [{ id, maxInput? }] */
    parseModels: (j) => (j?.data ?? []).map((m) => ({ id: m.id, ...(m.max_model_len ? { maxInput: m.max_model_len } : {}) })),
    toolUrl: (base) => `${base}/chat/completions`,
    toolBody: (model, extra = {}) => ({ model, max_tokens: 64, tool_choice: "auto", messages: [{ role: "user", content: "Call the ping tool." }],
      tools: [{ type: "function", function: { name: "ping", description: "health check", parameters: { type: "object", properties: {} } } }], ...extra }),
    toolName: (j) => j?.choices?.[0]?.message?.tool_calls?.[0]?.function?.name,
    plainBody: (model, extra = {}) => ({ model, max_tokens: 1, messages: [{ role: "user", content: "hi" }], ...extra }),
  },
  anthropic: {
    headers: (key, conn) => ({ "x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json", ...workspaceHeaders(conn) }),
    modelsUrl: (base) => `${base}/v1/models`,
    parseModels: (j) => (j?.data ?? []).map((m) => ({ id: m.id, ...(m.max_input_tokens ? { maxInput: m.max_input_tokens } : {}), ...(m.max_tokens ? { maxOutput: m.max_tokens } : {}) })),
    toolUrl: (base) => `${base}/v1/messages`,
    // 상태 점검은 짧게: thinking 을 끄고(Haiku 5.5 는 effort high 이하에서 허용) 출력 256 토큰
    toolBody: (model) => ({ model, max_tokens: 256, thinking: { type: "disabled" }, tool_choice: { type: "auto" },
      messages: [{ role: "user", content: "Call the ping tool." }], tools: [{ name: "ping", description: "health check", input_schema: { type: "object", properties: {} } }] }),
    toolName: (j) => j?.content?.find((b) => b?.type === "tool_use")?.name,
    plainBody: null,
  },
};

/** 연결의 모델 목록 (설치 TUI · Tweak · 상태 점검). → { models: [{id, maxInput?, maxOutput?}], rateLimit: 분당 토큰 한도 | null } */
export async function listModels(conn, key, { timeoutMs = 10000 } = {}) {
  const kind = LLM_KINDS[conn.kind];
  const R = REQUESTS[kind.listModels];
  const base = trimSlash(conn.baseUrl || kind.baseUrl);
  const r = await fetch(R.modelsUrl(base), { headers: R.headers(key, conn), signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) {
    const text = await r.text();
    throw Object.assign(new Error(`HTTP ${r.status} ${text.slice(0, 200)}`), { status: r.status, workspace: workspaceProblem(r.status, text) });
  }
  const limit = kind.rateLimitHeader ? Number(r.headers.get(kind.rateLimitHeader)) || null : null;
  return { models: R.parseModels(await r.json()), rateLimit: limit };
}

/** 짧은 요청 하나로 tool call 이 구조화되어 오는지 → { ok, detail } */
export async function checkToolCall(conn, key, model, { timeoutMs = 60000 } = {}) {
  const kind = LLM_KINDS[conn.kind];
  const R = REQUESTS[kind.listModels];
  const base = trimSlash(conn.baseUrl || kind.baseUrl);
  const r = await fetch(R.toolUrl(base), { method: "POST", headers: R.headers(key, conn), body: JSON.stringify(R.toolBody(model)), signal: AbortSignal.timeout(timeoutMs) });
  const text = await r.text();
  if (!r.ok) return { ok: false, detail: `HTTP ${r.status} ${text.slice(0, 200)}`, workspace: workspaceProblem(r.status, text) };
  let j = null;
  try { j = JSON.parse(text); } catch { /* 형식 오류 */ }
  return R.toolName(j) === "ping" ? { ok: true, detail: "" } : { ok: false, detail: text.slice(0, 200) };
}

/**
 * 이 키로 볼 수 있는 워크스페이스 (워크스페이스가 지정되지 않은 개인 · 서비스 계정 키는 Admin API 목록을 부를 수 있다. 권한에 따라 거부될 수 있음)
 * → [{ id, name, isDefault }] (보관된 것 제외). 실패하면 throw
 */
export async function listWorkspaces(conn, key, { timeoutMs = 10000 } = {}) {
  const kind = LLM_KINDS[conn.kind];
  if (!kind?.workspace) return [];
  const base = trimSlash(conn.baseUrl || kind.baseUrl);
  const out = [];
  let after = "";
  for (let page = 0; page < 10; page++) {
    const r = await fetch(`${base}/v1/organizations/workspaces?include_default=true&limit=100${after ? `&after_id=${encodeURIComponent(after)}` : ""}`,
      { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" }, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`), { status: r.status });
    const j = await r.json();
    for (const w of j?.data ?? []) if (w?.id && !w.archived_at) out.push({ id: w.id, name: w.name ?? w.id, isDefault: w.name === "Default" });
    if (!j?.has_more || !j?.last_id) break;
    after = j.last_id;
  }
  return out;
}

/** pi 가 실제로 붙여 보내는 samplingParams 를 서버가 받는지 (probe 가 있는 종류만) → { ok, status, detail, params } | null */
export async function checkSampling(root, conn, key, model, { timeoutMs = 60000 } = {}) {
  const kind = LLM_KINDS[conn.kind];
  const R = REQUESTS[kind.listModels];
  if (!kind.probe.length || !R.plainBody) return null;
  const m = providerConfig(root, conn, key).config.models.find((x) => x.id === model);
  const params = m?.samplingParams ?? {};
  const r = await fetch(R.toolUrl(trimSlash(conn.baseUrl || kind.baseUrl)), { method: "POST", headers: R.headers(key, conn),
    body: JSON.stringify(R.plainBody(model, params)), signal: AbortSignal.timeout(timeoutMs) });
  return { ok: r.ok, status: r.status, detail: r.ok ? "" : (await r.text()).slice(0, 200), params };
}

// ------------------------------------------------------------------ settings.json · 작업 수준
/** settings.json 에 넣을 값 (기본 모델 · 모든 연결의 모델 · 재시도) */
export function settingsFromLlm(llm) {
  const out = { enabledModels: llm.connections.map((c) => `${providerId(c.id)}/**`) };
  if (llm.main) {
    out.defaultProvider = providerId(llm.main.connection);
    out.defaultModel = llm.main.model;
    out.defaultThinkingLevel = llm.main.thinking || "off";
  }
  const retries = Math.max(0, ...llm.connections.map((c) => Number(c.request?.retries) || 0));
  if (retries > 0) out.retries = retries;
  return out;
}

/** 작업 수준 → 자식 pi 의 대상. 없는 수준 · 연결이면 null */
export function resolveLevel(llm, levelId) {
  const lv = llm?.levels?.find((l) => l.id === levelId);
  if (!lv) return null;
  const conn = findConnection(llm, lv.connection);
  if (!conn || !findModel(conn, lv.model)) return null;
  return { level: lv.id, connection: conn.id, provider: providerId(conn.id), id: lv.model, thinking: lv.thinking || "off" };
}

/**
 * 작업 수준 → subagent 의 대상. 수준이 기본 모델(llm.main)과 같으면 "기본 모델" 이라는 뜻으로 보고 지금 대화의 모델(current)을 따른다
 * (docs/tui-spec.md §11, 2026-11-14: pi 에서 기본 모델을 Haiku 로 바꿔도 수준은 설치 때의 vllm/qwen 그대로라 subagent 가 옛 연결로 가서
 * 413 · 429 로 실패했다). 따로 다른 모델을 지정한 수준은 그대로. current: { provider: "oxy-<연결>", id }
 */
export function resolveLevelFor(llm, levelId, current) {
  const r = resolveLevel(llm, levelId);
  if (!r) return null;
  const m = llm?.main;
  if (!m || r.connection !== m.connection || r.id !== m.model) return r;
  if (!current?.provider || !current?.id || !String(current.provider).startsWith("oxy-")) return r;
  if (current.provider === r.provider && current.id === r.id) return r;
  const conn = findConnection(llm, String(current.provider).slice(4));
  if (!conn || !findModel(conn, current.id)) return r;
  return { ...r, connection: conn.id, provider: current.provider, id: current.id, followsMain: true };
}

/** llm.json 검사 → 문제 목록 (빈 배열이면 정상). root 가 있으면 thinking 지원 여부까지 본다 */
export function validateLlm(llm, root) {
  const errs = [];
  const ids = new Set();
  for (const c of llm.connections) {
    if (!ID_RE.test(c.id ?? "")) errs.push(`연결 이름이 규칙에 맞지 않음: ${c.id}`);
    if (ids.has(c.id)) errs.push(`연결 이름이 겹침: ${c.id}`);
    ids.add(c.id);
    const kind = LLM_KINDS[c.kind];
    if (!kind) { errs.push(`${c.id}: 알 수 없는 연결 종류 ${c.kind}`); continue; }
    if (!c.baseUrl && !kind.baseUrl) errs.push(`${c.id}: 서버 주소가 없음`);
    if (c.workspaceId !== undefined && !kind.workspace) errs.push(`${c.id}: 이 연결 종류는 워크스페이스 ID를 쓰지 않음`);
    // 요청 한도 (docs/rate-limit-spec.md): 0 이상의 정수, 0 · 없음 = 제한 없음
    for (const k of ["rpm", "tpm"]) {
      const v = c.request?.[k];
      if (v !== undefined && !(Number.isInteger(v) && v >= 0)) errs.push(`${c.id}: request.${k} 는 0 이상의 정수여야 함: ${v}`);
    }
    if (c.workspaceId !== undefined && kind.workspace && !WORKSPACE_RE.test(c.workspaceId)) errs.push(`${c.id}: 워크스페이스 ID 형식이 아님 (wrkspc_…): ${c.workspaceId}`);
    for (const m of c.models ?? []) {
      if (!(m.contextWindow > 0) || !(m.maxOutput > 0)) errs.push(`${c.id}/${m.id}: 컨텍스트 길이나 응답 최대 길이가 없음`);
      if (kind.catalog !== "families" && root && !catalogModels(root, kind.catalog).some((x) => x.id === m.id)) {
        errs.push(`${c.id}/${m.id}: pi 내장 모델 목록에 없음`);
      }
    }
  }
  const point = (what, p) => {
    const conn = findConnection(llm, p?.connection);
    if (!conn) return errs.push(`${what}: 연결 ${p?.connection} 이 없음`);
    if (!findModel(conn, p.model)) return errs.push(`${what}: ${conn.id} 연결에 모델 ${p.model} 이 없음`);
    if (root && p.thinking && !thinkingChoices(root, conn, p.model).includes(p.thinking)) {
      errs.push(`${what}: ${p.model} 은 thinking ${p.thinking} 을 지원하지 않음`);
    }
  };
  if (llm.main) point("기본 모델", llm.main);
  for (const lv of llm.levels ?? []) point(`작업 수준 ${lv.id}`, lv);
  return errs;
}

/** 이 연결을 쓰고 있는 곳 (삭제 전 확인) */
export function connectionUsers(llm, id) {
  return [...(llm.main?.connection === id ? ["기본 모델"] : []),
    ...(llm.levels ?? []).filter((l) => l.connection === id).map((l) => `작업 수준 ${l.id}`)];
}

// ------------------------------------------------------------------ 예전 설정(oxy.env 의 vLLM 값) 옮기기
/** oxy.env 에서 llm.json 으로 옮긴 뒤 지우는 키 (docs/tui-spec.md §11 저장 위치) */
export const LEGACY_ENV_KEYS = ["OXY_VLLM_BASE_URL", "OXY_VLLM_API_KEY", "OXY_MODEL_CODER", "OXY_MODEL_GENERAL", "OXY_DEFAULT_MODEL",
  "OXY_CONTEXT_WINDOW", "OXY_MODEL_CODER_FAMILY", "OXY_MODEL_GENERAL_FAMILY", "OXY_VLLM_DROP_PARAMS", "OXY_PROVIDER_RETRIES", "OXY_MAX_OUTPUT_TOKENS"];

/** 예전 템플릿의 응답 최대 길이 (코딩 모델 16384, 범용 모델 32768) */
const LEGACY_MAX_OUTPUT = { coder: 16384, general: 32768 };

/**
 * oxy.env 의 vLLM 값(env)을 연결 "vllm" 으로 llm 에 합친다 (없으면 새로 만듦). 예전 설치 · 지금의 설치 TUI 가 쓴 값 모두.
 * → { llm, key: 옮길 API 키 (없으면 null) } · 옮길 값이 없으면 null
 */
export function migrateLegacy(llm, env) {
  const base = String(env.OXY_VLLM_BASE_URL ?? "").trim();
  if (!base) return null;
  const out = llm ? structuredClone(llm) : { version: 1, connections: [], levels: [] };
  const ctx = Number(env.OXY_CONTEXT_WINDOW) || 131072;
  const cap = Number(env.OXY_MAX_OUTPUT_TOKENS) || 0;
  const model = (id, role) => id ? {
    id, family: (role === "coder" ? env.OXY_MODEL_CODER_FAMILY : env.OXY_MODEL_GENERAL_FAMILY) || detectFamily(id),
    contextWindow: ctx, maxOutput: cap > 0 ? Math.min(cap, LEGACY_MAX_OUTPUT[role]) : LEGACY_MAX_OUTPUT[role],
  } : null;
  const coder = String(env.OXY_MODEL_CODER ?? "").trim();
  const general = String(env.OXY_MODEL_GENERAL ?? "").trim();
  const models = [model(coder, "coder"), general && general !== coder ? model(general, "general") : null].filter(Boolean);
  const prev = findConnection(out, "vllm");
  const conn = {
    id: "vllm", kind: "vllm", name: prev?.name ?? LLM_KINDS.vllm.label, baseUrl: base.replace(/\/+$/, ""),
    maxConcurrent: prev?.maxConcurrent ?? (Number(env.OXY_LLM_MAX_CONCURRENT) || LLM_KINDS.vllm.maxConcurrent),
    request: {
      retries: Number(env.OXY_PROVIDER_RETRIES) || 0,
      dropParams: String(env.OXY_VLLM_DROP_PARAMS ?? "").split(/[\s,]+/).filter((k) => VLLM_EXTRA_PARAMS.includes(k)),
    },
    models,
  };
  out.connections = prev ? out.connections.map((c) => (c.id === "vllm" ? conn : c)) : [...out.connections, conn];
  const defModel = String(env.OXY_DEFAULT_MODEL ?? "").trim() || coder;
  if (!out.main || out.main.connection === "vllm") {
    out.main = { connection: "vllm", model: defModel, thinking: out.main?.connection === "vllm" ? out.main.thinking ?? "off" : "off" };
  }
  if (!out.levels?.length) out.levels = DEFAULT_LEVELS.map((l) => ({ ...l, connection: out.main.connection, model: out.main.model, thinking: out.main.thinking }));
  // 연결 vllm 의 모델이 바뀌어 없는 모델을 가리키게 된 작업 수준은 기본 모델(없으면 이 연결의 첫 모델)로 되돌린다
  const fallback = out.main.connection === "vllm" ? out.main : { connection: "vllm", model: models[0]?.id, thinking: "off" };
  out.levels = out.levels.map((l) => (l.connection === "vllm" && !models.some((m) => m.id === l.model) && fallback.model
    ? { ...l, model: fallback.model, thinking: fallback.thinking ?? "off" } : l));
  // 키: 값이 있으면 저장, EMPTY · 빈 값이면 저장된 키 삭제, 변수 자체가 없으면 그대로
  const raw = env.OXY_VLLM_API_KEY;
  const key = raw === undefined ? undefined : String(raw).trim();
  return { llm: out, key: key && key !== "EMPTY" ? key : null, keyAction: key === undefined ? "keep" : key && key !== "EMPTY" ? "set" : "delete" };
}

/** env 파일 내용에서 키들의 줄을 지운다 (주석 줄은 남긴다) */
export function removeEnvKeys(text, keys) {
  const set = new Set(keys);
  return text.split(/\r?\n/).filter((line) => {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    return !(m && set.has(m[1]));
  }).join("\n");
}

/**
 * agentDir 의 oxy.env 에 예전 vLLM 값이 있으면 llm.json · secrets.json 으로 옮기고 oxy.env 에서 지운다.
 * secrets: installer/secrets.mjs 모듈 (setSecret · deleteSecret). → 옮겼으면 true
 */
export function migrateAgentDir(agentDir, env, secrets) {
  const r = migrateLegacy(loadLlm(agentDir), env);
  if (!r) return false;
  if (r.keyAction === "set") secrets.setSecret(agentDir, secretKey("vllm"), r.key);
  else if (r.keyAction === "delete") secrets.deleteSecret(agentDir, secretKey("vllm"));
  saveLlm(agentDir, r.llm);
  const envFile = join(agentDir, "oxy.env");
  if (existsSync(envFile)) writeFileSync(envFile, removeEnvKeys(readFileSync(envFile, "utf8"), LEGACY_ENV_KEYS));
  return true;
}
