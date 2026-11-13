# flow 모니터 구성 개편 · Tokyo Night 테마 명세

psmux 오른쪽 열의 flow 모니터(`oxy-tui` 모니터 모드)를 "지금 하는 일 → 다음 할 일 → 전체 할 일" 순서로 다시 나누고, pi 와 모니터에 Tokyo Night 색을 입힌다.
`docs/monitor-tui-spec.md` §3 의 flow 화면을 바꾼다. jobs 화면 · 실시간 활동(`live.json`) · 프로그램 구조(§4)는 그대로 쓴다.
진행 상태: [진행판](dev-board.md) 의 `flow-view` 행.

요청 (사용자, 2026-11-13, 5단계 캡처를 보고)
- flow 는 단계(depth)마다 전체 할 일 수와 그 할 일의 위치를 보인다. `p2.2` 대신 `[1/2] 태스크 1`, `[2/2] 태스크 2`.
- 영역을 나눈다. 위는 **Current Task**(위치 표시 없이 할 일 이름과 시간만), 그 아래 **Next Task:** 로 다음 할 일, 아래 영역은 **Overall Task**.
- Overall Task 는 바(│ ├ └)로 트리 구조를 보인다. 기본 포커스는 늘 지금 할 일이다.
- 끝난 할 일은 이름 옆에 걸린 시간을 보이고, 지금 하는 할 일은 왼쪽 화살표와 함께 `Current Task` 라고 보인다.
- pi 테마로 `pi-tokyo-night` 를 적용한다.
- (2026-11-13 추가) 맨 윗줄의 `flow` 를 `Flow Monitor` 로, `할 일 2/6` 을 `Total 2/6` 형태로 바꾼다.
- (2026-11-13 추가) 맨 윗줄(모니터 이름 줄)이 아래 내용과 잘 구분되지 않는다. 바탕색으로 구분하되 가독성은 확보한다.

결정된 사항 (사용자, 2026-11-13: "권장안대로 승인할게")
- 이 명세를 승인했다. R1 ~ R3 · T1 ~ T3 · H1 은 모두 (a): Current Task 아래 pi 상태 줄을 둔다(14줄 미만이면 뺀다), flow 의 최근 구역은 뺀다, `FLOW.md` 에도 걸린 시간을 적는다,
  `pi-tokyo-night` 는 테마 파일만 반입한다, pi 테마가 tokyo-night 면 모니터도 Tokyo Night, Windows Terminal `Oxygen Pi` 프로필에 Tokyo Night 색 구성, 맨 윗줄 띠는 flow · jobs 둘 다.

## 1. 확인된 사실

- `pi-tokyo-night` 는 npm 패키지다 (1.0.0, MIT, 저장소 `github.com/MitoroMisaka/pi-tokyo-night`, tarball sha1 `57cd48d8…0645`). 테마 파일 `themes/tokyo-night.json` 과 머리말 extension `extensions/tokyo-night-header.ts` 두 가지가 들어 있다.
- 테마 파일을 임시 agent 폴더의 `themes/` 에 두고 `pi --use-theme tokyo-night` 로 띄우면 pi 1.5.0 이 오류 없이 읽고 Tokyo Night 색(`#7dcfff` `#565f89` 등)으로 그린다 (2026-11-13, psmux 100×26, scratchpad `m5/theme-tokyo.png`).
- pi 테마는 글자색만 바꾸고 **바탕색은 칠하지 않는다**. Tokyo Night 의 바탕(`#1a1b26`)은 터미널 설정이 정한다 (같은 캡처: 바탕은 mintty 기본 검정).
- 머리말 extension 은 pi 의 시작 머리말(키 안내 포함)을 자체 그림으로 바꾸고, 2칸으로 그려지는 그림 글자 `🌙` 를 쓴다 (`docs/tui-spec.md` §5 의 1칸 규칙에 어긋난다).
- 지금 `flow.json` 의 할 일(`PlanItem`)에는 마지막으로 바뀐 시각(`at`)만 있고, 시작 · 끝 시각이 없다. 걸린 시간을 보이려면 기록을 더해야 한다.
- 두 모니터를 함께 열면 80×24 에서 flow pane 은 23칸 × 11~12줄, 120×30 에서 35칸 × 14~15줄이다 (`docs/monitor-tui-spec.md` §5).

