// agent/templates/*.json 의 @@VAR@@ 를 값으로 치환해 agent/*.json 을 만든다.
// configure.sh 와 설치 TUI(installer/) 가 공통으로 사용한다. 외부 의존성 없음.
//
//   CLI: node scripts/render-config.mjs <agentDir>      (값은 환경변수에서 읽음)
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** 비어 있어도 되는 변수 (해당 모델 항목은 생성 결과에서 빠진다) */
const OPTIONAL = new Set(["OXY_MODEL_GENERAL"]);

/** KEY=VALUE 형식의 env 파일 파싱 (주석/빈 줄 무시, 양끝 따옴표 제거) */
export function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const v = m[2];
    out[m[1]] = /^'.*'$/.test(v) ? v.slice(1, -1).replace(/'\\''/g, "'") : v.replace(/^"(.*)"$/, "$1");
  }
  return out;
}

/** env 파일은 bash 가 source 하므로 공백·괄호 등이 있는 값은 작은따옴표로 감싼다 */
export function quoteEnv(v) {
  const s = String(v ?? "");
  return /^[A-Za-z0-9_./:@%+,=-]*$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** 기존 env 파일 내용을 유지하면서 updates 의 키만 바꾸거나 추가한다 (주석, 기타 키 보존) */
export function mergeEnv(text, updates) {
  const pending = new Map(Object.entries(updates).map(([k, v]) => [k, quoteEnv(v)]));
  const lines = text.split(/\r?\n/).map((line) => {
    const m = line.match(/^\s*#?\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!m || !pending.has(m[1])) return line;
    const v = pending.get(m[1]);
    pending.delete(m[1]);
    return `${m[1]}=${v}`;
  });
  while (lines.length && lines.at(-1) === "") lines.pop();
  for (const [k, v] of pending) lines.push(`${k}=${v}`);
  return lines.join("\n") + "\n";
}

function substitute(template, vars, name) {
  return template.replace(/@@([A-Z_]+)@@/g, (_, key) => {
    const v = vars[key];
    if ((v === undefined || v === "") && !OPTIONAL.has(key)) {
      throw new Error(`${name}: ${key} 값이 비어 있음 (agent/oxy.env 확인)`);
    }
    return v ?? "";
  });
}

/** models.json 후처리: id 가 빈 모델 제거, 중복 id 제거 */
/**
 * OpenAI 표준이 아닌 vLLM 확장 파라미터. vLLM 은 받지만, 앞단 게이트웨이(LiteLLM 등)가 거부하는 경우가 있다.
 * 설치 TUI·Tweak 의 vLLM 단계가 하나씩 시험해서, 거부된 것만 OXY_VLLM_DROP_PARAMS 에 적는다.
 */
export const VLLM_EXTRA_PARAMS = ["top_k", "repetition_penalty", "min_p", "chat_template_kwargs", "reasoning_effort"];

/**
 * 모델 계열 프리셋: thinking(추론) 제어 방식과 권장 샘플링 값. models.json 의 모델마다 OXY_MODEL_<CODER|GENERAL>_FAMILY 로 고른다.
 *   qwen-coder    : Qwen Coder 계열, thinking 없음
 *   qwen-thinking : Qwen3 하이브리드 thinking — chat_template_kwargs.enable_thinking 으로 켜고 끔 (vLLM --reasoning-parser qwen3)
 *   gpt-oss       : OpenAI gpt-oss — reasoning_effort (끌 수 없으므로 off 는 low 로 보냄)
 *   generic       : 그 밖의 OpenAI 호환 모델 — thinking 제어 없음, temperature 만
 */
export const MODEL_FAMILIES = {
  "qwen-coder": { label: "Qwen Coder (thinking 없음)", preset: {
    reasoning: false, samplingParams: { temperature: 0.7, top_p: 0.8, top_k: 20, repetition_penalty: 1.05 } } },
  "qwen-thinking": { label: "Qwen3 하이브리드 thinking (chat_template_kwargs)", preset: {
    reasoning: true, compat: { thinkingFormat: "qwen-chat-template" },
    samplingParams: { temperature: 0.6, top_p: 0.95, top_k: 20 },
    samplingParamsByThinkingLevel: { off: { temperature: 0.7, top_p: 0.8 } } } },
  "gpt-oss": { label: "OpenAI gpt-oss (reasoning_effort)", preset: {
    reasoning: true, compat: { supportsReasoningEffort: true },
    thinkingLevelMap: { off: "low", minimal: "low", low: "low", medium: "medium", high: "high" },
    samplingParams: { temperature: 1.0, top_p: 1.0 } } },
  generic: { label: "기타 OpenAI 호환 모델 (thinking 제어 없음)", preset: {
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
 * vars.OXY_VLLM_DROP_PARAMS (쉼표 구분) 에 든 파라미터를 요청에서 뺀다.
 *   top_k · repetition_penalty · min_p → samplingParams 에서 삭제
 *   chat_template_kwargs / reasoning_effort → 그 방식으로 thinking 을 제어하는 모델은 thinking 제어를 끈다
 *     (reasoning:false, thinking 끈 상태의 샘플링 사용)
 */
export function dropList(vars = {}) {
  return String(vars.OXY_VLLM_DROP_PARAMS ?? "").split(/[\s,]+/).filter((k) => VLLM_EXTRA_PARAMS.includes(k));
}

function applyFamily(m, family) {
  const f = MODEL_FAMILIES[family];
  if (!f) return;
  for (const k of ["reasoning", "compat", "samplingParams", "samplingParamsByThinkingLevel", "thinkingLevelMap"]) delete m[k];
  Object.assign(m, structuredClone(f.preset));
  m.name = `${m.id} (${family})`;
}

function cleanModels(json, vars = {}) {
  const drop = dropList(vars);
  // OXY_MAX_OUTPUT_TOKENS: 응답 최대 토큰 상한 (분당 출력 토큰 제한이 있는 엔드포인트용 — 예: Groq 무료 등급 OTPM 1000)
  const cap = Number.parseInt(vars.OXY_MAX_OUTPUT_TOKENS ?? "", 10);
  for (const p of Object.values(json.providers ?? {})) {
    if (!Array.isArray(p.models)) continue;
    const seen = new Set();
    p.models = p.models.filter((m) => m.id && !seen.has(m.id) && seen.add(m.id));
    for (const m of p.models) {
      // 계열: 명시한 값 → 없으면 id 로 추정 (템플릿 순서: 코딩 모델, 범용 모델)
      const role = m.id === vars.OXY_MODEL_CODER ? "coder" : "general";
      const fam = (role === "coder" ? vars.OXY_MODEL_CODER_FAMILY : vars.OXY_MODEL_GENERAL_FAMILY) || detectFamily(m.id);
      applyFamily(m, fam);
      if (Number.isInteger(cap) && cap > 0 && m.maxTokens > cap) m.maxTokens = cap;
      for (const k of drop) {
        delete m.samplingParams?.[k];
        for (const lv of Object.values(m.samplingParamsByThinkingLevel ?? {})) delete lv[k];
      }
      const thinkingParam = m.compat?.thinkingFormat === "qwen-chat-template" ? "chat_template_kwargs"
        : m.compat?.supportsReasoningEffort ? "reasoning_effort" : null;
      if (thinkingParam && drop.includes(thinkingParam)) {
        delete m.compat.thinkingFormat;
        delete m.compat.supportsReasoningEffort;
        if (!Object.keys(m.compat).length) delete m.compat;
        m.reasoning = false;
        delete m.thinkingLevelMap;
        if (m.samplingParamsByThinkingLevel?.off) m.samplingParams = { ...m.samplingParams, ...m.samplingParamsByThinkingLevel.off };
        delete m.samplingParamsByThinkingLevel;
        m.name += " · thinking 제어 없음";
      }
    }
  }
  return json;
}

/**
 * settings.json 후처리.
 * OXY_PROVIDER_RETRIES: 요청 단계 재시도 횟수 (서버가 알려 준 대기 시간 Retry-After 를 지킨다, 기본 0).
 *   rate limit 메시지에 "billing" 같은 말이 섞인 게이트웨이(Groq 등)는 pi 가 할당량 소진으로 보고 재시도하지 않으므로,
 *   이런 곳에서는 이 값을 켠다.
 */
function tuneSettings(json, vars = {}) {
  const n = Number.parseInt(vars.OXY_PROVIDER_RETRIES ?? "", 10);
  if (Number.isInteger(n) && n > 0) {
    json.retry ??= {};
    json.retry.provider = { ...json.retry.provider, maxRetries: n, maxRetryDelayMs: 90000 };
  }
  return json;
}

/** @returns 생성한 파일 경로 목록 */
export function renderConfig(agentDir, vars) {
  const tplDir = join(agentDir, "templates");
  const written = [];
  const outputs = {};
  for (const file of readdirSync(tplDir).filter((f) => f.endsWith(".json"))) {
    let json = JSON.parse(substitute(readFileSync(join(tplDir, file), "utf8"), vars, file));
    if (file === "models.json") json = cleanModels(json, vars);
    if (file === "settings.json") json = tuneSettings(json, vars);
    outputs[file] = json;
  }
  // defaultModel 이 실제 모델 목록에 있는지 확인
  const ids = Object.values(outputs["models.json"]?.providers ?? {}).flatMap((p) => (p.models ?? []).map((m) => m.id));
  const def = outputs["settings.json"]?.defaultModel;
  if (def && !ids.includes(def)) throw new Error(`기본 모델 ${def} 가 models.json 에 없음 (모델: ${ids.join(", ")})`);

  for (const [file, json] of Object.entries(outputs)) {
    const out = join(agentDir, file);
    writeFileSync(out, JSON.stringify(json, null, 2) + "\n");
    written.push(out);
  }
  // psmux(선택 구성요소) 설정: wrappers/psmux 가 하네스 전용 서버(-L oxy)에 이 파일을 쓴다. pane 셸은 Git Bash
  if (vars.OXY_SHELL_PATH) {
    const out = join(agentDir, "psmux.conf");
    writeFileSync(out, psmuxConf(vars.OXY_SHELL_PATH));
    written.push(out);
  }
  return written;
}

export function psmuxConf(shellPath) {
  return [
    "# oxygen-pi-system 이 만든 psmux 설정 (configure · 설치 TUI 가 다시 만든다 — 직접 고치지 말 것)",
    `set -g default-shell "${String(shellPath).replace(/\\/g, "/")}"`,
    "set -g history-limit 20000",
    "set -g mouse on",
    "",
  ].join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const agentDir = process.argv[2];
  if (!agentDir) { console.error("usage: render-config.mjs <agentDir>"); process.exit(2); }
  try {
    for (const f of renderConfig(agentDir, process.env)) console.log(f);
  } catch (e) {
    console.error(`[fail] ${e.message}`);
    process.exit(1);
  }
}
