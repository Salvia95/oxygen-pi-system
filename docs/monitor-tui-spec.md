# 모니터 화면 개편 명세 (Ratatui)

psmux 오른쪽 열의 jobs · flow 모니터를 화면 프로그램 `oxy-tui`(Ratatui)로 다시 그리고, pi 본 대화가 **지금 무엇을 하고 있는지**를 실시간으로 보인다.
pane 배치 · 하단 바 · 데이터 형식(jobs `state.json`, flow `flow.json`)은 `docs/monitor-spec.md` 를 그대로 따르고, 이 문서는 그 §5(모니터 프로그램)를 바꾸는 것과 새로 내보낼 실시간 활동만 정한다.
진행 상태: [진행판](dev-board.md) 의 `monitor-tui` 행.

요청 (사용자, 2026-11-12): flow · todo 모니터가 UI 적으로 정돈되어 있지 않고, 실시간으로 실행되고 있는 flow 가 무엇인지 잘 표시되지 않는다. Ratatui 로 구현하는 명세를 쓴다.
결정된 사항 (사용자, 2026-11-12)
- 화면은 Ratatui 로 그린다 (Ink · OpenTUI 는 쓰지 않는다). 설치 · 설정 화면에 쓰는 `oxy-tui` 에 모니터 모드를 더한다.
- (2026-11-12: "M1~M5 권장안대로 승인하고 1단계 진행해줘") 이 명세를 승인했다. M1 ~ M5 는 모두 (a): Node 가 보기 모델을 보내고 exe 는 그리기만,
  jobs · flow 두 종류(지금은 flow 맨 위 · jobs 맨 아래), 오른쪽 열 30% 그대로, 최근 구역에 모델 응답은 넣지 않음, 예전 pi-tui 화면은 대체 화면으로 남김.

## 1. 지금의 문제

| 문제 | 원인 |
| --- | --- |
| 지금 하는 일이 보이지 않는다 | 모니터가 읽는 상태 파일에 본 대화의 활동이 없다. jobs 는 백그라운드 작업만, flow 는 목표 · 계획 · 커밋만 있다. 응답 생성 중인지, 어떤 도구를 실행 중인지, 얼마나 걸렸는지는 pi 메모리에만 있다 |
| 진행 중인 할 일이 눈에 띄지 않는다 | 계획 트리에서 `doing` 은 아이콘 하나로만 다르다. 화면이 길면 진행 중인 항목이 아래로 밀려 보이지 않는다 |
| 화면이 정돈되어 보이지 않는다 | `view.ts` 가 글자 줄을 직접 이어 붙인다. 구역 구분 · 오른쪽 정렬 · 강조가 화면마다 제각각이다 |
| 화면 규칙 위반 | `⏳`(그림 글자, 2칸) · `✗` 를 쓴다. `docs/tui-spec.md` §6 은 1칸 글자만 허용한다 (`✓ × ! · …`, 진행 중은 점자 `⠋⠙⠹…`) |

좁은 폭이 전제다: 오른쪽 열은 80×24 에서 23 ~ 24칸, 120×30 에서 35 ~ 36칸이다 (`main-pane-width 70%`, `docs/monitor-spec.md` §1. 2026-11-13 이 PC 의 psmux 3.4.0 에서는 24 · 36칸).
화면은 exe 가 알리는 실제 크기(`resize` 이벤트)를 따르므로 규칙은 "30칸 미만이면 좁은 폭"으로 둔다.

## 2. 실시간 활동 내보내기 (pi extension)

모니터는 별도 프로세스라 pi 메모리를 볼 수 없다. oxy-monitor extension 이 pi 이벤트를 받아 파일로 내보낸다.

- 파일: `agent/jobs/run-<pid>-<시작 시각 ms>/live.json` — oxy-jobs 의 `state.json` 과 같은 실행 폴더. 대화형 모드에서만 쓴다 (`-p` 는 쓰지 않는다).
- 쓰는 방식은 `state.json` 과 같다: 원자적 쓰기, 1초에 4번 이하, 변화가 없어도 5초마다 `updatedAt`, pi 를 끝낼 때 `closed: true`.

