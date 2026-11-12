#!/usr/bin/env bash
# 실제 pi + 실제 모델(agent/llm.json 의 LLM 연결) 시나리오 평가
#   bash tests/scenario-eval/run.sh <label> [--only a,b] [--tools read,bash,...] [--model [연결/]모델] [--level id] [--thinking 수준] [--set K=V] [--minutes N] [--rebuild] [--base-url URL]
#   bash tests/scenario-eval/run.sh --report
set -euo pipefail
E="$(cd "$(dirname "$0")" && pwd)"
cd "$E/../.."; source ./env.sh   # ./ 없이 쓰면 PATH 에 등록된 설치본의 env.sh 를 먼저 찾는다
if [[ "${1:-}" == --report ]]; then shift; exec "$OXY_NODE" "$(cygpath -m "$E/report.mjs")" "$@"; fi
exec "$OXY_NODE" "$(cygpath -m "$E/run.mjs")" "$@"
