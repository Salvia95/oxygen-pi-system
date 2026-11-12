//! 단일 열 배치: 배너 · 위치 줄 · [결과 줄] · 헤더 · 맥락 · 목록(묶음 사이 빈 줄) · 설명(상세 패널) · (남는 줄) · 키 안내(맨 아래).
//! 좁은 창(100칸 미만)의 메뉴 화면과, 아주 작은 창(72칸 · 16줄 미만)의 모든 화면이 이 배치로 그려진다.
//! 자리가 모자라면 SHRINK 순서로 줄이고, 뒤 단계에서 자리가 나면 앞에서 뺀 것을 되살린다.
use ratatui::Frame;
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;

use crate::banner;
use crate::model::{App, ConfirmSpec, InputSpec, Row, Screen, SelectSpec, TaskItem, TaskSpec};
use crate::parts::{alert_line, context_lines, desc_line, help_text, keys_for, keys_line, label_width, loc_line, loc_parts, loc_short, result_line, row_spans, summary_lines};
use crate::text::{trunc, w};
use crate::theme;

type L = Line<'static>;

/// 상세 패널: 포커스한 항목의 설명을 테두리 블록(제목 = 항목명)에 넣는다. 자리가 남으면 관련 정보도 보인다
struct Panel {
    title: String,
    info: Vec<L>,
}

/// 한 화면을 이루는 조각들
struct Pieces {
    result: Option<L>,
    header: L,
    /// 접을 수 있는 맥락
    ctx: Vec<L>,
    /// 접지 않는 줄 (요약표 · 확인 대상 · 경고)
    keep: Vec<L>,
    /// 목록: (줄, 그 줄 앞에서 묶음이 바뀌는가)
    list: Vec<(L, bool)>,
    focus: usize,
    /// 설명 줄 (들여쓰기 없이)
    desc: Vec<L>,
    /// 설명에 예약할 줄 수 (포커스를 옮겨도 목록이 움직이지 않게)
    desc_rows: usize,
    panel: Option<Panel>,
}

/// 여백 아홉 가지. 줄이는 순서는 번호 순서와 같다:
/// 키 안내 아래 빈 줄 → 설명 2줄→1줄 → 위치 줄(배너 오른쪽으로 합침) → 설명과 키 안내 사이 빈 줄 → 선택지 위 빈 줄(맥락 · 요약과 선택지 사이)
/// → 맥락 접기 → 상세 패널의 테두리 → 묶음 사이 빈 줄(전부 두거나 전부 뺀다) → 헤더 아래 빈 줄.
/// 줄이 남으면 헤더 아래, 선택지 위 순서로 빈 줄이 들어간다. 묶음 사이 빈 줄은 되도록 지킨다
type Space = [bool; 9];
const BOTTOM: usize = 0;
const DESC2: usize = 1;
const LOC: usize = 2;
const FOOTGAP: usize = 3;
const LISTGAP: usize = 4;
const CTX: usize = 5;
const BORDER: usize = 6;
const GAPS: usize = 7;
const HEADGAP: usize = 8;

pub fn head(app: &App, cols: usize, rows: usize, loc: bool) -> Vec<L> {
    // 큰 배너를 낮은 창(30줄 미만)에 그릴 때는 위치 줄을 따로 두지 않고 늘 배너 오른쪽(버전 아래)에 둔다
    let loc = loc && !(banner::height(cols, rows) > 1 && rows < 30);
    let has_loc = !loc_parts(&app.frame).is_empty();
    let aside = if loc || !has_loc { String::new() } else { loc_short(&app.frame) };
    let mut out = banner::lines(&app.frame.version, cols, rows, &aside);
    out.push(Line::raw(""));
    if loc && has_loc {
        out.push(loc_line(&app.frame, cols));
        out.push(Line::raw(""));
    }
    out
}

fn list_lines(p: &Pieces, gaps: bool) -> (Vec<L>, usize) {
    let mut out = Vec::new();
    let mut focus_line = 0;
    for (i, (line, gap)) in p.list.iter().enumerate() {
        if gaps && *gap && i > 0 {
            out.push(Line::raw(""));
        }
        if i == p.focus {
            focus_line = out.len();
        }
        out.push(line.clone());
    }
    (out, focus_line)
}

