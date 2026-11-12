#!/usr/bin/env bash
# skill description 시험: 현재(before) / 후보(after) 구성으로 pi 첫 요청을 잡고, 실제 모델(agent/llm.json 의 기본 모델)로 판정
set -euo pipefail
H="$(cd "$(dirname "$0")/../.." && pwd)"
E="$(cd "$(dirname "$0")" && pwd)"
cd "$H"; source ./env.sh   # ./ 없이 쓰면 PATH 에 등록된 설치본의 env.sh 를 먼저 찾는다
# 판정 모델은 eval.mjs 가 agent/llm.json 의 기본 모델 · 연결에서 읽는다 (키는 secrets.json, 셸 변수를 거치지 않는다)
PORT=18172
"$OXY_NODE" tests/mock-vllm.mjs $PORT "$(cygpath -m "$E/mock.jsonl")" >/dev/null & M=$!
trap 'kill $M 2>/dev/null || true' EXIT
sleep 1
for v in before after; do
  T="$E/$v"; rm -rf "$T"; mkdir -p "$T/agent" "$T/work"
  cp -r agent/AGENTS.md agent/templates agent/bin agent/extensions agent/skill-library agent/agents "$T/agent/"
  grep -vE "^OXY_VLLM_BASE_URL|^OXY_VLLM_API_KEY|^OXY_MODEL_|^OXY_DEFAULT_MODEL" agent/oxy.env > "$T/agent/oxy.env"
  printf 'OXY_VLLM_BASE_URL=http://127.0.0.1:%s/v1\nOXY_VLLM_API_KEY=k\nOXY_MODEL_CODER=qwen3.6-coder-30b\nOXY_MODEL_GENERAL=qwen3.8-27b\nOXY_DEFAULT_MODEL=qwen3.6-coder-30b\n' "$PORT" >> "$T/agent/oxy.env"

  OXY_AGENT_DIR="$T/agent" bash scripts/configure.sh >/dev/null
  # configure 는 하네스의 skill-library 에서 복사하므로, 복사된 agent/skills 에 후보를 적용한다
  if [[ $v == after ]]; then "$OXY_NODE" "$E/apply-desc.mjs" "$(cygpath -m "$T/agent/skills")"; fi
  : > "$E/mock.jsonl"
  (cd "$T/work" && git init -q && PI_CODING_AGENT_DIR="$(cygpath -m "$T/agent")" OXY_VLLM_API_KEY=k OXY_FLOW=off \
    timeout 120 "$OXY_NODE" "$OXY_PI_CLI" --no-session -p "hi" </dev/null >/dev/null 2>&1) || true
  head -1 "$E/mock.jsonl" | jq '.body' > "$E/$v-request.json"
  echo "captured $v: system $(jq -r '.messages[0].content' "$E/$v-request.json" | wc -c)자, skills $(jq -r '.messages[0].content' "$E/$v-request.json" | grep -c '<name>')개"
done
kill $M
env -u OXY_VLLM_BASE_URL -u OXY_VLLM_API_KEY -u OXY_MODEL_CODER \
  "$OXY_NODE" "$E/eval.mjs" "$(cygpath -m "$E/results.json")" "before=$(cygpath -m "$E/before-request.json")" "after=$(cygpath -m "$E/after-request.json")"
