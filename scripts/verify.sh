#!/usr/bin/env bash
# [폐쇄망 PC 자가진단] 네트워크 없이 하네스 구성요소를 모두 점검한다. FAIL 이 있으면 종료코드 1.
#   bash scripts/verify.sh            # 전체 점검
#   bash scripts/verify.sh --no-llm   # LLM 서버 연결 점검 생략
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

# 선택 구성요소(SQLcl, Chrome for Testing)는 설치하지 않을 수 있으므로 없으면 WARN
HAS_SQLCL=0; [[ -f "$OXY_HOME/runtime/sqlcl/bin/sql" ]] && HAS_SQLCL=1
need() { if (( HAS_SQLCL )); then fail "$@"; else wrn "$* (SQLcl 미설치라 영향 없음)"; fi; }
if command -v java >/dev/null; then
  jv=$(java -version 2>&1 | head -n1)
  major=$(sed -nE 's/.*version "([0-9]+).*/\1/p' <<< "$jv")
  (( ${major:-0} >= 17 )) && pass "java: $jv" || need "java 17 이상 필요 (SQLcl): $jv"
  # env.sh 가 java 에게 java.home 을 물어 정한다 (Maven · Gradle · SQLcl 이 JAVA_HOME 을 믿는다)
  if [[ -n "${JAVA_HOME:-}" && -x "$(cygpath -u "$JAVA_HOME")/bin/java.exe" ]]; then pass "JAVA_HOME: $JAVA_HOME"
  else wrn "JAVA_HOME 이 비었거나 java 가 없는 폴더 (${JAVA_HOME:-없음}) → Maven 등이 실패할 수 있음. agent/oxy.env 에 JAVA_HOME 을 적거나 .cache/java-home 을 지우고 다시 여세요"; fi
else need "java 없음 (SQLcl 실행 불가)"; fi

section "2. 번들 도구"
# 필수 (manifest role=required): 없으면 FAIL
tool "fd"            fd --version
tool "rg"            rg --version
tool "jq"            jq --version
# 선택: 반입하지 않았으면 WARN (해당 skill 사용 불가)
opt_tool() { # <label> <bin/파일> <skill> <cmd...>
  local label="$1" file="$2" skill="$3"; shift 3
  if [[ -f "$OXY_HOME/$file" ]]; then tool "$label" "$@"
  else wrn "$label: 선택 구성요소 미포함 ($skill 사용 불가 · 인터넷 PC 에서 fetch 로 받아 다시 번들링)"; fi
}
opt_tool "just"          bin/just.exe          project-task-running just --version
opt_tool "hurl"          bin/hurl.exe          http-api-testing     hurl --version
opt_tool "glab"          bin/glab.exe          gitlab-workflow      glab --version
opt_tool "gh"            bin/gh.exe            github-workflow      gh --version
opt_tool "agent-browser" bin/agent-browser.exe web-page-automation  agent-browser --version
opt_tool "obscura"       bin/obscura.exe       web-page-reading     obscura --version
opt_tool "usql"          bin/usql.exe          sql-querying         usql --version
opt_tool "psmux"         bin/psmux.exe         terminal-session-control psmux -V
opt_tool "ast-grep"      bin/ast-grep.exe      structural-code-search ast-grep --version
# 멀티플렉서 (oxy.env 의 OXY_MUX): 실행할 수 없으면 oxy 가 지금 창에서 실행하므로 WARN
if [[ -n "${OXY_MUX:-}" && "$OXY_MUX" != none ]]; then
  adapter="$OXY_HOME/scripts/mux/$OXY_MUX.sh"
  if [[ ! "$OXY_MUX" =~ ^[a-z0-9-]+$ || ! -f "$adapter" ]]; then wrn "멀티플렉서: 알 수 없는 값 OXY_MUX=$OXY_MUX (oxy 는 지금 창에서 실행)"
  elif ( source "$adapter"; oxy_mux_ready ); then pass "멀티플렉서: $OXY_MUX (oxy 를 폴더별 세션에서 실행)"
  else wrn "멀티플렉서: $OXY_MUX 가 설치되지 않음 (oxy 는 지금 창에서 실행 · tweak.cmd 의 PATH·바로가기에서 변경)"; fi
