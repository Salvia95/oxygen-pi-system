#!/usr/bin/env bash
# oxygen-pi-system 종합 설정 (Tweak TUI, Git Bash 용). 번들 Node 로 installer/tweak.mjs 를 실행한다.
# mintty(기본 Git Bash 창)는 Node 에 진짜 콘솔을 주지 않으므로 winpty 를 거치거나 줄 입력 모드로 동작한다.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node="$here/runtime/node/node.exe"
script="$(cygpath -m "$here/installer/tweak.mjs")"
# 표식 파일: 화면 프로그램(bin/oxy-tui.exe)이 대체 화면에 들어가 있는 동안에만 있다. Node 가 강제 종료되면 화면 프로그램도 함께 죽어
# 터미널을 되돌리지 못하고 표식이 남는다. 그때만 installer/restore-terminal.mjs 가 터미널을 되돌린다.
mark="${TMPDIR:-/tmp}/oxy-tui-$$.mark"
export OXY_TUI_MARK="$(cygpath -w "$mark")"
if [[ "${TERM_PROGRAM:-}" == mintty ]] && command -v winpty >/dev/null 2>&1; then
  winpty "$node" "$script" "$@"
else
  "$node" "$script" "$@"
fi
rc=$?
if [[ -e "$mark" ]]; then "$node" "$(cygpath -m "$here/installer/restore-terminal.mjs")" "$OXY_TUI_MARK"; fi
exit $rc
