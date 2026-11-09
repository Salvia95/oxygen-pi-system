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
cp -r "$OXY_HOME/agent/AGENTS.md" "$OXY_HOME/agent/templates" "$OXY_HOME/agent/bin" "$OXY_HOME/agent/extensions" "$OXY_HOME/agent/skill-library" "$OXY_HOME/agent/agents" "$TMP/agent/"
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

# DB MCP: SQLite 연결(dbhub) + 비밀값 주입 확인용 envcheck 서버 (dbhub 를 반입한 경우만)
HAS_DBHUB=0; [[ -f "$OXY_HOME/vendor/dbhub/node_modules/@bytebase/dbhub/dist/index.js" ]] && HAS_DBHUB=1
if (( HAS_DBHUB )); then
  "$OXY_HOME/bin/usql.exe" "sqlite:$(winpath "$TMP/e2e.db")" -c "create table t(a int); insert into t values (1),(2),(3),(4);" >/dev/null 2>&1
  "$OXY_NODE" "$(winpath "$OXY_HOME/tests/e2e-db-setup.mjs")" "$(winpath "$OXY_HOME")" "$(winpath "$TMP/agent")" "$(winpath "$TMP/e2e.db")" 'pw:한글 "q"$x' >/dev/null
fi

REQLOG="$TMP/requests.jsonl"
MOCK_CHILD_DELAY_MS=300 "$OXY_NODE" "$(winpath "$OXY_HOME/tests/mock-vllm.mjs")" "$PORT" "$(winpath "$REQLOG")" >/dev/null & MOCK_PID=$!
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
chk "내장 tools 7종 + oxy-jobs 2종 (+MCP direct)" '[[ $(first "[.body.tools[].function.name | select(startswith(\"mcp__\") | not)] | sort | join(\",\")") == "background,bash,edit,find,grep,ls,read,subagent,write" ]]'
chk "AGENTS.md 가 시스템 프롬프트에 포함"        '[[ $(first ".body.messages[0].content | tostring | contains(\"oxygen-pi-system\")") == true ]]'
SYS="$(first '.body.messages[0].content | tostring')"
ENABLED=$(ls "$TMP/agent/skills")
missing_skill=$(for s in $ENABLED; do grep -q "<name>$s</name>" <<< "$SYS" || echo "$s"; done)
chk "켜진 skill $(wc -w <<< "$ENABLED")개가 모두 프롬프트에 노출" '[[ -n "$ENABLED" && -z "$missing_skill" ]]'
chk "skill-library 원본은 프롬프트에 없음"        '[[ "$SYS" != *"skill-library"* ]]'
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

if (( HAS_DBHUB )); then
  run db-mcp
  chk "dbhub MCP: pi 가 도구를 선언하고 SQLite 조회"  '[[ "$out" == *'"'"'"n": 4'"'"'* || "$out" == *'"'"'\"n\": 4'"'"'* ]]'
  chk "dbhub MCP: exposure=direct 로 바로 선언"     '[[ $(first "[.body.tools[].function.name] | map(select(startswith(\"mcp__dbhub__execute_sql\"))) | length") -ge 1 ]]'
  run env-mcp
  chk "MCP env \"!command\" 로 DPAPI 비밀값 주입"   '[[ "$out" == *"ENVCHECK: match"* ]]'
else
  log "dbhub 미포함 → DB MCP 시나리오 생략"
fi

# ---- oxy-jobs: 백그라운드 작업 · subagent ----
run bg-start
chk "background: 끝나면 결과를 알리고 이어서 응답"  '[[ "$out" == *"[oxy-jobs] job-1 done (exit 0)"* && "$out" == *"bg-finished-ok"* ]]'
chk "background: 작업 로그 파일"               '[[ -n "$(ls "$TMP/agent/jobs/"*-job-1.log 2>/dev/null)" ]]'

run bg-guard
chk "background 도 bash-guard 검사 (npm install 차단)" '[[ "$out" == *"oxy-guard/offline-install"* ]]'

run sub-sync
chk "subagent: 별도 컨텍스트 실행 후 결과 반환"     '[[ "$out" == *"(scout: scenario:env check the environment) done"* && "$out" == *"hello-from-Msys"* ]]'
chk "subagent: 자식에는 지정한 도구만 (재귀 방지)"   '[[ $(jq -r "select(.body.messages | map(select(.role==\"user\"))[0].content | tostring | contains(\"Task:\")) | [.body.tools[].function.name] | sort | join(\",\")" "$REQ" | sort -u) == "bash,find,grep,ls,read" ]]'

run sub-async
chk "subagent wait=false: 완료 후 결과 알림"        '[[ "$out" == *"(scout: scenario:env async check) done"* ]]'

# 동시 실행 제한: 자식 요청을 300ms 씩 늦춘 상태에서 요청이 들어온 순서로 판별
order() { jq -r '.body.messages | map(select(.role=="user"))[0].content | if type=="string" then . else map(.text // "") | join("") end | select(startswith("Task:")) | capture("env (?<x>[ABC])").x' "$REQ" | tr -d '\n'; }
export OXY_LLM_MAX_CONCURRENT=1; run sub-par; o1=$(order)
chk "동시 실행 제한 1: 자식이 하나씩 순서대로 ($o1)"    '[[ "$o1" =~ ^(AA|BB|CC)(AA|BB|CC)(AA|BB|CC)$ ]]'
export OXY_LLM_MAX_CONCURRENT=3; run sub-par; o3=$(order); unset OXY_LLM_MAX_CONCURRENT
chk "동시 실행 제한 3: 자식 3개가 함께 시작 ($o3)"      '[[ ${#o3} -eq 6 && $(printf %s "${o3:0:3}" | fold -w1 | sort -u | wc -l) -eq 3 ]]'

# 대화형 경로 (RPC 모드: 작업 패널·상태줄, 완료 시 새 턴, /jobs 로그 보기)
rpc=$(cd "$TMP/work" && timeout 120 "$OXY_NODE" "$(winpath "$OXY_HOME/tests/rpc-jobs.mjs")" "$OXY_PI_CLI" "$(winpath "$TMP/work")" 2>&1 | tail -1)
printf '\n\033[1m[rpc-jobs]\033[0m %s\n' "$rpc"
chk "대화형: 작업 패널·상태줄 표시"            '[[ "$rpc" == *"\"widgetRunning\":true"* && "$rpc" == *"\"statusRunning\":true"* && "$rpc" == *"\"widgetDone\":true"* ]]'
chk "대화형: 작업이 끝나면 새 턴으로 결과 전달"   '[[ "$rpc" == *"\"followUpTurn\":true"* ]]'
chk "대화형: /jobs → 로그 보기"               '[[ "$rpc" == *"\"jobsLogView\":true"* ]]'

run repeat
chk "loop-guard: 같은 호출 3번째 차단"            '[[ "$out" == *"oxy-loop-guard"* && "$out" == *"2 times"* ]]'

printf '\n'
cp "$REQLOG" "$OXY_HOME/.cache/last-e2e-requests.jsonl" 2>/dev/null || true
(( F == 0 )) && log "E2E 통과" || die "E2E 실패 $F 건"
