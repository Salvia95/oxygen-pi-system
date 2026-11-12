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
#    / 브라우저: Chromium(2) / LLM 서버 주소 / 키 / 확인 결과대로 계속("") / 코딩 1 / 범용 1 / ctx 기본 / 계열 기본 ×2
#    / GitLab / PATH·바로가기 전부 / 설치 시작 / 상태 점검 실행 / 종료
#    주의: 구성요소 화면에 "1" 을 넣으면 "1번만 선택"이 되어 나머지가 모두 해제된다
long=$([[ ${#I} -gt 100 ]] && echo 1 || true)
run "신규 설치" "$NODE" 1 1 $long "" 2 "http://127.0.0.1:$PORT" mock-key "" 1 1 "" "" "" gitlab.example.internal "" 1 1 ""
chk "설치 종료코드 0"                     '[[ $RC == 0 ]]'
chk "파일 복사 + 설치 표시 (복사를 마치면 partial 표시 없음)" '[[ -f "$I/.oxy-install" && -x "$I/runtime/node/node.exe" ]] && ! grep -q partial "$I/.oxy-install"'
chk "oxy.env 에 입력값 기록"               'grep -q "^OXY_VLLM_BASE_URL=http://127.0.0.1:$PORT/v1$" "$I/agent/oxy.env" && grep -q "^GITLAB_HOST=gitlab.example.internal$" "$I/agent/oxy.env"'
chk "모델 계열 기록 (id 로 추정한 값)"   'grep -q "^OXY_MODEL_CODER_FAMILY=qwen-coder$" "$I/agent/oxy.env" && grep -q "^OXY_MODEL_GENERAL_FAMILY=qwen-thinking$" "$I/agent/oxy.env" && grep -q qwen-chat-template "$I/agent/models.json"'
chk "models.json 모델 2개"                '[[ $(grep -c "\"id\"" "$I/agent/models.json") == 2 ]]'
chk "PATH / WT 프로필 / 바로가기 (sandbox)"  '[[ -f "$SB/user-path.txt" && -f "$SB/LocalAppData/Microsoft/Windows Terminal/Fragments/oxygen-pi/oxygen-pi.json" && -f "$SB/Desktop/Oxygen Pi.lnk.json" ]]'
chk "SQLcl: 번들에서 설치"                 '[[ -f "$I/runtime/sqlcl/bin/sql" ]]'
chk "선택하지 않은 브라우저는 복사 안 함"       '[[ -f "$I/vendor/browsers/chromium/chrome.exe" && ! -d "$I/vendor/browsers/chrome-win64" ]]'
chk "브라우저 선택 기록 (chromium)"           'grep -q "^OXY_BROWSER=chromium$" "$I/agent/oxy.env"'
chk "skill 자동 활성화 (설치된 도구만)"        '[[ -f "$I/agent/skills/sql-querying/SKILL.md" && -f "$I/agent/skills/web-page-automation/SKILL.md" && ! -d "$I/agent/skill-library/../skills/nonexistent" ]]'
chk "verify 통과 (FAIL 0)"               'grep -q "FAIL 0" "$SB/out.txt"'

# 2) 업데이트: 설치 관리 메뉴 3 업데이트 / 1 업데이트 시작 (덮어쓰기 확인) / 2 상태 점검 건너뛰기 / 종료
#    (번들에 새로 들어온 구성요소가 없으므로 구성요소 화면은 나오지 않는다)
echo "OXY_CUSTOM_KEEP=1" >> "$I/agent/oxy.env"
run "업데이트" "$NODE" 3 1 2 ""
chk "업데이트 후 사용자 설정 유지"            'grep -q "^OXY_CUSTOM_KEEP=1$" "$I/agent/oxy.env"'

# 3) 설정 변경 (설치 관리 메뉴 1 다시 설정): / SQLcl 유지 / 브라우저 '사용 안 함' / URL·키 유지 / 계속 / 코딩 1 / 범용 '사용 안 함' / ctx / GitLab 유지
#    / 등록 1,2 / 적용 / verify 아니요 / 종료
run "설정 변경" "$NODE" 1 1 "$NONE_IDX" "" "" "" 1 2 "" "" "" "1,2" 1 2 ""
chk "브라우저 '사용 안 함' 기록"              'grep -q "^OXY_BROWSER=none$" "$I/agent/oxy.env"'
chk "브라우저 없음 → web-page-automation skill 꺼짐" '[[ ! -d "$I/agent/skills/web-page-automation" && -d "$I/agent/skills/web-page-reading" ]]'
chk "SQLcl 유지"                          '[[ -f "$I/runtime/sqlcl/bin/sql" ]]'
chk "범용 모델 제거 → models.json 1개"      '[[ $(grep -c "\"id\"" "$I/agent/models.json") == 1 ]]'
chk "바로가기만 해제"                       '[[ ! -f "$SB/Desktop/Oxygen Pi.lnk.json" && -f "$SB/user-path.txt" ]]'

# 3-1) 설치된 복사본의 Tweak TUI: SQLite 연결 추가 (usql + dbhub) → 설치 위치 기준 파일 생성
"$I/bin/usql.exe" "sqlite:$(winpath "$SB/t.db")" -c "create table t(a int); insert into t values (5),(6);" >/dev/null 2>&1
# Tweak 허브 (번호는 구성요소 유무와 상관없이 고정. 쓸 수 없는 항목은 비활성으로 남는다):
#   1 LLM 연결 · 2 DB 연결 · 3 GitLab 연결 · 4 브라우저 · 5 확장 기능 · 6 스킬 · 7 실행 제한 · 8 PATH·바로가기 · 9 상태 점검 · 10 종료
#   LLM 연결 하위: 1 서버 주소·API 키 · 2 모델 · 3 요청 설정 · 4 ← 이전
#   DB 연결 하위: 연결 1..n · + 새 연결 추가… · SQLcl · ← 이전   (연결 0개면 1 추가 · 2 SQLcl · 3 이전)
#   실행 제한 하위: 1 명령 출력 최대 길이 … 6 백그라운드 작업 동시 실행 수 · 7 ← 이전
# 3-1 입력: DB 연결 / 1 추가 / 6 SQLite / 이름 / 파일 / 1 읽기 전용 / "" usql+dbhub / 1 연결 테스트 / "" 저장 결과 확인 / 4 ← 이전 / 10 종료
INSTALLER="$I/installer/tweak.mjs" run "Tweak: DB 연결 추가" "$I/runtime/node/node.exe" 2 1 6 tdb "$(winpath "$SB/t.db")" 1 "" 1 "" 4 10
chk "Tweak 종료코드 0"                         '[[ $RC == 0 ]]'
chk "연결 테스트 성공"                            'grep -q "tdb 접속  성공" "$SB/out.txt"'
chk "usql.yaml / dbhub.toml / mcp.json 생성"     '[[ -f "$I/agent/usql.yaml" && -f "$I/agent/dbhub.toml" && -f "$I/agent/mcp.json" ]]'
chk "mcp.json 이 설치 위치의 dbhub 를 가리킴"     'grep -q "$(winpath "$I" | sed "s|\\|/|g")/vendor/dbhub" "$I/agent/mcp.json"'
chk "설치된 usql 래퍼로 이름 붙은 연결 조회"        '[[ "$(bash "$I/wrappers/usql" tdb -w -q --csv -c "select count(*) as n from t" | tail -1)" == 2 ]]'

# 3-2) Tweak: 항목 하나씩 (순서 무관) — GitLab 연결만 변경 → 실행 제한 값 하나만 변경 → 종료. 나머지 설정은 그대로여야 한다
#      저장하면 Enter 를 기다리지 않고 허브(하위 메뉴)의 메시지 줄에 결과를 보인다
#      입력: 3 GitLab 연결 / 호스트 / 7 실행 제한 / 1 명령 출력 최대 길이 / 9000 / 7 ← 이전 / 10 종료
before_url=$(grep "^OXY_VLLM_BASE_URL=" "$I/agent/oxy.env")
INSTALLER="$I/installer/tweak.mjs" run "Tweak: 항목별 조정" "$I/runtime/node/node.exe" 3 gitlab2.example.internal 7 1 9000 7 10
chk "Tweak 항목별: 종료코드 0"                   '[[ $RC == 0 ]]'
chk "Tweak 항목별: GitLab 호스트만 변경"           'grep -q "^GITLAB_HOST=gitlab2.example.internal$" "$I/agent/oxy.env" && [[ "$(grep "^OXY_VLLM_BASE_URL=" "$I/agent/oxy.env")" == "$before_url" ]]'
chk "Tweak 항목별: 한도 값 하나만 저장"            'grep -q "^OXY_TOOL_OUTPUT_MAX_CHARS=9000$" "$I/agent/oxy.env" && ! grep -q "^OXY_READ_MAX_CHARS=" "$I/agent/oxy.env"'
chk "Tweak 항목별: 단계 흐름 없이 바로 저장"        '! grep -q "설정을 적용하는 중입니다" "$SB/out.txt" && grep -q "GitLab 연결 저장 중입니다" "$SB/out.txt"'

# 3-3) 확장 파라미터를 거부하는 게이트웨이 (사내에서 받은 400 "property 'repetition_penalty' is unsupported")
#      Tweak 의 LLM 연결 · 서버 주소·API 키 가 하나씩 확인해서 거부된 것만 요청에서 제외한다. 그 설정으로 pi 요청이 통과
#      입력: 1 LLM 연결 / 1 서버 주소·API 키 / 주소 / 키 / "" 확인 결과대로 저장 / 1 제한에 맞춘 설정 적용 / 4 ← 이전 / 10 종료
SPORT=$((PORT + 1))
MOCK_TPM=8000 MOCK_STRICT_PARAMS=repetition_penalty "$NODE" "$(winpath "$OXY_HOME/tests/mock-vllm.mjs")" "$SPORT" "$(winpath "$SB/req2.jsonl")" >/dev/null & STRICT_PID=$!
for _ in $(seq 50); do curl -fs "http://127.0.0.1:$SPORT/v1/models" >/dev/null 2>&1 && break; sleep 0.1; done
INSTALLER="$I/installer/tweak.mjs" run "Tweak: 엄격한 게이트웨이로 vLLM 변경" "$I/runtime/node/node.exe" 1 1 "http://127.0.0.1:$SPORT" mock-key "" 1 4 10
chk "게이트웨이 판정: 거부된 repetition_penalty 만 기록"   'grep -q "^OXY_VLLM_DROP_PARAMS=repetition_penalty$" "$I/agent/oxy.env" && grep -q "repetition_penalty: 서버에서 지원하지 않아" "$SB/out.txt"'
chk "사용량 제한 감지 → 맞춤 설정 (재시도 4 · 응답 1000)"  'grep -q "분당 8,000 토큰" "$SB/out.txt" && grep -q "^OXY_PROVIDER_RETRIES=4$" "$I/agent/oxy.env" && grep -q "^OXY_MAX_OUTPUT_TOKENS=1000$" "$I/agent/oxy.env" && grep -q "\"maxTokens\": 1000" "$I/agent/models.json"'
chk "models.json: repetition_penalty 빠지고 top_k 유지"   '! grep -q repetition_penalty "$I/agent/models.json" && grep -q "\"top_k\": 20" "$I/agent/models.json"'
pi_out=$(cd "$SB" && PI_CODING_AGENT_DIR="$(winpath "$I/agent")" OXY_VLLM_API_KEY=mock-key OXY_FLOW=off timeout 120 "$I/runtime/node/node.exe" \
  "$I/vendor/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" --no-session -p "scenario:flow-half" < /dev/null 2>&1 | tail -1)
chk "그 설정으로 pi 요청 통과 (400 없음): $pi_out"        '[[ "$pi_out" == half-full ]]'
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