/// 목록이 자리보다 길면 포커스한 행이 보이게 창을 잡고, 잘린 쪽에 남은 개수를 적는다
pub fn window(list: Vec<L>, focus_line: usize, cap: usize, indent: usize) -> Vec<L> {
    if list.len() <= cap || cap == 0 {
        return list;
    }
    let cap = cap.max(3).min(list.len());
    let start = focus_line.saturating_sub(cap / 2).min(list.len() - cap);
    let below = list.len() - start - cap;
    let mut shown: Vec<L> = list.into_iter().skip(start).take(cap).collect();
    let ind = " ".repeat(indent);
    if start > 0 {
        shown[0] = Line::raw(format!("{ind}{} {}개 더", theme::UP, start + 1));
    }
    if below > 0 {
        shown[cap - 1] = Line::raw(format!("{ind}{} {}개 더", theme::DOWN, below + 1));
    }
    shown
}

/// 테두리 한 줄: `│ 내용          │`
fn boxed(content: L, inner: usize) -> L {
    let used: usize = content.spans.iter().map(|s| w(&s.content)).sum();
    let mut spans = vec![Span::styled(" │ ", theme::sub())];
    spans.extend(content.spans);
    spans.push(Span::raw(" ".repeat(inner.saturating_sub(used))));
    spans.push(Span::styled(" │", theme::sub()));
    Line::from(spans)
}

