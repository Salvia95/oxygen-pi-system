#!/usr/bin/env bash
# 실제 vLLM 없이 하네스 전체 경로를 점검한다:
#   pi → (mock) vLLM → 도구 실행(Git Bash) → oxy extension → 최종 응답
# 실제 agent/ 설정은 건드리지 않고 임시 agent 디렉터리를 사용한다.
#   bash tests/e2e-mock.sh [port]
source "$(dirname "${BASH_SOURCE[0]}")/../scripts/lib.sh"
# shellcheck disable=SC1091
source "$OXY_HOME/env.sh"
# env.sh 가 읽어 온 이 PC 의 사이트 설정(agent/oxy.env)이 mock 환경으로 새지 않게 한다 (임시 oxy.env 만 쓰도록)
while IFS= read -r k; do unset "$k"; done < <(grep -oE '^[A-Z_][A-Z0-9_]*' "$OXY_HOME/agent/oxy.env" 2>/dev/null | grep -vE '^(OXY_HOME|OXY_NODE|OXY_PI_CLI|OXY_SHELL_PATH)$')

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
# configure 가 oxy.env 의 vLLM 값을 llm.json(연결 vllm) · secrets.json(DPAPI)으로 옮겼다. 작업 수준 deep 만 범용 모델 + thinking 으로 바꿔 둔다
jq '(.levels[] | select(.id=="deep")) |= (.model="qwen3.8-27b" | .thinking="high")' "$TMP/agent/llm.json" > "$TMP/llm.json" && mv "$TMP/llm.json" "$TMP/agent/llm.json"
export PI_CODING_AGENT_DIR="$(winpath "$TMP/agent")" OXY_VLLM_API_KEY=mock-key
export OXY_FLOW=off   # oxy-flow 는 아래 전용 구역에서만 켠다

# DB MCP: SQLite 연결(dbhub) + 비밀값 주입 확인용 envcheck 서버 (dbhub 를 반입한 경우만)
HAS_DBHUB=0; [[ -f "$OXY_HOME/vendor/dbhub/node_modules/@bytebase/dbhub/dist/index.js" ]] && HAS_DBHUB=1
if (( HAS_DBHUB )); then
  "$OXY_HOME/bin/usql.exe" "sqlite:$(winpath "$TMP/e2e.db")" -c "create table t(a int); insert into t values (1),(2),(3),(4);" >/dev/null 2>&1
  "$OXY_NODE" "$(winpath "$OXY_HOME/tests/e2e-db-setup.mjs")" "$(winpath "$OXY_HOME")" "$(winpath "$TMP/agent")" "$(winpath "$TMP/e2e.db")" 'pw:한글 "q"$x' >/dev/null
fi

REQLOG="$TMP/requests.jsonl"
# subagent 중지 검사의 손자 프로세스 표식: 실행마다 달라야 다른 E2E · 테스트의 sleep 을 세거나 죽이지 않는다
SLEEP_MARK="${OXY_E2E_SLEEP_MARK:-41.$$${RANDOM}}"
MOCK_SLEEP="$SLEEP_MARK" MOCK_CHILD_DELAY_MS=300 "$OXY_NODE" "$(winpath "$OXY_HOME/tests/mock-vllm.mjs")" "$PORT" "$(winpath "$REQLOG")" >/dev/null & MOCK_PID=$!
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
# 대화 메시지(시스템 프롬프트 제외)를 합친 글. 문구 검사는 이것으로 한다 (AGENTS.md 에 같은 문구가 있으면 오탐하므로)
CONV='[.body.messages[] | select(.role != "system") | .content | tostring] | join(" ")'
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
chk "내장 tools 5종 + oxy-jobs 2종 (+MCP direct)" '[[ $(first "[.body.tools[].function.name | select(startswith(\"mcp__\") | not)] | sort | join(\",\")") == "background,bash,edit,grep,read,subagent,write" ]]'
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
chk "background: 작업 로그 파일 (실행 폴더)"     '[[ -n "$(ls "$TMP/agent/jobs/"run-*/logs/job-1.log 2>/dev/null)" ]]'
chk "background: 비대화형은 상태 파일을 쓰지 않음" '[[ -z "$(ls "$TMP/agent/jobs/"run-*/state.json 2>/dev/null)" ]]'

