#!/usr/bin/env bash
# [인터넷 연결 PC 전용]
# 반입할 구성요소를 골라 공식 배포처에서 직접 내려받고, sha256 을 검증해 하네스 디렉터리에 배치한다.
# 저장소에는 바이너리가 없다. 받은 것을 scripts/package-bundle.sh 로 묶어 본인이 반입한다.
#
#   bash scripts/fetch-bundle.sh                         # 선택 화면 (필수 항목은 기본 체크·해제 불가)
#   bash scripts/fetch-bundle.sh --defaults              # 필수 항목만 (비대화형)
#   bash scripts/fetch-bundle.sh --select=glab,hurl      # 필수 + 지정한 항목 (비대화형)
#   bash scripts/fetch-bundle.sh --all --accept-license  # 전부 (비오픈소스 약관 동의를 미리 표시)
#   bash scripts/fetch-bundle.sh --only=fd,rg            # 지정한 항목만 다시 받기 (다른 항목은 건드리지 않음)
#   bash scripts/fetch-bundle.sh --update-lock ...       # 버전 갱신 시: 내려받은 파일의 sha256 으로 lock 갱신
#
# 선택에서 빠진 구성요소가 이전에 받아져 있으면 지운다 (번들에 원치 않는 파일이 들어가지 않도록).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

UPDATE_LOCK=0
MODE=""        # interactive | defaults | select | all | only
LIST=""
ACCEPT=0
for a in "$@"; do
  case "$a" in
    --update-lock) UPDATE_LOCK=1 ;;
    --defaults) MODE=defaults ;;
    --all) MODE=all ;;
    --select=*) MODE=select; LIST="${a#--select=}" ;;
    --only=*) MODE=only; LIST="${a#--only=}" ;;
    --accept-license) ACCEPT=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) die "알 수 없는 인자: $a" ;;
  esac
done

LOCK="$OXY_HOME/manifest/tools.lock.tsv"
CACHE="$OXY_HOME/.cache/downloads"
BIN="$OXY_HOME/bin"
NODE="$OXY_HOME/runtime/node/node.exe"
mkdir -p "$CACHE" "$BIN" "$OXY_HOME/agent/bin" "$OXY_HOME/runtime" "$OXY_HOME/vendor/browsers" "$OXY_HOME/.cache/installed"

# installer/components.mjs CLI (구성요소 정의·설치를 설치 TUI 와 공유)
comp() { "$NODE" "$(winpath "$OXY_HOME/installer/components.mjs")" "$@"; }

download() {
  local url="$1" out="$2"
  if [[ -s "$out" ]]; then log "캐시 사용: $(basename "$out")"; return; fi
  log "다운로드: $url"
  curl -fL --retry 3 --retry-delay 2 -o "$out.part" "$url"
  mv "$out.part" "$out"
}

# 임시 해제 디렉터리 (컴포넌트마다 새로 만든다)
fresh_tmp() { local d="$OXY_HOME/.cache/extract/$1"; rm -rf "$d"; mkdir -p "$d"; echo "$d"; }

copy_found() { # <dir> <dest> <pattern...>: dir 아래에서 이름이 일치하는 파일을 dest 로 평탄화 복사
  local dir="$1" dest="$2"; shift 2
  local p found=0
  for p in "$@"; do
    while IFS= read -r -d '' f; do cp -f "$f" "$dest/"; found=1; done \
      < <(find "$dir" -type f -iname "$p" -print0)
  done
  [[ $found == 1 ]] || die "$dir 에서 $* 를 찾지 못함"
}

