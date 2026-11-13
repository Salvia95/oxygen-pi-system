//! 모니터 모드 (docs/monitor-tui-spec.md §3 · §4). psmux 오른쪽 열의 jobs · flow 모니터 화면을 그린다.
//! Node(agent/extensions/oxy-monitor/model.ts)가 보기 모델 전체를 보내고, 여기서는 받은 줄을 그대로 배치해 글 폭에 맞춰 자르기만 한다.
//! 스피너와 경과 시간만 이 프로그램의 시계로 움직인다 (Node 가 1초마다 보내지 않는다). 선택한 줄은 모델의 `selected` 를 따른다.
//!
//! 줄 배치 (model.ts 의 `modelHeight` 와 줄 수가 같아야 한다)
//!   맨 윗줄 띠 1줄(왼쪽 `◆ ` + title, 오른쪽 right. pane 폭 전체를 바탕색으로 칠한다) → nowAt 이 top 이면 지금(now) 줄들 → 가로줄(지금이 있을 때)
//!   → 구역마다 줄 (제목이 있으면 가로줄 안에 `── Current Task ──`, 구역 0 도 같다. 제목 없는 구역 0 은 가로줄이 없다. 제목 없는 다음 구역은 빈 가로줄) → nowAt 이 bottom 이면 가로줄 + 지금 줄들 → 키 안내 줄들
//! 키 안내는 항상 창의 맨 아래에 붙인다 (모델이 창보다 짧아도 아래에 놓인다. 길면 위쪽 줄을 자른다).
//! 줄 모양: `<들여쓰기 칸><prefix(회색)><기호> <글>` + 오른쪽 정렬 right (since 가 있으면 right 대신 경과 m:ss).
//! 줄이 폭을 넘으면 글을 `…` 로 줄이고 right 는 가능한 한 남긴다. 줄이 다음 줄로 넘어가지 않는다.
//! badge 가 있으면 오른쪽 열 바로 앞에 두 칸 띄워 둔다 (`◐ worker: 결제 모듈 수정  셸 1  2:12`). 글을 먼저 줄이고, 그래도 글이 4칸도 안 남으면 badge 를 뺀다.
//! popup 이 있으면 맨 윗줄 띠와 키 안내만 두고 그 사이를 흐리게 한 뒤 가운데에 설치 화면의 확인 팝업(parts::dialog)을 겹쳐 그린다 (draw_popup).
//! 색: emphasis = 강조색 · error = 오류색 · 선택한 줄 = 반전 (색이 없어도 보인다). 한글 문구에 회색을 쓰지 않는다 (가로줄과 · − 기호만 회색).
use std::time::{SystemTime, UNIX_EPOCH};

use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use serde::Deserialize;

use crate::parts::{Button, dialog};
use crate::text::{fit, w, wrap};
use crate::theme;

#[derive(Deserialize, Clone, Default, Debug)]
#[serde(default)]
pub struct MRow {
    /// 고를 수 있는 줄 (선택한 줄은 모델의 selected 와 같은 key)
    pub key: Option<String>,
    /// spinner · todo · done · failed · blocked · stopped · dropped · none
    pub marker: String,
    pub text: String,
    /// 오른쪽 정렬 글 (since 가 있으면 쓰지 않는다)
    pub right: Option<String>,
    /// 경과 시작 시각 (ms epoch). 이 프로그램이 1초마다 m:ss 로 그린다
    pub since: Option<i64>,
    pub indent: usize,
    /// 들여쓰기 다음 · 기호 앞에 회색으로 그리는 트리 바 (`├ ` `└ ` `│ `)
    pub prefix: Option<String>,
    pub emphasis: bool,
    pub error: bool,
    /// 오른쪽 열(경과 · right) 바로 앞에 두 칸 띄워 그리는 짧은 글 (Subagent 구역의 `셸 1`). 줄이 모자라면 글을 먼저 줄이고, 그래도 안 되면 뺀다
    pub badge: Option<String>,
}

/// 중지 확인 같은 팝업. 화면 가운데에 겹쳐 그린다. focus 는 buttons 의 위치
#[derive(Deserialize, Clone, Default, Debug)]
#[serde(default)]
pub struct MPopup {
    pub title: String,
    pub lines: Vec<String>,
    pub buttons: Vec<String>,
    pub focus: usize,
    /// 경고 모양(`! ` · 경고색)으로 그릴 버튼의 위치. 없으면 경고 버튼이 없다 (버튼 이름으로 알아내지 않는다)
    pub danger: Option<usize>,
}

#[derive(Deserialize, Clone, Default, Debug)]
#[serde(default)]
pub struct MSection {
    pub title: Option<String>,
    pub rows: Vec<MRow>,
}

/// `{"op":"monitor", …}` 보기 전체
#[derive(Deserialize, Clone, Default, Debug)]
#[serde(default)]
pub struct MonitorModel {
    /// flow · jobs
    pub kind: String,
    pub title: String,
    pub right: String,
    pub now: Vec<MRow>,
    /// top · bottom
    #[serde(rename = "nowAt")]
    pub now_at: String,
    pub sections: Vec<MSection>,
    pub selected: Option<String>,
    /// 키 안내 줄 (폭에 맞춰 이미 나눈 것)
    pub keys: Vec<String>,
    /// 있으면 화면 가운데에 팝업을 겹쳐 그린다 (아래 화면은 흐리게. 맨 윗줄 띠와 키 안내는 그대로)
    pub popup: Option<MPopup>,
}

/// 지시 한 줄의 결과
pub enum Next {
    Continue,
    /// 끝낸다: 종료 코드와 본 화면에 남길 줄
    Quit(i32, Vec<String>),
}

/// 지시 한 줄을 반영한다. `monitor` 는 보기 전체를 바꾸고(답 없음), `quit` 는 끝낸다
pub fn apply(model: &mut Option<MonitorModel>, line: &str) -> Result<Next, String> {
    let v: serde_json::Value = serde_json::from_str(line).map_err(|e| format!("JSON 이 아닙니다: {e}"))?;
    match v.get("op").and_then(serde_json::Value::as_str).unwrap_or("") {
        "monitor" => {
            *model = Some(serde_json::from_value(v).map_err(|e| e.to_string())?);
            Ok(Next::Continue)
        }
        "quit" => {
            let code = v.get("code").and_then(serde_json::Value::as_i64).unwrap_or(0) as i32;
            let summary = v.get("summary").and_then(serde_json::Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
            Ok(Next::Quit(code, summary))
        }
        other => Err(format!("모르는 지시입니다: {other}")),
    }
}

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// 경과 m:ss (한 시간 넘으면 h:mm:ss). 미래 시각이면 0:00
pub fn clock(ms: i64) -> String {
    let s = (ms.max(0) / 1000) as u64;
    let (h, m, r) = (s / 3600, (s % 3600) / 60, s % 60);
    if h > 0 { format!("{h}:{m:02}:{r:02}") } else { format!("{m}:{r:02}") }
}

fn marker_of(name: &str, frame: usize) -> Option<(&'static str, Style)> {
    Some(match name {
        "spinner" => (theme::SPINNER[frame % theme::SPINNER.len()], theme::spinner()),
        "todo" => ("·", theme::sub()),
        "done" => (theme::OK, theme::ok()),
        "failed" => (theme::ERR, theme::err()),
        "blocked" => (theme::WARN, theme::warn()),
        "stopped" => ("■", Style::new()),
        "dropped" => ("-", theme::sub()),
        _ => return None,
    })
}

fn blank(n: usize) -> Span<'static> {
    Span::raw(" ".repeat(n))
}

