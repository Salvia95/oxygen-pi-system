//! 두 시안이 함께 쓰는 조각: 위치 줄 · 키 안내 · 목록 행 · 설명 문장 · 요약표 · 도움말 내용.
use ratatui::text::{Line, Span};

use crate::model::{App, FrameSpec, Row, Screen, SelectSpec};
use crate::text::{pad, trunc, trunc_path, w, wrap};
use crate::theme;

/// 단계를 모두 지난 뒤의 상태 낱말 (`설치 중` · `설치 완료`)
pub fn stage(f: &FrameSpec) -> String {
    if f.stage.is_empty() { "진행 중".to_string() } else { f.stage.clone() }
}

/// 위치를 조각으로: 설치 단계는 ["설치 3/8", "구성요소"], 단계를 지난 뒤에는 ["설치 중"], 설정은 경로 조각
pub fn loc_parts(f: &FrameSpec) -> Vec<String> {
    if f.steps.is_empty() {
        return f.path.clone();
    }
    let title = if f.title.is_empty() { "설치" } else { f.title.as_str() };
    if f.current >= f.steps.len() {
        vec![stage(f)]
    } else {
        vec![format!("{title} {}/{}", f.current + 1, f.steps.len()), f.steps[f.current].clone()]
    }
}

/// 위치 줄을 접었을 때 배너 오른쪽에 붙이는 짧은 위치 (단계는 짧은 이름: 80칸 창에서 배너 오른쪽에 남는 자리는 16칸)
pub fn loc_short(f: &FrameSpec) -> String {
    if f.steps.is_empty() {
        return f.path.last().cloned().unwrap_or_default();
    }
    if f.current >= f.steps.len() {
        stage(f)
    } else {
        format!("{}/{} {}", f.current + 1, f.steps.len(), f.short.get(f.current).unwrap_or(&f.steps[f.current]))
    }
}

/// 단계 블록의 제목: `3/8 구성요소` (긴 이름)
pub fn loc_title(f: &FrameSpec) -> String {
    if f.steps.is_empty() {
        return f.path.last().cloned().unwrap_or_default();
    }
    if f.current >= f.steps.len() { stage(f) } else { format!("{}/{} {}", f.current + 1, f.steps.len(), f.steps[f.current]) }
}

/// 위치 줄: 조각을 ` · ` 로 잇고, 오른쪽 끝에 설치 폴더(가운데 말줄임)
pub fn loc_line(f: &FrameSpec, cols: usize) -> Line<'static> {
    let parts = loc_parts(f);
    let mut spans = vec![Span::raw("  ")];
    for (i, p) in parts.iter().enumerate() {
        if i > 0 {
            spans.push(Span::styled(" · ", theme::sub()));
        }
        spans.push(Span::styled(p.clone(), if i + 1 == parts.len() { theme::strong() } else { theme::text() }));
    }
    let used: usize = spans.iter().map(|s| w(&s.content)).sum();
    if !f.right.is_empty() && cols > used + 16 {
        let r = trunc_path(&f.right, (cols - used - 6).min(60));
        spans.push(Span::raw(" ".repeat(cols - 2 - used - w(&r))));
        spans.push(Span::styled(r, theme::sub()));
    }
    Line::from(spans)
}

/// 키 안내: 키는 기본색, 뜻은 보조색. 폭이 모자라면 뒤에서부터 뺀다
pub fn keys_line(keys: &[(String, String)], cols: usize) -> Line<'static> {
    let mut list: Vec<&(String, String)> = keys.iter().collect();
    let width = |l: &Vec<&(String, String)>| l.iter().map(|(k, v)| w(k) + 1 + w(v)).sum::<usize>() + 3 * l.len().saturating_sub(1);
    while list.len() > 1 && width(&list) + 4 > cols {
        list.pop();
    }
    let mut spans = vec![Span::raw("  ")];
    for (i, (k, v)) in list.iter().enumerate() {
        if i > 0 {
            spans.push(Span::raw("   "));
        }
        spans.push(Span::styled(k.clone(), theme::strong()));
        spans.push(Span::raw(" "));
        spans.push(Span::styled(v.clone(), theme::hint()));
    }
    Line::from(spans)
}

fn key(k: &str, v: &str) -> (String, String) {
    (k.to_string(), v.to_string())
}

