# shellcheck shell=bash
# oxygen-pi-system 스크립트 공통 함수. 다른 스크립트에서 source 해서 사용.
set -euo pipefail

OXY_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export OXY_HOME

log()  { printf '\033[36m[oxy]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[warn]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }

# POSIX 경로 → Windows 경로(C:/...). 네이티브 exe 에 넘기는 경로/환경변수는 반드시 이걸 거친다.
winpath() { cygpath -m "$1"; }

sha256() { sha256sum "$1" | cut -d' ' -f1; }

# zip 해제: Git Bash 의 unzip 우선, 없으면 Windows 내장 bsdtar
extract_zip() {
  local zip="$1" dest="$2"
  mkdir -p "$dest"
  if command -v unzip >/dev/null 2>&1; then
    unzip -q -o "$zip" -d "$dest"
  else
    "$(cygpath -u "${SYSTEMROOT:-C:/Windows}")/System32/tar.exe" -xf "$(winpath "$zip")" -C "$(winpath "$dest")"
  fi
}

# 번들 Node 로 npm 실행 (시스템 Node 버전과 무관하게 동작)
oxy_npm() {
  "$OXY_HOME/runtime/node/node.exe" \
    "$(winpath "$OXY_HOME/runtime/node/node_modules/npm/bin/npm-cli.js")" "$@"
}

# lock 파일에서 한 컴포넌트의 필드 조회: lock_get <name> <field: version|url|sha>
lock_get() {
  awk -F'\t' -v n="$1" -v f="$2" '
    $0 !~ /^#/ && $1 == n { i = (f=="version")?2:(f=="url")?3:4; print $i; exit }
  ' "$OXY_HOME/manifest/tools.lock.tsv"
}
