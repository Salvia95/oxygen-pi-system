# 모니터 pane 설계 (oxy-jobs · oxy-flow)

pi 하단 바의 항목을 누르면 psmux 오른쪽 열에 모니터 pane 이 열리고, 그 안에서 백그라운드 작업·subagent(oxy-jobs)와 작업 흐름·할 일(oxy-flow)을 본다.
이 문서는 구현 전에 합의할 형식과 규칙이다. 승인 후 §7 순서대로 구현한다.

결정된 사항 (사용자, 2026-11-12)
- 모니터 pane 은 터미널 오른쪽 30% 열에 열고, 호출한 순서대로 위에서 아래로 쌓는다. 쌓인 pane 은 같은 높이로 나눈다.
- 모니터 프로그램은 Node 스크립트로 만든다.
- todo 는 지금 메인 컨텍스트에서 하는 작업 흐름의 항목별 할 일을 위에서 아래로, 계층으로 보여 주는 것이다. oxy-flow 를 확장해서 채운다. 계층은 2단까지.
- 하단 바는 빈 입력창에서 `↓` 로 들어가 `←` `→` 로 고르고 `Enter` 로 연다 (별도 단축키 없음).
- 입력창 위 작업 목록은 쓸모가 있는 곳(psmux 밖)에서는 남기고, 모니터 pane 이 대신하는 곳(psmux 안)에서는 하단 바로 대체한다.

## 1. 화면 배치

```
┌──────────────────────────────┬────────────┐
│                              │ jobs       │  ← 1번째로 연 모니터
│  pi (70%)                    ├────────────┤
│                              │ flow       │  ← 2번째로 연 모니터
│                              │            │
│ ▸ jobs 2 실행 중  ▸ flow 3/7 │            │
└──────────────────────────────┴────────────┘
```

규칙과 psmux 명령 (psmux 3.4.0, 하네스 서버 `-L oxy`에서 실측)

| 규칙 | 방법 |
|---|---|
| 오른쪽 30% 열 | 창 옵션 `main-pane-width 70%` + `select-layout main-vertical`. main pane 은 pane index 0 (= pi)이고 포커스와 무관하다 |
| 호출 순서대로 위→아래 | 첫 모니터는 pi pane 을 `split-window -h -d`, 그다음부터는 마지막 모니터 pane 을 `split-window -v -d` 로 나눈다 (index 순서 = 호출 순서). 나눈 뒤 바로 `select-layout main-vertical` |
| 같은 높이 | `main-vertical` 이 오른쪽 열을 똑같이 나눈다 (120×30 에서 3개 → 9·9·10, 2개 → 14·15) |
| 닫힌 뒤에도 유지 | 세션에 `set-hook pane-exited 'select-layout main-vertical'` 을 건다. 모니터가 스스로 끝나도 남은 pane 이 다시 같은 높이로 맞춰진다 |
| 창 크기를 바꿔도 유지 | 70/30 비율과 같은 높이가 유지된다 (120×30 → 100×24: 69 / 30) |
| 포커스 | `-d` 로 열어 포커스는 pi 에 둔다. 모니터를 조작하려면 그 pane 을 클릭한다 (psmux `mouse on`) |

쓰면 안 되는 것: psmux 의 `resize-pane -x/-y` 는 tmux 와 달리 크기를 절대값으로 맞추지 않는다 (`-y 10` → 2줄). 크기는 `main-vertical` 로만 맞춘다.

pane 관리
- 모니터 종류마다 pane 은 하나다. pane 옵션 `@oxy_monitor=<종류>` 로 표시하고 `list-panes -F '#{pane_id} #{@oxy_monitor}'` 로 찾는다.
- 이미 열린 종류를 다시 누르면 그 pane 을 닫는다 (켜고 끄기). 닫으면 나머지가 위로 올라가고 같은 높이로 다시 나뉜다.
- 모니터는 pi 의 pid 를 감시하다가 pi 가 끝나면 스스로 종료한다. 그래야 pi pane 이 닫힐 때 세션이 남지 않는다 (`scripts/mux/psmux.sh` 의 `oxy_mux_exec` 는 pi 가 끝나면 세션도 끝난다는 전제다).
- `main-pane-width` 와 hook 은 이 세션에만 건다. `agent/psmux.conf` 에 넣지 않는다 (같은 서버의 terminal-session-control 세션에 영향을 주지 않도록).

