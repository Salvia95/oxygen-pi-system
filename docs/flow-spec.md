# oxy-flow 작업 기록 명세

oxy-flow(`agent/extensions/oxy-flow/`)가 프로젝트의 `.oxy/flow/` 에 남기는 작업 기록의 규칙이다. 기록 전체의 설명은 `README.md` 의 "작업 흐름 기록 · 컨텍스트 관리" 절, 계획(할 일) 트리는 `docs/monitor-spec.md` §4 에 있다.
이 문서는 구현이 먼저 된 뒤 쓴 사후 명세다 (`docs/dev-process.md` §9 D3).
진행 상태: [진행판](dev-board.md) 의 `flow-session` 행.

요청 (사용자 보고, 2026-11-12): pi 를 새로 시작해도 이전 작업의 flow 가 남는다 (하단 바 · 첫 요청에 이전 목표와 계획이 보이고, 새 요청이 그 기록에 섞인다).

결정된 사항 (사용자, 2026-11-12: "F1~F3 권장안대로 승인하고 …")
- 이 사후 명세를 승인했다.
- F1 (a): 보관 기록은 최근 50개만 남긴다 (§1).
- F2 (a): `/resume` · `-c` 로 다시 연 세션은 알림 없이 그 기록을 되살린다 (지금 동작).
- F3 (a): 세션 넘기기로 이어진 세션은 같은 기록을 이어 쓴다 (지금 동작).

## 1. 세션 단위 기록

작업 기록(`flow.json`)은 pi 세션에 묶인다. `flow.json` 의 `sessions` 에 이 작업을 한 pi 세션 id 를 적는다 (예전 파일에는 없고, 없으면 빈 목록이다).

pi 세션이 시작될 때(`session_start`) 위에서부터 처음 맞는 것을 한다 (`store.ts` 의 `bindSession`):

| 경우 | 동작 | 결과 이름 |
| --- | --- | --- |
| 다른 pi 가 기록을 쓰는 중 (락) | 읽기 전용으로 연다 | `readonly` |
| 세션 id 가 없음 | 기록을 바꾸지 않는다 | `empty` |
| 지금 기록의 `sessions` 에 이 세션이 있음 (`/resume` · `-c` 로 같은 세션) | 그대로 이어 간다 | `kept` |
| 세션 넘기기 표시가 있고 기록이 있음 | 이 세션이 이어받는다. 한 표시는 한 세션만 이어받는다 (`continueBy`) | `adopted` |
| `archive/` 에 이 세션의 기록이 있음 | 지금 기록이 있으면 보관하고, 이 세션의 가장 최근 기록을 되살린다 (보관 파일은 지운다) | `restored` |
| 지금 기록도 보관된 기록도 없음 | 빈 기록 | `empty` |
| 그 밖 (새 세션) | 지금 기록을 `archive/` 에 보관하고 빈 기록으로 시작한다 | `parked` |

- 보관 파일 이름은 작업 id 다. id 는 `flow-<UTC 초>-<16진 4자리 난수>` 이고, 같은 이름이 있으면 덮어쓰지 않고 번호를 붙인다. 예전에는 초 단위 id 가 겹쳐 보관 파일 두 개가 서로 덮어썼다 (테스트가 가끔만 실패한 원인).
- 작업 상태 주입: 기록이 있는 세션(다시 연 세션 · 세션 넘기기)의 첫 요청에만 넣는다. 세션마다 한 번이다 (그 세션에 이미 넣었으면 다시 넣지 않는다).
- `-p` (한 번 실행)도 세션 id 가 있으면 같은 규칙을 따른다. `--no-session` 이면 매번 새 세션이다.
- `/flow new 목표` 는 지금 기록을 보관하고 새 작업을 시작한다 (전과 같다).
- 보관 기록은 최근 50개만 남긴다 (`ARCHIVE_KEEP`). 보관할 때마다 수정 시각이 오래된 것부터 지우고, 방금 보관한 파일은 지우지 않는다 (F1).
  - 구현 (2026-11-12): `store.ts` 의 `pruneArchive` 를 `archiveCurrent` 끝에서 부른다.
- 구현 (2026-11-12): `agent/extensions/oxy-flow/store.ts` (`bindSession` · `findArchived` · `archiveCurrent` · `fresh`), `index.ts` 의 `session_start`. 커밋 `acd4aac`.
- 실측 (2026-11-12, 대화형 pi 1.5.0 · mock LLM `qwen3.6-coder-30b`): 새로 시작하면 빈 기록, `/resume` 으로 이전 세션을 열면 그 기록을 되살림. 실제 LLM 으로는 확인하지 않았다.

## 1-2. 작업 저장소 (pi 를 시작한 폴더와 실제 작업 저장소가 다를 때)

