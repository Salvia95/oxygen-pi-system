# 하단 바 · 모니터 디자인 일체화 명세

psmux 하단 바(`oxy-monitor` 의 상태 바)와 Flow Monitor · Job Monitor(`oxy-tui` 모니터 모드)를 oxygen-pi-tui(`docs/pi-tui-spec.md`)와 같은 디자인 기준(`.claude/rules/oxygen-design.md`: 시그니처 색 Oxygen Sage, D2Coding, 1칸 기호)으로 맞춘다.
진행 상태: [진행판](dev-board.md) 의 `ui-unify` 행.

요청 (사용자, 2026-11-13): "우리가 이전에 만든 Flow, Job Monitor를 키기위한 Status Bar쪽도 확인하고 모니터 등의 디자인도 일체화시키자"

결정된 사항 (사용자, 2026-11-13: "1. 팔레트 색 승인할게 2. 반영해줘 3. 반영해줘 4. 일체화 범위에 넣어줘")
- 이 명세를 승인했다. D5 Oxygen 팔레트 (§2.0) 확정. D1 (a) 끝남은 모든 화면에서 `✓` (pi 도구 줄의 `●` 도). D2 (a) 하단 바는 입력창 아래 따로 한 줄. D3 (a) 설치 · Tweak 스피너도 `◐◓◑◒`.
- `background` 도구 줄(oxy-jobs)도 일체화한다 (§2.5).
- 설치본에 지금 상태(pi-tui · D2Coding · Oxygen 테마)를 반영한다.

## 1. 확인된 사실 (2026-11-13, 코드 읽기)

| 곳 | 지금 | pi-tui (이번에 만든 것) |
| --- | --- | --- |
| 하단 바 (`agent/extensions/oxy-monitor/bar.ts` · `index.ts`) | `▸ jobs 1 실행 중 · 1 완료   ▸ flow 2/5`. 열린 모니터는 테마 `accent` 굵게, 키보드로 고른 항목은 `selectedBg`, 키 안내 `←→ 이동  Enter 열기·닫기  ↑ 입력창`. 상태 기호 없음, 이름은 소문자 영어 | 도구 줄 `○` 실행 중 · `●` 성공 · `×` 실패, 스피너 `◐◓◑◒` |
| 모니터 맨 윗줄 띠 (`installer/oxy-tui/src/monitor.rs` · `theme.rs` 의 `band`) | `Flow Monitor        Total 2/6` 를 pane 폭 전체 띠로. Tokyo Night 이면 바탕 `#7AA2F7`(Tokyo 파랑) · 글자 `#1A1B26`, 기본(어두움)이면 바탕 `#3A5A4D` · 글자 `#F1F7EE` | 웰컴 카드 제목 `◆ Oxygen Pi`, 테두리 `o2.mid` |
| 모니터 상태 기호 | 진행 `⠋⠙⠹…`(점자 10프레임, Tokyo 는 `#7DCFFF`) · 완료 `✓` · 실패 `!`/`×` · 대기 `·` · 지금 할 일 `◀ Current Task` | 위와 같음 |
| 설치 · Tweak 진행 표시 (`oxy-tui` `SPINNER`) | 점자 `⠋⠙⠹…` | — |
| 글꼴 | 점자 스피너는 **D2Coding 에 없다** (다른 글꼴로 대신 그려져 폭이 어긋날 수 있음, `docs/pi-tui-spec.md` §1) | D2Coding 1칸 기호만 |

- 모니터 · 설치 화면은 `oxy-tui.exe`(Rust) 이므로 바꾸면 새 릴리스(0.4.0) · sha256 고정 · 번들 · 설치본 반영이 필요하다 [승인 필요].
- 하단 바는 pi extension 이라 릴리스 없이 바뀐다.

## 2. 바꿀 것 (안)

### 2.0 Oxygen 테마 (Tokyo Night 대신)

결정 (사용자, 2026-11-13): "Tokyo Night 테마는 이제 제거해도 될 것 같아 우리만의 테마색을 적용하자".

- pi 테마 `oxygen` (어두운 배경): 저장소 파일 `config/pi-themes/oxygen.json` (우리 것이라 반입하지 않는다). pi 의 테마 검증(`validateThemeJson`)과 로더(`loadThemeFromPath`, 24비트 · 256색)를 통과했다 (2026-11-13).
- 팔레트 (설치 TUI 의 세이지 팔레트에서):

