//! 배너 `O² xy GEN PI`. 모든 화면 맨 위에 고정한다. 그리는 곳은 `lines()` 하나다 (모양을 바꿀 때 여기만 고친다).
//! 산소(O²)처럼 가볍고, 생성형 AI 의 GEN 과 코딩 에이전트 PI 를 함께 드러낸다: `O` + (위에 2, 그 아래 작은 xy) + `GEN` + `PI`.
//! `O` · `GEN` 은 초록 그러데이션, `PI` 는 pi coding agent 의 색(보라)이다. 글자마다 오른쪽 아래에 그림자가 있어 입체로 보인다.
//!   큰 배너 6줄 (폭 ≥ 64 · 높이 ≥ BIG_MIN_ROWS = 24): ANSI Shadow 글자꼴. `█` 는 줄마다 밝은 색 → 짙은 색, 그림자 선(╗╔═║╝╚)은 어두운 색.
//!                                             `O` 와 `GEN` 사이의 7칸 기둥에 3×5 픽셀 글자 `2`(위) 와 `xy`(큰 글자의 밑선) 를 반 칸 블록으로 찍는다. 폭 59칸
//!   그 밖의 창:                               한 줄 `O²xyGEN PI  v0.1.0`
//! 단계는 이 둘뿐이다 (그림을 줄인 중간 크기는 두지 않는다: `2` 와 `xy` 를 같은 모양으로 그릴 수 없다).
//! 버전은 1행 오른쪽 끝, 위치는 2행 오른쪽 끝, 폭 ≥ 100 이면 마지막 줄 오른쪽 끝에 부제. 색을 끄면(`NO_COLOR`) 같은 글자를 색 없이 그린다.
use ratatui::style::{Modifier, Style, Stylize};
use ratatui::text::{Line, Span};

use crate::text::w;
use crate::theme::{self, Rgb, palette, rgb};

const SUBTITLE: &str = "Coding Agent for Closed Network";

/// 큰 배너(6줄)를 쓰는 최소 창 높이. 기준 창(80×24)에도 큰 배너를 그린다. 그보다 낮은 창은 한 줄 글자
pub const BIG_MIN_ROWS: usize = 24;

type Spans = Vec<Span<'static>>;

fn colored(text: String, color: Rgb) -> Span<'static> {
    if theme::no_color() { Span::raw(text) } else { Span::styled(text, Style::new().fg(rgb(color))) }
}

/// 위·아래 픽셀 한 쌍을 반 칸 블록 한 글자로 (글자색 = 위, 배경색 = 아래)
fn half_block(top: Option<Rgb>, bottom: Option<Rgb>) -> Span<'static> {
    if theme::no_color() {
        return Span::raw(match (top.is_some(), bottom.is_some()) {
            (true, true) => "█",
            (true, false) => "▀",
            (false, true) => "▄",
            _ => " ",
        });
    }
    match (top, bottom) {
        (Some(t), Some(b)) => Span::styled("▀", Style::new().fg(rgb(t)).bg(rgb(b))),
        (Some(t), None) => Span::styled("▀", Style::new().fg(rgb(t))),
        (None, Some(b)) => Span::styled("▄", Style::new().fg(rgb(b))),
        (None, None) => Span::raw(" "),
    }
}

/// 픽셀 격자(grid[y][x])를 반 칸 블록 줄들로
fn half_rows(grid: &[Vec<Option<Rgb>>]) -> Vec<Spans> {
    grid.chunks(2).map(|pair| (0..pair[0].len()).map(|x| half_block(pair[0][x], pair.get(1).and_then(|r| r[x]))).collect()).collect()
}