fi
if [[ -f "$OXY_HOME/vendor/dbhub/node_modules/@bytebase/dbhub/dist/index.js" ]]; then
  # mcp.json 이 없거나 dbhub 항목이 없으면 0 (set -e/pipefail 에서 멈추지 않도록 || true)
  n=$( { jq -r '.mcpServers.dbhub.description // empty' "$OXY_HOME/agent/mcp.json" 2>/dev/null | grep -o '=' | wc -l; } || true)
  n=${n//[^0-9]/}; n=${n:-0}
  if (( n > 0 )); then pass "dbhub: pi MCP 에 DB 연결 ${n}개 등록됨"
  else pass "dbhub: 설치됨 (DB 연결은 tweak.cmd → DB 연결 에서 등록)"; fi
else wrn "dbhub: 선택 구성요소 미포함 (DB MCP 커넥터 사용 불가)"; fi
HAS_AB=0; [[ -f "$OXY_HOME/bin/agent-browser.exe" ]] && HAS_AB=1
if (( HAS_SQLCL )); then tool "sqlcl" sql -V
else wrn "sqlcl: 선택 구성요소 미설치 (oracle-db-querying 사용 불가, 설치 TUI '설정 변경'에서 추가)"; fi
for t in fd rg; do
  [[ -f "$OXY_HOME/agent/bin/$t.exe" ]] && pass "agent/bin/$t.exe (pi 자동 다운로드 방지)" \
    || fail "agent/bin/$t.exe 없음 → pi 가 GitHub 다운로드를 시도함"
done

section "3. 브라우저 (OXY_BROWSER=${OXY_BROWSER:-auto})"
if (( ! HAS_AB )); then wrn "agent-browser 미포함 → 브라우저 점검 생략"
elif [[ "${OXY_BROWSER:-}" == none ]]; then wrn "브라우저 자동화 사용 안 함 (web-page-automation 사용 불가)"
elif [[ "${OXY_BROWSER:-}" == obscura ]]; then
  if [[ -f "$OXY_HOME/bin/obscura.exe" ]]; then pass "브라우저 엔진: obscura (CDP 포트 ${OXY_OBSCURA_PORT:-9233}, agent-browser 래퍼가 필요할 때 기동)"
  else fail "브라우저 엔진 obscura 를 골랐지만 bin/obscura.exe 가 없음"; fi
elif [[ -z "${AGENT_BROWSER_EXECUTABLE_PATH:-}" ]]; then wrn "사용할 브라우저 없음 (설치 TUI '설정 변경'에서 선택)"
elif [[ -f "$(cygpath -u "$AGENT_BROWSER_EXECUTABLE_PATH")" ]]; then
  pass "브라우저: $AGENT_BROWSER_EXECUTABLE_PATH"
  if out=$(agent-browser doctor --offline --quick 2>&1); then pass "agent-browser doctor --offline --quick"
  else wrn "agent-browser doctor 경고: $(tail -n3 <<< "$out" | tr '\n' ' ')"; fi
else fail "브라우저 실행 파일 없음: $AGENT_BROWSER_EXECUTABLE_PATH"; fi
if (( HAS_AB )); then
  if agent-browser skills list 2>/dev/null | grep -q '^ *core '; then pass "agent-browser 버전 일치 가이드 (skills get core)"
  else fail "agent-browser 가이드 없음: $AGENT_BROWSER_SKILLS_DIR"; fi
fi

section "4. 백그라운드 작업 · subagent (oxy-jobs)"
if [[ -f "$OXY_HOME/agent/extensions/oxy-jobs/index.ts" ]]; then
  agents=$(find "$OXY_HOME/agent/agents" -name '*.md' 2>/dev/null | sed 's|.*/||; s|\.md$||' | sort | tr '\n' ' ')
  [[ -n "$agents" ]] && pass "subagent 정의: $agents(동시 실행 ${OXY_LLM_MAX_CONCURRENT:-2})" || wrn "agent/agents 에 정의 없음 → subagent 도구 비활성"
  # 이전 세션에서 남은 작업 프로세스 (pi 를 강제 종료하면 남을 수 있음)
  # node.exe 만 센다 (이 검사를 실행하는 PowerShell 의 명령줄에도 같은 문자열이 들어가므로)
  left=$(powershell -NoProfile -Command "@(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -like '*--mode json -p --no-session*' }).Count" 2>/dev/null | tr -d '\r ')
  if [[ "${left:-0}" =~ ^[0-9]+$ ]] && (( left > 0 )); then wrn "실행 중인 subagent 프로세스 ${left}개 (pi 가 실행 중이 아니면 작업 관리자에서 정리)"
  else pass "남은 subagent 프로세스 없음"; fi
  [[ "${OXY_VLLM_METRICS:-off}" =~ ^(on|1|true)$ ]] && pass "vLLM 혼잡 감지 사용 (/metrics)" || pass "vLLM 혼잡 감지 꺼짐 (OXY_VLLM_METRICS=on 으로 켬)"
else wrn "oxy-jobs extension 없음"; fi

section "5. skill / Git Bash 보정"
skills=$(find "$OXY_HOME/agent/skills" -name SKILL.md 2>/dev/null | sed 's|/SKILL.md$||; s|.*/||' | sort | tr '\n' ' ')
[[ -n "$skills" ]] && pass "pi skill: $skills" || fail "agent/skills 에 SKILL.md 없음"
if jq -n '1' | od -c | grep -q '\\r'; then fail "jq 출력에 CR 포함 (wrappers/jq 확인)"; else pass "jq 출력 LF (wrappers/jq)"; fi
rgout=$(rg -l OXY_HOME "$OXY_HOME/scripts" 2>&1)
if [[ -z "$rgout" ]]; then fail "rg 실행 결과 없음"
elif [[ "$rgout" == *'\'* ]]; then fail   # 주의: Git Bash 에서 *\\* 패턴은 역슬래시와 매칭되지 않음 "rg 가 역슬래시 경로 출력 (RIPGREP_CONFIG_PATH 확인)"
else pass "rg 경로 / 구분 (config/ripgreprc)"; fi

section "6. pi 설정"
for f in settings.json models.json; do
  p="$OXY_HOME/agent/$f"
  if [[ -f "$p" ]] && "$OXY_NODE" -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$(winpath "$p")" 2>/dev/null; then
    pass "agent/$f"
  else fail "agent/$f 없음 또는 JSON 오류 → just configure"; fi
done
# 터미널 글꼴 D2Coding (docs/tui-spec.md §12): 판정은 설치 TUI 와 같은 함수 (system.mjs 의 fontRegistered)
font=$("$OXY_NODE" --input-type=module -e 'const { pathToFileURL } = await import("node:url"); const { createSystem } = await import(pathToFileURL(process.argv[1]).href); process.stdout.write(createSystem({ root: process.argv[2] }).fontRegistered() ?? "")' \
  "$(winpath "$OXY_HOME/installer/system.mjs")" "$(winpath "$OXY_HOME")" 2>/dev/null || true)
case "$font" in
  system) pass "D2Coding 글꼴 (시스템 글꼴)" ;;
  user)   pass "D2Coding 글꼴 (사용자 글꼴)" ;;
  *)      wrn "D2Coding 글꼴 없음 → 터미널은 지금 글꼴로 동작합니다. install.cmd 의 업데이트로 설치하세요." ;;
