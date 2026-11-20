# 구성요소 업데이트 검증

`manifest/tools.lock.tsv` 의 버전을 올릴 때(pi · Node · 도구 · 화면 프로그램 · 글꼴), 올린 구성요소에 기대는 곳을 모두 확인하는 검사 묶음과 절차를 정한다.
진행 상태: [진행판](dev-board.md) 의 `upgrade-check` 행.

요청 (사용자, 2026-11-20): "현재 oxygen pi의 구성 요소들이 의존성을 가지는 라이브러리들이 업데이트 되어도 독립적으로 동작할 수 있는지, 주요 업데이트가 있을 때 이들을 모두 테스트할 수 있는 테스트 셋이 준비되어있는지 확인해줘" → 점검 보고 뒤 "업데이트 검증 명세로 가자".

결정된 사항 (사용자, 2026-11-20: D1~D4 모두 권장안 (a) 선택)
- D1 타입 검사의 `typescript` 는 `manifest/` 의 개발용 npm lock 으로 고정하고 `just fetch --dev` 로만 받는다. 번들 · 설치본에는 들어가지 않는다.
- D2 `just package` 는 lock 이 마지막 통과 기록과 다르면 번들을 만들지 않는다 (`--force` 로 넘길 수 있다). 설치본 pi 화면에는 알림을 더하지 않는다.
- D3 통과 기록은 `tests/upgrade-check/results.jsonl` (날짜 · 기준 rev · lock sha256 · 검사별 결과 · 남은 실측) 과 진행판 메모에 둔다. `PATCH_NOTES.md` 에는 적지 않는다.
- 명세 승인 (사용자, 2026-11-20: "승인").
- D4 완료 조건의 시험으로 작은 도구 하나(`jq` 또는 `fd`)를 실제 새 버전으로 올려 절차 전체를 한 번 돌린다 (인터넷 다운로드. 커밋은 사용자 요청으로만).

## 1. 지금 상태 (2026-11-20 점검, HEAD 47ae34e)

이미 된 것 (고정 · 분리)
- 모든 구성요소의 버전 · sha256 을 `manifest/tools.lock.tsv` 가 고정한다. npm 패키지(pi · dbhub)는 `manifest/<이름>-package-lock.json` 으로 `npm ci --ignore-scripts` 설치하고, `vendor/<이름>` 에 따로 둔다 (서로의 `node_modules` 를 함께 쓰지 않는다).
- Node 는 번들(`runtime/node`)을 쓰고, `env.sh` 가 번들 도구를 PATH 앞에 둔다 (E2E "번들 fd / jq 래퍼가 PATH 우선").
- `oxy-tui` 는 `Cargo.lock` 으로 고정하고 릴리스 exe 의 sha256 을 lock 에 둔다. 예전 exe 는 `--version` 으로 알아본다 (`oxy-monitor/controller.ts` `supportsMonitor`).
- 폐쇄망 설치본은 스스로 업데이트하지 않는다. 바깥의 새 버전은 누군가 lock 을 고쳐 다시 받기 전까지 영향이 없다.