/// ANSI Shadow 글자꼴 (6줄)
fn shadow_glyph(ch: char) -> [&'static str; 6] {
    match ch {
        'O' => [" ██████╗ ", "██╔═══██╗", "██║   ██║", "██║   ██║", "╚██████╔╝", " ╚═════╝ "],
        'G' => [" ██████╗ ", "██╔════╝ ", "██║  ███╗", "██║   ██║", "╚██████╔╝", " ╚═════╝ "],
        'E' => ["███████╗", "██╔════╝", "█████╗  ", "██╔══╝  ", "███████╗", "╚══════╝"],
        'N' => ["███╗   ██╗", "████╗  ██║", "██╔██╗ ██║", "██║╚██╗██║", "██║ ╚████║", "╚═╝  ╚═══╝"],
        'P' => ["██████╗ ", "██╔══██╗", "██████╔╝", "██╔═══╝ ", "██║     ", "╚═╝     "],
        'I' => ["██╗", "██║", "██║", "██║", "██║", "╚═╝"],
        _ => ["   ", "   ", "   ", "   ", "   ", "   "],
    }
}

/// 큰 글자 한 낱말. ramp: `█` 의 줄별 색 다섯 + 그림자 선의 색 하나
fn shadow_word(text: &str, ramp: &[Rgb; 6]) -> Vec<Spans> {
    (0..6)
        .map(|r| {
            text.chars()
                .flat_map(|ch| shadow_glyph(ch)[r].chars())
                .map(|c| match c {
                    ' ' => Span::raw(" "),
                    '█' => colored(c.to_string(), ramp[r]),
                    _ => colored(c.to_string(), ramp[5]),
                })
                .collect()
        })
        .collect()
}

/// 작은 글자 기둥 (7칸 × 6줄): 위에 흰색 `2`, 그 아래 `xy` 를 큰 글자의 밑선에 맞춰. 3×5 픽셀 글자꼴을 반 칸 블록으로
fn small_column() -> Vec<Spans> {
    let p = palette();
    let two = ["██ ", "  █", " █ ", "█  ", "███"];
    let x = ["█ █", " █ ", "█ █"];
    let y = ["█ █", "█ █", " ██", "  █", " █ "];
    let mut grid = vec![vec![None::<Rgb>; 7]; 12];
    let mut put = |glyph: &[&str], x0: usize, y0: usize, color: Rgb| {
        for (dy, row) in glyph.iter().enumerate() {
            for (dx, c) in row.chars().enumerate() {
                if c == '█' {
                    grid[y0 + dy][x0 + dx] = Some(color);
                }
            }
        }
    };
    put(&two, 0, 0, p.white);
    put(&x, 0, 7, p.mid);
    put(&y, 4, 7, p.mid);
    half_rows(&grid)
}

/// 배너의 줄 수 (아래 빈 줄 제외)
pub fn height(cols: usize, rows: usize) -> usize {
    if cols >= 64 && rows >= BIG_MIN_ROWS { 6 } else { 1 }
}

/// 배너 줄들 (아래 빈 줄은 포함하지 않는다). aside: 위치 줄을 접었을 때 둘째 줄 오른쪽 끝에 붙일 짧은 위치 (들어갈 때만)
pub fn lines(version: &str, cols: usize, rows: usize, aside: &str) -> Vec<Line<'static>> {
    let p = palette();
    let ver = if version.is_empty() { String::new() } else { format!("v{version}") };
    // 오른쪽 끝(창 끝에서 2칸 안쪽)에 회색 글자를 붙인다. 자리가 모자라면 줄이고, 6칸도 안 되면 붙이지 않는다
    let right = |mut spans: Spans, text: &str| {
        let used: usize = spans.iter().map(|s| w(&s.content)).sum();
        let room = cols.saturating_sub(used + 3);
        if !text.is_empty() && room >= 6 {
            let text = crate::text::trunc(text, room);
            spans.push(Span::raw(" ".repeat(cols - 2 - used - w(&text))));
            spans.push(Span::styled(text, theme::sub()));
        }
        Line::from(spans)
    };
    let n = height(cols, rows);
    let side = |i: usize| if i == 0 { ver.as_str() } else if i == 1 { aside } else if i + 1 == n && cols >= 100 { SUBTITLE } else { "" };
    match n {
        6 => {
            let (o, col, gen_, pi) = (shadow_word("O", &p.rows6), small_column(), shadow_word("GEN", &p.rows6), shadow_word("PI", &p.pi6));
            (0..6)
                .map(|i| {
                    let mut spans: Spans = vec![Span::raw("  ")];
                    spans.extend(o[i].iter().cloned());
                    spans.extend(col[i].iter().cloned());
                    spans.push(Span::raw(" "));
                    spans.extend(gen_[i].iter().cloned());
                    spans.push(Span::raw("  "));
                    spans.extend(pi[i].iter().cloned());
                    right(spans, side(i))
                })
                .collect()
        }
        _ => {
            let bold = |s: &str, c: Rgb| colored(s.to_string(), c).add_modifier(Modifier::BOLD);
            let mark = vec![Span::raw("  "), bold("O²", p.light), colored("xy".to_string(), p.mid), bold("GEN", p.light), Span::raw(" "), bold("PI", p.pi6[3]), Span::raw("  "), Span::styled(ver, theme::sub())];
            vec![right(mark, aside)]
        }
    }
}

