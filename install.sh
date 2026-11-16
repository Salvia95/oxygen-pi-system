#!/usr/bin/env bash
# oxygen-pi-system 설치 TUI (Git Bash 용). 번들 Node 로 installer/install.mjs 를 실행한다.
# mintty(기본 Git Bash 창)는 Node 에 진짜 콘솔을 주지 않으므로 winpty 를 거치거나 줄 입력 모드로 동작한다.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node="$here/runtime/node/node.exe"
script="$(cygpath -m "$here/installer/install.mjs")"
# 표식 파일: 화면 프로그램(bin/oxy-tui.exe)이 대체 화면에 들어가 있는 동안에만 있다. Node 가 강제 종료되면 화면 프로그램도 함께 죽어
# 터미널을 되돌리지 못하고 표식이 남는다. 그때만 installer/restore-terminal.mjs 가 터미널을 되돌린다.
mark="${TMPDIR:-/tmp}/oxy-tui-$$.mark"
export OXY_TUI_MARK="$(cygpath -w "$mark")"
# 업데이트 넘김 (docs/tui-spec.md §13): 설치 폴더의 업데이트에서 새 번들을 고르면 install.mjs 가 이 스크립트를 쓰고 끝난다.
# 업데이트가 이 파일 자체를 바꾸므로 exec 로 넘기고 돌아오지 않는다.
handoff="${TMPDIR:-/tmp}/oxygen-pi-update-$$.sh"
# exec 로 넘기면 프로세스 번호가 그대로라 새 번들의 install.sh 가 같은 이름을 만든다. 남은 파일로 다시 넘기지 않게 지운다
rm -f "$handoff"
export OXY_UPDATE_HANDOFF="$(cygpath -w "$handoff")"
if [[ "${TERM_PROGRAM:-}" == mintty ]] && command -v winpty >/dev/null 2>&1; then
  winpty "$node" "$script" "$@"
else
  "$node" "$script" "$@"
fi
rc=$?
if [[ -e "$mark" ]]; then "$node" "$(cygpath -m "$here/installer/restore-terminal.mjs")" "$OXY_TUI_MARK"; fi
if [[ $rc == 0 && -f "$handoff" ]]; then exec bash "$handoff"; fi
exit $rc