빠진 것 (버전을 올릴 때)
- G1 extension 과 pi 의 접점을 확인하는 검사가 없다. extension 14개 파일이 `@earendil-works/pi-coding-agent`, 4개가 `@earendil-works/pi-tui`, 2개가 `typebox`(pi 가 넣어 주는 1.3.27)를 쓴다. pi 이벤트 20종, `ctx.ui` 68곳. 이벤트 처리 함수 42곳이 `any` 이고 타입 검사(`tsc`) 단계가 없다. 번들에 `typescript` 가 없다 (pi 패키지에는 `.d.ts` 가 있다).
- G2 pi 내부 문구에 기대는 곳이 조용히 꺼질 수 있다. `oxy-prompt-trim` 은 pi 프롬프트의 `- Additional docs:` 줄을 읽고, 못 찾으면 원문을 둔다. 단위 테스트는 고정 문자열만 보고 E2E 에는 적용 여부 검사가 없다.
- G3 pi 화면에 기대는 곳(`oxygen-pi-tui` 의 `CustomEditor` 상속, 모니터 하단 바 · 마우스)은 자동 검사가 없다. E2E 는 `-p` · RPC 모드라 화면을 그리지 않는다. pi 를 올리면 WT 실제 클릭을 다시 실측해야 한다 (`docs/dev-process.md` §7 함정 5).
- G4 선택 도구는 `verify.sh` 의 `--version` 만 본다. 래퍼(`wrappers/agent-browser` 의 인자 해석, `wrappers/sql` 의 SQLcl 26.3.1 우회)와 skill 본문의 명령이 새 버전에서 맞는지는 아무 검사도 보지 않는다. 단위 테스트에 나오는 도구 이름은 bash-guard 의 명령 해석용 문자열이다.
- G5 "무엇을 올리면 무엇을 돌린다" 가 정해져 있지 않다. `docs/guide.md` 는 "lock 을 고치고 `--update-lock`" 까지만 적는다. 검사는 `just test` · `just test-installer` · `just tui-test` · 실제 LLM 측정 · 화면 캡처로 흩어져 있다.
- G6 검사하지 않은 lock 으로도 `just package` 가 번들을 만든다.

## 2. 영향 표

구성요소를 올리면 아래 검사를 모두 통과해야 한다. 표는 `tests/upgrade-check/map.tsv` 로도 두고 `just upgrade-check` 가 읽는다 (§4). lock 에 행이 있는데 표에 없으면 단위 테스트가 실패한다.

| 구성요소 (lock 이름) | 기대는 곳 | 자동 검사 | 남는 실측 (사람 · 승인) |
| --- | --- | --- | --- |
| `node` | 모든 스크립트 · 설치 TUI · pi 실행 · `--experimental-strip-types` | 전부: 위생 · 단위 · 계약 · 타입 · E2E · 설치 흐름 · 도구 확인 | 설치본 `verify.sh` |
| `pi` (+ 함께 오는 `pi-tui` · `typebox`) | extension 전부, prompt-trim 문구, 설정 생성(`render-config`), subagent 실행, MCP | 단위 · 계약(C1) · 타입(C2) · E2E · 설치 흐름 | pi 화면 캡처(`docs/pi-tui-spec.md` 화면 목록) mintty 80×24 · WT, WT 실제 클릭(함정 5), 실제 LLM 한 번 (과금 승인) |
| `fd` · `rg` · `jq` | `find-code` · `json-querying` skill, 래퍼 `jq`, E2E · 설치 흐름 스크립트의 `jq` | 도구 확인(C3) · E2E | – |
| `just` | 개발 작업 목록, `project-task-running` skill | 도구 확인 | – |
| `hurl` | `http-api-testing` skill | 도구 확인 (mock 서버에 요청) | – |
| `psmux` | `terminal-session-control` skill, 모니터 pane, 화면 캡처 | 도구 확인 · 단위(`-L oxytest-<pid>`) | 모니터 pane 캡처 · WT 클릭 |
| `glab` · `gh` | `gitlab-workflow` · `github-workflow` skill, bash-guard 쓰기 판정 | 도구 확인 (네트워크 없이 하위 명령 · 옵션 존재) | – |
| `ast-grep` | `structural-code-search` skill, 래퍼 | 도구 확인 (fixture 검색) | – |
| `agent-browser` · `obscura` · `chromium` · `chrome` | `web-page-automation` · `web-page-reading` skill, 래퍼 `agent-browser` | 도구 확인 (로컬 HTML 열기 · 읽기) · 설치 흐름 (`chromium`) | – |
| `usql` · `dbhub` | `sql-querying` skill, DB MCP, Tweak 연결 | 도구 확인 · E2E (SQLite) · 설치 흐름 | – |
| `sqlcl` | `oracle-db-querying` skill, 래퍼 `sql` (긴 경로 · `JAVA_HOME` 우회) | 도구 확인 (`/nolog` 실행, 120자 넘는 경로) · 설치 흐름 | 실제 Oracle 연결 (있을 때) |
| `d2coding` | 터미널 글꼴, 글자 폭 기준(`.claude/rules/oxygen-design.md`) | 설치 흐름 · 단위 | 기호 1칸 확인 캡처 mintty · WT |
| `oxy-tui` (와 `Cargo.lock` 의 ratatui 등) | 설치 · Tweak · 모니터 화면 | Rust · 단위 · 설치 흐름 | 바뀐 화면의 mintty 80×24 캡처 |
| skill 본문이 쓰는 도구 전부 | 모델이 skill 을 고르는지 · 명령을 맞게 쓰는지 | – | skill-eval · scenario-eval (skill-evaluator, 과금 승인) — skill 본문을 고쳤을 때만 |

