//! 모니터 모드 (docs/monitor-tui-spec.md §3 · §4). psmux 오른쪽 열의 jobs · flow 모니터 화면을 그린다.
//! Node(agent/extensions/oxy-monitor/model.ts)가 보기 모델 전체를 보내고, 여기서는 받은 줄을 그대로 배치해 글 폭에 맞춰 자르기만 한다.
//! 스피너와 경과 시간만 이 프로그램의 시계로 움직인다 (Node 가 1초마다 보내지 않는다). 선택한 줄은 모델의 `selected` 를 따른다.
//!
//! 줄 배치 (model.ts 의 `modelHeight` 와 줄 수가 같아야 한다)
//!   제목 1줄(왼쪽 title, 오른쪽 right) → nowAt 이 top 이면 지금(now) 줄들 → 가로줄(지금이 있을 때) → 구역 0 의 줄
//!   → 다음 구역마다 가로줄(구역 제목은 그 가로줄 안에 `── 최근 ──`) + 줄 → nowAt 이 bottom 이면 가로줄 + 지금 줄들 → 키 안내 줄들
//! 키 안내는 항상 창의 맨 아래에 붙인다 (모델이 창보다 짧아도 아래에 놓인다. 길면 위쪽 줄을 자른다).
//! 줄 모양: `<들여쓰기 칸><기호> <글>` + 오른쪽 정렬 right (since 가 있으면 right 대신 경과 m:ss).
//! 줄이 폭을 넘으면 글을 `…` 로 줄이고 right 는 가능한 한 남긴다. 줄이 다음 줄로 넘어가지 않는다.
//! 색: emphasis = 강조색 · error = 오류색 · 선택한 줄 = 반전 (색이 없어도 보인다). 한글 문구에 회색을 쓰지 않는다 (가로줄과 · − 기호만 회색).
use std::time::{SystemTime, UNIX_EPOCH};

use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use serde::Deserialize;

use crate::text::{fit, w};
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
    pub emphasis: bool,
    pub error: bool,
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

/// 스피너의 지금 모양 (1초에 10번 바뀐다). start_ms: 이 프로그램을 시작한 시각 대신 어떤 기준 시각이든 된다
pub fn spinner_frame(elapsed_ms: u128) -> usize {
    (elapsed_ms / 100) as usize % theme::SPINNER.len()
}

/// 경과 m:ss (한 시간 넘으면 h:mm:ss). 미래 시각이면 0:00
pub fn clock(ms: i64) -> String {
    let s = (ms.max(0) / 1000) as u64;
    let (h, m, r) = (s / 3600, (s % 3600) / 60, s % 60);
    if h > 0 { format!("{h}:{m:02}:{r:02}") } else { format!("{m}:{r:02}") }
}