/// 조각을 창 높이에 맞춰 줄들로 조립한다 → (줄들, 목록이 시작하는 줄 번호)
fn assemble(app: &App, p: &Pieces, cols: usize, rows: usize) -> (Vec<L>, usize) {
    // 큰 배너를 낮은 창(30줄 미만)에 그릴 때: 위치는 배너 오른쪽에 두고, 상세 패널에도 테두리를 두르지 않는다
    // (자리가 남는 화면에만 테두리가 생겨 화면마다 모양이 달라지지 않게)
    let low = banner::height(cols, rows) > 1 && rows < 30;
    let has: Space = [
        true,
        p.desc_rows > 1,
        !low && !loc_parts(&app.frame).is_empty(),
        true,
        !p.ctx.is_empty() || !p.keep.is_empty(),
        !p.ctx.is_empty(),
        !low && p.panel.is_some() && p.desc_rows > 0,
        p.list.iter().skip(1).any(|(_, g)| *g),
        true,
    ];
    // 헤더와 선택지 사이에 맥락이나 요약이 보이는가 (보일 때만 선택지 위 빈 줄이 따로 있다)
    let sub = |o: &Space| (o[CTX] && !p.ctx.is_empty()) || !p.keep.is_empty();
    let mut o = has;
    let desc_n = |o: &Space| if o[DESC2] { p.desc_rows } else { 1 };
    // 목록 아래: 빈 줄 + 설명(테두리가 있으면 위아래 선) + 키 안내 앞 빈 줄(테두리가 없을 때만) + 키 안내 + 아래 여백
    let foot_gap = |o: &Space| usize::from(o[FOOTGAP]);
    let tail = |o: &Space| (if p.desc_rows == 0 { foot_gap(o) } else if o[BORDER] { 1 + desc_n(o) + 2 } else { 1 + desc_n(o) + foot_gap(o) }) + 1 + usize::from(o[BOTTOM]);
    // 결과 줄: 낮은 창에서는 배너 바로 아래(배너 아래 빈 줄 자리)에 두어 한 줄만 쓴다
    let result_rows = if p.result.is_none() { 0 } else if low { 1 } else { 2 };
    let chrome = |o: &Space| head(app, cols, rows, o[LOC]).len() + result_rows + 1 + if o[CTX] { p.ctx.len() } else { 0 } + p.keep.len() + usize::from(o[HEADGAP]) + usize::from(o[LISTGAP] && sub(o)) + tail(o);
    let height = |o: &Space| chrome(o) + list_lines(p, o[GAPS]).0.len();
    let mut last = None;
    for k in 0..o.len() {
        if height(&o) <= rows {
            break;
        }
        if o[k] {
            o[k] = false;
            last = Some(k);
        }
    }
    for k in (0..o.len()).rev() {
        if Some(k) == last || o[k] || !has[k] {
            continue;
        }
        o[k] = true;
        if height(&o) > rows {
            o[k] = false;
        }
    }

    let (list, focus_line) = list_lines(p, o[GAPS]);
    let list = window(list, focus_line, rows.saturating_sub(chrome(&o)).max(1), 4);
    let spare = rows.saturating_sub(chrome(&o) + list.len());

    let mut body = head(app, cols, rows, o[LOC]);
    if let Some(r) = &p.result {
        if low {
            body.pop();
        }
        body.push(r.clone());
        body.push(Line::raw(""));
    }
    body.push(p.header.clone());
    if o[HEADGAP] {
        body.push(Line::raw(""));
    }
    if o[CTX] {
        body.extend(p.ctx.iter().cloned());
    }
    body.extend(p.keep.iter().cloned());
    if o[LISTGAP] && sub(&o) {
        body.push(Line::raw(""));
    }
    let list_at = body.len();
    body.extend(list);
    if p.desc_rows > 0 {
        body.push(Line::raw(""));
        let mut d: Vec<L> = (0..desc_n(&o)).map(|i| p.desc.get(i).cloned().unwrap_or_default()).collect();
        match (&p.panel, o[BORDER]) {
            (Some(panel), true) => {
                // 남는 줄이 있으면 관련 정보까지 넣는다 (빈 줄 하나 + 정보 줄)
                if !panel.info.is_empty() && spare >= 2 {
                    d.push(Line::raw(""));
                    d.extend(panel.info.iter().take(spare - 1).cloned());
                }
                let inner = cols.saturating_sub(6);
                let title = trunc(&panel.title, inner.saturating_sub(4));
                body.push(Line::from(vec![
                    Span::styled(" ┌ ", theme::sub()),
                    Span::styled(title.clone(), theme::strong()),
                    Span::styled(format!(" {}┐", "─".repeat(inner.saturating_sub(w(&title) + 1))), theme::sub()),
                ]));
                body.extend(d.into_iter().map(|l| boxed(l, inner)));
                body.push(Line::styled(format!(" └{}┘", "─".repeat(inner + 2)), theme::sub()));
            }
            (panel, _) => {
                // 테두리 없이: 설명 줄, 자리가 남으면 빈 줄 하나 뒤에 관련 정보
                if let Some(panel) = panel.as_ref().filter(|x| !x.info.is_empty() && spare >= 2) {
                    d.push(Line::raw(""));
                    d.extend(panel.info.iter().take(spare - 1).cloned());
                }
                body.extend(d.into_iter().map(|l| indent(l, 2)));
            }
        }
    }
    let foot_row = rows.saturating_sub(1 + usize::from(o[BOTTOM]));
    body.truncate(foot_row);
    while body.len() < foot_row {
        body.push(Line::raw(""));
    }
    // `? 도움말` 은 볼 것이 있을 때만: 맥락을 접었거나, 관련 정보가 있는 항목이 있을 때
    let mut keys = keys_for(app);
    let folded = has[CTX] && !o[CTX];
    let has_info = matches!(&app.screen, Screen::Select(s) if s.rows.iter().any(|r| !r.info.is_empty()));
    if !folded && !has_info {
        keys.retain(|(k, _)| k != "?");
    }
    body.push(keys_line(&keys, cols));
    (body, list_at)
}

pub fn header_line(s: &str) -> L {
    Line::from(vec![Span::raw("  "), Span::styled(s.to_string(), theme::strong())])
}

/// 목록 행들 (왼쪽 들여쓰기 2칸 포함): (줄, 그 줄 앞에서 묶음이 바뀌는가)
pub fn rows_as_lines(rows: &[Row], focus: usize, multi: bool, cols: usize) -> Vec<(L, bool)> {
    // 레이블 열은 폭의 절반까지 (그보다 긴 레이블이 있으면 그 행만 값 열이 밀린다)
    let label_w = rows.iter().map(label_width).max().unwrap_or(0).min((cols / 2).max(16));
    let show_value = cols > label_w + 24;
    rows.iter()
        .enumerate()
        .map(|(i, r)| {
            let mut spans = vec![Span::raw("  ")];
            spans.extend(row_spans(r, i == focus, multi, label_w, cols.saturating_sub(4), show_value));
            (Line::from(spans), r.gap)
        })
        .collect()
}

