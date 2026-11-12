#!/usr/bin/env bash
# 저장소 위생 검사. 회고에서 두 번 이상 나온 실수를 기계적으로 잡는다. 키는 출력하지 않는다 (경로:줄 과 패턴 이름만).
#   bash tests/repo-hygiene.sh [저장소 루트]      FAIL 이 있으면 종료코드 1
# 검사:
#   1. Windows 예약 이름 파일 (NUL CON PRN AUX COM1-9 LPT1-9): Git Bash 에서 `> NUL` 이 실제 파일이 된다
#   2. CRLF: .gitattributes 가 eol=lf 인 파일이 작업 트리에서 CRLF (Windows 도구로 고친 파일). *.cmd 는 crlf 가 맞다
#   3. `source env.sh` / `. env.sh` (경로 없음): bash 는 / 가 없는 이름을 PATH 에서 먼저 찾아 설치본 env.sh 를 읽는다
#   4. 키 모양 문자열: git 이 무시하지 않는 새 파일 · 고친 파일에 API 키처럼 보이는 값
set -uo pipefail
ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT" || exit 2
F=0
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; F=$((F+1)); }
pass() { printf '  \033[32mPASS\033[0m %s\n' "$*"; }
PRUNE=(-path ./.git -o -path ./vendor -o -path ./runtime -o -path ./bin -o -path ./dist -o -path ./.cache -o -path ./optional -o -path ./installer/oxy-tui/target)

# 1
bad=$(find . \( "${PRUNE[@]}" \) -prune -o -type f -print 2>/dev/null | grep -iE '/(nul|con|prn|aux|com[1-9]|lpt[1-9])(\.[^/]*)?$' || true)
if [[ -n "$bad" ]]; then while IFS= read -r f; do fail "예약 이름 파일: $f (2>NUL 대신 2>/dev/null)"; done <<< "$bad"; else pass "예약 이름 파일 없음"; fi

# 2 (추적 파일: git 이 판정한 작업 트리 줄바꿈 / 새 파일: 직접 확인)
crlf=$(git ls-files --eol 2>/dev/null | awk '$2=="w/crlf" || $2=="w/mixed" {print $NF}' | grep -vE '\.cmd$' || true)
while IFS= read -r f; do
  [[ -z "$f" || "$f" == *.cmd ]] && continue
  grep -qU $'\r' "$f" 2>/dev/null && crlf+=$'\n'"$f"
done < <(git ls-files --others --exclude-standard 2>/dev/null | grep -vE '\.(png|exe|zip|dll)$')
crlf=$(sed '/^$/d' <<< "$crlf")
if [[ -n "$crlf" ]]; then while IFS= read -r f; do fail "CRLF: $f (sed -i 's/\\r\$//' 로 LF 로)"; done <<< "$crlf"; else pass "CRLF 없음 (*.cmd 제외)"; fi

# 3
src=$(git grep --untracked -nIE '(^|[;&|({[:space:]`])(source|\.)[[:space:]]+env\.sh([[:space:]`;&|)]|$)' -- . ':!vendor' ':!docs/dev-*.md' ':!.claude/agents/harness-engineer.md' ':!tests/repo-hygiene.sh' 2>/dev/null | cut -d: -f1,2 || true)
if [[ -n "$src" ]]; then while IFS= read -r f; do fail "경로 없는 source env.sh: $f (source ./env.sh)"; done <<< "$src"; else pass "경로 없는 source env.sh 없음"; fi

# 4 (값은 출력하지 않는다)
PAT=(
  'anthropic:sk-ant-[A-Za-z0-9_-]{20,}'
  'groq:gsk_[A-Za-z0-9]{20,}'
  'openai:sk-(proj-)?[A-Za-z0-9_-]{32,}'
  'header:(x-api-key|authorization)"?[[:space:]]*[:=][[:space:]]*"?(Bearer[[:space:]]+)?[A-Za-z0-9_-]{24,}'
)
files=$( { git ls-files --others --exclude-standard; git diff --name-only HEAD; } 2>/dev/null | sort -u)
hit=0
while IFS= read -r f; do
  [[ -f "$f" ]] || continue
  for p in "${PAT[@]}"; do
    name="${p%%:*}" re="${p#*:}"
    while IFS= read -r ln; do [[ -n "$ln" ]] && { fail "키처럼 보이는 값 ($name): $f:$ln"; hit=1; }; done < <(grep -inIE "$re" "$f" 2>/dev/null | cut -d: -f1)
  done
done <<< "$files"
(( hit )) || pass "새 파일 · 고친 파일에 키처럼 보이는 값 없음"

(( F == 0 )) && { echo "저장소 위생 검사 통과"; exit 0; } || { echo "저장소 위생 검사 실패 $F 건"; exit 1; }
