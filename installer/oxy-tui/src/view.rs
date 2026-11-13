//! 화면 배치. 화면 종류마다 함수 하나다 (배치를 바꿀 때 그 함수만 고치면 된다).
//!   메뉴(하나 고르기, 단계 없음)   menu()    목록은 항상 레이블 + 현재 값. 포커스한 항목의 설명·관련 정보는 상세 패널(제목 = 항목명)
//!                                             폭 ≥ 100: 목록 왼쪽 / 상세 오른쪽 · 그보다 좁으면 목록 위 / 상세 아래 (view_a::render_menu)
//!   마법사(설치 단계 · 여러 개 고르기 · 입력 · 진행)   wizard()
//!                                             폭 ≥ 100: 왼쪽 단계 목록 패널 + 오른쪽 블록 · 좁으면 블록 하나(제목 `설치 3/8 · 구성요소` + 오른쪽 위 진행 표시)
//!   위험 확인 · `?` 도움말            confirm_popup() · help_popup()   가운데 팝업 (아래 화면은 어둡게)
//! 30줄 미만의 창은 테두리 블록을 쓰지 않는다: 큰 배너(6줄) 아래를 테두리 없는 단일 열로 그리고 위치는 배너 오른쪽(버전 아래)에 둔다.
//! 72칸 · 16줄 미만의 창은 팝업도 쓰지 않는다 (view_a::render). 테두리는 어두운 회색의 얇은 선, 블록은 화면당 둘까지.
use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Clear, Gauge, Padding, Paragraph};

use crate::model::{App, ConfirmSpec, InputSpec, Screen, SelectSpec, TaskSpec};
use crate::parts::{Button, alert_line, centered, dialog, widen, context_lines, desc_line, help_text, keys_for, keys_line, label_width, loc_parts, loc_title, result_line, row_spans, summary_lines};
use crate::text::{trunc, w, wrap};
use crate::theme;
use crate::view_a::{self, desc_rows, select_desc, shown_value, tail, task_body, window};

type L = Line<'static>;

/// 두 영역을 나란히 놓는 최소 폭
const WIDE: u16 = 100;
/// 테두리 블록(단계 목록 패널 · 본문 블록 · 나란한 상세 패널)을 쓰는 최소 높이. 그보다 낮으면 테두리 없는 단일 열
const PANEL_MIN_ROWS: u16 = 30;

pub fn render(f: &mut Frame, app: &App) {
    let area = f.area();
    if area.width < 72 || area.height < 16 {
        return view_a::render(f, app);
    }
    // 확인은 아래 화면 위에 팝업으로 띄운다
    let main = match (&app.screen, &app.under) {
        (Screen::Confirm(_), Some(under)) => under,
        (s, _) => s,
    };
    let mut cursor = None;
    // 블록(테두리) 안에 선택지가 다 들어가지 않는 높이면 테두리 없는 단일 열로 그린다 (큰 배너를 낮은 창에 쓸 때)
    let banner_h = crate::banner::height(area.width as usize, area.height as usize) as u16;
    let block_inner = area.height.saturating_sub(banner_h + u16::from(area.height >= 22) + 1 + 2) as usize;
    match main {
        Screen::Select(s) if app.frame.steps.is_empty() && !s.multi => menu(f, app, s),
        Screen::Idle | Screen::Confirm(_) => f.render_widget(Paragraph::new(view_a::head(app, area.width as usize, area.height as usize, true)), area),
        // 낮은 창(30줄 미만)에서는 테두리 블록을 쓰지 않고 단일 열로 그린다 (큰 배너 아래에 남는 줄이 적다)
        other if area.height < PANEL_MIN_ROWS => view_a::render_screen(f, app, other),
        // 블록 안에 필요한 줄: 헤더 1 + 빈 줄 1 + 선택지 + 빈 줄 1 + 설명 1
        Screen::Select(s) if s.rows.len() + 4 > block_inner => view_a::render_screen(f, app, main),
        other => cursor = wizard(f, app, other),
    }
    // 팝업: 화면 전체를 어둡게 한 뒤 팝업과 키 안내(맨 아랫줄)를 그 위에 그린다
    let popup = match &app.screen {
        Screen::Confirm(_) => true,
        Screen::Select(_) => app.help,
        _ => false,
    };
    if popup {
        // 배너는 가리지도 어둡게 하지도 않는다
        let top = (crate::banner::height(area.width as usize, area.height as usize) + 1) as u16;
        let body = Rect::new(area.x, area.y + top, area.width, area.height - 2 - top);
        let foot = Rect::new(area.x, area.y + area.height - 2, area.width, 2);
        dim(f, Rect::new(area.x, area.y + top, area.width, area.height - top));
        match &app.screen {
            Screen::Confirm(c) => confirm_popup(f, c, body),
            Screen::Select(s) => help_popup(f, s, body),
            _ => {}
        }
        f.render_widget(Clear, foot);
        f.render_widget(Paragraph::new(vec![Line::raw(""), keys_line(&keys_for(app), area.width as usize)]), foot);
        cursor = None;
    }
    if let Some(pos) = cursor {
        f.set_cursor_position(pos);
    }
}