```jsonc
{
  "version": 1, "pid": 12345, "updatedAt": 1763000000000, "closed": false,
  "agent": { "state": "tool", "since": 1762999990000, "turn": 3, "running": true },   // idle · thinking · tool · compacting. running: agent_start ~ agent_settled
  "tools": [ { "id": "call_1", "name": "bash", "summary": "npm test", "startedAt": 1762999995000 } ],   // 실행 중인 도구 (병렬이면 여러 개)
  "model": "oxy-vllm/qwen/qwen3.8-27b",
  "context": { "percent": 41 },
  "events": [ { "at": 1762999990000, "kind": "tool", "ok": true, "text": "edit src/login.ts" } ]   // 최근 20개, 오래된 것부터
}
```

| pi 이벤트 | 바뀌는 값 |
| --- | --- |
| `agent_start` | `agent.state = thinking`, `since` = 지금, `turn` 0 |
| `turn_start` | `agent.turn` = `turnIndex + 1`, 실행 중인 도구가 없으면 `thinking` |
| `tool_execution_start` | `tools` 에 더하고 `agent.state = tool` (`since` 는 첫 도구가 시작한 시각) |
| `tool_execution_end` | `tools` 에서 빼고 `events` 에 `kind: tool` (`ok` = 오류가 아님). 남은 도구가 없으면 `thinking` |
| `session_before_compact` / `session_compact` · `session_compact_failed` | `compacting` / 앞 상태로 |
| `agent_settled` | `agent.state = idle`, `tools` 비움 |
| 사용자 요청 (`before_agent_start`, `messageType` 이 `user`) | `events` 에 `kind: user` (앞 60자) |
| oxy-flow 변화 (`globalThis[Symbol.for("oxy.flow")]` 의 `onChange`) | 새 커밋 노드 → `kind: commit` (`커밋 n3 feat: …`), 할 일 상태 변화 → `kind: plan` (`p1.2 완료 테스트 작성`. 상태는 예정 · 진행 · 완료 · 막힘 · 제외) |
| oxy-jobs 변화 (`oxy.jobs` 의 `onChange`) | 작업 시작 · 끝 → `kind: job` (`job-2 시작`, `job-2 완료 (exit 0)`) |

- 도구 요약(`summary`): `bash` 는 명령 첫 줄, `read` · `edit` · `write` 는 경로, `grep` 은 찾는 말, `subagent` 는 `<agent>: <일 앞부분>`, `flow_plan` 은 `동작 id 상태`, `flow_note` 는 `종류 글`, 그 밖은 비운다(이벤트에는 도구 이름만). 120자에서 자른다.
- 도구 출력 · 파일 내용 · 모델 응답은 쓰지 않는다. 명령줄은 `state.json` 이 이미 쓰는 것과 같은 수준이다.
- 컨텍스트 사용률은 pi 상태줄과 같은 값(`ctx.getContextUsage()`)이다.
- 구현 (1단계, 2026-11-13): `agent/extensions/oxy-monitor/live.ts` (이벤트 → 상태 · 작업/계획 변화 → 이벤트, 순수 함수), `index.ts` 가 pi 이벤트를 받아 `StateWriter`(`fileName: "live.json"`)로 쓴다.
  oxy-jobs 는 `runDir()` · `jobs()`, oxy-flow 는 `summary()` 에 `items` · `lastNode` 를 더해 내보낸다.
- 실측 (2026-11-13, 대화형 pi 1.5.0 · mock LLM · psmux 100×30): 계획 · 커밋 시나리오와 3초 걸리는 bash 를 실행하는 동안 `live.json` 이 `tool`(도구 요약 `sleep 3; echo live-tool-done`) → `thinking` → `idle` 로 바뀌고,
  최근 이벤트에 사용자 요청 · `flow_plan` · `p1 → doing` · `커밋 n1 feat: add g` · `p1 → done` · 도구가 순서대로 남았다. pi 를 끝내면 `closed: true`. 실제 LLM 으로는 5단계에서 본다.

## 3. 화면

화면은 `oxy-tui` 의 모니터 모드가 그린다 (구조는 §4). 기호 · 색 · 말줄임은 `docs/tui-spec.md` §6 을 따른다: 1칸 글자만, 한글 문구에 회색(dim)을 쓰지 않는다, 경로는 가운데를 줄인다.

상태 기호 (jobs · flow 공통): 진행 중 = 점자 스피너(1초에 10번 바뀐다), `·` 예정 · 대기, `✓` 완료, `×` 실패, `!` 막힘, `■` 중지, `-` 뺌.

