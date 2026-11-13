# Job Monitor 구성 개편 명세

psmux 오른쪽 열의 jobs 모니터를 **Main Context**(본 대화가 띄운 백그라운드 셸)와 **Sub Context**(본 대화가 띄운 subagent)로 나누고, subagent 를 골라 Enter 를 누르면 그 subagent 가 띄운 백그라운드 셸을 보인다.
`docs/monitor-tui-spec.md` §3 의 jobs 화면을 바꾼다. 맨 윗줄 띠 · Tokyo Night 팔레트 · 그리기 규칙은 `docs/flow-view-spec.md` 를 그대로 따른다.
진행 상태: [진행판](dev-board.md) 의 `jobs-view` 행.

요청 (사용자, 2026-11-13, flow 모니터 캡처를 보고)
- jobs 도 flow 처럼 고친다. 이름은 `Job Monitor`.
- `Main Context` 와 `Sub Context` 영역으로 나눈다. Main Context 에는 메인 컨텍스트가 띄운 작업만, Sub Context 에는 메인 컨텍스트가 띄운 서브 컨텍스트만 보인다.
- 서브 컨텍스트를 골라 Enter 를 누르면 그 서브 컨텍스트가 띄운 백그라운드 셸이 보인다.
- (2026-11-13 추가) `s` 를 누르면 중지할지 다시 묻는 팝업을 띄운 뒤 처리한다.
- (2026-11-13 추가) 각 영역에 진행 중인 작업이 없으면 `-` 로 보여, 지금 진행 중인 작업이 아무것도 없음을 분명히 알 수 있게 한다.
- (2026-11-13 확인 요청) 끝난 작업이 바로 지워지는지 확인한다 → §1.

결정된 사항 (사용자, 2026-11-13: "j1, j2는 권장안으로 가고 j3는 s를 눌렀을 때 삭제 여부를 다시 한번 확인하는 팝업을 띄운 후 처리하고 싶어")
- J1 (a) `background` 는 worker 만. J2 (a) subagent 화면 맨 위 `대화 로그` 줄. J3 은 팝업으로 확인한 뒤 중지 (§2 "중지 확인 팝업").
- 진행 중인 작업이 없는 영역은 `-` 한 줄.

결정된 사항 (사용자, 2026-11-13: "진행 중인 작업이 없는 영역에 표시되는 - 가 해당 섹션 영역의 수평, 수직 중심에 위치하도록 해줘 그리고 Job Monitor 옆 실행 중은 \"Processing {n}\" 으로 표시하자 남은 결정은 권장안으로 갈게")
- 이 명세를 승인했다. J4 (a) 끝난 작업은 바로 목록에서 뺀다, J3-1 (a) 중지 팝업의 처음 포커스는 `취소`.
- 빈 영역의 `-` 는 그 영역의 가로 · 세로 가운데에 둔다. 맨 윗줄 오른쪽은 `Processing {n}`.

## 1. 확인된 사실

- 지금 jobs 화면은 본 대화의 작업 목록 하나에 `bg`(백그라운드 셸)와 `sub`(subagent)를 섞어 보이고, Enter 는 고른 작업의 로그를 연다 (`agent/extensions/oxy-monitor/model.ts` 의 `jobsModel`).
- subagent 는 별도 pi 프로세스(`--mode json -p --no-session`)로 돌고, agent 정의의 `tools` 를 `--tools` 허용 목록으로 받는다 (`agent/extensions/oxy-jobs/subagent.ts`). 지금 정의는 scout · reviewer `read, grep, find, ls, bash`, worker `read, bash, edit, write, grep, find, ls` 라 **subagent 는 `background` 도구를 쓸 수 없다**. pi 1.5.0 의 `--tools` 는 extension 도구도 이름으로 허용한다 (`docs/cli.md`).
- oxy-jobs 는 대화형 모드에서만 상태 파일(`agent/jobs/run-<pid>-<시각>/state.json`)을 쓰고 중지 요청(`control/`)을 받는다. subagent(비대화형)는 상태를 파일로 내보내지 않고, 끝내기 전에 남은 작업을 기다린다 (`OXY_JOBS_WAIT_MS`).
- subagent 를 중지하면 그 프로세스 트리(손자 프로세스 포함)를 끝낸다 (`monitor/r` 단계, 2026-11-12).
- **끝난 작업은 바로 지워지지 않는다** (2026-11-13 코드 확인): oxy-jobs 는 띄운 작업을 pi 가 끝날 때까지 목록(`JobManager.jobs`)에 두고, 상태 파일에 모두 쓴다 (`manager.ts` 의 `snapshot`).
  그래서 지금 모니터는 끝난 작업(`✓` `×` `■`)을 pi 를 끝낼 때까지 계속 보인다 (5단계 · flow-view 캡처의 `✓ npm test` · `× npm run lint` · `■ reviewer`). 끝난 작업의 결과는 본 대화에 알림으로 들어가고 `/jobs` 로도 볼 수 있다.
