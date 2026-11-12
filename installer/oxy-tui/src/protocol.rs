//! Node(installer/tui.mjs)와의 통신 규약. 콘솔(stdin/stdout)은 화면과 키 입력에 그대로 쓰고, 지시와 결과는 이름 있는 파이프로 주고받는다.
//!
//! # 연결
//! Node 가 `net.createServer().listen("\\\\.\\pipe\\oxy-tui-<pid>-<난수>")` 로 열고 `oxy-tui.exe --pipe <이름>` 을 띄운다.
//! exe 는 같은 이름에 **두 번** 접속한다 (동기 핸들 하나로는 읽기를 기다리는 동안 쓸 수 없다):
//!   첫 연결 = 지시 (Node → exe): 접속 직후 `{"hello":"commands"}` 를 보내고 그 뒤로는 읽기만 한다
//!   둘째 연결 = 결과 · 이벤트 (exe → Node): `{"hello":"events"}` 를 보내고 그 뒤로는 쓰기만 한다
//! 모든 메시지는 JSON 한 줄이다. 지시 연결이 끊기면(Node 가 죽으면) exe 는 터미널을 되돌리고 종료 코드 1 로 끝난다.
//!
//! # 지시 (Node → exe). 필드는 model.rs 의 구조체와 같다
//!   {"op":"frame", version, title, steps, short, current, path, right}     위치 (다음 화면부터 적용)
//!   {"op":"select", "id":N, header, context, keep, summary, rows, multi, focus, esc, enter, result, result_kind}
//!        → {"id":N,"index":i} · multi 면 {"id":N,"indices":[…]} (잠긴 행 포함) · Esc 면 {"id":N,"back":true}
//!   {"op":"input", "id":N, header, context, value, mask, esc, enter}
//!        → {"id":N,"value":"…"} · {"id":N,"back":true}.  값이 틀리면 Node 가 {"op":"invalid","id":N,"message":"…"} 를 보내고,
//!          exe 는 오류를 보인 채 다시 입력받아 같은 id 로 답한다
//!   {"op":"confirm", "id":N, title, header, context, summary, warning, yes, no, danger, on_yes}   위험 확인 팝업 (아래에 직전 화면)
//!        → {"id":N,"yes":true|false} · {"id":N,"back":true}
//!   {"op":"task", title, lines, items:[{label,state,extra}], percent}       진행 화면. 답 없음. 상태가 바뀔 때마다 전체를 다시 보낸다
//!   {"op":"pause", "id":N, "label":"계속"}                                  지금 화면에서 Enter 를 기다린다 → {"id":N}
//!   {"op":"busy", "label":"삭제할 파일을 세는 중입니다"}                     지금 화면을 그대로 둔 채 키 안내 자리에 진행 표시. 답 없음. 다음 화면 지시가 오면 사라진다
//!   {"op":"suspend", "id":N}                                               대체 화면과 raw mode 에서 나온다 (verify 를 본 화면에서 돌릴 때) → {"id":N}
//!   {"op":"resume", "id":N, "wait":"계속"}                                  wait 가 있으면 본 화면에서 `Enter 계속` 을 기다린 뒤 대체 화면으로 돌아온다 → {"id":N}
//!   {"op":"quit", "code":0, "summary":["본 화면에 남길 줄", …]}             터미널을 되돌리고 summary 를 찍은 뒤 code 로 끝난다
//!
//! # 이벤트 (exe → Node)
//!   {"event":"interrupt"}          Ctrl+C. 화면은 그대로 두고 Node 의 `quit` 을 기다린다 (무엇이 반쯤 됐는지는 Node 가 안다)
//!   {"event":"error","message"}    알 수 없는 지시 · 형식 오류
//!
//! 답을 보낸 뒤에는 다음 지시가 올 때까지 화면을 그대로 둔다 (화면 사이에 빈 화면이 깜박이지 않는다).
use std::fs::{File, OpenOptions};
use std::io::{self, BufRead, BufReader, Write};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::Duration;

use serde_json::{Value, json};

use crate::model::{App, ConfirmSpec, FrameSpec, InputSpec, Screen, SelectSpec, TaskSpec};

pub struct Link {
    events: File,
    pub commands: Receiver<Option<String>>,
}

fn open(path: &str) -> io::Result<File> {
    // 서버가 다음 연결을 받을 준비를 하는 사이에는 ERROR_PIPE_BUSY(231) 가 날 수 있어 잠깐 다시 시도한다
    let mut last = None;
    for _ in 0..50 {
        match OpenOptions::new().read(true).write(true).open(path) {
            Ok(f) => return Ok(f),
            Err(e) if e.raw_os_error() == Some(231) => {
                last = Some(e);
                thread::sleep(Duration::from_millis(20));
            }
            Err(e) => return Err(e),
        }
    }
    Err(last.unwrap_or_else(|| io::Error::other("pipe busy")))
}