install_component() {
  local name="$1" file="$2" t
  case "$name" in
    node)
      t=$(fresh_tmp node); extract_zip "$file" "$t"
      rm -rf "$OXY_HOME/runtime/node"; mv "$t"/node-v*-win-x64 "$OXY_HOME/runtime/node" ;;
    fd|rg|just|glab|gh|usql)
      t=$(fresh_tmp "$name"); extract_zip "$file" "$t"
      copy_found "$t" "$BIN" "$name.exe" ;;
    ast-grep)
      # 압축 안에 ast-grep.exe 와 같은 바이너리의 별칭 sg.exe 가 있다 → ast-grep.exe 만 둔다
      t=$(fresh_tmp ast-grep); extract_zip "$file" "$t"
      copy_found "$t" "$BIN" "ast-grep.exe" ;;
    obscura)
      t=$(fresh_tmp obscura); extract_zip "$file" "$t"
      copy_found "$t" "$BIN" "obscura.exe" "obscura-worker.exe" ;;
    hurl)
      t=$(fresh_tmp hurl); extract_zip "$file" "$t"
      copy_found "$t" "$BIN" "hurl.exe" "hurlfmt.exe"
      find "$t" -type f -iname '*.dll' -exec cp -f {} "$BIN/" \;
      find "$t" -type f -iname '*.dll' -printf 'bin/%f\n' > "$OXY_HOME/.cache/installed/hurl.dlls" ;;
    jq)
      cp -f "$file" "$BIN/jq.exe" ;;
    agent-browser)
      t=$(fresh_tmp agent-browser); tar -xzf "$file" -C "$t"
      cp -f "$t/package/bin/agent-browser-win32-x64.exe" "$BIN/agent-browser.exe"
      # `agent-browser skills get core` 가 읽는 버전 일치 가이드 (AGENT_BROWSER_SKILLS_DIR 로 지정)
      rm -rf "$OXY_HOME/vendor/agent-browser-skill-data"
      [[ -d "$t/package/skill-data" ]] && cp -r "$t/package/skill-data" "$OXY_HOME/vendor/agent-browser-skill-data" ;;
    chromium)
      t=$(fresh_tmp chromium); extract_zip "$file" "$t"
      # 스냅샷 빌드에 들어 있는 테스트 실행 파일(약 370MB)은 브라우저 실행에 필요 없음
      rm -f "$t/chrome-win/interactive_ui_tests.exe"
      rm -rf "$OXY_HOME/vendor/browsers/chromium"; mv "$t/chrome-win" "$OXY_HOME/vendor/browsers/chromium" ;;
    chrome|sqlcl)
      # 설치 TUI 의 zip 설치와 같은 코드 (installer/components.mjs)
      comp install "$name" "$(winpath "$file")" >/dev/null || die "$name 설치 실패" ;;
    *) die "설치 방법이 정의되지 않은 컴포넌트: $name" ;;
  esac
  # pi 의 grep/find 도구가 fd/rg 를 GitHub 에서 자동 다운로드하지 않도록 agent/bin 에도 둔다
  case "$name" in fd|rg) cp -f "$BIN/$name.exe" "$OXY_HOME/agent/bin/" ;; esac
}

# 선택에서 빠진 (선택 항목) 구성요소의 설치 파일
prune_paths() {
  case "$1" in
    just) echo bin/just.exe ;;
    hurl) echo bin/hurl.exe bin/hurlfmt.exe
      # 설치할 때 기록한 DLL 목록. 없으면(기록 이전 설치) 캐시된 hurl 압축 파일에서 읽는다
      if [[ -f "$OXY_HOME/.cache/installed/hurl.dlls" ]]; then cat "$OXY_HOME/.cache/installed/hurl.dlls"
      else for z in "$CACHE"/hurl-*.download; do [[ -f "$z" ]] && unzip -Z1 "$z" | grep -i '\.dll$' | sed 's|.*/||; s|^|bin/|'; done; fi ;;
    glab) echo bin/glab.exe ;;
    gh) echo bin/gh.exe ;;
    usql) echo bin/usql.exe ;;
    ast-grep) echo bin/ast-grep.exe ;;
    obscura) echo bin/obscura.exe bin/obscura-worker.exe ;;
    dbhub) echo vendor/dbhub ;;
    agent-browser) echo bin/agent-browser.exe vendor/agent-browser-skill-data ;;
    chromium) echo vendor/browsers/chromium ;;
    chrome) echo vendor/browsers/chrome-win64 ;;
    sqlcl) echo runtime/sqlcl ;;
  esac
}