esac
# LLM 연결 (agent/llm.json · 키는 secrets.json DPAPI): 설정 · 작업 수준 · compaction 여유분 · 키. 출력은 "<결과>\t<메시지>"
llm_lines() { "$OXY_NODE" "$(winpath "$OXY_HOME/scripts/llm-check.mjs")" "$(winpath "$OXY_HOME")" "$(winpath "$OXY_HOME/agent")" "$1" 2>&1 | tr -d '\r'; }
llm_show() { # 한 줄 표시. MAIN 줄은 기본 모델을 기억한다
  case "$1" in
    PASS) pass "$2" ;; WARN) wrn "$2" ;; FAIL) fail "$2" ;; SECTION) section "$2" ;;
    MAIN) main_provider="$2"; main_model="$3" ;;
    *) [[ -n "$1" ]] && wrn "llm-check: $1 $2" ;;
  esac
}
main_provider="" main_model=""
while IFS=$'\t' read -r lv a b; do llm_show "$lv" "$a" "$b"; done < <(llm_lines --local)
[[ -f "$OXY_HOME/agent/extensions/oxy-flow/index.ts" ]] && enabled_flow=${OXY_FLOW:-on} && \
  pass "작업 기록 oxy-flow: ${enabled_flow} (compaction ${OXY_FLOW_COMPACT:-file} · 세션 넘기기 ${OXY_FLOW_ROLLOVER:-on} ${OXY_FLOW_ROLLOVER_PCT:-50}%)"
[[ "${PI_OFFLINE:-}" == 1 && "${PI_SKIP_VERSION_CHECK:-}" == 1 && "${PI_TELEMETRY:-}" == 0 ]] \
  && pass "PI_OFFLINE / PI_SKIP_VERSION_CHECK / PI_TELEMETRY=0" || fail "pi 오프라인 환경변수 미설정"
# pi 가 기본 모델을 인식하는지 (oxy-llm extension 이 llm.json 의 연결을 provider oxy-<연결 id> 로 등록한다)
if [[ -n "$main_provider" && -f "$OXY_PI_CLI" ]]; then
  if out=$("$OXY_NODE" "$OXY_PI_CLI" --offline --list-models "$main_model" 2>&1) \
     && awk -v p="$main_provider" -v m="$main_model" '$1 == p && $2 == m { f = 1 } END { exit !f }' <<< "$out"; then
    pass "pi가 기본 모델을 인식: ${main_provider}/${main_model}"
  else fail "pi --list-models 에서 ${main_provider}/${main_model} 미확인: $(head -n3 <<< "$out" | tr '\n' ' ')"; fi
fi

# 연결마다 서버 점검 (모델 목록 · tool call · vLLM 샘플링 파라미터)
if [[ $CHECK_LLM == 1 ]]; then
  while IFS=$'\t' read -r lv a b; do llm_show "$lv" "$a" "$b"; done < <(llm_lines --net)
fi


printf '\n\033[1m결과: PASS %d / WARN %d / FAIL %d\033[0m\n' "$P" "$W" "$F"
(( F == 0 ))
