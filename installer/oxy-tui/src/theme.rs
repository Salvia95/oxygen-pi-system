//! 색과 기호.
//! 색은 채도 낮은 초록(세이지) 팔레트 하나다. 24비트 색으로 지정한다 (mintty · Windows Terminal 에서 확인).
//! 강조색은 `light` 하나 (포커스한 행 · 현재 단계 · 배너). 경고 노랑 · 오류 빨강만 16색 이름 색을 쓴다.
//! 문장과 값은 터미널의 기본 글자색, 레이블과 키는 굵게. 회색(`gray`)은 테두리 · 버전 · 경로 · 선택할 수 없는 레이블에만 쓴다
//! (mintty 에서 어두운 회색 한글은 읽히지 않는다).
//! `NO_COLOR` 가 있으면 색을 모두 끄고 굵기와 기호만 남긴다. `OXY_TUI_THEME=light` 는 밝은 배경 터미널용 팔레트다.
//! 팔레트는 어두운 배경(기본)과 밝은 배경 둘뿐이다. 예전 `OXY_TUI_THEME=tokyo-night` 는 걷어냈다 (그 값이 와도 기본 팔레트).
//! 기호는 mintty 와 Windows Terminal 양쪽에서 1칸으로 그려지는 글자만 고른다 (✔ ✖ ↑↓ 는 그림 글자로 그려진다).
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};

use ratatui::style::{Color, Modifier, Style};

pub const POINTER: &str = "❯";
pub const OK: &str = "✓";
pub const ERR: &str = "×";
pub const WARN: &str = "!";
pub const UP: &str = "▲";
pub const DOWN: &str = "▼";
/// 돌아가는 표시. D2Coding 에서 1칸으로 그려지는 기호 4프레임 (점자 스피너는 D2Coding 에 없다)
pub const SPINNER: [&str; 4] = ["◐", "◓", "◑", "◒"];
/// 프레임 하나가 보이는 시간
pub const SPINNER_MS: u128 = 150;

/// 시작한 뒤 `elapsed_ms` 가 지났을 때의 스피너 프레임 번호
pub fn spinner_frame(elapsed_ms: u128) -> usize {
    (elapsed_ms / SPINNER_MS) as usize % SPINNER.len()
}

pub type Rgb = [u8; 3];

/// 팔레트. 밝은 쪽에서 어두운 쪽으로: white → light → mid → dark → shadow
pub struct Palette {
    pub white: Rgb,
    /// 강조색
    pub light: Rgb,
    pub mid: Rgb,
    pub dark: Rgb,
    pub shadow: Rgb,
    /// 테두리 · 버전 · 경로
    pub gray: Rgb,
    /// 큰 배너 글자의 줄별 색 (위 → 아래로 짙어진다. 마지막 줄은 그림자)
    pub rows6: [Rgb; 6],
    /// 배너의 `PI`: pi coding agent 기본 테마의 강조색(어두운 테마 #A798D7 · 밝은 테마 #7459B4) 계열. 마지막은 그림자
    pub pi6: [Rgb; 6],
}

/// 어두운 배경 (기본)
const DARK_BG: Palette = Palette {
    white: [0xF1, 0xF7, 0xEE],
    light: [0xA9, 0xCB, 0xA4],
    mid: [0x7F, 0xA9, 0x8A],
    dark: [0x55, 0x80, 0x6A],
    shadow: [0x3A, 0x5A, 0x4D],
    gray: [0x7C, 0x8A, 0x84],
    rows6: [[0xC6, 0xDD, 0xBF], [0xB3, 0xD0, 0xAE], [0x9F, 0xC1, 0x9E], [0x8C, 0xB2, 0x8F], [0x79, 0xA2, 0x81], [0x3A, 0x5A, 0x4D]],
    pi6: [[0xD3, 0xCB, 0xEF], [0xC4, 0xB9, 0xE7], [0xB5, 0xA8, 0xDF], [0xA7, 0x98, 0xD7], [0x93, 0x83, 0xC8], [0x51, 0x46, 0x7D]],
};

/// 밝은 배경 (`OXY_TUI_THEME=light`): 같은 색상을 어둡게 뒤집은 것. 실제 밝은 배경 터미널에서 확인하지 못했다
const LIGHT_BG: Palette = Palette {
    white: [0x1E, 0x2E, 0x28],
    light: [0x3A, 0x66, 0x52],
    mid: [0x4C, 0x7A, 0x62],
    dark: [0x6C, 0x97, 0x7E],
    shadow: [0xA9, 0xCB, 0xA4],
    gray: [0x60, 0x6E, 0x68],
    rows6: [[0x2F, 0x4A, 0x3F], [0x36, 0x55, 0x47], [0x3D, 0x60, 0x4F], [0x45, 0x6C, 0x58], [0x4C, 0x7A, 0x62], [0xA9, 0xCB, 0xA4]],
    pi6: [[0x56, 0x40, 0x92], [0x60, 0x48, 0x9E], [0x6A, 0x51, 0xA9], [0x74, 0x59, 0xB4], [0x82, 0x69, 0xBE], [0xC9, 0xBF, 0xE6]],
};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Variant {
    Dark,
    Light,
}

/// 화면을 그리는 조건: 환경변수가 정한 테마, 모니터 모드인지, 색을 끌지
#[derive(Clone, Copy, Debug)]
pub struct Look {
    pub theme: Variant,
    pub monitor: bool,
    pub no_color: bool,
}

static MONITOR: AtomicBool = AtomicBool::new(false);

/// 모니터 모드로 그린다고 알린다 (첫 색을 고르기 전에 한 번 부른다). 모니터에서 색을 껐을 때의 모양이 설치 화면과 다르다
pub fn set_monitor() {
    MONITOR.store(true, Ordering::Relaxed);
}