## 2. flow 화면

### 35칸 (120×30)

```
Flow Monitor             Total 2/6
── Current Task ───────────────────
⠹ 테스트 작성                  0:42     ← 진행 중인 할 일 이름 · 그 할 일의 경과 (위치 표시 없음)
  도구 실행 중 · bash npm test          ← pi 의 지금 상태 한 줄 (R1)
Next Task: 오류 처리                    ← 다음에 할 일 (없으면 `Next Task: 없음`)
── Overall Task ───────────────────
⠹ [1/3] 로그인 API
├ ✓ [1/3] 라우트              3:10     ← 끝난 할 일: 걸린 시간
├ ⠹ [2/3] 테스트… ◀ Current Task       ← 지금 할 일: 반전(기본 포커스) · 오른쪽에 `◀ Current Task`
└ · [3/3] 오류 처리
· [2/3] 결제 연동
! [3/3] 배포 설정
계획 밖 커밋
  ✓ n3 fix: 린트 오류
▲▼ 이동  Enter 펼치기  q 닫기
```

### 23칸 (80×24, 모니터 둘)

```
Flow Monitor  Total 2/6
── Current Task ───────
⠹ 테스트 작성      0:42
Next Task: 오류 처리
── Overall Task ───────
⠹ [1/3] 로그인 API
├ ✓ [1/3] 라우트   3:10
├ ⠹ [2/3] 테스트… ◀
└ · [3/3] 오류 처리
▲▼ 이동  Enter 펼치기
q 닫기
```

**Current Task** (맨 위)
- 진행 중인 할 일(지금처럼 첫 번째 `doing` 할 일, 없으면 `doing` 항목)의 이름과 경과. `[i/n]` 과 `p2.2` 같은 위치는 쓰지 않는다. 경과는 그 할 일이 `doing` 이 된 때부터 잰다 (§3).
- 진행 중인 할 일이 없으면 `진행 중인 할 일이 없습니다`.
- 그 아래 한 줄에 pi 의 지금 상태(`응답 생성 중` · `도구 실행 중 · <도구 요약>` · `대기 중`)를 보인다 (R1). 높이가 14줄 미만이면 이 줄은 뺀다 (jobs 화면 맨 아래에도 같은 줄이 있다).

**Next Task** (한 줄)
- `Next Task: <이름>`. 진행 중인 할 일 다음의 첫 `todo` 할 일: 같은 항목 안의 다음 할 일, 없으면 다음 항목의 첫 할 일(할 일이 없는 항목이면 그 항목).
- 없으면 `Next Task: 없음`. 이름이 길면 끝을 `…` 로 줄인다.

**Overall Task** (남는 높이, 스크롤)
- 계획 전체를 트리로. 1단(항목)은 바 없이, 2단(할 일)은 `├` · `└` 로 잇는다. 펼친 줄(결정 · 변경 파일)은 그 할 일 아래에 `│` 로 이어 들여 쓴다.
- 이름 앞에 같은 단계 안의 위치 `[i/n]` (항목은 전체 항목 중, 할 일은 그 항목의 할 일 중). 뺀(`dropped`) 것도 수에 넣고 `-` 기호로 보인다.
- 상태 기호는 지금과 같다 (점자 스피너 · `·` · `✓` · `!` · `-`).
- 오른쪽 정렬 열: 끝난 것은 걸린 시간(`m:ss`, 한 시간 넘으면 `h:mm:ss`), 지금 할 일은 `◀ Current Task` (30칸 미만이면 `◀` 만). 시작 · 끝 시각을 모르는 것(이 기록을 더하기 전에 끝난 것)은 비운다.
- 이름은 오른쪽 열을 뺀 폭에 맞춰 끝을 `…` 로 줄인다.
- 지금 할 일 줄은 반전으로 고른 상태다. **기본 포커스는 늘 지금 할 일**: 사용자가 `▲▼` 로 움직인 뒤 10초 동안만 사용자 위치를 두고, 그 뒤 지금 할 일로 돌아간다 (지금과 같은 `MANUAL_HOLD_MS`).
- 커밋 번호(`n2`) 열은 뺀다. 커밋은 `Enter` 로 펼치면 보인다 (지금과 같다). 계획 아래의 `계획 밖 커밋` · `커밋 전 작업` 은 그대로 둔다.
- 최근 구역은 flow 에서 뺀다 (R2).