/// 패널 제목은 테두리 색(어두운 회색)을 따라가지 않게 글자색을 기본색으로 되돌린다 (mintty 에서 회색 한글은 읽히지 않는다)
fn title(text: &str) -> L {
    Line::from(vec![Span::raw(" "), Span::styled(text.to_string(), Style::new().fg(Color::Reset).add_modifier(Modifier::BOLD)), Span::raw(" ")])
}

fn panel(name: &str) -> Block<'static> {
    let b = Block::bordered().border_style(theme::sub()).padding(Padding::horizontal(1));
    if name.is_empty() { b } else { b.title(title(name)) }
}

/// 팝업 아래 화면을 어둡게 한다
fn dim(f: &mut Frame, area: Rect) {
    f.buffer_mut().set_style(area, theme::dimmed());
}

// ---------------------------------------------------------------- 메뉴
/// 메뉴: 넓으면 목록 왼쪽 / 상세 패널 오른쪽, 좁으면 목록 위 / 상세 패널 아래
fn menu(f: &mut Frame, app: &App, s: &SelectSpec) {
    let area = f.area();
    let has_detail = s.rows.iter().any(|r| !r.desc.is_empty() || !r.info.is_empty());
    if area.width < WIDE || area.height < PANEL_MIN_ROWS || !has_detail {
        return view_a::render_menu(f, app, s);
    }
    let (cols, rows) = (area.width as usize, area.height as usize);
    let mut top = view_a::head(app, cols, rows, true);
    if !s.result.is_empty() {
        top.push(result_line(s, cols - 2, 2));
        top.push(Line::raw(""));
    }
    top.push(view_a::header_line(&s.header));
    top.extend(context_lines(&s.context, cols - 2, 2));
    top.extend(summary_lines(&s.summary, cols - 2, 2));
    top.push(Line::raw(""));
    let [top_area, mid, foot, _] = Layout::vertical([Constraint::Length(top.len() as u16), Constraint::Min(0), Constraint::Length(1), Constraint::Length(1)]).areas(area);
    f.render_widget(Paragraph::new(top), top_area);

    // 목록 폭: 가장 긴 "레이블 + 값" 이 들어갈 만큼 (창의 55% 까지)
    let label_w = s.rows.iter().map(label_width).max().unwrap_or(0);
    let natural = 4 + label_w + 3 + s.rows.iter().map(|r| w(&r.value_text())).max().unwrap_or(0) + 2;
    // 값이 짧아도 값 열이 보이도록 레이블 폭 + 26칸은 잡는다 (rows_as_lines 는 그보다 좁으면 값 열을 접는다)
    let left_w = natural.max(label_w + 26).clamp(30, cols * 55 / 100) as u16;
    let [left, _, right] = Layout::horizontal([Constraint::Length(left_w), Constraint::Length(2), Constraint::Min(30)]).areas(mid);
    let rows_l = view_a::rows_as_lines(&s.rows, s.focus, false, left_w as usize);
    let gaps = s.rows.len() + rows_l.iter().skip(1).filter(|(_, g)| *g).count() <= mid.height as usize;
    let mut list: Vec<L> = Vec::new();
    let mut focus_line = 0;
    for (i, (line, gap)) in rows_l.into_iter().enumerate() {
        if gaps && gap && i > 0 {
            list.push(Line::raw(""));
        }
        if i == s.focus {
            focus_line = list.len();
        }
        list.push(line);
    }
    let list_len = list.len();
    f.render_widget(Paragraph::new(window(list, focus_line, mid.height as usize, 4)), left);

    let Some(r) = s.rows.get(s.focus) else { return };
    let block = panel(&r.label);
    let iw = (right.width as usize).saturating_sub(4);
    let mut lines: Vec<L> = Vec::new();
    if !s.message.is_empty() {
        lines.push(alert_line(theme::WARN, theme::warn(), &s.message, iw, 0));
    }
    for d in &r.desc {
        match d.strip_prefix("! ") {
            Some(_) => lines.push(desc_line(d, iw, 0)),
            None => lines.extend(wrap(d, iw).into_iter().map(Line::raw)),
        }
    }
    if !r.info.is_empty() {
        if !lines.is_empty() {
            lines.push(Line::raw(""));
        }
        lines.extend(summary_lines(&r.info, iw, 0));
    }
    // 상세 패널의 높이는 목록과 맞춘다 (포커스를 옮겨도 패널 크기가 바뀌지 않게)
    let h = (list_len.max(lines.len() + 2) as u16).min(mid.height);
    f.render_widget(Paragraph::new(lines).block(block), Rect::new(right.x, right.y, right.width, h));
    f.render_widget(Paragraph::new(keys_line(&keys_for(app), cols)), foot);
}