알려진 제약
- 같은 창에 사용자가 직접 나눈 pane 이 있으면 그 pane 도 오른쪽 열에 들어간다.
- 80×24 에서 오른쪽 열은 23칸이다. 모니터 화면은 23칸에서도 줄이 깨지지 않아야 한다 (§5).
- psmux 밖에서는 (`OXY_MUX=none`, `$TMUX` 없음) pane 을 열지 않는다. §2 의 대체 동작을 따른다.

## 2. 하단 바 (pi extension)

- 입력창 아래(`setWidget(..., { placement: "belowEditor" })`)에 한 줄. 항목: `jobs`, `flow`.
  - `▸ jobs 2 실행 중 · 1 완료` — 실행 중이거나 최근 2분 안에 끝난 작업이 있을 때만
  - `▸ flow 3/7` — 계획(§4)의 완료/전체 할 일 수. 계획이 없으면 마지막 단계 번호(`n4`)
  - 모니터 pane 이 열린 항목은 강조색으로 표시한다
- 클릭: 컴포넌트 위젯을 pi-tui `MouseRegion` 으로 감싸고, 이벤트의 x 좌표로 어느 항목인지 가린다. 누르면 그 종류의 모니터를 켜고 끈다 (§1).
  - pi fullscreen 모드(기본값)에서만 마우스를 받는다. regular 모드에서는 키보드로만 연다.
  - 실측: mintty 창 클릭 → psmux → pane 안 node 에 SGR `\e[<0;x;yM` 도착. Windows Terminal 은 아직 확인하지 않음.
- 키보드 (Claude Code 하단 표시와 같은 방식, 별도 단축키 없음)

  | 상태 | 키 | 동작 |
  |---|---|---|
  | 입력창이 비어 있고 입력창에 포커스 | `↓` | 하단 바로 이동, 첫 항목 강조 |
  | 하단 바 | `←` `→` | 항목 이동 (끝에서 반대쪽으로 돌아감) |
  | 하단 바 | `Enter` | 그 항목의 모니터 pane 열기 / 이미 열려 있으면 닫기 |
  | 하단 바 | `↑` `Esc` | 입력창으로 돌아감 |
  | 하단 바 | 그 밖의 키 (글자 등) | 입력창으로 돌아가고 그 키는 입력창에 그대로 들어감 |

  - 구현: `ctx.ui.onTerminalInput` 으로 키를 먼저 받는다. 이 함수는 포커스와 관계없이 모든 키를 받으므로, 포커스가 입력창(`getText`·`setText` 가 있는 컴포넌트)이고 오버레이가 없을 때만 `↓` 를 가로챈다. 입력창에 글이 있으면 `↓` 는 원래대로 (줄 이동 · 기록 탐색) 동작한다.
  - 하단 바에 항목이 없으면 `↓` 를 가로채지 않는다.
  - 다른 확인 경로: `/monitor jobs`, `/monitor flow` 명령.
- psmux 밖: 바는 그대로 보이고, `Enter`/클릭하면 지금의 `/jobs` 목록 대화상자를 연다. flow 는 `/flow` 보기와 같다.
- 입력창 위 작업 목록 위젯(`oxy-jobs`, 최대 6줄): psmux 안에서는 모니터 pane 이 같은 역할(실행 중 작업과 마지막 출력)을 맡으므로 숨기고 하단 바로 대체한다. psmux 밖에서는 모니터 pane 을 열 수 없어 이 목록이 유일하게 실시간으로 보이는 화면이므로 그대로 둔다. 상태줄(`setStatus`)은 두 경우 모두 그대로 둔다.