| 이름 | 값 | 쓰는 토큰 |
| --- | --- | --- |
| 바탕 | `#141A17` (WT 배경) · 패널 `#1A221E` · 들뜸 `#1E2924` · 선택 `#24332C` | `toolPendingBg` · `userMessageBg` · `selectedBg` |
| 글자 | `#DCE5DA` · 밝은 글자 `#F1F7EE` | `text` · `toolOutput` / `toolTitle` · `searchMatchText` |
| 회색 | `#7C8A84` · 흐림 `#56635D` | `muted` / `dim` (한글에는 쓰지 않는다) |
| 선 | `#3A5A4D` · 흐린 선 `#2C3A34` | `border` · `mdHr` / `borderMuted` |
| 세이지 (시그니처) | `#A9CBA4` · 밝음 `#C6DDBF` · 중간 `#7FA98A` · 짙음 `#55806A` | `borderAccent` · `mdListBullet` · `mdHeading` · 생각 수준 low–medium |
| 하늘 (accent) | `#7FB8D6` | `accent` · `mdLink` · `syntaxFunction` |
| pi 보라 | `#A798D7` | `mdCode` · `syntaxKeyword` · `customMessageLabel` · 생각 수준 high |
| 상태 | 성공 잎 `#9BDB7B` · 실패 코랄 `#F2777A` · 주의 앰버 `#E8C26B` · bash 주황 `#E8A86B` | `success` · `error` · `warning` · `bashMode` |
| 그 밖 | 청록 `#79C7C5` · 복숭아 `#E3B98A` · 문자열 `#B5D99C` | `syntaxType` · `syntaxVariable` · `syntaxString` |

- `accent` 를 세이지가 아니라 하늘색으로 둔 이유: `accent` 는 pi 가 경로 · 링크 · 프롬프트 등 곳곳에 쓰므로 세이지로 두면 시그니처 색이 화면 전체에 퍼진다 (규칙: 시그니처는 1–2곳). 성공 색은 세이지와 헷갈리지 않게 채도 높은 잎 초록.
- `configure` 의 기본 테마를 `oxygen` 으로. 설정이 `tokyo-night` 이면(우리가 넣었던 기본값) `oxygen` 으로 바꾸고 `agent/themes/tokyo-night.json` 을 지운다. 사용자가 그 밖의 테마를 골랐으면 그대로 둔다.
- Tokyo Night 를 걷어낸다: `manifest/tools.lock.tsv` 의 `pi-tokyo-night` 행, `scripts/fetch-bundle.sh` 의 꺼내기, `installer/components.mjs` 의 `HARNESS_FILES`, 번들 안내 문구, 이 PC 의 `vendor/pi-themes/`.
- Windows Terminal `Oxygen Pi` 프로필의 색 구성을 `Oxygen` 으로: 바탕 `#141A17` · 글자 `#DCE5DA` · 커서 `#A9CBA4` · 선택 `#2C4A3C`, 16색 black `#1E2924` · red `#F2777A` · green `#9BDB7B` · yellow `#E8C26B` · blue `#7FB8D6` · purple `#A798D7` · cyan `#79C7C5` · white `#DCE5DA`, bright 는 한 단계 밝게 (brightBlack `#56635D` · brightWhite `#F1F7EE`).
- 모니터: pi 테마가 `oxygen` 이면 `oxy-tui` 는 기본(세이지) 팔레트로 그린다 (지금 코드 그대로, `monitorTheme` 이 Tokyo 를 고르지 않음). 경고 · 오류의 16색 이름 색은 WT 색 구성의 앰버 · 코랄로 보인다. `oxy-tui` 안의 Tokyo 팔레트 코드는 다음 릴리스 때 지운다. → D4 는 필요 없어졌다.
- 구현 (2026-11-13, 부모): `config/pi-themes/oxygen.json`, `scripts/render-config.mjs` (`DEFAULT_THEME = "oxygen"`, `tokyo-night` → `oxygen` 바꾸기 · 테마 파일 지움), `installer/system.mjs` 의 `WT_SCHEME` (`Oxygen`) · 필수 파일 목록에 테마, `manifest` · `fetch-bundle.sh` · `components.mjs` · `package-bundle.sh` 에서 `pi-tokyo-night` 제거, `oxy-monitor/controller.ts` 의 `monitorTheme` (Tokyo 고르기 제거), 이 PC 의 `vendor/pi-themes/` 지움. 단위 `# tests 83` `# pass 83` `# fail 0` (테마 시험: 기본 oxygen · tokyo-night 바꾸기 · pi 검증 통과 · accent 하늘색), 위생 통과. `tests/installer-sandbox.sh` PASS 73 · FAIL 0 (`WT 프로필: Oxygen 색 구성` 포함, 2026-11-13 부모). 실측: mock pi 의 임시 agent 에 `"theme": "oxygen"` · `themes/oxygen.json`, mintty 80×24 D2Coding 웰컴 카드 · 대화(도구 줄) · psmux 안 Job Monitor 캡처 (scratchpad `caps/pt7-80-welcome.png` · `pt7-80-chat.png` · `pt7-80-monitor.png`). 모니터는 기본 세이지 팔레트로 그려지고, 점자 스피너 `⠋` 는 D2Coding 에 없어 작게 대신 그려진다 (§2.3 의 근거). 남음: 사용자 팔레트 확인 (D5), 설치본 반영 [승인 필요].
- 이 명세의 다른 절에서 "Tokyo" 로 적힌 색(스피너 `#7DCFFF` 등)은 Oxygen 팔레트로 읽는다: 스피너는 `accent`(하늘) .