/// 선택 화면의 설명 줄 (차단 안내가 있으면 그것을 대신 보인다)
pub fn select_desc(s: &SelectSpec, width: usize) -> Vec<L> {
    if !s.message.is_empty() {
        return vec![alert_line(theme::WARN, theme::warn(), &s.message, width, 0)];
    }
    s.rows.get(s.focus).map(|r| r.desc.iter().map(|d| desc_line(d, width, 0)).collect()).unwrap_or_default()
}

/// 설명에 예약할 줄 수 (0~2). 설명이 하나도 없고 차단 안내가 뜰 일도 없는 목록(잠금 · 선택 불가 행 없음)에는 설명 줄을 두지 않는다
pub fn desc_rows(s: &SelectSpec) -> usize {
    let most = s.rows.iter().map(|r| r.desc.len()).max().unwrap_or(0);
    if most == 0 && !s.rows.iter().any(|r| r.locked || r.disabled) { 0 } else { most.clamp(1, 2) }
}

fn select_pieces(s: &SelectSpec, cols: usize, panel: bool) -> Pieces {
    let ctx = context_lines(&s.context, cols.saturating_sub(2), 2);
    let mut keep = if s.keep { ctx.clone() } else { vec![] };
    keep.extend(summary_lines(&s.summary, cols - 2, 2));
    let fo = s.rows.get(s.focus);
    // 상세 패널은 설명할 것이 있는 메뉴에만 (설명이 하나도 없는 값 목록에는 두지 않는다)
    let panel = (panel && s.rows.iter().any(|r| !r.desc.is_empty() || !r.info.is_empty()))
        .then(|| Panel { title: fo.map(|r| r.label.clone()).unwrap_or_default(), info: fo.map(|r| summary_lines(&r.info, cols.saturating_sub(6), 0)).unwrap_or_default() });
    Pieces {
        result: (!s.result.is_empty()).then(|| result_line(s, cols - 2, 2)),
        header: header_line(&s.header),
        ctx: if s.keep { vec![] } else { ctx },
        keep,
        list: rows_as_lines(&s.rows, s.focus, s.multi, cols),
        focus: s.focus,
        desc: select_desc(s, cols.saturating_sub(if panel.is_some() { 6 } else { 4 })),
        desc_rows: desc_rows(s),
        panel,
    }
}

fn confirm_pieces(c: &ConfirmSpec, cols: usize) -> Pieces {
    let mut keep = context_lines(&c.context, cols.saturating_sub(2), 2);
    keep.extend(summary_lines(&c.summary, cols - 2, 2));
    if !c.warning.is_empty() {
        keep.push(Line::raw(""));
        keep.push(desc_line(&format!("! {}", c.warning), cols - 2, 2));
    }
    let rows = [Row { label: c.yes.clone(), danger: c.danger, ..Row::default() }, Row { label: c.no.clone(), ..Row::default() }];
    let focus = usize::from(!c.on_yes);
    Pieces { result: None, header: header_line(&c.header), ctx: vec![], keep, list: rows_as_lines(&rows, focus, false, cols), focus, desc: vec![], desc_rows: 0, panel: None }
}

fn input_pieces(i: &InputSpec, cols: usize) -> Pieces {
    let field = Line::from(vec![Span::raw("  "), Span::styled(format!("{} ", theme::POINTER), theme::accent()), Span::raw(tail(&shown_value(i), cols.saturating_sub(8)))]);
    Pieces {
        result: None,
        header: header_line(&i.header),
        ctx: context_lines(&i.context, cols.saturating_sub(2), 2),
        keep: vec![],
        list: vec![(field, false)],
        focus: 0,
        desc: if i.error.is_empty() { vec![] } else { vec![alert_line(theme::ERR, theme::err(), &i.error, cols.saturating_sub(4), 0)] },
        desc_rows: 1,
        panel: None,
    }
}

