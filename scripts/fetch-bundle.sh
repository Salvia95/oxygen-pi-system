#!/usr/bin/env bash
# [인터넷 연결 PC 전용]
# manifest/tools.lock.tsv 에 고정된 구성요소를 내려받아 sha256 을 검증하고 하네스 디렉터리에 배치한다.
#
#   bash scripts/fetch-bundle.sh                 # lock 의 sha256 과 일치해야만 설치
#   bash scripts/fetch-bundle.sh --update-lock   # 버전 갱신 시: 내려받은 파일의 sha256 으로 lock 갱신
#   bash scripts/fetch-bundle.sh --only=fd,rg    # 일부만
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

UPDATE_LOCK=0
ONLY=""
for a in "$@"; do
  case "$a" in
    --update-lock) UPDATE_LOCK=1 ;;
    --only=*) ONLY=",${a#--only=}," ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) die "알 수 없는 인자: $a" ;;
  esac
done

LOCK="$OXY_HOME/manifest/tools.lock.tsv"
CACHE="$OXY_HOME/.cache/downloads"
BIN="$OXY_HOME/bin"
mkdir -p "$CACHE" "$BIN" "$OXY_HOME/agent/bin" "$OXY_HOME/runtime" "$OXY_HOME/vendor/browsers"

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
    fd|rg|just|glab)
      t=$(fresh_tmp "$name"); extract_zip "$file" "$t"
      copy_found "$t" "$BIN" "$name.exe" ;;
    hurl)
      t=$(fresh_tmp hurl); extract_zip "$file" "$t"
      copy_found "$t" "$BIN" "hurl.exe" "hurlfmt.exe"
      find "$t" -type f -iname '*.dll' -exec cp -f {} "$BIN/" \; ;;
    jq)
      cp -f "$file" "$BIN/jq.exe" ;;
    agent-browser)
      t=$(fresh_tmp agent-browser); tar -xzf "$file" -C "$t"
      cp -f "$t/package/bin/agent-browser-win32-x64.exe" "$BIN/agent-browser.exe"
      # 패키지에 포함된 공식 skill 이 있으면 벤더 skill 로 보관
      if [[ -d "$t/package/skills" ]]; then
        rm -rf "$OXY_HOME/vendor/agent-browser-skills"; cp -r "$t/package/skills" "$OXY_HOME/vendor/agent-browser-skills"
      fi ;;
    chrome)
      t=$(fresh_tmp chrome); extract_zip "$file" "$t"
      rm -rf "$OXY_HOME/vendor/browsers/chrome-win64"; mv "$t/chrome-win64" "$OXY_HOME/vendor/browsers/" ;;
    sqlcl)
      t=$(fresh_tmp sqlcl); extract_zip "$file" "$t"
      rm -rf "$OXY_HOME/runtime/sqlcl"; mv "$t/sqlcl" "$OXY_HOME/runtime/sqlcl" ;;
    *) die "설치 방법이 정의되지 않은 컴포넌트: $name" ;;
  esac
  # pi 의 grep/find 도구가 fd/rg 를 GitHub 에서 자동 다운로드하지 않도록 agent/bin 에도 둔다
  case "$name" in fd|rg) cp -f "$BIN/$name.exe" "$OXY_HOME/agent/bin/" ;; esac
}

install_pi() { # npm lockfile(manifest/pi-package-lock.json)로 무결성 고정
  local version="$1" spec="$2" dir="$OXY_HOME/vendor/pi"
  [[ -x "$OXY_HOME/runtime/node/node.exe" ]] || die "pi 설치 전에 node 가 필요함 (lock 순서 확인)"
  mkdir -p "$dir"
  local pkg="${spec%@*}"
  printf '{\n  "name": "oxy-vendor-pi",\n  "private": true,\n  "dependencies": { "%s": "%s" }\n}\n' "$pkg" "$version" \
    > "$dir/package.json"
  local npm_flags=(--ignore-scripts --omit=dev --no-audit --no-fund --loglevel=error)
  if [[ -f "$OXY_HOME/manifest/pi-package-lock.json" && $UPDATE_LOCK == 0 ]]; then
    cp -f "$OXY_HOME/manifest/pi-package-lock.json" "$dir/package-lock.json"
    log "npm ci ($spec)"
    (cd "$dir" && oxy_npm ci "${npm_flags[@]}") || die "npm ci 실패 - 버전을 바꿨다면 --update-lock 으로 다시 실행"
  else
    rm -f "$dir/package-lock.json"
    log "npm install ($spec) → lockfile 갱신"
    (cd "$dir" && oxy_npm install "${npm_flags[@]}")
    cp -f "$dir/package-lock.json" "$OXY_HOME/manifest/pi-package-lock.json"
  fi
}

# ---- 메인 루프: lock 을 읽으며 처리하고, 갱신된 lock 을 새로 쓴다 ----
new_lock="$(mktemp)"
while IFS= read -r line || [[ -n "$line" ]]; do
  if [[ -z "$line" || "$line" == \#* ]]; then printf '%s\n' "$line" >> "$new_lock"; continue; fi
  IFS=$'\t' read -r name version url sha <<< "$line"
  if [[ -n "$ONLY" && "$ONLY" != *",$name,"* ]]; then printf '%s\n' "$line" >> "$new_lock"; continue; fi

  if [[ "$name" == pi ]]; then
    install_pi "$version" "$url"
    printf '%s\t%s\t%s\t%s\n' "$name" "$version" "$url" "npm-lock" >> "$new_lock"
    continue
  fi

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
  log "✓ $name $version"
  printf '%s\t%s\t%s\t%s\n' "$name" "$version" "$url" "$sha" >> "$new_lock"
done < "$LOCK"

mv -f "$new_lock" "$LOCK"
rm -rf "$OXY_HOME/.cache/extract"
log "완료. 다음: just configure && just verify"