## 3. 새로 더하는 검사

### C1 pi 계약 검사 (`tests/upgrade-check/pi-contract.mjs`)

번들의 pi 를 직접 읽어, extension 이 기대는 것이 그대로 있는지 본다. 판정은 `PASS` / `FAIL <무엇이 없는지>` 줄로 낸다.
- 가져다 쓰는 이름: extension 의 `import { … } from "@earendil-works/…"` · `"typebox"` 에서 값(타입이 아닌 것)을 모아, 번들 pi 에서 실제로 import 해 존재를 확인한다 (`getAgentDir` · `CustomEditor` · `matchesKey` · `visibleWidth` · `truncateToWidth` · `Type` …). 목록은 소스에서 읽고 손으로 적지 않는다.
- 이벤트 이름: extension 의 `pi.on("<이름>")` 을 모아, pi 의 `.d.ts` 에 그 이벤트 이름이 있는지 확인한다.
- prompt-trim 문구: pi 가 만든 실제 시스템 프롬프트에 `- Additional docs: ` 줄이 있는지. E2E 에도 "첫 요청의 시스템 프롬프트에 `Pi harness docs` 안내가 있고 원래 docs 안내는 없다" 검사를 더한다.
- 확인: 검사를 고치기 전 실패를 보인다 — 임시 복사본에서 이벤트 이름 하나와 `- Additional docs:` 문구를 바꾸면 `FAIL` 이 나온다.
- 구현 (2단계, 2026-11-20): `tests/upgrade-check/pi-contract.mjs` (`just contract`). 값 이름은 번들 pi 를 실제로 import 해서, 이벤트는 `.d.ts` 의 `on(event: "<이름>"` 로, 이벤트 필드 · `pi` · `ctx` · `ctx.ui` · `ctx.sessionManager` 의 이름은 `@earendil-works/*` 의 `.d.ts` 어딘가에 선언돼 있는지로 본다. `pi` · `ctx` 는 pi extension API 를 가져오는 파일에서만 모은다 (`oxygen-pi-tui/header.ts` 의 색 이름 `pi.purple` 오탐). 시스템 프롬프트는 pi 의 `buildSystemPrompt` (`dist/core/system-prompt.js`, index 에서 내보내지 않음)로 만든다. E2E 에 `prompt-trim: pi 문서 안내를 한 문단으로 바꿈` 검사를 더했다. 단위 테스트는 `tests/unit-upgrade.test.mjs`.
- 실측 (2026-11-20, pi 1.5.0): 통과 — 가져다 쓰는 이름 6개 · 이벤트 20종 · 이벤트 필드 37개 · API 43개 · prompt-trim 문구. 바꾼 복사본(이벤트 `before_agent_begin`, 필드 `systemPromptOptionz`, `ctx.ui.notifyX`, 없는 import `notAThing`)에서 `FAIL` 4 · 종료코드 1. E2E `E2E 통과` (PASS 77, 새 검사 포함). 약 40초 (pi 를 불러오는 시간).

### C2 extension 타입 검사 (`just typecheck`)