// ---------------------------------------------------------------- 마법사
/// 설치 단계 · 여러 개 고르기 · 입력 · 진행. 넓으면 왼쪽에 단계 목록 패널, 좁으면 블록 제목에 위치와 진행 표시 → 커서 위치(입력 화면)
fn wizard(f: &mut Frame, app: &App, screen: &Screen) -> Option<(u16, u16)> {
    let area = f.area();
    let (cols, rows) = (area.width as usize, area.height as usize);
    let art = crate::banner::lines(&app.frame.version, cols, rows, "");
    let gap = u16::from(rows >= 22);
    let [banner_area, _, body, foot] = Layout::vertical([Constraint::Length(art.len() as u16), Constraint::Length(gap), Constraint::Min(0), Constraint::Length(1)]).areas(area);
    f.render_widget(Paragraph::new(art), banner_area);
    f.render_widget(Paragraph::new(keys_line(&keys_for(app), cols)), foot);

    let fr = &app.frame;
    let side = !fr.steps.is_empty() && body.width >= WIDE;
    let right = if side { steps_panel(f, app, body) } else { body };
    let block = if side {
        panel(&loc_title(fr))
    } else if fr.steps.is_empty() {
        panel(&loc_parts(fr).join(" · "))
    } else {
        // 접었을 때: 제목 = `설치 3/8 · 구성요소`, 오른쪽 위 = 진행 표시 (✓ 완료 · ❯ 현재 · `·` 남음)
        let mut marks = vec![Span::raw(" ")];
        for i in 0..fr.steps.len() {
            marks.push(if i < fr.current {
                Span::styled(format!("{} ", theme::OK), theme::ok())
            } else if i == fr.current {
                Span::styled(format!("{} ", theme::POINTER), theme::accent())
            } else {
                Span::raw("· ")
            });
        }
        panel(&loc_parts(fr).join(" · ")).title_top(Line::from(marks).right_aligned())
    };
    let inner = block.inner(right);
    f.render_widget(block, right);
    match screen {
        Screen::Select(s) => {
            select_panel(f, s, inner);
            None
        }
        Screen::Input(i) => Some(input_panel(f, i, inner)),
        Screen::Task(t) => {
            task_panel(f, app, t, inner);
            None
        }
        _ => None,
    }
}