### flow 화면

위에서 아래로 세 구역. 구역 사이는 가로줄 한 줄.

```
flow           할 일 2/5        ← 제목 · 진행 (오른쪽 정렬)
⠹ 도구 실행 중      0:12        ← 지금: 상태 · 경과
  bash npm test                 ← 지금: 실행 중인 도구 (여러 개면 줄마다)
⠹ p1.2 테스트 작성               ← 지금: 진행 중인 할 일
─────────────────────────
✓ p1 로그인 API        n1        ← 계획 트리
  ✓ p1.1 라우트        n1
  ⠹ p1.2 테스트 작성
· p2 문서
─────────────────────────
✓ edit src/login.ts              ← 최근 (새 것이 아래)
× bash npm test
✓ 커밋 n1 feat: 라우트
▲▼ 이동  Enter 펼치기  q 닫기
```

- **지금** (항상 맨 위, 최대 4줄)
  - 상태 문구: `대기 중`(입력을 기다림) · `응답 생성 중` · `도구 실행 중` · `compaction 중`. 대기가 아니면 스피너와 경과(`m:ss`, 오른쪽 정렬).
  - 실행 중인 도구: 한 줄에 하나, `도구 이름 + 요약`. 넘치면 마지막 줄을 `외 2개` 로.
  - 진행 중인 할 일: 첫 번째 `doing` 할 일(없으면 항목). 계획이 없으면 이 줄을 두지 않는다.
  - `live.json` 이 없거나 10초 넘게 갱신되지 않으면 `pi 상태를 알 수 없습니다` 한 줄 (5초마다 갱신되므로 두 번 놓친 경우. 5초로 하면 갱신 직전에 깜박인다).
- **계획** (남는 높이를 차지, 스크롤)
  - 진행 중인 항목 · 할 일은 강조색과 스피너. 화면에 늘 보이도록 스크롤을 맞춘다 (사용자가 `▲▼` 키로 움직인 뒤 10초 동안은 사용자 위치를 둔다).
  - 연결된 커밋은 오른쪽 정렬(`n2 n3`), 폭이 모자라면 뺀다.
  - 계획이 없고 목표만 있으면 목표 한두 줄, 기록이 없으면 `작업 기록이 없습니다.`
  - 계획 아래에 지금 화면과 같이 `계획 밖 커밋` · `커밋 전 작업`(결정 · 변경 파일 수 · 실패)을 둔다 (`docs/monitor-spec.md` §5 의 기존 정보를 잃지 않는다).
- **최근** (높이 16줄 이상일 때만, 3~5줄)
  - `live.json` 의 `events` 를 새 것이 아래로. 실패는 `×` 와 오류색. 사용자 요청은 기호 없이 `요청 <앞 60자>`.
- 펼치기(`Enter`): 할 일 · 커밋을 고르면 그 아래에 결정 · 변경 파일을 들여 쓴다 (지금과 같다).

### jobs 화면

```
jobs        실행 중 2 · 완료 1
⠹ bg   npm run build     0:41
⠹ sub  scout: 로그 찾기   0:12
✓ bg   npm test          1:03
─────────────────────────
⠹ 응답 생성 중            0:05    ← 지금 (한 줄): 본 대화가 무엇을 하는지
▲▼ 이동  Enter 로그  s 중지  q 닫기
```

- 목록: 상태 기호 · 종류(`bg` · `sub`) · 이름 · 경과(오른쪽 정렬). 23칸이면 종류를 빼고, 그래도 모자라면 이름을 줄인다.
- 맨 아래 한 줄에 본 대화의 지금 상태 (flow 를 열지 않아도 보이게).
- 로그 보기 · 중지 확인(`s` 두 번)은 지금과 같다.

### 폭과 높이

| 창 | 오른쪽 열 | 규칙 |
| --- | --- | --- |
| 80×24 | 23칸 | 키 안내는 두 줄로 줄여 쓴다. 커밋 번호 · 종류 열을 뺀다. 최근 구역은 높이 16줄 미만이면 두지 않는다 (모니터 둘이면 한 pane 이 11~12줄) |
| 120×30 | 35칸 | 모든 열을 보인다 |

모든 줄은 열 폭 안에 들어간다 (넘치면 `…`). 줄이 넘쳐 다음 줄로 밀리는 일이 없어야 한다.