install_npm() { # <name> <version> <spec>: vendor/<name> 에 설치, manifest/<name>-package-lock.json 으로 무결성 고정
  local name="$1" version="$2" spec="$3" dir="$OXY_HOME/vendor/$1" lockf="$OXY_HOME/manifest/$1-package-lock.json"
  [[ -x "$NODE" ]] || die "$name 설치 전에 node 가 필요함 (lock 순서 확인)"
  mkdir -p "$dir"
  local pkg="${spec%@*}"
  printf '{\n  "name": "oxy-vendor-%s",\n  "private": true,\n  "dependencies": { "%s": "%s" }\n}\n' "$name" "$pkg" "$version" \
    > "$dir/package.json"
  local npm_flags=(--ignore-scripts --omit=dev --no-audit --no-fund --loglevel=error)
  if [[ -f "$lockf" && $UPDATE_LOCK == 0 ]]; then
    cp -f "$lockf" "$dir/package-lock.json"
    log "npm ci ($spec)"
    (cd "$dir" && oxy_npm ci "${npm_flags[@]}") || die "npm ci 실패 - 버전을 바꿨다면 --update-lock 으로 다시 실행"
  else
    rm -f "$dir/package-lock.json"
    log "npm install ($spec) → lockfile 갱신"
    (cd "$dir" && oxy_npm install "${npm_flags[@]}")
    cp -f "$dir/package-lock.json" "$lockf"
  fi
}

# 한 행 처리: 다운로드 → sha256 검증(또는 lock 갱신) → 설치. 갱신된 sha 를 NEW_SHA 로 돌려준다
process_row() { # <name> <version> <url> <sha>
  local name="$1" version="$2" url="$3" sha="$4" file actual
  # url 이 http 가 아니면 npm package spec (pi, dbhub): lockfile 로 고정
  if [[ "$url" != http* ]]; then install_npm "$name" "$version" "$url"; NEW_SHA="npm-lock"; log "✓ $name $version"; return; fi
  file="$CACHE/$name-$version.download"
  download "$url" "$file"
  actual=$(sha256 "$file")
  if [[ $UPDATE_LOCK == 1 ]]; then
    [[ "$sha" != "-" && "$sha" != "$actual" ]] && warn "$name: sha256 변경됨 ($sha → $actual)"
    sha="$actual"
  elif [[ "$sha" == "-" ]]; then
    die "$name: lock 에 sha256 이 없음 → --update-lock 으로 먼저 고정하세요"
  elif [[ "$sha" != "$actual" ]]; then
    rm -f "$file"
    die "$name: sha256 불일치 (기대 $sha, 실제 $actual)"
  fi
  install_component "$name" "$file"
  NEW_SHA="$sha"
  log "✓ $name $version"
}

lock_rows() { grep -v '^#' "$LOCK" | grep -v '^$'; }
REQUIRED=",$(lock_rows | awk -F'\t' '$6=="required"{print $1}' | paste -sd, -),"
ALLNAMES=",$(lock_rows | cut -f1 | paste -sd, -),"
PROPRIETARY=",sqlcl,chrome,"   # installer/components.mjs CATALOG.proprietary 와 같게 유지

# ---- 1) Node 준비 (선택 화면이 Node 로 동작) ----
if [[ ! -x "$NODE" ]]; then
  IFS=$'\t' read -r n v u s _ <<< "$(lock_rows | awk -F'\t' '$1=="node"')"
  process_row "$n" "$v" "$u" "$s"
fi