run bg-guard
chk "background 도 bash-guard 검사 (npm install 차단)" '[[ "$out" == *"oxy-guard/offline-install"* ]]'

run sub-sync
chk "subagent: 별도 컨텍스트 실행 후 결과 반환"     '[[ "$out" == *"(scout: scenario:env check the environment) done"* && "$out" == *"hello-from-Msys"* ]]'
: > "$REQLOG"
out=$(cd "$TMP/work" && timeout 120 "$OXY_NODE" "$OXY_PI_CLI" --no-session -p --model qwen3.8-27b --thinking low "scenario:sub-sync" < /dev/null 2>&1) || true
child() { jq -r 'select((.body.messages | map(select(.role=="user"))[0].content | tostring) | test("Task:")) | "\(.body.model) \(.body.chat_template_kwargs.enable_thinking)"' "$REQLOG" | sort -u | tr '\n' ' '; }
cm=$(child)
chk "subagent: 수준을 정하지 않으면 agent 의 기본 수준(scout=light) 모델 ($cm)" '[[ "$cm" == "qwen3.6-coder-30b null " ]]'
: > "$REQLOG"
out=$(cd "$TMP/work" && timeout 120 "$OXY_NODE" "$OXY_PI_CLI" --no-session -p "scenario:sub-level" < /dev/null 2>&1) || true
cl=$(child)
chk "subagent: level=deep → 그 수준의 모델 · thinking ($cl)" '[[ "$cl" == "qwen3.8-27b true " && "$out" == *"(scout: scenario:env deep check) done"* ]]'
chk "LLM 연결: 키는 DPAPI 로 저장되고 oxy.env 에는 남지 않음" '[[ -f "$TMP/agent/secrets.json" && $(jq -r "has(\"llm/vllm\")" "$TMP/agent/secrets.json") == true && -z "$(grep -E "^OXY_VLLM_API_KEY=" "$TMP/agent/oxy.env")" ]]'
chk "subagent: 자식에는 지정한 도구만 (재귀 방지)"   '[[ $(jq -r "select(.body.messages | map(select(.role==\"user\"))[0].content | tostring | contains(\"Task:\")) | [.body.tools[].function.name] | sort | join(\",\")" "$REQ" | sort -u) == "bash,find,grep,ls,read" ]]'

run sub-async
chk "subagent wait=false: 완료 후 결과 알림"        '[[ "$out" == *"(scout: scenario:env async check) done"* ]]'

# 동시 실행 제한: 자식 요청을 300ms 씩 늦춘 상태에서 요청이 들어온 순서로 판별
order() { jq -r '.body.messages | map(select(.role=="user"))[0].content | if type=="string" then . else map(.text // "") | join("") end | select(startswith("Task:")) | capture("env (?<x>[ABC])").x' "$REQ" | tr -d '\n'; }
# 동시 실행 수는 연결마다 (llm.json 의 maxConcurrent)
conc() { jq --argjson n "$1" '(.connections[] | select(.id=="vllm")).maxConcurrent = $n' "$TMP/agent/llm.json" > "$TMP/llm.json" && mv "$TMP/llm.json" "$TMP/agent/llm.json"; }
conc 1; run sub-par; o1=$(order)
chk "동시 실행 제한 1: 자식이 하나씩 순서대로 ($o1)"    '[[ "$o1" =~ ^(AA|BB|CC)(AA|BB|CC)(AA|BB|CC)$ ]]'
conc 3; run sub-par; o3=$(order); conc 2
chk "동시 실행 제한 3: 자식 3개가 함께 시작 ($o3)"      '[[ ${#o3} -eq 6 && $(printf %s "${o3:0:3}" | fold -w1 | sort -u | wc -l) -eq 3 ]]'

