#!/usr/bin/env bash
# skill 선택 시험을 Anthropic(Claude) 연결로: pi 첫 요청을 mock 으로 잡고(capture-claude.mjs) 실제 모델로 판정(eval.mjs). 결과는 results-claude.json
#   bash tests/skill-eval/run-claude.sh <llm.json · secrets.json 이 있는 agent 폴더> <연결/모델:thinking> [반복 접미사 예: -r2]
#   SKILL_EVAL_CANDIDATES=<후보 description json> SKILL_EVAL_AGENTS=<후보 AGENTS.md> 로 after 구성을 정한다 (기본 candidates.json · candidate-AGENTS.md)
#   VARIANTS="before" 처럼 잴 구성만 고를 수 있다 (기본 "before after")
# 키는 eval.mjs 안에서만 복호화한다 (화면 · 결과 · 명령줄에 남기지 않는다)
set -euo pipefail
H="$(cd "$(dirname "$0")/../.." && pwd)"
E="$(cd "$(dirname "$0")" && pwd)"
cd "$H"; source ./env.sh
FROM="$1"; TARGET="$2"; SUF="${3:-}"
"$OXY_NODE" "$(cygpath -m "$E/capture-claude.mjs")" "$FROM" "$TARGET"
args=()
for v in ${VARIANTS:-before after}; do args+=("$v$SUF=$(cygpath -m "$E/$v-claude-request.json")"); done
SKILL_EVAL_LLM_FROM="$FROM" SKILL_EVAL_TARGET="$TARGET" "$OXY_NODE" "$(cygpath -m "$E/eval.mjs")" "$(cygpath -m "$E/results-claude.json")" "${args[@]}"
