# 설치·설정 TUI 명세

설치 TUI(`install.cmd`)와 설정 TUI(`tweak.cmd`, Tweak), fetch 의 구성요소 선택 화면이 따르는 규칙이다.
화면을 바꿀 때는 이 문서를 먼저 고치고, 끝난 뒤 [검증](#9-검증)의 방법으로 실제 터미널에서 확인한다.

## 1. 구조

| 부분 | 위치 | 하는 일 |
| --- | --- | --- |
| 로직 | `installer/install.mjs` · `tweak.mjs` · `select-components.mjs` | 무엇을 물을지, 답으로 무엇을 할지. 화면 문구도 여기에 있다 |
| 공용 입력 | `installer/tui.mjs` 의 `UI` | `select` · `multiselect` · `input` · `confirm` · `confirmTyped` · `task` · `busy` · `notice` · `pause` · `outside` |
| 화면 프로그램 | `installer/oxy-tui` (Rust, Ratatui) → `bin/oxy-tui.exe` | 그리기와 키 입력만 한다. 무엇을 보일지는 모른다 |

- Node 가 이름 있는 파이프(`\\.\pipe\oxy-tui-<pid>-<난수>`)를 열고 exe 를 실행한다. 지시와 답은 JSON 한 줄씩이다.
  지시의 종류와 필드는 `installer/oxy-tui/src/protocol.rs` 머리말과 `model.rs` 가 기준이다.
- 두 가지 방식으로 동작하고, 두 방식에서 같은 결정을 모두 내릴 수 있어야 한다.
  - **원격 모드**: 진짜 터미널(TTY)이고 `bin/oxy-tui.exe` 가 있을 때. exe 가 대체 화면에 그린다.
  - **줄 입력 모드**: 파이프 입력, `TERM=dumb`, exe 없음, `OXY_TUI=line`. 번호를 입력한다. 회귀 테스트(`tests/installer-sandbox.sh`)가 이 방식으로 돈다.
    선택지의 순서나 개수를 바꾸면 테스트의 입력 번호도 함께 고친다.
- 설치 TUI 는 단계 흐름(점검 → 폴더 → 구성요소 → LLM → 모델 → GitLab → PATH·바로가기 → 확인)이다.
  PATH·바로가기 단계는 화면 세 개(등록 항목 → 터미널 셸 → 멀티플렉서)이고, 위치 표시는 셋 모두 `7/8 바로가기` 다.
  Tweak 은 허브다: 항목을 하나 선택해 그것만 변경하고 바로 저장한다. Tweak 을 단계 흐름으로 만들지 않는다.
  허브의 PATH·바로가기는 하위 메뉴(등록 항목 · 터미널 셸 · 멀티플렉서)를 열고, 하위 항목 하나를 변경하면 바로 저장한다.
- 출력이 길어 스크롤백에 남아야 하는 것(상태 점검 `verify.sh`)은 `ui.outside` 로 화면 밖(본 화면)에서 실행하고 돌아온다.

## 2. 배너

`O` + (위에 `2`, 아래 작은 `xy`) + `GEN` + `PI`. `O`·`GEN` 은 초록 그러데이션, `PI` 는 pi 의 보라색이고 글자마다 그림자가 있다.
그림은 `installer/oxy-tui/src/banner.rs` 하나에만 있다. **확정된 그림이므로 모양을 바꾸지 않는다.**

| 창 | 배너 |
| --- | --- |
| 폭 64칸 이상 · 높이 24줄 이상 | 큰 배너 6줄 (폭 59칸) |
| 그보다 작은 창 | 한 줄 `O²xyGEN PI  v0.1.0` |

중간 크기는 두지 않는다. 버전은 1행 오른쪽 끝, 폭 100칸 이상이면 마지막 줄 오른쪽 끝에 부제를 둔다.

## 3. 창 크기별 배치

기준 창은 Git Bash 기본 창(mintty) **80×24** 다.

| 창 | 배치 |
| --- | --- |
| 30줄 미만 (기준 창 포함) | 큰 배너 아래를 **테두리 없는 단일 열**로 그린다. 위치는 배너 오른쪽(버전 아래)에 둔다 |
| 30줄 이상 · 100칸 미만 | 설치 단계 · 입력 · 진행 화면은 테두리 블록 하나. 메뉴는 목록 아래에 상세 패널 |
| 30줄 이상 · 100칸 이상 | 설치 화면은 왼쪽에 단계 목록 패널. 메뉴는 목록 왼쪽 · 상세 패널 오른쪽 |
| 72칸 미만 또는 16줄 미만 | 단일 열. 도움말과 확인도 팝업 없이 같은 열에 그린다 |

단일 열의 순서는 위에서 아래로 고정이다:
배너 · [직전 결과 한 줄] · 헤더 · 빈 줄 · 맥락과 요약 · 빈 줄 · 선택지(묶음 사이 빈 줄) · 빈 줄 · 설명 · 빈 줄 · 키 안내(맨 아랫줄).

자리가 모자라면 다음 순서로 줄인다 (`view_a.rs` 의 `assemble`):
키 안내 아래 빈 줄 → 설명 2줄을 1줄로 → 설명과 키 안내 사이 빈 줄 → 선택지 위 빈 줄 → 맥락 접기(`?` 로 펼친다) → 묶음 사이 빈 줄 → 헤더 아래 빈 줄 → 목록 스크롤(`▲ n개 더`).
반대로 줄이 남으면 헤더 아래, 선택지 위 순서로 빈 줄이 들어간다. 묶음 사이 빈 줄은 되도록 지킨다.

- 위치 표시: 설치는 `3/8 구성요소` (배너 오른쪽에는 짧은 이름), 단계를 모두 지난 뒤에는 상태 낱말(`설치 중` · `설치 완료` · `업데이트 중` · `제거 완료`), Tweak 은 경로의 마지막 조각.
- 목록은 `레이블 + 값` 두 열이다. 레이블 열의 폭은 그 목록에서 가장 긴 레이블에 맞춘다.
- 설명(포커스한 항목을 선택하면 일어나는 일)은 한 줄에 한 문장이다. 설명이 하나도 없는 목록에는 설명 줄을 두지 않는다.
- 관련 정보(`info`: 이름–값)는 상세 패널에 보이고, 자리가 없으면 `?` 도움말에서 본다.
- 말줄임은 `…`(1칸). **경로는 가운데를 줄인다** (`C:\Users\kim\…\Programs\oxygen-pi`). 줄 끝에 붙은 경로도 같다 (`SQLite · C:/Users/kim/…/data/app.db`, `text.rs` 의 `fit`). 요약표의 값은 자르지 않고 줄바꿈한다.
- 위험한 확인(제거, 연결 삭제, 등록 해제, 비밀번호 삭제)만 팝업으로 그린다. 팝업 아래에는 직전 화면이 어둡게 깔린다. 일반 확인은 목록이다.
- 팝업의 요약이 창보다 길면 경로를 가운데 말줄임 한 줄로 줄인다. 버튼은 항상 보여야 한다.

## 4. 색

채도 낮은 초록(세이지) 팔레트 하나를 24비트 색으로 쓴다 (`theme.rs`).

- 강조색은 하나다: 포커스한 행, 현재 단계, 입력 칸 테두리.
- 문장과 값은 터미널의 기본 글자색, 레이블과 키는 굵게. 회색은 테두리 · 버전 · 경로 · 선택할 수 없는 레이블에만 쓴다 (mintty 에서 어두운 회색 한글은 읽히지 않는다).
- 경고는 노랑, 오류는 빨강이고 기호(`!` `×`)에만 칠한다.
- `NO_COLOR` 가 있으면 색을 모두 끄고 굵기와 기호만 남긴다. 모든 상태는 색 없이도 기호로 구분된다. `OXY_TUI_THEME=light` 는 밝은 배경용 팔레트다.
- 줄 입력 모드는 16색만 쓰고, `NO_COLOR` · `TERM=dumb` · 출력이 TTY 가 아닐 때 끈다.

## 5. 기호

mintty 와 Windows Terminal 양쪽에서 **1칸으로 그려지는 글자만** 쓴다. `✔` `✖` `↑↓` 는 그림 글자(2칸)로 그려져 옆 글자를 덮으므로 쓰지 않는다.

| 기호 | 뜻 |
| --- | --- |
| `❯` | 포커스한 행, 현재 단계 |
| `[✓]` `[ ]` | 선택됨 / 선택 안 됨 |
| `[■]` | 필수 또는 설치됨 (해제할 수 없다) |
| `[·]` | 선택할 수 없음 (이유는 값 열과 설명에) |
| `✓` `×` `!` | 됨 / 실패 / 주의 |
| `(추천)` `(현재)` | 추천 항목 / 지금 값 |
| `▲▼` `←→` | 키 안내의 방향키, `▲ n개 더` |
| `◀` | flow 모니터의 지금 할 일 (`◀ Current Task`). mintty · Windows Terminal 에서 1칸 확인 (2026-11-13, `docs/flow-view-spec.md`) |
| `…` | 말줄임, 레이블 끝에서는 "다음 화면이 있다" |
| `◐ ◓ ◑ ◒` | 진행 중 (150ms 마다 바뀐다. D2Coding 1칸) |

## 6. 문구

화면 문구는 한국어, 명령 · 경로 · 식별자 · 도구 이름은 원문이다.

- 합니다체. 실제 한국어 소프트웨어가 쓰는 말만 쓴다. 지어낸 말(`고르다`, `시험하다`, `띄운 모델`, `뺌`, `다시 밟음`)을 쓰지 않는다: 선택 · 테스트 · 실행 · 제외.
- 조사는 영문 낱말에 붙여 쓴다 (`pi가`, `PATH에`). `은(는)` `을(를)` 처럼 조사를 병기하지 않는다. 문장을 바꿔 피한다.
- 기호로 문장을 잇지 않는다: ` · ` 는 한 줄에 두 번까지, `›` `→` `—` 는 쓰지 않는다.
- **헤더**: 선택 화면은 한 문장(`어떤 설정을 변경할까요?`, `변경할 값을 선택하세요`), 입력 화면은 입력할 값의 이름(`LLM 서버 주소`, `API 키`, `포트`). 표시 폭 60칸 이내.
- **선택지 레이블**: 선택하면 일어나는 일을 쓴다. `예` / `아니요` 만으로 된 선택지는 두지 않는다 (`업데이트 시작` / `업데이트 취소`).
- **구성요소와 스킬**: 레이블은 도구 이름 그대로(`ast-grep`, `sql-querying`), 값 열에 하는 일 한 줄. 확장 기능과 실행 제한은 한국어 기능 이름을 레이블로 쓰고 내부 이름은 관련 정보에 둔다.
- **설명**: 문장으로 쓴다. `바뀌는 것:` `되돌리기:` 같은 속성 이름을 달지 않는다. 한 줄(74칸)에 들어가는 문장으로 쓰고, 둘이면 배열로 나눠 준다.
- **선택할 수 없는 항목**은 목록에서 빼지 않는다. 값 열에 상태(`반입 안 됨`, `사용 불가`), 설명에 이유 한 문장과 할 일 한 문장.
- **오류**: 제목 · 원인 · 해결 방법 순서. 해결 방법이 마지막 줄이다. 입력 검증 오류는 한 줄에 들어가게 쓴다.
- **결과**: 저장하면 확인 없이 바로 저장하고 한 줄로 알린다 (`GitLab 연결 설정을 저장했습니다. pi를 다시 시작하면 적용됩니다.`).
- **값 열의 경로**: 경로와 설명을 함께 쓰면 설명을 앞에, 경로를 끝에 둔다. 그래야 좁은 창에서 경로의 가운데를 줄이고 설명은 남는다 (`필수 5개 확인 · C:\…\oxygen-pi-system`). 예전 `C:\…\oxygen-pi-sys… (필수 5개 확인)` 처럼 끝이 잘리지 않게 (2026-11-13, `monitor-tui/3` 에서 발견).
- **위험한 행동**: 대상과 수량을 구체적으로 보인다 (삭제할 폴더, 파일 수와 크기, 함께 해제되는 등록, 백업 위치).
  설치 폴더 삭제는 팝업 뒤에 폴더 이름을 직접 입력해야 진행한다.
- **Enter 의 뜻**: 설치 단계에서는 `다음`, Tweak 에서 누르면 바로 저장되는 화면은 `저장`, 그 밖에는 `선택` · `확인`. 키 안내는 `▲▼ 이동   Enter 선택   Esc 이전   ? 도움말` 형식 하나다.
- 비밀값(API 키, 비밀번호)은 입력을 가리고, 화면과 로그에 다시 보이지 않는다.

용어는 하나로 쓴다.

| 쓰는 말 | 쓰지 않는 말 |
| --- | --- |
| 구성요소 | 도구(목록 이름으로), 바이너리 |
| 스킬 | 도구 사용법 |
| 확장 기능 | 보조 기능, extension |
| 실행 제한 | 작업 한도 |
| 상태 점검 | 동작 시험 |
| 다시 설정 | 설정 다시 하기 |
| PATH·바로가기 | 실행 등록 |
| 요청 설정 | 요청 조정 |
| 연결 테스트 | 연결 시험 |
| 이전 (Esc) | 뒤로 |
| 반입 (폐쇄망으로 가져옴) · 번들 (가져온 묶음) | 번들링하다 → 번들을 만들다 |
| 터미널 셸 | 셸 종류, 쉘 |
| 명령 프롬프트 (`cmd.exe`) | cmd 창, 커맨드 창 |
| 멀티플렉서 (헤더에서는 터미널 멀티플렉서) | 먹스, mux (명령 `oxy mux` 는 원문) |
| 세션 (psmux 세션) | 작업 공간 |

## 7. 종료와 복구

- **Ctrl+C**: 바로 끝내고, 무엇이 반쯤 된 상태인지 본 화면에 한 줄로 알린다. 설치는 다시 실행하면 이어서 진행한다.
- 끝날 때는 대체 화면에서 나온 뒤 결과(완료 안내, 오류의 원인과 해결 방법)를 본 화면에 남긴다.
- exe 는 정상 종료 · 오류 · panic · Node 와의 연결 끊김 어느 경우에도 raw mode 와 대체 화면에서 나온다.
- Node 가 강제 종료되면 exe 도 함께 죽어 스스로 복구할 수 없다. 이때를 위한 안전망이 래퍼에 있다:
  `install.cmd` · `tweak.cmd` · `*.sh` 가 표식 파일 경로를 `OXY_TUI_MARK` 로 주고, exe 는 대체 화면에 들어가 있는 동안에만 그 파일을 둔다.
  Node 가 끝난 뒤 표식이 남아 있으면 래퍼가 `installer/restore-terminal.mjs` 로 터미널을 되돌린다.
  표식이 없을 때는 아무것도 찍지 않는다 (대체 화면이 아닌데 나가는 시퀀스를 보내면 커서가 저장된 자리로 돌아가 이전 출력을 덮는다).
  `node installer/tweak.mjs` 처럼 래퍼 없이 실행하면 이 안전망은 없다.

## 8. 화면 프로그램 빌드와 배포

- 저장소에는 exe 를 넣지 않는다. `manifest/tools.lock.tsv` 의 `oxy-tui` 행(`role=harness`)에 버전 · 주소 · sha256 을 고정하고 `scripts/fetch-bundle.sh` 가 받아 `bin/oxy-tui.exe` 에 둔다.
- 릴리스는 `.github/workflows/oxy-tui-release.yml` 이 만든다 (태그 `oxy-tui-v<version>`). C 런타임을 exe 안에 넣어 폐쇄망 PC 에 VC 런타임이 없어도 실행된다.
- 직접 빌드: Rust(stable, msvc)가 있는 PC 에서 `just tui-build`. 단위 테스트는 `just tui-test`.
- exe 가 없으면 설치·설정 TUI 는 줄 입력 모드로 동작한다. 기능은 같다.

## 9. 검증

화면을 고친 뒤에는 가짜 터미널이 아니라 실제 터미널의 렌더링으로 확인한다.

| 무엇을 | 어떻게 |
| --- | --- |
| Node 쪽 (지시 내용, 줄 입력 문법, 금지 문구) | `./runtime/node/node.exe --test tests/unit-tui.test.mjs` |
| exe 쪽 (글자 폭, 배너, 통신 규약) | `just tui-test` |
| 줄 입력 모드의 전체 흐름 | `bash tests/installer-sandbox.sh` (sandbox + mock vLLM, 몇 분) |
| 실제 화면 | `tests/tui-capture/tuicap.sh` 로 psmux 세션에 띄우고 텍스트(`text`)와 PNG(`mintty` · `wt`)로 캡처 |
| 예시 값으로 화면만 | `bin/oxy-tui.exe demo <hub\|manage\|components\|input\|confirm\|task>` |
| 직접 써 보기 | `just install-demo` (mock vLLM + sandbox) |

캡처할 때의 약속:

- 설치 TUI 는 `--sandbox <폴더>` 와 mock vLLM 으로만 실행한다. Tweak 의 저장은 sandbox 에 설치된 복사본에서만 한다.
- mintty 는 세션에 붙으면 pane 이 한 줄 줄어든다. 24줄을 찍으려면 세션을 25줄로 시작한다.
- Windows Terminal 은 설정에 따라 요청한 크기와 다르게 열린다. 실제 pane 크기를 확인해서 적는다.
- 글자와 Enter 를 한 번에 보내면 붙여넣기로 판정되어 Enter 가 무시된다. Enter 는 따로 보낸다.
- 텍스트 캡처는 줄마다 표시 폭이 창 폭 이내인지, 말줄임(`…`)으로 끝난 줄이 의도한 것인지 확인한다.
- 캡처가 끝나면 세션과 붙인 창을 `stop` 으로 정리한다.

## 10. 터미널 셸과 멀티플렉서

PATH·바로가기에서 정하는 두 값이다. 서로 독립이다. 값은 `agent/oxy.env` 에 기록한다 (업데이트해도 유지).

| 값 | 바꾸는 것 | 바꾸지 않는 것 |
| --- | --- | --- |
| 터미널 셸 `OXY_TERMINAL_SHELL` (`git-bash` 기본 · `cmd` · `powershell`) | Windows Terminal `Oxygen Pi` 프로필과 바탕화면 바로가기가 여는 셸, 그 셸에 하네스를 적용하는 방법 | pi 의 bash 도구(`shellPath`, 항상 Git Bash), psmux pane 의 셸(`agent/psmux.conf`, 항상 Git Bash), `oxy` 런처의 동작 |
| 멀티플렉서 `OXY_MUX` (`none` 기본 · `psmux` · 이후 추가분) | `oxy` 를 대화형으로 실행할 때 pi 를 멀티플렉서 세션 안에서 실행할지 | 프로필 · 바로가기(셸만 연다), `oxy -p` 같은 비대화형 실행 |

### 화면

- 설치: 등록 항목(지금 화면) → 터미널 셸 → 멀티플렉서. Esc 는 앞 화면으로, 등록 항목에서의 Esc 는 이전 단계로 간다.
  세 화면은 등록 항목 선택과 관계없이 항상 나온다 (줄 입력 모드의 입력 개수가 바뀌지 않게).
- 프로필과 바로가기를 하나도 선택하지 않았으면 셸 화면의 맥락에 `! 프로필과 바로가기를 선택하지 않아 지금은 적용되지 않습니다.` 를 더한다. 선택한 값은 그대로 기록한다.
- Tweak: 하위 메뉴 `등록 항목` · `터미널 셸` · `멀티플렉서` (줄 입력 모드에는 `← 이전` 을 더한다). 각 화면의 Enter 는 `저장`.
  등록 해제 확인은 지금처럼 팝업이다. 셸을 저장하면 등록된 프로필과 바로가기를 새 셸로 다시 만든다.
- 처음 포커스: 신규 설치는 `Git Bash (추천)` 과 `사용 안 함`, 다시 설정과 Tweak 은 `(현재)`.
- 셸 선택지는 Git Bash · 명령 프롬프트 · PowerShell 세 개로 고정이다. PowerShell 은 `pwsh.exe` 가 있으면 그것을, 없으면 `powershell.exe` 를 쓰고 값 열에 실행 파일 이름을 보인다.
- 멀티플렉서 선택지는 `사용 안 함` + 멀티플렉서 정의 표의 순서다. 설치되지 않은 것도 목록에 남기고 값 열에 상태를 둔다:
  설치 단계에서 구성요소를 선택하지 않았으면 `설치 안 됨`, 번들에 없으면 `반입 안 됨`.
- 지금 값이 선택할 수 없게 되면(psmux 제거 등) 포커스는 `사용 안 함` 에 두고, 그대로 진행하면 `none` 으로 기록한다.
- 확인 단계 요약에는 `터미널` 행 하나를 더한다 (`Git Bash · 멀티플렉서 psmux`).
- 완료 화면 시작하기: 멀티플렉서를 쓰면 `멀티플렉서   oxy가 psmux 세션에서 pi 실행 (바로 실행: oxy --no-mux)` 행을 더한다.
- 저장 결과: `터미널 셸 설정을 저장했습니다. 새로 연 터미널부터 적용됩니다.` · `멀티플렉서 설정을 저장했습니다. 다음에 oxy를 실행할 때부터 적용됩니다.`
- 업데이트는 파일 복사 · 설정 파일 다시 생성 뒤에 **등록된** Windows Terminal 프로필과 바탕화면 바로가기를 이 번들의 내용으로 다시 쓴다 (작업 줄 `Windows Terminal 프로필 갱신` · `바탕화면 바로가기 갱신`, 셸은 기록된 `OXY_TERMINAL_SHELL`). 등록하지 않은 것은 새로 만들지 않고, PATH 는 설치 폴더가 같으므로 그대로 둔다.
  이유: 프로필의 내용(예: Tokyo Night 색 구성, `docs/flow-view-spec.md` §4)이 번들과 함께 바뀌는데, 업데이트가 다시 쓰지 않아 기존 설치본에 들어가지 않았다 (2026-11-13 실측). 결정: 2026-11-13 사용자가 TUI 개선을 서브 에이전트에 맡김.
- 업데이트(파일 복사)와 제거 전에 하네스의 psmux 서버(`-L oxy`)에 세션이 있으면 팝업으로 세션 수를 보이고 확인을 받은 뒤 종료한다 (실행 중인 `psmux.exe` 는 덮어쓰거나 지울 수 없다). 처음 포커스는 취소 쪽이다.

### 셸별 실행 방법 (프로필의 commandline, 바로가기의 대상과 인수)

| 셸 | 실행 | 하네스 적용 |
| --- | --- | --- |
| Git Bash | `"<bash.exe>" --login -i -c "source '<설치>/env.sh' && cd ~ && exec bash -i"` | `env.sh` 전체 |
| Git Bash 바로가기 (Windows Terminal 없이, §12) | `"<Git>\usr\bin\mintty.exe" -o Font=D2Coding -i "<Git 아이콘>" /usr/bin/bash --login -i -c "source '<설치>/env.sh' && cd ~ && exec bash -i"`. 글꼴이 없으면 `-o Font=…` 를 빼고, mintty 가 없으면 위 줄 | 같다 |
| 명령 프롬프트 | `%SystemRoot%\System32\cmd.exe /k "set "OXY_HOME=<설치>" & set "PATH=<설치>;%PATH%""` | 설치 폴더만 PATH 앞에. `oxy` → `oxy.cmd` → Git Bash 로 `env.sh` |
| PowerShell | `<pwsh.exe 또는 powershell.exe> -NoLogo -NoExit -Command "$env:OXY_HOME='<설치>'; $env:Path='<설치>;'+$env:Path"` | 같다. `-Command` 라서 실행 정책(ps1 차단)의 영향을 받지 않는다 |

바탕화면 바로가기는 Windows Terminal 프로필을 선택했고 `wt.exe` 가 있으면 `wt.exe -p "Oxygen Pi"`, 아니면 위 표의 실행 파일을 대상으로 한다. 시작 폴더는 모두 `%USERPROFILE%`.
Windows Terminal 은 commandline 의 `%VAR%` 를 스스로 전개한다 (WT 프로세스의 값). 그래서 cmd 프로필의 `%PATH%` 는 cmd 가 아니라 WT 가 채운다.
cmd · PowerShell 프로필에는 아이콘을 지정하지 않는다 (Windows Terminal 기본 아이콘). `oxy.cmd` 는 `agent/oxy.env` 의 `OXY_GIT_BASH` 로 Git Bash 를 찾고, 없으면 `%ProgramFiles%\Git\bin\bash.exe` 를 쓴다.

### oxy 의 판정 (위에서부터 처음 맞는 것)

1. 첫 인자가 `mux` → 이번만 멀티플렉서로 실행한다 (`OXY_MUX` 가 `none` 이면 psmux). 실행할 수 없으면 오류로 끝낸다.
2. 첫 인자가 `--no-mux` → 그 인자를 빼고 이번만 바로 실행한다.
3. `OXY_MUX` 가 `none` 이거나 비어 있음 → 바로 실행.
4. 이미 멀티플렉서 세션 안(psmux: `$TMUX`) → 바로 실행.
5. 대화형이 아님 → 바로 실행: stdin 이나 stdout 이 TTY 가 아님, 인자에 `-p` `--print` `--mode` `--export` `--list-models` `-h` `--help` `-v` `--version` 이 있음, 첫 인자가 pi 하위 명령(`install` `remove` `uninstall` `update` `list` `config` `auth` `mcp`)임.
6. 멀티플렉서를 실행할 수 없음(실행 파일 없음, 어댑터 없음, 알 수 없는 값) → 표준 오류에 두 줄을 남기고 바로 실행한다:
   `[oxy] psmux가 설치되지 않아 지금 창에서 pi를 실행합니다.` / `[oxy] tweak.cmd의 PATH·바로가기에서 멀티플렉서를 변경하세요.`
7. 그 밖 → 지금 폴더의 세션 `oxy-<폴더 이름>-<경로 해시 4자리>` 에서 실행한다 (있으면 다시 연결. 같은 폴더의 두 번째 창도 같은 세션에 붙는다).

### 멀티플렉서 정의

- 화면: `installer/components.mjs` 의 `MULTIPLEXERS` 표. 한 행이 `{ id, component, label, hint, detail, info }` 다. `component` 는 `CATALOG` 의 구성요소 이름이고, 그 구성요소가 없으면 선택할 수 없다.
- 실행: `scripts/mux/<id>.sh` 어댑터. `oxy` 가 source 하며 함수 세 개를 둔다:
  `oxy_mux_ready`(실행할 수 있는지), `oxy_mux_inside`(세션 안인지), `oxy_mux_exec <세션 이름> <Windows 경로> <명령>`. `OXY_MUX` 값은 `^[a-z0-9-]+$` 일 때만 어댑터 경로로 쓴다.
- 멀티플렉서를 더할 때: `tools.lock` 행 + `CATALOG` 행 + `MULTIPLEXERS` 한 행 + 어댑터 파일 하나. 단위 테스트가 표의 모든 id 에 어댑터와 구성요소가 있는지 확인한다.
- 어떤 멀티플렉서를 선택해도 pi 의 bash 도구와 `terminal-session-control` 스킬은 하네스의 psmux(`-L oxy`, pane 셸 Git Bash)를 쓴다.

## 11. LLM 연결과 작업 수준

진행 상태: [진행판](dev-board.md) 의 `llm-conn` 행.

LLM 연결은 여러 개를 함께 등록해 쓴다 (사내 vLLM 여러 대, 외부망 개발·테스트용 OpenAI 호환 서비스, Anthropic Claude).
연결마다 등록한 모델을 **기본 모델**(대화하는 pi)과 **작업 수준**(subagent 에게 맡기는 일의 수준)에 배정한다.
본 모델은 일을 맡길 때 agent 와 작업 수준을 함께 정하고, 작업 수준이 연결 · 모델 · thinking(effort)을 정한다.
작업에 맞는 모델과 추론 강도를 일마다 정해 맡기는 것이 oxy-jobs 가 pi 기본 subagent 와 다른 점이다.

### 저장 위치

| 파일 | 내용 |
| --- | --- |
| `agent/llm.json` (새로, git · 번들 제외) | 연결 목록, 기본 모델, 작업 수준. 비밀값은 없다 |
| `agent/secrets.json` | API 키. DB 비밀번호와 같은 DPAPI(CurrentUser) 암호문, 키 이름 `llm/<연결 id>` |
| `agent/oxy.env` | LLM 연결 값은 두지 않는다. 기존 `OXY_VLLM_*` · `OXY_MODEL_*` · `OXY_CONTEXT_WINDOW` · `OXY_VLLM_DROP_PARAMS` · `OXY_PROVIDER_RETRIES` · `OXY_MAX_OUTPUT_TOKENS` 는 처음 한 번 `llm.json` 연결 `vllm` 으로 옮기고(키는 `secrets.json` 으로) oxy.env 에서 지운다 |

`llm.json` 형식 (version 1):

```jsonc
{
  "version": 1,
  "connections": [{
    "id": "site", "kind": "vllm", "name": "사내 vLLM",
    "baseUrl": "http://vllm.example.internal:8000/v1",   // 표에 기본 주소가 있는 종류는 생략 가능
    "maxConcurrent": 2,                                  // 이 연결에 동시에 보내는 subagent 수 (vLLM KV 캐시 · API 사용량 한도)
    "request": { "retries": 0, "dropParams": ["repetition_penalty"] },   // 종류에 있는 항목만
    "models": [{ "id": "qwen3.6-coder-30b", "family": "qwen-coder", "contextWindow": 131072, "maxOutput": 16384 }]
  }],
  "main": { "connection": "site", "model": "qwen3.6-coder-30b", "thinking": "off" },
  "levels": [
    { "id": "light",  "label": "가벼운 작업", "use": "file search, reading, short reports",   "connection": "site", "model": "qwen3.6-coder-30b", "thinking": "off" },
    { "id": "normal", "label": "보통 작업",   "use": "defined code changes, test runs",       "connection": "site", "model": "qwen3.6-coder-30b", "thinking": "off" },
    { "id": "deep",   "label": "깊은 작업",   "use": "reviews, design decisions, hard bugs",   "connection": "site", "model": "qwen3.8-27b",       "thinking": "high" }
  ]
}
```

- 연결 id 는 DB 연결과 같은 규칙(`^[a-z][a-z0-9_-]{0,30}$`)이고, pi 의 provider id 는 `oxy-<연결 id>` 다.
- 작업 수준의 `use` 는 본 모델이 수준을 정할 때 읽는 설명이다 (subagent 도구 설명에 들어간다). 수준은 더하거나 지울 수 있다. 기본 세 개는 설치할 때 모두 기본 모델로 만든다.
- thinking 값은 그 모델이 지원하는 수준 안에서만 고를 수 있다 (vLLM 계열 프리셋, pi 내장 정보). 지원하지 않는 값이 남아 있으면 pi 가 가장 가까운 수준으로 낮춘다.

### 연결 종류 정의

`scripts/llm-connections.mjs` 의 `LLM_KINDS` 표. 설치 TUI · Tweak · pi extension · 상태 점검이 같은 표를 쓴다.
화면 문구 · 기본값 · 추천값은 표에 두고, 화면 코드와 extension 에는 종류 이름으로 나누는 분기를 두지 않는다.

| 필드 | 뜻 | vllm | openai | anthropic |
| --- | --- | --- | --- | --- |
| `label` · `hint` · `detail` | 화면 | `사내 vLLM` | `OpenAI 호환 서비스` (`외부망 테스트용`) | `Anthropic Claude` (`외부망 테스트용`) |
| `api` | 요청 형식 | `openai-completions` | `openai-completions` | `anthropic-messages` |
| `catalog` | 모델 정보 출처 | 계열 프리셋 | 계열 프리셋 (`generic` · `gpt-oss`) | pi 내장 카탈로그 (`vendor/pi/.../providers/data/anthropic.json`) |
| `baseUrl` | 기본 주소 (없으면 입력 필수) | 없음 | 없음 | `https://api.anthropic.com` |
| `listModels` | 모델 목록과 최대 길이를 가져오는 방법 | `GET <주소>/models` | 같음 | `GET <주소>/v1/models` (`x-api-key`) |
| `probe` | 연결할 때 테스트하는 확장 파라미터 | `top_k` 등 4개 | 없음 | 없음 |
| `request` | 요청 설정 항목 | 재시도 · 제외 파라미터 | 재시도 | 재시도 |
| `rateLimitHeader` | 분당 토큰 한도 응답 헤더 (있으면 맞춤 설정 제안) | 없음 | `x-ratelimit-limit-tokens` | `anthropic-ratelimit-input-tokens-limit` |
| `thinkingDefault` | thinking 선택 화면의 (추천) | `off` | `off` | `low` |
| `maxConcurrent` | 동시 요청 수 기본값 | 2 | 1 | 2 |
| `workspace` | 워크스페이스 ID(`anthropic-workspace-id` 헤더)를 쓰는지 (아래 Anthropic 워크스페이스) | 아니오 | 아니오 | 예 |

종류를 더할 때: 표 한 행, 모델 목록 · 점검 형식이 다르면 함수 하나. 단위 테스트가 모든 행의 필드와 함수를 확인한다.

### pi 에 적용하는 방법 (extension `oxy-llm`, 새로)

- extension 의 비동기 초기화에서 `llm.json` 을 읽고, 키를 **한 번만** 복호화해 연결마다 `pi.registerProvider("oxy-<id>", …)` 로 등록한다.
  - 키는 pi 프로세스의 메모리에만 있다. 환경변수 · `models.json` · 명령줄에 남지 않으므로 bash 도구로 실행한 명령이 키를 읽을 수 없다.
  - `models.json` 의 `!command` 는 요청할 때마다 실행되고 캐시되지 않으므로(pi 문서) 쓰지 않는다 (요청마다 PowerShell 복호화 약 0.5초).
  - 키의 `$` 와 앞의 `!` 는 pi 의 치환 규칙대로 `$$` · `$!` 로 바꿔 넘긴다.
  - 실측 (2026-11-12, pi 1.5.0): `oxy-claude` 로 등록한 Claude 모델이 `--list-models` 에 131.1K · 16.4K 로 보이고, 요청에 키가 그대로 실리며 `thinking: adaptive` · `effort: low` · `max_tokens: 16384` 로 나갔다.
- 모델 정보: 계열 프리셋(지금 `render-config.mjs` 의 `MODEL_FAMILIES`)이나 pi 내장 카탈로그를 바탕으로, 연결에 입력한 컨텍스트 길이와 응답 최대 길이를 덮어쓴다 (pi 내장값 1M · 128K 를 그대로 쓰지 않는다).
- `settings.json`: `defaultProvider` · `defaultModel` · `defaultThinkingLevel` 은 `main`, `enabledModels` 는 모든 연결의 모델 (`/model` 로 오간다). configure 가 `llm.json` 으로 만든다.
  - pi 에서 저장한 기본값을 지킨다 (2026-11-13, 사용자: "ctrl + s를 이용해 haiku를 기본 모델로 설정했음에도 이렇게 다시 돌아간거였어"). render 는 마지막으로 넣은 `main` 을 `agent/.oxy-llm-default.json` 에 적어 두고, 다음 render 때 `settings.json` 의 값이 그것과 다르고(pi `/model` Ctrl+S 로 바꿈) `llm.json` 의 `main` 은 그대로이며 등록된 연결의 모델이면 그 값을 둔다. Tweak 에서 기본 모델을 바꾸면 Tweak 값이 이긴다. 모델과 thinking 은 따로 본다. 기록 파일이 없던 설치본도 pi 의 값을 지킨다. 단위: `renderConfig: pi 에서 Ctrl+S 로 저장한 기본 모델을…`.
- subagent 의 자식 pi 에는 부모가 띄울 때만 키를 `OXY_LLM_INHERIT_KEYS` 로 넘기고, 자식의 extension 이 받자마자 `process.env` 에서 지운다 (자식이 실행하는 bash · MCP 서버에 남지 않는다. E2E 로 확인).
  처음 설계는 자식도 직접 복호화하는 것이었지만, 새 프로세스의 첫 DPAPI 복호화가 약 2초 걸려(같은 프로세스의 두 번째부터 0.4초, 2026-11-12 실측) subagent 마다 2초가 붙어서 바꿨다.
  같은 Windows 사용자는 어차피 secrets.json 을 복호화할 수 있으므로 노출 범위는 늘지 않는다.
- 복호화는 `installer/secrets.mjs` 의 `getSecrets` (PowerShell 한 번, .NET `ProtectedData`). `ConvertTo-SecureString` 은 보안 모듈을 불러오느라 1~2초 더 걸려 쓰지 않는다. 암호문 형식은 DB 비밀번호와 같다.
- `pi.registerProvider` 는 provider 단위 `compat` 를 모델에 적용하지 않으므로(실측: `max_completion_tokens` · `store` 가 나감) 종류의 compat 를 모델마다 합쳐 넣는다.
- 키를 복호화하지 못하면(다른 Windows 사용자, secrets.json 손상) 그 연결만 등록하지 않고, 대화형이면 알림으로 원인과 해결 방법(Tweak 에서 키 다시 입력)을 보인다.

### subagent 와 작업 수준 (oxy-jobs)

- `subagent` 도구에 `level` 을 더한다 (`tasks[]` 의 항목마다도). 값은 작업 수준 id, 설명은 각 수준의 `use`. 도구 설명: 일을 할 수 있는 가장 낮은 수준을 고른다.
- 자식의 연결 · 모델 · thinking 은 다음 순서로 처음 정해진 것: 도구의 `level` → agent 파일 frontmatter 의 `level` → frontmatter 의 `provider`·`model`·`thinking` → 부모의 지금 모델과 thinking.
  기본 agent 의 `level`: scout = `light`, worker = `normal`, reviewer = `deep`.
- 동시 실행 제한은 연결마다 (`maxConcurrent`, 없으면 `OXY_LLM_MAX_CONCURRENT` · 종류의 기본값). 사내 vLLM 이 꽉 차도 다른 연결로 가는 작업은 기다리지 않는다.
  Tweak 의 실행 제한에 있는 `subagent 동시 실행 수`(`OXY_LLM_MAX_CONCURRENT`)는 연결 편집의 `동시 요청 수` 로 옮긴다.
- 작업 목록 · 모니터(§3 상태 파일)에는 작업마다 수준 · 연결 · 모델 · thinking 을 보인다.

### 화면: 설치

- LLM 단계: `연결 종류를 선택하세요`(표의 순서, 사내 vLLM 이 (추천)) → 연결 이름(기본값은 종류 id) → 서버 주소(기본 주소가 있으면 미리 채움) → API 키(가림) →
  모델 목록 가져오기 → 확장 파라미터 테스트(`probe` 가 있는 종류만) → 사용량 제한 맞춤 설정 제안(헤더가 있을 때만). 위치 표시는 그대로 `4/8 LLM`.
- 모델 단계: 이 연결에서 쓸 모델 선택(여러 개) → 모델마다 컨텍스트 길이 · 응답 최대 길이 → 모델 계열(계열이 있는 종류만) → 기본 모델 → 기본 thinking 수준.
  - 컨텍스트 길이의 처음 값은 서버가 알려 준 최대 입력 길이다. 설명: `사내 vLLM과 같은 조건으로 테스트하려면 사내 컨텍스트 길이를 입력하세요.`
  - thinking 화면은 지원하는 수준이 둘 이상일 때만 나온다. 처음 포커스는 지금 값, 신규 설치는 표의 `thinkingDefault` (추천).
  - 작업 수준 세 개는 기본 모델로 만든다 (확인 단계 요약에 그렇게 보이고, 바꾸는 곳은 Tweak).
- 설치에서는 연결 하나만 등록한다. 다른 연결은 Tweak 에서 더한다 (설치 단계 흐름을 늘리지 않는다).
- 확인 단계 요약: `LLM 연결` 행(`사내 vLLM · site · API 키 저장됨`), `모델` 행(`qwen3.6-coder-30b · 128K · thinking off`), `작업 수준` 행(`세 수준 모두 기본 모델`).
- 줄 입력 모드: LLM 단계 입력이 둘(종류, 이름), 모델 단계 입력이 늘어난다. `tests/installer-sandbox.sh` 의 입력 번호를 함께 고친다.

### 화면: Tweak (허브 원칙 그대로)

LLM 연결 하위 메뉴는 DB 연결과 같은 구성이다. 한 항목을 선택해 그것만 바꾸고 바로 저장한다.

| 하위 항목 | 화면 | 저장 |
| --- | --- | --- |
| 연결 목록의 각 연결 | `편집…` · `연결 테스트` · `삭제…` (DB 연결과 같음). 편집은 그 연결의 주소 · 키 · 모델 · 요청 설정을 다시 입력하고, 현재 값이 기본값이다 | 편집 마지막 화면의 Enter 가 `저장` (DB 연결 편집과 같음) |
| `+ 새 연결 추가…` | 설치 LLM 단계 + 모델 단계와 같은 화면 (기본 모델 · thinking 화면은 빼고) | 마지막 화면의 Enter 가 `저장` |
| 기본 모델 | 등록된 모든 연결의 모델 목록(값 열에 연결 이름 · 컨텍스트) → thinking 수준 | 각 화면에서 바로 저장 |
| 작업 수준 | 수준 목록(값 열에 `연결/모델 · thinking`) + `+ 수준 추가…`. 수준 하나를 선택하면 모델 → thinking (→ 이름 · 설명) | 각 화면에서 바로 저장 |

- API 키: 저장된 키가 있으면 `저장된 키 유지`(현재) · `새 키 입력…` · `저장된 키 삭제`(확인 팝업). DB 비밀번호와 같은 문구 구조다. 키는 화면 · 로그 · llm.json 에 보이지 않는다.
- 연결 삭제: 기본 모델이나 작업 수준이 그 연결을 쓰고 있으면 삭제할 수 없다. 이유(`기본 모델과 작업 수준 2개가 이 연결을 사용합니다`)와 할 일(`먼저 다른 연결의 모델로 바꾸세요`)을 보인다.
- 저장 결과: `LLM 연결 설정을 저장했습니다. pi를 다시 시작하면 적용됩니다.`

### Anthropic 워크스페이스 (조직 API 키)

진행 상태: [진행판](dev-board.md) 의 `anthropic-ws` 행.

요청 (사용자, 2026-11-12): 조직 API 키는 `anthropic-workspace-id` 헤더가 필요하다.
결정된 사항 (사용자, 2026-11-12: "워크스페이스 결정은 권장안대로 반영하고 커밋해줘")
- 설치 확인 단계 요약의 워크스페이스는 `LLM 연결` 행 끝이 아니라 따로 한 행으로 둔다.
- 워크스페이스 선택 화면의 설명은 74칸 안에 들어가게 두 문장으로 나눈다.

공식 문서([인증 · 워크스페이스 선택](https://platform.claude.com/docs/ko/manage-claude/authentication#select-a-workspace), 2026-11-12 확인):
특정 워크스페이스용으로 만든 키는 워크스페이스 ID 없이 쓰고, **워크스페이스가 지정되지 않은 키는 모든 요청에 `anthropic-workspace-id` 헤더**가 있어야 한다.
헤더가 없으면 HTTP 400 `This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header …`,
잘못된 형식이면 400 `anthropic-workspace-id header must be a valid workspace ID.`, 없거나 권한이 없는 워크스페이스면 404 `Workspace <id> not found.`.
ID 는 Claude Console 의 Settings → Workspaces 화면 **ID** 열에 있고 `wrkspc_` 로 시작한다.
워크스페이스가 지정되지 않은 개인 · 서비스 계정 키는 Admin API 의 워크스페이스 목록(`GET /v1/organizations/workspaces?include_default=true`)을 부를 수 있다 (키 사용자의 권한에 따라 거부될 수 있다).

- `llm.json`: anthropic 연결에 선택 값 `"workspaceId": "wrkspc_…"`. 비밀값이 아니므로 llm.json 에 둔다. 종류 표의 `workspace: true` 인 종류만 쓴다 (지금은 anthropic).
- 값이 있으면 **모든 요청**에 `anthropic-workspace-id` 헤더를 붙인다: pi provider 등록(`headers`), 모델 목록, tool calling 점검, 상태 점검.
- 화면 (설치 LLM 단계 · Tweak 의 `+ 새 연결 추가…` · `편집…` 공통). API 키 다음, 모델 목록을 가져올 때:
  1. 모델 목록이 위의 400(워크스페이스 미지정)으로 실패하면 `워크스페이스를 선택하세요` 화면을 보인다.
     - 설명 두 줄: `이 API 키는 워크스페이스가 지정되지 않았습니다.` / `요청마다 워크스페이스 ID를 보내야 합니다.` (한 문장이면 74칸을 넘는다)
     - 워크스페이스 목록 조회가 되면 목록(`이름` · 값 열에 ID, 기본 워크스페이스는 이름 `기본 워크스페이스`)과 맨 아래 `직접 입력…`. 보관(archived)된 것은 뺀다.
     - 목록 조회가 안 되면 바로 입력 화면 `워크스페이스 ID` (설명 `Claude Console의 Settings → Workspaces 화면 ID 열에서 확인할 수 있습니다.`, 예 `wrkspc_01Jw…`).
       `wrkspc_` 로 시작하지 않으면 입력 화면에서 `워크스페이스 ID는 wrkspc_로 시작합니다.` 오류.
  2. 고른 ID 로 모델 목록을 다시 가져온다. 404 면 `이 키로 사용할 수 없는 워크스페이스입니다.` 와 함께 1 로 돌아간다.
  3. 키가 워크스페이스용이면(첫 요청이 성공) 이 화면은 나오지 않고 `workspaceId` 를 두지 않는다.
- `편집…`: 저장된 `workspaceId` 가 있으면 그 값으로 먼저 요청한다. 성공하면 화면 없이 유지, 실패하면(400 · 404) 1 의 화면을 보인다 (처음 포커스는 저장된 값).
  키를 워크스페이스용 키로 바꾸면 저장된 ID 로도 성공할 수 있으므로, ID 를 지우는 길은 1 의 목록 맨 아래 `사용 안 함`(저장된 값이 있을 때만)이다.
- Tweak 연결 목록의 오른쪽 상세와 설치 확인 단계 요약: `워크스페이스  wrkspc_…` 행 (값이 있을 때만, `LLM 연결` 행 바로 아래).
  `LLM 연결` 행 끝에 붙이면 80칸에서 줄이 넘어가고 ` · ` 를 세 번 잇게 되어 따로 둔다 (2026-11-12 캡처로 확인).
- 상태 점검: 묶음 제목 아래 첫 줄에 워크스페이스가 있으면 `PASS 워크스페이스 wrkspc_…`. 400(미지정)으로 실패하면
  FAIL `이 API 키는 워크스페이스가 지정되지 않았습니다` + `→ tweak.cmd의 LLM 연결에서 이 연결을 편집해 워크스페이스를 선택하세요`.

구현 순서와 확인 방법
1. `workspaceId` · 모든 요청의 헤더 · 오류 판정 (`scripts/llm-connections.mjs`, oxy-llm) — 자동 검증: 단위 + E2E / 실측: 실제 조직 키 [승인 필요: 과금 LLM]
2. 상태 점검의 PASS · FAIL 줄 (`scripts/llm-check.mjs`) — 자동 검증: E2E / 실측: 실제 조직 키로 `verify.sh`
3. 화면: 설치 LLM 단계 · Tweak 추가 · 편집 — 자동 검증: 단위 + `just tui-test` + `tests/installer-sandbox.sh` / 실측: `tests/tui-capture/tuicap.sh` mintty 80×24 캡처

완료 조건: 모든 단계 + 실제 조직 키로 모델 목록 · 대화 · 상태 점검, 설치본 반영 뒤 `verify.sh` [승인 필요: 실제 설치본].

정할 것
- 없음.

### 상태 점검 (`verify.sh` 의 LLM 절)

- 연결마다 한 묶음: `7. LLM 연결: site (사내 vLLM)`. 키를 복호화할 수 있는지 → 모델 목록에 등록한 모델이 있는지 → 짧은 요청 하나로 tool call 이 구조화되어 오는지.
- vLLM 전용 안내(`--enable-auto-tool-choice` 등)와 샘플링 파라미터 거부 확인은 `probe` 가 있는 종류만 한다.
- 기본 모델과 작업 수준이 가리키는 연결 · 모델이 모두 있는지 확인한다.

## 12. 터미널 글꼴 D2Coding

`docs/pi-tui-spec.md` §8 의 설치 쪽이다. 글꼴 고르기 화면은 두지 않는다 (pi 테마와 같이 하네스 자료로 늘 설치, 사용자 결정 2026-11-13 "D2Coding 폰트를 패킹해서 사용"). 진행 상태: [진행판](dev-board.md) 의 `pi-tui/8` 행.
승인 (사용자, 2026-11-13: "변경되면 보여주고 8단계 진행하자").

### 작업 줄

| 흐름 | 위치 | 작업 줄 | 결과 글 |
| --- | --- | --- | --- |
| 설치 · 다시 설정 | 등록 항목 작업(`PATH 등록` · `Windows Terminal 프로필 등록` · `바탕화면 바로가기 등록`) **앞** | `글꼴 설치 (D2Coding)` | `새로 설치` · `이미 있음` · `번들에 없어 건너뜀` |
| 업데이트 | `설정 파일 다시 생성` 뒤, `Windows Terminal 프로필 갱신` **앞** | `글꼴 설치 (D2Coding)` | 위와 같다. 우리가 깐 글꼴의 버전이 번들과 다르면 `새 버전으로 바꿈` |
| 제거 | `바탕화면 바로가기 해제` 뒤, `설치 기록 삭제` 앞 | `글꼴 제거 (D2Coding)` | 우리가 깐 경우만 줄이 나온다. `지움` · 사용 중이라 파일을 지우지 못하면 `사용 중이라 파일을 남김` (등록은 지운다) |

- 등록 항목보다 앞에 두는 이유: Windows Terminal 프로필 · 바로가기가 글꼴 이름을 가리키므로 글꼴이 먼저 있어야 한다.
- 실패해도 설치를 멈추지 않는다: 작업 줄은 노란색 `!` 와 이유(`글꼴을 등록하지 못했습니다: <이유>`)를 보이고 다음 작업으로 간다. 이유는 줄 끝에 놓고, 74칸을 넘으면 다음 줄에 들여써서 잇는다. 터미널은 지금 글꼴로 동작한다.
- 확인 단계 요약 · 완료 화면에는 줄을 더하지 않는다 (pi 테마와 같다).
- `--sandbox` 에서는 sandbox 폴더에 복사 기록만 남기고 레지스트리 · 시스템 글꼴 목록을 건드리지 않는다.

### 동작 (system.mjs, 부모 구현)

- 이미 있음 판정: 글꼴 이름이 정확히 `D2Coding` 인 글꼴이 시스템(`HKLM\…\Fonts`) 이나 사용자(`HKCU\…\Fonts`) 에 등록되어 있으면 그것을 쓴다. `D2Coding ligature` · `D2Codingligature Nerd Font` 처럼 이름이 다른 글꼴은 해당하지 않는다 (이 PC 실측, `docs/pi-tui-spec.md` §1).
- 새로 설치: 번들의 두 TTF 를 `%LOCALAPPDATA%\Microsoft\Windows\Fonts\` 에 복사하고 `HKCU\Software\Microsoft\Windows NT\CurrentVersion\Fonts` 에 `D2Coding (TrueType)` · `D2Coding Bold (TrueType)` 를 쓴 뒤 `AddFontResource` + `WM_FONTCHANGE` 로 알린다. 설치 기록(`reg.font`)에 `{ version, files }` 를 남긴다.
- 제거: `reg.font` 가 있을 때만 레지스트리 값과 파일을 지운다. 사용 중인 파일을 다음 로그인 때 지우게 예약하는 것은 관리자 권한이 필요해서 하지 않는다 (구현 중 바꿈, 2026-11-13).
- 구현 (1, 부모, 2026-11-13): `installer/system.mjs` 의 `FONT_FACE` · `FONT_FILES` · `fontBundle()` · `fontRegistered()` · `installFont(prev) → { text, record }` · `removeFont(record) → 결과 글`, `minttyExe()`, `addTerminalProfile` 의 `font`, `addShortcut` 의 mintty. 단위 `tests/unit-tui.test.mjs` "글꼴 D2Coding". 이 PC 실측(읽기만): `fontRegistered()` = `user`, `fontBundle().version` = `1.4.0`, mintty `C:\Program Files\Git\usr\bin\mintty.exe`. `verify.sh` → `PASS D2Coding 글꼴 (사용자 글꼴)`.

### Windows Terminal 프로필 · 바로가기 (§10 표를 바꾼다)

- `Oxygen Pi` 프로필에 `"font": { "face": "D2Coding" }` 를 더한다 (글꼴이 있을 때만. 글자 크기는 정하지 않는다).
- Windows Terminal 을 쓰지 않는 Git Bash 바로가기는 콘솔 창 대신 mintty 로 연다 (`docs/pi-tui-spec.md` D7 (b)):
  `"<Git>\usr\bin\mintty.exe" -o Font=D2Coding -i "<Git 아이콘>" /usr/bin/bash --login -i -c "source '<설치>/env.sh' && cd ~ && exec bash -i"`.
  mintty 가 없으면 지금처럼 `bash.exe` 를 연다. `~/.minttyrc` 는 건드리지 않는다. 명령 프롬프트 · PowerShell 바로가기는 바꾸지 않는다.
- 업데이트의 `Windows Terminal 프로필 갱신` · `바탕화면 바로가기 갱신` 이 위 내용을 그대로 다시 쓴다 (§10).

### 상태 점검

- `verify.sh` 에 한 줄: `D2Coding 글꼴` PASS (`사용자 글꼴` · `시스템 글꼴`) / 없으면 WARN `터미널은 지금 글꼴로 동작합니다. install.cmd 의 업데이트로 설치하세요.`

### 구현 순서와 확인 방법

1. `system.mjs` 글꼴 판정 · 설치 · 제거, 프로필 `font.face`, mintty 바로가기 (부모) — 자동 검증: 단위 (이미 있음 · 새로 설치 · 다른 이름 글꼴 · sandbox · 제거 판정), `bash tests/installer-sandbox.sh` (WT 조각의 `font.face`, 바로가기 대상).
2. 작업 줄 (tui-implementer) — 자동 검증: `just tui-test` · `bash tests/installer-sandbox.sh`. 실측: mintty 80×24 설치 · 업데이트 · 제거 진행 화면 캡처.
3. 설치본 업데이트 [승인 필요: 실제 설치본] — 실측: WT `Oxygen Pi` 프로필과 바로가기가 D2Coding 으로 열림, `verify.sh` 의 글꼴 줄.

### 정할 것

- 없음 (이 절의 승인만 남음)