요청 (사용자, 2026-11-13): "pi를 실제 작업 폴더가 아닌 곳에서 시작했더라도 현재 메인컨텍스트의 작업을 기준으로 플로우 모니터를 보여줘야지"
결정된 사항 (사용자, 2026-11-13): 위 요청대로 고치고 설치본에 반영한다.

본 일 (2026-11-13, 사용자 프로젝트 cozy-example 의 flow.json): pi 를 `cozy-example` (git 저장소 아님)에서 시작하고 실제 작업은 옆 폴더 `library-rental` 에서 했다.
기록은 `cozy-example/.oxy/flow` 에 묶여 커밋을 하나도 찾지 못했고 (노드 0개, `baseCommit: null`), 고친 파일은 `../library-rental/pom.xml` 로 "커밋 전 작업" 에 계속 남았다. `git status` 를 `cozy-example` 에서 돌려 `not a git repository` 실패도 쌓였다.

- 기록을 두는 곳은 지금처럼 pi 를 시작한 폴더(의 git 최상위)다. 모니터가 pi 의 폴더로 기록을 찾기 때문이다.
- **작업 저장소**(`flow.work = { root, baseCommit }`)를 따로 둔다. 메인 컨텍스트가 `edit` · `write` 로 고친 파일, `bash` 의 `cd <폴더>` (앞 cd 기준으로 이어서 푼다) · `git -C <폴더>` 가 다른 git 저장소면 그 저장소의 최상위로 옮기고, 옮긴 때의 HEAD 부터 커밋을 찾는다. 기록을 둔 저장소로 돌아오면 `work` 를 지운다.
- 커밋 → 노드 (`syncCommits`), 고친 파일의 상대 경로, `/flow rollback` 의 `git status` 는 작업 저장소에서 한다. 다른 저장소의 노드에는 `repo` 를 남기고, 되돌리기는 그 노드의 저장소에서 한다.
- 모델에게 넣는 작업 상태 맨 위에 `Work repository: <경로> (pi was started elsewhere; run git and builds there)` 를 넣는다.
- 구현 (2026-11-13): `oxy-flow/store.ts` (`repoOf` · `commandDirs` · `workRoot` · `noteWorkPath` · `syncCommits` · `renderContext`), `oxy-flow/index.ts` (`tool_result` · `/flow rollback`). 단위: git 이 아닌 시작 폴더 + 옆 저장소에서 커밋 → `n1 feat: events` (`repo` = 옆 저장소), 기록은 시작 폴더의 `.oxy/flow`, `cd` · `git -C` 풀기.

## 1-3. 커밋하면 커밋 전 작업을 모두 비운다 (2026-11-13)

- 커밋을 노드로 만들 때 버퍼의 결정 · 파일과 함께 **실패한 명령도** 비운다 (작업 목록은 둔다). 전에는 해결 안 된 실패를 커밋 뒤에도 남겨 모델에게 넘겼다.
- 이유: 사용자 요청으로 Flow Monitor 의 `Before Commit Task` 는 커밋하면 사라져야 한다 (`docs/flow-view-spec.md`). 커밋했다면 그 전의 실패는 대개 해결되었다.
- 구현: `oxy-flow/store.ts` 의 `syncCommits`. 단위: 커밋 뒤 `failures` 0, 커밋 뒤 새 실패는 같은 명령이 성공하면 풀린다.

## 2. 구현 순서와 확인 방법

1. 세션 단위 기록 (§1) — 자동 검증: 단위(`tests/unit-extensions.test.ts` 의 "oxy-flow: 작업 기록은 세션 단위") + E2E(`tests/e2e-mock.sh` 의 flow 검사: 새 세션은 빈 기록, 다시 연 세션은 기록과 계획 · 다음 할 일 주입) / 실측: 대화형 pi 로 새로 시작 · `/resume`
2. 설치본 반영 — 실측: 설치본에서 `scripts/verify.sh` [승인 필요: 실제 설치본]
3. 실제 Claude Haiku 로 compaction (작업 도중 한도에서 작업 상태로 교체) — 자동 검증: E2E (mock compaction) / 실측: 실제 Claude 연결로 긴 작업 [승인 필요: 과금 LLM, 유효한 키]
4. 보관 기록 50개 유지 (§1, F1) — 자동 검증: 단위(`tests/unit-extensions.test.ts` 의 "oxy-flow: 보관 기록은 최근 50개만 남긴다") / 실측: 자동 검증으로 대신한다 (파일 수만 보는 동작)

완료 조건: 1~4.

## 3. 정할 것

- 없음 (F1 ~ F3 은 2026-11-12 사용자가 권장안 (a) 로 정했다. 위 "결정된 사항")
