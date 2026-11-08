#!/usr/bin/env bash
# [폐쇄망 PC 자가진단] 네트워크 없이 하네스 구성요소를 모두 점검한다. FAIL 이 있으면 종료코드 1.
#   bash scripts/verify.sh            # 전체 점검
#   bash scripts/verify.sh --no-llm   # vLLM 연결 점검 생략
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# shellcheck disable=SC1091
source "$OXY_HOME/env.sh"

CHECK_LLM=1
[[ "${1:-}" == "--no-llm" ]] && CHECK_LLM=0

P=0 W=0 F=0
pass() { printf '  \033[32mPASS\033[0m %s\n' "$*"; P=$((P+1)); }
wrn()  { printf '  \033[33mWARN\033[0m %s\n' "$*"; W=$((W+1)); }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; F=$((F+1)); }
section() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# 명령의 첫 줄 출력이 나오면 PASS. 실행 파일 위치가 번들 내부인지도 표시한다.
tool() { # <label> <cmd...>
  local label="$1"; shift
  local out where
  if out=$("$@" 2>&1 | head -n1) && [[ -n "$out" ]]; then
    where=$(command -v "$1" 2>/dev/null || true)
    [[ "$where" == "$OXY_HOME"* ]] || [[ "$1" == /* ]] || out="$out  (번들 외부: $where)"
    pass "$label: $out"
  else
    fail "$label: 실행 실패 ($out)"
  fi
}

section "1. 런타임"
if [[ -x "$OXY_NODE" ]]; then
  if "$OXY_NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a==22&&b>=19)?0:1)'; then
    pass "node $("$OXY_NODE" -v) (번들, pi 요구사항 >=22.19 충족)"
  else fail "번들 node 버전이 22.19 미만: $("$OXY_NODE" -v)"; fi
else fail "번들 node 없음: $OXY_NODE"; fi

if [[ -f "$OXY_PI_CLI" ]]; then tool "pi" "$OXY_NODE" "$OXY_PI_CLI" --version
else fail "pi 미설치: $OXY_PI_CLI"; fi

GIT_BASH="$(cygpath -m /)"; GIT_BASH="${GIT_BASH%/}/bin/bash.exe"
[[ -f "$GIT_BASH" ]] && pass "Git Bash: $GIT_BASH" || fail "Git Bash 없음: $GIT_BASH"

if command -v java >/dev/null; then
  jv=$(java -version 2>&1 | head -n1)
  major=$(sed -nE 's/.*version "([0-9]+).*/\1/p' <<< "$jv")
  (( ${major:-0} >= 17 )) && pass "java: $jv" || fail "java 17 이상 필요 (SQLcl): $jv"
else fail "java 없음 (SQLcl 실행 불가)"; fi

section "2. 번들 도구"
tool "fd"            fd --version
tool "rg"            rg --version
tool "jq"            jq --version
tool "just"          just --version
tool "hurl"          hurl --version
tool "glab"          glab --version
tool "agent-browser" agent-browser --version
tool "sqlcl"         sql -V
for t in fd rg; do
  [[ -f "$OXY_HOME/agent/bin/$t.exe" ]] && pass "agent/bin/$t.exe (pi 자동 다운로드 방지)" \
    || fail "agent/bin/$t.exe 없음 → pi 가 GitHub 다운로드를 시도함"
done

section "3. 브라우저"
CHROME="$(cygpath -u "$AGENT_BROWSER_EXECUTABLE_PATH")"
[[ -f "$CHROME" ]] && pass "Chrome for Testing: $AGENT_BROWSER_EXECUTABLE_PATH" || fail "Chrome 없음: $CHROME"
if out=$(agent-browser doctor --offline --quick 2>&1); then pass "agent-browser doctor --offline --quick"
else wrn "agent-browser doctor 경고: $(tail -n3 <<< "$out" | tr '\n' ' ')"; fi
if agent-browser skills list 2>/dev/null | grep -q '^ *core '; then pass "agent-browser 버전 일치 가이드 (skills get core)"
else fail "agent-browser 가이드 없음: $AGENT_BROWSER_SKILLS_DIR"; fi

section "4. skill / Git Bash 보정"
skills=$(find "$OXY_HOME/agent/skills" -name SKILL.md 2>/dev/null | sed 's|/SKILL.md$||; s|.*/||' | sort | tr '\n' ' ')
[[ -n "$skills" ]] && pass "pi skill: $skills" || fail "agent/skills 에 SKILL.md 없음"
if jq -n '1' | od -c | grep -q '\\r'; then fail "jq 출력에 CR 포함 (wrappers/jq 확인)"; else pass "jq 출력 LF (wrappers/jq)"; fi
rgout=$(rg -l OXY_HOME "$OXY_HOME/scripts" 2>&1)
if [[ -z "$rgout" ]]; then fail "rg 실행 결과 없음"
elif [[ "$rgout" == *'\'* ]]; then fail   # 주의: Git Bash 에서 *\\* 패턴은 역슬래시와 매칭되지 않음 "rg 가 역슬래시 경로 출력 (RIPGREP_CONFIG_PATH 확인)"
else pass "rg 경로 / 구분 (config/ripgreprc)"; fi

section "5. pi 설정"
for f in settings.json models.json; do
  p="$OXY_HOME/agent/$f"
  if [[ -f "$p" ]] && "$OXY_NODE" -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$(winpath "$p")" 2>/dev/null; then
    pass "agent/$f"
  else fail "agent/$f 없음 또는 JSON 오류 → just configure"; fi
done
[[ "${PI_OFFLINE:-}" == 1 && "${PI_SKIP_VERSION_CHECK:-}" == 1 && "${PI_TELEMETRY:-}" == 0 ]] \
  && pass "PI_OFFLINE / PI_SKIP_VERSION_CHECK / PI_TELEMETRY=0" || fail "pi 오프라인 환경변수 미설정"
if [[ -f "$OXY_HOME/agent/models.json" && -f "$OXY_PI_CLI" ]]; then
  if out=$("$OXY_NODE" "$OXY_PI_CLI" --offline --list-models oxy-vllm 2>&1) && grep -q "${OXY_DEFAULT_MODEL:-@@}" <<< "$out"; then
    pass "pi 가 모델을 인식: ${OXY_DEFAULT_MODEL}"
  else fail "pi --list-models 에서 ${OXY_DEFAULT_MODEL:-?} 미확인: $(head -n3 <<< "$out" | tr '\n' ' ')"; fi
fi

if [[ $CHECK_LLM == 1 ]]; then
  section "6. 사내 vLLM (${OXY_VLLM_BASE_URL:-미설정})"
  if [[ -z "${OXY_VLLM_BASE_URL:-}" ]]; then fail "OXY_VLLM_BASE_URL 미설정 (agent/oxy.env)"
  elif resp=$(curl -fsS -m 5 -H "Authorization: Bearer ${OXY_VLLM_API_KEY:-EMPTY}" "$OXY_VLLM_BASE_URL/models" 2>&1); then
    # jq.exe 는 CRLF 로 출력하므로 \r 제거 (안 하면 모델명 비교가 항상 실패)
    ids=$(jq -r '.data[].id' <<< "$resp" 2>/dev/null | tr -d '\r' | tr '\n' ' ')
    pass "/models 응답: $ids"
    for m in "${OXY_MODEL_CODER:-}" "${OXY_MODEL_GENERAL:-}"; do
      [[ -z "$m" ]] && continue
      [[ " $ids " == *" $m "* ]] && pass "served-model-name 일치: $m" || wrn "vLLM 에 $m 없음 (oxy.env 모델명 확인)"
    done
    if [[ " $ids " == *" ${OXY_DEFAULT_MODEL:-} "* ]]; then
      body=$(jq -nc --arg m "$OXY_DEFAULT_MODEL" '{model:$m,max_tokens:64,tool_choice:"auto",
        messages:[{role:"user",content:"Call the ping tool."}],
        tools:[{type:"function",function:{name:"ping",description:"health check",parameters:{type:"object",properties:{}}}}]}')
      if r=$(curl -fsS -m 60 -H "Authorization: Bearer ${OXY_VLLM_API_KEY:-EMPTY}" -H 'Content-Type: application/json' \
            -d "$body" "$OXY_VLLM_BASE_URL/chat/completions" 2>&1) \
         && [[ "$(jq -r '.choices[0].message.tool_calls[0].function.name // empty' <<< "$r")" == ping ]]; then
        pass "tool calling 정상 (vLLM --enable-auto-tool-choice / --tool-call-parser 설정 확인됨)"
      else wrn "tool call 이 구조화되어 오지 않음 → vLLM 의 --enable-auto-tool-choice, --tool-call-parser 확인"; fi
    fi
  else wrn "vLLM 접속 불가: $resp"; fi
fi

printf '\n\033[1m결과: PASS %d / WARN %d / FAIL %d\033[0m\n' "$P" "$W" "$F"
(( F == 0 ))