- 지금 중지 확인은 팝업이 아니라 키 안내 줄이 `<id> 작업을 중지할까요?` 로 바뀌고 `s` 를 한 번 더 누르는 방식이다.
- 따라서 "서브 컨텍스트가 띄운 백그라운드 셸"을 보이려면 화면 말고도 (1) subagent 가 `background` 를 쓸 수 있게 하고 (2) subagent 의 작업 상태를 본 대화의 실행 폴더 아래로 내보내야 한다 (§3).

## 2. 화면

### 목록 (35칸, 120×30)

```
Job Monitor            Processing 2      ← 맨 윗줄 띠 (flow 와 같은 띠)
── Main Context ───────────────────
⠹ npm run build                 0:41      ← 본 대화의 백그라운드 셸 (진행 중인 것만, J4)
── Sub Context ────────────────────
⠹ worker: 결제 모듈 수정  셸 1  2:12      ← 본 대화의 subagent. 실행 중인 셸이 있으면 `셸 N`
───────────────────────────────────
⠹ 응답 생성 중                  0:05      ← 본 대화의 지금 상태 (지금과 같다)
▲▼ 이동  Enter 열기  s 중지  q 닫기
```

진행 중인 작업이 하나도 없을 때 (35칸 × 15줄, 영역 높이 Main 5줄 · Sub 4줄):

```
Job Monitor            Processing 0
── Main Context ───────────────────

                 -                       ← 영역의 가로 · 세로 가운데

── Sub Context ────────────────────
                 -

───────────────────────────────────
대기 중
▲▼ 이동  q 닫기
```

- 맨 윗줄: 왼쪽 `Job Monitor`, 오른쪽 `Processing {n}` (n = 본 대화의 진행 중인 작업 수, 실행 중 · 대기, Main 과 Sub 를 합친 수. subagent 의 셸은 세지 않는다. 없으면 `Processing 0`). 23칸에서 넘치면 왼쪽을 `Jobs` 로 줄인다.
- **Main Context**: 본 대화가 `background` 로 띄운 셸만. 상태 기호 · 명령 · 경과(끝난 것은 걸린 시간). 종류 열(`bg` · `sub`)은 영역이 나뉘므로 뺀다.
- **Sub Context**: 본 대화가 `subagent` 로 띄운 것만. 상태 기호 · `<agent>: <일>` · 실행 중인 셸 수(`셸 N`, 없으면 비움, 30칸 미만이면 뺌) · 경과.
- 영역에 진행 중인 작업(실행 중 · 대기)이 없으면 그 영역의 **가로 · 세로 가운데**에 `-` 하나 (사용자 결정). 고를 수 있는 줄이 아니다. 가운데는 위 · 왼쪽으로 내림한다 (영역 h 줄 중 `floor((h-1)/2)` 번째 줄, 폭 w 칸 중 `floor((w-1)/2)` 번째 칸).
- 영역 높이: 두 영역이 남는 줄을 반씩 나눈다 (홀수면 Main 이 한 줄 더). 작업이 있는 영역이 자기 몫보다 짧으면 남는 줄을 다른 영역에 넘긴다. 빈 영역(`-`)은 몫을 그대로 가져 `-` 가 가운데에 보인다. 영역보다 작업이 많으면 고른 줄이 늘 보이게 스크롤한다.
- 순서는 지금과 같다 (실행 중 · 대기 → 최근에 끝난 것).

