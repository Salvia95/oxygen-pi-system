# oxygen-pi-tui 명세 (pi 화면 꾸미기 · 도구 출력 구조화 · D2Coding)

pi 의 대화 화면(헤더 · 메시지창 · 입력창 · 푸터)을 Oxygen Pi System 에 맞게 다시 그리는 pi extension `oxygen-pi-tui` 를 만든다. 기본 도구(rg · fd 등)의 결과는 파일별로 묶어 구조화해서 보인다. 터미널 글꼴로 D2Coding 을 번들에 넣어 설치한다.
`oxy-tui`(Ratatui 화면 프로그램, 설치 · Tweak · 모니터)와는 다른 것이다. 이 명세는 pi 프로세스 안에서 그리는 화면과 글꼴 반입만 다룬다.
색 · 글꼴 · 기호의 공통 기준은 `.claude/rules/oxygen-design.md` 다.
진행 상태: [진행판](dev-board.md) 의 `pi-tui` 행.

요청 (사용자, 2026-11-13): pi-open-tui · pi-omp-theme 처럼 oxygen-pi-tui 를 만든다. https://pi.dev/docs/latest/extensions 를 참고해 Oxygen Pi System 에 맞게 헤더 · 메시지창 · 입력창 · 푸터 디자인을 정하고, rg · fd 등 기본 도구에 구조화된 출력 기능을 더한다. 구현은 가장 필요한 외관부터 시작해 세세한 부분으로 들어간다.

결정된 사항 (사용자, 2026-11-13: "한글 중심의 작업이 예상되니 … D2Coding 이 폰트를 패킹해서 사용하는 것으로 하자, pi-omp-theme 은 별도의 레포지토리가 없어 … 이 자료들만 참고해, 다른 것들은 네 제안대로 승인할거고 시그니처 컬러는 Oxygen 에 맞는 컬러로 지정하고 앞으로 인지하고 디자인할 수 있게해줘")
- D1 (a) 평범한 글자 조각 · ` · ` 구분. D2 (a) 화면에서만 구조화. D3 (a) 헤더 키 안내 줄 없음. D4 (a) 설치하면 켜짐. D6 (b) 컨텍스트 50% `warning` · 85% `error`.
- D5: pi-omp-theme 은 pi.dev 패키지 페이지(`@nguyenquangthai/pi-omp-theme`)와 그 패키지 파일만 참고한다 (§1).
- 글꼴: D2Coding 1.4.0 을 번들에 넣어 설치하고 터미널 글꼴로 쓴다 (§8).
- 시그니처 색: 부모가 정한다 → Oxygen Sage `#A9CBA4` (설치 TUI 배너 · 강조색, `.claude/rules/oxygen-design.md`).

결정된 사항 (사용자, 2026-11-13: "Lite Weight 로 줄여 … 부제의 아스키 아트 표기는 포기하자 … 레포지토리 주소를 적어줘 세로 2단 분리는 포기하자")
- 웰컴 카드는 배너 · 부제 글자 두 줄 · 저장소 주소의 한 칸 세로 배치 (§3).

