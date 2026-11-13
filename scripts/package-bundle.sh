#!/usr/bin/env bash
# [인터넷 연결 PC 전용] fetch 로 받은 구성요소와 하네스를 폐쇄망 반입용 zip 으로 묶는다.
#   bash scripts/package-bundle.sh           # 필수 구성요소 검사 → dist/oxygen-pi-<날짜>.zip (+ .sha256)
#   bash scripts/package-bundle.sh --check   # 검사만
# 필수(role=required) 구성요소가 하나라도 없으면 zip 을 만들지 않는다.
# 만든 번들은 본인 반입용이다. 비오픈소스 구성요소가 들어 있으면 다른 사람에게 배포하기 전에 해당 약관을 확인한다.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

NODE="$OXY_HOME/runtime/node/node.exe"
[[ -x "$NODE" ]] || die "필수 구성요소 node 가 없습니다 → bash scripts/fetch-bundle.sh"

# ---- 구성요소 검사 ----
missing=() included=() proprietary=() skipped=() harness_missing=()
while IFS=$'\t' read -r name role installed prop version; do
  if [[ $installed == 1 ]]; then
    included+=("$name $version")
    [[ $prop == 1 ]] && proprietary+=("$name")
  elif [[ $role == required ]]; then
    missing+=("$name")
  elif [[ $role == harness ]]; then
    harness_missing+=("$name")
  else
    skipped+=("$name")
  fi
done < <("$NODE" "$(winpath "$OXY_HOME/installer/components.mjs")" status --root "$(winpath "$OXY_HOME")" | tr -d '\r')

log "포함: ${included[*]/%/,}"
(( ${#skipped[@]} )) && log "미포함 (선택 항목): ${skipped[*]}"
# 화면 프로그램이 없어도 번들은 만든다: 폐쇄망 PC 에서 설치·설정 TUI 가 줄 입력 모드(번호 입력)로 동작한다
(( ${#harness_missing[@]} )) && warn "하네스 구성요소 없음: ${harness_missing[*]} → 화면 프로그램(oxy-tui)이 없으면 설치·설정 TUI 가 줄 입력 모드로, pi 테마(pi-tokyo-night)가 없으면 pi 가 기본 테마로 동작합니다. 받으려면 bash scripts/fetch-bundle.sh --only=${harness_missing[0]}"
if (( ${#missing[@]} )); then
  die "필수 구성요소 누락: ${missing[*]} → bash scripts/fetch-bundle.sh 로 받은 뒤 다시 실행하세요"
fi
if (( ${#proprietary[@]} )); then
  warn "비오픈소스 구성요소 포함: ${proprietary[*]} — 본인 반입용입니다. 다른 사람에게 배포하기 전에 약관을 확인하세요."
fi
(( CHECK_ONLY )) && { log "검사 통과 (--check)"; exit 0; }

# ---- zip 생성 ----
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
    --exclude="$base/.cache" --exclude="$base/dist" --exclude="$base/.git" --exclude="$base/optional" \
    --exclude="$base/.oxy-selection" \
    --exclude="$base/installer/oxy-tui/target" --exclude="$base/tests/tui-capture/.state" \
    --exclude="$base/agent/oxy.env" --exclude="$base/agent/sessions" \
    --exclude="$base/agent/settings.json" --exclude="$base/agent/models.json" \
    --exclude="$base/agent/auth.json" --exclude="$base/agent/models-store.json" --exclude="$base/agent/skills" \
    --exclude="$base/agent/usql.yaml" --exclude="$base/agent/dbhub.toml" --exclude="$base/agent/connections.json" \
    --exclude="$base/agent/secrets.json" --exclude="$base/agent/llm.json" --exclude="$base/agent/mcp.json" --exclude="$base/agent/mcp.log*" \
    --exclude="$base/agent/mcp-auth.json" --exclude="$base/agent/jobs" --exclude="$base/agent/psmux.conf" \
    "$base"
)
(cd "$OXY_HOME/dist" && sha256sum "$name.zip" > "$name.zip.sha256")
log "완료: $(du -h "$out" | cut -f1)  $(cut -d' ' -f1 "$out.sha256")"
log "폐쇄망 PC: 압축 해제 → install.cmd (설치 TUI)"