# subagent 를 멈추면 자식 pi 의 bash 도구가 띄운 손자 프로세스(MSYS)도 끝난다 (예전: taskkill /T 로는 sleep 이 남음)
# 이 실행의 표식($SLEEP_MARK)을 인자로 받은 sleep 만 센다 (예전: 시스템 전체의 sleep 41 을 세고 끝나면 모두 죽였다)
sleeps() { powershell.exe -NoProfile -Command "@(Get-CimInstance Win32_Process -Filter \"Name='sleep.exe'\" | Where-Object { (\$_.CommandLine -split '\s+') -contains '$SLEEP_MARK' }).Count" | tr -d '\r'; }
s0=$(sleeps)
run sub-stop
sleep 2; s1=$(sleeps)
chk "subagent 중지: 손자 프로세스까지 끝남 (sleep $SLEEP_MARK: $s0 → $s1)" '[[ "$out" == *"(scout: scenario:env-sleep long) stopped"* && "$s0" == 0 && "$s1" == 0 ]]'
powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='sleep.exe'\" | Where-Object { (\$_.CommandLine -split '\s+') -contains '$SLEEP_MARK' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }" >/dev/null 2>&1 || true

# ---- LLM 연결 여러 개 · 작업 수준 (docs/tui-spec.md §11) ----
# 자식 pi 의 bash 에 부모가 넘긴 키가 남지 않는다 (oxy-llm 이 받자마자 process.env 에서 지운다)
run sub-keys
kt=$(jq -r '[.body.messages[] | select(.role=="tool") | .content | tostring] | join(" ")' "$REQ" | grep -o 'inherit=[^ "\\]*' | sort -u | tr '\n' ' ')
chk "LLM 키: 자식 pi 의 bash 환경에 남지 않음 ($kt)" '[[ "$out" == *"(scout: scenario:env-keys look) done"* && "$kt" == "inherit=none " ]]'
# 두 번째 연결 claude (Anthropic 형식 mock) 를 더하고 deep 수준을 그쪽으로. 키는 DPAPI 로 저장
APORT=$((PORT + 1)); ALOG="$TMP/anthropic.jsonl"; : > "$ALOG"
# mock 은 워크스페이스가 지정되지 않은 조직 키처럼 동작한다 (anthropic-workspace-id 헤더가 없으면 400)
MOCK_ANTHROPIC_WORKSPACE=wrkspc_e2e1 MOCK_ANTHROPIC_KEY='sk-ant-$e2e!' "$OXY_NODE" "$(winpath "$OXY_HOME/tests/mock-anthropic.mjs")" "$APORT" "$(winpath "$ALOG")" >/dev/null & AMOCK_PID=$!
trap 'kill "${MOCK_PID:-}" "${AMOCK_PID:-}" 2>/dev/null || true; rm -rf "$TMP"' EXIT
"$OXY_NODE" --input-type=module -e "const s = await import(process.argv[1]); s.setSecret(process.argv[2], 'llm/claude', 'sk-ant-\$e2e!');" \
  "$(winpath "$OXY_HOME/installer/secrets.mjs" | sed 's#^#file:///#')" "$(winpath "$TMP/agent")"
jq --arg u "http://127.0.0.1:$APORT" '.connections += [{id: "claude", kind: "anthropic", name: "Claude", baseUrl: $u, maxConcurrent: 2, workspaceId: "wrkspc_e2e1",
  request: {retries: 0}, models: [{id: "claude-haiku-5-5", contextWindow: 131072, maxOutput: 16384}]}]
  | (.levels[] | select(.id=="deep")) |= (.connection="claude" | .model="claude-haiku-5-5" | .thinking="high")' "$TMP/agent/llm.json" > "$TMP/llm.json" && mv "$TMP/llm.json" "$TMP/agent/llm.json"
