# 여러 skill 상황 시험 · CI 계획 명세

실제 모델(Claude Haiku)에게 **도구 · skill 이름 없이 상황만** 주고, 한 작업에 skill 2~3개를 함께 써야 끝나는 일을 시켜, skill 들이 실제 작업에서 제 역할을 하는지 잰다.
그 결과를 CI(GitHub Actions)에 넣는 계획을 함께 정한다.
진행 상태: [진행판](dev-board.md) 의 `skill-combo` 행.

요청 (사용자, 2026-11-13)
- 스킬 테스트를 더 명확히 만든다. 직접 haiku 를 사용해 여러 도구를 활용해서 수행하는 테스트를 만든다.
- 바이너리나 스킬을 직접 언급하지 않고 상황을 말해서, 한 번 작업에 2~3개 스킬이 활용되게 한다.
- 실행 결과를 CI 파이프라인에 포함시킬 계획을 세운다.

결정된 사항 (사용자, 2026-11-13: "권장안대로 진행할게")
- 이 명세를 승인했다. C0 (a) skill 이 상황에서 쓰이도록 고치는 작업은 skill-evaluator 에 맡기고 이 combo 시험으로 전후를 잰다, C0-1 (a) 측정 때 PC 의 Python 을 숨긴다,
  C1 (a) `ci.yml` 도 만든다, C2 (a) `skill-eval.yml` 은 수동 + 매일 1번 + `skill-eval` 레이블, C3 (a) 2번 중 1번 합격, C5 (a) 2주 보고만 한 뒤 필수 검사. C4(비밀 등록 · 월 한도)는 사용자가 한다.

## 1. 지금 있는 시험과 이 시험의 차이

| 시험 | 무엇을 보나 | 한계 |
| --- | --- | --- |
| `tests/skill-eval` | 첫 응답이 맞는 `SKILL.md` 를 read 하는지 (한 문장 · 한 skill) | 실제로 그 도구를 써서 일을 끝냈는지는 모른다. 2026-11-12 Groq 한도로 13/28 에서 멈춤 |
| `tests/scenario-eval` (base) | 실제 pi 로 끝까지 돌려 답이 맞는지 · 요청 수 · 토큰 (ls · find · grep · docs) | 도구 하나짜리 과제. skill 을 함께 쓰는지는 보지 않는다 |
| **`tests/scenario-eval --suite combo` (이 명세)** | 상황만 준 여러 단계 작업을 끝까지: 결과물이 맞는지 + 기대한 skill 의 명령을 실제로 실행했는지 + 그 skill 문서를 읽었는지 + 비용 | 모델 응답에 흔들림이 있다 (§4 반복) |

## 2. 시나리오 (`tests/scenario-eval/combo.mjs`)

프롬프트 규칙: 도구 이름(`jq` · `usql` · `hurl` …)과 skill 이름을 쓰지 않는다. 사람이 동료에게 부탁하듯 상황 · 원하는 결과만 쓴다.
자료 규칙: 기대한 skill 없이는 잘 끝나지 않게 만든다 (JSON 이 커서 read 로는 잘린다, 호출 지점이 12곳이라 하나씩 고치기 어렵다, 실행 방법이 justfile 에만 있다).

| ID | 상황 (프롬프트 요지) | 기대 skill | 결과물 판정 |
| --- | --- | --- | --- |
| `sales` | `data/shop.db` 의 주문과 `reports/customer-tiers.json`(84KB)의 고객 등급을 맞춰 gold 고객의 결제 완료 합계를 고객별로 | sql-querying · json-querying | 5명의 합계가 모두 답에 있음 |
| `api` | 로컬 주문 API 의 status 필터가 맞는지 확인, 다시 돌릴 수 있게 확인 내용을 파일로, shipped 중 500 넘는 주문 번호 | http-api-testing · json-querying | `.hurl` 파일이 남음 + 섞인 cancelled 를 결함으로 보고 + 큰 주문 14개 |
| `deprecate` | 곧 지울 `legacyTotal()` 의 실제 호출만 `newTotal()` 로 (주석 · 로그 문자열은 그대로), 프로젝트의 검사 명령으로 확인 | structural-code-search · project-task-running | 호출 0/12 남음, 주석 · 문자열 17곳 그대로, 검사 통과 |
| `failtest` | 테스트가 깨졌다는 연락: 원인을 찾아 고치고 프로젝트가 정한 방법으로 다시 확인 | project-task-running · find-code · json-querying | 테스트 통과, `baseDelayMs` 가 숫자 100, 나머지 설정(기능 120 · 채널 40) 그대로 |