`tsc --noEmit` 으로 `agent/extensions/**` 를 번들 pi 의 `.d.ts` 에 맞춰 검사한다. `typescript` 를 어디서 받는지는 D1.
- 이번 명세에서는 `any` 를 없애지 않는다. 이벤트 처리 함수의 `any` 를 pi 타입으로 바꾸는 일은 따로 한다 (§7 범위 밖).
- 확인: 지금 코드로 통과, 일부러 틀린 호출 하나를 넣으면 실패.
- 구현 (3단계, 2026-11-20): `manifest/dev-package.json` (typescript 7.0.2 · @types/node 22.20.5) + `manifest/dev-package-lock.json`, `bash scripts/fetch-bundle.sh --dev [--update-lock]` 가 `.cache/dev` 에 받는다 (`.cache` 는 번들에서 빠진다). 설정 `tests/upgrade-check/tsconfig.json` (`strict: false`, `paths` 로 번들 pi 의 `.d.ts`), `just typecheck`.
- 처음 실행에서 오류 12개: pi 와 어긋난 곳은 없고 모두 extension 안의 타입 선언 문제였다. 동작을 바꾸지 않고 선언만 고쳤다 — `oxy-jobs` subagent 사용량 타입에 `cache` · `cost` · `maxInput` (f10d598 에서 더한 필드), `await` 뒤 `job.state === "stopped"` 비교를 `isStopped(job)` 로 (TypeScript 가 앞선 대입으로 좁힌 타입을 씀), `oxy-monitor/monitor.ts` 가 `view.ts` 의 `FlowLike` 대신 `model.ts` 의 것을 쓰고 `model.ts` 에 `status?`, `oxygen-pi-tui/tools/index.ts` 의 늘 배열인 값에 대한 함수 분기 제거.
- 함께 고친 결함: `env.sh` 를 읽은 셸(`npm_config_offline=true`)에서는 `fetch-bundle.sh` 의 npm 이 `ENOTCACHED` 로 실패했다 (`just lock` 도 같음). `fetch-bundle.sh` 가 `npm_config_offline=false` 로 받게 했다.
- 실측 (2026-11-20, typescript 7.0.2): `타입 검사 통과` (약 2초). 틀린 사용(없는 이벤트 `session_begin`, `ctx.ui.notifyX`)을 넣은 파일에서 `error TS2769` · `TS2551`, 종료코드 1.

### C3 도구 확인 (`tests/upgrade-check/tools.sh [구성요소…]`)

번들에 받아 둔 도구마다, skill 과 래퍼가 쓰는 방식으로 네트워크 없이 한두 번 실행한다. 받지 않은 도구는 `SKIP <이름>: 받지 않음` 으로 내고 실패로 세지 않는다.
- `rg` · `fd`: fixture 폴더에서 skill 예시와 같은 옵션으로 찾기. `jq`: skill 예시 필터. `ast-grep`: fixture 에서 패턴 찾기.
- `hurl`: mock 서버(`tests/mock-vllm.mjs`)에 요청 · 단언.
- `glab` · `gh`: skill 본문 · bash-guard 가 쓰는 하위 명령과 옵션이 `--help` 에 있는지.
- 옵션 목록은 손으로 적지 않고 `tests/upgrade-check/tool-usage.mjs` 가 `agent/skill-library/**/*.md` 의 코드 블록에서 뽑는다 (skill 을 고치면 목록도 따라온다). 이 옵션 검사는 위의 모든 도구(fd · rg · jq · just · hurl · glab · gh · ast-grep · agent-browser · obscura · usql)에 적용한다. 전역 옵션은 최상위 `--help` 에서 찾는다.
- `psmux`: `-L oxytest-<pid>` 로 세션 만들기 · 글자 보내기 · 화면 읽기 · 끝내기.
- `agent-browser` (+ 고른 브라우저) · `obscura`: 로컬 HTML 파일을 열어 제목 읽기.
- `usql`: SQLite 만들기 · 조회. `sqlcl`: 래퍼로 `/nolog` 실행, 120자 넘는 경로에서도.
- 확인: 지금 번들로 전부 `PASS` 또는 `SKIP`. 없는 옵션을 쓰면 실패.
- 구현 (4단계, 2026-11-20): `tests/upgrade-check/tools.sh` · `tool-usage.mjs`. 로컬 HTTP 서버(127.0.0.1:18120, `OXY_TOOLS_PORT`)와 임시 fixture. agent-browser 는 받아 둔 브라우저(chromium · chrome for testing)마다 연다. SQLcl 의 120자 넘는 경로는 여기서 보지 않는다 (설치 흐름이 긴 경로로 설치한다). obscura 를 agent-browser 엔진으로 쓰는 경로(래퍼가 서버를 띄움)도 보지 않는다.
- 실측 (2026-11-20, 지금 번들 16개 도구): 처음 실행에서 진짜 결함 하나를 찾았다 — `gitlab-workflow` skill 의 `glab api … --jq` 가 glab 1.128.0 에서 `ERROR unknown flag: --jq` (`glab api` 에는 `--jq` 가 없다). 사용자 결정(2026-11-20: "고치고 실제 LLM 측정까지")으로 그 줄을 `| jq -r …` 로 고쳤다. 고친 뒤 `도구 확인 통과` (약 45초).