## 4. 프로그램 구조

권장안 (§7 M1 (a)) 기준. 설치 화면과 같은 원칙(로직은 Node, 화면은 Rust)을 따른다.

- `monitor.ts` (Node, 지금 파일): 상태 파일(`state.json` · `flow.json` · `live.json`)을 읽고 보기 모델을 만든다. 형식 해석은 TS 한 곳에만 있다.
- `oxy-tui.exe --pipe <이름> --mode monitor`: 보기 모델을 받아 그리고, 키를 이벤트로 돌려준다. 스피너 · 경과 시간은 exe 가 시계로 갱신한다 (Node 가 1초마다 보내지 않는다).
- 통신 규약 (`protocol.rs` 머리말에 더한다)
  - `{"op":"monitor", kind, title, right, now:[행], nowAt:"top"|"bottom", sections:[{title, rows:[{key, marker, text, right, indent, emphasis, error, since}]}], keys:[줄], selected}` — 보기 전체. 답 없음. 상태가 바뀔 때마다 다시 보낸다.
  - 줄 수는 Node 가 맞춰 보낸다 (높이 안에서 어느 줄을 보일지 · 좁은 폭에서 뺄 열 · 키 안내 줄 나누기). exe 는 받은 줄을 그대로 그리고, 글 폭에 맞춰 자르기만 한다.
    줄 배치: 제목 1줄 → (`nowAt: top` 이면) 지금 → 가로줄 → 구역들 (구역 사이 가로줄, 구역 제목은 가로줄 안에) → (`bottom` 이면) 가로줄 → 지금 → 키 안내. 이 규칙의 줄 수는 `model.ts` 의 `modelHeight` 와 같아야 한다.
  - 화면 크기가 바뀌면 exe 가 `{"event":"resize","width","height"}` 를 보내고 Node 가 새 크기로 다시 보낸다.
  - `marker` 는 `spinner` · `todo` · `done` · `failed` · `blocked` · `stopped` · `dropped` (기호는 exe 가 정한다). `since` 가 있으면 exe 가 경과를 그린다.
  - 이벤트 `{"event":"key","key":"up|down|enter|esc|s|q"}`. 선택한 줄은 Node 가 정해 `selected` 로 보낸다 (exe 는 선택을 따로 기억하지 않는다).
  - 지원 확인: 새 exe 는 `oxy-tui --version` 에 `monitor` 를 함께 출력한다 (예 `oxy-tui 0.2.0 monitor`). 예전 exe(v0.1.0)는 `--mode` 를 모르고 설치 화면 규약으로 기다리므로, Node 는 띄우기 전에 버전 출력으로 확인한다.
- 예전 화면(pi-tui)은 남긴다: `oxy-tui.exe` 가 없거나 모니터 모드를 모르면(`--mode monitor` 에 오류) 지금의 pi-tui 화면으로 그린다 (§7 M5).

- 구현 (2단계, 2026-11-13): `agent/extensions/oxy-monitor/model.ts` (`flowModel` · `jobsModel` · `nowRows` · `planRows` · `recentRows` · `modelHeight`). 색 코드 없이 상태 기호 이름(`marker`)만 담는다.
  지금의 pi-tui 화면(`view.ts`)은 M5 대로 대체 화면으로 남기고 아직 바꾸지 않았다 (`⏳` · `✗` 는 4단계에서 대체 화면에도 고친다).

- 구현 (3단계, 2026-11-13, tui-implementer): `installer/oxy-tui/src/monitor.rs` (그리기 · 줄 배치 · 스피너 · 경과), `main.rs` 의 `--mode monitor` · `demo monitor --model`, `--version` 에 `monitor` (`oxy-tui 0.2.0 monitor`).
  jobs 의 지금(`nowAt: bottom`)은 키 안내 바로 위에 붙이고, 목록이 짧으면 빈 줄은 목록과 그 가로줄 사이에 둔다.
  예시 모델은 `tests/monitor-fixtures.mjs` 가 `model.ts` 로 만든다 (`tests/fixtures/monitor/`, `model.ts` 를 바꾸면 다시 만든다. unit-tui 가 최신인지 본다).
  Ctrl+C 는 `{"event":"interrupt"}` 를 보내고(Node 가 `q` 처럼 처리), 지시 연결이 끊기면 터미널을 되돌리고 종료 코드 1.
  함께 바꾼 공용 규칙: `text::fit` 이 상대 경로와 긴 파일 이름도 가운데를 줄이고, `parts.rs` 의 맥락 · 설명 · 알림 · 결과 줄이 `fit` 을 쓴다 (설치 화면에도 적용). `TERM=dumb` 에서 색을 끈다.
