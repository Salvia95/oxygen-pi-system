// agent/templates/*.json 의 @@VAR@@ 를 값으로 치환해 agent/*.json 을 만든다.
// configure.sh 와 설치 TUI(installer/) 가 공통으로 사용한다. 외부 의존성 없음.
//
//   CLI: node scripts/render-config.mjs <agentDir>      (값은 환경변수에서 읽음)
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as secrets from "../installer/secrets.mjs";
import { loadLlm, migrateAgentDir, settingsFromLlm, validateLlm } from "./llm-connections.mjs";

/** 비어 있어도 되는 템플릿 변수 */
const OPTIONAL = new Set([]);

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

// 모델 계열 · vLLM 확장 파라미터는 LLM 연결 정의(scripts/llm-connections.mjs)에 있다. 예전 import 경로를 위해 다시 내보낸다
export { VLLM_EXTRA_PARAMS, MODEL_FAMILIES, detectFamily } from "./llm-connections.mjs";

/** pi 가 settings.json 에서 읽는 LLM 값 (llm.json 에서 채운다. 템플릿에는 두지 않는다) */
const LLM_SETTING_KEYS = ["defaultProvider", "defaultModel", "defaultThinkingLevel", "enabledModels"];

/**
 * settings.json 에 LLM 연결 값을 채운다 (docs/tui-spec.md §11).
 * 재시도: 연결 중 가장 큰 request.retries (pi 의 재시도 설정은 하나다). 서버가 알려 준 대기 시간(Retry-After)을 지킨다.
 *   rate limit 메시지에 "billing" 같은 말이 섞인 게이트웨이(Groq 등)는 pi 가 할당량 소진으로 보고 재시도하지 않으므로 필요하다.
 */
function applyLlmSettings(json, llm) {
  for (const k of LLM_SETTING_KEYS) delete json[k];
  if (!llm) return json;
  const s = settingsFromLlm(llm);
  for (const k of LLM_SETTING_KEYS) if (s[k] !== undefined) json[k] = s[k];
  if (s.retries) {
    json.retry ??= {};
    json.retry.provider = { ...json.retry.provider, maxRetries: s.retries, maxRetryDelayMs: 90000 };
  }
  return json;
}

/**
 * agent/templates/*.json → agent/*.json. 먼저 oxy.env 에 남은 예전 vLLM 값을 llm.json · secrets.json 으로 옮긴다.
 * opts.root: 하네스 루트 (pi 내장 카탈로그 확인용. 기본은 vars.OXY_HOME → agentDir 의 상위)
 * @returns 생성한 파일 경로 목록
 */
export const DEFAULT_THEME = "tokyo-night";

/**
 * pi 테마 (docs/flow-view-spec.md §4): 번들의 vendor/pi-themes/*.json 을 agent/themes 로 복사하고,
 * settings.json 의 theme 은 지금 값(사용자가 pi /settings 에서 고른 것)을 두되 없으면 DEFAULT_THEME (그 테마 파일이 있을 때만).
 */
export function applyTheme(json, agentDir, root) {
  const src = join(root, "vendor", "pi-themes");
  if (existsSync(src)) {
    mkdirSync(join(agentDir, "themes"), { recursive: true });
    for (const f of readdirSync(src).filter((x) => x.endsWith(".json"))) copyFileSync(join(src, f), join(agentDir, "themes", f));
  }
  let current;
  try { current = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).theme; } catch { /* 아직 없음 */ }
  const out = { ...json };
  if (typeof current === "string" && current) out.theme = current;
  else if (existsSync(join(agentDir, "themes", `${DEFAULT_THEME}.json`))) out.theme = DEFAULT_THEME;
  return out;
}

export function renderConfig(agentDir, vars, opts = {}) {
  const root = opts.root ?? vars.OXY_HOME ?? resolve(agentDir, "..");
  // 예전 값은 oxy.env 파일에서만 읽는다 (셸에 이전 값이 내보내져 있어도 llm.json 을 덮어쓰지 않게)
  const envFile = join(agentDir, "oxy.env");
  if (existsSync(envFile)) migrateAgentDir(agentDir, parseEnv(readFileSync(envFile, "utf8")), secrets);
  const llm = loadLlm(agentDir);
  if (llm) {
    const errs = validateLlm(llm, root);
    if (errs.length) throw new Error(`LLM 연결 설정(agent/llm.json)에 문제가 있음: ${errs.join(" / ")}`);
  }
  const tplDir = join(agentDir, "templates");
  const written = [];
  const outputs = {};
  for (const file of readdirSync(tplDir).filter((f) => f.endsWith(".json"))) {
    let json = JSON.parse(substitute(readFileSync(join(tplDir, file), "utf8"), vars, file));
    if (file === "settings.json") json = applyTheme(applyLlmSettings(json, llm), agentDir, root);
    outputs[file] = json;
  }
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
