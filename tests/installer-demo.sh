#!/usr/bin/env bash
# 설치 TUI 체험: mock vLLM 을 띄우고 sandbox 모드로 설치 TUI 를 연다.
# 실제 PATH(레지스트리)·바탕화면·AppData 는 건드리지 않으며, 끝나면 sandbox 폴더를 지운다.
# Windows Terminal 의 Git Bash 탭에서 실행하세요 (mintty 창에서는 winpty 를 거칩니다).
source "$(dirname "${BASH_SOURCE[0]}")/../scripts/lib.sh"
NODE="$OXY_HOME/runtime/node/node.exe"
PORT="${OXY_DEMO_PORT:-18097}"
SB="$(mktemp -d)"; trap 'kill "${MOCK_PID:-}" 2>/dev/null || true; rm -rf "$SB"' EXIT
"$NODE" "$(winpath "$OXY_HOME/tests/mock-vllm.mjs")" "$PORT" "$(winpath "$SB/req.jsonl")" >/dev/null & MOCK_PID=$!
for _ in $(seq 50); do curl -fs "http://127.0.0.1:$PORT/v1/models" >/dev/null 2>&1 && break; sleep 0.1; done

log "mock vLLM 주소: http://127.0.0.1:$PORT   (vLLM 단계에서 입력, API 키는 아무 값)"
log "sandbox: $(winpath "$SB")   (종료 시 삭제)"
read -r -p "Enter 를 누르면 설치 TUI 를 시작합니다..." _
cmd=("$NODE" "$(winpath "$OXY_HOME/installer/install.mjs")" --sandbox "$(winpath "$SB")")
if [[ "${TERM_PROGRAM:-}" == mintty ]] && command -v winpty >/dev/null 2>&1; then winpty "${cmd[@]}"; else "${cmd[@]}"; fi
