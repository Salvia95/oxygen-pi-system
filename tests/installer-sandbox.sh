#!/usr/bin/env bash
# 설치 TUI 회귀 테스트 (줄 입력 모드 + sandbox). 레지스트리·바탕화면·AppData 는 건드리지 않는다.
# 흐름: 신규 설치(mock vLLM) → 업데이트 → 설정 변경 → 설치된 복사본으로 자기 제거
# 번들(약 1GB)을 두 번 복사하므로 몇 분 걸린다.
source "$(dirname "${BASH_SOURCE[0]}")/../scripts/lib.sh"
NODE="$OXY_HOME/runtime/node/node.exe"
PORT="${1:-18098}"
SB="$(mktemp -d)"; trap 'kill "${MOCK_PID:-}" 2>/dev/null || true; rm -rf "$SB"' EXIT
I="$SB/LocalAppData/Programs/oxygen-pi"
"$NODE" "$(winpath "$OXY_HOME/tests/mock-vllm.mjs")" "$PORT" "$(winpath "$SB/req.jsonl")" >/dev/null & MOCK_PID=$!
for _ in $(seq 50); do curl -fs "http://127.0.0.1:$PORT/v1/models" >/dev/null 2>&1 && break; sleep 0.1; done

F=0
# LLM 연결은 agent/llm.json (jq.exe 는 CRLF 로 출력하므로 \r 제거), 키는 agent/secrets.json 의 llm/<연결 id> (DPAPI)
lj() { jq -r "$1" "$I/agent/llm.json" 2>/dev/null | tr -d '\r'; }
sj() { jq -r "\"$1\"" "$I/agent/settings.json" 2>/dev/null | tr -d '\r'; }
has_key() { [[ "$(jq -r --arg k "llm/$1" 'has($k)' "$I/agent/secrets.json" 2>/dev/null | tr -d '\r')" == true ]]; }
chk() { if eval "$2"; then printf '  \033[32mPASS\033[0m %s\n' "$1"; else printf '  \033[31mFAIL\033[0m %s\n' "$1"; F=$((F+1)); fi; }
run() { # <설명> <installer node> <답...>
  local label="$1" node="$2"; shift 2
  log "$label"
  printf '%s\n' "$@" | timeout 900 "$node" "$(winpath "${INSTALLER:-$OXY_HOME/installer/install.mjs}")" --sandbox "$(winpath "$SB")" > "$SB/out.txt" 2>&1
  RC=$?
}

# 브라우저 선택지 수는 PC 마다 다름 (Edge/Chrome 설치 여부) → 마지막 항목('사용 안 함') 번호를 계산
NONE_IDX=$("$NODE" --input-type=module -e "import('$(winpath "$OXY_HOME/installer/components.mjs" | sed 's|^|file:///|')').then(m=>console.log(m.browserChoices(process.argv[1]).length))" "$(winpath "$OXY_HOME")")
[[ -f "$OXY_HOME/runtime/sqlcl/bin/sql" && -f "$OXY_HOME/vendor/browsers/chromium/chrome.exe" ]]   || die "이 테스트는 SQLcl·Chromium 이 받아진 상태가 필요 → bash scripts/fetch-bundle.sh --all --accept-license"