## 4. 업데이트 절차와 `just upgrade-check`

인터넷 PC 에서 버전을 올리는 순서 (`docs/guide.md` 의 "버전을 올릴 때" 를 이것으로 바꾼다):

1. `manifest/tools.lock.tsv` 의 version · url 을 고치고 `just lock` (= `fetch --update-lock`).
2. pi 를 올렸으면 `vendor/pi/node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md` 의 지난 버전 이후 항목에서 extension API · 이벤트 · TUI 변경을 읽고 보고에 적는다.
3. `just upgrade-check` — 지난 통과 기록과 lock 을 비교해 바뀐 구성요소를 찾고, §2 표의 자동 검사를 모두 돌린다 (이름을 주면 그 구성요소만: `just upgrade-check pi`).
4. 출력의 "남은 실측" 목록(기록의 `manual` 에도 남는다)을 진행판 메모로 옮겨 사람이 확인한다. 번들링 막기는 자동 검사의 통과만 본다.
5. `just package` (D2 에 따라 통과 기록이 없으면 막는다).

`just upgrade-check` 출력 (예)

```
구성요소 업데이트 검증 — 바뀐 것: pi 1.5.0 → 1.6.0  (기준: HEAD 47ae34e + 미커밋)
  PASS 위생 · 진행판
  PASS 단위            # pass 99 · # fail 0
  PASS pi 계약          가져다 쓰는 이름 9 · 이벤트 20 · prompt-trim 문구
  PASS 타입 검사
  PASS E2E              E2E 통과 (PASS 74)
  PASS 설치 흐름        설치 TUI 테스트 통과
  SKIP 도구 확인        pi 만 바뀜
남은 실측 (사람):
  - pi 화면 캡처 mintty 80×24 · WT (docs/pi-tui-spec.md)
  - WT 실제 클릭 (dev-process §7 함정 5)
  - 실제 LLM 한 번 (과금 승인 필요)
```

- 검사가 하나라도 `FAIL` 이면 종료코드 1. 무거운 검사(E2E · 설치 흐름)는 `docs/dev-process.md` §4 의 공유 자원 규칙대로 하나씩 돌린다.
- 통과 기록은 D3 의 위치에 lock 의 지문과 함께 남긴다 (어느 lock 으로 통과했는지). 지문 = 구성요소마다 lock 행의 버전 · 주소 · sha256 + npm 이면 그 lockfile 내용 (`manifest/dev-*` 는 빼고).
- 구현 (5단계, 2026-11-20): `tests/upgrade-check/run.mjs` (`just upgrade-check [이름 …]`, `--gate`), `scripts/package-bundle.sh` 의 막기 · `--force` (`just package *args`). 검사별 로그 `.cache/upgrade-check/<검사>.log`. `docs/guide.md` 의 버전 올리기 절차, `docs/dev-process.md` §6 표 (`manifest/**` 행, `agent/extensions/**` 에 타입 검사 · pi 계약, 새 명령 4개).
- `docs/dev-process.md` §6 표에 `manifest/**` 를 바꾸면 `just upgrade-check` 를 더한다.

