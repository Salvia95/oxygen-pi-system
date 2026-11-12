# skill 선택 시험 (실제 LLM)

skill description 을 바꾸기 전(`before`)과 후보(`after`, `candidates.json`)를 비교한다.
pi 가 만든 첫 요청 본문을 그대로 쓰고 사용자 메시지만 28개 시험 문장으로 바꿔 실제 모델에 보낸 뒤,
첫 응답이 어떤 `skills/<name>/SKILL.md` 를 read 하는지로 판정한다.

- `run.sh` — before/after 첫 요청을 mock 으로 잡고(`*-request.json`), `eval.mjs` 를 실제 엔드포인트(agent/oxy.env)로 실행
- `eval.mjs` — 시험 문장(CASES) · 판정 · 표 출력. `results.json` 에 이미 있는 `variant#id` 는 건너뛰므로 **언제든 이어서 실행**된다
- `apply-desc.mjs` — `candidates.json` 의 description 을 skill 폴더의 SKILL.md 에 적용
- 문장 종류: P = 그 skill 을 읽어야 함 · N = 그 skill 을 읽으면 안 됨(alt 가 있으면 그쪽을 읽어야 함) · G = 아무 skill 도 필요 없음

## 진행 상황 (2026-11-12 중단)

진행 상태는 [진행판](../../docs/dev-board.md) 의 `skill-eval` 행이 기준이다. 이 표는 `results.json` 을 옮긴 것이다 (2026-11-12 기준 before 13개).

시험 모델 Groq `qwen/qwen3.8-27b` 의 사용량 제한(429)으로 중단. 이어서 하면 before #14 부터 시작한다.
`results.json` 에는 모델이 적혀 있지 않다. 같은 모델로 이어서 재야 비교할 수 있다 (재기 전에 `jq .main agent/llm.json` 으로 확인).

| variant | 완료 | 통과 |
|---|---|---|
| before (현재 description) | 13 / 28 | 13 (#6 은 모델 오류로 판정, ※) |
| after (후보) | 0 / 28 | – |

before 결과:

| # | 종류 | 기대 | 결과 | 판정 |
|---|---|---|---|---|
| 1 | P | find-code | find-code 읽음 | ✓ |
| 2 | N | find-code 아님 | grep | ✓ |
| 3 | P | structural-code-search | 읽음 | ✓ |
| 4 | N | structural-code-search 아님 | bash | ✓ |
| 5 | P | terminal-session-control | 읽음 | ✓ |
| 6 | N | terminal-session-control 아님 | Groq 400 tool call 검증 실패 (read 인자) | ✓ ※ |
| 7 | P | project-task-running | 읽음 | ✓ |
| 8 | N | project-task-running 아님 | ls | ✓ |
| 9 | P | json-querying | 읽음 (2026-11-12 다시 잼) | ✓ |
| 10 | N | json-querying 아님 | read | ✓ |
| 11 | P | gitlab-workflow | 읽음 | ✓ |
| 12 | N | gitlab-workflow · github-workflow 아님 | bash | ✓ |
| 13 | P | github-workflow | 읽음 | ✓ |

※ #6 은 skill 을 읽지 않았으므로 N 기준으로는 통과지만, 모델이 깨진 tool call 을 만들어 선택을 본 것이 아니다.
다시 판정하려면 `results.json` 에서 `before` #6 항목을 지우고 실행한다 (지운 사실을 보고한다).

## 이어서 실행

```bash
# 메모리 부족 정리를 끄려면 Claude Code 를 CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP=1 로 시작
bash tests/skill-eval/run.sh 2>&1 | tee -a tests/skill-eval/run.log
```

- 같은 엔드포인트로 다른 실제 LLM 요청(검증·계열 시험 등)을 동시에 보내지 않는다 (한도를 같이 소모)
- `eval.mjs` 프로세스가 하나만 돌고 있는지 확인한다 (여러 개면 한도와 results.json 을 함께 씀)
- 끝나면 표가 출력된다. after 가 before 보다 나빠지지 않으면 `apply-desc.mjs agent/skill-library` 로 후보를 반영하고,
  SKILL.md frontmatter 가 YAML 로 파싱되는지(평문 값에 `": "` 금지) 점검하는 단위 시험을 함께 추가한다
