#!/usr/bin/env bash
# 도구 확인 (docs/upgrade-check-spec.md §3 C3): 받아 둔 도구를 skill · 래퍼가 쓰는 방식으로 네트워크 없이 실행해 본다.
#   bash tests/upgrade-check/tools.sh [이름 …]     # 이름 = manifest/tools.lock.tsv 의 이름. 없으면 받아 둔 것 전부
# - 옵션 검사: skill 본문의 하위 명령 · 옵션(tool-usage.mjs 가 뽑는다)이 새 버전의 `--help` 에 있는지
# - 실행 검사: 임시 폴더의 fixture · 로컬 HTTP 서버(127.0.0.1)로 한두 번 실행
# 받지 않은 도구는 SKIP (실패로 세지 않는다). 결과 줄: PASS · FAIL · SKIP, 마지막 줄 "도구 확인 통과" / "도구 확인 실패 (N)"
# 공유 자원: 포트 18120 (OXY_TOOLS_PORT 로 바꿈), psmux -L oxytest-tools-<pid>, agent-browser 세션 oxytest-<pid>
source "$(dirname "${BASH_SOURCE[0]}")/../../scripts/lib.sh"
set +e +o pipefail
# shellcheck disable=SC1091
source "$OXY_HOME/env.sh"
export GH_NO_UPDATE_NOTIFIER=1 GH_PROMPT_DISABLED=1 GLAB_CHECK_UPDATE=false GLAB_SEND_TELEMETRY=false NO_COLOR=1 CLICOLOR=0