/// 지금 화면의 키 안내 목록 (폭이 모자라면 뒤에서부터 뺀다)
pub fn keys_for(app: &App) -> Vec<(String, String)> {
    // 잠깐의 작업을 알리는 중: 키 안내 대신 돌아가는 표시 + 하는 일
    if let Some(label) = &app.busy {
        return vec![(theme::SPINNER[app.tick % theme::SPINNER.len()].to_string(), label.clone())];
    }
    if app.help {
        return vec![key("아무 키", "닫기")];
    }
    if let Some(label) = &app.pause {
        return vec![("Enter".to_string(), label.clone())];
    }
    let or = |s: &str, d: &str| if s.is_empty() { d.to_string() } else { s.to_string() };
    match &app.screen {
        Screen::Idle => vec![],
        Screen::Task(_) => vec![key("Ctrl+C", "중단")],
        Screen::Input(i) => {
            let mut k = vec![("Enter".to_string(), or(&i.enter, "확인"))];
            if !i.esc.is_empty() {
                k.push(("Esc".to_string(), i.esc.clone()));
            }
            k.push(key("Ctrl+U", "모두 지우기"));
            k
        }
        // 확인 팝업의 선택지는 좌우로 놓인다
        Screen::Confirm(_) => vec![key("←→", "이동"), key("Enter", "선택"), key("Esc", "취소")],
        Screen::Select(s) => {
            let mut k = vec![(format!("{}{}", theme::UP, theme::DOWN), "이동".to_string())];
            if s.multi {
                k.push(key("Space", "선택/해제"));
            }
            k.push(("Enter".to_string(), or(&s.enter, if s.multi { "확인" } else { "선택" })));
            if !s.esc.is_empty() {
                k.push(("Esc".to_string(), s.esc.clone()));
            }
            if has_help(s) {
                k.push(key("?", "도움말"));
            }
            k
        }
    }
}

/// 도움말은 볼 것이 있을 때만: 접힐 수 있는 맥락 문장이 있거나, 관련 정보가 있는 항목이 있을 때
pub fn has_help(s: &SelectSpec) -> bool {
    (!s.context.is_empty() && !s.keep) || s.rows.iter().any(|r| !r.info.is_empty())
}

/// 레이블 + `(추천)` `(현재)` 의 표시 폭
pub fn label_width(r: &Row) -> usize {
    (if r.danger { 2 } else { 0 }) + w(&r.label) + (if r.recommended { 7 } else { 0 }) + (if r.current { 7 } else { 0 })
}

/// 목록 한 행: 포인터 · [체크] · 레이블 · 값 열. width 는 이 행에 쓸 수 있는 폭
pub fn row_spans(r: &Row, focused: bool, multi: bool, label_w: usize, width: usize, show_value: bool) -> Vec<Span<'static>> {
    let mut spans = vec![if focused { Span::styled(format!("{} ", theme::POINTER), theme::accent()) } else { Span::raw("  ") }];
    if multi {
        spans.push(if r.locked {
            Span::styled("[■] ", theme::sub())
        } else if r.disabled {
            Span::styled("[·] ", theme::sub())
        } else if r.checked {
            Span::styled(format!("[{}] ", theme::OK), theme::ok())
        } else {
            Span::raw("[ ] ")
        });
    }
    if r.danger {
        spans.push(Span::styled(format!("{} ", theme::WARN), theme::warn()));
    }
    spans.push(Span::styled(r.label.clone(), if r.disabled { theme::sub() } else if focused { theme::focus() } else { theme::strong() }));
    if r.recommended {
        spans.push(Span::styled(" (추천)", theme::ok()));
    }
    if r.current {
        spans.push(Span::styled(" (현재)", theme::sub()));
    }
    let v = r.value_text();
    if show_value && !v.is_empty() {
        let used: usize = spans.iter().map(|s| w(&s.content)).sum();
        let gap = label_w.saturating_sub(label_width(r)) + 3;
        if width > used + gap + 6 {
            spans.push(Span::raw(" ".repeat(gap)));
            // 값이 경로이거나 경로로 끝나면 경로의 가운데를 줄인다 (끝의 폴더 이름이 남게)
            let room = width - used - gap;
            let shown = crate::text::fit(&v, room);
            spans.push(Span::styled(shown, theme::value()));
        }
    }
    spans
}

/// 설명 문장 한 줄. `! ` 로 시작하면 위험한 결과 (노란 ! + 기본색 문장)
pub fn desc_line(s: &str, width: usize, indent: usize) -> Line<'static> {
    let ind = " ".repeat(indent);
    match s.strip_prefix("! ") {
        Some(rest) => Line::from(vec![Span::raw(ind), Span::styled(format!("{} ", theme::WARN), theme::warn()), Span::styled(trunc(rest, width.saturating_sub(indent + 2)), theme::strong())]),
        None => Line::from(vec![Span::raw(ind), Span::raw(trunc(s, width.saturating_sub(indent)))]),
    }
}

/// 차단 안내 · 검증 오류 한 줄
pub fn alert_line(mark: &'static str, style: ratatui::style::Style, s: &str, width: usize, indent: usize) -> Line<'static> {
    Line::from(vec![Span::raw(" ".repeat(indent)), Span::styled(format!("{mark} "), style), Span::raw(trunc(s, width.saturating_sub(indent + 2)))])
}

/// 이름–값 요약표. 값은 폭에 맞춰 줄바꿈한다 (경로는 자르지 않는다). 이름이 빈 행은 윗줄의 이어짐
pub fn summary_lines(pairs: &[(String, String)], width: usize, indent: usize) -> Vec<Line<'static>> {
    let kw = pairs.iter().map(|(k, _)| w(k)).max().unwrap_or(0);
    let mut out = Vec::new();
    for (k, v) in pairs {
        for (i, part) in wrap(v, width.saturating_sub(indent + kw + 3)).into_iter().enumerate() {
            out.push(Line::from(vec![
                Span::raw(" ".repeat(indent)),
                Span::styled(pad(if i == 0 { k } else { "" }, kw), theme::hint()),
                Span::raw("   "),
                Span::raw(part),
            ]));
        }
    }
    out
}