/// 왼쪽 단계 목록 패널 (완료 ✓ / 현재 / 남음) → 오른쪽에 남은 영역
fn steps_panel(f: &mut Frame, app: &App, area: Rect) -> Rect {
    let fr = &app.frame;
    let left_w = (fr.steps.iter().map(|s| w(s)).max().unwrap_or(8) + 6).clamp(16, 26) as u16;
    let [left, right] = Layout::horizontal([Constraint::Length(left_w), Constraint::Min(20)]).areas(area);
    let mut lines: Vec<L> = fr
        .steps
        .iter()
        .enumerate()
        .map(|(i, name)| {
            if i < fr.current {
                Line::from(vec![Span::styled(format!("{} ", theme::OK), theme::ok()), Span::raw(name.clone())])
            } else if i == fr.current {
                Line::from(vec![Span::styled(format!("{} ", theme::POINTER), theme::accent()), Span::styled(name.clone(), theme::focus())])
            } else {
                Line::from(vec![Span::raw("  "), Span::raw(name.clone())])
            }
        })
        .collect();
    if fr.current >= fr.steps.len() {
        // 단계를 모두 지난 뒤: 하는 중이면 ❯ 설치 중, 마쳤으면 ✓ 설치 완료
        let (mark, style) = if fr.finished { (theme::OK, theme::ok()) } else { (theme::POINTER, theme::accent()) };
        lines.push(Line::raw(""));
        lines.push(Line::from(vec![Span::styled(format!("{mark} "), style), Span::styled(crate::parts::stage(fr), theme::focus())]));
    }
    f.render_widget(Paragraph::new(lines).block(panel(if fr.title.is_empty() { "설치" } else { fr.title.as_str() })), left);
    right
}

/// 질문 · 맥락 · 선택지. 설명은 블록 맨 아래에 고정한다
fn select_panel(f: &mut Frame, s: &SelectSpec, area: Rect) {
    let iw = area.width as usize;
    let height = area.height as usize;
    let head = |ctx: bool, listgap: bool| {
        let mut top: Vec<L> = Vec::new();
        if !s.result.is_empty() {
            top.push(result_line(s, iw, 0));
            top.push(Line::raw(""));
        }
        // 헤더 / 빈 줄 / 맥락 · 요약 / 빈 줄 / 선택지. 맥락도 요약도 없으면 빈 줄은 하나다
        top.push(Line::styled(s.header.clone(), theme::strong()));
        top.push(Line::raw(""));
        let before = top.len();
        if ctx || s.keep {
            top.extend(context_lines(&s.context, iw, 0));
        }
        top.extend(summary_lines(&s.summary, iw, 0));
        if top.len() > before && listgap {
            top.push(Line::raw(""));
        }
        top
    };
    // 자리가 모자라면: 설명 2줄→1줄 → 선택지 위 빈 줄 → 맥락 접기 → 묶음 사이 빈 줄 → 목록 스크롤
    let mut desc_n = desc_rows(s);
    let mut top = head(true, true);
    if top.len() + s.rows.len() + 1 + desc_n > height {
        desc_n = desc_n.min(1);
    }
    if top.len() + s.rows.len() + 1 + desc_n > height {
        top = head(true, false);
    }
    if top.len() + s.rows.len() + 1 + desc_n > height {
        top = head(false, false);
    }
    let room = height.saturating_sub(top.len() + 1 + desc_n);
    let gaps = s.rows.len() + s.rows.iter().skip(1).filter(|r| r.gap).count() <= room;
    let label_w = s.rows.iter().map(label_width).max().unwrap_or(0).min(iw * 2 / 5);
    let mut list: Vec<L> = Vec::new();
    let mut focus_line = 0;
    for (i, r) in s.rows.iter().enumerate() {
        if gaps && r.gap && i > 0 {
            list.push(Line::raw(""));
        }
        if i == s.focus {
            focus_line = list.len();
        }
        list.push(Line::from(row_spans(r, i == s.focus, s.multi, label_w, iw, true)));
    }
    top.extend(window(list, focus_line, room, 2));
    let [list_area, _, desc_area] = Layout::vertical([Constraint::Min(0), Constraint::Length(1), Constraint::Length(desc_n as u16)]).areas(area);
    f.render_widget(Paragraph::new(top), list_area);
    f.render_widget(Paragraph::new(select_desc(s, iw)), desc_area);
}

