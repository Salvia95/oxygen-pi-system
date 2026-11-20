# skill 선택 시험 (실제 LLM)

skill description 을 바꾸기 전(`before`)과 후보(`after`, `candidates.json`)를 비교한다.
pi 가 만든 첫 요청 본문을 그대로 쓰고 사용자 메시지만 시험 문장(36개, #29~#36 은 2026-11-14 추가)으로 바꿔 실제 모델에 보낸 뒤,
첫 응답이 어떤 `skills/<name>/SKILL.md` 를 read 하는지로 판정한다.

- `run.sh` — before/after 첫 요청을 mock 으로 잡고(`*-request.json`), `eval.mjs` 를 실제 엔드포인트(agent/oxy.env)로 실행
- `eval.mjs` — 시험 문장(CASES) · 판정 · 표 출력. `results.json` 에 이미 있는 `variant#id` 는 건너뛰므로 **언제든 이어서 실행**된다
- `apply-desc.mjs` — `candidates.json` 의 description 을 skill 폴더의 SKILL.md 에 적용
- 문장 종류: P = 그 skill 을 읽어야 함 · N = 그 skill 을 읽으면 안 됨(alt 가 있으면 그쪽을 읽어야 함) · G = 아무 skill 도 필요 없음
- `avoid`: 첫 응답의 bash 명령에 그 습관(oxy-tool-hints 와 같은 판정: `bash-grep` 파일 검색 · `bash-cat` 소스 읽기 · `curl`)이 있으면 실패 (#32~#34)
- `run-claude.sh` · `capture-claude.mjs` — Anthropic(Claude) 연결용. pi 를 `tests/mock-anthropic.mjs` 에 붙여 첫 `/v1/messages` 본문과 `anthropic-beta` 헤더를 잡고(`*-claude-request.json`), 실제 모델로 판정한다. 결과는 `results-claude.json` (각 기록에 `model`)

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

## Claude Haiku 5.5 측정 (2026-11-14, `results-claude.json`)

판정 모델: `anthropic-claude/claude-haiku-5-5:low` (설치본 agent 폴더의 llm.json · secrets.json 연결, thinking = adaptive · effort low). Groq qwen 의 `results.json` 과 섞어 비교하지 않는다.
시스템 프롬프트: before 11,738자 → after 12,544자 (skill 12개: 저장소 bin 기준이라 설치본(11개)보다 oracle-db-querying 하나 많다).

after 후보 = http-api-testing description 교체 + AGENTS.md 의 "Which tool for common actions" 절 (둘 다 반영함, 근거: 아래 표 · `tests/scenario-eval/results-habit.jsonl`).

| variant | 완료 | 전체 | P | N | G | 실패 |
|---|---|---|---|---|---|---|
| before | 36 / 36 | 33 | 12/15 | 15/15 | 6/6 | #1 #7 #19 |
| before-r2 | 36 / 36 | 33 | 12/15 | 15/15 | 6/6 | #1 #7 #9 |
| after | 36 / 36 | 34 | 13/15 | 15/15 | 6/6 | #1 #7 |
| after-r2 | 36 / 36 | 36 | 15/15 | 15/15 | 6/6 | – |

- 처음 실행 36건은 `anthropic-beta` 헤더를 빼고 보내 모두 400 (`messages.1.output_config: Extra inputs are not permitted`) 이었다. 측정 도구 오류라 그 36건을 지우고 다시 쟀다 (모델 응답 없음).
- 실패 원인: #1 은 `fd --changed-within` + `grep -c` 를 바로 실행(find-code 를 안 읽음, 결과는 맞는 방법), #7 은 justfile 을 바로 읽거나 `cat` (skill 을 안 읽음), #19 · #9 는 skill 없이 bash 로 시작. 모두 (a) description 쪽, 도구 오류(c) 없음.

### gitlab-workflow 본문 수정 확인 (2026-11-20, 같은 모델 `anthropic-claude/claude-haiku-5-5:low`)

본문 35줄 `glab api …/changes --jq …` → `glab api …/changes | jq -r …` (glab 1.128.0 의 `glab api` 에 `--jq` 가 없다). description 은 그대로.
시스템 프롬프트(지금 작업 트리 47ae34e + 이 수정): 12,558자 (본문은 시스템 프롬프트에 들어가지 않으므로 이 수정으로 바뀌는 크기는 0).

| variant | 완료 | 전체 | P | N | G | 실패 |
|---|---|---|---|---|---|---|
| glab-fix (#11 · #12 · #14 만) | 3 / 3 | 3 | 1/1 | 2/2 | – | – |

같은 세 사례는 before · before-r2 · after · after-r2 에서도 모두 통과였다 (나빠짐 없음).

사용 판정 `results-claude-usage.json` (kind `U`): 문장 "사내 GitLab MR !123 에서 바뀐 파일 목록만 보여줘" 를 pi 첫 요청에 넣고, 모델이 read 한 SKILL.md 원문을 tool_result 로 준 뒤 다음 응답의 bash 명령을 본다
(GitLab 서버가 없어 glab 은 실행하지 않는다). 통과 = skill 을 읽고, 바뀐 파일 목록 명령을 냈고, `glab api` 조각에 `--jq` 가 없음.

| variant | 본문 | 통과 | 낸 명령 |
|---|---|---|---|
| glab-fix | 수정 뒤 | 3/3 | 3회 모두 `glab api projects/:id/merge_requests/123/changes … \| jq -r …` |
| head-old (대조) | 수정 전 (HEAD) | 0/3 | 3회 모두 `glab api projects/:id/merge_requests/123/changes -F json --jq …` |

### 이어서 실행

```bash
# 후보를 바꿔 잴 때: SKILL_EVAL_CANDIDATES=<description json> SKILL_EVAL_AGENTS=<AGENTS.md> 로 after 구성을 준다. 이미 있는 variant#id 는 건너뛴다
bash tests/skill-eval/run-claude.sh "$LOCALAPPDATA/Programs/oxygen-pi/agent" anthropic-claude/claude-haiku-5-5:low -r3
```

## 이어서 실행 (Groq qwen, `results.json`)

```bash
# 메모리 부족 정리를 끄려면 Claude Code 를 CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP=1 로 시작
bash tests/skill-eval/run.sh 2>&1 | tee -a tests/skill-eval/run.log
```

- 같은 엔드포인트로 다른 실제 LLM 요청(검증·계열 시험 등)을 동시에 보내지 않는다 (한도를 같이 소모)
- `eval.mjs` 프로세스가 하나만 돌고 있는지 확인한다 (여러 개면 한도와 results.json 을 함께 씀)
- 끝나면 표가 출력된다. after 가 before 보다 나빠지지 않으면 `apply-desc.mjs agent/skill-library` 로 후보를 반영하고,
  SKILL.md frontmatter 가 YAML 로 파싱되는지(평문 값에 `": "` 금지) 점검하는 단위 시험을 함께 추가한다
