# Oxygen 디자인 기준 (시그니처 색 · 글꼴 · 기호)

Oxygen Pi System 이 그리는 모든 화면(설치 · Tweak · 모니터 `oxy-tui`, pi extension `oxygen-pi-tui`, Windows Terminal 프로필)에 적용한다.
정한 날: 2026-11-13 (사용자: "시그니처 컬러는 Oxygen에 맞는 컬러로 지정하고 앞으로 인지하고 디자인할 수 있게해줘", "D2Coding 폰트를 패킹해서 사용").

## 시그니처 색: Oxygen Sage

설치 TUI 배너(`O²xyGEN`)와 강조색으로 이미 확정된 초록(세이지)을 Oxygen 의 시그니처 색으로 정한다. 짝 색은 배너 `PI` 의 pi 보라다.
값의 원본은 `installer/oxy-tui/src/theme.rs` 의 `DARK_BG` · `LIGHT_BG` 다. 여기 값과 다르면 `theme.rs` 가 맞다.

| 이름 | 쓰임 | 어두운 배경 | 밝은 배경 | 256색 대체 |
| --- | --- | --- | --- | --- |
| `o2.sage` (시그니처) | 브랜드 표식, 포커스 · 현재 위치, 입력 칸 테두리의 강조 | `#A9CBA4` | `#3A6652` | 151 / 65 |
| `o2.mid` | 시그니처의 둘째 단계 (그러데이션 · 보조 강조) | `#7FA98A` | `#4C7A62` | 108 / 65 |
| `o2.shadow` | 시그니처 계열의 바탕 · 그림자 | `#3A5A4D` | `#A9CBA4` | 59 / 151 |
| `o2.white` | 시그니처 위의 밝은 글자 (배너 `²`) | `#F1F7EE` | `#1E2E28` | 255 / 235 |
| `pi.purple` (짝 색) | `Pi` 이름 · pi 쪽 표식에만 | `#A798D7` | `#7459B4` | 140 / 97 |

규칙
- 한 화면에서 시그니처 색은 1–2곳에만 쓴다: 브랜드 표식(`◆` 과 `Oxygen` 이름), 그리고 포커스 · 현재 위치 · 작업 중 테두리 가운데 그 화면의 주인공 하나.
- 상태의 뜻(성공 · 경고 · 오류 · 진행)에는 시그니처 색을 쓰지 않는다. 상태는 테마의 `success` · `warning` · `error` 토큰과 기호로 나타낸다. 시그니처 초록과 성공 초록을 한 줄에 나란히 두지 않는다.
- 이름을 쓸 때는 `Oxygen` 을 `o2.sage`, `Pi` 를 `pi.purple` 로 칠한다 (배너의 `OxyGEN` · `PI` 와 같은 짝).
- 시그니처 색 값은 화면마다 한 파일에만 둔다: `oxy-tui` 는 `theme.rs`, pi extension 은 `agent/extensions/oxygen-pi-tui/brand.ts`. 그 밖의 색은 각 화면의 테마를 따른다.
- 테마는 Oxygen 테마 하나다 (Tokyo Night 는 걷어냈다, 2026-11-13): pi 는 `config/pi-themes/oxygen.json`, Windows Terminal 은 `Oxygen` 색 구성, `oxy-tui` 는 기본 세이지 팔레트. 팔레트 표는 `docs/ui-unify-spec.md` §2.0. pi 의 `accent` 는 하늘색 `#7FB8D6` 이고 세이지가 아니다 (시그니처를 1–2곳에 두려고).
- 한글 글자에는 회색(테마의 `muted` · `dim`, `oxy-tui` 의 `gray`)을 쓰지 않는다. mintty 에서 어두운 회색 한글은 읽기 어렵다 (`docs/tui-spec.md` §4). 회색은 테두리 · 경로 · 숫자 · 시간 · 코드 문맥 줄에만 쓴다.
- 밝은 배경에서는 밝은 배경 열의 값을 쓴다 (pi 는 `theme.appearance`, `oxy-tui` 는 `OXY_TUI_THEME=light`). 24비트 색을 쓸 수 없는 터미널에서는 256색 대체를 쓴다. `NO_COLOR` 면 색을 끄고 굵기 · 기호만 남긴다.
- 이미 사용자가 확인한 화면(배너 · 설치 · Tweak · Flow/Job Monitor 캡처)은 이 기준 때문에 다시 그리지 않는다. 그 화면을 고칠 일이 생기면 그때 이 기준에 맞춘다.

## 글꼴: D2Coding 1.4.0

- 한글이 많은 화면이므로 터미널 글꼴은 D2Coding(네이버, OFL-1.1) 으로 맞춘다. 번들에는 `D2Coding/` 폴더의 일반 · 굵게 TTF 두 개와 `OFL.txt` 만 넣는다 (합자판 · TTC 는 넣지 않는다).
- 화면은 D2Coding 기준으로 설계한다: 한글은 2칸, 아래 기호는 D2Coding 에서 1칸이다 (글꼴의 글자 폭 표에서 확인, 2026-11-13):
  `● ○ ◆ ◇ ◐ ◓ ◑ ◒ ✓ ✗ × ! › ❯ · • … ─ │ └ ├ ╭ ╮ ╰ ╯ ▲ ▼ ◀ ▶ ▸ ← → ■ □ ▀ ▄ ▌ █ ²`
- D2Coding 에 없는 글자는 다른 글꼴로 대신 그려져 폭이 어긋날 수 있으므로 새 화면에 쓰지 않는다: 점자 스피너 `⠋⠙⠹…`, `⎿`, `⏺`, Nerd Font · powerline 글리프. 진행 표시는 `◐ ◓ ◑ ◒` 를 쓴다.
- 글꼴에서 1칸이어도 터미널이 동아시아 모호폭 글자를 2칸으로 그릴 수 있다. 새 기호는 mintty · Windows Terminal 실제 캡처로 1칸인지 확인한 뒤 쓴다.
- 이미 있는 화면의 점자 스피너(`oxy-tui` `SPINNER`, `docs/tui-spec.md` §5)는 D2Coding 을 적용한 뒤 캡처로 확인하고, 어긋나면 그 화면을 고칠 때 `◐ ◓ ◑ ◒` 로 바꾼다.