## 3. 데이터 형식: oxy-jobs

모니터는 별도 프로세스라 pi 메모리를 볼 수 없다. oxy-jobs 가 상태를 파일로 내보낸다.

실행 폴더 — extension 실행 하나(세션 하나)마다 하나. `/new`, 세션 넘기기 때는 새 폴더가 생긴다.

```
agent/jobs/run-<pid>-<시작 시각 ms>/
  state.json        현재 상태 (아래 형식). 대화형 모드에서만
  logs/<job-id>.log 작업 로그 (예전 agent/jobs/<시각>-<id>.log 를 옮김)
  logs/<job-id>.pid bash 작업의 MSYS pid (중지할 때 프로세스 그룹을 찾는 데 쓴다)
  control/          모니터 → pi 요청
```

`state.json` (version 1)

```jsonc
{
  "version": 1,
  "pid": 12345,               // pi 프로세스
  "startedAt": 1762900000000,
  "updatedAt": 1762900012345, // 변경 시 + 실행 중이 아니어도 5초마다 (모니터가 pi 가 살아 있는지 판단)
  "closed": false,            // pi 가 이 실행을 끝냄 (세션 종료 · 교체). 강제 종료되면 false 로 남으므로 모니터는 pid 도 확인한다
  "cwd": "C:/work/proj",
  "slots": { "agents": { "running": 1, "limit": 2, "waiting": 0 }, "bash": { "running": 1, "limit": 4, "waiting": 0 } },
  "jobs": [{
    "id": "job-3", "kind": "bash" /* | "agent" */, "state": "running" /* queued|running|done|failed|stopped */,
    "label": "npm test",
    "agent": "scout",          // kind=agent 일 때
    "task": "…",               // kind=agent: 맡긴 작업 전문 (bash: 명령 전문)
    "createdAt": 0, "startedAt": 0, "endedAt": null, "exitCode": null,
    "usage": { "turns": 3, "input": 12000, "output": 800 },
    "log": "logs/job-3.log",   // 실행 폴더 기준 상대 경로
    "last": "마지막 출력 한 줄",
    "result": "subagent 최종 답변 앞부분 (최대 2000자)"
  }],
  "control": { "seq": "…", "ok": true, "message": "Stopped job-3." } // 마지막으로 처리한 요청의 결과
}
```

- 쓰기: 임시 파일에 쓴 뒤 이름 바꾸기(oxy-flow 의 `writeAtomic` 과 같은 방식). 변경은 초당 최대 4번으로 묶는다.
- 요청: 모니터가 `control/<시각>-<난수>.json` 에 `{ "seq": "<파일 이름>", "op": "stop", "id": "job-3" }` 을 쓴다. pi 는 `fs.watch` (+1초 폴링 대체)로 읽고 처리한 뒤 파일을 지우고 결과를 `state.json` 의 `control` 에 쓴다. 지금은 `stop` 만 받는다.
- 모니터가 찾는 방법: 인자로 받은 pi pid 의 `run-<pid>-*` 중 가장 최근 폴더. 세션이 바뀌어 새 폴더가 생기면 그쪽으로 옮겨 간다.
- 정리: 시작할 때 pid 가 살아 있지 않은 실행 폴더는 최근 20개만 남긴다 (지금의 로그 50개 정리를 대체).
- 비대화형(`-p`, json) 모드와 subagent(자식 pi)에서는 `state.json` 과 `control/` 을 만들지 않는다 (로그만).
- 중지 방식: Git Bash(MSYS)는 fork/exec 를 흉내 내느라 손자 프로세스의 Windows 부모가 끊겨 있어 `taskkill /T` 로는 `sleep` · 서버가 남고 출력 파이프도 닫히지 않는다 (실측: 중지 후 `close` 가 20초 뒤 `sleep` 이 끝날 때 옴). 그래서 bash 작업은 시작할 때 bash 가 자기 MSYS pid(`$$`)를 `logs/<id>.pid` 에 적고, 중지할 때 그 프로세스 그룹 전체에 `kill -9 -- -<pid>` 를 보낸 뒤 `taskkill /T` 를 한다 (중지 후 0.25초 안에 끝남). 이 문제는 이번 작업 전부터 `/jobs` 중지와 세션 종료에도 있었다.

