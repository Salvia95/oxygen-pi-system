#!/usr/bin/env bash
# 실제 vLLM 없이 하네스 전체 경로를 점검한다: pi → (mock) vLLM → bash 도구(Git Bash) → 번들 도구 → 최종 응답
# 실제 agent/ 설정은 건드리지 않고 임시 agent 디렉터리를 사용한다.
source "$(dirname "${BASH_SOURCE[0]}")/../scripts/lib.sh"
# shellcheck disable=SC1091
source "$OXY_HOME/env.sh"

PORT="${1:-18000}"
TMP="$(mktemp -d)"; trap 'kill "${MOCK_PID:-}" 2>/dev/null || true; rm -rf "$TMP"' EXIT
mkdir -p "$TMP/agent"
cp -r "$OXY_HOME/agent/AGENTS.md" "$OXY_HOME/agent/templates" "$OXY_HOME/agent/bin" "$TMP/agent/"
cat > "$TMP/agent/oxy.env" <<ENV
OXY_VLLM_BASE_URL=http://127.0.0.1:$PORT/v1
OXY_VLLM_API_KEY=mock-key
OXY_MODEL_CODER=qwen3.6-coder-30b
OXY_MODEL_GENERAL=qwen3.8-27b
OXY_DEFAULT_MODEL=qwen3.6-coder-30b
OXY_CONTEXT_WINDOW=131072
ENV
OXY_AGENT_DIR="$TMP/agent" bash "$OXY_HOME/scripts/configure.sh" >/dev/null
export PI_CODING_AGENT_DIR="$(winpath "$TMP/agent")" OXY_VLLM_API_KEY=mock-key

REQLOG="$TMP/requests.jsonl"
"$OXY_NODE" "$(winpath "$OXY_HOME/tests/mock-vllm.mjs")" "$PORT" "$(winpath "$REQLOG")" & MOCK_PID=$!
for _ in $(seq 50); do curl -fs "http://127.0.0.1:$PORT/v1/models" >/dev/null 2>&1 && break; sleep 0.1; done

log "pi 1회 실행 (mock vLLM)"
out=$(cd "$TMP" && timeout 120 "$OXY_NODE" "$OXY_PI_CLI" --no-session -p "run the environment check" < /dev/null 2>&1) || true
printf '%s\n' "$out" | sed 's/^/    | /'

F=0
chk() { if eval "$2"; then printf '  \033[32mPASS\033[0m %s\n' "$1"; else printf '  \033[31mFAIL\033[0m %s\n' "$1"; F=$((F+1)); fi; }
first() { head -n1 "$REQLOG" | jq -r "$1"; }
chk "최종 응답 수신"                  '[[ "$out" == *MOCK-DONE* ]]'
chk "bash 도구가 Git Bash(Msys)에서 실행" '[[ "$out" == *hello-from-Msys* ]]'
chk "번들 fd/jq 가 PATH 우선"          '[[ "$out" == *"/agent/bin/fd"* && "$out" == *"$OXY_HOME/bin/jq"* ]]'
chk "sql 은 래퍼로 연결"              '[[ "$out" == *"$OXY_HOME/wrappers/sql"* ]]'
chk "요청 2회 (tool call → 결과 회신)"   '[[ $(wc -l < "$REQLOG") -eq 2 ]]'
chk "model id"                       '[[ $(first .body.model) == qwen3.6-coder-30b ]]'
chk "Authorization 헤더"              '[[ $(first .headers.authorization) == "Bearer mock-key" ]]'
chk "max_tokens 사용 (max_completion_tokens 아님)" '[[ $(first ".body.max_tokens // empty") != "" && $(first ".body.max_completion_tokens // empty") == "" ]]'
chk "store 필드 없음"                  '[[ $(first ".body | has(\"store\")") == false ]]'
chk "developer role 미사용"            '[[ $(first "[.body.messages[].role] | index(\"developer\")") == null ]]'
chk "sampling (temperature 0.7, top_k 20)" '[[ $(first .body.temperature) == 0.7 && $(first .body.top_k) == 20 ]]'
chk "tools 에 bash/read/edit/write/grep/find/ls" '[[ $(first "[.body.tools[].function.name] | sort | join(\",\")") == "bash,edit,find,grep,ls,read,write" ]]'
chk "AGENTS.md 가 시스템 프롬프트에 포함" '[[ $(first ".body.messages[0].content | tostring | contains(\"oxygen-pi-system\")") == true ]]'
SYS_CHARS=$(first '.body.messages[0].content | tostring | length'); TOOLS_CHARS=$(first '.body.tools | tostring | length')
log "첫 요청 크기: system ${SYS_CHARS}자, tools ${TOOLS_CHARS}자 (소형 모델 컨텍스트 예산 참고)"
(( F == 0 )) && log "E2E 통과" || die "E2E 실패 $F 건"
