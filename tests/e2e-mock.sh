#!/usr/bin/env bash
# 실제 vLLM 없이 하네스 전체 경로를 점검한다:
#   pi → (mock) vLLM → 도구 실행(Git Bash) → oxy extension → 최종 응답
# 실제 agent/ 설정은 건드리지 않고 임시 agent 디렉터리를 사용한다.
#   bash tests/e2e-mock.sh [port]
source "$(dirname "${BASH_SOURCE[0]}")/../scripts/lib.sh"
# shellcheck disable=SC1091
source "$OXY_HOME/env.sh"

PORT="${1:-18000}"
TMP="$(mktemp -d)"; trap 'kill "${MOCK_PID:-}" 2>/dev/null || true; rm -rf "$TMP"' EXIT
mkdir -p "$TMP/agent" "$TMP/work"
cp -r "$OXY_HOME/agent/AGENTS.md" "$OXY_HOME/agent/templates" "$OXY_HOME/agent/bin" "$OXY_HOME/agent/extensions" "$OXY_HOME/agent/skills" "$TMP/agent/"
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
"$OXY_NODE" "$(winpath "$OXY_HOME/tests/mock-vllm.mjs")" "$PORT" "$(winpath "$REQLOG")" >/dev/null & MOCK_PID=$!
for _ in $(seq 50); do curl -fs "http://127.0.0.1:$PORT/v1/models" >/dev/null 2>&1 && break; sleep 0.1; done

F=0
chk() { if eval "$2"; then printf '  \033[32mPASS\033[0m %s\n' "$1"; else printf '  \033[31mFAIL\033[0m %s\n' "$1"; F=$((F+1)); fi; }

# 시나리오 실행: 결과는 $out, 해당 실행의 요청 로그는 $REQ
run() {
  printf 'hello world\n' > "$TMP/work/sample.txt"
  : > "$REQLOG"
  out=$(cd "$TMP/work" && timeout 120 "$OXY_NODE" "$OXY_PI_CLI" --no-session -p "scenario:$1" < /dev/null 2>&1) || true
  REQ="$REQLOG"
  printf '\n\033[1m[%s]\033[0m %s\n' "$1" "$(head -c 160 <<< "$out" | tr '\n' ' ')"
}
first() { head -n1 "$REQ" | jq -r "$1"; }
nreq() { wc -l < "$REQ" | tr -d ' '; }

run env
chk "최종 응답 수신"                         '[[ "$out" == *MOCK-DONE* ]]'
chk "bash 도구가 Git Bash(Msys)에서 실행"      '[[ "$out" == *hello-from-Msys* ]]'
chk "번들 fd / jq 래퍼가 PATH 우선"            '[[ "$out" == *"/agent/bin/fd"* && "$out" == *"$OXY_HOME/wrappers/jq"* ]]'
chk "sql 은 래퍼로 연결"                      '[[ "$out" == *"$OXY_HOME/wrappers/sql"* ]]'
chk "요청 2회 (tool call → 결과 회신)"          '[[ $(nreq) -eq 2 ]]'
chk "model id / Authorization"               '[[ $(first .body.model) == qwen3.6-coder-30b && $(first .headers.authorization) == "Bearer mock-key" ]]'
chk "max_tokens 사용, store·developer role 없음" '[[ $(first ".body.max_tokens // empty") != "" && $(first ".body | has(\"store\")") == false && $(first "[.body.messages[].role] | index(\"developer\")") == null ]]'
chk "sampling (temperature 0.7, top_k 20)"   '[[ $(first .body.temperature) == 0.7 && $(first .body.top_k) == 20 ]]'
chk "tools 7종"                              '[[ $(first "[.body.tools[].function.name] | sort | join(\",\")") == "bash,edit,find,grep,ls,read,write" ]]'
chk "AGENTS.md 가 시스템 프롬프트에 포함"        '[[ $(first ".body.messages[0].content | tostring | contains(\"oxygen-pi-system\")") == true ]]'
SYS="$(first '.body.messages[0].content | tostring')"
chk "skill 6종이 시스템 프롬프트에 노출"         '[[ $(grep -oE "oracle-sqlcl|gitlab-glab|http-api-hurl|browser-automation|just-tasks|shell-data-tools" <<< "$SYS" | sort -u | wc -l) -eq 6 ]]'
log "첫 요청 크기: system $(first '.body.messages[0].content | tostring | length')자, tools $(first '.body.tools | tostring | length')자"

run offline-install
chk "bash-guard: npm install 차단(deny)"     '[[ "$out" == *"oxy-guard/offline-install"* ]]'

run git-push
chk "bash-guard: 확인 UI 없는 모드에서 git push 차단" '[[ "$out" == *"oxy-guard/git-history"* && "$out" == *"no confirmation UI"* ]]'

run edit-unread
chk "read-before-edit: 읽지 않은 파일 edit 차단"  '[[ "$out" == *"oxy-read-before-edit"* && $(cat "$TMP/work/sample.txt") == "hello world" ]]'

run write-existing
chk "read-before-edit: 기존 파일 write 차단"      '[[ "$out" == *"oxy-read-before-edit"* && $(cat "$TMP/work/sample.txt") == "hello world" ]]'

run read-then-edit
chk "read-before-edit: read 후 edit 는 허용"      '[[ "$out" != *"BLOCKED"* && $(cat "$TMP/work/sample.txt") == "bye world" ]]'

run big-output
chk "context-budget: 긴 bash 출력 축약"          '[[ "$out" == *"characters omitted"* && "$out" == *"30000"* && ${#out} -lt 14000 ]]'

run text-toolcall
chk "loop-guard: 텍스트 tool call 감지 → 재호출 안내" '[[ "$out" == *"[oxy-loop-guard]"* && $(nreq) -eq 2 ]]'

run read-skill
chk "skill: 프롬프트의 위치로 SKILL.md 읽기"       '[[ "$out" == *"# Oracle SQLcl"* && "$out" == *"Never use \`-e\`"* ]]'

run repeat
chk "loop-guard: 같은 호출 3번째 차단"            '[[ "$out" == *"oxy-loop-guard"* && "$out" == *"2 times"* ]]'

printf '\n'
cp "$REQLOG" "$OXY_HOME/.cache/last-e2e-requests.jsonl" 2>/dev/null || true
(( F == 0 )) && log "E2E 통과" || die "E2E 실패 $F 건"
