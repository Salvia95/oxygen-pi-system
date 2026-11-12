//! 표시 폭 기준 글자 처리 (한글·전각은 2칸). 정렬과 말줄임은 모두 여기 함수를 쓴다.
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

pub fn w(s: &str) -> usize {
    s.width()
}

/// 표시 폭 기준으로 오른쪽을 공백으로 채운다
pub fn pad(s: &str, width: usize) -> String {
    format!("{s}{}", " ".repeat(width.saturating_sub(w(s))))
}

/// 끝 말줄임 (…, 1칸). 2칸 글자 중간은 자르지 않는다
pub fn trunc(s: &str, max: usize) -> String {
    if w(s) <= max {
        return s.to_string();
    }
    if max == 0 {
        return String::new();
    }
    let mut out = String::new();
    let mut n = 0;
    for ch in s.chars() {
        let cw = ch.width().unwrap_or(0);
        if n + cw > max - 1 {
            break;
        }
        out.push(ch);
        n += cw;
    }
    out.push('…');
    out
}

/// 줄 전체가 Windows 경로 하나인가 (`C:\…` · `\\서버\…`, 공백 없음)
pub fn is_path(s: &str) -> bool {
    let b = s.as_bytes();
    let drive = b.len() > 2 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/');
    (drive || s.starts_with(r"\\")) && !s.contains(' ')
}

/// Windows 경로 가운데 말줄임: 앞부분 + … + 마지막 두 단계 (그래도 길면 마지막 한 단계)
pub fn trunc_path(p: &str, max: usize) -> String {
    if w(p) <= max {
        return p.to_string();
    }
    let sep = if p.contains('\\') { '\\' } else { '/' };
    let parts: Vec<&str> = p.split(sep).collect();
    for tail in [2usize, 1] {
        if parts.len() <= tail + 1 {
            continue;
        }
        for head in (1..parts.len() - tail).rev() {
            let mut v: Vec<&str> = parts[..head].to_vec();
            v.push("…");
            v.extend_from_slice(&parts[parts.len() - tail..]);
            let cand = v.join(&sep.to_string());
            if w(&cand) <= max {
                return cand;
            }
        }
    }
    trunc(p, max)
}

/// 한 줄을 폭에 맞춘다. 줄 전체나 마지막 낱말이 경로면 그 경로의 가운데를 줄이고, 그 밖에는 끝을 줄인다
/// (`SQLite · C:/Users/kim/…/data/app.db`)
pub fn fit(s: &str, max: usize) -> String {
    if w(s) <= max {
        return s.to_string();
    }
    if is_path(s) {
        return trunc_path(s, max);
    }
    if let Some(at) = s.rfind(' ') {
        let (head, tail) = s.split_at(at + 1);
        let room = max.saturating_sub(w(head));
        if is_path(tail) && room >= 12 {
            let t = trunc_path(tail, room);
            if w(&t) <= room {
                return format!("{head}{t}");
            }
        }
    }
    trunc(s, max)
}

/// 줄바꿈: 낱말(공백) 단위로 넘긴다. 한 줄보다 긴 낱말(경로)만 `\` · `/` 뒤에서, 그래도 길면 글자 경계에서 나눈다
pub fn wrap(s: &str, max: usize) -> Vec<String> {
    let max = max.max(4);
    let mut lines: Vec<String> = Vec::new();
    let mut cur = String::new();
    let push = |cur: &mut String, lines: &mut Vec<String>| {
        if !cur.trim().is_empty() {
            lines.push(cur.trim_end().to_string());
        }
        cur.clear();
    };
    for word in s.split_inclusive(' ') {
        if w(&cur) + w(word.trim_end()) <= max {
            cur.push_str(word);
            continue;
        }
        if w(word.trim_end()) <= max {
            push(&mut cur, &mut lines);
            cur.push_str(word);
            continue;
        }
        for piece in word.split_inclusive(['\\', '/']) {
            if w(&cur) + w(piece) <= max {
                cur.push_str(piece);
                continue;
            }
            push(&mut cur, &mut lines);
            let mut rest = piece;
            while w(rest) > max {
                let mut end = 0;
                let mut n = 0;
                for (i, ch) in rest.char_indices() {
                    let cw = ch.width().unwrap_or(0);
                    if n + cw > max {
                        break;
                    }
                    n += cw;
                    end = i + ch.len_utf8();
                }
                lines.push(rest[..end].to_string());
                rest = &rest[end..];
            }
            cur.push_str(rest);
        }
    }
    push(&mut cur, &mut lines);
    if lines.is_empty() {
        lines.push(String::new());
    }
    lines
}

/// 1234567 → 1,234,567
pub fn num(n: u64) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, ch) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fit_shortens_a_trailing_path_in_the_middle() {
        let s = "✓ tdb 연결을 저장했습니다  SQLite · C:/Users/kim/AppData/Local/Temp/work/project-0123456789abcdef/scratch/sb/t.db";
        let f = fit(s, 78);
        assert!(w(&f) <= 78, "{f}");
        assert!(f.starts_with("✓ tdb 연결을 저장했습니다  SQLite · C:/"), "{f}");
        assert!(f.ends_with("/sb/t.db"), "{f}");
        assert_eq!(fit("짧은 줄", 78), "짧은 줄");
        assert_eq!(fit("경로 없는 아주 긴 문장입니다", 10), trunc("경로 없는 아주 긴 문장입니다", 10));
    }

    #[test]
    fn widths_and_truncation() {
        assert_eq!(w("LLM 연결"), 8);
        assert_eq!(w("❯ ✓ × ▲▼ · …"), 12);
        let t = trunc("터미널 세션 제어 (tmux 호환)", 12);
        assert!(w(&t) <= 12 && t.ends_with('…'), "{t}");
        assert_eq!(trunc_path(r"C:\Users\kim\AppData\Local\Programs\oxygen-pi", 34), r"C:\Users\kim\…\Programs\oxygen-pi");
        assert_eq!(num(12480), "12,480");
        assert!(is_path(r"C:\Users\kim\oxygen-pi") && is_path(r"\\server\share\x"));
        assert!(!is_path("설치를 마쳤습니다") && !is_path(r"실행  C:\oxygen-pi\oxy.cmd"));
    }

    #[test]
    fn wrap_keeps_every_line_within_width() {
        let long = r"C:\Users\kim\AppData\Local\Temp\work\project-0123456789abcdef\scratch\sb2\LocalAppData\Programs\oxygen-pi";
        for max in [20, 40, 76] {
            let lines = wrap(long, max);
            assert!(lines.iter().all(|l| w(l) <= max), "{lines:?}");
            assert_eq!(lines.concat(), long);
        }
        assert_eq!(wrap("도구, 설정, LLM 연결이 정상인지 확인합니다.", 20).len(), 3);
        // 문장 안의 짧은 경로는 나누지 않는다
        assert_eq!(wrap(r"전체 경로를 입력하세요. 예: C:\oxygen-pi", 30), ["전체 경로를 입력하세요. 예:", r"C:\oxygen-pi"]);
    }
}