/// 입력 칸에 보일 글 (비밀값은 가린다)
pub fn shown_value(i: &InputSpec) -> String {
    if i.mask { "•".repeat(i.value.chars().count()) } else { i.value.clone() }
}

/// 입력 값이 칸보다 길면 뒤쪽을 보인다 (커서가 끝에 있으므로)
pub fn tail(s: &str, max: usize) -> String {
    if w(s) <= max {
        return s.to_string();
    }
    let mut out: Vec<char> = Vec::new();
    let mut n = 1;
    for ch in s.chars().rev() {
        let cw = w(&ch.to_string());
        if n + cw > max {
            break;
        }
        out.push(ch);
        n += cw;
    }
    out.push('…');
    out.into_iter().rev().collect()
}

/// 진행 막대 한 줄: ████░░░░   34%
pub fn progress_text(percent: i32, width: usize) -> String {
    let ratio = (percent.clamp(0, 100) as f64) / 100.0;
    let bar = width.saturating_sub(8).clamp(8, 40);
    let filled = (ratio * bar as f64).round() as usize;
    format!("{}{}  {percent:>3}%", "█".repeat(filled), "░".repeat(bar - filled))
}

/// 작업 한 줄: ✓ 끝남 · 돌아가는 표시 · × 실패 · `·` 대기. state 가 text 면 작업이 아닌 그냥 한 줄
pub fn task_item_line(app: &App, it: &TaskItem, width: usize, indent: usize) -> L {
    if it.state == "text" {
        return Line::raw(format!("{}{}", " ".repeat(indent), trunc(&it.label, width.saturating_sub(indent))));
    }
    let (mark, style) = match it.state.as_str() {
        "done" => (theme::OK, theme::ok()),
        "fail" => (theme::ERR, theme::err()),
        "run" => (theme::SPINNER[app.tick % theme::SPINNER.len()], theme::accent()),
        _ => ("·", theme::sub()),
    };
    let label_style = if it.state == "wait" { theme::text() } else { theme::strong() };
    let mut spans = vec![Span::raw(" ".repeat(indent)), Span::styled(format!("{mark} "), style), Span::styled(it.label.clone(), label_style)];
    if !it.extra.is_empty() {
        let used = indent + 2 + w(&it.label) + 3;
        spans.push(Span::raw("   "));
        spans.push(Span::raw(trunc(&it.extra, width.saturating_sub(used))));
    }
    Line::from(spans)
}

/// 진행 화면의 본문 (제목 아래): 본문 줄 · 진행 막대 · 작업 목록
pub fn task_body(app: &App, t: &TaskSpec, width: usize, indent: usize, bar: bool) -> Vec<L> {
    let ind = " ".repeat(indent);
    // 경로이거나 경로로 끝나는 줄은 경로의 가운데를 줄인다. 그 밖의 줄은 끝을 줄인다
    let fit = |l: &str| crate::text::fit(l, width.saturating_sub(indent));
    let mut out: Vec<L> = t.lines.iter().map(|l| Line::raw(format!("{ind}{}", fit(l)))).collect();
    if !t.lines.is_empty() && (!t.items.is_empty() || t.percent >= 0) {
        out.push(Line::raw(""));
    }
    if bar && t.percent >= 0 {
        out.push(Line::from(vec![Span::raw(ind.clone()), Span::styled(progress_text(t.percent, width.saturating_sub(indent)), theme::accent())]));
        out.push(Line::raw(""));
    }
    out.extend(t.items.iter().map(|it| task_item_line(app, it, width, indent)));
    out
}