pub fn connect(name: &str) -> io::Result<Link> {
    let path = if name.starts_with(r"\\") { name.to_string() } else { format!(r"\\.\pipe\{name}") };
    let mut cmd = open(&path)?;
    cmd.write_all(b"{\"hello\":\"commands\"}\n")?;
    let mut events = open(&path)?;
    events.write_all(b"{\"hello\":\"events\"}\n")?;
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(cmd).lines() {
            match line {
                Ok(l) if !l.trim().is_empty() => {
                    if tx.send(Some(l)).is_err() {
                        return;
                    }
                }
                Ok(_) => {}
                Err(_) => break,
            }
        }
        let _ = tx.send(None); // Node 가 연결을 닫았다 (끝났거나 죽었다)
    });
    Ok(Link { events, commands: rx })
}

impl Link {
    pub fn send(&mut self, v: Value) -> io::Result<()> {
        let mut s = v.to_string();
        s.push('\n');
        self.events.write_all(s.as_bytes())
    }
}

/// 지시 하나를 반영한 뒤 주 루프가 할 일
pub enum Next {
    Continue,
    /// 대체 화면에서 나간다 (verify 를 본 화면에서 돌리는 동안)
    Suspend(Option<u64>),
    /// 대체 화면으로 돌아온다. wait: 돌아오기 전에 본 화면에서 Enter 를 기다릴 때의 뜻
    Resume(Option<u64>, String),
    /// 끝낸다: 종료 코드와 본 화면에 남길 줄
    Quit(i32, Vec<String>),
}

fn parse<T: serde::de::DeserializeOwned>(v: Value) -> Result<T, String> {
    serde_json::from_value(v).map_err(|e| e.to_string())
}

/// 지시 한 줄을 화면 모델에 반영한다. pending: 답을 기다리는 지시의 id
pub fn apply(app: &mut App, pending: &mut Option<u64>, line: &str) -> Result<Next, String> {
    let v: Value = serde_json::from_str(line).map_err(|e| format!("JSON 이 아닙니다: {e}"))?;
    let op = v.get("op").and_then(Value::as_str).unwrap_or("").to_string();
    let id = v.get("id").and_then(Value::as_u64);
    // 답을 받는 화면이 새로 오면 이전 화면의 일시 상태를 지운다
    let mut show = |app: &mut App, screen: Screen| {
        app.screen = screen;
        app.under = None;
        app.help = false;
        app.pause = None;
        app.frozen = false;
        app.busy = None;
        *pending = id;
    };
    match op.as_str() {
        "frame" => app.frame = parse::<FrameSpec>(v)?,
        "select" => {
            let mut s = parse::<SelectSpec>(v)?;
            s.focus = s.focus.min(s.rows.len().saturating_sub(1));
            show(app, Screen::Select(s));
        }
        "input" => show(app, Screen::Input(parse::<InputSpec>(v)?)),
        "invalid" => {
            if let Screen::Input(i) = &mut app.screen {
                i.error = v.get("message").and_then(Value::as_str).unwrap_or("").to_string();
                app.frozen = false;
                *pending = id;
            }
        }
        "confirm" => {
            // 직전 화면을 팝업 아래에 깔아 둔다
            let under = match std::mem::replace(&mut app.screen, Screen::Idle) {
                Screen::Idle | Screen::Confirm(_) => None,
                s => Some(s),
            };
            show(app, Screen::Confirm(parse::<ConfirmSpec>(v)?));
            app.under = under;
        }
        "task" => {
            app.screen = Screen::Task(parse::<TaskSpec>(v)?);
            app.under = None;
            app.help = false;
            app.pause = None;
            app.frozen = false;
            app.busy = None;
        }
        "pause" => {
            app.pause = Some(v.get("label").and_then(Value::as_str).unwrap_or("계속").to_string());
            app.frozen = false;
            app.busy = None;
            *pending = id;
        }
        // 지금 화면은 그대로 두고 키 안내 자리에만 알린다 (키는 받지 않는다)
        "busy" => {
            app.busy = Some(v.get("label").and_then(Value::as_str).unwrap_or("").to_string());
            app.help = false;
            app.frozen = true;
        }
        "suspend" => return Ok(Next::Suspend(id)),
        "resume" => return Ok(Next::Resume(id, v.get("wait").and_then(Value::as_str).unwrap_or("").to_string())),
        "quit" => {
            let code = v.get("code").and_then(Value::as_i64).unwrap_or(0) as i32;
            let summary = v.get("summary").and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
            return Ok(Next::Quit(code, summary));
        }
        other => return Err(format!("모르는 지시입니다: {other}")),
    }
    Ok(Next::Continue)
}