/// 본 화면에 남기는 한 줄 머리말 (데모 종료 줄)
pub fn wordmark(version: &str) -> String {
    if version.is_empty() { "OXYGEN PI SYSTEM".to_string() } else { format!("OXYGEN PI SYSTEM v{version}") }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain(l: &Line) -> String {
        l.spans.iter().map(|s| s.content.as_ref()).collect()
    }

    #[test]
    fn two_sizes_with_fixed_widths() {
        // 큰 배너는 폭 64칸 · 높이 24줄부터. 그보다 작으면 한 줄 (중간 크기는 없다)
        for (cols, rows, want) in [(120, 30, 6), (80, 30, 6), (80, 24, 6), (64, 24, 6), (63, 24, 1), (80, 23, 1), (60, 18, 1)] {
            let a = lines("0.1.0", cols, rows, "설정");
            assert_eq!((a.len(), height(cols, rows)), (want, want), "{cols}x{rows}");
            assert!(a.iter().all(|l| w(&plain(l)) <= cols - 2), "{cols}x{rows}");
        }
        let big = lines("", 80, 24, "");
        assert!(big.iter().all(|l| w(&plain(l)) == 59), "큰 배너는 줄마다 59칸: {:?}", big.iter().map(|l| w(&plain(l))).collect::<Vec<_>>());
        assert_eq!(plain(&lines("0.1.0", 60, 18, "")[0]), "  O²xyGEN PI  v0.1.0");
    }

    #[test]
    fn version_aside_and_subtitle_sit_at_the_right_edge() {
        let a = lines("0.1.0", 80, 24, "3/8 구성요소");
        assert!(plain(&a[0]).ends_with("v0.1.0") && plain(&a[1]).ends_with("3/8 구성요소") && !plain(&a[5]).contains(SUBTITLE));
        // 80칸에서 배너 오른쪽에 남는 자리는 16칸: 딱 맞으면 그대로, 넘치면 줄인다
        assert!(plain(&lines("0.1.0", 80, 24, "서버 주소·API 키")[1]).ends_with(" 서버 주소·API 키"));
        let cut = plain(&lines("0.1.0", 80, 24, "설정 · LLM 연결 · 요청 설정")[1]);
        assert!(cut.ends_with('…') && w(&cut) == 78, "{cut}");
        let wide = lines("0.1.0", 120, 30, "");
        assert!(plain(&wide[0]).ends_with("v0.1.0") && plain(&wide[5]).ends_with(SUBTITLE));
    }

    #[test]
    fn pi_is_painted_in_the_pi_colour_and_letters_have_shadows() {
        let p = palette();
        let pi = shadow_word("PI", &p.pi6);
        assert_eq!(pi[0][0].style.fg, Some(rgb(p.pi6[0])));
        assert_eq!(pi[5][0].style.fg, Some(rgb(p.pi6[5])), "마지막 줄은 그림자 선");
        // 기둥: 맨 위는 흰색 2, 맨 아래는 xy
        let col = small_column();
        assert_eq!((col.len(), col[0].len()), (6, 7));
        assert_eq!(col[0][0].style.fg, Some(rgb(p.white)));
        assert!(col[5].iter().any(|s| s.style.fg == Some(rgb(p.mid))));
    }
}