자료는 시나리오마다 `setup(dir)` 이 만든다 (SQLite 는 번들의 `usql` 로, API 는 실행 중에만 뜨는 로컬 HTTP 서버). 정답도 같은 코드에서 계산한다.
LLM 없이 판정이 맞는지: 손대지 않은 자료는 4개 모두 FAIL, 정답대로 고친 자료는 4개 모두 PASS (2026-11-13 확인).

## 3. 기록과 판정

`tests/scenario-eval/results-combo.jsonl` 에 한 줄씩 (키는 저장하지 않는다, 경로의 사용자 이름은 `scrub.mjs` 가 가린다):

- `pass`: 결과물 판정 (위 표).
- `skills`: 기대 skill 마다 `{skill, read, ran}`. `read` = 그 `SKILL.md` 를 read 했는지, `ran` = 그 skill 의 명령(`usql` · `jq` · `hurl` · `ast-grep`/`sg` · `just` · `rg`/`fd`)을 bash 로 실행했는지 (명령 머리 낱말로 판정).
  `skillsUsed`/`skillsExpected` 는 `ran` 기준이다. 읽지 않고 바로 써도 쓴 것으로 본다. 읽기만 하고 안 쓰면 쓰지 않은 것.
- `requests` · `inTok` · `outTok` · `cost`(pi 가 계산한 금액, USD) · `seconds` · `calls`(도구별 호출 · 출력 크기).

시나리오 하나의 **합격**: `pass` 이고 `skillsUsed >= 2` (기대 skill 이 3개여도 2개 이상이면 합격. 모델이 같은 일을 다른 skill 로 해낼 수 있어서).

실행:

```bash
bash tests/scenario-eval/run.sh combo-r1 --suite combo --model anthropic-claude/claude-haiku-5-5 --thinking low \
  --llm-from "$(cygpath -m "$LOCALAPPDATA/Programs/oxygen-pi/agent")"   # 키가 있는 agent 폴더 (저장소 키가 무효일 때)
bash tests/scenario-eval/run.sh --report --suite combo
```

## 4. CI 계획

### 지금

- GitHub Actions 는 `oxy-tui-release.yml`(태그를 push 하면 화면 프로그램을 빌드해 Release 에 올림) 하나뿐이다. 단위 · E2E(mock) 도 CI 에서 돌지 않고, 부모가 PC 에서 `just test` 로 돌린다.
- 시험에 번들(Node · pi · 도구 exe)이 필요하다. 저장소에는 바이너리가 없고 `scripts/fetch-bundle.sh` 가 공식 배포처에서 받아 sha256 을 확인한다.
- 실제 LLM 키는 이 PC 에서는 DPAPI(`secrets.json`)에 있다. CI 러너에는 DPAPI 저장소가 없다.

### 두 개의 workflow

| workflow | 언제 | 무엇을 | 비용 · 비밀 |
| --- | --- | --- | --- |
| `ci.yml` (새로) | 모든 push · PR | `just hygiene` · `just unit` · `just e2e`(mock LLM) · `cargo test` | 없음 (비밀 없이 돈다, fork PR 도 안전) |
| `skill-eval.yml` (새로) | 수동 실행 · 매일 1번(main) · PR 에 `skill-eval` 레이블을 붙였을 때 | `run.sh ci-<sha>-r<n> --suite combo` 를 2번, 결과 표를 Job Summary 에, `results-combo.jsonl` · 이벤트 로그를 artifact 로 | Anthropic 키(비밀) · 실행당 비용 (§5 실측) |