/// 이름 · 맥락 · 테두리 있는 입력 칸 · 검증 오류 → 커서 위치
fn input_panel(f: &mut Frame, i: &InputSpec, area: Rect) -> (u16, u16) {
    let iw = area.width as usize;
    // 이름 / 빈 줄 / 맥락 / 빈 줄 / 입력 칸
    let mut top: Vec<L> = vec![Line::styled(i.header.clone(), theme::strong()), Line::raw("")];
    if !i.context.is_empty() {
        top.extend(context_lines(&i.context, iw, 0));
        top.push(Line::raw(""));
    }
    let [head, field, msg, _] = Layout::vertical([Constraint::Length(top.len() as u16), Constraint::Length(3), Constraint::Length(2), Constraint::Min(0)]).areas(area);
    f.render_widget(Paragraph::new(top), head);
    let border = if i.error.is_empty() { theme::accent() } else { theme::err() };
    let block = Block::bordered().border_style(border).padding(Padding::horizontal(1));
    let inner = block.inner(field);
    let shown = tail(&shown_value(i), (inner.width as usize).saturating_sub(1));
    let x = inner.x + w(&shown) as u16;
    f.render_widget(Paragraph::new(shown).block(block), field);
    if !i.error.is_empty() {
        let lines: Vec<L> = wrap(&i.error, iw.saturating_sub(2))
            .into_iter()
            .enumerate()
            .map(|(n, l)| if n == 0 { alert_line(theme::ERR, theme::err(), &l, iw, 0) } else { Line::raw(format!("  {l}")) })
            .collect();
        f.render_widget(Paragraph::new(lines), msg);
    }
    (x, inner.y)
}

/// 제목 · 본문 · 게이지 · 작업 목록. 넘치면 최근 줄을 보인다
fn task_panel(f: &mut Frame, app: &App, t: &TaskSpec, area: Rect) {
    let iw = area.width as usize;
    // 제목과 본문 줄(대상 경로 등) → 게이지 → 작업 목록
    let mut top: Vec<L> = Vec::new();
    if !t.title.is_empty() {
        top.push(Line::styled(trunc(&t.title, iw), theme::strong()));
    }
    let (lines_only, items_only) = (TaskSpec { items: vec![], percent: -1, ..t.clone() }, TaskSpec { lines: vec![], ..t.clone() });
    top.extend(task_body(app, &lines_only, iw, 0, false));
    let gauge_h = if t.percent >= 0 { 3 } else { 0 };
    let top_h = (top.len() as u16).min(area.height.saturating_sub(gauge_h + 1));
    let [head, gauge, _, list] = Layout::vertical([Constraint::Length(top_h), Constraint::Length(gauge_h), Constraint::Length(u16::from(!top.is_empty())), Constraint::Min(0)]).areas(area);
    f.render_widget(Paragraph::new(top), head);
    if t.percent >= 0 {
        let [_, bar, count] = Layout::vertical([Constraint::Length(1), Constraint::Length(1), Constraint::Length(1)]).areas(gauge);
        // 막대 안에는 글자를 넣지 않는다 (채운 부분 위의 글자는 대비가 낮다). 숫자는 아랫줄에
        let ratio = f64::from(t.percent.clamp(0, 100)) / 100.0;
        f.render_widget(Gauge::default().ratio(ratio).label("").gauge_style(Style::new().fg(theme::accent_color()).bg(theme::track_color())), bar);
        f.render_widget(Paragraph::new(Line::raw(format!("{}%", t.percent))), count);
    }
    // 넘치면 최근 줄을 보인다 (진행 중인 작업이 아래에 있다)
    let body = task_body(app, &items_only, iw, 0, false);
    let skip = body.len().saturating_sub(list.height as usize);
    f.render_widget(Paragraph::new(body.into_iter().skip(skip).collect::<Vec<L>>()), list);
}

// ---------------------------------------------------------------- 팝업
/// 확인 팝업: 질문 · 요약표 · 되돌릴 수 없는 결과 · 버튼 두 개. 위험한 확인은 테두리가 노랑
fn confirm_popup(f: &mut Frame, c: &ConfirmSpec, area: Rect) {
    let width = (area.width.saturating_sub(6)).min(70);
    let iw = width.saturating_sub(4) as usize;
    let mut lines: Vec<L> = wrap(&c.header, iw).into_iter().map(|l| Line::styled(l, theme::strong())).collect();
    lines.extend(context_lines(&c.context, iw, 0));
    if !c.summary.is_empty() {
        lines.push(Line::raw(""));
        // 버튼은 항상 보여야 한다: 요약이 길어 팝업이 창보다 커지면 요약을 줄인다 (경고 · 버튼 줄은 남긴다)
        let tail = if c.warning.is_empty() { 2 } else { 4 };
        let room = (area.height as usize).saturating_sub(2 + lines.len() + tail).max(1);
        let mut summary = summary_lines(&c.summary, iw, 0);
        if summary.len() > room {
            // 경로 값을 줄바꿈하지 않고 가운데 말줄임 한 줄로 줄인다 (끝의 폴더 이름이 남는다)
            let kw = c.summary.iter().map(|(k, _)| w(k)).max().unwrap_or(0);
            let short: Vec<(String, String)> = c
                .summary
                .iter()
                .map(|(k, v)| (k.clone(), if crate::text::is_path(v) { crate::text::trunc_path(v, iw.saturating_sub(kw + 3)) } else { v.clone() }))
                .collect();
            summary = summary_lines(&short, iw, 0);
        }
        if summary.len() > room {
            summary.truncate(room.saturating_sub(1));
            summary.push(Line::raw("…"));
        }
        lines.extend(summary);
    }
    if !c.warning.is_empty() {
        lines.push(Line::raw(""));
        lines.push(desc_line(&format!("! {}", c.warning), iw, 0));
    }
    lines.push(Line::raw(""));
    let buttons = [Button { label: &c.yes, on: c.on_yes, danger: c.danger }, Button { label: &c.no, on: !c.on_yes, danger: false }];
    dialog(f, area, width, &c.title, lines, &buttons, c.danger);
}