**머리말 · 키 안내**: 맨 윗줄은 왼쪽 `Flow Monitor`, 오른쪽 `Total <끝난 할 일>/<전체 할 일>` (뺀 할 일은 세지 않는다, 지금 `할 일 2/6` 과 같은 수). 23칸에서 `Total 10/12` 처럼 두 쪽이 한 줄에 들어가지 않으면 왼쪽을 `Flow` 로 줄인다. 키 안내는 지금과 같다. jobs 화면의 맨 윗줄은 바꾸지 않는다. 영역 이름은 사용자가 정한 영어 그대로 쓴다 (`Current Task` · `Next Task:` · `Overall Task`). 영역 사이 가로줄에 이름을 싣는다 (`── Current Task ───`, 지금 화면의 `── 최근 ──` 과 같은 모양).

**맨 윗줄 띠**: 맨 윗줄은 pane 폭 전체를 바탕색으로 칠한 띠로 그린다. 글자는 굵게. 띠 색은 고른 줄(반전)과 다르게 해 헷갈리지 않게 한다.
글자와 바탕의 명암비는 4.5:1(WCAG AA) 이상으로 한다. 아래 값은 계산한 명암비다.

| 팔레트 | 띠 바탕 | 글자 | 명암비 |
| --- | --- | --- | --- |
| Tokyo Night (§4) | `#7aa2f7` (파랑) | `#1a1b26` | 6.79:1 |
| 기본 (어두운 배경) | `#3A5A4D` (짙은 녹색, 지금 팔레트의 shadow) | `#F1F7EE` | 7.01:1 |
| 밝은 배경 (`OXY_TUI_THEME=light`) | `#A9CBA4` | `#1E2E28` | 7.97:1 |
| `NO_COLOR` | 반전 | 굵게 | – |

같은 띠를 jobs 화면의 맨 윗줄에도 쓴다 (H1).

**기호**: `◀` 는 `docs/tui-spec.md` §5 표에 없는 새 기호다. `▲▼` 와 같은 모양 글자라 1칸일 것으로 보지만, mintty · Windows Terminal 캡처로 1칸인지 확인한 뒤 §5 표에 더한다. 2칸으로 그려지면 `<` 를 쓴다.

### 계획 밖의 일 · 막힘 (2026-11-14)

요청 (사용자, 2026-11-14): "현재 메인 컨텍스트가 진행하고 있는 flow와 flow 모니터에 있는 내용이 서로 다른 것 같은데 확인해줘" → 원인 1~3 고치기 승인 ("1~3은 진행시키고").

확인한 사실 (설치본 cozy-example, 2026-11-14 00:00): 계획 p1~p5 가 끝난 뒤 "대여 생성 400 원인 확인 · 브라우저 검증" 을 하는데 모델은 `flow_note` (decision · next)로만 남겼다. 모니터는 계획 항목만 보여 `진행 중인 할 일이 없습니다` · `Next Task: 없음` 이었다. 23:10 의 `blocked: 사용자 지시로 작업 중단 …` 은 재개 뒤에도 남아 새 세션마다 모델에게 전달됐다.

- Current Task: 진행 중인 할 일이 없으면 막힘이 있을 때 `! <막힘>`, 없으면 모델의 다음 단계(`next`)를 지금 할 일 자리에 보인다. Next Task 는 계획의 다음 항목, 없으면 아직 안 보인 다음 단계, 그것도 없으면 `없음`.
- 막힘은 새 다음 단계 · 끝(`flow_note` next · done)을 기록하거나 할 일을 doing 으로 바꾸면 지운다.
- 계획이 모두 끝났거나 빠진 상태에서 새 요청이 오거나 모델이 next · decision 을 기록하면, "새 일은 `flow_plan add` 로 계획에 더하고 doing 으로 시작하라" 는 안내를 모델에게 준다 (숨은 메시지 · 도구 결과).
- 실측: 사용자 flow.json 복사본으로 만든 모델을 oxy-tui 0.4.0 `demo monitor` 47×19 로 그려 `! 사용자 지시로 작업 중단…` · `Next Task: 브라우저(web-page-automation)에서 …` 확인.