## 5. 구현 순서와 확인 방법

1. 영향 표 데이터 `tests/upgrade-check/map.tsv` + lock 의 모든 행이 표에 있는지 보는 단위 테스트 (§2) — 자동 검증: 단위 (행 하나를 지우면 실패를 먼저 보임)
2. C1 pi 계약 검사 + E2E 의 prompt-trim 검사 (§3) — 자동 검증: 계약 검사 · E2E / 실측: 바꾼 복사본에서 `FAIL` 확인
3. C2 타입 검사 (§3, D1) — 자동 검증: `just typecheck` 통과 + 틀린 호출로 실패 확인
4. C3 도구 확인 (§3) — 자동 검증: `tools.sh` 전부 PASS/SKIP + 없는 옵션으로 실패 확인
5. `just upgrade-check` · 통과 기록 · 번들링 막기 (§4, D2 · D3) · `docs/guide.md` · `docs/dev-process.md` §6 고침 — 자동 검증: 단위 + 위생 / 실측: 지금 lock 으로 한 번 전체 실행
완료 조건: 모든 단계 + 지금 lock 으로 `just upgrade-check` 전체 통과 기록 + D4 의 시험 업데이트 한 번

실측 (2026-11-20, 이 PC · HEAD 47ae34e + 미커밋, 기록 `tests/upgrade-check/results.jsonl`)
- 전체 실행 (lock `b60621db089c780f`, 구성요소 20개 전부): 위생 · 단위 114 · pi 계약 · 타입 · 도구 16개 · oxy-tui 48 · E2E · 설치 흐름 모두 PASS, 약 15분 (E2E 269초 · 설치 흐름 472초). 남은 실측(사람) 8줄 출력.
- 앞선 실행 하나는 여유 메모리 1.1GB 에서 Rust · E2E · 설치 흐름이 0초 · 출력 없이 FAIL 로 기록됐다 (프로세스가 뜨지 못함). → `run.mjs` 가 실행 오류 · 신호를 결과 줄 `FAIL 실행 못 함: …` 으로 남기게 고쳤다.
- D4 시험 업데이트: `jq` · `fd` 는 이미 최신이라 `ast-grep` 0.51.1 → 0.51.3 으로 했다. lock 의 버전 · 주소를 고치고 `fetch-bundle.sh --only=ast-grep --update-lock` (sha256 `1f27ff60…`) → `--gate` 가 `ast-grep 0.51.1 → 0.51.3` 로 막음(종료코드 1) → `just upgrade-check` 가 `ast-grep` 만 찾아 위생 · 단위 · 도구 확인(ast-grep 2건) PASS (lock `e4a80709acad224d`) → `just package --check` 가 `업데이트 검증 기록 확인` 으로 통과. 이 버전 올림은 커밋하지 않았다 (사용자 결정).

담당: 모두 화면이 아닌 코드라 부모(메인 세션)가 한다. 위임하지 않는다.

## 6. 범위 밖

- 이벤트 처리 함수의 `any` 를 pi 타입으로 바꾸기 (C2 가 생긴 뒤 따로).
- pi 화면 · 모니터 화면의 자동 캡처 비교 (화면은 지금처럼 사람이 확인한다).
- GitHub CI 적용 (지금은 로컬에서만, `skill-combo` 행의 보류와 같다).
- 실제 버전 올리기 자체 (이 명세는 검사와 절차만 만든다. D4 의 시험 하나만 예외).

## 7. 정할 것

- 없음