fn task_lines(app: &App, t: &TaskSpec, cols: usize, rows: usize) -> Vec<L> {
    let mut body = head(app, cols, rows, true);
    if !t.title.is_empty() {
        // 제목도 창 폭에 맞춘다 (결과 제목 뒤에 경로가 붙는다: `✓ tdb 연결을 저장했습니다  SQLite · C:/…/app.db`)
        body.push(header_line(&crate::text::fit(&t.title, cols - 2)));
    }
    let content = task_body(app, t, cols - 2, 2, true);
    // 넘치면 최근 줄을 보인다 (진행 중인 작업이 아래에 있다)
    let cap = rows.saturating_sub(body.len() + 2);
    let skip = content.len().saturating_sub(cap);
    body.extend(content.into_iter().skip(skip));
    let foot_row = rows.saturating_sub(2);
    body.truncate(foot_row);
    while body.len() < foot_row {
        body.push(Line::raw(""));
    }
    body.push(keys_line(&keys_for(app), cols));
    body
}

pub fn indent(l: L, n: usize) -> L {
    let mut spans = vec![Span::raw(" ".repeat(n))];
    spans.extend(l.spans);
    Line::from(spans)
}

/// 메뉴 화면을 단일 열로: 목록(레이블 + 현재 값) 아래에 상세 패널. 테두리가 들어가지 않는 높이에서는 테두리 없이 설명만
pub fn render_menu(f: &mut Frame, app: &App, s: &SelectSpec) {
    let area = f.area();
    let (cols, rows) = (area.width as usize, area.height as usize);
    f.render_widget(Paragraph::new(assemble(app, &select_pieces(s, cols, true), cols, rows).0), area);
}

/// 모든 화면을 테두리 없는 단일 열로 (아주 작은 창: 도움말 · 확인도 팝업 없이 같은 열에 그린다)
pub fn render(f: &mut Frame, app: &App) {
    draw(f, app, &app.screen, app.help);
}

/// 주어진 화면 하나를 테두리 없는 단일 열로. 도움말 · 확인은 부르는 쪽(view.rs)이 팝업으로 그 위에 그린다
pub fn render_screen(f: &mut Frame, app: &App, screen: &Screen) {
    draw(f, app, screen, false);
}

fn draw(f: &mut Frame, app: &App, screen: &Screen, help: bool) {
    let area = f.area();
    let (cols, rows) = (area.width as usize, area.height as usize);
    let mut cursor = None;
    let lines = match screen {
        Screen::Idle => head(app, cols, rows, true),
        Screen::Task(t) => task_lines(app, t, cols, rows),
        Screen::Select(s) if help => {
            // 도움말: 목록 자리에 맥락 전체와 포커스한 항목의 설명을 보인다
            let help: Vec<(L, bool)> = help_text(s, cols.saturating_sub(6)).into_iter().map(|l| (indent(l, 2), false)).collect();
            let p = Pieces { result: None, header: header_line(&s.header), ctx: vec![], keep: vec![], list: help, focus: 0, desc: vec![], desc_rows: 0, panel: None };
            assemble(app, &p, cols, rows).0
        }
        Screen::Select(s) => assemble(app, &select_pieces(s, cols, false), cols, rows).0,
        Screen::Confirm(c) => assemble(app, &confirm_pieces(c, cols), cols, rows).0,
        Screen::Input(i) => {
            let (lines, at) = assemble(app, &input_pieces(i, cols), cols, rows);
            cursor = Some((4 + w(&tail(&shown_value(i), cols.saturating_sub(8))), at));
            lines
        }
    };
    f.render_widget(Paragraph::new(lines), area);
    if let Some((x, y)) = cursor {
        f.set_cursor_position((x as u16, y as u16));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_list_without_descriptions_reserves_no_description_line() {
        let plain = SelectSpec { rows: vec![Row { label: "설치 시작".into(), ..Row::default() }, Row { label: "설치 취소".into(), ..Row::default() }], ..SelectSpec::default() };
        assert_eq!(desc_rows(&plain), 0);
        // 설명이 있거나, 차단 안내가 뜰 수 있는 행(잠금 · 선택 불가)이 있으면 줄을 남긴다
        let mut with_desc = plain.clone();
        with_desc.rows[0].desc = vec!["a".into(), "b".into(), "c".into()];
        assert_eq!(desc_rows(&with_desc), 2);
        let mut locked = plain.clone();
        locked.rows[0].locked = true;
        assert_eq!(desc_rows(&locked), 1);
    }
}