run sub-claude
ar=$(jq -c '{keyMatches, model, thinking, effort, max_tokens, workspace, firstUser}' "$ALOG" | head -1)
chk "여러 연결: 본 대화는 vLLM 기본 모델 그대로"      '[[ $(first .body.model) == qwen3.6-coder-30b ]]'
chk "여러 연결: deep 수준만 Claude 연결로 ($ar)"     '[[ $(wc -l < "$ALOG") -eq 1 && "$ar" == *"\"model\":\"claude-haiku-5-5\""* && "$ar" == *"claude-task review"* ]]'
chk "여러 연결: 부모가 넘긴 DPAPI 키로 인증 · effort high · 128K/16K 덮어쓰기" '[[ "$ar" == *"\"keyMatches\":true"* && "$ar" == *"\"thinking\":\"adaptive\",\"effort\":\"high\",\"max_tokens\":16384"* ]]'
chk "여러 연결: 조직 키의 워크스페이스 헤더 (anthropic-workspace-id)" '[[ "$ar" == *"\"workspace\":\"wrkspc_e2e1\""* ]]'
nc=$("$OXY_NODE" "$(winpath "$OXY_HOME/scripts/llm-check.mjs")" "$(winpath "$OXY_HOME")" "$(winpath "$TMP/agent")" --net 2>&1 | tr '	' ' ')
jq '(.connections[] | select(.id=="claude")) |= del(.workspaceId)' "$TMP/agent/llm.json" > "$TMP/llm-nows.json"
mkdir -p "$TMP/agent-nows"; cp "$TMP/llm-nows.json" "$TMP/agent-nows/llm.json"; cp "$TMP/agent/secrets.json" "$TMP/agent-nows/"
nw=$("$OXY_NODE" "$(winpath "$OXY_HOME/scripts/llm-check.mjs")" "$(winpath "$OXY_HOME")" "$(winpath "$TMP/agent-nows")" --net 2>&1 | tr '	' ' ')
chk "상태 점검: 워크스페이스 PASS · 없으면 FAIL 과 해결 방법" '[[ "$nc" == *"PASS 워크스페이스 wrkspc_e2e1"* && "$nw" == *"FAIL 이 API 키는 워크스페이스가 지정되지 않았습니다 → tweak.cmd의 LLM 연결에서 이 연결을 편집해 워크스페이스를 선택하세요"* ]]'
chk "여러 연결: light 수준은 vLLM 에서 실행"          '[[ "$out" == *"MOCK-ANTHROPIC Task: claude-task review"* && "$out" == *"(scout: scenario:env vllm-task) done"* && "$out" == *"hello-from-Msys"* ]]'

# 대화형 경로 (RPC 모드: 작업 패널·상태줄, 완료 시 새 턴, /jobs 로그 보기)
rpc=$(cd "$TMP/work" && timeout 120 "$OXY_NODE" "$(winpath "$OXY_HOME/tests/rpc-jobs.mjs")" "$OXY_PI_CLI" "$(winpath "$TMP/work")" 2>&1 | tail -1) || true
printf '\n\033[1m[rpc-jobs]\033[0m %s\n' "$rpc"
chk "대화형: 작업 패널·상태줄 표시"            '[[ "$rpc" == *"\"widgetRunning\":true"* && "$rpc" == *"\"statusRunning\":true"* && "$rpc" == *"\"widgetDone\":true"* ]]'
chk "대화형: 작업이 끝나면 새 턴으로 결과 전달"   '[[ "$rpc" == *"\"followUpTurn\":true"* ]]'
chk "대화형: /jobs → 로그 보기"               '[[ "$rpc" == *"\"jobsLogView\":true"* ]]'
chk "모니터: 상태 파일에 작업 목록·로그 경로"    '[[ "$rpc" == *"\"stateFile\":true"* && "$rpc" == *"\"stateRunning\":true"* ]]'
chk "모니터: 중지 요청 → 작업 중지·알림·모델에 전달" '[[ "$rpc" == *"\"monitorStop\":true"* && "$rpc" == *"\"monitorStopNotice\":true"* && "$rpc" == *"\"stopReported\":true"* ]]'
chk "모니터: 이미 끝난 작업 중지 요청은 실패로 기록" '[[ "$rpc" == *"\"monitorStopRejected\":true"* ]]'
chk "실시간 활동: 도구 실행 중 live.json 에 상태 · 도구 요약" '[[ "$rpc" == *"\"liveTool\":true"* ]]'
chk "실시간 활동: 끝나면 대기 · 최근 이벤트(요청 · 도구 · 작업)" '[[ "$rpc" == *"\"liveIdle\":true"* ]]'