공통 준비 (windows-latest, Git Bash 는 러너에 있음):

1. `actions/cache` 로 번들 캐시 (키: `manifest/tools.lock.tsv` 와 npm lockfile 의 해시). 없으면 `bash scripts/fetch-bundle.sh --select=just,hurl,usql,ast-grep` (필수 node · pi · fd · rg · jq + 시험에 쓰는 것만, 브라우저 · SQLcl 은 받지 않는다).
2. `ci.yml` 은 여기까지 + 시험. `skill-eval.yml` 은 아래를 더한다.
3. LLM 연결: 저장소의 `agent/llm.json` 대신 시험용 연결을 만든다 (Anthropic 연결 하나, 모델 `claude-haiku-5-5`). 키는 비밀 `ANTHROPIC_API_KEY`(+ 필요하면 `ANTHROPIC_WORKSPACE_ID`)에서 환경변수로만 넘긴다.
   → `run.mjs` 에 `--key-env <변수>` 를 더한다 (DPAPI 를 거치지 않고 그 값을 `OXY_LLM_INHERIT_KEYS` 로 pi 에 넘긴다. 로그 · 결과 파일에 키를 쓰지 않는 것은 지금과 같다).
4. 판정과 종료 코드: `report.mjs --suite combo --gate` 가 반복 2번을 합쳐 시나리오별 결과를 내고, 아래 규칙으로 종료 코드를 정한다.
   - 시나리오는 2번 중 1번 이상 합격이면 통과 (모델 흔들림 흡수).
   - 기준선(`tests/scenario-eval/baseline-combo.json`, main 에서 사람이 갱신)보다 통과 시나리오가 줄면 실패.
5. 결과 보관: artifact(90일) + Job Summary 표. CI 가 저장소에 결과를 커밋하지는 않는다 (기준선 갱신은 사람이 PR 로).

보호 장치:
- 비밀은 GitHub Environment `llm-eval` 에 두고, 그 환경에 승인자를 둔다 (공개 저장소라 레이블 실행도 승인 뒤에만 키가 열린다). fork PR 에는 비밀이 열리지 않는다.
- Anthropic 쪽에서 이 키의 워크스페이스에 월 사용 한도를 건다. workflow 는 `concurrency` 로 한 번에 하나만, `timeout-minutes: 60`.
- `run.mjs` 의 도구 호출 상한(25) · 시나리오 시간 상한(7분)은 그대로 둔다.

### 폐쇄망 사이트와의 관계

CI 는 Claude Haiku 로 잰다. 사이트의 vLLM(Qwen)은 GitHub 러너에서 닿지 않는다. 사이트 모델 결과는 사이트 PC 에서 같은 명령(`--model vllm/<모델>`)으로 따로 잰다.
나중에 사이트에 self-hosted runner 를 둘 수 있으면 같은 `skill-eval.yml` 에 러너 · 모델만 바꾼 job 을 더한다.

## 5. 실측 (2026-11-13)

조건: 대화형이 아닌 pi 1.5.0 (`--mode json`), `anthropic-claude/claude-haiku-5-5` thinking low, 키는 설치본 agent 폴더(`--llm-from`), oxy-flow 끔, 도구 출력 상한 4000자. 두 번(`combo-r1` · `combo-r2`), 합쳐 약 $0.025.

| 시나리오 | 결과 r1 / r2 | skill 실행 r1 / r2 | 실제로 쓴 방법 |
| --- | --- | --- | --- |
| `sales` | PASS / PASS | 0/2 · 1/2 | PC 의 Python(`sqlite3` 모듈 · `json`)으로 한 번에 계산. r2 는 `jq` 를 함께 씀. `usql` 은 한 번도 안 씀 |
| `api` | FAIL※ / PASS | 1/2 · 1/2 | `curl` + `jq` 로 확인하고 bash 스크립트를 남김. `hurl` 은 안 씀 |
| `deprecate` | FAIL(호출 25회 상한) / PASS | 1/2 · 1/2 | grep 으로 찾고 edit 로 하나씩 (12곳). 읽기 전 편집 금지 규칙에 7번 막혀 다시 읽음. `ast-grep` 은 안 씀. 검사는 `just check` |
| `failtest` | PASS / PASS | 2/3 · 2/3 | `just test` · `rg` · `fd` 로 찾고 edit 로 고침. `jq` 는 안 씀 |