# ---- 2) 선택 결정 ----
ACCEPTED=","
if [[ -z "$MODE" ]]; then
  [[ -t 0 && -t 1 ]] || die "비대화형 실행입니다. --defaults / --select=<이름,...> / --all 중 하나를 지정하세요"
  MODE=interactive
  SEL_FILE="$(mktemp)"
  "$NODE" "$(winpath "$OXY_HOME/installer/select-components.mjs")" --out "$(winpath "$SEL_FILE")" --root "$(winpath "$OXY_HOME")" \
    || die "선택을 취소했습니다"
  SELECTED=",$(grep -v '^accepted:' "$SEL_FILE" | paste -sd, -),"
  ACCEPTED=",$(grep '^accepted:' "$SEL_FILE" | sed 's/^accepted://' | paste -sd, -),"
  rm -f "$SEL_FILE"
else
  case "$MODE" in
    defaults) SELECTED="$REQUIRED" ;;
    all) SELECTED="$ALLNAMES" ;;
    select) SELECTED="$REQUIRED$LIST," ;;
    only) SELECTED=",$LIST," ;;
  esac
  for n in $(tr ',' ' ' <<< "$LIST"); do [[ "$ALLNAMES" == *",$n,"* ]] || die "알 수 없는 구성요소: $n (manifest/tools.lock.tsv 확인)"; done
  # 비대화형: 비오픈소스 항목은 --accept-license 로 동의를 표시해야 한다
  for n in $(tr ',' ' ' <<< "$PROPRIETARY"); do
    [[ "$SELECTED" == *",$n,"* ]] || continue
    if [[ $ACCEPT == 1 ]]; then ACCEPTED+="$n,"
    else die "$n 은(는) 오픈소스가 아닙니다 ($(lock_rows | awk -F'\t' -v n="$n" '$1==n{print $5}')). 약관을 확인한 뒤 --accept-license 를 붙이세요: $(comp license-url "$n")"; fi
  done
  if [[ "$MODE" != only ]]; then printf '%s\n' $(tr ',' ' ' <<< "$SELECTED") > "$OXY_HOME/.oxy-selection"; fi
fi
log "선택: $(tr ',' ' ' <<< "$SELECTED" | xargs)"

# ---- 3) 처리: 선택한 것은 받고, 선택에서 빠진 선택 항목은 지운다 (--only 는 지우지 않음) ----
new_lock="$(mktemp)"
while IFS= read -r line || [[ -n "$line" ]]; do
  if [[ -z "$line" || "$line" == \#* ]]; then printf '%s\n' "$line" >> "$new_lock"; continue; fi
  IFS=$'\t' read -r name version url sha license role group <<< "$line"
  if [[ "$SELECTED" == *",$name,"* ]]; then
    if [[ "$PROPRIETARY" == *",$name,"* && "$ACCEPTED" != *",$name,"* ]]; then die "$name: 약관 동의 없이 받을 수 없음"; fi
    if [[ "$name" == node && -x "$NODE" && $UPDATE_LOCK == 0 && "$MODE" != only ]]; then
      NEW_SHA="$sha"   # 1) 에서 이미 준비됨
    else
      process_row "$name" "$version" "$url" "$sha"
    fi
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$name" "$version" "$url" "$NEW_SHA" "$license" "$role" "$group" >> "$new_lock"
  else
    printf '%s\n' "$line" >> "$new_lock"
    if [[ "$MODE" != only && "$role" != required ]]; then
      removed=""
      for p in $(prune_paths "$name"); do
        [[ -e "$OXY_HOME/$p" ]] && { rm -rf "${OXY_HOME:?}/$p"; removed=1; }
      done
      [[ -n "$removed" ]] && log "– $name 제거 (선택에서 빠짐)"
    fi
  fi
done < "$LOCK"

mv -f "$new_lock" "$LOCK"
rm -rf "$OXY_HOME/.cache/extract"
log "완료. 다음: just package  (이 PC 에서 쓸 때는 just configure && just verify)"