### Before Commit Task (2026-11-13)

요청 (사용자, 2026-11-13): "Jobs 라고 되어 있던 것들을 Task 로 바꾸고 background 와 같은 작업을 Jobs 로 표현하자, "job-1 중지됨" 과 같은 문구도 "Job-1 done!", "Job-1 stoped..", "Job-1 timeouted.." 와 같이 표현하고 부정적인 것에는 빨강색을, 긍정적인 것에는 기존과 같이 초록색을 그 둘 중 아무것도 아닐 때는 노랑색 … 하단 statusbar 에 Flow: n/n Jobs: n 과 같이 콜론 … Jobs 가 0 일 때도 표시 … Flow Monitor 에서는 커밋 전 작업을 Before Commit Task 로 명명하고 … 구분선으로 영역을 나눠줘, 이 부분은 커밋되면 사라지도록"

```
── Overall Task ───────────────────
…
── Before Commit Task ─────────────   ← 커밋 전 작업이 있을 때만
테스트는 vitest 로                      ← 결정 (최근 2)
변경 파일 3개
× npm test                              ← 실패한 명령 (최근 3, 앞의 cd <긴 경로> 는 …/<폴더>)
```

- "커밋 전 작업" 을 Overall Task 트리에서 빼고 셋째 구역 `Before Commit Task` 로 둔다 (가로줄 안 제목, Current Task · Overall Task 와 같은 모양).
- 커밋하면 사라진다: oxy-flow 가 커밋을 노드로 만들 때 버퍼의 결정 · 파일 · **실패**를 비운다 (전에는 해결 안 된 실패를 커밋 뒤에도 남겼다, `docs/flow-spec.md`).
- 높이: 트리에 최소 3줄(낮은 창이면 남는 만큼)을 남기고 남는 자리만 쓴다. 모자라면 오래된 줄부터 빼고, 1줄도 안 되면 구역을 뺀다. 최대 6줄.
- 구현 (2026-11-13, 부모): `oxy-monitor/model.ts` (`beforeCommitRows` · `flowModel`), `oxy-flow/store.ts` (`syncCommits`). 화면 프로그램은 구역 수에 매이지 않아 새 릴리스가 필요 없다 (Rust 시험만 셋째 구역을 허용하도록). 실측: oxy-tui 0.4.0 `demo monitor` 35×28 에서 `── Before Commit Task ──` 아래 결정 · `변경 파일 3개` · `× npm test`.

## 3. 걸린 시간 기록 (oxy-flow)

- `PlanItem` 에 `startedAt?`(처음 `doing` 이 된 시각) · `endedAt?`(`done` 이 된 시각)을 더한다. 다시 `doing` 으로 돌아가면 `endedAt` 을 지우고 `startedAt` 은 둔다.
- `todo` 에서 바로 `done` 이 된 할 일은 `startedAt` 이 없으므로 걸린 시간을 비운다 (지어낸 시간을 보이지 않는다).
- 항목의 걸린 시간: 할 일이 있으면 가장 이른 할 일 시작 ~ 가장 늦은 할 일 끝, 없으면 항목 자신의 시작 ~ 끝.
- 예전 `flow.json`(시각 없음)은 그대로 읽고 걸린 시간만 비운다. `FLOW.md` 에도 끝난 할 일 옆에 걸린 시간을 적는다 (R3).

## 4. Tokyo Night 테마