ALL="node fd rg jq just hurl psmux glab gh ast-grep agent-browser obscura chromium chrome usql sqlcl"
NAMES="${*:-$ALL}"
PORT="${OXY_TOOLS_PORT:-18120}"
F=0
pass() { printf '  PASS %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1"; F=$((F + 1)); }
skip() { printf '  SKIP %s\n' "$1"; }
want() { [[ " $NAMES " == *" $1 "* ]]; }
for n in $NAMES; do [[ " $ALL dbhub d2coding oxy-tui pi " == *" $n "* ]] || die "모르는 이름: $n (도구: $ALL)"; done

TMP="$(mktemp -d)"
SOCK="oxytest-tools-$$"; SESSION="oxytest-$$"
cleanup() {
  [[ -n "${AB_USED:-}" ]] && timeout 20 agent-browser --session "$SESSION" close >/dev/null 2>&1
  [[ -n "${PSMUX_USED:-}" ]] && timeout 10 psmux -L "$SOCK" kill-server >/dev/null 2>&1
  kill "${SERVER_PID:-}" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

# ---- fixture ----
FX="$TMP/fx"; mkdir -p "$FX/src"
printf 'export function greet(name: string) {\n  console.log("hello", name);\n}\n' > "$FX/src/sample.ts"
printf '# Notes\n\nneedle-oxygen\n' > "$FX/notes.md"
printf 'hello:\n    @echo just-ok\n' > "$FX/justfile"
printf '<!doctype html><html><head><title>Oxygen Fixture</title></head><body><h1 id="t">Hello Oxygen</h1><p id="result">fixture-ok</p></body></html>\n' > "$FX/page.html"
printf '{"name":"oxygen","items":[1,2,3]}\n' > "$FX/data.json"

needs_server() { for n in hurl agent-browser obscura chromium chrome; do want "$n" && return 0; done; return 1; }
if needs_server; then
  "$OXY_NODE" -e '
    const http = require("http"), fs = require("fs"), path = require("path");
    const [dir, port] = process.argv.slice(1);
    const type = { ".html": "text/html; charset=utf-8", ".json": "application/json" };
    http.createServer((q, r) => {
      const f = path.join(dir, path.basename(decodeURIComponent(q.url.split("?")[0])));
      if (!fs.existsSync(f)) { r.writeHead(404); return r.end("not found"); }
      r.writeHead(200, { "content-type": type[path.extname(f)] ?? "text/plain" }); r.end(fs.readFileSync(f));
    }).listen(Number(port), "127.0.0.1");' "$(winpath "$FX")" "$PORT" & SERVER_PID=$!
  for _ in $(seq 50); do curl -fs "http://127.0.0.1:$PORT/data.json" >/dev/null 2>&1 && break; sleep 0.1; done
fi
URL="http://127.0.0.1:$PORT"

# ---- 옵션 검사: skill 본문의 하위 명령 · 옵션이 --help 에 있는가 ----
# 칸 구분을 TAB 에서 | 로: bash 의 read 는 TAB 이 이어지면(빈 하위 명령) 한 칸으로 합친다
USAGE="$("$OXY_NODE" "$(winpath "$OXY_HOME/tests/upgrade-check/tool-usage.mjs")" | tr -d '\r' | tr '\t' '|')"
flags_ok() { # <도구> <실행 파일>
  local tool="$1" exe="$2" missing=() n=0 root
  root="$(timeout 30 "$exe" --help 2>&1)"   # 전역 옵션(agent-browser --session 등)은 최상위 도움말에만 있다
  while IFS='|' read -r t sub flags; do
    [[ "$t" == "$tool" ]] || continue
    local help
    # shellcheck disable=SC2086
    help="$(timeout 30 "$exe" $sub --help 2>&1)"
    for f in $flags; do
      n=$((n + 1))
      local re="(^|[^A-Za-z0-9-])${f}([^A-Za-z0-9-]|$)"
      grep -qE -- "$re" <<< "$help" || grep -qE -- "$re" <<< "$root" || missing+=("${sub:+$sub }$f")
    done
  done <<< "$USAGE"
  if (( ${#missing[@]} )); then fail "$tool: skill 이 쓰는 옵션이 --help 에 없음: ${missing[*]}"
  else pass "$tool: skill 이 쓰는 옵션 ${n}개가 --help 에 있음"; fi
}

has() { [[ -x "$OXY_HOME/$1" ]]; }
out_has() { # <설명> <기대 문자열> <명령…>
  local label="$1" want_s="$2"; shift 2
  local out; out="$(timeout 60 "$@" 2>&1 | tr -d '\r')"
  if [[ "$out" == *"$want_s"* ]]; then pass "$label"; else fail "$label — 기대: $want_s / 출력: $(head -c 300 <<< "$out" | tr '\n' ' ')"; fi
}

log "도구 확인 ($(wc -w <<< "$NAMES")개)"

if want node; then
  v="$(lock_get node version)"
  out_has "node: 번들 Node 가 lock 의 버전 (v$v)" "v$v" "$OXY_NODE" --version
  out_has "node: 번들 pi 실행 (--version)" "$(lock_get pi version)" "$OXY_NODE" "$OXY_PI_CLI" --version
fi

if want fd; then
  if has bin/fd.exe; then flags_ok fd "$OXY_HOME/bin/fd.exe"; out_has "fd: 확장자로 찾기" "notes.md" fd -e md . "$FX"
  else skip "fd: 받지 않음"; fi
fi
if want rg; then
  if has bin/rg.exe; then flags_ok rg "$OXY_HOME/bin/rg.exe"; out_has "rg: 줄 번호와 함께 찾기" "3:needle-oxygen" rg -n "needle-oxygen" "$FX"
  else skip "rg: 받지 않음"; fi
fi
if want jq; then
  if has bin/jq.exe; then flags_ok jq "$OXY_HOME/bin/jq.exe"; out_has "jq: --arg · -r 필터" "oxygen 3" jq -r --arg n oxygen '"\($n) \(.items | length)"' "$FX/data.json"
  else skip "jq: 받지 않음"; fi
fi
if want just; then
  if has bin/just.exe; then flags_ok just "$OXY_HOME/bin/just.exe"; out_has "just: 작업 목록 · 실행" "just-ok" just --justfile "$FX/justfile" --working-directory "$FX" hello
  else skip "just: 받지 않음"; fi
fi
if want hurl; then
  if has bin/hurl.exe; then
    flags_ok hurl "$OXY_HOME/bin/hurl.exe"
    printf 'GET {{base}}/data.json\nHTTP 200\n[Asserts]\njsonpath "$.name" == "oxygen"\njsonpath "$.items" count == 3\n' > "$TMP/t.hurl"
    out_has "hurl: --test · --variable 로 로컬 서버 단언" "Success" hurl --test --variable "base=$URL" "$TMP/t.hurl"
  else skip "hurl: 받지 않음"; fi
fi
if want psmux; then
  if has bin/psmux.exe; then
    PSMUX_USED=1
    timeout 20 psmux -L "$SOCK" new-session -d -s t >/dev/null 2>&1
    timeout 10 psmux -L "$SOCK" has-session -t t >/dev/null 2>&1 && pass "psmux: new-session · has-session" || fail "psmux: new-session · has-session"
    # 글자와 Enter 를 따로 보낸다 (docs/dev-process.md §7 함정 10)
    timeout 10 psmux -L "$SOCK" send-keys -t t "echo psmux-ok" >/dev/null 2>&1; sleep 0.5
    timeout 10 psmux -L "$SOCK" send-keys -t t Enter >/dev/null 2>&1
    got=""; for _ in $(seq 20); do got="$(timeout 10 psmux -L "$SOCK" capture-pane -p -t t 2>&1 | tr -d '\r')"; [[ "$got" == *$'\n'psmux-ok* || "$got" == psmux-ok* ]] && break; sleep 0.5; done
    [[ "$got" == *psmux-ok*psmux-ok* || "$got" == *$'\n'psmux-ok* ]] && pass "psmux: send-keys · capture-pane" || fail "psmux: send-keys · capture-pane — 출력: $(tail -c 200 <<< "$got" | tr '\n' ' ')"
    timeout 10 psmux -L "$SOCK" kill-session -t t >/dev/null 2>&1
  else skip "psmux: 받지 않음"; fi
fi
for t in glab gh; do
  if want "$t"; then
    if has "bin/$t.exe"; then out_has "$t: 실행 (--version)" "$t" "$OXY_HOME/bin/$t.exe" --version; flags_ok "$t" "$OXY_HOME/bin/$t.exe"
    else skip "$t: 받지 않음"; fi
  fi
done
if want ast-grep; then
  if has bin/ast-grep.exe; then
    flags_ok ast-grep "$OXY_HOME/bin/ast-grep.exe"
    out_has "ast-grep: 패턴 찾기 (래퍼: / 경로)" "src/sample.ts" ast-grep run -l ts -p 'console.log($$$A)' "$FX"
  else skip "ast-grep: 받지 않음"; fi
fi

# agent-browser: 고른 브라우저마다 로컬 페이지를 열어 제목 읽기
ab_engine() { # <설명> <브라우저 exe (Windows 경로)>
  AB_USED=1
  local label="$1"
  export AGENT_BROWSER_EXECUTABLE_PATH="$2"
  timeout 90 agent-browser --session "$SESSION" open "$URL/page.html" >/dev/null 2>&1
  out_has "$label: 로컬 페이지 열기 · get title" "Oxygen Fixture" agent-browser --session "$SESSION" get title
  out_has "$label: get text" "Hello Oxygen" agent-browser --session "$SESSION" get text h1
  timeout 30 agent-browser --session "$SESSION" close >/dev/null 2>&1
}
CHROMIUM="$OXY_HOME/vendor/browsers/chromium/chrome.exe"; CFT="$OXY_HOME/vendor/browsers/chrome-win64/chrome.exe"
if want agent-browser || want chromium || want chrome; then
  if has bin/agent-browser.exe; then
    want agent-browser && flags_ok agent-browser "$OXY_HOME/bin/agent-browser.exe"
    ran=0
    if want chromium || want agent-browser; then [[ -f "$CHROMIUM" ]] && { ab_engine "agent-browser + chromium" "$(winpath "$CHROMIUM")"; ran=1; } || { want chromium && skip "chromium: 받지 않음"; }; fi
    if want chrome || { want agent-browser && (( ! ran )); }; then [[ -f "$CFT" ]] && ab_engine "agent-browser + chrome (for testing)" "$(winpath "$CFT")" || { want chrome && skip "chrome: 받지 않음"; }; fi
  else
    for t in agent-browser chromium chrome; do want "$t" && skip "$t: agent-browser 를 받지 않음"; done
  fi
fi
if want obscura; then
  if has bin/obscura.exe; then
    flags_ok obscura "$OXY_HOME/bin/obscura.exe"
    out_has "obscura: fetch --dump text" "Hello Oxygen" obscura fetch "$URL/page.html" --dump text
    out_has "obscura: scrape --eval --format json" "fixture-ok" obscura scrape "$URL/page.html" --format json -q --eval "document.querySelector('#result').textContent"
  else skip "obscura: 받지 않음"; fi
fi
if want usql; then
  if has bin/usql.exe; then
    flags_ok usql "$OXY_HOME/bin/usql.exe"
    db="sqlite:$(winpath "$TMP/t.db")"
    timeout 30 usql "$db" -w -q -c "create table t(a int); insert into t values (1),(2),(3);" >/dev/null 2>&1
    out_has "usql: SQLite 조회 (-w -q --csv -c)" "3" usql "$db" -w -q --csv -c "select count(*) as n from t"
  else skip "usql: 받지 않음"; fi
fi
if want sqlcl; then
  if [[ -f "$OXY_HOME/runtime/sqlcl/bin/sql" ]]; then
    # 래퍼(wrappers/sql)로 실행: sh 런처 · JAVA_HOME 보정 · /nolog 경로 변환 차단. 120자 넘는 설치 경로는 설치 흐름(installer-sandbox)이 본다
    out_has "sqlcl: 래퍼로 /nolog 실행 · 버전" "SQLcl" bash -c 'printf "version\nexit\n" | sql -S /nolog'
  else skip "sqlcl: 받지 않음"; fi
fi

if (( F )); then echo "도구 확인 실패 ($F)"; exit 1; fi
echo "도구 확인 통과"
