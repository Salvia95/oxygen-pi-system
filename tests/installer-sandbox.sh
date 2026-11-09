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

# 1) 신규 설치: 점검 계속 / 기본 위치 / (긴 경로 경고 시 예) / SQLcl: 번들에 포함된 것 설치(1) / 브라우저: Chromium(2)
#    / vLLM / 키 / 계속 / 코딩 1 / 범용 1 / ctx 기본 / GitLab / 등록 전부 / 설치 / verify 예 / 종료
long=$([[ ${#I} -gt 100 ]] && echo 1 || true)
run "신규 설치" "$NODE" 1 1 $long 1 2 "http://127.0.0.1:$PORT" mock-key "" 1 1 "" gitlab.example.internal "" 1 1 ""
chk "설치 종료코드 0"                     '[[ $RC == 0 ]]'
chk "파일 복사 + 설치 표시"                 '[[ -f "$I/.oxy-install" && -x "$I/runtime/node/node.exe" ]]'
chk "oxy.env 에 입력값 기록"               'grep -q "^OXY_VLLM_BASE_URL=http://127.0.0.1:$PORT/v1$" "$I/agent/oxy.env" && grep -q "^GITLAB_HOST=gitlab.example.internal$" "$I/agent/oxy.env"'
chk "models.json 모델 2개"                '[[ $(grep -c "\"id\"" "$I/agent/models.json") == 2 ]]'
chk "PATH / WT 프로필 / 바로가기 (sandbox)"  '[[ -f "$SB/user-path.txt" && -f "$SB/LocalAppData/Microsoft/Windows Terminal/Fragments/oxygen-pi/oxygen-pi.json" && -f "$SB/Desktop/Oxygen Pi.lnk.json" ]]'
chk "SQLcl: 번들에서 설치"                 '[[ -f "$I/runtime/sqlcl/bin/sql" ]]'
chk "고르지 않은 브라우저는 복사 안 함"       '[[ -f "$I/vendor/browsers/chromium/chrome.exe" && ! -d "$I/vendor/browsers/chrome-win64" ]]'
chk "브라우저 선택 기록 (chromium)"           'grep -q "^OXY_BROWSER=chromium$" "$I/agent/oxy.env"'
chk "skill 자동 활성화 (설치된 도구만)"        '[[ -f "$I/agent/skills/sql-querying/SKILL.md" && -f "$I/agent/skills/web-page-automation/SKILL.md" && ! -d "$I/agent/skill-library/../skills/nonexistent" ]]'
chk "verify 통과 (FAIL 0)"               'grep -q "FAIL 0" "$SB/out.txt"'

# 2) 업데이트: 메뉴 3 / verify 아니요 / 종료
echo "OXY_CUSTOM_KEEP=1" >> "$I/agent/oxy.env"
run "업데이트" "$NODE" 3 2 ""
chk "업데이트 후 사용자 설정 유지"            'grep -q "^OXY_CUSTOM_KEEP=1$" "$I/agent/oxy.env"'

# 3) 설정 변경: 메뉴 1 / SQLcl 유지 / 브라우저 '사용 안 함' / URL·키 유지 / 계속 / 코딩 1 / 범용 '사용 안 함' / ctx / GitLab 유지
#    / 등록 1,2 / 적용 / verify 아니요 / 종료
run "설정 변경" "$NODE" 1 1 "$NONE_IDX" "" "" "" 1 2 "" "" "1,2" 1 2 ""
chk "브라우저 '사용 안 함' 기록"              'grep -q "^OXY_BROWSER=none$" "$I/agent/oxy.env"'
chk "브라우저 없음 → web-page-automation skill 꺼짐" '[[ ! -d "$I/agent/skills/web-page-automation" && -d "$I/agent/skills/web-page-reading" ]]'
chk "SQLcl 유지"                          '[[ -f "$I/runtime/sqlcl/bin/sql" ]]'
chk "범용 모델 제거 → models.json 1개"      '[[ $(grep -c "\"id\"" "$I/agent/models.json") == 1 ]]'
chk "바로가기만 해제"                       '[[ ! -f "$SB/Desktop/Oxygen Pi.lnk.json" && -f "$SB/user-path.txt" ]]'

# 3-1) 설치된 복사본의 Tweak TUI: SQLite 연결 추가 (usql + dbhub) → 설치 위치 기준 파일 생성
"$I/bin/usql.exe" "sqlite:$(winpath "$SB/t.db")" -c "create table t(a int); insert into t values (5),(6);" >/dev/null 2>&1
INSTALLER="$I/installer/tweak.mjs" run "Tweak: DB 연결 추가" "$I/runtime/node/node.exe" 2 1 6 tdb "$(winpath "$SB/t.db")" 1 "" 1 "" 3 5
chk "Tweak 종료코드 0"                         '[[ $RC == 0 ]]'
chk "연결 시험 성공"                            'grep -q "tdb 접속  성공" "$SB/out.txt"'
chk "usql.yaml / dbhub.toml / mcp.json 생성"     '[[ -f "$I/agent/usql.yaml" && -f "$I/agent/dbhub.toml" && -f "$I/agent/mcp.json" ]]'
chk "mcp.json 이 설치 위치의 dbhub 를 가리킴"     'grep -q "$(winpath "$I" | sed "s|\\|/|g")/vendor/dbhub" "$I/agent/mcp.json"'
chk "설치된 usql 래퍼로 이름 붙은 연결 조회"        '[[ "$(bash "$I/wrappers/usql" tdb -w -q --csv -c "select count(*) as n from t" | tail -1)" == 2 ]]'

# 4) 설치된 복사본으로 제거 (실행 중인 node.exe 가 설치 폴더 안 → 종료 후 삭제 예약)
INSTALLER="$I/installer/install.mjs" run "자기 제거" "$I/runtime/node/node.exe" 3 1 ""
chk "제거 종료코드 0"                      '[[ $RC == 0 ]]'
chk "등록 해제 + 설치 기록 삭제 + 설정 백업"  '[[ ! -f "$SB/user-path.txt" && ! -d "$SB/LocalAppData/Microsoft/Windows Terminal/Fragments/oxygen-pi" && ! -f "$SB/AppData/oxygen-pi/install.json" && -f "$SB/AppData/oxygen-pi/oxy.env.bak" ]]'
for _ in $(seq 60); do [[ -d "$I" ]] || break; sleep 1; done
chk "설치 폴더 삭제 (예약 삭제 완료)"         '[[ ! -d "$I" ]]'

(( F == 0 )) && log "설치 TUI 테스트 통과" || die "설치 TUI 테스트 실패 $F 건"