※ r1 의 `api` 는 처음 판정이 `.hurl` 파일만 인정해서 FAIL 이었다. 요청은 "다시 돌릴 수 있는 확인 파일" 이므로 결과물 판정을 "확인 파일(.hurl · 스크립트)이 남음" 으로 고쳤다 (어떤 skill 로 했는지는 skills 기록이 따로 본다).

본 것:
- **8번 모두 `SKILL.md` 를 한 번도 읽지 않았다.** skill 목록은 시스템 프롬프트에 있었다 (스냅샷 `agent/skills` 에 13개). 하이쿠는 이름을 아는 도구(`just` · `rg` · `fd` · `jq` · `curl`)와 PC 의 Python 으로 일을 끝냈다.
- 결과는 대부분 맞았다 (8번 중 6 PASS, 판정 수정 뒤 7). skill 을 쓰지 않아도 일은 되지만, 사이트 PC 에 Python 이 없으면 `sales` 같은 일의 방법이 사라진다.
- 합격(결과 PASS + skill 2개 이상): r1 1/4, r2 1/4. 기대 skill 중 `usql` · `hurl` · `ast-grep` 은 8번 동안 한 번도 실행되지 않았다.
- 읽기 전 편집 금지(`oxy-read-before-edit`)에 막힌 편집이 `deprecate` 에서 매번 7번 나왔다 (호출 낭비의 대부분).
- **Python 을 숨기면 (C0-1, `hide-r1`, $0.010)**: 결과는 4개 모두 PASS. `sales` 가 `usql` + `jq` 로 바뀌어 2/2, `failtest` 3/3 (`jq` 까지), `api` 1/2(`hurl` 안 씀), `deprecate` 1/2(`ast-grep` 안 씀, 이번에는 bash 로 바꿈). 합격 2/4. 여전히 `SKILL.md` 를 읽은 적은 없다.
  두 번째(`hide-r2`)는 이 PC 의 메모리가 부족해 Claude Code 가 중간에 멈췄다 (기록 없음). 기준선(`baseline-combo.json`)은 `hide-r1` 하나로 정했다: 합격 `sales` · `failtest`.
- **skill 튜닝 (C0, skill-evaluator, $0.044)**: description 4개(sql-querying · json-querying · http-api-testing · structural-code-search)를 도구 이름이 아니라 상황으로 시작하게 바꾸고, AGENTS.md 에 "스크립트나 curl · sed · python 을 쓰기 전에 skill 목록을 보고, 맞는 것이 있으면 읽고 그 도구를 쓴다" 한 줄.
  before(`hide-r1` · `before-r2`) 합격 2/4 → after(`after-r1` · `after-r2`) 3/4 (api 새로 합격), 기본 suite 8/8 → 8/8, 첫 요청 +141 토큰. 반영했다. 본문은 바꾸지 않았다.
  찾은 측정 결함 두 가지 (부모가 고침): (1) `--hide` 가 WindowsApps 의 앱 실행 별칭 · `C:\Windows\py.exe` 를 숨기지 못해 before-r2 · after 의 sales 가 실제로 python3 을 썼다 → PATH 맨 앞에 "command not found" 대역을 두는 방식으로 (폴더를 빼면 C:\Windows 까지 빠진다).
  (2) `deprecate` 는 모든 호출이 `orders.legacyTotal(` 한 모양이라 sed 한 줄로 풀렸다 → 받는 객체 · this · 메서드 체인 · 여러 줄 호출로 다양하게, 로그 문자열에 같은 글자를 넣어 글자 바꾸기는 FAIL (LLM 없이 확인: 손대지 않음 FAIL · sed FAIL · 구문 바꾸기 PASS).