- 실측 (2026-11-13, mintty 80×24 · 120×30, psmux 오른쪽 30% pane 에 예시 모델, WT 80×24): 줄 넘침 없음, 점자 스피너 · `✓ × ■ ! ▲▼` 1칸, 선택 줄 반전, jobs 지금 줄이 맨 아래.
  설치 화면(폴더 선택)의 경로가 가운데에서 줄어드는 것도 확인. 증거: scratchpad `mtui2/a-*` · `b-*` · `i-*` (2026-11-13).

- 구현 (4단계, 2026-11-13): `monitor.ts` 가 `bin/oxy-tui.exe --version` 에 `monitor` 가 있으면(`controller.ts` 의 `supportsMonitor`) `installer/tui.mjs` 의 `ExeLink` 로 exe 를 `--mode monitor` 로 띄우고,
  상태 파일이 바뀌면 바로 · 그 밖에는 1초마다 보기 모델을 다시 만들어 바뀐 경우에만 보낸다. 키 처리는 `controller.ts` (`flowKey` · `jobsKey`, 순수 함수). `interrupt` 는 `q` 와 같다.
  exe 가 없거나 모니터 모드를 모르면 · `OXY_MONITOR_TUI=pi` 면 예전 pi-tui 화면(`view.ts`)으로 그린다. 대체 화면의 기호도 1칸으로 고쳤다 (`⏳` → `⠿`, `✗` → `×`, `↑↓` → `▲▼`).
  flow 화면도 지금 상태를 위해 pi 의 실행 폴더(`live.json`)를 읽는다.
- 실측에서 찾아 고친 것 (2026-11-13): `live.json` 을 5초마다 다시 쓸 때 `updatedAt` 을 새로 넣지 않아, 긴 도구가 10초를 넘으면 모니터가 `pi 상태를 알 수 없습니다` 로 바뀌었다.
  쓸 때마다 `updatedAt` 을 새로 넣고, E2E 에 "긴 도구 동안에도 5초마다 갱신" 검사를 더했다 (고치기 전 코드에서 FAIL, 고친 뒤 PASS 확인).
- 실측 (2026-11-13, 대화형 pi 1.5.0 · mock LLM · psmux, mintty 120×30 · 80×24): `/monitor flow` · `/monitor jobs` 가 oxy-tui 로 열리고, 40초 bash 를 실행하는 동안 지금(`도구 실행 중` · 경과 · 명령) · 계획 · 백그라운드 작업 경과가 갱신된다.
  pi 의 경과(24.2s)와 모니터의 경과(0:25)가 맞는다. 80×24 에서는 오른쪽 열 24칸 · 종류 열 없음 · 키 안내 두 줄. `OXY_MONITOR_TUI=pi` 로 띄우면 pi-tui 대체 화면이 열린다.
  증거: scratchpad `m4/120x30-b.png` · `m4/80x24.png` · `m4/*.txt` (2026-11-13). mintty 에 붙인 화면은 pane 보다 한 줄 덜 보인다 (3단계와 같은 현상, 원인 미확인).

## 5. 확인된 사실

- 오른쪽 열 폭: 80×24 에서 23칸, 120×30 에서 35칸 (`docs/monitor-spec.md` §1 실측).
- pi 1.5.0 extension 이벤트에 `agent_start` · `agent_settled` · `turn_start` · `tool_execution_start` / `_end` · `session_before_compact` / `session_compact` 가 있다 (`vendor/pi/.../docs/extensions.md`). 실제 순서와 병렬 도구에서의 짝은 1단계에서 실측한다.
- 점자 스피너는 WT 와 mintty 에서 1칸으로 그려진다 (pi 의 `⠦ Working`, WT 캡처 2026-11-12. mintty 는 1단계 캡처에서 다시 본다).

## 6. 구현 순서와 확인 방법