### subagent 를 열었을 때 (Sub Context 에서 Enter)

```
worker               Processing 1     ← 맨 윗줄 띠: subagent 이름 · 그 subagent 의 진행 중인 셸 수
── worker: 결제 모듈 수정 ─────────
  대화 로그                              ← 그 subagent 의 출력 로그 (J2)
⠹ npm test -- payment           0:32      ← 그 subagent 가 띄운 셸
───────────────────────────────────
⠹ worker 실행 중                2:12      ← 그 subagent 의 상태 · 경과
▲▼ 이동  Enter 로그  s 중지  Esc 목록
```

- 그 subagent 가 띄운 셸 목록. 셸을 골라 Enter 면 그 셸의 로그, `Esc` 면 목록으로.
- 맨 위 줄 `대화 로그` 를 고르고 Enter 면 그 subagent 자신의 로그(지금 jobs 화면에서 subagent 를 Enter 했을 때와 같은 로그) (J2).
- `s` 면 고른 셸을 중지 확인 팝업을 거쳐 멈춘다 (J3). subagent 자신을 멈추는 것은 목록 화면에서 그 subagent 를 골라 `s`.
- 진행 중인 셸이 없으면 `대화 로그` 아래 남은 영역의 가로 · 세로 가운데에 `-`.
- 그 subagent 가 끝나면 목록 화면의 Sub Context 에서 빠지고(J4), 이 화면을 보고 있었다면 목록으로 돌아간다.

### 23칸 (80×24, 모니터 둘)

```
Jobs        Processing 2
── Main Context ───────
⠹ npm run build   0:41
── Sub Context ────────
⠹ worker: 결제…   2:12
───────────────────────
⠹ 응답 생성 중    0:05
▲▼ 이동  Enter 열기
s 중지  q 닫기
```

### 중지 확인 팝업 (J3)

`s` 를 누르면 화면 가운데에 팝업을 띄우고, 고른 것을 누른 뒤에 처리한다. 본 대화의 셸 · subagent · subagent 의 셸 모두 같다 (지금의 "`s` 두 번" 방식을 바꾼다).

```
┌ 작업 중지 ──────────────┐
│ npm test 작업을          │
│ 중지할까요?               │
│ 실행 중인 명령과 그 하위   │
│ 프로세스가 끝납니다.       │
│                          │
│     중지      취소        │
└──────────────────────────┘
```

- 버튼 `중지` · `취소`, `←→` 이동 · `Enter` 선택 · `Esc` 취소. 처음 포커스는 `취소` (J3-1).
- subagent 를 멈출 때의 둘째 줄: `그 subagent 와 그것이 띄운 셸이 모두 끝납니다.`
- 팝업 모양 · 버튼 · 키는 설치 화면의 확인 팝업(`docs/tui-spec.md` 의 확인 팝업, 예: "psmux 세션 종료")과 같게 그린다. 23칸에서는 글을 줄바꿈해 폭 안에 넣는다.
- 중지를 요청한 뒤에는 키 안내 줄에 결과(`<이름> 중지를 요청했습니다`)를 잠시 보인다 (지금과 같다).

### 로그 화면

지금과 같다 (`▲▼` 로 스크롤, `Esc` 로 돌아감). 로그를 연 곳(목록 · subagent 화면)으로 돌아간다. 로그 화면에서 `s` 도 위 팝업을 띄운다.

## 3. subagent 의 셸 내보내기 (oxy-jobs)