/// 맥락 줄들. 공백으로 시작하는 줄은 미리 열을 맞춘 줄이라 줄바꿈하지 않고 자른다 (점검 결과 · 요약표)
pub fn context_lines(ctx: &[String], width: usize, indent: usize) -> Vec<Line<'static>> {
    let ind = " ".repeat(indent);
    ctx.iter()
        .flat_map(|c| if c.starts_with(' ') { vec![trunc(c, width.saturating_sub(indent))] } else { wrap(c, width.saturating_sub(indent)) })
        .map(|l| Line::raw(format!("{ind}{l}")))
        .collect()
}

/// 결과 줄: `✓ 저장했습니다` · `! 문제가 발견되었습니다` · `× 저장하지 못했습니다`
pub fn result_line(s: &SelectSpec, width: usize, indent: usize) -> Line<'static> {
    let (mark, style) = match s.result_kind.as_str() {
        "warn" => (theme::WARN, theme::warn()),
        "err" => (theme::ERR, theme::err()),
        _ => (theme::OK, theme::ok()),
    };
    Line::from(vec![Span::raw(" ".repeat(indent)), Span::styled(format!("{mark} "), style), Span::raw(trunc(&s.result, width.saturating_sub(indent + 2)))])
}

/// `?` 도움말 내용: 맥락 전체 + 포커스한 행의 값 · 설명 · 관련 정보
pub fn help_text(s: &SelectSpec, width: usize) -> Vec<Line<'static>> {
    let mut out: Vec<Line<'static>> = Vec::new();
    for c in &s.context {
        out.extend(wrap(c, width).into_iter().map(Line::raw));
    }
    if let Some(r) = s.rows.get(s.focus) {
        if !out.is_empty() {
            out.push(Line::raw(""));
        }
        out.push(Line::styled(r.label.clone(), theme::strong()));
        let v = r.value_text();
        if !v.is_empty() {
            out.extend(wrap(&v, width).into_iter().map(Line::raw));
        }
        for d in &r.desc {
            out.extend(wrap(d.strip_prefix("! ").unwrap_or(d), width).into_iter().map(Line::raw));
        }
        if !r.info.is_empty() {
            out.push(Line::raw(""));
            out.extend(summary_lines(&r.info, width, 0));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn steps() -> FrameSpec {
        FrameSpec { title: "설치".into(), steps: vec!["환경 점검".into(), "PATH·바로가기".into()], short: vec!["점검".into(), "바로가기".into()], ..FrameSpec::default() }
    }

    #[test]
    fn location_uses_short_step_names_beside_the_banner_and_long_ones_in_titles() {
        let f = FrameSpec { current: 1, ..steps() };
        assert_eq!((loc_short(&f), loc_title(&f)), ("2/2 바로가기".to_string(), "2/2 PATH·바로가기".to_string()));
        assert_eq!(loc_parts(&f), vec!["설치 2/2".to_string(), "PATH·바로가기".to_string()]);
    }

    #[test]
    fn after_the_last_step_the_location_is_the_stage_word() {
        let f = FrameSpec { current: 2, stage: "설치 완료".into(), finished: true, ..steps() };
        assert_eq!((loc_short(&f), loc_title(&f), loc_parts(&f)), ("설치 완료".to_string(), "설치 완료".to_string(), vec!["설치 완료".to_string()]));
        // 상태 낱말을 주지 않았을 때
        assert_eq!(loc_short(&FrameSpec { current: 2, ..steps() }), "진행 중");
    }

    #[test]
    fn result_line_mark_follows_the_kind() {
        let text = |l: &Line| l.spans.iter().map(|s| s.content.as_ref()).collect::<String>();
        let s = SelectSpec { result: "문제가 발견되었습니다".into(), result_kind: "warn".into(), ..SelectSpec::default() };
        assert_eq!(text(&result_line(&s, 60, 2)), "  ! 문제가 발견되었습니다");
        let ok = SelectSpec { result: "저장했습니다".into(), ..SelectSpec::default() };
        assert_eq!(text(&result_line(&ok, 60, 2)), "  ✓ 저장했습니다");
    }

    #[test]
    fn path_values_keep_the_last_folder() {
        let r = Row { label: "기본 위치에 설치".into(), value: r"C:\Users\hong.gildong\AppData\Local\Programs\oxygen-pi".into(), ..Row::default() };
        let line: String = row_spans(&r, false, false, 16, 60, true).iter().map(|s| s.content.as_ref()).collect();
        assert!(line.ends_with(r"\Programs\oxygen-pi") && line.contains('…') && w(&line) <= 60, "{line}");
    }
}