/// 지금 화면에서 Enter(확정)를 눌렀을 때 보낼 답
pub fn answer(id: Option<u64>, app: &App) -> Value {
    if app.pause.is_some() {
        return json!({ "id": id });
    }
    match &app.screen {
        Screen::Select(s) if s.multi => {
            let indices: Vec<usize> = s.rows.iter().enumerate().filter(|(_, r)| r.locked || (r.checked && !r.disabled)).map(|(i, _)| i).collect();
            json!({ "id": id, "indices": indices })
        }
        Screen::Select(s) => json!({ "id": id, "index": s.focus }),
        Screen::Input(i) => json!({ "id": id, "value": i.value }),
        Screen::Confirm(c) => json!({ "id": id, "yes": c.on_yes }),
        _ => json!({ "id": id }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::FrameSpec;

    fn app() -> App {
        App::new(FrameSpec::default(), Screen::Idle)
    }

    #[test]
    fn select_then_answer() {
        let mut a = app();
        let mut pending = None;
        let line = r#"{"op":"select","id":7,"header":"h","rows":[{"label":"a"},{"label":"b","desc":["d"],"info":[["k","v"]]}],"focus":1,"esc":"이전"}"#;
        assert!(matches!(apply(&mut a, &mut pending, line), Ok(Next::Continue)));
        assert_eq!(pending, Some(7));
        assert_eq!(answer(pending, &a), json!({ "id": 7, "index": 1 }));
    }

    #[test]
    fn multi_answer_includes_locked_rows() {
        let mut a = app();
        let mut pending = None;
        let line = r#"{"op":"select","id":1,"multi":true,"rows":[{"label":"a","locked":true},{"label":"b","checked":true},{"label":"c"},{"label":"d","checked":true,"disabled":true}]}"#;
        apply(&mut a, &mut pending, line).unwrap();
        assert_eq!(answer(pending, &a), json!({ "id": 1, "indices": [0, 1] }));
    }

    #[test]
    fn input_invalid_keeps_the_value_and_shows_the_error() {
        let mut a = app();
        let mut pending = None;
        apply(&mut a, &mut pending, r#"{"op":"input","id":2,"header":"설치 폴더","value":"oxygen-pi"}"#).unwrap();
        a.frozen = true;
        apply(&mut a, &mut pending, r#"{"op":"invalid","id":2,"message":"전체 경로를 입력하세요"}"#).unwrap();
        let Screen::Input(i) = &a.screen else { panic!("입력 화면이 아니다") };
        assert_eq!((i.value.as_str(), i.error.as_str(), a.frozen), ("oxygen-pi", "전체 경로를 입력하세요", false));
        assert_eq!(answer(pending, &a), json!({ "id": 2, "value": "oxygen-pi" }));
    }

    #[test]
    fn confirm_keeps_the_previous_screen_underneath() {
        let mut a = app();
        let mut pending = None;
        apply(&mut a, &mut pending, r#"{"op":"select","id":1,"rows":[{"label":"제거"}]}"#).unwrap();
        apply(&mut a, &mut pending, r#"{"op":"confirm","id":2,"header":"제거할까요?","yes":"삭제","no":"취소","danger":true}"#).unwrap();
        assert!(matches!(a.under, Some(Screen::Select(_))));
        assert_eq!(answer(pending, &a), json!({ "id": 2, "yes": false }));
    }

    #[test]
    fn busy_keeps_the_screen_and_the_next_screen_clears_it() {
        let mut a = app();
        let mut pending = None;
        apply(&mut a, &mut pending, r#"{"op":"select","id":1,"rows":[{"label":"제거"}]}"#).unwrap();
        apply(&mut a, &mut pending, r#"{"op":"busy","label":"삭제할 파일을 세는 중입니다"}"#).unwrap();
        assert!(matches!(a.screen, Screen::Select(_)));
        assert_eq!((a.busy.as_deref(), a.frozen), (Some("삭제할 파일을 세는 중입니다"), true));
        assert_eq!(crate::parts::keys_for(&a).len(), 1);
        apply(&mut a, &mut pending, r#"{"op":"confirm","id":2,"header":"제거할까요?","yes":"삭제","no":"취소","danger":true}"#).unwrap();
        assert!(a.busy.is_none() && !a.frozen && matches!(a.under, Some(Screen::Select(_))));
    }

    #[test]
    fn task_pause_suspend_quit() {
        let mut a = app();
        let mut pending = None;
        apply(&mut a, &mut pending, r#"{"op":"task","title":"설치하는 중입니다","items":[{"label":"파일 복사","state":"run","extra":"34%"}],"percent":34}"#).unwrap();
        let Screen::Task(t) = &a.screen else { panic!("진행 화면이 아니다") };
        assert_eq!((t.percent, t.items.len()), (34, 1));
        apply(&mut a, &mut pending, r#"{"op":"task","title":"t"}"#).unwrap();
        assert!(matches!(&a.screen, Screen::Task(t) if t.percent == -1));
        apply(&mut a, &mut pending, r#"{"op":"pause","id":3,"label":"종료"}"#).unwrap();
        assert_eq!((a.pause.as_deref(), answer(pending, &a)), (Some("종료"), json!({ "id": 3 })));
        assert!(matches!(apply(&mut a, &mut pending, r#"{"op":"suspend","id":4}"#), Ok(Next::Suspend(Some(4)))));
        assert!(matches!(apply(&mut a, &mut pending, r#"{"op":"resume","id":5,"wait":"계속"}"#), Ok(Next::Resume(Some(5), w)) if w == "계속"));
        assert!(matches!(apply(&mut a, &mut pending, r#"{"op":"quit","code":130,"summary":["중단되었습니다."]}"#), Ok(Next::Quit(130, s)) if s.len() == 1));
        assert!(apply(&mut a, &mut pending, r#"{"op":"nope"}"#).is_err());
    }
}