결정된 사항 (사용자, 2026-11-13: "웰컴 문구에서 푸터와 겹치는 부분은 다 빼줘 … 부제로 Lite Weighted Coding Agent 
 For Closed Network … 작은 아스키 아트로 … 변경되면 보여주고 8단계 진행하자, 그리고 9단계는 나중에 생각하고 … Status Bar 쪽도 확인하고 모니터 등의 디자인도 일체화시키자")
- 웰컴 카드에서 모델 · 폴더를 빼고 부제를 작은 아스키 아트로 (§3). `docs/tui-spec.md` §12 를 승인했다 (8단계 진행). 9단계(실제 LLM)는 보류. 하단 바 · 모니터 디자인을 이 명세의 기준에 맞춰 일체화한다 (새 명세 `docs/ui-unify-spec.md`).

결정된 사항 (사용자, 2026-11-13: 웰컴 카드 스크린샷과 함께 "내가 말하는 헤더는 이 스크린샷과 같은 웰컴 메세지를 말하는 거야")
- 헤더는 웰컴 카드다 (§3). 처음 안의 2줄 헤더는 푸터와 겹쳐 버렸다.

결정된 사항 (사용자, 2026-11-13: "권장안대로 갈게 바로 진행해")
- 이 명세를 승인했다. D7 (b): WT 프로필에 D2Coding, WT 가 없을 때 Git Bash 바로가기는 `mintty.exe -o Font=D2Coding …` 로 연다 (`~/.minttyrc` 는 건드리지 않음). 1단계에서 이 PC 에 D2Coding 을 사용자 글꼴로 설치한다.

## 1. 확인된 사실

pi 1.5.0 (`vendor/pi/node_modules/@earendil-works/pi-coding-agent`, `docs/extensions.md` · `docs/tui.md` · `docs/themes.md` · `examples/extensions/*`, 2026-11-13 확인).

| 영역 | 쓸 수 있는 API | 한계 |
| --- | --- | --- |
| 헤더 | `ctx.ui.setHeader((tui, theme) => Component)` | 내장 헤더(버전 · 키 안내)를 통째로 바꾼다. 팩토리에 keybindings 가 오지 않아 사용자가 바꾼 키를 알 수 없다 |
| 메시지창 | 테마 토큰(`userMessageBg` · `toolPendingBg` · `toolSuccessBg` · `toolErrorBg` · `md*` 등), `pi.registerMarkdownTransformer` (표시 전용), `pi.registerToolRenderer`, `ctx.ui.setHiddenThinkingLabel`, `setWorkingIndicator` · `setWorkingMessage` | 사용자 · 어시스턴트 메시지 컴포넌트 자체는 바꿀 수 없다 (색은 테마, 내용은 markdown 변환만) |
| 입력창 | `ctx.ui.setEditorComponent((tui, theme, keybindings) => CustomEditor)`, `CustomEditor` 네 번째 인자 `{ embedWorkingStatus: true }` (작업 표시를 테두리에) | `CustomEditor` 를 상속해 윗줄 · 아랫줄 테두리만 바꾼다. 자동완성 · 붙여넣기는 그대로 |
| 푸터 | `ctx.ui.setFooter((tui, theme, footerData) => Component)`, `footerData.getGitBranch()` · `onBranchChange()` · `getExtensionStatuses()`, `ctx.getContextUsage()` | 내장 푸터를 통째로 바꾸므로 다른 extension 의 `setStatus` 글도 직접 그려야 한다 |
| 도구 출력 | `pi.registerToolRenderer((toolName, next) => ({ renderCall, renderResult }))` | 실행 · 모델이 받는 내용은 그대로 두고 그리기만 바꾼다. `next()` 를 부르지 않고 돌려주면 등록된 도구(내장 포함)의 그리기보다 앞선다 |

- 내장 도구 이름은 `grep`(내부에서 rg 실행) · `find` · `ls` · `read` · `bash` · `edit` · `write` 다. 우리 설정의 `defaultTools` 는 `read, bash, edit, write, grep` 이고 (`agent/settings.json`), `AGENTS.md` 는 파일 찾기를 `bash` 안의 `fd` 로 하라고 한다. 그래서 **rg 는 `grep` 도구로, fd 는 `bash` 도구로** 들어온다.
- 내장 `grep` 결과 글은 `경로:줄: 내용` 줄의 나열이고 `details` 는 `{ truncation?, matchLimitReached?, linesTruncated? }` 다. 내장 그리기는 앞 15줄만 보이고 나머지는 "더 보기" 로 접는다 (`dist/core/tools/renderers/grep.js`). `bash` 의 `details` 는 `{ truncation?, fullOutputPath? }` 다.
- 지금 화면에 무엇인가를 그리는 우리 extension:
  - `oxy-context-budget` → `setStatus("oxy-ctx", "ctx 23% (29K/128K)")`
  - `oxy-flow` → `setStatus("oxy-flow", "flow n4 · 할 일 2/5 …")`
  - `oxy-jobs` → `setStatus("oxy-jobs", …)`, psmux 밖에서는 입력창 위 `setWidget("oxy-jobs", 작업 목록)`
  - `oxy-monitor` → psmux 안에서 입력창 아래 `setWidget("oxy-bar", …, { placement: "belowEditor" })`
- 테마는 이미 `tokyo-night` 다 (`vendor/pi-themes/tokyo-night.json`, `flow-view` 명세). 시그니처 색(브랜드 표식 · 작업 중 테두리) 말고는 테마 토큰만 쓴다.
- 설치 TUI 의 색은 세이지 초록 팔레트이고 배너는 `O`·`GEN` 초록, `PI` pi 보라다 (`docs/tui-spec.md` §2 §4, `installer/oxy-tui/src/theme.rs`). 시그니처 색은 이것을 이어받는다.
- psmux 안에서는 pi pane 이 창 너비의 70% 다. 80×24 창이면 pi 는 **56칸**에서 그려진다 (`docs/monitor-spec.md` §6).
- 참고한 패키지 (2026-11-13):
  - `pi-open-tui` 0.4.5 (MIT): 헤더 · 2줄 푸터(Starship 식 조각: 위치 · git · 실행환경 · 타이머 · 컨텍스트 · 모델 · 토큰 · 비용) · 둥근 테두리 입력창 · "Compact" 도구 줄 `● Read(path:1-120)` / `└ 120 lines` · 생각 미리보기 · 턴 통계. Nerd Font 아이콘이 기본이고 `ascii` · `unicode` 모드가 따로 있다.
  - `@nguyenquangthai/pi-omp-theme` 1.0.26 (MIT, pi.dev 패키지 페이지 · jsDelivr 의 패키지 파일만 읽음): 테마 `titanium` (강조 `#00b4ff` 전기 파랑, 바탕 `#151820` 계열) + 시작 화면 · 상태 줄 · 입력창 · 메시지 · 도구 그리기를 한 벌로 바꾼다. 상태 줄은 모델 · 생각 수준 · 경로 · git · 컨텍스트 · 사용량 · 비용 · 시간을 너비에 따라 줄이고, 구분자는 흐린 `·` 다 (powerline 없음). 메시지는 어시스턴트 앞 `●` 과 매달린 줄, 사용자 메시지는 `>` 로 시작하는 띠, 생각은 `Thought for 6.2s` 한 줄. 도구는 상자 그리기가 기본이고 `claude-code` 프리셋은 `● Bash(...)` + `⎿` 결과 줄. 미리 정한 묶음(`claude` · `omp` · `minimal` · `ascii` …)을 `settings.json` 의 `piOmpTheme` 로 고른다. Nerd Font 는 꺼진 것이 기본이다. 상태 줄 조각의 정확한 순서는 번들 안에서 찾지 못했다.
  - 우리가 가져오는 것: 흐린 `·` 구분 · 너비에 따른 조각 빼기(둘 다), `●` + `└` 도구 줄(둘 다, `⎿` 는 D2Coding 에 없어 `└`), 시작 화면을 짧게(pi-omp-theme 의 compact). 가져오지 않는 것: 자체 테마 파일(테마는 Tokyo Night 를 유지), 미리 정한 묶음 · 코어 패치.
- D2Coding 1.4.0 (`github.com/naver/d2-coding-font` 릴리스 `VER1.4.0`, 2026-10-03, OFL-1.1):
  - 내려받을 파일은 `D2Coding-Ver1.4.0-20261003.zip` 하나 (21,298,887 바이트, sha256 `17e2da5e2879006eb725b87943f7988736ef8b6c9f8b84bc8e3bdbcb8dd46744`, 릴리스의 digest 와 내려받은 파일이 같음).
  - zip 안: `D2Coding/D2Coding-Ver1.4.0-20261003.ttf` · `D2Coding/D2CodingBold-Ver1.4.0-20261003.ttf` · `.ttc`, `D2CodingAll/` · `D2CodingLigature/` (TTC · 합자판), `OFL.txt`.
  - 글꼴 이름(name table 1 · 4)은 `D2Coding`. 반각 폭 500/1000, 한글 `가` 2칸.
  - 이 명세에서 쓰는 기호는 모두 1칸이다 (`hmtx` 폭): `● ○ ✓ ✗ × └ ├ │ ─ ╭ ╮ ╰ ╯ ◆ › · … ◐ ◓ ◑ ◒ ❯ ▲ ▼ ◀ ▶`. **점자 `⠋⠙⠹` · `⎿` · `⏺` 은 글꼴에 없다.**
- 1단계 실측 (2026-11-13, pi 1.5.0 · mock LLM · psmux 안 mintty 80×24, `-o Font=D2Coding`, 시험용 extension):
  - F1 세로 순서는 위에서부터 `setWidget`(기본, 입력창 위) → 입력창 → `belowEditor` 위젯 → 푸터. 푸터가 맨 아래다.
  - F2 `● ○ ✓ ✗ × └ ├ │ ─ ╭ ╮ ╰ ╯ ◆ › · … ◐ ◓ ◑ ◒ ❯ ▲ ▼ ◀ ▶` 가 모두 1칸으로 그려진다 (구분자 `|` 사이 간격이 같음, 확대 캡처). Windows Terminal 은 D2Coding 프로필이 생기는 8단계에서 확인한다.
  - F3 `registerToolRenderer` 가 `next()` 없이 돌려준 그리기가 내장 `grep` · `bash` 그리기보다 앞선다. `context.durationMs` 가 온다 (grep 431ms, bash 404ms), `context.keyText("app.tools.expand")` 는 `ctrl+o`. 도구 줄 본문의 폭은 창보다 좁다 (상자 안쪽 여백, `PROBE-CALL` 줄이 66칸쯤에서 접힘).
  - F4 psmux 안에서 `TERM=xterm-256color` · `COLORTERM=truecolor` 이고 `theme.getColorMode()` 는 `truecolor`. 24비트 Oxygen Sage · pi 보라가 mintty 에 그대로 그려진다.
  - 그 밖: `footerData.getExtensionStatuses()` 키는 `probe` · `oxy-ctx` (응답 뒤). `/oxygen-pi-tui off` 는 알림을 띄우고 `<agent>/oxygen-pi-tui.json` 에 `"enabled": false` 를 쓴다. 명령 인자 자동완성이 열려 있으면 첫 Enter 는 완성에 쓰이고 둘째 Enter 가 실행한다 (pi 기본 동작).
  - 이 PC 에는 사용자가 먼저 깐 `D2Codingligature Nerd Font` (`D2Coding ligature (TrueType)`) 가 있었다. 글꼴 이름이 달라 1단계의 `D2Coding` 설치와 겹치지 않았다 → 8단계의 "이미 있음" 판정은 글꼴 이름 `D2Coding` 이 정확히 같을 때만.
  - 증거: scratchpad `caps/pt1-f2-mintty-d2coding.png` · `pt1-f2-zoom.png` · `pt1-f2-zoom2.png`.

## 2. 공통 규칙

- 위치: `agent/extensions/oxygen-pi-tui/` (`index.ts` 가 등록만 하고, 그리기는 순수 함수 파일로 나눈다: `header.ts` · `editor.ts` · `footer.ts` · `tools/*.ts` · `layout.ts` · `glyphs.ts` · `brand.ts`). 순수 함수는 `(입력, 너비, 테마) → string[]` 이라 단위 테스트로 확인한다.
- 대화형 모드(`ctx.mode === "tui"`)에서만 화면을 바꾼다. `-p` · json · rpc 모드와 subagent 에서는 아무것도 하지 않는다.
- 기본으로 켜진다 (D4). 끄기: `/oxygen-pi-tui off` 는 헤더 · 입력창 · 푸터를 pi 기본으로 되돌리고 (`undefined` 를 넘김) 도구 그리기는 `next()` 로 넘긴다. `/oxygen-pi-tui on` 으로 다시 켠다. 설정은 `agent/oxygen-pi-tui.json` 에 둔다.
- 색:
  - 시그니처 색은 `brand.ts` 한곳에만 둔다: `o2.sage` (어두운 배경 `#A9CBA4` · 밝은 배경 `#3A6652`), `pi.purple` (`#A798D7` · `#7459B4`). `theme.appearance` 로 고르고, 24비트 색을 못 쓰면 256색 대체 (`.claude/rules/oxygen-design.md` 의 표).
  - 시그니처 색은 브랜드 표식(헤더 `◆ Oxygen`)과 작업 중 입력창 테두리에만 쓴다. 상태의 뜻에는 쓰지 않는다.
  - 그 밖은 테마 토큰만 쓴다 (`accent` · `muted` · `dim` · `success` · `warning` · `error` · `toolTitle` · `toolOutput` · `border` · `borderMuted` · `bashMode` · `searchMatchText`). 한글 글자에는 회색(`muted` · `dim`)을 쓰지 않는다 (mintty 에서 흐려 읽기 어려움, `docs/tui-spec.md` §4 와 같은 규칙). 회색은 테두리 · 경로 · 숫자 · 시간 · 코드 문맥 줄에만 쓴다. 5단계 캡처에서 `결과 없음` 이 회색으로 그려진 것을 보고 한글 글 전부를 `text` 로 바꿨다 (2026-11-13).
- 글꼴 · 기호: 화면은 D2Coding 기준으로 설계한다 (§8). 기호는 `glyphs.ts` 한곳에 두고 §1 의 1칸 목록 안에서만 고른다. F2 에서 2칸으로 그려지는 터미널이 있으면 ASCII 대체(`* o v x \ | - + > .`)로 바꾼다. Nerd Font · powerline 글리프 · 점자는 쓰지 않는다.
- 모든 줄은 `visibleWidth` 로 재고 `truncateToWidth` 로 자른다. 줄마다 색을 다시 입힌다. 테마가 바뀌면 `invalidate()` 에서 캐시를 버린다.
- 너비 단계: **넓음** ≥ 100칸, **보통** 64–99칸, **좁음** < 64칸 (psmux 안 80×24 = 56칸). 각 영역은 좁음에서 무엇을 먼저 빼는지 정해 둔다 (§3–§6).
- 조각 구분은 흐린 ` · ` 와 빈칸이다 (D1).
- 화면 문구는 한국어로, 실제 한국어 소프트웨어가 쓰는 말을 쓴다 (예: VS Code 의 "3개 파일에서 7개 결과").

## 3. 헤더 (웰컴 카드)

pi 를 띄울 때 대화 맨 위에 한 번 나오고 대화와 함께 위로 밀려 올라간다. 내장 헤더(로고 · 키 안내)를 바꾼다. 키 안내 줄은 두지 않는다 (D3).

바뀐 과정 (사용자, 2026-11-13)
- 처음 안(2줄: 버전 · 테마 / 모델 · 폴더)은 "사실상 푸터랑 중복" → pi-open-tui 스크린샷 같은 웰컴 카드로.
- 둘째 안(배너 아래 모델 · 폴더 줄): "웰컴 문구에서 푸터와 겹치는 부분은 다 빼줘 … 부제 … 작은 아스키 아트로".
- 셋째 안(부제 아스키 아트 · 오른쪽 열): "Lite Weight 로 줄여. 부제의 아스키 아트 표기는 포기하자, 박스 예산에 너무 빽빽해. 차라리 부제는 '무엇을 도와드릴까요?'를 지우고 같은 색으로 Lite Weight Coding Agent \n For Closed Network 를 텍스트로 쓰고 그 아래는 명령어 대신 레포지토리 주소를 적어줘. 세로 2단 분리는 포기하자."

64칸 이상 (80×24 에서 13줄):
```
╭─ ◆ Oxygen Pi 0.1.0 ──────────────────────────────────────────────────────────╮
│           ██████╗ ▀▀▄      ██████╗ ███████╗███╗   ██╗  ██████╗ ██╗           │
│          ██╔═══██╗▄▀      ██╔════╝ ██╔════╝████╗  ██║  ██╔══██╗██║           │
│          ██║   ██║▀▀▀     ██║  ███╗█████╗  ██╔██╗ ██║  ██████╔╝██║           │
│          ██║   ██║▄ ▄ ▄ ▄ ██║   ██║██╔══╝  ██║╚██╗██║  ██╔═══╝ ██║           │
│          ╚██████╔╝▄▀▄ ▀▄█ ╚██████╔╝███████╗██║ ╚████║  ██║     ██║           │
│           ╚═════╝      ▄▀  ╚═════╝ ╚══════╝╚═╝  ╚═══╝  ╚═╝     ╚═╝           │
│                                                                              │
│                           Lite Weight Coding Agent                           │
│                              For Closed Network                              │
│                                                                              │
│                 https://github.com/Salvia95/oxygen-pi-system                 │
╰──────────────────────────────────────────────────────────────────────────────╯
```

64칸 미만 (psmux 안 56칸): 배너 없이 6줄.
```
╭─ ◆ Oxygen Pi 0.1.0 ──────────────────────────────────╮
│               Lite Weight Coding Agent               │
│                  For Closed Network                  │
│                                                      │
│     https://github.com/Salvia95/oxygen-pi-system     │
╰──────────────────────────────────────────────────────╯
```

- 한 칸짜리 세로 배치다. 오른쪽 열 · 안내 문구(`무엇을 도와드릴까요?`) · 명령 목록은 두지 않는다. 넓은 창에서도 같다.
- 넣지 않는 것: 모델 · 생각 수준 · 폴더 · 브랜치 (입력창 테두리 · 푸터가 늘 보인다).
- 로고는 설치 TUI 의 확정 배너 `O²xyGEN PI` 큰 배너(ANSI Shadow, 6줄)를 그대로 옮긴다 (`installer/oxy-tui/src/banner.rs` 의 글자 · `theme.rs` 의 색, 앞 여백 2칸을 뺀 57칸). 배너는 64칸부터 (`banner.rs` 와 같은 기준). 배너 색 값은 `brand.ts` 의 `BANNER` 에 두고, `theme.rs` 와 다르면 `theme.rs` 가 맞다.
- 부제 `Lite Weight Coding Agent` / `For Closed Network` 는 글자로, 두 줄 모두 `o2.mid`. 저장소 주소 `https://github.com/Salvia95/oxygen-pi-system` (git remote origin) 는 `muted` (영문 주소라 회색 규칙에 걸리지 않는다). 모두 가운데 정렬.
- 카드 테두리는 `o2.mid`, 제목 `◆ Oxygen` 은 `o2.sage` + 굵게, `Pi` 는 `pi.purple` + 굵게, 버전은 `muted`. 카드 전체가 브랜드 표식이다 (`.claude/rules/oxygen-design.md`).
- 30칸보다 좁으면 그리지 않는다 (제목이 들어가지 않는다).
- 구현 (6단계, 2026-11-13): `header.ts` (`bannerLines` · `SUBTITLE` · `REPO_URL` · `headerLines`) · `chrome.ts` 의 `installHeader`. 단위: 30–160칸 폭 · 배너 64칸부터 · 13줄(80) · 6줄(56). mintty 캡처는 tui-implementer 작업이 끝난 뒤 (psmux 를 함께 쓰지 않기로 함). **사용자 확인 대기.**

## 4. 메시지창

메시지 컴포넌트 자체는 pi 것을 쓴다. 바꾸는 것은 도구 줄(§7 에서 자세히) · 작업 표시 · 숨긴 생각 라벨이다.

### 도구 줄 공통 틀

```
 ✓ grep /registerTool/ in agent/extensions                               0.2s
 └ 3개 파일에서 7개 결과
   …도구별 본문 (§7)
```

- 첫 줄(`renderCall`): 상태 기호 · 도구 제목(`toolTitle` + `bold`) · 인자 요약(`accent`) · 오른쪽 끝 걸린 시간(`muted`, 끝난 뒤에만).
- 상태 기호: 실행 중 `○` (`warning`), 성공 `✓` (`success`), 실패 `×` (`error`, 설치 TUI 의 실패 기호와 같음). 성공은 처음에 `●` 였고 `docs/ui-unify-spec.md` D1 (2026-11-13) 로 모든 화면의 `✓` 에 맞췄다.
- 둘째 줄(`renderResult`): `└ ` 뒤에 한 줄 요약. 본문은 둘째 줄 아래에 2칸 들여 쓴다.
- 접힌 상태(기본)는 본문을 최대 8줄 보이고, 넘치면 `  … <n>개 더 (<펼치기 키> 펼치기)` 한 줄을 둔다. 펼치기 키 글은 렌더러에 주입된 `context.keyText("app.tools.expand")` 로 쓴다 (사용자가 바꾼 키를 따른다).
- 펼친 상태는 본문을 모두 보이되 도구별 상한(§7)을 둔다.
- 우리가 그리기를 정하지 않은 도구(MCP 도구 · 다른 extension 도구)는 `next()` 그대로 둔다.
- pi 의 도구 상자(배경색 · 위아래 여백)는 쓰지 않는다 (`renderShell: "self"`). 도구마다 빈 줄 하나 + 첫 줄 + 요약 + 본문이다. 24줄 창에서 도구 하나에 2줄씩 아낀다.
- 펼친 `read` · `edit` 는 요약 아래에 pi 기본 그리기(코드 강조 · diff)를 3칸 들여 붙인다 (앞 빈 줄은 뺀다).
- 구현 · 실측 (3단계, 2026-11-13): `tools/frame.ts` (첫 줄 · 요약 · 접힘) · `tools/basic.ts` (bash 결과 글 읽기: `Command exited with code N` · `Command aborted` · `Command timed out after N seconds` · `[Showing lines a-b of N. Full output: …]`) · `tools/index.ts` (`registerToolRenderer`). mock 시나리오 `tui-tools` (read → bash 12줄 → edit → write → `exit 3`) 를 mintty 80×24 D2Coding 으로 확인: `● read sample.txt` / `└ 1줄`, bash 는 `… 앞 4줄 더 (ctrl+o 펼치기)` + 마지막 8줄, `└ +1 -1`, `└ 3줄 씀`, `× $ echo 실패 직전; exit 3` / `└ 종료 3 · 출력 1줄` (빨강). ctrl+o 로 펼치면 read 내용 · edit diff 가 붙는다. 증거: scratchpad `caps/pt3-80-tools.png`.

### 작업 표시 · 생각 라벨

- 작업 중 문구: `◐ ◓ ◑ ◒` 스피너 + `작업 중` + 걸린 초. 입력창 윗줄 테두리 안에 보인다 (`embedWorkingStatus`, §5).
- 숨긴 생각 라벨: `생각 과정` (`setHiddenThinkingLabel`). pi 는 이 라벨을 쓰는 중인 답뿐 아니라 끝난 답의 접힌 생각에도 붙인다 (`interactive-mode.js`, 기본 `Thinking...`). 그래서 진행형(`생각 중…`)이 아니라 시제 없는 말로 정했다 (6단계, 2026-11-13).

## 5. 입력창

pi 기본 입력창의 윗줄 · 아랫줄 가로선을 상태가 들어간 테두리로 바꾼다. 옆 테두리는 두지 않는다 (커서 · 자동완성 위치를 건드리지 않음).

보통 (80칸), 쉬는 중:
```
╭─ 입력 ─────────────────────────────────────────── vllm · qwen3-30b · low ─╮
 › 다음 할 일을 정리해줘
╰──────────────────────────────────────────────── ctx 23% · 29K/128K ──────╯
```

보통 (80칸), 작업 중:
```
╭─ ◓ 작업 중 12초 ───────────────────────────────── vllm · qwen3-30b · low ─╮
 › 
╰──────────────────────────────────────────────── ctx 23% · 29K/128K ──────╯
```

좁음 (56칸):
```
╭─ 입력 ───────────────────────────── qwen3-30b · low ─╮
 › 다음 할 일을 정리해줘
╰──────────────────────────────────────────── ctx 23% ─╯
```

- 윗줄 왼쪽: 쉬는 중 `입력`, 작업 중 `<스피너> 작업 중 <n>초`. 윗줄 오른쪽: `<연결> · <모델> · <생각 수준>` (`muted`). 좁음에서는 연결 이름을 뺀다.
- 아랫줄 오른쪽: `ctx <퍼센트>% · <사용>/<창>`. 50% 이상 `warning` (oxy-flow 가 다음 메시지에서 새 세션으로 넘어가는 지점), 85% 이상 `error` (D6). 유료 연결(비용이 0 보다 큼)이면 `· $0.012` 를 붙인다. 좁음에서는 `ctx <퍼센트>%` 만.
- 테두리 색: 쉬는 중 `border`, 작업 중 `o2.sage` (스피너 · `작업 중` 글자도 같은 색), bash 모드(`!`) 는 `bashMode`.
- 입력 앞 `›` 는 `accent`.
- 다른 extension 이 이미 입력창을 바꿨으면(`getEditorComponent()` 가 있으면) 그것을 `base` 로 감싼다. (지금 우리 extension 가운데 입력창을 바꾸는 것은 없다.)
- 구현 (2단계, 2026-11-13): `agent/extensions/oxygen-pi-tui/editor.ts` (테두리 · 글 순수 함수) · `chrome.ts` (`CustomEditor` 상속, `embedWorkingStatus` 로 받은 pi 의 표시를 윗줄에 그림 — 작업 중은 우리 문구, 재시도 · 압축은 pi 문구 그대로). pi 는 새 입력창에 사용자 설정 `editorPaddingX` 를 다시 넣으므로 3칸으로 고정한다 (` › ` 자리). 위 · 아래로 숨은 줄은 `▲ <n>줄 더` · `▼ <n>줄 더`.
- 실측 (2026-11-13, pi 1.5.0 · mock LLM · tokyo-night · mintty D2Coding): 80×24 쉬는 중 · 작업 중(`◑ 작업 중 5초`, 테두리 · 글이 24비트 `169;203;164`), bash 모드 테두리 `bashMode`(`255;158;100`), 56×24 좁음(`qwen3.6-coder-30b` 만, `ctx 0%`). 모델이 생각 기능이 없는 qwen3.6-coder 라 수준은 빠진다. D2Coding 은 테두리 선을 칸 아래쪽에 그려 윗줄 글(`입력`)이 선 위로 올라앉은 모양이 된다. 증거: scratchpad `caps/pt2-80-working.png` · `pt2-56-idle.png` · `pt2-zoom-corner.png`.

## 6. 푸터

한 줄. 입력창 아래(psmux 안에서는 하단 바 아래, F1)에 둔다.

보통 (80칸, 다른 extension 의 상태 글이 있을 때):
```
 ~/workspace/oxygen-pi-system  main                              db appdb 연결됨
```

좁음 (56칸, psmux 안):
```
 …/oxygen-pi-system  main
```

- 왼쪽: 작업 폴더(`muted`, 홈은 `~`) + 두 칸 + git 브랜치(`accent`). 브랜치가 없으면 뺀다.
- 오른쪽: extension 상태 글을 ` · ` 로 잇는다. 순서는 `oxy-flow` → `oxy-jobs` → 그 밖의 키(이름순). `oxy-ctx` 는 입력창 아랫줄에 보이므로 푸터에서 뺀다.
- 하단 바(`oxy-monitor`)가 있으면 `oxy-flow` · `oxy-jobs` 도 뺀다 (바와 겹침). 바는 `OXY_MONITOR` 가 꺼져 있지 않으면 psmux 안팎 모두 그려진다 (2단계 실측, 2026-11-13: 처음 명세는 psmux 안에서만 바가 있다고 보았다). 바를 끄면(`OXY_MONITOR=off`) 푸터가 flow · jobs 를 보인다.
- 구현 · 실측 (2단계, 2026-11-13): `footer.ts` · `chrome.ts`. psmux 밖 · 안 모두 `jobs` 상태가 바에만 보이고, 푸터는 ` …/work  main` (긴 임시 폴더) · ` …/work  main` 으로 줄었다. `OXY_MONITOR=off` 일 때의 상태 순서는 단위 시험으로 확인.
- 줄이 넘치면 (1) 폴더를 `…/<마지막 단계>` 로 줄이고 (2) 상태 글을 뒤에서부터 자르고 (3) 8칸도 남지 않으면 상태를 뺀 뒤 (4) 폴더를 가운데 말줄임한다. 브랜치는 마지막까지 남긴다.
  - 2단계 실측에서 바꿈 (2026-11-13): 처음 규칙(상태를 먼저 자름)은 작업 폴더 경로가 길면(66칸) 상태 `jobs 1 · agents 0/2` 를 통째로 빼고 전체 경로를 남겼다. 바뀌는 정보(상태)를 폴더 전체 경로보다 먼저 지킨다.

## 7. 도구 출력 구조화

모델이 받는 결과 글은 바꾸지 않는다 (D2). 화면에서만 결과 글을 읽어 묶는다. 읽지 못하는 모양이면 pi 기본 그리기(`next()`)로 넘긴다.

### 7.1 `grep` (rg)

접힘:
```
 ✓ grep /registerTool/ in agent/extensions                               0.2s
 └ 3개 파일에서 7개 결과
   agent/extensions/oxy-flow/index.ts                                       3
   agent/extensions/oxy-jobs/index.ts                                       2
   agent/extensions/oxy-monitor/index.ts                                    2
```

펼침:
```
 ✓ grep /registerTool/ in agent/extensions                               0.2s
 └ 3개 파일에서 7개 결과
   agent/extensions/oxy-flow/index.ts
     195 │   pi.registerTool({
     218 │   pi.registerTool({
     253 │   pi.registerTool({
   agent/extensions/oxy-jobs/index.ts
     189 │   pi.registerTool({
   …
```

- 첫 줄: `grep /<패턴>/ in <경로>`, glob 이 있으면 ` (<glob>)`.
- 요약: `<n>개 파일에서 <m>개 결과`. 결과가 없으면 `└ 결과 없음` (`muted`). 잘림이 있으면 ` · 결과 <k>개에서 멈춤` 또는 ` · 일부 줄 잘림` 을 `warning` 으로 붙인다.
- 접힘 본문: 파일마다 한 줄, 오른쪽 끝에 결과 수. 순서는 rg 가 낸 순서. 8개 파일 넘으면 `… <n>개 파일 더`.
- 펼침 본문: 파일 이름(`accent`) 아래에 `<줄 번호> │ <내용>`. 줄 번호는 오른쪽 맞춤, 내용 안의 패턴 일치 부분을 `searchMatchText` 로 칠한다 (패턴을 JS 정규식으로 만들 수 없으면 칠하지 않는다). 문맥 줄(`경로-줄-내용`)은 `muted`. 상한 200줄.
- 경로는 작업 폴더 기준 상대 경로 (밖이면 홈을 `~` 로). 좁음에서는 가운데를 `…` 로 줄인다.
- 첫 줄이 넘치면 걸린 시간은 남기고 인자를 자른다.
- 일치 부분은 `searchMatchBg` 바탕 + `searchMatchText` 글자 (Tokyo Night 는 두 토큰이 없어 `selectedBg` · `text` 로 대신 그려진다).
- 구현 · 실측 (4단계, 2026-11-13): `tools/grep.ts`. mock `tui-grep` 를 80×24 · 56×24 와 펼침으로 확인: `└ 5개 파일에서 11개 결과`, 파일마다 결과 수, 펼치면 `195 │   pi.registerTool({` 에 일치 강조. 증거: scratchpad `caps/pt4-80-grep.png` · `pt4-80-grep-expanded.png`.

### 7.2 `bash` 안의 `fd`

명령이 `fd` 로 시작하거나 (앞에 `cd <폴더> &&` 가 붙은 것 포함) 파이프 없이 `fd` 하나만 부를 때 적용한다.

접힘:
```
 ✓ $ fd -e sql src                                                       0.1s
 └ 폴더 3개에 파일 23개
   src/db/                                                                 12
   src/report/                                                              8
   src/                                                                     3
```

펼침:
```
   src/db/
     001_init.sql   002_users.sql   003_orders.sql   …
```

- 요약: `폴더 <k>개에 파일 <n>개` (폴더만 나오면 `폴더 <k>개`). 결과가 없으면 `└ 찾은 파일 없음`.
- 접힘 본문: 바로 위 폴더별로 묶고 오른쪽에 개수. 폴더는 처음 나온 순서.
- 펼침 본문: 폴더 아래에 파일 이름(경로 없이)을 너비에 맞춰 여러 칸으로 늘어놓는다. 상한 200개.

### 7.3 `bash` 안의 `rg`

명령이 `rg` 로 시작하고 출력이 `경로:줄:내용` 모양이면 §7.1 과 같게 그린다. `rg -l` · `rg --files` 처럼 경로만 나오면 §7.2 와 같게 그린다. `rg -c` 는 파일별 개수 표로.

- `-n` 없이 부르면 줄 번호가 없다 (`경로:내용`): 줄 번호 칸을 비운다. 패턴을 명령에서 뽑지 않으므로 일치 부분 강조는 하지 않는다.
- rg 가 결과 없이 종료 1 로 끝나면 실패가 아니다: `✓ … / └ 결과 없음`. rg 오류(종료 2) · 중단 · 시간 제한은 일반 bash 그리기.
- 알아보는 명령: 앞의 `cd <폴더> &&` (여러 번 가능) 와 뒤의 `2>/dev/null` · `2>&1` 은 허용. 파이프 · `;` · `&&` 로 이은 다른 명령 · 리다이렉트 · `$(…)` · 여러 줄 · `rg --json` 같은 모르는 출력은 일반 bash 그리기.
- 첫 줄의 `cd <24자 넘는 경로> &&` 는 마지막 폴더만 보인다 (`cd …/extensions && fd -e ts`). 실측에서 긴 경로가 실제 명령을 가렸다.
- 구현 · 실측 (5단계, 2026-11-13): `tools/search.ts`. mock `tui-search` (`fd -e ts` · `rg -n` · `rg -l` · `rg -c` · 결과 없는 `rg`) 를 mintty 80×24 D2Coding 으로 확인: `└ 폴더 7개에 파일 36개` · `└ 5개 파일에서 11개 결과` · `└ 폴더 4개에 파일 5개` · `└ 결과 없음` (● 초록). 증거: scratchpad `caps/pt5-80-search.png`.

### 7.4 그 밖의 기본 도구 (간단 요약)

| 도구 | 첫 줄 | 요약 줄 | 펼침 |
| --- | --- | --- | --- |
| `bash` (위에 해당하지 않음) | `$ <명령 첫 줄>` (넘치면 `…`) | `종료 0 · 출력 <n>줄` (`success`) / `종료 <c>` (`error`) / `잘림 · 전체 출력 <파일>` | 마지막 8줄 → 펼치면 마지막 200줄 |
| `read` | `read <경로>[:<시작>-<끝>]` | `<n>줄` · 잘리면 `전체 <m>줄 중` | pi 기본 (코드 강조) |
| `edit` | `edit <경로>` | `+<추가> -<삭제>` | pi 기본 diff |
| `write` | `write <경로>` | `<n>줄 씀` | 없음 |

## 8. 글꼴 D2Coding 반입 · 적용

### 반입 (fetch · 번들)

- `manifest/tools.lock.tsv` 에 `role=harness` 행을 더한다: `d2coding	1.4.0	https://github.com/naver/d2-coding-font/releases/download/VER1.4.0/D2Coding-Ver1.4.0-20261003.zip	17e2da5e2879006eb725b87943f7988736ef8b6c9f8b84bc8e3bdbcb8dd46744	OFL-1.1	harness	core`. 선택 화면에 나오지 않고 fetch 가 늘 함께 받는다 (`pi-tokyo-night` 과 같다).
- `scripts/fetch-bundle.sh` 는 zip 에서 `D2Coding/D2Coding-Ver1.4.0-20261003.ttf` · `D2Coding/D2CodingBold-Ver1.4.0-20261003.ttf` · `OFL.txt` 만 꺼내 `vendor/fonts/d2coding/` 에 둔다. 셋 중 하나라도 없으면 실패한다. TTC · 합자판 · `D2CodingAll` 은 넣지 않는다.
- `installer/components.mjs` 의 `HARNESS_FILES` 에 `"d2coding": "vendor/fonts/d2coding/D2Coding-Ver1.4.0-20261003.ttf"` 를 더한다. 없으면 번들링은 경고만 하고 (`글꼴(D2Coding)이 없으면 터미널은 지금 글꼴로 동작합니다`) 설치는 글꼴 단계를 건너뛴다.
- `NOTICE` 에 D2Coding 과 OFL-1.1 고지를 더하고, 번들에 `OFL.txt` 를 함께 넣는다.

### 설치 · 업데이트 · 제거

- 관리자 권한 없이 사용자 글꼴로 설치한다: 두 TTF 를 `%LOCALAPPDATA%\Microsoft\Windows\Fonts\` 에 복사하고 `HKCU\Software\Microsoft\Windows NT\CurrentVersion\Fonts` 에 `D2Coding (TrueType)` · `D2Coding Bold (TrueType)` 값을 쓴 뒤, 실행 중인 프로그램이 알도록 글꼴 변경을 알린다 (`AddFontResource` + `WM_FONTCHANGE`).
- 같은 이름의 글꼴이 이미 있으면(시스템 글꼴 `C:\Windows\Fonts` 이거나 사용자가 먼저 깐 것) 설치하지 않고 그것을 쓴다. 설치 기록(`reg`)에는 우리가 깐 경우만 남긴다.
- 업데이트는 우리가 깐 글꼴의 버전이 번들과 다를 때만 바꾼다. 제거는 우리가 깐 글꼴만 지운다 (사용 중이면 다음 로그인 때 지워지도록 표시).
- `--sandbox` 에서는 sandbox 폴더에 복사 기록만 남기고 레지스트리를 건드리지 않는다.
- 작업 줄 문구 · 위치는 설치 화면 명세 `docs/tui-spec.md` §12 (초안, 2026-11-13) 에서 정하고 tui-implementer 가 구현한다 (위임 전에 그 절을 사용자에게 승인받는다).
- 구현 (7단계 반입, 2026-11-13): `manifest/tools.lock.tsv` 의 `d2coding` 행 (role=harness), `scripts/fetch-bundle.sh` 의 `place_harness` 가 zip 에서 TTF 두 개와 `OFL.txt` 를 `vendor/fonts/d2coding/` 에 꺼냄, `installer/components.mjs` 의 `HARNESS_FILES`, `NOTICE`. 실측: `bash scripts/fetch-bundle.sh --only=d2coding` → `✓ d2coding 1.4.0` (sha256 확인), `components.mjs status` 에 `d2coding harness 1`, `package-bundle.sh --check` 통과, `git status` 에 글꼴 파일 없음 (`/vendor/` 는 무시 목록).

### 터미널에 적용

- Windows Terminal `Oxygen Pi` 프로필에 `"font": { "face": "D2Coding" }` 를 더한다. 글자 크기는 정하지 않는다 (터미널 기본).
- WT 가 없을 때 Git Bash 바로가기는 `<Git>/usr/bin/mintty.exe -o Font=D2Coding -i <Git 아이콘> /usr/bin/bash --login -i -c "source …/env.sh && cd ~ && exec bash -i"` 로 연다 (D7 (b)). `~/.minttyrc` 는 건드리지 않는다. 바로가기 대상이 바뀌므로 `docs/tui-spec.md` §10 의 셸별 실행 방법 표도 함께 고친다 (8단계).
- `verify.sh` 에 글꼴 확인 한 줄을 더한다 (`D2Coding 글꼴 설치됨` / 없으면 WARN).

## 9. 구현 순서와 확인 방법

화면에 늘 보이는 아래쪽(입력창 · 푸터)과 작업 중 화면 대부분을 차지하는 도구 줄을 먼저 하고, 한 번만 보이는 헤더와 세부는 뒤로 둔다. 글꼴은 1단계에서 이 PC 에만 깔아 실측 기준으로 쓰고, 설치 프로그램 반영은 화면이 굳은 뒤에 한다.
pi extension 단계는 부모(메인 세션)가 구현한다 (`tui-implementer` 는 설치 · Tweak · `oxy-tui` 화면 담당). 8단계의 설치 화면 작업 줄만 tui-implementer 에게 넘긴다.

1. 골격 · 사실 확인 (§1 F1–F4, §2) — 자동 검증: `just unit` 에 `layout.ts` · `glyphs.ts` · `brand.ts` 테스트 (한글 · 모호폭 너비, 56/80/120칸 자르기, 밝은 · 어두운 · 256색 값). 실측: D2Coding 을 이 PC 에 사용자 글꼴로 깔고 [승인 필요: 이 PC 에 글꼴 설치], 시험용 extension 으로 F1–F4 를 mintty 80×24 (`-o Font=D2Coding`, psmux 안 · 밖) · WT 에서 캡처해 결과를 §1 에 적는다. `/oxygen-pi-tui on|off` 가 기본 화면으로 돌아가는지.
2. 입력창 · 푸터 (§5 §6) — 자동 검증: 단위 (쉬는 중 · 작업 중 · bash 모드 · 50/85% · 비용 · 좁음, 상태 키 순서 · psmux 에서 뺄 것). 실측: mock LLM 으로 대화형 pi, mintty 80×24 psmux 밖 · 안 캡처, 작업 중 스피너와 시그니처 색 테두리, `oxy-jobs` 위젯 · `oxy-bar` 와 겹치지 않는지.
3. 도구 줄 공통 틀 + `bash` · `read` · `edit` · `write` 요약 (§4 §7.4) — 자동 검증: 단위 (상태 기호 · 시간 · 접힘 8줄 · 펼침 상한, 읽지 못하면 `next()`). 실측: mock LLM 이 각 도구를 부르는 대화를 mintty 80×24 로 캡처, 펼치기 키로 펼침.
4. `grep` 구조화 (§7.1) — 자동 검증: 단위 (실제 rg 출력 fixture: 결과 없음 · 한 파일 · 여러 파일 · 문맥 줄 · 잘림 · Windows 경로 · 한글 줄). 실측: 이 저장소에서 mock LLM 이 `grep` 을 부르게 해 접힘 · 펼침 캡처 (psmux 안 56칸 포함).
5. `bash` 안의 `fd` · `rg` (§7.2 §7.3) — 자동 검증: 단위 (명령 인식 표: `fd`, `cd x && fd`, 파이프 있는 것은 제외, `rg -l` · `rg -c`). 실측: mock 대화 캡처.
6. 헤더 · 작업 표시 · 생각 라벨 (§3 §4) — 자동 검증: 단위 (보통 · 좁음, 모델 바뀜, `Oxygen` · `Pi` 색). 실측: 띄운 직후 캡처, 모델 · 생각 수준 바꾼 뒤 캡처.
7. 글꼴 반입 (§8 반입) — 자동 검증: `bash scripts/fetch-bundle.sh --only=d2coding` 이 sha256 을 확인하고 세 파일을 꺼냄, 번들 zip 목록에 세 파일, `just hygiene` (저장소에 글꼴 파일이 들어가지 않음).
8. 글꼴 설치 · 터미널 적용 (§8 설치 · 적용, 작업 줄은 tui-implementer) — 자동 검증: 단위 (이미 있음 · 새로 깜 · 업데이트 · 제거 판정), `bash tests/installer-sandbox.sh` (작업 줄 · WT 프로필의 `font.face`). 실측: 설치본 업데이트 뒤 WT `Oxygen Pi` 프로필과 바로가기가 D2Coding 으로 열리는지 캡처 [승인 필요: 실제 설치본].
9. 실제 LLM 확인 — 실측: 실제 LLM 한 번으로 대화형 세션 하나를 끝까지 (grep · fd · bash · edit 를 쓰는 작업) D2Coding 의 mintty 80×24 psmux 안 · 밖 · WT 캡처 [승인 필요: 과금 LLM].

완료 조건: 1–9 단계 + 사용자가 9단계 캡처를 확인함 (확인한 캡처가 이 명세가 된다).

뒤로 미룬 것 (이 명세 밖, 따로 요청이 오면): Tweak 의 extension 켜기 · 끄기 목록에 `oxygen-pi-tui` 넣기 (tui-implementer), 코드 블록 테두리 · 복사, 턴 통계 알림, 모델이 받는 결과 글의 구조화 (D2 (b)), 기존 `oxy-tui` 화면의 점자 스피너를 D2Coding 에서 확인 (`.claude/rules/oxygen-design.md`).

## 10. 정할 것

- 없음 (D1–D7 결정, 2026-11-13)