#[cfg(test)]
thread_local! {
    static FORCE: std::cell::Cell<Option<Look>> = const { std::cell::Cell::new(None) };
}

/// 시험용: 이 스레드에서만 조건을 정해 놓고 `f` 를 부른다 (시험은 스레드마다 따로 돌아 서로 섞이지 않는다)
#[cfg(test)]
pub fn with_look<R>(look: Look, f: impl FnOnce() -> R) -> R {
    let prev = FORCE.with(|c| c.replace(Some(look)));
    let r = f();
    FORCE.with(|c| c.set(prev));
    r
}

fn look() -> Look {
    #[cfg(test)]
    if let Some(l) = FORCE.with(std::cell::Cell::get) {
        return l;
    }
    static THEME: OnceLock<Variant> = OnceLock::new();
    let theme = *THEME.get_or_init(|| variant_of(std::env::var("OXY_TUI_THEME").ok().as_deref()));
    Look { theme, monitor: MONITOR.load(Ordering::Relaxed), no_color: no_color_env() }
}

/// 지금 쓰는 팔레트 (어두운 배경 · 밝은 배경)
pub fn variant() -> Variant {
    look().theme
}

/// `OXY_TUI_THEME` 값에서 팔레트를 고른다: `light` 만 밝은 배경, 그 밖의 값(예전 `tokyo-night` 포함)은 기본 어두운 배경
pub fn variant_of(name: Option<&str>) -> Variant {
    if name.is_some_and(|v| v.eq_ignore_ascii_case("light")) { Variant::Light } else { Variant::Dark }
}

pub fn palette() -> &'static Palette {
    match variant() {
        Variant::Light => &LIGHT_BG,
        Variant::Dark => &DARK_BG,
    }
}

fn no_color_env() -> bool {
    static OFF: OnceLock<bool> = OnceLock::new();
    *OFF.get_or_init(|| std::env::var_os("NO_COLOR").is_some_and(|v| !v.is_empty()) || std::env::var("TERM").is_ok_and(|v| v == "dumb"))
}

/// `NO_COLOR` 가 있거나 `TERM=dumb` 이면 색을 쓰지 않는다 (굵기 · 반전 · 기호로만 구분한다)
pub fn no_color() -> bool {
    look().no_color
}

pub fn rgb(c: Rgb) -> Color {
    Color::Rgb(c[0], c[1], c[2])
}

/// 글자색 하나 (색을 껐으면 기본색)
fn fg(color: Color) -> Style {
    if no_color() { Style::new() } else { Style::new().fg(color) }
}

/// 강조색
pub fn accent_color() -> Color {
    if no_color() { Color::Reset } else { rgb(palette().light) }
}
/// 게이지의 빈 부분 · 어둡게 깔리는 바탕
pub fn track_color() -> Color {
    if no_color() { Color::Reset } else { rgb(palette().shadow) }
}

/// 문장 · 값: 터미널의 기본 글자색
pub fn text() -> Style {
    Style::new()
}
/// 레이블 · 헤더 · 키: 굵게
pub fn strong() -> Style {
    Style::new().add_modifier(Modifier::BOLD)
}
/// 테두리 · 버전 · 경로 · 선택할 수 없는 레이블
pub fn sub() -> Style {
    fg(rgb(palette().gray))
}
/// 포커스한 행 · 현재 단계
pub fn focus() -> Style {
    fg(accent_color()).add_modifier(Modifier::BOLD)
}
pub fn accent() -> Style {
    fg(accent_color())
}
/// ✓ · (추천)
pub fn ok() -> Style {
    fg(rgb(palette().mid))
}
pub fn warn() -> Style {
    fg(Color::Yellow)
}
/// 위험한 확인 버튼의 강조 글자색: 노랑. 모니터에서 색을 껐으면 기본색
pub fn danger_color() -> Color {
    if no_color() && look().monitor { Color::Reset } else { Color::Yellow }
}
pub fn err() -> Style {
    fg(Color::Red)
}
/// 돌아가는 표시: 강조색
pub fn spinner() -> Style {
    accent()
}
/// 모니터 맨 윗줄 띠: 굵은 글자를 바탕색 위에 (docs/flow-view-spec.md §2). 색을 껐으면 반전 + 굵게
pub fn band() -> Style {
    if no_color() {
        return Style::new().add_modifier(Modifier::REVERSED | Modifier::BOLD);
    }
    let (bg, fg) = match variant() {
        Variant::Light => ([0xA9, 0xCB, 0xA4], [0x1E, 0x2E, 0x28]),
        Variant::Dark => ([0x3A, 0x5A, 0x4D], [0xF1, 0xF7, 0xEE]),
    };
    Style::new().bg(rgb(bg)).fg(rgb(fg)).add_modifier(Modifier::BOLD)
}
/// 모니터에서 고른 줄을 칠하는 법: 반전 (색을 껐을 때도 반전)
pub fn select(style: Style) -> Style {
    style.add_modifier(Modifier::REVERSED)
}
/// 값 열 (현재 값 · 한 줄 설명): 기본 글자색. 레이블은 굵게 써서 굵기로 위계를 나눈다
pub fn value() -> Style {
    Style::new()
}
/// 키 안내의 뜻 · 요약표의 이름: 기본 글자색 (키와 값은 굵게 써서 구분한다)
pub fn hint() -> Style {
    Style::new()
}
/// 팝업 아래에 깔린 화면
pub fn dimmed() -> Style {
    fg(rgb(palette().dark)).remove_modifier(Modifier::BOLD)
}