## 4. 데이터 형식: oxy-flow 계획(할 일) 트리

지금 flow 는 지나간 일(커밋 단위 노드와 결정)만 기록한다. 여기에 앞으로 할 일을 계층으로 담는 `plan` 을 더한다.

```
목표: 결제 모듈 리팩터링
├─ ✓ p1 기존 구조 파악                         n1
│   ├─ ✓ p1.1 결제 흐름 읽기
│   └─ ✓ p1.2 테스트 현황 확인
├─ ⏳ p2 PaymentService 분리                   n2 n3
│   ├─ ✓ p2.1 인터페이스 정의
│   ├─ ⏳ p2.2 구현 옮기기
│   └─ · p2.3 호출부 바꾸기
└─ · p3 통합 테스트
```

`flow.json` 에 선택 필드로 추가한다 (기존 파일은 그대로 읽힌다: 없으면 빈 계획).

```jsonc
"plan": [{
  "id": "p2", "text": "PaymentService 분리",
  "status": "doing",          // todo | doing | done | blocked | dropped
  "at": 1762900000000,        // 마지막으로 상태가 바뀐 시각
  "nodes": ["n2", "n3"],      // 이 항목이 doing 일 때 생긴 커밋 노드
  "children": [{ "id": "p2.1", "text": "인터페이스 정의", "status": "done", "at": 0, "nodes": [], "children": [] }]
}]
```

- 계층은 2단까지다 (작업 흐름의 항목 → 그 항목의 할 일). 소형 모델이 깊은 트리를 관리하다 틀리지 않도록. (사용자 확인, 2026-11-12)
- 모델 도구 `flow_plan` (새로 추가)
  - `action=set, items=[{text, children:[{text}]}]` — 계획 전체를 쓴다. id 는 extension 이 매긴다. 이미 done 인 항목은 같은 글이면 상태를 유지한다.
  - `action=add, parent?="p2", text` — 항목(또는 할 일) 하나 추가
  - `action=update, id="p2.2", status?, text?` — 상태·글 바꾸기. 할 일이 모두 done 이면 위 항목도 done 으로 바꾼다.
- 자동 기록: 커밋 노드가 생기면 그 시점에 doing 인 가장 깊은 항목의 `nodes` 에 붙인다.
- `next` 와의 관계: 계획이 있으면 컨텍스트와 FLOW.md 의 "다음"은 첫 번째 doing(없으면 todo) 할 일로 보여 준다. `flow_note kind=next` 는 계획이 없을 때를 위해 남긴다.
- 컨텍스트에 넣는 계획: done 항목은 접어서 개수만, 나머지는 한 줄씩. 프롬프트 길이가 늘어나므로 넣기 전후를 실측한다 (scenario-eval, Groq 실제 모델).
- `/flow new` 로 작업을 보관하면 계획도 함께 보관된다.

## 5. 모니터 프로그램 (Node 스크립트)

- 위치: `agent/extensions/oxy-monitor/monitor.ts` (같은 폴더의 `index.ts` 가 하단 바와 pane 관리를 맡는 extension).
- 실행: 번들 Node 로 `.ts` 를 바로 실행한다 (Node 22.23.4 에서 확인, `oxy-flow/store.ts` 를 읽기 전용 `FileFlowEngine` 으로 그대로 불러온다). 화면은 번들의 pi-tui (`TuiAltScreen`, `ProcessTerminal`, `ScrollView`, `SelectList`). 새 바이너리는 없다.
- 인자: `monitor.ts <jobs|flow> --pi-pid <pid> --cwd <폴더>`
- 갱신: 상태 파일을 `fs.watch` 하고 1초 폴링으로 보완한다.
- pi 가 끝나면 (`state.json` 의 pid 가 사라지거나 pi pid 가 죽음) 스스로 종료한다.
- 맨 윗줄은 제목 (`jobs`, `flow`), 맨 아랫줄은 키 안내. 23칸에서도 잘리지 않게 줄여 쓴다.