fn marker_of(name: &str, frame: usize) -> Option<(&'static str, Style)> {
    Some(match name {
        "spinner" => (theme::SPINNER[frame % theme::SPINNER.len()], theme::accent()),
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

/// 왼쪽 글과 오른쪽 글을 폭 안에 놓는다. 폭이 모자라면 왼쪽 글을 `…` 로 줄이고, 오른쪽 글은 왼쪽에 4칸이 남는 한 둔다
fn two_sides(head: Vec<Span<'static>>, head_w: usize, text: &str, text_style: Style, right: Option<(String, Style)>, width: usize) -> Vec<Span<'static>> {
    let avail = width.saturating_sub(head_w);
    let mut spans = head;
    let (shown, right) = match right {
        Some((r, st)) if !r.is_empty() => {
            let room = avail.saturating_sub(w(&r) + 1);
            if room >= 4 || w(text) <= room { (fit(text, room), Some((r, st))) } else { (fit(text, avail), None) }
        }
        _ => (fit(text, avail), None),
    };
    let used = head_w + w(&shown);
    spans.push(Span::styled(shown, text_style));
    if let Some((r, st)) = right {
        spans.push(blank(width.saturating_sub(used + w(&r))));
        spans.push(Span::styled(r, st));
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

/// 한 행. selected 면 줄 전체를 반전한다
fn row_line(r: &MRow, selected: bool, width: usize, frame: usize, now: i64) -> Line<'static> {
    let indent = r.indent.min(width / 2);
    let mut head = Vec::new();
    let mut head_w = indent;
    if indent > 0 {
        head.push(blank(indent));
    }
    if let Some((sym, st)) = marker_of(&r.marker, frame) {
        head.push(Span::styled(sym, st));
        head.push(blank(1));
        head_w += 2;
    }
    let text_style = if r.error { theme::err() } else if r.emphasis { theme::focus() } else { theme::text() };
    let right_style = if r.error { theme::err() } else if r.emphasis { theme::accent() } else { theme::text() };
    let right = match (r.since, &r.right) {
        (Some(s), _) => Some((clock(now - s), right_style)),
        (None, Some(t)) => Some((t.clone(), right_style)),
        _ => None,
    };
    let mut spans = clip(two_sides(head, head_w, &r.text, text_style, right, width), width);
    if selected {
        let used: usize = spans.iter().map(|s| w(&s.content)).sum();
        spans.push(blank(width.saturating_sub(used)));
        for s in &mut spans {
            s.style = s.style.add_modifier(Modifier::REVERSED);
        }
    }
    Line::from(spans)
}

/// 제목: 왼쪽 title(굵게), 오른쪽 right
fn title_line(m: &MonitorModel, width: usize) -> Line<'static> {
    let right = (!m.right.is_empty()).then(|| (m.right.clone(), theme::text()));
    Line::from(two_sides(Vec::new(), 0, &m.title, theme::strong(), right, width))
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
        if i > 0 {
            body.push(rule(s.title.as_deref(), width));
        } else if let Some(t) = s.title.as_deref().filter(|t| !t.is_empty()) {
            body.push(Line::from(Span::styled(fit(t, width), theme::strong())));
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
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;
    use std::path::PathBuf;

    const NOW: i64 = 1_763_000_000_000;

    fn line_text(l: &Line) -> String {
        l.spans.iter().map(|s| s.content.as_ref()).collect()
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
            assert!(rows[0].starts_with(m.title.as_str()), "{name}: {}", rows[0]);
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
    fn spinner_marker_is_a_braille_glyph_that_changes_ten_times_a_second() {
        let (at, fx) = fixtures();
        let mut seen = std::collections::HashSet::new();
        for (name, width, _, _, m) in &fx {
            let spinners = all_rows(m).into_iter().filter(|r| r.marker == "spinner").count();
            for frame in 0..10 {
                let (body, _) = lines(m, *width as usize, frame, at);
                let glyphs: Vec<char> = body.iter().map(line_text).filter_map(|t| t.trim_start().chars().next()).filter(|c| ('\u{2800}'..='\u{28FF}').contains(c)).collect();
                assert_eq!(glyphs.len(), spinners, "{name}: spinner 줄마다 점자 글자 하나");
                assert!(glyphs.iter().all(|g| theme::SPINNER.contains(&g.to_string().as_str())));
                seen.extend(glyphs);
            }
        }
        assert_eq!(seen.len(), theme::SPINNER.len(), "10프레임이 모두 다르다");
        assert_eq!((spinner_frame(0), spinner_frame(99), spinner_frame(100), spinner_frame(1000)), (0, 0, 1, 0));
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
            for s in m.sections.iter().skip(1).filter(|s| s.title.is_some()) {
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
        // 작은 창의 flow 에는 최근 구역이 없다 (spec §3 폭과 높이)
        assert!(fx.iter().filter(|(n, ..)| n.starts_with("flow-23x12")).all(|(.., m)| m.sections.iter().all(|s| s.title.is_none())));
    }

    #[test]
    fn now_goes_on_top_for_flow_and_at_the_bottom_for_jobs() {
        let (at, fx) = fixtures();
        for (name, width, _, _, m) in &fx {
            let (body, keys) = lines(m, *width as usize, 0, at);
            let texts: Vec<String> = body.iter().map(line_text).collect();
            let first_now = m.now.first().map(|r| r.text.chars().take(2).collect::<String>()).unwrap();
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
        assert_eq!(line_text(&row_line(&spin, false, 23, 0, NOW)), "⠋ 도구 실행 중     0:12");
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
    fn jobs_now_row_sits_right_above_the_keys_and_the_blank_lines_are_above_its_rule() {
        let (at, fx) = fixtures();
        for want in ["jobs-35x28", "jobs-23x24", "jobs-35x14", "jobs-23x12"] {
            let Some((name, width, height, model_h, m)) = fx.iter().find(|(n, ..)| n.starts_with(want)) else { continue };
            assert_eq!(m.now_at, "bottom");
            assert!(*model_h < *height as usize, "{name}: 목록이 짧아 빈 줄이 생기는 모델이어야 한다");
            let rows = dump(m, *width, *height, 0, at);
            let h = *height as usize;
            let key_rows = m.keys.len();
            // 맨 아래 = 키 안내, 그 위 = 지금 줄들, 그 위 = 가로줄
            assert_eq!(rows[h - 1].trim_start(), m.keys.last().unwrap().trim_start(), "{name}");
            let now_first = h - key_rows - m.now.len();
            assert_eq!(rows[now_first - 1], "─".repeat(*width as usize), "{name}: 가로줄이 지금 바로 위");
            let head: String = m.now[0].text.chars().take(2).collect();
            assert!(rows[now_first].contains(&head), "{name}: {}", rows[now_first]);
            // 목록과 가로줄 사이에 빈 줄이 있고, 목록은 제목 바로 아래에서 시작한다
            let list_rows = m.sections[0].rows.len();
            assert_eq!(rows[1 + list_rows..now_first - 1].iter().filter(|r| r.is_empty()).count(), h - model_h, "{name}: 빈 줄 수");
            assert!(rows[1 + list_rows..now_first - 1].iter().all(|r| r.is_empty()), "{name}");
            assert!(!rows[1].is_empty(), "{name}");
        }
        // 창이 모델과 같은 높이면 순서대로의 줄과 같다 (빈 줄 없음)
        let (_, _, _, _, m) = fx.iter().find(|(n, ..)| n.starts_with("jobs-35x28")).unwrap();
        let (body, keys) = lines(m, 35, 0, at);
        let rows = dump(m, 35, (body.len() + keys.len()) as u16, 0, at);
        assert!(rows.iter().all(|r| !r.is_empty()));
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
        assert_eq!((rows.len(), rows[0].starts_with(m.title.as_str())), (8, true));
        assert_eq!(rows.last().unwrap().trim_start(), m.keys.last().unwrap().trim_start());
        // 아주 작은 창에서도 panic 하지 않는다
        for (cw, ch) in [(1, 1), (5, 2), (23, 1)] {
            let mut term = Terminal::new(TestBackend::new(cw, ch)).unwrap();
            term.draw(|f| render(f, m, 0, at)).unwrap();
        }
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
        assert!(apply(&mut m, r#"{"op":"select"}"#).is_err());
        assert!(apply(&mut m, "not json").is_err());
        assert!(apply(&mut m, r#"{"op":"monitor","sections":"x"}"#).is_err());
    }
}