- **pi**: 패키지의 테마 파일만 반입한다 (T1). `manifest/tools.lock.tsv` 에 npm tarball 을 sha256 으로 고정해 `scripts/fetch-bundle.sh` 가 받고, `configure` 가 `agent/themes/tokyo-night.json` 으로 두고 `settings.json` 에 `"theme": "tokyo-night"` 를 쓴다. 사용자가 pi `/settings` 에서 테마를 바꿨으면 그 값을 덮어쓰지 않는다.
- **모니터 (`oxy-tui`)**: pi 테마가 `tokyo-night` 이면 모니터도 Tokyo Night 팔레트로 그린다 (T2). 강조 `#7aa2f7`, 진행 `#7dcfff`, 완료 `#9ece6a`, 주의 `#e0af68`, 실패 `#f7768e`, 흐린 글 `#565f89`, 선택 바탕 `#283457`. 한글 문구에 흐린 색을 쓰지 않는 규칙(`docs/tui-spec.md` §4)은 그대로다. 설치 · 설정 화면의 색은 바꾸지 않는다.
- **바탕색**: Windows Terminal 의 `Oxygen Pi` 프로필(설치 TUI 가 만든다)에 Tokyo Night 색 구성(바탕 `#1a1b26`)을 넣는다 (T3). mintty(Git Bash 기본 창)는 바꾸지 않는다.

## 5. 구현 순서와 확인 방법

1. 걸린 시간 기록 (§3) — 담당: 부모. 자동 검증: 단위(`doing` · `done` · 되돌림 · `todo` 에서 바로 `done` · 예전 파일) + E2E(`tests/rpc-flow.mjs` 에서 `startedAt` · `endedAt`)
2. 보기 모델 (§2) — 담당: 부모. 자동 검증: 단위(23 · 35칸 × 11 · 15줄: 세 영역, `[i/n]`, 트리 바, 오른쪽 열, 다음 할 일 고르기, 기본 포커스, 14줄 미만에서 상태 줄 뺌)
3. `oxy-tui` (§2 그리기 · §4 모니터 팔레트) — 담당: tui-implementer. 자동 검증: `just tui-test` / 실측: 예시 모델로 mintty 80×24 · 120×30 캡처, `◀` 가 1칸인지 WT 캡처 한 장
4. Tokyo Night 반입 · 적용 (§4 pi · Windows Terminal 프로필) — 담당: 부모 (설치 화면 문구가 바뀌면 그 부분만 tui-implementer). 자동 검증: 단위(settings 의 `theme` 을 덮어쓰지 않음) + `bash tests/installer-sandbox.sh` / 실측: 설치 sandbox 의 pi 가 tokyo-night 로 뜨는지
5. 실제 LLM 실측 — 담당: 부모. 하이쿠로 여러 단계 작업을 시키며 mintty 80×24 · 120×30 캡처 (Current · Next · Overall, 걸린 시간, 테마)
6. `oxy-tui` 릴리스 · 번들 · 설치본 반영 — 담당: 부모 [승인 필요: push · 릴리스 · 실제 설치본]

완료 조건: 1~6 과, 사용자가 3 · 5 의 캡처를 확인한 것.

### 구현 기록

- 1단계 (2026-11-13, 부모): `plan.ts` 의 `setStatus` 가 `startedAt` · `endedAt` 을 맞추고 `itemDuration` 이 걸린 시간을 계산한다. `FLOW.md` 의 끝난 할 일 옆에 `(m:ss)`.
- 2단계 (2026-11-13, 부모): `model.ts` 의 `planRows`(트리 · `[i/n]` · 오른쪽 열) · `currentRows` · `nextItem` · `flowSelection`(기본 포커스), `controller.ts` 의 이동이 고른 줄(기본: 지금 할 일)에서 시작한다. 최근 구역 · `nowRows` 는 지웠다.
- 3단계 (2026-11-13, tui-implementer): `oxy-tui` 0.3.0. 구역 0 제목도 가로줄, 행의 `prefix` 를 회색으로, 맨 윗줄 띠(팔레트별), `OXY_TUI_THEME=tokyo-night` 은 모니터 모드에서만(설치 화면은 기본 팔레트), Tokyo Night 의 고른 줄은 바탕 `#283457`.
  `◀` 는 mintty 80×24 · 120×30 과 Windows Terminal 에서 1칸으로 그려진다 (`3:10` 과 오른쪽 끝 열이 같다) → `docs/tui-spec.md` §5 에 더했다.
  증거: `just tui-test` `37 passed`, 캡처 scratchpad `fv3/mintty-{80x24,120x30}-{default,tokyo}.png` · `fv3/wt-80x24-tokyo.png` (2026-11-13). 밝은 배경 팔레트는 단위 시험으로만 확인했다.