jobs 화면
- 목록: 상태 아이콘(`·` 대기, `⏳` 실행, `✓` 완료, `✗` 실패, `■` 중지) · id · 종류 · 이름 · 걸린 시간. 폭이 좁으면 이름과 시간만.
- `↑↓` 이동, `Enter` 로그 보기 (같은 pane 안에서 마지막 줄을 따라감, `Esc` 로 목록), `s` 중지 (한 번 더 확인), `q` 닫기.
- subagent 는 로그 보기에서 맡긴 작업 전문과 최종 답변을 보여 준다.

flow 화면
- 목표 → 항목 → 할 일을 위에서 아래로 (§4 그림). 항목 오른쪽에 연결된 커밋(`n2 n3`).
- 계획에 연결되지 않은 커밋은 아래 "계획 밖 커밋"에, 커밋 전 작업(결정 · 변경 파일 수 · 실패)은 맨 아래에.
- `↑↓` 이동, `Enter` 펼치기/접기 (커밋을 고르면 그 단계의 결정·파일), `q` 닫기. 읽기만 한다 (상태는 모델이 `flow_plan` 으로 바꾼다).

## 6. 확인된 사실 (2026-11-12 실측)

| 항목 | 결과 |
|---|---|
| mintty 클릭 → psmux(`mouse on`) → pane 안 node | SGR 누름/뗌 도착 |
| psmux `send-keys -l` 로 넣은 SGR 시퀀스 → ConPTY → node | 그대로 도착 |
| pi fullscreen 마우스 | `$TMUX` 가 있으면 버튼 동작 추적(1000/1002/1006)을 켠다. 화면 위치로 컴포넌트를 찾아 `handleMouse` 전달 |
| `split-window -d -P -F '#{pane_id}'`, `list-panes -F`, `set-option -p @oxy_monitor` | 동작 |
| `main-pane-width 70%` + `select-layout main-vertical` | 오른쪽 30% 열, 같은 높이, pane 닫기·창 크기 변경 후에도 유지 |
| `set-hook pane-exited 'select-layout main-vertical'` | pane 이 스스로 끝나도 다시 맞춰진다 |
| `resize-pane -x/-y` | 절대 크기가 아님 (사용하지 않음) |
| 번들 Node 22.23.4 로 `.ts` 실행, `store.ts` import | 동작 (`file:///` URL 로 import) |
| 시험용 extension 으로 하단 바 키 조작 (pi 1.5.0, psmux 100×30) | 빈 입력창 `↓` → 바 강조, `→` 이동, `Enter` 실행, `↑` 복귀, 글자 키는 입력창으로 들어감. 입력창에 글이 있으면 `↓` 를 가로채지 않음. `/settings` 대화상자 안의 `↓` 는 대화상자 목록으로 감 (포커스 `SettingsList`) |

## 7. 구현 순서와 확인 방법

1. oxy-jobs 상태 파일과 요청 처리 (§3) — `tests/unit-extensions.test.ts`, `tests/rpc-jobs.mjs`
2. oxy-flow 계획 트리와 `flow_plan` 도구 (§4) — 단위 테스트 + Groq 실제 모델로 모델이 계획을 쓰고 갱신하는지 확인
3. pane 관리 (§1) — psmux 실측 (pane 위치·크기를 `list-panes` 로 확인)
4. 모니터 jobs · flow 화면 (§5) — `tests/tui-capture/tuicap.sh` 로 mintty 80×24 실제 화면 캡처 (모니터 23칸)
5. 하단 바와 클릭 (§2) — mintty 창에 클릭 메시지를 보내 pane 이 열리고 닫히는지 확인

## 8. 정할 것

- 없음. 입력창 위 작업 목록 처리(§2), 키 조작(§2), 계층 2단(§4)은 2026-11-12 에 정했다.