# 1) 신규 설치: 점검 계속 / 기본 위치 / (긴 경로 경고 시 1 = 이 경로에 설치) / 구성요소: 표시된 대로("" = 반입된 것 전부, SQLcl 포함)
#    / 브라우저: Chromium(2)
#    / LLM: 연결 종류 기본(사내 vLLM) / 연결 이름 site / 서버 주소 / 키 / (모델 목록 · 확장 파라미터 테스트) 결과대로 계속("")
#    / 모델: 1,2 둘 다 / 모델마다 컨텍스트 길이 · 응답 최대 길이 기본 ×2 / 계열 기본 ×2 / 기본 모델 기본(첫 모델)
#      (Coder 계열은 thinking 수준이 off 하나라서 thinking 화면은 나오지 않는다)
#    / GitLab / PATH·바로가기: 등록 전부 · 셸 기본(Git Bash) · 멀티플렉서 2 psmux / 설치 시작 / 상태 점검 실행 / 종료
#    주의: 구성요소 화면에 "1" 을 넣으면 "1번만 선택"이 되어 나머지가 모두 해제된다
long=$([[ ${#I} -gt 100 ]] && echo 1 || true)
run "신규 설치" "$NODE" 1 1 $long "" 2 "" site "http://127.0.0.1:$PORT" mock-key "" "1,2" "" "" "" "" "" "" "" gitlab.example.internal "" "" 2 1 1 ""
chk "설치 종료코드 0"                     '[[ $RC == 0 ]]'
chk "파일 복사 + 설치 표시 (복사를 마치면 partial 표시 없음)" '[[ -f "$I/.oxy-install" && -x "$I/runtime/node/node.exe" ]] && ! grep -q partial "$I/.oxy-install"'
chk "llm.json: 연결 site (사내 vLLM, 주소에 /v1)"   '[[ "$(lj ".connections | map(\"\(.id) \(.kind) \(.baseUrl) \(.maxConcurrent)\") | join(\",\")")" == "site vllm http://127.0.0.1:$PORT/v1 2" ]]'
chk "llm.json: 모델 2개 · 계열 (id 로 추정) · 길이"   '[[ "$(lj ".connections[0].models | map(\"\(.id)/\(.family)/\(.contextWindow)/\(.maxOutput)\") | join(\" \")")" == "qwen3.6-coder-30b/qwen-coder/131072/16384 qwen3.8-27b/qwen-thinking/131072/16384" ]]'
chk "llm.json: 기본 모델 · 작업 수준 세 개 모두 기본 모델"   '[[ "$(lj "[.main] + .levels | map(\"\(.connection)/\(.model)/\(.thinking)\") | unique | join(\",\")")" == "site/qwen3.6-coder-30b/off" && $(lj ".levels | length") == 3 ]]'
chk "API 키: secrets.json 의 llm/site (DPAPI) · oxy.env · llm.json 에 없음"   'has_key site && ! grep -q mock-key "$I/agent/oxy.env" "$I/agent/llm.json" "$I/agent/secrets.json"'
chk "oxy.env 에 LLM 값 없음 (OXY_VLLM_* · OXY_MODEL_*) · GitLab 기록"   '! grep -qE "^(OXY_VLLM_|OXY_MODEL_|OXY_CONTEXT_WINDOW|OXY_DEFAULT_MODEL)" "$I/agent/oxy.env" && grep -q "^GITLAB_HOST=gitlab.example.internal$" "$I/agent/oxy.env"'
chk "settings.json: defaultProvider oxy-site · 기본 모델"   '[[ "$(sj "\(.defaultProvider) \(.defaultModel) \(.defaultThinkingLevel) \(.enabledModels | join(\",\"))")" == "oxy-site qwen3.6-coder-30b off oxy-site/**" ]]'
chk "확인 요약: LLM 연결 · 모델 · 작업 수준 행"   'grep -q "LLM 연결 *사내 vLLM · site · API 키 저장됨" "$SB/out.txt" && grep -q "모델 *qwen3.6-coder-30b 외 1개 · 128K · thinking off" "$SB/out.txt" && grep -q "작업 수준 *세 수준 모두 기본 모델" "$SB/out.txt"'
chk "PATH / WT 프로필 / 바로가기 (sandbox)"  '[[ -f "$SB/user-path.txt" && -f "$SB/LocalAppData/Microsoft/Windows Terminal/Fragments/oxygen-pi/oxygen-pi.json" && -f "$SB/Desktop/Oxygen Pi.lnk.json" ]]'
chk "SQLcl: 번들에서 설치"                 '[[ -f "$I/runtime/sqlcl/bin/sql" ]]'
chk "선택하지 않은 브라우저는 복사 안 함"       '[[ -f "$I/vendor/browsers/chromium/chrome.exe" && ! -d "$I/vendor/browsers/chrome-win64" ]]'
chk "브라우저 선택 기록 (chromium)"           'grep -q "^OXY_BROWSER=chromium$" "$I/agent/oxy.env"'
chk "skill 자동 활성화 (설치된 도구만)"        '[[ -f "$I/agent/skills/sql-querying/SKILL.md" && -f "$I/agent/skills/web-page-automation/SKILL.md" && ! -d "$I/agent/skill-library/../skills/nonexistent" ]]'
chk "verify 통과 (FAIL 0)"               'grep -q "FAIL 0" "$SB/out.txt"'
WTF="$SB/LocalAppData/Microsoft/Windows Terminal/Fragments/oxygen-pi/oxygen-pi.json"
chk "터미널 셸 · 멀티플렉서 기록 (git-bash · psmux) + oxy.cmd 용 OXY_GIT_BASH"  'grep -q "^OXY_TERMINAL_SHELL=git-bash$" "$I/agent/oxy.env" && grep -q "^OXY_MUX=psmux$" "$I/agent/oxy.env" && grep -q "^OXY_GIT_BASH=.*bash.exe" "$I/agent/oxy.env"'
chk "WT 프로필: Git Bash 로 env.sh"           'grep -q "bash.exe.*env.sh" "$WTF"'
chk "확인 요약 · 완료 화면에 멀티플렉서"         'grep -q "터미널.*Git Bash · 멀티플렉서 psmux" "$SB/out.txt" && grep -q "oxy --no-mux" "$SB/out.txt"'
# oxy 런처: OXY_MUX=psmux 여도 비대화형(파이프)·--no-mux 는 세션 없이 바로 실행
ver=$(cd "$SB" && env -u TMUX bash "$I/oxy" --version </dev/null 2>&1 | tail -1)
chk "oxy: 비대화형이면 psmux 세션 없이 바로 실행 ($ver)"   '[[ "$ver" =~ ^[0-9]+\.[0-9]+ ]]'
ver2=$(cd "$SB" && env -u TMUX bash "$I/oxy" --no-mux --version </dev/null 2>&1 | tail -1)
chk "oxy --no-mux: 바로 실행 ($ver2)"            '[[ "$ver2" == "$ver" ]]'

# 2) 업데이트: 설치 관리 메뉴 3 업데이트 / 1 업데이트 시작 (덮어쓰기 확인) / 2 상태 점검 건너뛰기 / 종료
#    (번들에 새로 들어온 구성요소가 없으므로 구성요소 화면은 나오지 않는다)
echo "OXY_CUSTOM_KEEP=1" >> "$I/agent/oxy.env"
run "업데이트" "$NODE" 3 1 2 ""
chk "업데이트 후 사용자 설정 유지"            'grep -q "^OXY_CUSTOM_KEEP=1$" "$I/agent/oxy.env" && grep -q "^OXY_MUX=psmux$" "$I/agent/oxy.env" && grep -q "^OXY_TERMINAL_SHELL=git-bash$" "$I/agent/oxy.env"'
chk "업데이트 후 LLM 연결 · 키 유지"           '[[ $(lj ".connections[0].models | length") == 2 ]] && has_key site'

# 3) 설정 변경 (설치 관리 메뉴 1 다시 설정): / SQLcl 유지 / 브라우저 '사용 안 함'
#    / LLM: 종류 · 이름 · 주소 그대로 / 저장된 키 유지 / 결과대로 계속 / 모델 1 하나만 / 컨텍스트 · 응답 최대 길이 · 계열 그대로 / GitLab 유지
#    / 등록 1,2 · 셸 2 명령 프롬프트 · 멀티플렉서 1 사용 안 함 / 적용 / verify 아니요 / 종료
run "설정 변경" "$NODE" 1 1 "$NONE_IDX" "" "" "" "" "" 1 "" "" "" "" "1,2" 2 1 1 2 ""
chk "브라우저 '사용 안 함' 기록"              'grep -q "^OXY_BROWSER=none$" "$I/agent/oxy.env"'
chk "브라우저 없음 → web-page-automation skill 꺼짐" '[[ ! -d "$I/agent/skills/web-page-automation" && -d "$I/agent/skills/web-page-reading" ]]'
chk "SQLcl 유지"                          '[[ -f "$I/runtime/sqlcl/bin/sql" ]]'
chk "모델 하나만 선택 → llm.json 모델 1개 · 키 유지"   '[[ "$(lj ".connections[0].models | map(.id) | join(\",\")")" == qwen3.6-coder-30b ]] && has_key site'
chk "다시 설정: 저장된 키 유지 화면 · 요약에 (변경됨)"    'grep -q "저장된 API 키를 유지할까요?" "$SB/out.txt" && grep -q "qwen3.6-coder-30b · 128K · thinking off (변경됨)" "$SB/out.txt"'
chk "바로가기만 해제"                       '[[ ! -f "$SB/Desktop/Oxygen Pi.lnk.json" && -f "$SB/user-path.txt" ]]'
chk "셸 변경: WT 프로필이 cmd.exe /k 로, OXY_MUX=none"  'grep -q "cmd.exe.*/k.*OXY_HOME=" "$WTF" && ! grep -q "env.sh" "$WTF" && grep -q "^OXY_TERMINAL_SHELL=cmd$" "$I/agent/oxy.env" && grep -q "^OXY_MUX=none$" "$I/agent/oxy.env"'

# 3-1) 설치된 복사본의 Tweak TUI: SQLite 연결 추가 (usql + dbhub) → 설치 위치 기준 파일 생성
"$I/bin/usql.exe" "sqlite:$(winpath "$SB/t.db")" -c "create table t(a int); insert into t values (5),(6);" >/dev/null 2>&1
# Tweak 허브 (번호는 구성요소 유무와 상관없이 고정. 쓸 수 없는 항목은 비활성으로 남는다):
#   1 LLM 연결 · 2 DB 연결 · 3 GitLab 연결 · 4 브라우저 · 5 확장 기능 · 6 스킬 · 7 실행 제한 · 8 PATH·바로가기 · 9 상태 점검 · 10 종료
#   LLM 연결 하위: 연결 1..n · + 새 연결 추가… · 기본 모델 · 작업 수준 · ← 이전   (연결 하나면 1 site · 2 추가 · 3 기본 모델 · 4 작업 수준 · 5 이전)
#     연결 하나를 선택하면: 1 편집… · 2 연결 테스트 · 3 삭제… · 4 ← 이전
#   DB 연결 하위: 연결 1..n · + 새 연결 추가… · SQLcl · ← 이전   (연결 0개면 1 추가 · 2 SQLcl · 3 이전)
#   실행 제한 하위: 1 명령 출력 최대 길이 … 5 백그라운드 작업 동시 실행 수 · 6 ← 이전
# 3-1 입력: DB 연결 / 1 추가 / 6 SQLite / 이름 / 파일 / 1 읽기 전용 / "" usql+dbhub / 1 연결 테스트 / "" 저장 결과 확인 / 4 ← 이전 / 10 종료
INSTALLER="$I/installer/tweak.mjs" run "Tweak: DB 연결 추가" "$I/runtime/node/node.exe" 2 1 6 tdb "$(winpath "$SB/t.db")" 1 "" 1 "" 4 10
chk "Tweak 종료코드 0"                         '[[ $RC == 0 ]]'
chk "연결 테스트 성공"                            'grep -q "tdb 접속  성공" "$SB/out.txt"'
chk "usql.yaml / dbhub.toml / mcp.json 생성"     '[[ -f "$I/agent/usql.yaml" && -f "$I/agent/dbhub.toml" && -f "$I/agent/mcp.json" ]]'
chk "mcp.json 이 설치 위치의 dbhub 를 가리킴"     'grep -q "$(winpath "$I" | sed "s|\\|/|g")/vendor/dbhub" "$I/agent/mcp.json"'
chk "설치된 usql 래퍼로 이름 붙은 연결 조회"        '[[ "$(bash "$I/wrappers/usql" tdb -w -q --csv -c "select count(*) as n from t" | tail -1)" == 2 ]]'

# 3-2) Tweak: 항목 하나씩 (순서 무관) — GitLab 연결만 변경 → 실행 제한 값 하나만 변경 → 종료. 나머지 설정은 그대로여야 한다
#      저장하면 Enter 를 기다리지 않고 허브(하위 메뉴)의 메시지 줄에 결과를 보인다
#      입력: 3 GitLab 연결 / 호스트 / 7 실행 제한 / 1 명령 출력 최대 길이 / 9000 / 6 ← 이전 / 10 종료
before_llm=$(cat "$I/agent/llm.json")
INSTALLER="$I/installer/tweak.mjs" run "Tweak: 항목별 조정" "$I/runtime/node/node.exe" 3 gitlab2.example.internal 7 1 9000 6 10
chk "Tweak 항목별: 종료코드 0"                   '[[ $RC == 0 ]]'
chk "Tweak 항목별: GitLab 호스트만 변경"           'grep -q "^GITLAB_HOST=gitlab2.example.internal$" "$I/agent/oxy.env" && [[ "$(cat "$I/agent/llm.json")" == "$before_llm" ]]'
chk "Tweak 항목별: 한도 값 하나만 저장"            'grep -q "^OXY_TOOL_OUTPUT_MAX_CHARS=9000$" "$I/agent/oxy.env" && ! grep -q "^OXY_READ_MAX_CHARS=" "$I/agent/oxy.env"'
chk "Tweak 항목별: 단계 흐름 없이 바로 저장"        '! grep -q "설정을 적용하는 중입니다" "$SB/out.txt" && grep -q "GitLab 연결 저장 중입니다" "$SB/out.txt"'

# 3-2-1) Tweak: PATH·바로가기 하위 메뉴 (1 등록 항목 · 2 터미널 셸 · 3 멀티플렉서 · 4 ← 이전)
#      입력: 8 PATH·바로가기 / 3 멀티플렉서 / 2 psmux / 2 터미널 셸 / 3 PowerShell / 4 ← 이전 / 10 종료
INSTALLER="$I/installer/tweak.mjs" run "Tweak: 터미널 셸 · 멀티플렉서" "$I/runtime/node/node.exe" 8 3 2 2 3 4 10
chk "Tweak 셸·멀티플렉서: 종료코드 0"            '[[ $RC == 0 ]]'
chk "Tweak 셸·멀티플렉서: 값 저장 + 결과 줄"       'grep -q "^OXY_MUX=psmux$" "$I/agent/oxy.env" && grep -q "^OXY_TERMINAL_SHELL=powershell$" "$I/agent/oxy.env" && grep -q "멀티플렉서 설정을 저장했습니다" "$SB/out.txt"'
chk "Tweak 셸: WT 프로필을 PowerShell 로 다시 만듦"  'grep -qE "powershell.exe|pwsh.exe" "$WTF" && grep -q "NoExit" "$WTF"'

# 3-3) 확장 파라미터를 거부하는 게이트웨이 (사내에서 받은 400 "property 'repetition_penalty' is unsupported")
#      Tweak 의 LLM 연결 · site · 편집… 이 하나씩 테스트해서 거부된 것만 요청에서 제외한다. 그 설정으로 pi 요청이 통과
#      입력: 1 LLM 연결 / 1 site / 1 편집… / 주소 / 저장된 키 유지("") / 결과대로 계속("") / 모델 1,2
#            / 컨텍스트 · 응답 최대 길이 그대로 ×2 / 계열 그대로 ×2 / 재시도 그대로 / 제외 파라미터 그대로 / 동시 요청 수 3 (저장) / 5 ← 이전 / 10 종료
SPORT=$((PORT + 1))
MOCK_TPM=8000 MOCK_STRICT_PARAMS=repetition_penalty "$NODE" "$(winpath "$OXY_HOME/tests/mock-vllm.mjs")" "$SPORT" "$(winpath "$SB/req2.jsonl")" >/dev/null & STRICT_PID=$!
for _ in $(seq 50); do curl -fs "http://127.0.0.1:$SPORT/v1/models" >/dev/null 2>&1 && break; sleep 0.1; done
INSTALLER="$I/installer/tweak.mjs" run "Tweak: LLM 연결 편집 (엄격한 게이트웨이)" "$I/runtime/node/node.exe" 1 1 1 "http://127.0.0.1:$SPORT" "" "" "1,2" "" "" "" "" "" "" "" "" 3 5 10
chk "Tweak LLM 편집: 종료코드 0"                     '[[ $RC == 0 ]]'
chk "게이트웨이 판정: 거부된 repetition_penalty 만 제외"   '[[ "$(lj ".connections[0].request.dropParams | join(\",\")")" == repetition_penalty ]] && grep -q "repetition_penalty: 서버에서 지원하지 않아" "$SB/out.txt"'
chk "편집 결과: 주소 · 모델 2개 · 동시 요청 수 3 · 키 유지 · 결과 줄"   '[[ "$(lj ".connections[0] | \"\(.baseUrl) \(.models | length) \(.maxConcurrent)\"")" == "http://127.0.0.1:$SPORT/v1 2 3" ]] && has_key site && grep -q "LLM 연결 설정을 저장했습니다. pi를 다시 시작하면 적용됩니다." "$SB/out.txt"'
pi_out=$(cd "$SB" && PI_CODING_AGENT_DIR="$(winpath "$I/agent")" OXY_FLOW=off timeout 120 "$I/runtime/node/node.exe" \
  "$I/vendor/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" --no-session -p "scenario:flow-half" < /dev/null 2>&1 | tail -1)
chk "그 설정으로 pi 요청 통과 (400 없음, 키는 secrets.json): $pi_out"        '[[ "$pi_out" == half-full ]]'
chk "pi 요청: repetition_penalty 빠지고 top_k 유지"     'tail -1 "$SB/req2.jsonl" | grep -q "\"top_k\":20" && ! tail -1 "$SB/req2.jsonl" | grep -q repetition_penalty'

# 3-3-1) 새 연결 추가: OpenAI 호환 서비스 (분당 토큰 한도 헤더 → 사용량 제한 맞춤 설정)
#      입력: 1 LLM 연결 / 2 + 새 연결 추가… / 2 OpenAI 호환 서비스 / 이름 기본(openai) / 주소 / 키 / 1 제한에 맞춘 설정 적용
#            / 모델 기본(첫 모델) / 컨텍스트 · 응답 최대 길이 기본 / 계열 기본 (저장) / 6 ← 이전 / 10 종료
INSTALLER="$I/installer/tweak.mjs" run "Tweak: 새 LLM 연결 추가" "$I/runtime/node/node.exe" 1 2 2 "" "http://127.0.0.1:$SPORT" test-key 1 "" "" "" "" 6 10
chk "새 연결: 종료코드 0 · 분당 토큰 한도 감지"         '[[ $RC == 0 ]] && grep -q "분당 8,000 토큰" "$SB/out.txt"'
chk "새 연결: 재시도 4 · 동시 요청 1 · 응답 최대 1000 · 계열 generic"   '[[ "$(lj ".connections[1] | \"\(.id) \(.kind) \(.request.retries) \(.maxConcurrent) \(.models[0].maxOutput) \(.models[0].family)\"")" == "openai openai 4 1 1000 generic" ]]'
chk "새 연결: 키 llm/openai · settings 에 모델 · 재시도"   'has_key openai && [[ "$(sj "\(.enabledModels | join(\",\")) \(.retry.provider.maxRetries)")" == "oxy-site/**,oxy-openai/** 4" ]]'

# 3-3-2) 작업 수준 deep: 모델 → thinking → 이름 → 설명 (화면마다 바로 저장)
#      수준 목록: 1 light · 2 normal · 3 deep · 4 + 수준 추가… · 5 ← 이전. 모델 목록: 1 site/qwen3.6-coder-30b · 2 site/qwen3.8-27b · 3 openai/… · 4 이 수준 삭제…
#      입력: 1 LLM 연결 / 5 작업 수준 (연결이 둘이라 5) / 3 deep / 2 qwen3.8-27b / 2 high / 이름 그대로 / 설명 그대로 / 5 ← 이전 / 6 ← 이전 / 10 종료
INSTALLER="$I/installer/tweak.mjs" run "Tweak: 작업 수준" "$I/runtime/node/node.exe" 1 5 3 2 2 "" "" 5 6 10
chk "작업 수준 deep → site/qwen3.8-27b · thinking high"   '[[ "$(lj ".levels[] | select(.id==\"deep\") | \"\(.connection)/\(.model)/\(.thinking)/\(.label)\"")" == "site/qwen3.8-27b/high/깊은 작업" ]]'

# 3-3-3) 기본 모델을 openai 로 → 쓰고 있는 연결은 삭제할 수 없다 (이유와 할 일) → 기본 모델을 site 로 되돌리고 openai 삭제
#      입력: 1 LLM 연결 / 4 기본 모델 / 3 openai 모델 / 1 site / 3 삭제…(막힘) / 4 ← 이전 / 2 openai / 3 삭제…(막힘) / 4 ← 이전
#            / 4 기본 모델 / 1 site coder / 2 openai / 3 삭제… / 1 openai 연결 삭제 / 5 ← 이전 / 10 종료
INSTALLER="$I/installer/tweak.mjs" run "Tweak: 기본 모델 · 연결 삭제" "$I/runtime/node/node.exe" 1 4 3 1 3 4 2 3 4 4 1 2 3 1 5 10
chk "삭제 막힘: 작업 수준이 쓰는 연결 · 기본 모델이 쓰는 연결"   'grep -q "선택할 수 없습니다: 3번 삭제… (작업 수준 3개가 이 연결을 사용합니다.)" "$SB/out.txt" && grep -q "선택할 수 없습니다: 3번 삭제… (기본 모델이 이 연결을 사용합니다.)" "$SB/out.txt"'
chk "openai 삭제: 연결 · 키 · settings 에서 빠짐, 기본 모델 site"   '[[ "$(lj ".connections | map(.id) | join(\",\")")" == site ]] && ! has_key openai && [[ "$(sj "\(.defaultProvider) \(.defaultModel) \(.enabledModels | join(\",\"))")" == "oxy-site qwen3.6-coder-30b oxy-site/**" ]]'
kill "$STRICT_PID" 2>/dev/null || true

# 3-4) Tweak: 스킬 하나 끄기 (줄 입력 문법 -N = 표시된 상태에서 N 번만 끄기)
#      스킬 목록: 1 find-code · 2 json-querying · 3 project-task-running · 4 http-api-testing · 5 terminal-session-control · …
#      입력: 6 스킬 / -5 terminal-session-control 끄기 / 10 종료
INSTALLER="$I/installer/tweak.mjs" run "Tweak: 스킬 하나 끄기" "$I/runtime/node/node.exe" 6 -5 10
chk "스킬: 종료코드 0"                        '[[ $RC == 0 ]]'
chk "스킬: 끈 것만 OXY_SKILLS_OFF 에 기록"      'grep -q "^OXY_SKILLS_OFF=terminal-session-control$" "$I/agent/oxy.env"'
chk "스킬: 끈 스킬만 agent/skills 에서 빠짐"  '[[ ! -d "$I/agent/skills/terminal-session-control" && -d "$I/agent/skills/find-code" && -d "$I/agent/skills/sql-querying" ]]'
bash "$I/scripts/configure.sh" > "$SB/configure.txt" 2>&1; CRC=$?
chk "configure.sh 를 다시 돌려도 꺼진 채 남음"       '[[ $CRC == 0 && ! -d "$I/agent/skills/terminal-session-control" && -d "$I/agent/skills/find-code" ]]'

# 4) 설치된 복사본으로 제거 (실행 중인 node.exe 가 설치 폴더 안 → 종료 후 삭제 예약)
#    설치 관리 메뉴는 항상 5개: 1 다시 설정 · 2 상태 점검 · 3 업데이트(여기서는 같은 폴더라 비활성) · 4 제거 · 5 종료
#    입력: 4 제거 / 1 설치 폴더 삭제하고 등록 해제 (초기값은 2 제거 취소) / 폴더 이름 확인 입력 / 종료
INSTALLER="$I/installer/install.mjs" run "자기 제거" "$I/runtime/node/node.exe" 4 1 oxygen-pi ""
chk "제거 종료코드 0"                      '[[ $RC == 0 ]]'
chk "등록 해제 + 설치 기록 삭제 + 설정 백업"  '[[ ! -f "$SB/user-path.txt" && ! -d "$SB/LocalAppData/Microsoft/Windows Terminal/Fragments/oxygen-pi" && ! -f "$SB/AppData/oxygen-pi/install.json" && -f "$SB/AppData/oxygen-pi/oxy.env.bak" ]]'
for _ in $(seq 60); do [[ -d "$I" ]] || break; sleep 1; done
chk "설치 폴더 삭제 (예약 삭제 완료)"         '[[ ! -d "$I" ]]'

(( F == 0 )) && log "설치 TUI 테스트 통과" || die "설치 TUI 테스트 실패 $F 건"
