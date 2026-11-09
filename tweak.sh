#!/usr/bin/env bash
# oxygen-pi-system 종합 설정 (Tweak TUI, Git Bash 용). 번들 Node 로 installer/tweak.mjs 를 실행한다.
# mintty(기본 Git Bash 창)는 Node 에 진짜 콘솔을 주지 않으므로 winpty 를 거치거나 줄 입력 모드로 동작한다.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node="$here/runtime/node/node.exe"
script="$(cygpath -m "$here/installer/tweak.mjs")"
if [[ "${TERM_PROGRAM:-}" == mintty ]] && command -v winpty >/dev/null 2>&1; then
  exec winpty "$node" "$script" "$@"
fi
exec "$node" "$script" "$@"
