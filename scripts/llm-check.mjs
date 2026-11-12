// 상태 점검(scripts/verify.sh)의 LLM 연결 부분. 한 줄에 "<PASS|WARN|FAIL|SECTION|MAIN>\t<메시지>" 를 출력한다 (verify.sh 가 받아서 표시).
//   node scripts/llm-check.mjs <하네스 루트> <agent 폴더> --local   서버에 연결하지 않는 점검 (설정 · 작업 수준 · compaction 여유분 · 키)
//   node scripts/llm-check.mjs <하네스 루트> <agent 폴더> --net     연결마다 서버 점검 (SECTION 줄로 나눈다):
//     모델 목록에 등록한 모델이 있는지 → tool call 이 구조화되어 오는지 → (vLLM) 샘플링 파라미터를 받는지
// 키 값은 출력하지 않는다.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getSecrets } from "../installer/secrets.mjs";
import { LLM_KINDS, checkSampling, checkToolCall, listModels, loadLlm, providerId, secretKey, validateLlm } from "./llm-connections.mjs";

const [root, agentDir, mode] = process.argv.slice(2);
const say = (level, msg) => console.log(`${level}\t${msg}`);

const llm = loadLlm(agentDir);
if (!llm) {
  if (mode !== "--net") say("FAIL", "LLM 연결 없음 (agent/llm.json) → install.cmd의 LLM 단계나 tweak.cmd의 LLM 연결에서 등록하세요");
  process.exit(0);
}

let keys = {};
let keyError = null;
try { keys = getSecrets(agentDir, llm.connections.map((c) => secretKey(c.id))); } catch (e) { keyError = e; }

if (mode === "--net") await serverChecks();
else localChecks();

function localChecks() {
  const errs = validateLlm(llm, root);
  for (const e of errs) say("FAIL", `llm.json: ${e} → tweak.cmd의 LLM 연결에서 고치세요`);
  if (!errs.length) say("PASS", `LLM 연결 ${llm.connections.map((c) => c.id).join(", ")} · 기본 모델 ${llm.main?.connection}/${llm.main?.model} (thinking ${llm.main?.thinking ?? "off"})`);
  const lv = (llm.levels ?? []).map((l) => `${l.id}=${l.connection}/${l.model}${l.thinking && l.thinking !== "off" ? `:${l.thinking}` : ""}`);
  if (lv.length) say("PASS", `작업 수준 ${lv.join(" · ")}`);
  else say("WARN", "작업 수준이 없음 → subagent가 부모 모델을 그대로 씁니다");

  // compaction 여유분 ≥ 모델 응답 최대치 (작으면 compaction 전에 한도를 넘어 실패 후 복구 경로로 감)
  try {
    const s = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
    const reserve = s.compaction?.reserveTokens ?? 16384;
    const maxOut = Math.max(0, ...llm.connections.flatMap((c) => (c.models ?? []).map((m) => m.maxOutput ?? 0)));
    if (s.compaction?.enabled === false) say("WARN", "compaction 꺼짐 — 작업 도중 컨텍스트가 차면 요청이 실패합니다");
    else if (reserve > maxOut) say("PASS", `compaction 여유분 ${reserve} > 응답 최대 ${maxOut} 토큰`);
    else say("WARN", `compaction 여유분 ${reserve} ≤ 응답 최대 ${maxOut} 토큰 → settings.json compaction.reserveTokens 를 늘리세요`);
  } catch { /* settings.json 은 verify.sh 가 따로 점검한다 */ }

  // 키: DPAPI 로 복호화할 수 있는지
  if (keyError) say("FAIL", `API 키 복호화 실패: ${keyError.message} → 설치한 Windows 사용자로 실행했는지 확인하세요`);
  for (const c of llm.connections) {
    const kind = LLM_KINDS[c.kind];
    if (!kind) continue;
    const has = Boolean(keys[secretKey(c.id)]);
    if (kind.keyRequired && !has) say("FAIL", `${c.id}: API 키가 없거나 복호화할 수 없음 → tweak.cmd의 LLM 연결에서 키를 다시 입력하세요`);
    else say("PASS", `${c.id}: API 키 ${has ? "저장됨 (DPAPI)" : "없음 (키 없이 연결)"}`);
  }
  // pi 가 기본 모델을 인식하는지는 verify.sh 가 pi --list-models 로 본다
  if (llm.main) say("MAIN", `${providerId(llm.main.connection)}\t${llm.main.model}`);
}

async function serverChecks() {
  for (const c of llm.connections) {
    const kind = LLM_KINDS[c.kind];
    if (!kind) continue;
    say("SECTION", `7. LLM 연결: ${c.id} (${kind.label}, ${c.baseUrl || kind.baseUrl})`);
    const key = keys[secretKey(c.id)];
    let list;
    try {
      const r = await listModels(c, key);
      list = r.models.map((m) => m.id);
      say("PASS", `모델 목록 응답: ${list.length}개${r.rateLimit ? ` · 분당 토큰 한도 ${r.rateLimit.toLocaleString()}` : ""}`);
    } catch (e) {
      say("WARN", `서버 접속 불가: ${e.cause?.code ?? e.message}`);
      continue;
    }
    for (const m of c.models ?? []) {
      if (list.includes(m.id)) say("PASS", `모델 있음: ${m.id}`);
      else say("WARN", `서버에 ${m.id} 없음 → ${kind.hints?.models ?? "모델 이름을 확인하세요"}`);
    }
    // tool call · 샘플링: 이 연결에서 기본 모델이나 작업 수준이 쓰는 모델 하나 (없으면 첫 모델)
    const used = [llm.main, ...(llm.levels ?? [])].filter((p) => p?.connection === c.id).map((p) => p.model);
    const model = used.find((m) => list.includes(m)) ?? (c.models ?? []).map((m) => m.id).find((m) => list.includes(m));
    if (!model) continue;
    try {
      const t = await checkToolCall(c, key, model);
      if (t.ok) say("PASS", `tool calling 정상 (${model})`);
      else say("WARN", `tool call이 구조화되어 오지 않음 (${model}) → ${kind.hints?.toolCall ?? "서버 설정을 확인하세요"}${t.detail ? ` · ${t.detail}` : ""}`);
    } catch (e) { say("WARN", `tool call 요청 실패: ${e.cause?.code ?? e.message}`); }
    try {
      const s = await checkSampling(root, c, key, model);
      if (s?.ok) say("PASS", `샘플링 파라미터 수락: ${JSON.stringify(s.params)}`);
      else if (s) say("FAIL", `서버가 샘플링 파라미터를 거부 (HTTP ${s.status}): ${s.detail} → tweak.cmd의 LLM 연결에서 이 연결을 편집하면 자동으로 판정해 제외합니다`);
    } catch (e) { say("WARN", `샘플링 파라미터 확인 실패: ${e.cause?.code ?? e.message}`); }
  }
}
