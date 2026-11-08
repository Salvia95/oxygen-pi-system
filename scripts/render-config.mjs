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
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

/** 기존 env 파일 내용을 유지하면서 updates 의 키만 바꾸거나 추가한다 (주석, 기타 키 보존) */
export function mergeEnv(text, updates) {
  const pending = new Map(Object.entries(updates));
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
function cleanModels(json) {
  for (const p of Object.values(json.providers ?? {})) {
    if (!Array.isArray(p.models)) continue;
    const seen = new Set();
    p.models = p.models.filter((m) => m.id && !seen.has(m.id) && seen.add(m.id));
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
    if (file === "models.json") json = cleanModels(json);
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
  return written;
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