1. 실시간 활동 내보내기 (§2) — 담당: 부모. 자동 검증: 단위(이벤트 → `live.json` 을 만드는 순수 함수, 병렬 도구 · compaction · 실패 포함) + E2E(`tests/rpc-jobs.mjs` 에 bash 도구 실행 중 `agent.state = tool`, 끝난 뒤 `idle` 과 `events`) / 실측: 대화형 pi + mock 에서 `live.json` 을 보며 상태가 바뀌는지
2. 보기 모델 (§3) — 담당: 부모. 자동 검증: 단위(`view.ts` 를 보기 모델 함수로: 23 · 35칸 × 높이 11 · 24줄에서 구역 · 줄 수 · 진행 중 항목이 보이는지)
3. `oxy-tui` 모니터 모드 (§3 §4) — 담당: tui-implementer. 자동 검증: `just tui-test`(23×12 · 35×28 버퍼에 그린 결과), 단위(`unit-tui`: `model.ts` 로 만든 예시 모델을 exe 가 받아 그림) /
   실측: `model.ts` 로 만든 예시 모델을 exe 에 넣어, psmux 의 오른쪽 30% pane(pi 자리는 빈 셸)에서 mintty 80×24 · 120×30 캡처 (flow · jobs, 두 모니터를 함께 연 경우), WT 캡처 한 장
4. `monitor.ts` 연결과 예전 화면 대체 (§4) — 담당: 부모. 자동 검증: 단위(모니터 모드가 없는 exe 에서 pi-tui 화면으로) + E2E /
   실측: `tuicap` 으로 pi + mock 이 긴 bash 와 계획을 실행하는 동안 mintty 80×24 · 120×30 캡처 (실시간 갱신 · 스피너 · 경과), 새 exe 가 없을 때 예전 화면으로 열리는지
5. 실제 LLM 실측 — 담당: 부모. 실측: Groq 연결로 여러 단계 작업(계획 · 편집 · 테스트 · 커밋)을 시키며 모니터가 따라가는지 `tuicap` 으로 확인 (사용자 화면은 쓰지 않는다)
6. `oxy-tui` 릴리스 · `manifest/tools.lock.tsv` sha, 번들 · 설치본 반영 — 담당: 부모 [승인 필요: push · 릴리스 · 실제 설치본]

완료 조건: 1~6 과, 사용자가 3 · 5 의 캡처를 확인한 것 (확인한 캡처가 이 화면의 명세가 된다).

## 7. 정할 것

- 없음 (M1 ~ M5 는 2026-11-12 사용자가 (a) 로 정했다. 아래는 그때의 선택지와 이유다)

- M1 프로그램 구조 — (a) Node 가 상태 파일을 읽어 보기 모델을 보내고 exe 는 그리기만 (b) exe 가 상태 파일을 직접 읽는다.
  권장 (a): 상태 파일 형식이 TS 한 곳에서만 해석되어, 형식을 바꿔도 Rust 를 다시 릴리스하지 않아도 된다. 설치 화면과 같은 구조다. 대가는 pane 하나에 프로세스 두 개(Node + exe).
- M2 모니터 구성 — (a) 지금처럼 jobs · flow 두 종류, "지금"은 flow 맨 위와 jobs 맨 아래 (b) 하나로 합친 `활동` 모니터 (지금 · 계획 · 작업 · 최근).
  권장 (a): 하단 바와 켜고 끄기(2026-11-12 사용자 결정)를 그대로 쓴다. 23칸에서 네 구역은 너무 좁다.
- M3 오른쪽 열 폭 — (a) 30% 그대로, 23칸 기준으로 줄여 그린다 (b) 모니터가 열려 있을 때 35%.
  권장 (a): 사용자가 정한 배치다. 23칸 규칙(§3 폭과 높이)으로 충분한지는 3단계 캡처로 본다.
- M4 최근 구역에 넣을 것 — (a) 도구 · 커밋 · 작업 · 할 일 변화 · 사용자 요청 (b) (a) + 모델 응답 첫 줄.
  권장 (a): 응답 내용은 pi 화면에 있고, 모니터는 무엇을 했는지만 보인다.
- M5 예전 화면(pi-tui) — (a) exe 에 모니터 모드가 없을 때 쓰는 대체 화면으로 남긴다 (b) 지운다.
  권장 (a): 새 exe 가 들어간 번들이 퍼지기 전까지 예전 번들의 exe 와 섞여 쓰인다.
