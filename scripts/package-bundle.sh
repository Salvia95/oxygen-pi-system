#!/usr/bin/env bash
# [인터넷 연결 PC 전용] fetch 가 끝난 하네스를 폐쇄망 반입용 zip 으로 묶는다.
#   결과: dist/oxygen-pi-<날짜>.zip, dist/oxygen-pi-<날짜>.zip.sha256
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

[[ -x "$OXY_HOME/runtime/node/node.exe" && -f "$OXY_HOME/bin/fd.exe" ]] || die "먼저 just fetch 를 실행하세요"

name="oxygen-pi-$(date +%Y%m%d)"
mkdir -p "$OXY_HOME/dist"
out="$OXY_HOME/dist/$name.zip"
rm -f "$out"

# Windows 내장 bsdtar 로 zip 생성 (Git Bash 에는 zip 이 없음). PC별 설정/세션/캐시는 제외.
TAR="$(cygpath -u "${SYSTEMROOT:-C:/Windows}")/System32/tar.exe"
log "압축 중: $out"
(
  cd "$OXY_HOME/.."
  base="$(basename "$OXY_HOME")"
  "$TAR" -a -c -f "$(winpath "$out")" \
    --exclude="$base/.cache" --exclude="$base/dist" --exclude="$base/.git" \
    --exclude="$base/agent/oxy.env" --exclude="$base/agent/sessions" \
    --exclude="$base/agent/settings.json" --exclude="$base/agent/models.json" \
    --exclude="$base/agent/auth.json" --exclude="$base/agent/models-store.json" \
    "$base"
)
(cd "$OXY_HOME/dist" && sha256sum "$name.zip" > "$name.zip.sha256")
log "완료: $(du -h "$out" | cut -f1)  $(cut -d' ' -f1 "$out.sha256")"
log "폐쇄망 PC: 압축 해제 → Git Bash 에서 bash scripts/configure.sh && bash scripts/verify.sh"
