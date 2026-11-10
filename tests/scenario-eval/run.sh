#!/usr/bin/env bash
# 실제 pi + 실제 모델(agent/oxy.env 의 엔드포인트) 시나리오 평가
#   bash tests/scenario-eval/run.sh <label> [--only a,b] [--tools read,bash,...] [--model id] [--set K=V] [--minutes N] [--rebuild]
#   bash tests/scenario-eval/run.sh --report
set -euo pipefail
E="$(cd "$(dirname "$0")" && pwd)"
cd "$E/../.."; source env.sh
if [[ "${1:-}" == --report ]]; then shift; exec "$OXY_NODE" "$(cygpath -m "$E/report.mjs")" "$@"; fi
exec "$OXY_NODE" "$(cygpath -m "$E/run.mjs")" "$@"