- 본 대화가 subagent 를 띄울 때 환경변수 `OXY_JOBS_PARENT=<본 대화의 실행 폴더>` · `OXY_JOBS_PARENT_JOB=<그 subagent 의 작업 id>` 를 넘긴다.
- subagent 쪽 oxy-jobs 는 이 값이 있으면 비대화형이어도 상태 파일을 `<본 대화의 실행 폴더>/sub/<작업 id>/state.json` 에 쓰고(형식은 지금 `state.json` 과 같다), 로그는 그 아래 `logs/`, 중지 요청은 그 아래 `control/` 에서 받는다.
- 본 대화의 실행 폴더를 정리할 때(`pruneRuns`) `sub/` 도 함께 지운다.
- subagent 정의의 `tools` 에 `background` 를 더한다 (J1). subagent 안의 `background` 는 지금 규칙대로 그 subagent 가 끝나기 전에 끝날 때까지 기다린다.
- 모니터는 본 대화의 `state.json` 과 `sub/*/state.json` 을 읽는다. 표시 문구는 §2.

## 4. 구현 순서와 확인 방법

1. subagent 의 셸 내보내기 (§3) — 담당: 부모. 자동 검증: 단위(내보낼 곳 정하기 · 상태 파일 · 정리) + E2E(mock: subagent 가 `background` 로 셸을 띄우면 `sub/<id>/state.json` 에 그 셸이 있고, 모니터의 중지 요청으로 멈춘다)
2. 보기 모델 · 키 처리 (§2) — 담당: 부모. 자동 검증: 단위(23 · 35칸 × 11 · 15 · 24줄: 두 영역, 빈 영역, 높이 나누기, subagent 화면, Enter · Esc · s 흐름)
3. 화면 프로그램 (중지 확인 팝업) — 담당: tui-implementer. 모니터 모드에 팝업을 더한다 (설치 화면의 확인 팝업 재사용). 아직 릴리스하지 않은 0.3.0 에 함께 넣는다. 자동 검증: `just tui-test` / 실측: mintty 80×24 · 120×30 팝업 캡처
4. 실제 LLM 실측 — 담당: 부모. 하이쿠에게 worker subagent 로 백그라운드 셸을 쓰는 일을 맡기고 mintty 80×24 · 120×30 캡처 (목록 · subagent 화면 · 셸 로그)
5. 릴리스 · 번들 · 설치본 반영 — `flow-view/6` 과 함께 [승인 필요: push · 릴리스 · 실제 설치본]

완료 조건: 1~5 와, 사용자가 4 의 캡처를 확인한 것.

### 구현 기록

- 1단계 (2026-11-13, 부모): 본 대화가 subagent 를 띄울 때 `OXY_JOBS_PARENT` · `OXY_JOBS_PARENT_JOB` 을 넘기고(`oxy-jobs/index.ts`), 자식의 `JobManager` 는 `sub/<작업 id>` 를 실행 폴더로 쓴다.
  자식은 비대화형이어도 상태 파일 · 중지 요청 받기를 켠다. `state.ts` 의 `subRunDir` · `subRunFromEnv` · `readSubStates`. worker 의 `tools` 에 `background` 와, 1분 넘는 명령은 background 로 돌리라는 한 줄.
  E2E(mock): worker 가 띄운 셸이 `sub/<id>/state.json` 에 보이고, 모니터의 중지 요청으로 멈추고, worker 가 끝나면 `closed`.
- 2단계 (2026-11-13, 부모): `model.ts` 의 `jobsModel`(`jobLists` · `areaRows` · `splitAreas` · 팝업), `controller.ts` 의 `jobsKey`(목록 · subagent 화면 · 로그 · 팝업), `monitor.ts` 가 `sub/*` 를 읽고 중지 요청을 맞는 폴더로 보낸다.
  키 안내 줄의 알림은 5초 뒤 지운다 ("잠시").
- 3단계 (2026-11-13, tui-implementer): `oxy-tui` 0.3.0 에 배지(경과 앞 두 칸), 팝업(설치 화면의 확인 팝업 그리기를 `parts.rs` 로 옮겨 함께 씀, `popup.danger` 로 경고 버튼), Left/Right 키. `just tui-test` `45 passed`.
  80×24 의 위쪽 11줄 pane 에서는 팝업이 맨 윗줄 띠까지 덮는다 (질문 문장을 자르지 않으려고 그대로 둔다).