### 2.1 공통 상태 기호 (규칙 파일에 더한다)

| 뜻 | 기호 | 색 |
| --- | --- | --- |
| 진행 중 (움직임) | `◐ ◓ ◑ ◒` | Tokyo `#7DCFFF` / 테마 `accent` (지금 모니터의 스피너 색 그대로) |
| 진행 중 (멈춘 그림) | `○` | `warning` |
| 끝남 · 성공 | `✓` (D1, pi 도구 줄의 `●` 도 바꿈: `glyphs.ts` 의 `ok`) | `success` |
| 실패 | `×` | `error` |
| 주의 | `!` | `warning` |
| 대기 · 아직 | `·` | 회색 (기호만, 한글 글에는 회색을 쓰지 않는다) |

### 2.2 하단 바

```
지금   ▸ jobs 1 실행 중 · 1 완료   ▸ flow 2/5
안     ◐ Jobs 1 실행 중 · 1 완료   ✓ Flow 2/5
       ◐ Jobs 1 실행 중   ◐ Flow 2/5 · 테스트 작성        ← flow 의 지금 할 일이 있을 때 (넓을 때만)
```

- 항목 앞 기호가 상태를 보인다: Jobs 는 실행 중이면 스피너, 모두 끝났으면 `✓`, 실패가 있으면 `×`. Flow 는 진행 중인 할 일이 있으면 스피너, 모두 끝났으면 `✓`.
- 이름은 모니터 제목과 같게 `Jobs` · `Flow` (첫 글자 대문자).
- 열린 모니터의 항목은 `o2.sage` 굵게 (지금은 테마 `accent`). 키보드로 고른 항목은 지금처럼 `selectedBg`.
- 왼쪽 여백 1칸 (푸터 · 도구 줄과 같은 시작 칸).
- 바의 자리는 지금처럼 입력창 아래 한 줄 (D2 (a)).
- 구현 · 실측 (2026-11-13, 부모): `oxy-monitor/bar.ts` (`BarState` · 이름 `Jobs`/`Flow` · 왼쪽 여백 1칸), `oxy-monitor/index.ts` (기호 · 시그니처 색, `oxygen-pi-tui/glyphs.ts` · `brand.ts` 를 씀), `oxy-jobs` 요약에 `failed`. 단위 `# tests 84` `# pass 84`. mock pi psmux 안 80×24 D2Coding: `◑ Jobs 1 실행 중`, 모니터를 열면 이름이 세이지 굵게 (scratchpad `caps/pt8-80-bar.png` · `pt8-80-bar-open.png`).

### 2.3 모니터 (Flow Monitor · Job Monitor)

```
지금   Flow Monitor             Total 2/6        ← 띠 바탕 Tokyo 파랑
안     ◆ Flow Monitor           Total 2/6        ← 띠 바탕 o2.sage(#A9CBA4) · 글자 #1A1B26 · 굵게, ◆ 는 같은 띠 위
```

- 띠 색: Tokyo Night 일 때도 Oxygen Sage 바탕 (기본 어두움 · 밝음 팔레트는 지금 값 그대로). 제목 앞에 `◆`.
- 스피너: 점자 → `◐ ◓ ◑ ◒` (프레임 4개, 간격 150ms). 색은 지금 그대로.
- 그 밖의 배치 · 문구 · 키는 바꾸지 않는다 (확인된 화면 그대로: `docs/flow-view-spec.md` · `docs/jobs-view-spec.md`).

### 2.5 `background` 도구 줄 (oxy-jobs)

