#!/usr/bin/env bash
# [폐쇄망 PC / 인터넷 PC 공통]
# agent/oxy.env 값을 사용해 agent/templates/*.json 을 agent/*.json 으로 생성한다.
# oxy.env 가 없으면 예시 파일을 복사한다. 값을 바꾼 뒤에는 다시 실행하면 된다.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

AGENT="${OXY_AGENT_DIR:-$OXY_HOME/agent}"   # 테스트용으로 다른 디렉터리 지정 가능
if [[ ! -f "$AGENT/oxy.env" ]]; then
  cp "$AGENT/oxy.env.example" "$AGENT/oxy.env"
  warn "agent/oxy.env 를 예시값으로 생성함 → vLLM 주소/모델명을 수정한 뒤 다시 실행하세요"
fi
set -a
# shellcheck disable=SC1091
. "$AGENT/oxy.env"
set +a

# pi 가 사용할 Git Bash: 현재 Git 설치 루트의 bin/bash.exe (Git 을 다른 경로에 설치해도 동작)
OXY_SHELL_PATH="$(cygpath -m /)"; OXY_SHELL_PATH="${OXY_SHELL_PATH%/}/bin/bash.exe"
[[ -f "$OXY_SHELL_PATH" ]] || die "Git Bash 를 찾지 못함: $OXY_SHELL_PATH"
export OXY_SHELL_PATH
: "${OXY_CONTEXT_WINDOW:=131072}"; export OXY_CONTEXT_WINDOW

# 템플릿 치환은 설치 TUI 와 같은 코드(scripts/render-config.mjs)를 사용
"$OXY_HOME/runtime/node/node.exe" "$(winpath "$OXY_HOME/scripts/render-config.mjs")" "$(winpath "$AGENT")" \
  | while IFS= read -r f; do log "생성: $f"; done
[[ ${PIPESTATUS[0]} == 0 ]] || die "설정 생성 실패"

# 설치된 구성요소에 해당하는 skill 만 agent/skills 에 켠다 (원본: agent/skill-library). 사용자가 끈 OXY_SKILLS_OFF 는 뺀다
skills=$("$OXY_HOME/runtime/node/node.exe" "$(winpath "$OXY_HOME/installer/components.mjs")" sync-skills \
  --root "$(winpath "$OXY_HOME")" --agent "$(winpath "$AGENT")" --browser "${OXY_BROWSER:-}" --off "${OXY_SKILLS_OFF:-}") || die "skill 동기화 실패"
log "skill: ${skills:-(없음)}"

# 참고: vendor/agent-browser-skills 의 공식 skill 은 클라우드/Slack 등 폐쇄망과 무관한 내용이 많아
# 자동으로 연결하지 않는다. 축약 skill 은 agent/skills/agent-browser 에 별도로 둔다.

log "완료. 다음: just verify"
