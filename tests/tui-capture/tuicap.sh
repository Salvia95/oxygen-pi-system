#!/usr/bin/env bash
# 실제 터미널(ConPTY)에서 TUI 를 실행하고 화면을 캡처한다. 번들의 psmux(tmux 호환) 세션 안에서 실행하므로 방향키 · raw mode · 대체 화면이 진짜로 동작한다.
# 화면을 고친 뒤에는 가짜 터미널이 아니라 이 도구로 확인한다 (기준 환경: Git Bash 기본 창 mintty 80×24, 둘째: Windows Terminal. Windows Terminal 은 설정에 따라 요청한 크기와 다르게 열릴 수 있다).
#   tuicap.sh start  <세션> <폭> <높이> -- <명령>     세션 시작 (작업 폴더 = 저장소 루트. 명령의 경로는 역슬래시로: runtime\node\node.exe installer\tweak.mjs)
#   tuicap.sh keys   <세션> <키...>                   키 입력 (Down Up Enter Escape Space C-c, 글자는 그대로: abc)
#   tuicap.sh text   <세션> [파일]                    보이는 화면을 텍스트로 (무색). 창을 열지 않는다
#   tuicap.sh ansi   <세션> [파일]                    보이는 화면을 색 코드 포함 텍스트로
#   tuicap.sh back   <세션> [줄수]                    스크롤백(위로 밀려난 줄)까지 포함해 텍스트로
#   tuicap.sh mintty <세션> <파일.png>                Git Bash 기본 창(mintty)에 세션을 붙여 실제 렌더링을 PNG 로 (글꼴 등: TUICAP_MINTTY_OPTS="-o Font=D2Coding")
#   tuicap.sh wt     <세션> <파일.png>                Windows Terminal 새 창에 세션을 붙여 PNG 로
#   tuicap.sh stop   <세션>                           세션 종료 (붙인 창도 닫힌다)
# 주의: mintty · wt 는 바탕화면에 창을 실제로 연다. 반복 확인은 text 로 하고 PNG 는 화면당 한 장으로 아낀다. 세션은 반드시 stop 으로 정리한다.
#       설치 TUI 는 --sandbox <임시 폴더> 로만 실행한다 (tests/installer-demo.sh 참고). 사용자가 쓰는 터미널 창은 건드리지 않는다 (창은 이 도구가 붙인 제목으로만 찾는다).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -W)"
REPO="$(cd "$HERE/../.." && pwd -W)"
P="$REPO/bin/psmux.exe"
STATE="$HERE/.state"
MINTTY="${MINTTY:-/c/Program Files/Git/usr/bin/mintty.exe}"
cmd="${1:?start|keys|text|ansi|back|mintty|wt|stop}"; s="${2:?세션 이름}"; shift 2
out() { if [[ -n "${1:-}" ]]; then cat > "$1"; echo "saved $1"; else cat; fi; }
shot() { powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$HERE/win.ps1" -Title "$1" -Out "$2" -Wait 15; }
mkdir -p "$STATE"
case "$cmd" in
  start)
    cols="$1"; rows="$2"; shift 2; [[ "${1:-}" == "--" ]] && shift
    "$P" kill-session -t "$s" 2>/dev/null || true
    (cd "$REPO" && "$P" new-session -d -s "$s" -x "$cols" -y "$rows" "$*")
    "$P" set-option -t "$s" status off >/dev/null 2>&1 || true
    echo "$cols $rows" > "$STATE/$s.size"
    sleep "${TUICAP_WAIT:-2}" ;;
  keys) "$P" send-keys -t "$s" "$@"; sleep "${TUICAP_WAIT:-0.5}" ;;
  text) "$P" capture-pane -p -t "$s" | out "${1:-}" ;;
  ansi) "$P" capture-pane -p -e -t "$s" | out "${1:-}" ;;
  back) "$P" capture-pane -p -S "-${1:-200}" -t "$s" ;;
  mintty)
    file="${1:?파일.png}"
    if [[ ! -f "$STATE/$s.mintty" ]]; then
      read -r cols rows < "$STATE/$s.size"
      read -ra mopts <<< "${TUICAP_MINTTY_OPTS:-}"
      "$MINTTY" "${mopts[@]}" -t "tuicap-m-$s" -s "$cols,$rows" "$P" attach -t "$s" &
      touch "$STATE/$s.mintty"
    fi
    shot "tuicap-m-$s" "$file" ;;
  wt)
    file="${1:?파일.png}"
    if [[ ! -f "$STATE/$s.wt" ]]; then
      read -r cols rows < "$STATE/$s.size"
      wt.exe -w new --size "$cols,$rows" new-tab --title "tuicap-w-$s" --suppressApplicationTitle "$P" attach -t "$s"
      touch "$STATE/$s.wt"
    fi
    shot "tuicap-w-$s" "$file" ;;
  stop)
    "$P" kill-session -t "$s" 2>/dev/null || true
    # 세션이 끝나면 붙인 창은 스스로 닫힌다. 남아 있으면 제목으로 찾아 닫는다 (이 도구가 연 창만)
    for kind in m w; do
      [[ -f "$STATE/$s.$([[ $kind == m ]] && echo mintty || echo wt)" ]] || continue
      sleep 1
      powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$HERE/win.ps1" -Title "tuicap-$kind-$s" -Close -Wait 0 >/dev/null 2>&1 || true
    done
    rm -f "$STATE/$s.size" "$STATE/$s.mintty" "$STATE/$s.wt"; echo stopped ;;
  *) echo "unknown: $cmd" >&2; exit 2 ;;
esac