/// 왼쪽 글과 오른쪽 글(두 칸 띄운 조각들: 배지 · 경과)을 폭 안에 놓는다. 폭이 모자라면 왼쪽 글을 `…` 로 줄이고,
/// 그래도 왼쪽에 4칸이 남지 않으면 오른쪽 조각을 앞(배지)부터 하나씩 뺀다
fn two_sides(head: Vec<Span<'static>>, head_w: usize, text: &str, text_style: Style, right: Vec<(String, Style)>, width: usize) -> Vec<Span<'static>> {
    let avail = width.saturating_sub(head_w);
    let right: Vec<(String, Style)> = right.into_iter().filter(|(r, _)| !r.is_empty()).collect();
    let right_w = |from: usize| right[from..].iter().map(|(r, _)| w(r)).sum::<usize>() + 2 * right.len().saturating_sub(from + 1);
    let mut spans = head;
    let mut chosen = right.len();
    let mut shown = fit(text, avail);
    for from in 0..right.len() {
        let room = avail.saturating_sub(right_w(from) + 1);
        if room >= 4 || w(text) <= room {
            chosen = from;
            shown = fit(text, room);
            break;
        }
    }
    let used = head_w + w(&shown);
    spans.push(Span::styled(shown, text_style));
    if chosen < right.len() {
        spans.push(blank(width.saturating_sub(used + right_w(chosen))));
        for (i, (r, st)) in right.into_iter().enumerate().skip(chosen) {
            if i > chosen {
                spans.push(blank(2));
            }
            spans.push(Span::styled(r, st));
        }
    }
    spans
}

/// 폭을 넘는 칸을 자른다 (기호와 들여쓰기만으로 폭을 넘는 아주 좁은 창에서)
fn clip(spans: Vec<Span<'static>>, width: usize) -> Vec<Span<'static>> {
    let mut left = width;
    let mut out = Vec::new();
    for s in spans {
        if left == 0 {
            break;
        }
        if w(&s.content) <= left {
            left -= w(&s.content);
            out.push(s);
            continue;
        }
        let mut cut = String::new();
        for ch in s.content.chars() {
            let cw = w(&ch.to_string());
            if cw > left {
                break;
            }
            cut.push(ch);
            left -= cw;
        }
        out.push(Span::styled(cut, s.style));
        break;
    }
    out
}

/// 한 행. selected 면 줄 전체를 칠한다 (`theme::select`: 반전)
fn row_line(r: &MRow, selected: bool, width: usize, frame: usize, now: i64) -> Line<'static> {
    let indent = r.indent.min(width / 2);
    let mut head = Vec::new();
    let mut head_w = indent;
    if indent > 0 {
        head.push(blank(indent));
    }
    if let Some(p) = r.prefix.as_deref().filter(|p| !p.is_empty()) {
        head.push(Span::styled(p.to_string(), theme::sub()));
        head_w += w(p);
    }
    if let Some((sym, st)) = marker_of(&r.marker, frame) {
        head.push(Span::styled(sym, st));
        head.push(blank(1));
        head_w += 2;
    }
    let text_style = if r.error { theme::err() } else if r.emphasis { theme::focus() } else { theme::text() };
    let right_style = if r.error { theme::err() } else if r.emphasis { theme::accent() } else { theme::text() };
    let mut right = Vec::new();
    if let Some(b) = r.badge.as_deref().filter(|b| !b.is_empty()) {
        right.push((b.to_string(), theme::text())); // 한글이라 회색을 쓰지 않는다
    }
    match (r.since, &r.right) {
        (Some(s), _) => right.push((clock(now - s), right_style)),
        (None, Some(t)) => right.push((t.clone(), right_style)),
        _ => {}
    }
    let mut spans = clip(two_sides(head, head_w, &r.text, text_style, right, width), width);
    if selected {
        let used: usize = spans.iter().map(|s| w(&s.content)).sum();
        spans.push(blank(width.saturating_sub(used)));
        for s in &mut spans {
            s.style = theme::select(s.style);
        }
    }
    Line::from(spans)
}

/// 띠 제목 앞의 브랜드 표식 (D2Coding 1칸) 과 그 뒤 빈칸
const BRAND: &str = "◆ ";

/// 띠에 놓을 제목. 표식 2칸을 더해 `제목 + 1 + right` 가 폭을 넘으면 짧은 이름으로 줄인다
/// (Node 가 표식 없이 정한 제목이 22칸까지 들어가므로 23칸에서는 `◆ Flow  Total 2/6` · `◆ Jobs  Processing 1`)
fn band_title(m: &MonitorModel, width: usize) -> String {
    if m.right.is_empty() || w(BRAND) + w(&m.title) + 1 + w(&m.right) <= width {
        return m.title.clone();
    }
    match m.title.as_str() {
        "Flow Monitor" => "Flow".to_string(),
        "Job Monitor" => "Jobs".to_string(),
        t => t.to_string(),
    }
}

/// 맨 윗줄 띠: `◆ ` 와 왼쪽 title, 오른쪽 right 를 한 줄에 놓고 pane 폭 전체를 띠 색(`theme::band`)으로 칠한다
fn title_line(m: &MonitorModel, width: usize) -> Line<'static> {
    let band = theme::band();
    let right = vec![(m.right.clone(), band)];
    let head = vec![Span::styled(BRAND, band)];
    let mut spans = clip(two_sides(head, w(BRAND), &band_title(m, width), band, right, width), width);
    let used: usize = spans.iter().map(|s| w(&s.content)).sum();
    spans.push(blank(width.saturating_sub(used)));
    for s in &mut spans {
        s.style = band;
    }
    Line::from(spans)
}

/// 가로줄. 제목이 있으면 `── 최근 ──` 처럼 그 안에 쓴다 (줄은 폭을 꽉 채운다)
fn rule(title: Option<&str>, width: usize) -> Line<'static> {
    let Some(t) = title.filter(|t| !t.is_empty()) else {
        return Line::from(Span::styled("─".repeat(width), theme::sub()));
    };
    let t = fit(t, width.saturating_sub(5).max(1));
    let tail = width.saturating_sub(4 + w(&t));
    Line::from(vec![Span::styled("── ", theme::sub()), Span::styled(t, theme::strong()), Span::styled(format!(" {}", "─".repeat(tail)), theme::sub())])
}

const KEY_NAMES: [&str; 7] = ["▲▼", "↑↓", "Enter", "Esc", "Tab", "Space", "←→"];

/// 키 안내 한 줄: `키 뜻  키 뜻` 에서 키 이름만 굵게 (키가 아닌 문장은 그대로)
fn key_line(s: &str, width: usize) -> Line<'static> {
    let s = fit(s, width);
    let mut spans: Vec<Span<'static>> = Vec::new();
    for (i, token) in s.split("  ").enumerate() {
        if i > 0 {
            spans.push(blank(2));
        }
        match token.split_once(' ') {
            Some((k, rest)) if KEY_NAMES.contains(&k) || (k.chars().count() == 1 && k.is_ascii()) => {
                spans.push(Span::styled(k.to_string(), theme::strong()));
                spans.push(Span::raw(format!(" {rest}")));
            }
            _ => spans.push(Span::raw(token.to_string())),
        }
    }
    Line::from(spans)
}

/// 모델을 줄로 나눈다: (위에서부터 쌓는 본문, 키 안내 바로 위에 붙이는 줄, 키 안내).
/// 붙이는 줄은 nowAt 이 bottom 일 때의 `가로줄 + 지금`이다. 세 묶음의 줄 수 합이 model.ts 의 `modelHeight` 다
pub fn layout(m: &MonitorModel, width: usize, frame: usize, now: i64) -> (Vec<Line<'static>>, Vec<Line<'static>>, Vec<Line<'static>>) {
    let width = width.max(1);
    let sel = m.selected.as_deref();
    let row = |r: &MRow| row_line(r, sel.is_some() && r.key.as_deref() == sel, width, frame, now);
    let mut body = vec![title_line(m, width)];
    let mut pinned = Vec::new();
    let top = m.now_at != "bottom";
    if top && !m.now.is_empty() {
        body.extend(m.now.iter().map(row));
        body.push(rule(None, width));
    }
    for (i, s) in m.sections.iter().enumerate() {
        // 제목이 있는 구역은 구역 0 도 가로줄 안에 제목을 쓴다. 제목 없는 구역 0 은 줄이 없다 (jobs 의 목록)
        if i > 0 || s.title.as_deref().is_some_and(|t| !t.is_empty()) {
            body.push(rule(s.title.as_deref(), width));
        }
        body.extend(s.rows.iter().map(row));
    }
    if !top && !m.now.is_empty() {
        pinned.push(rule(None, width));
        pinned.extend(m.now.iter().map(row));
    }
    (body, pinned, m.keys.iter().map(|k| key_line(k, width)).collect())
}

/// 모델을 줄로 만든다: (본문 + 붙이는 줄, 키 안내). 창 높이를 모를 때의 순서대로의 줄이다
pub fn lines(m: &MonitorModel, width: usize, frame: usize, now: i64) -> (Vec<Line<'static>>, Vec<Line<'static>>) {
    let (mut body, pinned, keys) = layout(m, width, frame, now);
    body.extend(pinned);
    (body, keys)
}

/// 창에 그린다. 키 안내는 맨 아래, 그 바로 위에 붙이는 줄(jobs 의 지금), 남는 위쪽에 본문. 목록이 짧으면 빈 줄은 목록과 가로줄 사이에 생긴다.
/// 창이 모자라면 본문의 아래쪽부터 자른다
pub fn render(f: &mut Frame, m: &MonitorModel, frame: usize, now: i64) {
    let area = f.area();
    let height = area.height as usize;
    let (mut body, mut pinned, mut keys) = layout(m, area.width as usize, frame, now);
    let skip = keys.len().saturating_sub(height);
    keys.drain(..skip);
    let mut room = height - keys.len();
    let skip = pinned.len().saturating_sub(room);
    pinned.drain(..skip);
    room -= pinned.len();
    body.truncate(room);
    let draw = |f: &mut Frame, lines: Vec<Line<'static>>, y: usize| {
        let h = lines.len() as u16;
        f.render_widget(Paragraph::new(lines), Rect::new(area.x, area.y + y as u16, area.width, h));
    };
    let keys_at = height - keys.len();
    let pinned_at = keys_at - pinned.len();
    draw(f, body, 0);
    draw(f, pinned, pinned_at);
    draw(f, keys, keys_at);
    if let Some(p) = m.popup.as_ref().filter(|p| !p.buttons.is_empty()) {
        draw_popup(f, p, area, keys_at as u16 + area.y);
    }
}

