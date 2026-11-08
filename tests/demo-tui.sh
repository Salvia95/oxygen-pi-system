#!/usr/bin/env bash
# 실제 vLLM 없이 하네스 TUI 를 직접 써 보는 데모.
# mock vLLM 을 띄우고 임시 agent 디렉터리(실제 agent/ 설정과 동일한 extension·AGENTS.md)로 pi TUI 를 연다.
#   bash tests/demo-tui.sh            # TUI
#   bash tests/demo-tui.sh -p "..."   # 추가 인자는 pi 로 전달
#
# TUI 에서 입력해 볼 프롬프트 (mock 이 정해진 도구 호출을 돌려줌):
#   scenario:env              Git Bash 에서 bash 도구 실행, 번들 도구 경로 확인
#   scenario:git-push         bash-guard 확인 창 (허용/세션 허용/거부)
#   scenario:offline-install  npm install 차단
#   scenario:edit-unread      읽지 않은 파일 edit 차단
#   scenario:read-then-edit   read → edit 정상 수정 (작업 폴더의 sample.txt)
#   scenario:big-output       긴 출력 축약
#   scenario:text-toolcall    텍스트 tool call 감지 → 재호출 안내
#   scenario:repeat           같은 호출 반복 차단
source "$(dirname "${BASH_SOURCE[0]}")/../scripts/lib.sh"
# shellcheck disable=SC1091
source "$OXY_HOME/env.sh"

PORT="${OXY_DEMO_PORT:-18090}"
TMP="$(mktemp -d)"; trap 'kill "${MOCK_PID:-}" 2>/dev/null || true; rm -rf "$TMP"' EXIT
mkdir -p "$TMP/agent" "$TMP/work"
cp -r "$OXY_HOME/agent/AGENTS.md" "$OXY_HOME/agent/templates" "$OXY_HOME/agent/bin" "$OXY_HOME/agent/extensions" "$TMP/agent/"
cat > "$TMP/agent/oxy.env" <<ENV
OXY_VLLM_BASE_URL=http://127.0.0.1:$PORT/v1
OXY_VLLM_API_KEY=mock-key
OXY_MODEL_CODER=qwen3.6-coder-30b
OXY_MODEL_GENERAL=qwen3.8-27b
OXY_DEFAULT_MODEL=qwen3.6-coder-30b
OXY_CONTEXT_WINDOW=131072
ENV
OXY_AGENT_DIR="$TMP/agent" bash "$OXY_HOME/scripts/configure.sh" >/dev/null
export PI_CODING_AGENT_DIR="$(winpath "$TMP/agent")" OXY_VLLM_API_KEY=mock-key
printf 'hello world\n' > "$TMP/work/sample.txt"

"$OXY_NODE" "$(winpath "$OXY_HOME/tests/mock-vllm.mjs")" "$PORT" "$(winpath "$TMP/requests.jsonl")" >/dev/null & MOCK_PID=$!
for _ in $(seq 50); do curl -fs "http://127.0.0.1:$PORT/v1/models" >/dev/null 2>&1 && break; sleep 0.1; done

log "mock vLLM: 127.0.0.1:$PORT  /  작업 폴더: $(winpath "$TMP/work")  (종료 시 자동 삭제)"
log "프롬프트에 scenario:git-push 등을 입력해 보세요. 목록: sed -n '7,15p' tests/demo-tui.sh"
cd "$TMP/work"
"$OXY_NODE" "$OXY_PI_CLI" "$@"
