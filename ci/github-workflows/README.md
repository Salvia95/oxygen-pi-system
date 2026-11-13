# 보류한 GitHub Actions workflow

CI 적용은 보류했다 (사용자, 2026-11-13: "CI 적용은 아직 하지 않을거고, 필요 시 로컬에서만 진행할거야").
이 폴더의 파일은 GitHub 가 실행하지 않는다. 적용하기로 하면 `.github/workflows/` 로 옮긴다 (계획은 `docs/skill-combo-spec.md` §4).

- `ci.yml` — 모든 push · PR: 위생 · 단위 · E2E(mock) · Rust. 2026-11-13 GitHub 에서 한 번 통과(run 43363974266)한 상태 그대로.
- `skill-eval.yml` — 하이쿠로 skill 상황 시험. 비밀(`llm-eval` Environment 의 `ANTHROPIC_API_KEY`)이 필요하고 한 번도 실행하지 않았다.

로컬에서 같은 것을 돌리는 법:

```bash
source ./env.sh && just test                       # 위생 · 단위 · E2E (ci.yml 과 같다)
just tui-test                                       # Rust
bash tests/scenario-eval/run.sh <label> --suite combo --model anthropic-claude/claude-haiku-5-5 --thinking low \
  --llm-from "$(cygpath -m "$LOCALAPPDATA/Programs/oxygen-pi/agent")"   # 키가 있는 agent 폴더
bash tests/scenario-eval/run.sh --report --suite combo --gate <label>   # 기준선(baseline-combo.json)과 비교, 통과 0 · 실패 1
```