/// 중지 확인 팝업 (설치 화면의 확인 팝업과 같은 모양: `parts::dialog`). 맨 윗줄 띠와 키 안내는 그대로 두고 그 사이를 흐리게 한 뒤 가운데에 겹쳐 그린다.
/// 본문은 팝업 안 폭에 맞춰 줄바꿈하고, 높이가 모자라면 본문과 버튼 사이의 빈 줄 → 맨 윗줄 띠를 덮는 한 줄 → 본문 끝(`…`) 순으로 줄인다. 버튼은 늘 남는다.
/// keys_y: 키 안내가 시작하는 줄 (창 기준)
fn draw_popup(f: &mut Frame, p: &MPopup, area: Rect, keys_y: u16) {
    let body = Rect::new(area.x, area.y + 1, area.width, keys_y.saturating_sub(area.y + 1));
    let full = Rect::new(area.x, area.y, area.width, keys_y.saturating_sub(area.y));
    f.buffer_mut().set_style(body, theme::dimmed());
    let width = area.width.saturating_sub(2).clamp(1, 70);
    let iw = (width.saturating_sub(4) as usize).max(4);
    let mut text: Vec<Line<'static>> = Vec::new();
    for (i, l) in p.lines.iter().enumerate() {
        for part in wrap(l, iw) {
            text.push(if i == 0 { Line::styled(part, theme::strong()) } else { Line::raw(part) });
        }
    }
    // (자리, 빈 줄을 둘지) 를 위에서부터 시도한다. 줄 수 = 본문 + 빈 줄 + 버튼 줄 + 테두리 2
    let tries = [(body, true), (body, false), (full, true), (full, false)];
    let (place, spacer) = tries.into_iter().find(|(r, sp)| text.len() + usize::from(*sp) + 3 <= r.height as usize).unwrap_or((full, false));
    let room = (place.height as usize).saturating_sub(3);
    if text.len() > room {
        text.truncate(room.saturating_sub(1));
        if room > 0 {
            text.push(Line::raw("…"));
        }
    }
    if spacer {
        text.push(Line::raw(""));
    }
    let buttons: Vec<Button> = p.buttons.iter().enumerate().map(|(i, b)| Button { label: b, on: i == p.focus, danger: p.danger == Some(i) }).collect();
    dialog(f, place, width, &p.title, text, &buttons, p.danger.is_some_and(|d| d < buttons.len()));
}