- pi 기본 상자 대신 다른 도구와 같은 한 줄 틀(`docs/pi-tui-spec.md` §4): `○/✓/× background <action> <인자>` · `└ <요약>`.
- 요약: start `job-1 시작 · 끝나면 알림` · status `작업 없음` / `작업 2개 · 1개 실행 중` (본문에 작업 줄, 상태는 한국어) · output `job-1 실패 · 출력 2줄` (본문은 마지막 줄들) · stop `job-1 중지함` / `job-1: 실행 중이 아님 (끝남)`. 상태 말: 대기 · 실행 중 · 끝남 · 실패 · 중지됨.
- 구현 (2026-11-13, 부모): `oxygen-pi-tui/tools/jobs.ts` · `tools/index.ts`. mock 실측: `✓ background start echo bg-long-started; sleep 60; …` / `└ job-1 시작 · 끝나면 알림`.

### 2.4 설치 · Tweak (D3)

- 진행 표시의 점자 스피너만 `◐ ◓ ◑ ◒` 로 바꾼다 (같은 exe 라 같은 릴리스). 배치 · 색 · 문구는 바꾸지 않는다.

## 3. 구현 순서와 확인 방법

구현 기록 (2026-11-13)
- 1 하단 바 (부모): 완료 — §2.2 의 구현 · 실측.
- 2 `oxy-tui` (tui-implementer): 스피너 `◐◓◑◒` 150ms (모니터 · 설치 · Tweak), 띠 `◆ `, Tokyo 팔레트 코드 삭제, 작업 줄 `warn` 상태(노란 `!`, exe `--version` 의 `task-warn` 낱말로 판단해 예전 exe 에는 글 한 줄). 부모 후속: `oxy-monitor/model.ts` 의 제목 줄이기 기준에 `◆ ` 2칸(`TITLE_MARK_WIDTH`) → 23칸 Flow 는 `◆ Flow`, 예시 모델 3개 다시 만듦. 부모가 다시 실행: 단위 `# tests 84` `# pass 84` `# fail 0`, `just tui-test` `48 passed; 0 failed`, 위생 통과. tui-implementer: `tests/installer-sandbox.sh` PASS 73. 캡처: scratchpad `caps/ug-*.png` (모니터 23 · 35칸, 설치 진행 스피너, 노란 `!` 경고 줄).
- 3 릴리스 · 번들 · 설치본: 대기 [승인 필요: 커밋 · push · GitHub 릴리스 `oxy-tui-v0.4.0` · `Cargo.toml` 0.4.0 · sha256 고정 · 설치본 업데이트].

1. 하단 바 (§2.2, 부모) — 자동 검증: `bar.ts` 단위 (항목 기호 · 이름 · 폭 · 클릭 범위). 실측: mock pi psmux 안 · 밖 mintty 80×24 D2Coding, 키보드로 들어가 Enter 로 모니터 열기 · 닫기, 클릭.
2. `oxy-tui` 스피너 · 띠 (§2.3 §2.4, tui-implementer) — 자동 검증: `just tui-test` · 단위 · `tests/installer-sandbox.sh`. 실측: 모니터 23칸 · 35칸 (tokyo-night · 기본), 설치 진행 화면 mintty 80×24 D2Coding 캡처.
3. 릴리스 · 번들 · 설치본 [승인 필요: GitHub 릴리스 · 실제 설치본] — 릴리스 워크플로 `oxy-tui-v0.4.0`, sha256 고정, 설치본 업데이트 뒤 `/monitor flow` · `/monitor jobs` 캡처.

완료 조건: 1–3 + 사용자가 3의 캡처를 확인함.

## 4. 정할 것

- D1 끝남 기호 — (a) 모든 화면에서 `✓` (pi 도구 줄의 `●` 도 `✓` 로 바꿈) (b) pi 도구 줄은 `●`, 할 일 · 작업은 `✓` 로 나눔. 권장 (a): 한 가지 말로 읽히고, `×` 와 짝이 맞는다.
- D2 하단 바 자리 — (a) 지금처럼 입력창 아래 따로 한 줄 (b) 푸터 오른쪽에 넣어 한 줄로 (키 · 클릭은 지금과 같게). 권장 (a): 바는 키보드로 들어가는 자리라 따로 있는 편이 헷갈리지 않고, (b) 는 두 extension 이 한 줄을 나눠 그려야 해서 클릭 범위 계산이 얽힌다. 24줄 창에서 한 줄을 아끼는 것이 더 중요하면 (b).
- D3 설치 · Tweak 의 스피너도 이번 릴리스에서 바꿀지 — (a) 바꿈 (b) 그대로. 권장 (a): 같은 exe 이고, 점자는 D2Coding 에 없다.
- D4 모니터 띠 색 — Tokyo Night 를 걷어내므로 필요 없어졌다 (§2.0, 기본 팔레트의 세이지 띠).
- D5 Oxygen 테마 팔레트 (§2.0) — 실제 화면 캡처를 보고 확정한다.