fn help_popup(f: &mut Frame, s: &SelectSpec, area: Rect) {
    let width = (area.width.saturating_sub(6)).min(70);
    let lines = help_text(s, width.saturating_sub(4) as usize);
    let block = Block::bordered().border_style(theme::accent()).padding(Padding::horizontal(1)).title(Line::from(vec![Span::raw(" "), Span::styled("도움말", theme::strong()), Span::raw(" ")]));
    let rect = centered(area, width, lines.len() as u16 + 2);
    f.render_widget(Clear, widen(rect, area));
    f.render_widget(Paragraph::new(lines).block(block), rect);
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::Terminal;
    use ratatui::backend::TestBackend;

    /// 확인 팝업을 `parts::dialog` 로 옮겨도 설치 화면의 모양은 그대로다: 넉넉한 버튼(앞뒤 2칸 · 사이 3칸), 위험이면 `! ` 와 경고색 테두리
    #[test]
    fn confirm_popup_keeps_the_install_screen_shape() {
        let c = ConfirmSpec {
            title: "제거".into(),
            header: "이 PC에서 제거할까요?".into(),
            warning: "삭제하면 복구할 수 없습니다.".into(),
            yes: "설치 폴더 삭제".into(),
            no: "제거 취소".into(),
            danger: true,
            ..ConfirmSpec::default()
        };
        let mut term = Terminal::new(TestBackend::new(100, 20)).unwrap();
        term.draw(|f| confirm_popup(f, &c, f.area())).unwrap();
        let buf = term.backend().buffer().clone();
        let row = |y: u16| -> String {
            let mut s = String::new();
            let mut x = 0;
            while x < 100 {
                let sym = buf[(x, y)].symbol();
                s.push_str(sym);
                x += w(sym).max(1) as u16;
            }
            s.trim().to_string()
        };
        let rows: Vec<String> = (0..20).map(row).filter(|r| !r.is_empty()).collect();
        assert_eq!(rows.len(), 7, "{rows:?}");
        assert!(rows[0].starts_with("┌ 제거 ") && rows[0].ends_with('┐') && rows[6].starts_with('└'), "{rows:?}");
        assert_eq!(rows[1].trim_matches('│').trim(), "이 PC에서 제거할까요?");
        assert_eq!(rows[3].trim_matches('│').trim(), "! 삭제하면 복구할 수 없습니다.");
        assert!(rows[5].contains("! 설치 폴더 삭제       제거 취소"), "{rows:?}");
        // 포커스는 취소(on_yes=false): 취소만 반전, 테두리는 경고색(노랑)
        let at = |label: &str| (0..20).find_map(|y| (0..100).find(|&x| buf[(x, y)].symbol() == label).map(|x| (x, y))).unwrap();
        let (x, y) = at("취");
        assert!(buf[(x, y)].style().add_modifier.contains(Modifier::REVERSED) && buf[(x, y)].style().fg == Some(theme::accent_color()));
        let (x, y) = at("설");
        assert!(!buf[(x, y)].style().add_modifier.contains(Modifier::REVERSED));
        let (x, y) = at("┌");
        assert_eq!(buf[(x, y)].style().fg, Some(Color::Yellow));
    }
}