- **고친 조건으로 다시 (`v2-r1` · `v2-r2`, $0.027)**: 두 번 모두 **합격 4/4**. skill 실행 2/2 · 2/2 · 2/2 · 2~3/3, `SKILL.md` 읽음 sql · http-api · structural-code-search (처음으로 읽기 시작). 기준선(`baseline-combo.json`)을 4개 모두 합격으로 갱신했다.
- 측정 고침: Claude 는 첫 요청 입력이 `cacheWrite` 로 오므로, 입력 토큰에 `cacheWrite` 를 더했다 (r1 의 `first=4` 는 이 때문).

## 6. 구현 순서와 확인 방법

1. combo 시나리오 · 기록 (§2 §3) — 담당: 부모. 확인: LLM 없이 판정 검사(손대지 않음 FAIL · 정답 PASS) + 하이쿠 실측 1회
2. `report.mjs` 의 combo 표 · `--gate` · `run.mjs` 의 `--key-env` — 담당: 부모. 확인: 단위(판정 규칙) + 실측 결과로 표
3. `ci.yml` (mock 시험) — 담당: 부모 [승인 필요: workflow 추가 · push]
4. `skill-eval.yml` (하이쿠) — 담당: 부모 [승인 필요: 비밀 등록 · 비용 · push]. 확인: 수동 실행 1회의 Job Summary · artifact
5. 2주 동안은 결과만 보고(실패해도 막지 않음), 그 뒤 `skill-library` · `extensions` · `AGENTS.md` 를 바꾸는 PR 에 필수 검사로 (사용자 결정)

## 7. 정할 것

- 없음 (2026-11-13 사용자가 모두 (a) 로 정했다. 아래는 그때의 선택지와 이유다)

- C0 이 결과를 받고 할 일 — (a) skill 이 상황에서 쓰이도록 고치는 작업을 skill-evaluator 에 맡긴다 (description 을 도구 이름이 아니라 상황으로 시작, AGENTS.md 에 "스크립트를 직접 쓰기 전에 맞는 skill 을 본다" 한 줄 등. 이 combo 시험으로 전후를 재고 나빠지지 않은 것만 반영) (b) 지금은 측정만.
  권장 (a): 기대 skill 중 3개(`usql` · `hurl` · `ast-grep`)가 한 번도 쓰이지 않았다.
- C0-1 측정 환경에서 PC 의 Python 을 숨길까 — (a) 숨긴다 (사이트 PC 와 같게, PATH 에서 뺀 조건을 기본으로) (b) 그대로.
  권장 (a): 사이트 PC 에 Python 이 있는지 모르는 채로, 번들 도구만으로 되는지를 재는 것이 하네스의 목적에 맞다. 사이트에 Python 이 있다면 (b).

- C1 `ci.yml`(비용 없는 mock 시험)도 함께 만들까 — (a) 만든다 (b) skill-eval 만.
  권장 (a): 지금은 단위 · E2E 가 PC 에서만 돈다. 비밀 · 비용 없이 모든 PR 에서 돌릴 수 있다.
- C2 `skill-eval.yml` 이 도는 때 — (a) 수동 + 매일 1번 + 레이블 (b) 수동만 (c) skill · extension 을 바꾸는 모든 PR.
  권장 (a): 비용을 예측할 수 있고(하루 1번), 필요할 때 바로 돌릴 수 있다.
- C3 반복 횟수와 합격 규칙 — (a) 2번 중 1번 합격 (b) 3번 중 2번 (c) 1번.
  권장 (a): 비용과 흔들림의 균형. §5 실측의 흔들림을 보고 바꿀 수 있다.
- C4 비밀 · 한도 — 사용자가 GitHub 저장소 설정에 비밀(`ANTHROPIC_API_KEY`, 필요하면 워크스페이스 ID)을 등록하고 Anthropic 콘솔에서 월 한도를 정한다. 키 값은 대화 · 저장소에 쓰지 않는다.
- C5 막는 시점 — (a) 2주 보고만 한 뒤 필수 검사 (b) 처음부터 필수 (c) 계속 보고만.