- 4단계 (2026-11-13, 부모, 대화형 pi 1.5.0 · claude-haiku-5-5 · psmux 120×30): 하이쿠가 worker 에게 일을 맡기고, worker 가 background 로 `sleep 40; node test.js` 를 띄웠다.
  목록의 Sub Context 에 `셸 1`, Main Context 는 가운데 `-`, Enter 로 subagent 화면(대화 로그 · 셸), `s` → 팝업(처음 포커스 취소) → `←` · Enter 로 그 셸만 멈추고 worker 는 계속(같은 명령을 다시 돌려 끝냄), 끝나면 두 영역 모두 `-`.
  **찾아 고친 것**: worker(자식 pi)가 끝날 때 본 대화의 모니터 pane 이 닫혔다. 자식이 부모 pane 의 `TMUX` 환경을 물려받아, 끝날 때 oxy-monitor 가 그 창의 모니터 pane 을 모두 닫았다 (subagent 를 쓰면 늘 생기던 문제).
  → 화면을 그린 본 대화가 끝날 때만 닫는다 (`pane.ts` 의 `closesMonitorsOnShutdown`, 단위 시험). 고친 뒤 같은 실측에서 worker 가 끝나도 pane 이 남는다.
  비용 세 번 합쳐 약 $0.006. 증거: scratchpad `fv8/1-list.png` · `2-sub.png` · `3-popup.png` · `4-final.png`, 예시 모델 캡처 `fv7/*` (2026-11-13).
  본 것: subagent 이름 줄은 맡긴 일의 앞 60자라, 하이쿠가 일을 "작업 디렉터리: C:/…" 로 시작하면 그 경로가 보인다 (범위 밖, 기록만).

## 5. 정할 것

- 없음 (2026-11-13 사용자가 모두 정했다. 아래는 그때의 선택지와 이유다)

- J4 끝난 작업 — (a) 끝나면 바로 목록에서 뺀다 (진행 중인 것만 보인다) (b) 끝난 뒤 10초 동안 `✓` `×` `■` 로 보이고 뺀다.
  권장 (a): 요청하신 "진행 중인 작업이 없음을 분명히" 에 가장 잘 맞는다. 실패한 작업도 본 대화에 알림이 들어가고 `/jobs` 에 남으므로 놓치지 않는다. (b) 는 실패를 화면에서 잠깐 더 볼 수 있지만, 그 10초 동안은 `-` 가 늦게 나온다.
- J3-1 중지 팝업의 처음 포커스 — (a) `취소` (b) `중지`.
  권장 (a): 실행 중인 명령을 끝내는 일이라, 설치 화면의 "세션 종료" 팝업처럼 Enter 를 잘못 눌러도 멈추지 않게 한다.

아래는 2026-11-13 에 정한 것 (기록):

- J1 `background` 를 쓸 수 있는 subagent — (a) worker 만 (b) scout · reviewer · worker 모두.
  권장 (a): 빌드 · 테스트처럼 오래 걸리는 명령을 돌리는 것은 worker 다. scout · reviewer 는 짧은 읽기 · 검색이 대부분이라, 도구 설명이 매 요청에 실리는 비용(작은 모델의 컨텍스트)을 늘리지 않는다.
- J2 subagent 화면에서 그 subagent 자신의 로그 — (a) 셸 목록 맨 위에 `대화 로그` 줄을 두고 Enter 로 연다 (b) 셸만 보이고, 자신의 로그는 목록 화면에서 다른 키(`l`)로 연다.
  권장 (a): 키를 새로 외우지 않아도 되고, 지금 Enter 로 보던 로그를 한 단계 안에서 그대로 볼 수 있다.
- J3 subagent 의 셸 중지 — (a) 본 대화의 셸처럼 `s` 두 번으로 멈춘다 (b) 보기만 한다 (멈추려면 subagent 를 멈춘다).
  권장 (a): 잘못 띄운 긴 명령만 멈추고 subagent 의 일은 이어 가게 할 수 있다.