/// 화면을 글자로 (시험 · 터미널이 아닌 곳에서의 데모). 세로로 height 줄, 가로는 줄마다 오른쪽 공백을 뗀다
pub fn dump(m: &MonitorModel, width: u16, height: u16, frame: usize, now: i64) -> Vec<String> {
    use ratatui::Terminal;
    use ratatui::backend::TestBackend;
    let mut term = Terminal::new(TestBackend::new(width, height)).expect("TestBackend");
    term.draw(|f| render(f, m, frame, now)).expect("draw");
    let buf = term.backend().buffer().clone();
    (0..height)
        .map(|y| {
            let mut row = String::new();
            let mut x = 0;
            while x < width {
                let sym = buf[(x, y)].symbol();
                row.push_str(sym);
                x += w(sym).max(1) as u16; // 2칸 글자 뒤의 빈 칸은 건너뛴다
            }
            row.trim_end().to_string()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::spinner_frame;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;
    use std::path::PathBuf;

    const NOW: i64 = 1_763_000_000_000;

    fn line_text(l: &Line) -> String {
        l.spans.iter().map(|s| s.content.as_ref()).collect()
    }
    /// 맨 윗줄이 `◆ ` 와 모델의 제목(좁으면 짧은 이름)으로 시작하는가
    fn band_starts(row: &str, m: &MonitorModel) -> bool {
        row.starts_with("◆ ") && row.contains(m.title.split(' ').next().unwrap_or(""))
    }
    fn reversed(l: &Line) -> bool {
        !l.spans.is_empty() && l.spans.iter().all(|s| s.style.add_modifier.contains(Modifier::REVERSED))
    }
    fn dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/monitor")
    }
    fn index() -> serde_json::Value {
        let p = dir().join("index.json");
        let s = std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {e} (node tests/monitor-fixtures.mjs 로 만든다)", p.display()));
        serde_json::from_str(&s).unwrap()
    }
    /// model.ts 가 만든 예시 모델: (이름, 폭, 높이, model.ts 의 modelHeight, 모델)
    fn fixtures() -> (i64, Vec<(String, u16, u16, usize, MonitorModel)>) {
        let idx = index();
        let at = idx["generatedAt"].as_i64().unwrap();
        let mut out = Vec::new();
        for f in idx["files"].as_array().unwrap() {
            let name = f["file"].as_str().unwrap().to_string();
            let s = std::fs::read_to_string(dir().join(&name)).unwrap();
            let m: MonitorModel = serde_json::from_str(&s).unwrap_or_else(|e| panic!("{name}: {e}"));
            out.push((name, f["width"].as_u64().unwrap() as u16, f["height"].as_u64().unwrap() as u16, f["modelHeight"].as_u64().unwrap() as usize, m));
        }
        assert!(!out.is_empty());
        (at, out)
    }
    fn all_rows(m: &MonitorModel) -> Vec<&MRow> {
        m.now.iter().chain(m.sections.iter().flat_map(|s| s.rows.iter())).collect()
    }

    #[test]
    fn every_fixture_fits_the_width_and_has_the_height_model_ts_computed() {
        let (at, fx) = fixtures();
        for (name, width, height, model_h, m) in &fx {
            for frame in [0, 3, 9] {
                let (body, keys) = lines(m, *width as usize, frame, at + 5_000);
                for l in body.iter().chain(keys.iter()) {
                    assert!(w(&line_text(l)) <= *width as usize, "{name}: {}칸 넘음: {}", width, line_text(l));
                }
                assert_eq!(body.len() + keys.len(), *model_h, "{name}: 그린 줄 수와 modelHeight");
                assert!(*model_h <= *height as usize, "{name}: 모델이 창보다 큼");
            }
            // 실제 버퍼에 그려서도 키 안내는 맨 아래, 제목은 맨 위
            let rows = dump(m, *width, *height, 0, at + 5_000);
            assert_eq!(rows.len(), *height as usize);
            // 팝업이 모자란 높이에서 맨 윗줄 띠를 덮을 수는 있다 (popup 시험이 따로 본다)
            assert!(m.popup.is_some() || band_starts(&rows[0], m), "{name}: {}", rows[0]);
            let last_key = m.keys.last().unwrap();
            assert_eq!(rows.last().unwrap().trim_start(), last_key.trim_start(), "{name}");
            assert!(rows.iter().all(|r| w(r) <= *width as usize), "{name}");
        }
    }

    #[test]
    fn fixtures_cover_the_sizes_in_the_spec() {
        let (_, fx) = fixtures();
        for want in ["flow-23x12", "jobs-23x12", "flow-35x28", "jobs-35x28"] {
            assert!(fx.iter().any(|(n, ..)| n.starts_with(want)), "{want} 예시 모델이 없다");
        }
    }

    #[test]
    fn selected_row_is_reversed_and_only_that_row() {
        let (at, fx) = fixtures();
        for (name, width, _, _, m) in &fx {
            let Some(sel) = &m.selected else { continue };
            let (body, _) = lines(m, *width as usize, 0, at);
            let hit: Vec<&Line> = body.iter().filter(|l| reversed(l)).collect();
            assert_eq!(hit.len(), 1, "{name}: 반전된 줄은 선택한 줄 하나");
            let row = all_rows(m).into_iter().find(|r| r.key.as_deref() == Some(sel.as_str())).unwrap_or_else(|| panic!("{name}: selected {sel} 줄이 없다"));
            let head: String = row.text.chars().take(3).collect();
            assert!(line_text(hit[0]).contains(&head), "{name}: {} / {head}", line_text(hit[0]));
            assert_eq!(w(&line_text(hit[0])), *width as usize, "{name}: 선택한 줄은 폭 전체를 반전한다");
        }
    }

    #[test]
    fn spinner_marker_is_a_d2coding_circle_that_changes_every_150ms() {
        let (at, fx) = fixtures();
        let mut seen = std::collections::HashSet::new();
        let circles = ['◐', '◓', '◑', '◒'];
        for (name, width, _, _, m) in &fx {
            let spinners = all_rows(m).into_iter().filter(|r| r.marker == "spinner").count();
            for frame in 0..8 {
                let (body, _) = lines(m, *width as usize, frame, at);
                // 띠의 브랜드 표식 ◆ 는 돌아가는 표시가 아니다. 줄 맨 앞(들여쓰기 · 가지 기호 다음)의 원 기호만 센다
                let glyphs: Vec<char> = body.iter().map(line_text).filter_map(|t| t.trim_start_matches(|c: char| c == ' ' || "├└│".contains(c)).chars().next()).filter(|c| circles.contains(c)).collect();
                assert_eq!(glyphs.len(), spinners, "{name}: spinner 줄마다 원 기호 하나");
                assert!(glyphs.iter().all(|g| theme::SPINNER.contains(&g.to_string().as_str())));
                seen.extend(glyphs);
            }
        }
        assert_eq!(seen.len(), theme::SPINNER.len(), "4프레임이 모두 다르다");
        assert_eq!(theme::SPINNER, ["◐", "◓", "◑", "◒"]);
        assert_eq!((spinner_frame(0), spinner_frame(149), spinner_frame(150), spinner_frame(599), spinner_frame(600)), (0, 0, 1, 3, 0));
    }

    #[test]
    fn since_rows_show_elapsed_on_the_right_and_it_ticks() {
        let (at, fx) = fixtures();
        let mut checked = 0;
        for (name, width, _, _, m) in &fx {
            for dt in [0, 7_000, 61_000] {
                let now = at + dt;
                let (body, _) = lines(m, *width as usize, 0, now);
                let texts: Vec<String> = body.iter().map(line_text).collect();
                for r in all_rows(m).into_iter().filter(|r| r.since.is_some()) {
                    let want = clock(now - r.since.unwrap());
                    // 글이 줄어도 경과는 남는다: 경과로 끝나는 줄 중 이 행의 앞부분을 가진 줄
                    let head: String = r.text.chars().take(2).collect();
                    let l = texts.iter().find(|t| t.contains(&head) && t.ends_with(&want)).unwrap_or_else(|| panic!("{name}: {} 행 오른쪽에 {want} 가 없다\n{}", r.text, texts.join("\n")));
                    assert_eq!(w(l), *width as usize, "{name}: 경과는 오른쪽 끝에 붙는다");
                    checked += 1;
                }
            }
        }
        assert!(checked > 0);
        assert_eq!((clock(0), clock(59_999), clock(61_000), clock(3_723_000), clock(-5)), ("0:00".into(), "0:59".into(), "1:01".into(), "1:02:03".into(), "0:00".into()));
    }

    #[test]
    fn section_title_sits_inside_the_rule() {
        let (at, fx) = fixtures();
        let mut seen = 0;
        for (name, width, _, _, m) in &fx {
            let (body, _) = lines(m, *width as usize, 0, at);
            // 구역 0 의 제목도 같은 가로줄이다 (한 줄이라 줄 수는 그대로)
            for s in m.sections.iter().filter(|s| s.title.is_some()) {
                let t = s.title.as_deref().unwrap();
                let l = body.iter().map(line_text).find(|l| l.starts_with(&format!("── {t} "))).unwrap_or_else(|| panic!("{name}: `── {t} ──` 줄이 없다"));
                assert!(l.ends_with('─') && w(&l) == *width as usize, "{name}: {l}");
                seen += 1;
            }
            // 제목 없는 구역 사이는 폭을 채운 가로줄
            let plain = "─".repeat(*width as usize);
            let rules = body.iter().map(line_text).filter(|l| *l == plain).count();
            let expected = usize::from(!m.now.is_empty()) + m.sections.iter().skip(1).filter(|s| s.title.is_none()).count();
            assert_eq!(rules, expected, "{name}: 가로줄 수");
        }
        assert!(seen >= 2, "구역 제목이 있는 예시 모델이 flow 에 있어야 한다");
        // flow 는 구역 0 이 Current Task, 다음이 Overall Task 다 (flow-view-spec §2)
        for (name, width, _, _, m) in fx.iter().filter(|(n, ..)| n.starts_with("flow-")) {
            // 끝난 Flow 가 있으면 셋째 구역 Completed Flow (docs/flow-rollback-spec.md §3, Before Commit Task 를 대신함)
            let titles: Vec<_> = m.sections.iter().map(|s| s.title.as_deref()).collect();
            assert!(titles == [Some("Current Task"), Some("Overall Flow")] || titles == [Some("Current Task"), Some("Overall Flow"), Some("Completed Flow")], "{name}: {titles:?}");
            let (body, _) = lines(m, *width as usize, 0, at);
            assert_eq!(line_text(&body[1]), format!("── Current Task {}", "─".repeat(*width as usize - 16)), "{name}: 맨 윗줄 바로 아래가 구역 0 가로줄");
        }
        // jobs 의 목록은 Main Background · Subagent 두 구역이고, subagent 화면은 `<agent>: <일>` 한 구역이다 (jobs-view-spec §2)
        for (name, width, _, _, m) in fx.iter().filter(|(n, ..)| n.starts_with("jobs-")) {
            let titles: Vec<_> = m.sections.iter().map(|s| s.title.as_deref()).collect();
            if name.starts_with("jobs-sub-") {
                assert!(titles.len() == 1 && titles[0].is_some_and(|t| t.starts_with("scout: ")), "{name}: {titles:?}");
            } else {
                assert_eq!(titles, [Some("Main Background"), Some("Subagent")], "{name}");
            }
            let (body, _) = lines(m, *width as usize, 0, at);
            assert!(line_text(&body[1]).starts_with("── "), "{name}: 맨 윗줄 바로 아래가 구역 0 가로줄");
        }
    }

    #[test]
    fn now_goes_on_top_for_flow_and_at_the_bottom_for_jobs() {
        let (at, fx) = fixtures();
        for (name, width, _, _, m) in &fx {
            let (body, keys) = lines(m, *width as usize, 0, at);
            let texts: Vec<String> = body.iter().map(line_text).collect();
            // 새 flow 모델은 지금(now) 줄이 없다 (구역 Current Task 가 대신한다)
            let Some(first_now) = m.now.first().map(|r| r.text.chars().take(2).collect::<String>()) else {
                assert!(m.kind == "flow" && !texts.iter().any(|t| *t == "─".repeat(*width as usize)), "{name}");
                continue;
            };
            let pos = texts.iter().position(|t| t.contains(&first_now)).unwrap();
            let rule_at = texts.iter().position(|t| *t == "─".repeat(*width as usize)).unwrap();
            if m.now_at == "top" {
                assert!(pos == 1 && rule_at == 1 + m.now.len(), "{name}: 지금은 제목 바로 아래, 그 아래 가로줄");
            } else {
                assert_eq!(body.len(), rule_at + 1 + m.now.len(), "{name}: 가로줄 + 지금이 본문의 맨 끝(키 안내 앞)에 온다");
            }
            assert!(!keys.is_empty());
        }
    }

    fn row(marker: &str, text: &str, right: Option<&str>, indent: usize) -> MRow {
        MRow { marker: marker.into(), text: text.into(), right: right.map(String::from), indent, ..MRow::default() }
    }

    #[test]
    fn row_shape_markers_indent_and_right_alignment() {
        let l = |r: &MRow, width| line_text(&row_line(r, false, width, 0, NOW));
        assert_eq!(l(&row("done", "p1 로그인", Some("n1"), 0), 20), "✓ p1 로그인       n1");
        assert_eq!(l(&row("done", "p1.1", None, 2), 20), "  ✓ p1.1");
        assert_eq!(l(&row("none", "bash npm test", None, 2), 20), "  bash npm test");
        assert_eq!(l(&row("none", "작업 기록이 없습니다.", None, 0), 30), "작업 기록이 없습니다.");
        for (m, sym) in [("todo", "·"), ("done", "✓"), ("failed", "×"), ("blocked", "!"), ("stopped", "■"), ("dropped", "-")] {
            assert_eq!(l(&row(m, "x", None, 0), 10), format!("{sym} x"));
        }
        assert!(l(&row("spinner", "x", None, 0), 10).starts_with(theme::SPINNER[0]));
        let spin = MRow { since: Some(NOW - 12_000), ..row("spinner", "도구 실행 중", Some("무시"), 0) };
        assert_eq!(line_text(&row_line(&spin, false, 23, 0, NOW)), "◐ 도구 실행 중     0:12");
    }

    #[test]
    fn long_text_is_cut_with_an_ellipsis_and_the_right_side_stays() {
        let r = row("done", "p1.2 아주 긴 할 일 이름이 폭을 넘습니다", Some("n2 n3"), 2);
        let t = line_text(&row_line(&r, false, 23, 0, NOW));
        assert!(w(&t) <= 23 && t.contains('…') && t.ends_with("n2 n3"), "{t}");
        // 남는 칸이 4칸 미만이면 오른쪽 글을 버리고 왼쪽 글을 지킨다
        let r = row("done", "p1.2 아주 긴 할 일 이름", Some("n2 n3 n4 n5 n6 n7"), 2);
        let t = line_text(&row_line(&r, false, 23, 0, NOW));
        assert!(w(&t) <= 23 && t.contains("p1.2") && !t.contains("n7"), "{t}");
        // 경로는 가운데를 줄인다 (text::fit 규칙)
        let r = row("done", r"read C:\Users\kim\project\src\components\payment\Checkout.tsx", None, 0);
        let t = line_text(&row_line(&r, false, 23, 0, NOW));
        assert!(w(&t) <= 23 && t.starts_with("✓ read ") && t.ends_with(r"\Checkout.tsx") && t.contains('…'), "{t}");
        // 아주 좁은 폭에서도 넘지 않는다
        for width in [1, 2, 3, 5, 8] {
            let t = line_text(&row_line(&r, false, width, 0, NOW));
            assert!(w(&t) <= width, "{width}: {t}");
        }
        let deep = MRow { indent: 40, ..row("done", "깊은 들여쓰기", Some("n1"), 40) };
        assert!(w(&line_text(&row_line(&deep, false, 23, 0, NOW))) <= 23);
    }

    #[test]
    fn styles_emphasis_error_and_selection() {
        let st = |r: &MRow, sel| row_line(r, sel, 20, 0, NOW);
        let emph = MRow { emphasis: true, ..row("spinner", "진행", None, 0) };
        assert!(st(&emph, false).spans.iter().any(|s| s.content == "진행" && s.style == theme::focus()));
        let err = MRow { error: true, ..row("failed", "실패", Some("1"), 0) };
        let l = st(&err, false);
        assert!(l.spans.iter().filter(|s| s.content != " " && !s.content.trim().is_empty()).all(|s| s.style == theme::err()));
        assert!(!l.spans.iter().any(|s| s.style.add_modifier.contains(Modifier::REVERSED)));
        let plain = row("done", "보통", None, 0);
        assert!(st(&plain, false).spans.iter().find(|s| s.content == "보통").unwrap().style == theme::text());
        assert!(reversed(&st(&plain, true)));
        // 한글 문구에 회색(sub)을 쓰지 않는다: 회색은 · − 기호와 가로줄뿐
        for m in ["done", "failed", "todo", "dropped", "none"].into_iter().filter(|_| !theme::no_color()) {
            let l = row_line(&row(m, "한글 문구", Some("오른쪽"), 0), false, 30, 0, NOW);
            assert!(l.spans.iter().filter(|s| s.content.contains("한글") || s.content.contains("오른쪽")).all(|s| s.style != theme::sub()), "{m}");
        }
    }

    #[test]
    fn key_lines_bold_only_key_names() {
        let l = key_line("▲▼ 이동  Enter 펼치기  q 닫기", 40);
        let bold: Vec<&str> = l.spans.iter().filter(|s| s.style.add_modifier.contains(Modifier::BOLD)).map(|s| s.content.as_ref()).collect();
        assert_eq!(bold, ["▲▼", "Enter", "q"]);
        assert_eq!(line_text(&l), "▲▼ 이동  Enter 펼치기  q 닫기");
        let q = key_line("job-2 작업을 중지할까요?  s 중지  Esc 취소", 80);
        assert!(!q.spans[0].style.add_modifier.contains(Modifier::BOLD));
        assert!(w(&line_text(&key_line("▲▼ 이동  Enter 펼치기  q 닫기", 10))) <= 10);
    }

    #[test]
    fn jobs_now_row_sits_right_above_the_keys_and_the_areas_fill_the_window() {
        let (at, fx) = fixtures();
        let mut seen = 0;
        for (name, width, height, model_h, m) in fx.iter().filter(|(n, ..)| n.starts_with("jobs-")) {
            // 새 jobs 모델은 영역이 빈 줄로 창을 채운다: 모델 높이 = 창 높이
            assert_eq!((m.now_at.as_str(), *model_h), ("bottom", *height as usize), "{name}");
            let rows = dump(m, *width, *height, 0, at);
            let h = *height as usize;
            // 맨 아래 = 키 안내, 그 위 = 지금 줄들, 그 위 = 가로줄 (팝업이 있어도 이 줄들은 그대로)
            assert_eq!(rows[h - 1].trim_start(), m.keys.last().unwrap().trim_start(), "{name}");
            if m.popup.is_some() {
                seen += 1; // 팝업이 지금 줄을 덮을 수 있다 (11줄 pane): popup 시험이 따로 본다
                continue;
            }
            let now_first = h - m.keys.len() - m.now.len();
            assert_eq!(rows[now_first - 1], "─".repeat(*width as usize), "{name}: 가로줄이 지금 바로 위");
            let head: String = m.now[0].text.chars().take(2).collect();
            assert!(rows[now_first].contains(&head), "{name}: {}", rows[now_first]);
            seen += 1;
        }
        assert_eq!(seen, 15);
        // flow(지금이 위)는 그대로: 빈 줄이 가로줄 아래가 아니라 본문과 키 안내 사이에 생긴다
        let (_, _, _, _, f) = fx.iter().find(|(n, ..)| n.starts_with("flow-23x12")).unwrap();
        let rows = dump(f, 23, 16, 0, at);
        assert!(!rows[1 + f.now.len() + 1].is_empty() && rows[15 - f.keys.len()].is_empty());
    }

    #[test]
    fn render_pins_the_keys_to_the_bottom_and_clips_a_too_tall_model() {
        let (at, fx) = fixtures();
        let (_, _, _, _, m) = fx.iter().find(|(n, ..)| n.starts_with("flow-23x12")).unwrap();
        // 창이 모델보다 높으면 키 안내가 맨 아래에 붙고 사이는 비어 있다
        let rows = dump(m, 23, 16, 0, at);
        assert_eq!(rows.last().unwrap().trim_start(), m.keys.last().unwrap().trim_start());
        assert!(rows.iter().filter(|r| r.is_empty()).count() >= 4);
        // 창이 모델보다 낮으면 본문 아래쪽을 자르고 키 안내는 남긴다
        let rows = dump(m, 23, 8, 0, at);
        assert_eq!((rows.len(), band_starts(&rows[0], m)), (8, true));
        assert_eq!(rows.last().unwrap().trim_start(), m.keys.last().unwrap().trim_start());
        // 아주 작은 창에서도 panic 하지 않는다
        for (cw, ch) in [(1, 1), (5, 2), (23, 1)] {
            let mut term = Terminal::new(TestBackend::new(cw, ch)).unwrap();
            term.draw(|f| render(f, m, 0, at)).unwrap();
        }
    }

    use crate::theme::{Look, Variant, with_look};
    use ratatui::style::{Color, Modifier};

    fn look(theme: Variant, no_color: bool) -> Look {
        Look { theme, monitor: true, no_color }
    }
    fn c(hex: u32) -> Color {
        Color::Rgb((hex >> 16) as u8, (hex >> 8) as u8, hex as u8)
    }
    fn style_of<'a>(l: &'a Line, text: &str) -> &'a Style {
        &l.spans.iter().find(|s| s.content == text).unwrap_or_else(|| panic!("{text} 칸이 없다: {:?}", l.spans)).style
    }

    #[test]
    fn prefix_goes_between_the_indent_and_the_marker_in_grey_and_counts_in_the_width() {
        with_look(look(Variant::Dark, false), || {
            let r = MRow { prefix: Some("├ ".into()), ..row("done", "라우트", Some("3:10"), 0) };
            let l = row_line(&r, false, 20, 0, NOW);
            assert_eq!(line_text(&l), "├ ✓ 라우트      3:10");
            assert_eq!(*style_of(&l, "├ "), theme::sub());
            assert_ne!(*style_of(&l, "✓"), theme::sub());
            // 들여쓰기가 있으면 그 다음에 온다. 폭 계산에 들어가 긴 글은 그만큼 더 줄어든다
            let r = MRow { prefix: Some("│ ".into()), ..row("none", "결정: 아주 긴 결정 문장이 폭을 넘습니다", None, 2) };
            let t = line_text(&row_line(&r, false, 20, 0, NOW));
            assert!(t.starts_with("  │ ") && w(&t) <= 20 && t.contains('…'), "{t}");
            // 고른 줄이면 prefix 도 줄 전체와 같이 칠해진다
            let l = row_line(&MRow { prefix: Some("└ ".into()), ..row("todo", "x", None, 0) }, true, 12, 0, NOW);
            assert!(reversed(&l) && w(&line_text(&l)) == 12);
        });
    }

    #[test]
    fn title_band_fills_the_pane_in_each_palette_and_inverts_without_color() {
        let m = MonitorModel { title: "Flow Monitor".into(), right: "Total 2/6".into(), ..MonitorModel::default() };
        for (v, bg, fg) in [(Variant::Dark, 0x3A5A4D, 0xF1F7EE), (Variant::Light, 0xA9CBA4, 0x1E2E28)] {
            with_look(look(v, false), || {
                for width in [23, 35, 5] {
                    let l = title_line(&m, width);
                    assert_eq!(w(&line_text(&l)), width, "{v:?} {width}: 띠는 폭 전체");
                    for s in &l.spans {
                        assert_eq!((s.style.bg, s.style.fg), (Some(c(bg)), Some(c(fg))), "{v:?}: {:?}", s.content);
                        assert!(s.style.add_modifier.contains(Modifier::BOLD) && !s.style.add_modifier.contains(Modifier::REVERSED));
                    }
                }
                let l = title_line(&m, 35);
                assert!(line_text(&l).starts_with("◆ Flow Monitor") && line_text(&l).ends_with("Total 2/6"));
            });
        }
        with_look(look(Variant::Dark, true), || {
            let l = title_line(&m, 23);
            assert_eq!(w(&line_text(&l)), 23);
            assert!(l.spans.iter().all(|s| s.style.add_modifier.contains(Modifier::REVERSED | Modifier::BOLD) && s.style.bg.is_none() && s.style.fg.is_none()));
        });
        // 오른쪽 글이 없어도 띠는 폭 전체
        with_look(look(Variant::Dark, false), || {
            let l = title_line(&MonitorModel { title: "jobs".into(), ..MonitorModel::default() }, 23);
            assert_eq!((w(&line_text(&l)), l.spans.iter().all(|s| s.style.bg == Some(c(0x3A5A4D)))), (23, true));
        });
        // 맨 윗줄은 layout 의 첫 줄이다 (flow · jobs 공통)
        let (at, fx) = fixtures();
        with_look(look(Variant::Dark, false), || {
            for (name, width, _, _, m) in &fx {
                let (body, _) = lines(m, *width as usize, 0, at);
                assert!(body[0].spans.iter().all(|s| s.style.bg == Some(c(0x3A5A4D))), "{name}");
                assert!(body[1..].iter().all(|l| l.spans.iter().all(|s| s.style.bg.is_none())), "{name}: 띠는 맨 윗줄뿐");
            }
        });
    }

    #[test]
    fn band_title_starts_with_the_brand_mark_and_shortens_by_the_two_extra_cells() {
        let t = |title: &str, right: &str, width| line_text(&title_line(&MonitorModel { title: title.into(), right: right.into(), ..MonitorModel::default() }, width));
        with_look(look(Variant::Dark, false), || {
            // 넓으면 전체 이름, 표식 2칸을 더해 `제목 + 1 + right` 가 폭에 안 들어가면 짧은 이름
            assert_eq!(t("Flow Monitor", "Total 2/6", 35), format!("◆ Flow Monitor{}Total 2/6", " ".repeat(12)));
            assert_eq!(t("Flow Monitor", "Total 2/6", 24), "◆ Flow Monitor Total 2/6");
            assert_eq!(t("Flow Monitor", "Total 2/6", 23), format!("◆ Flow{}Total 2/6", " ".repeat(8)));
            assert_eq!(t("Job Monitor", "Processing 1", 35), format!("◆ Job Monitor{}Processing 1", " ".repeat(10)));
            assert_eq!(t("Job Monitor", "Processing 1", 26), "◆ Job Monitor Processing 1");
            assert_eq!(t("Job Monitor", "Processing 1", 23), format!("◆ Jobs{}Processing 1", " ".repeat(5)));
            // 오른쪽 글이 없으면 그대로, Node 가 이미 줄인 이름도 그대로
            assert_eq!(t("Job Monitor", "", 23), format!("◆ Job Monitor{}", " ".repeat(10)));
            assert_eq!(t("Jobs", "Processing 1", 23), format!("◆ Jobs{}Processing 1", " ".repeat(5)));
            // 그 밖의 제목(로그 화면)은 줄이지 않고 `…` 로 자른다
            assert_eq!(w(&t("scout: 아주 긴 작업 이름 로그", "running", 23)), 23);
            assert!(t("scout: 아주 긴 작업 이름 로그", "running", 23).starts_with("◆ scout") && t("scout: 아주 긴 작업 이름 로그", "running", 23).contains('…'));
        });
    }

    #[test]
    fn default_and_light_palettes_color_the_monitor_and_select_by_inverting() {
        for v in [Variant::Dark, Variant::Light] {
            with_look(look(v, false), || {
                let l = |m: &str, text: &str| row_line(&row(m, text, None, 0), false, 20, 3, NOW);
                let p = theme::palette();
                // 돌아가는 표시 = 강조색, 완료 = mid, 경고 · 실패 = 노랑 · 빨강, 흐린 것 = gray
                assert_eq!(style_of(&l("spinner", "진행"), theme::SPINNER[3]).fg, Some(theme::rgb(p.light)), "{v:?}");
                assert_eq!(style_of(&l("done", "완료"), "✓").fg, Some(theme::rgb(p.mid)), "{v:?}");
                assert_eq!(style_of(&l("blocked", "주의"), "!").fg, Some(Color::Yellow), "{v:?}");
                assert_eq!(style_of(&l("failed", "실패"), "×").fg, Some(Color::Red), "{v:?}");
                assert_eq!(style_of(&l("todo", "할 일"), "·").fg, Some(theme::rgb(p.gray)), "{v:?}");
                // 가로줄과 prefix 는 gray, 한글 문구는 gray 가 아니다
                let rl = rule(Some("Current Task"), 20);
                assert_eq!((rl.spans[0].style.fg, rl.spans[2].style.fg), (Some(theme::rgb(p.gray)), Some(theme::rgb(p.gray))), "{v:?}");
                let pr = MRow { prefix: Some("├ ".into()), ..row("done", "한글 문구", Some("오른쪽"), 0) };
                let pl = row_line(&pr, false, 30, 0, NOW);
                assert!(pl.spans.iter().filter(|s| s.content.contains("한글") || s.content.contains("오른쪽")).all(|s| s.style.fg != Some(theme::rgb(p.gray))), "{v:?}");
                // 고른 줄은 바탕색이 아니라 반전, 줄 전체
                let sel = row_line(&row("done", "고른 줄", None, 0), true, 20, 0, NOW);
                assert!(reversed(&sel) && w(&line_text(&sel)) == 20 && sel.spans.iter().all(|s| s.style.bg.is_none()), "{v:?}");
                // 고르지 않은 줄에는 반전이 없다
                assert!(!reversed(&l("done", "x")), "{v:?}");
            });
        }
        // 색을 끄면 반전과 기호만 남는다
        with_look(look(Variant::Dark, true), || {
            let sel = row_line(&row("done", "고른 줄", None, 0), true, 20, 0, NOW);
            assert!(reversed(&sel) && sel.spans.iter().all(|s| s.style.bg.is_none() && s.style.fg.is_none()));
        });
    }

    #[test]
    fn theme_names_pick_dark_or_light_and_the_removed_tokyo_night_falls_back_to_dark() {
        for (name, want) in [(None, Variant::Dark), (Some("light"), Variant::Light), (Some("LIGHT"), Variant::Light), (Some("dark"), Variant::Dark), (Some("tokyo-night"), Variant::Dark), (Some("oxygen"), Variant::Dark)] {
            assert_eq!(theme::variant_of(name), want, "{name:?}");
        }
        // 팔레트 밖의 색은 두 팔레트가 같다: 경고 노랑 · 오류 빨강 (16색 이름 색)
        for v in [Variant::Dark, Variant::Light] {
            with_look(Look { theme: v, monitor: true, no_color: false }, || {
                assert_eq!((theme::err().fg, theme::warn().fg, theme::danger_color()), (Some(Color::Red), Some(Color::Yellow), Color::Yellow), "{v:?}");
                assert_eq!(theme::spinner(), theme::accent(), "{v:?}: 돌아가는 표시는 강조색");
            });
        }
    }

    fn badge_row(text: &str, badge: &str, since: Option<i64>) -> MRow {
        MRow { badge: Some(badge.into()), since, ..row("spinner", text, None, 0) }
    }

    #[test]
    fn badge_sits_right_before_the_elapsed_column_and_goes_first_when_the_line_is_short() {
        let l = |r: &MRow, width| line_text(&row_line(r, false, width, 0, NOW));
        let r = badge_row("worker: 결제 모듈 수정", "셸 1", Some(NOW - 132_000));
        // 글 · 배지 · 경과 순. 배지와 경과 사이는 두 칸이고 경과는 오른쪽 끝
        let t = l(&r, 36);
        assert_eq!(t, "◐ worker: 결제 모듈 수정  셸 1  2:12");
        assert_eq!(w(&t), 36);
        // 35칸에서는 글과 배지 사이가 한 칸으로 줄지만 배지와 경과 사이는 두 칸이다
        assert_eq!(l(&r, 35), "◐ worker: 결제 모듈 수정 셸 1  2:12");
        // 글을 먼저 `…` 로 줄이고 배지는 남긴다
        let t = l(&r, 23);
        assert!(t.starts_with("◐ worker") && t.contains('…') && t.ends_with("셸 1  2:12") && w(&t) == 23, "{t}");
        // 그래도 글이 4칸도 못 남으면 배지를 뺀다 (경과는 남는다)
        let t = l(&r, 14);
        assert!(!t.contains("셸") && t.ends_with("2:12") && w(&t) <= 14 && t.contains('…'), "{t}");
        // 글이 다 들어가면 줄이지 않는다
        assert_eq!(l(&badge_row("npm", "셸 2", Some(NOW - 5_000)), 20), "◐ npm     셸 2  0:05");
        // 경과가 없으면 배지가 오른쪽 끝
        assert_eq!(l(&badge_row("scout", "셸 1", None), 20), "◐ scout         셸 1");
        // 배지가 없으면 지금과 같다
        assert_eq!(l(&MRow { since: Some(NOW - 5_000), ..row("spinner", "npm", None, 0) }, 20), "◐ npm           0:05");
        for width in [1, 2, 5, 9, 12, 14, 23] {
            assert!(w(&l(&r, width)) <= width, "{width}");
        }
        // 한글이므로 회색을 쓰지 않고, 고른 줄이면 줄 전체와 같이 칠한다
        with_look(look(Variant::Dark, false), || {
            let line = row_line(&r, false, 35, 0, NOW);
            assert_eq!(*style_of(&line, "셸 1"), theme::text());
            let sel = row_line(&r, true, 35, 0, NOW);
            assert!(reversed(&sel) && w(&line_text(&sel)) == 35);
        });
        with_look(look(Variant::Light, false), || {
            assert_eq!(*style_of(&row_line(&r, false, 35, 0, NOW), "셸 1"), theme::text());
        });
        // 예시 모델: Subagent 구역의 첫 행
        let (at, fx) = fixtures();
        let (_, _, _, _, m) = fx.iter().find(|(n, ..)| n.starts_with("jobs-35x14")).unwrap();
        let (body, _) = lines(m, 35, 0, at + 10_000);
        let t = body.iter().map(line_text).find(|t| t.contains("scout")).unwrap();
        assert!(t.ends_with("셸 1  0:22") && w(&t) == 35, "{t}");
    }

    use ratatui::buffer::Buffer;

    fn buffer(m: &MonitorModel, width: u16, height: u16, now: i64) -> Buffer {
        let mut term = Terminal::new(TestBackend::new(width, height)).unwrap();
        term.draw(|f| render(f, m, 0, now)).unwrap();
        term.backend().buffer().clone()
    }
    /// 팝업 테두리의 칸 범위: (왼쪽, 오른쪽 포함, 위, 아래 포함)
    fn box_of(b: &Buffer, width: u16, height: u16) -> (u16, u16, u16, u16) {
        let find = |sym: &str| (0..height).flat_map(|y| (0..width).map(move |x| (x, y))).find(|&(x, y)| b[(x, y)].symbol() == sym).unwrap_or_else(|| panic!("{sym} 가 없다"));
        let (l, t) = find("┌");
        let (r, bt) = find("┘");
        (l, r, t, bt)
    }
    fn popup_fixtures() -> (i64, Vec<(String, u16, u16, MonitorModel)>) {
        let (at, fx) = fixtures();
        (at, fx.into_iter().filter(|(n, ..)| n.starts_with("jobs-popup-")).map(|(n, w_, h, _, m)| (n, w_, h, m)).collect())
    }

    #[test]
    fn popup_is_drawn_inside_the_pane_with_the_text_wrapped_and_both_buttons() {
        let (at, fx) = popup_fixtures();
        assert_eq!(fx.len(), 5);
        for (name, width, height, m) in &fx {
            let p = m.popup.as_ref().unwrap();
            let b = buffer(m, *width, *height, at);
            let (l, r, t, bt) = box_of(&b, *width, *height);
            assert!(l >= 1 && r + 2 <= *width && t < bt && bt < *height, "{name}: 테두리 {l}..{r} × {t}..{bt} 가 pane 안(양쪽 한 칸 남김)에 있어야 한다");
            let rows = dump(m, *width, *height, 0, at);
            let inner: Vec<String> = rows[t as usize + 1..bt as usize].iter().map(|r| r.trim().trim_matches('│').trim().to_string()).collect();
            assert!(rows[t as usize].contains("┌ 작업 중지 ") && rows[bt as usize].contains('└'), "{name}");
            // 본문은 줄바꿈만 하고 줄이지 않는다 (공백을 빼고 이어 붙이면 원문)
            let squash = |s: &str| s.chars().filter(|c| !c.is_whitespace()).collect::<String>();
            let buttons = inner.last().unwrap();
            let body = inner[..inner.len() - 1].join("");
            assert_eq!(squash(&body), squash(&p.lines.join("")), "{name}: {inner:?}");
            assert!(buttons.contains("! 중지") && buttons.contains("취소") && !body.contains('…'), "{name}: {buttons}");
            assert!(rows.iter().all(|r| w(r) <= *width as usize), "{name}");
            // 키 안내는 팝업 아래에서 그대로 맨 아래에 있다
            assert_eq!(rows.last().unwrap().trim_start(), m.keys.last().unwrap().trim_start(), "{name}");
            assert!(m.keys.iter().any(|k| k.contains("←→ 이동")), "{name}: 팝업 키 안내");
        }
        let get = |n: &str| fx.iter().find(|(name, ..)| name.starts_with(n)).unwrap();
        // 높이가 넉넉하면 본문 · 빈 줄 · 버튼
        let (_, w28, h28, m28) = get("jobs-popup-35x28");
        let rows = dump(m28, *w28, *h28, 0, at);
        let (_, _, t, bt) = box_of(&buffer(m28, *w28, *h28, at), *w28, *h28);
        assert!(rows[bt as usize - 2].trim_matches(|c| c == ' ' || c == '│').is_empty(), "{:?}", &rows[t as usize..=bt as usize]);
        // 맨 윗줄 띠는 12줄 · 14줄 · 24줄 · 28줄 pane 에서도 그대로다 (11줄은 팝업이 덮는다)
        for n in ["jobs-popup-23x12", "jobs-popup-23x24", "jobs-popup-35x14", "jobs-popup-35x28"] {
            let (_, w_, h, m) = get(n);
            assert!(band_starts(&dump(m, *w_, *h, 0, at)[0], m), "{n}");
        }
        // 팝업 위아래로 팝업 아래 화면이 비친다: 구역 제목과 지금 줄이 남는다
        let (_, w14, h14, m14) = get("jobs-popup-35x14");
        let rows = dump(m14, *w14, *h14, 0, at);
        assert!(rows.iter().any(|r| r.starts_with("── Main Background")) && rows.iter().any(|r| r.contains("도구 실행 중")));
    }

    #[test]
    fn popup_focus_button_is_highlighted_and_stop_is_the_danger_style() {
        let (at, fx) = popup_fixtures();
        let (_, w_, h, m) = fx.iter().find(|(n, ..)| n.starts_with("jobs-popup-35x14")).unwrap();
        // 버튼 줄(테두리 바로 위)에서 label 첫 글자 칸의 스타일
        let cell_style = |m: &MonitorModel, label: &str| {
            let b = buffer(m, *w_, *h, at);
            let (_, _, _, bt) = box_of(&b, *w_, *h);
            let x = (0..*w_).find(|&x| b[(x, bt - 1)].symbol() == label).unwrap_or_else(|| panic!("{label} 가 없다"));
            b[(x, bt - 1)].style()
        };
        assert_eq!(m.popup.as_ref().unwrap().focus, 1, "처음 포커스는 취소 (J3-1)");
        for (v, warn) in [(Variant::Dark, Color::Yellow), (Variant::Light, Color::Yellow)] {
            with_look(look(v, false), || {
                // 포커스 = 취소: 취소만 반전, 중지는 굵은 글씨
                let cancel = cell_style(m, "취");
                assert!(cancel.add_modifier.contains(Modifier::REVERSED | Modifier::BOLD) && cancel.fg == Some(theme::accent_color()), "{v:?}: {cancel:?}");
                let stop = cell_style(m, "중");
                assert!(!stop.add_modifier.contains(Modifier::REVERSED) && stop.add_modifier.contains(Modifier::BOLD), "{v:?}: {stop:?}");
                // 포커스를 중지로 옮기면 중지가 경고색으로 반전
                let mut m2 = m.clone();
                m2.popup.as_mut().unwrap().focus = 0;
                let stop = cell_style(&m2, "중");
                assert!(stop.add_modifier.contains(Modifier::REVERSED | Modifier::BOLD) && stop.fg == Some(warn), "{v:?}: {stop:?}");
                assert!(!cell_style(&m2, "취").add_modifier.contains(Modifier::REVERSED), "{v:?}");
                // 위험한 확인이라 테두리도 경고색
                let b = buffer(m, *w_, *h, at);
                let (l, _, t, _) = box_of(&b, *w_, *h);
                assert_eq!(b[(l, t)].style().fg, Some(warn), "{v:?}: 테두리");
            });
        }
        // 색을 끄면 반전과 굵기로만 구분된다
        with_look(look(Variant::Dark, true), || {
            let cancel = cell_style(m, "취");
            assert!(cancel.add_modifier.contains(Modifier::REVERSED) && cancel.fg.is_none_or(|c| c == Color::Reset), "{cancel:?}");
            let mut m2 = m.clone();
            m2.popup.as_mut().unwrap().focus = 0;
            assert!(cell_style(&m2, "중").fg.is_none_or(|c| c == Color::Reset));
        });
    }

    #[test]
    fn popup_danger_comes_from_the_field_and_not_from_the_button_name() {
        let (at, fx) = popup_fixtures();
        let (_, w_, h, m) = fx.iter().find(|(n, ..)| n.starts_with("jobs-popup-35x14")).unwrap();
        assert_eq!(m.popup.as_ref().unwrap().danger, Some(0), "예시 모델의 danger");
        let text = |m: &MonitorModel| dump(m, *w_, *h, 0, at).join("
");
        assert!(text(m).contains("! 중지") && !text(m).contains("! 취소"));
        // 필드가 없으면 경고 버튼이 없다 (이름이 `중지` 여도): `! ` 도 경고색 테두리도 없다
        let mut none = m.clone();
        none.popup.as_mut().unwrap().danger = None;
        assert!(!text(&none).contains("! "), "{}", text(&none));
        with_look(look(Variant::Dark, false), || {
            let b = buffer(&none, *w_, *h, at);
            let (l, _, t, _) = box_of(&b, *w_, *h);
            assert_eq!(b[(l, t)].style().fg, Some(theme::accent_color()), "경고가 없으면 강조색 테두리");
            // 위치를 가리키는 대로: danger=1 이면 두 번째 버튼이 경고
            let mut second = m.clone();
            second.popup.as_mut().unwrap().danger = Some(1);
            assert!(text(&second).contains("! 취소") && !text(&second).contains("! 중지"));
            // 범위를 벗어난 위치는 경고 버튼이 없는 것과 같다
            let mut out = m.clone();
            out.popup.as_mut().unwrap().danger = Some(5);
            let b = buffer(&out, *w_, *h, at);
            let (l, _, t, _) = box_of(&b, *w_, *h);
            assert!(!text(&out).contains("! ") && b[(l, t)].style().fg == Some(theme::accent_color()));
        });
    }

    #[test]
    fn popup_dims_the_view_below_but_not_the_title_band_or_the_keys() {
        let (at, fx) = popup_fixtures();
        let (_, w_, h, m) = fx.iter().find(|(n, ..)| n.starts_with("jobs-popup-35x28")).unwrap();
        for v in [Variant::Dark, Variant::Light] {
            with_look(look(v, false), || {
                let b = buffer(m, *w_, *h, at);
                let dim = theme::dimmed().fg;
                // 맨 윗줄 띠(바탕색)와 키 안내(맨 아래 줄)는 흐리지 않다
                assert_eq!(b[(0, 0)].style().bg, theme::band().bg, "{v:?}");
                let key_x = (0..*w_).find(|&x| b[(x, h - 1)].symbol() == "E").unwrap();
                assert_ne!(b[(key_x, h - 1)].style().fg, dim, "{v:?}");
                // 그 사이 화면은 흐리다 (구역 제목 · 가로줄)
                assert_eq!(b[(3, 1)].style().fg, dim, "{v:?}: 구역 제목");
                assert_eq!(b[(0, *h - 3)].style().fg, dim, "{v:?}: 가로줄");
            });
        }
        // 팝업이 없으면 흐리지 않다
        let (_, fx2) = fixtures();
        let (_, _, _, _, plain) = fx2.iter().find(|(n, ..)| n.starts_with("jobs-35x28")).unwrap();
        with_look(look(Variant::Dark, false), || assert_ne!(buffer(plain, 35, 28, at)[(3, 1)].style().fg, theme::dimmed().fg));
    }

    #[test]
    fn popup_fits_odd_sizes_and_keeps_the_buttons() {
        let m = MonitorModel {
            title: "Job Monitor".into(),
            keys: vec!["←→ 이동  Enter 선택".into(), "Esc 취소".into()],
            popup: Some(MPopup {
                title: "작업 중지".into(),
                lines: vec!["scout: 로그 찾기 작업을 중지할까요?".into(), "그 subagent 와 그것이 띄운 셸이 모두 끝납니다.".into()],
                buttons: vec!["중지".into(), "취소".into()],
                focus: 1,
                danger: Some(0),
            }),
            ..MonitorModel::default()
        };
        // 낮은 pane 에서는 본문을 `…` 로 줄여도 버튼은 남는다
        for (width, height) in [(23u16, 6u16), (23, 7), (23, 8), (23, 9), (35, 8), (12, 9), (80, 24)] {
            let rows = dump(&m, width, height, 0, 0);
            assert!(rows.iter().all(|r| w(r) <= width as usize), "{width}x{height}");
            assert!(rows.iter().any(|r| r.contains("취소")), "{width}x{height}: 버튼\n{}", rows.join("\n"));
        }
        let rows = dump(&m, 23, 6, 0, 0);
        assert!(rows.iter().any(|r| r.contains('…')), "{rows:?}");
        // 아주 작은 창에서도 panic 하지 않는다
        for (cw, ch) in [(1, 1), (5, 2), (10, 3), (23, 1), (3, 12)] {
            let mut term = Terminal::new(TestBackend::new(cw, ch)).unwrap();
            term.draw(|f| render(f, &m, 0, 0)).unwrap();
        }
        // 버튼이 없는 팝업은 그리지 않는다
        let mut none = m.clone();
        none.popup.as_mut().unwrap().buttons.clear();
        assert!(!dump(&none, 23, 12, 0, 0).iter().any(|r| r.contains('┌')));
    }

    #[test]
    fn apply_takes_the_whole_view_and_quit() {
        let mut m = None;
        let line = r#"{"op":"monitor","kind":"jobs","title":"jobs","right":"실행 중 1","now":[],"nowAt":"bottom","sections":[{"rows":[{"key":"job-1","marker":"spinner","text":"bg  npm test","since":1763000000000,"indent":0}]}],"selected":"job-1","keys":["▲▼ 이동"]}"#;
        assert!(matches!(apply(&mut m, line), Ok(Next::Continue)));
        let mm = m.as_ref().unwrap();
        assert_eq!((mm.kind.as_str(), mm.now_at.as_str(), mm.selected.as_deref(), mm.sections[0].rows[0].since), ("jobs", "bottom", Some("job-1"), Some(NOW)));
        // 다음 지시가 보기 전체를 바꾼다. null · 빠진 필드는 기본값
        apply(&mut m, r#"{"op":"monitor","kind":"flow","title":"flow","selected":null,"sections":[{"title":null,"rows":[{"marker":"none","text":"a","indent":0,"right":null}]}]}"#).unwrap();
        let mm = m.as_ref().unwrap();
        assert_eq!((mm.kind.as_str(), mm.selected.is_none(), mm.keys.len(), mm.sections[0].rows.len()), ("flow", true, 0, 1));
        assert!(matches!(apply(&mut m, r#"{"op":"quit","code":3,"summary":["끝"]}"#), Ok(Next::Quit(3, s)) if s == ["끝"]));
        // 팝업과 배지
        apply(&mut m, r#"{"op":"monitor","kind":"jobs","sections":[{"rows":[{"marker":"spinner","text":"worker: x","badge":"셸 1","indent":0}]}],"popup":{"title":"작업 중지","lines":["a","b"],"buttons":["중지","취소"],"focus":1,"danger":0}}"#).unwrap();
        let mm = m.as_ref().unwrap();
        let p = mm.popup.as_ref().unwrap();
        assert_eq!((mm.sections[0].rows[0].badge.as_deref(), p.title.as_str(), p.lines.len(), p.buttons.len(), p.focus), (Some("셸 1"), "작업 중지", 2, 2, 1));
        assert_eq!(p.danger, Some(0));
        apply(&mut m, r#"{"op":"monitor","kind":"jobs","popup":null}"#).unwrap();
        assert!(m.as_ref().unwrap().popup.is_none());
        assert!(apply(&mut m, r#"{"op":"select"}"#).is_err());
        assert!(apply(&mut m, "not json").is_err());
        assert!(apply(&mut m, r#"{"op":"monitor","sections":"x"}"#).is_err());
    }
}