- 4단계 (2026-11-13, 부모): `manifest/tools.lock.tsv` 에 `pi-tokyo-night` (role=harness, sha256 고정), `fetch-bundle.sh` 가 테마 파일만 `vendor/pi-themes` 로,
  `render-config.mjs` 의 `applyTheme` 가 `agent/themes` 로 복사하고 `settings.json` 의 `theme` 을 정한다, `monitor.ts` 가 pi 테마를 모니터 팔레트로 넘긴다(`monitorTheme`), WT 조각 파일에 색 구성 `Tokyo Night (Oxygen Pi)`.
  찾아 고친 것: GNU tar 가 `C:/…` 경로를 원격 호스트로 읽어 압축을 풀지 못했다 → `tar --force-local` (같은 방식인 agent-browser 줄은 범위 밖이라 그대로).
  증거: 단위 `# pass 70` (테마 · 모니터 팔레트 시험), `tests/installer-sandbox.sh` 통과 (새 검사 "WT 프로필: Tokyo Night 색 구성").
- 5단계 (2026-11-13, 부모, 대화형 pi 1.5.0 · claude-haiku-5-5 · psmux, mintty 120×30 · 80×24): 2단 계획(항목 2 × 할 일 2) → 편집 → background `sleep 25; node test.js` → 커밋을 두 번 시켰다.
  pi 가 tokyo-night 테마로, 모니터가 Tokyo Night 팔레트로 그려지고, Current Task(이름 · 경과) · Next Task · Overall Task(`[i/n]` · `├ └` · `◀ Current Task` · 끝난 항목의 걸린 시간 0:06 · 0:30)가 따라간다.
  `FLOW.md` 에 할 일마다 걸린 시간. 실패한 도구 0개. 비용 두 번 합쳐 약 $0.009. 증거: scratchpad `fv5/120x30-job.png` · `fv5/80x24-job.png` (2026-11-13).

## 6. 정할 것

- 없음 (2026-11-13 사용자가 모두 (a) 로 정했다. 아래는 그때의 선택지와 이유다)

- R1 Current Task 아래의 pi 상태 줄 — (a) 둔다 (높이 14줄 미만이면 뺀다) (b) 뺀다 (할 일 이름과 시간만).
  권장 (a): 할 일 하나가 몇 분씩 걸리는 동안 pi 가 지금 무엇을 실행하는지(1~4단계에서 만든 정보)를 flow 에서도 볼 수 있다. 좁은 화면에서는 jobs 맨 아래 줄로 충분하다.
- R2 flow 의 최근 구역 — (a) 뺀다 (b) 높이 16줄 이상일 때 Overall Task 아래에 둔다 (지금 규칙).
  권장 (a): 요청한 세 영역에 집중한다. 지금도 두 모니터를 함께 열면 높이가 모자라 보이지 않는다.
- R3 `FLOW.md` 에도 걸린 시간 — (a) 적는다 (b) 모니터에만.
  권장 (a): 같은 기록에서 나오므로 비용이 거의 없고, 모델이 다음 세션에서 읽는 기록에도 남는다.
- H1 맨 윗줄 띠를 쓸 화면 — (a) flow · jobs 둘 다 (b) flow 만.
  권장 (a): 두 모니터가 위아래로 붙어 있어, 띠가 각 모니터의 시작을 나누는 경계 역할도 한다.
- T1 `pi-tokyo-night` 에서 반입할 것 — (a) 테마 파일만 (b) 테마 + 머리말 extension.
  권장 (a): 머리말 extension 은 pi 시작 화면의 키 안내를 지우고 2칸 그림 글자(`🌙`)를 쓴다.
- T2 모니터 색 — (a) pi 테마가 tokyo-night 면 모니터도 Tokyo Night (b) 모니터는 지금 색.
  권장 (a): 같은 창의 왼쪽(pi)과 오른쪽(모니터) 색이 맞는다.
- T3 바탕색 — (a) Windows Terminal `Oxygen Pi` 프로필에 Tokyo Night 색 구성 (b) 터미널은 그대로.
  권장 (a): 바로가기로 여는 창이 이 프로필이고, pi 테마만으로는 바탕이 검정으로 남는다.