# oxy-flow: 별도 git 작업 폴더 (위 시나리오들은 OXY_FLOW=off 로 실행해 서로 영향을 주지 않게 한다)
FW="$TMP/flowwork"; mkdir -p "$FW"; (cd "$FW" && git init -q)
# 작업 기록은 세션 단위다: FSID 가 같으면 같은 세션을 다시 연다 (--session-id), 없으면 저장하지 않는 새 세션
frun() {
  : > "$REQLOG"
  local s=(--no-session); [[ -n ${FSID:-} ]] && s=(--session-id "$FSID")
  out=$(cd "${FWD:-$FW}" && OXY_FLOW=on timeout 120 "$OXY_NODE" "$OXY_PI_CLI" "${s[@]}" -p "$1" < /dev/null 2>&1) || true
  REQ="$REQLOG"
  printf '\n\033[1m[%s]\033[0m %s\n' "${1%% *}" "$(head -c 160 <<< "$out" | tr '\n' ' ')"
}
FSID=flowa frun "scenario:flow-commit add the f file"
chk "flow: 도구 flow_note · flow_plan · flow_show 등록" '[[ $(first "[.body.tools[].function.name] | map(select(startswith(\"flow_\"))) | sort | join(\",\")") == "flow_note,flow_plan,flow_show" ]]'
chk "flow: 커밋 → 노드 n1 + 결정 + 커밋 파일"       '[[ $(jq -r ".nodes[0] | \"\(.id) \(.title) \(.decisions[0].text) \(.files|join(\",\"))\"" "$FW/.oxy/flow/flow.json") == "n1 feat: add f Store sessions in SQLite f.txt" ]]'
chk "flow: 커밋 결과에 기록 안내"                 '[[ $(tail -1 "$REQ" | jq -r "[.body.messages[] | select(.role==\"tool\") | .content | tostring] | join(\" \")") == *"Recorded step n1"* ]]'
chk "flow: .oxy 는 사용자 git 에 안 잡힘"          '[[ -z "$(cd "$FW" && git status --porcelain)" ]]'
FSID=flowb frun "scenario:env another task"
chk "flow: 새 세션은 빈 기록으로 시작 (이전 작업은 보관, 첫 요청에 넣지 않음)" '[[ $(first "$CONV") != *"Store sessions in SQLite"* && $(jq -r ".goal + \" \" + (.nodes|length|tostring)" "$FW/.oxy/flow/flow.json") == "scenario:env another task 0" && $(cat "$FW"/.oxy/flow/archive/*.json | grep -c "scenario:flow-commit add the f file") -ge 1 ]]'
FSID=flowa frun "scenario:flow-plan add g with a plan"
chk "flow: 이전 세션을 다시 열면 그 작업 기록을 되살려 첫 요청에 넣음" '[[ $(first "$CONV") == *"[oxy-flow] Task state"*"scenario:flow-commit add the f file"*"Store sessions in SQLite"* && $(cat "$FW"/.oxy/flow/archive/*.json | grep -c "scenario:env another task") -ge 1 ]]'
chk "flow 계획: 항목·할 일 저장, 커밋이 진행 중인 할 일에 연결" '[[ $(jq -r "[.plan[0].id, .plan[0].status, .plan[0].children[0].nodes[0], .plan[0].children[1].status, .plan[1].status] | join(\" \")" "$FW/.oxy/flow/flow.json") == "p1 done n2 done todo" ]]'
chk "flow 계획: 도구 결과에 계획과 다음 할 일"     '[[ $(tail -1 "$REQ" | jq -r "[.body.messages[] | select(.role==\"tool\") | .content | tostring] | join(\" \")") == *"Updated p1 [done]."*"p2 [todo] Report"*"Next: p2 Report"* ]]'
chk "flow 계획: 커밋 결과에 연결된 할 일과 done 안내" '[[ $(tail -1 "$REQ" | jq -r "[.body.messages[] | select(.role==\"tool\") | .content | tostring] | join(\" \")") == *"Linked to plan item p1.1 "*"write g"*"If this commit finishes it, call flow_plan(action="* ]]'
chk "flow 계획: FLOW.md 에 계획"                 '[[ $(cat "$FW/.oxy/flow/FLOW.md") == *"## 계획"*"✓ p1 Add g file"*"· p2 Report"* ]]'
# 계획이 있는 세션을 다시 열면 첫 요청에 계획과 다음 할 일이 들어간다. 작업 상태는 세션마다 한 번만 넣으므로(flowa 는 이미 넣었다)
# 별도 작업 폴더에서 새 세션 flowc 에 계획을 만들고, 다른 세션 flowd 로 바꿨다가 flowc 를 다시 연다
FW2="$TMP/flowwork2"; mkdir -p "$FW2"; (cd "$FW2" && git init -q)
FWD="$FW2" FSID=flowc frun "scenario:flow-plan add g with a plan"
FWD="$FW2" FSID=flowd frun "scenario:env switch to another task"
FWD="$FW2" FSID=flowc frun "scenario:env plan check"
chk "flow 계획: 다시 연 세션의 첫 요청에 계획과 다음 할 일" '[[ $(first "$CONV") == *"Next: p2 Report"*"Plan (update it with flow_plan):"*"- p1 [done] Add g file"*"(2/2 sub-tasks done)"*"- p2 [todo] Report"* ]]'
cp "$TMP/agent/settings.json" "$TMP/settings.bak"
jq '.compaction.keepRecentTokens = 50' "$TMP/settings.bak" > "$TMP/agent/settings.json"   # 작은 대화로도 compaction 이 일어나게
FSID=flowa frun "scenario:flow-big refactor the parser"
chk "flow: 작업 도중 compaction → LLM 요약 요청 없음" '[[ "$out" == *after-compaction* && $(grep -c "context summarization" "$REQ") -eq 0 ]]'
chk "flow: compaction 요약 = 작업 상태 + 최근 요청"  '[[ $(tail -1 "$REQ" | jq -r "$CONV") == *"[oxy-flow] Task state"*"Latest user request: scenario:flow-big"* ]]'
cp "$TMP/settings.bak" "$TMP/agent/settings.json"
: > "$REQLOG"
rf=$(cd "$FW" && OXY_FLOW=on timeout 120 "$OXY_NODE" "$(winpath "$OXY_HOME/tests/rpc-flow.mjs")" "$OXY_PI_CLI" "$(winpath "$FW")" "$(winpath "$REQLOG")" 2>&1 | tail -1) || true
printf '\n\033[1m[rpc-flow]\033[0m %s\n' "$rf"
# -p(1회 실행)에서는 세션 넘기기를 하지 않고 그 메시지를 처리한다 (예전: 실행이 먼저 끝나 /oxy-rollover 가 끝난 세션을 건드려 오류, 메시지 유실)
: > "$REQLOG"
(cd "$FW" && OXY_FLOW=on timeout 120 "$OXY_NODE" "$OXY_PI_CLI" -p "scenario:flow-half fill" < /dev/null > /dev/null 2>&1) || true
pc=$(cd "$FW" && OXY_FLOW=on timeout 120 "$OXY_NODE" "$OXY_PI_CLI" -p -c "after half" < /dev/null 2>&1) || true
printf '\n\033[1m[-p -c 50%% 이상]\033[0m %s\n' "$(head -c 160 <<< "$pc" | tr '\n' ' ')"
chk "flow: -p 에서는 세션 넘기기 없이 그 메시지를 처리 (오류 없음)" '[[ "$pc" == *"MOCK-DONE"* && "$pc" != *"stale"* && "$pc" != *"Error"* && $(nreq) -ge 2 ]]'
chk "flow: 컨텍스트가 찬 뒤 새 메시지 → 새 세션 + 작업 상태" '[[ "$rf" == *"\"newSession\":true"* && "$rf" == *"\"stateInjected\":true"* ]]'

run repeat
chk "loop-guard: 같은 호출 3번째 차단"            '[[ "$out" == *"oxy-loop-guard"* && "$out" == *"2 times"* ]]'

printf '\n'
cp "$REQLOG" "$OXY_HOME/.cache/last-e2e-requests.jsonl" 2>/dev/null || true
(( F == 0 )) && log "E2E 통과" || die "E2E 실패 $F 건"
