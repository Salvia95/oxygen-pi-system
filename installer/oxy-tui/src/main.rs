//! oxy-tui: oxygen-pi-system 설치·설정 TUI 의 화면. 그리기와 키 입력만 맡는다 (무엇을 보일지는 installer/*.mjs 가 정한다).
//!   oxy-tui --pipe <이름>                         Node(installer/tui.mjs)의 지시를 받아 그린다 (protocol.rs)
//!   oxy-tui demo <화면> [--focus N] [--help-open] [--keylog <파일>] [--exit-after <ms>]   예시 값으로 그린다 (demo.rs)
//!   oxy-tui demo colors | panic                  색 견본 · 비정상 종료 때 터미널 복구 확인
//!   oxy-tui --pipe <이름> --mode monitor          psmux 오른쪽 열의 jobs · flow 모니터 화면 (monitor.rs, docs/monitor-tui-spec.md)
//!   oxy-tui demo monitor --model <JSON> [--exit-after <ms>] [--size WxH] [--now <ms>]   보기 모델 파일을 그린다
//!   oxy-tui --version                            `oxy-tui <버전> monitor` (모니터 모드를 아는 exe 는 monitor 를 덧붙인다)
//! 대체 화면 버퍼에 그리고, 어떤 경로로 끝나든(정상 · Ctrl+C · 오류 · panic · Node 와의 연결 끊김) raw mode 와 대체 화면에서 나온다.
mod banner;
mod demo;
mod model;
mod monitor;
mod parts;
mod protocol;
mod text;
mod theme;
mod view;
mod view_a;

use std::fs::OpenOptions;
use std::io::{self, IsTerminal, Write};
use std::process::ExitCode;
use std::time::{Duration, Instant};

use ratatui::Terminal;
use ratatui::backend::CrosstermBackend;
use ratatui::crossterm::cursor::{Hide, Show};
use ratatui::crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::crossterm::execute;
use ratatui::crossterm::terminal::{EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode, is_raw_mode_enabled};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use serde_json::json;

use model::{App, FrameSpec, Screen};

type Term = Terminal<CrosstermBackend<io::Stdout>>;

/// 대체 화면에 들어가 있는 동안에만 있는 표식 파일 (환경변수 `OXY_TUI_MARK` 의 경로. install.cmd · tweak.cmd 가 정한다).
/// 이 프로그램이 터미널을 되돌리지 못하고 죽으면(Node 가 강제 종료되면 함께 죽는다) 파일이 남고, 래퍼가 그것을 보고 터미널을 되돌린다.
fn mark(on: bool) {
    let Some(path) = std::env::var_os("OXY_TUI_MARK").filter(|p| !p.is_empty()) else { return };
    if on {
        let _ = std::fs::write(&path, b"alt");
    } else {
        let _ = std::fs::remove_file(&path);
    }
}

fn enter() -> io::Result<Term> {
    enable_raw_mode()?;
    execute!(io::stdout(), EnterAlternateScreen, Hide)?;
    mark(true);
    Terminal::new(CrosstermBackend::new(io::stdout()))
}

/// 터미널을 원래대로. 여러 번 불러도 된다
fn leave() {
    let _ = execute!(io::stdout(), Show, LeaveAlternateScreen);
    let _ = disable_raw_mode();
    mark(false);
}

/// 키 하나를 화면에 반영한 결과
enum Act {
    None,
    Submit,
    Back,
    Interrupt,
}

impl App {
    /// pasted: 바로 앞 글자와 거의 동시에 들어온 키 (붙여넣기 안의 줄바꿈은 확정으로 보지 않는다)
    fn key(&mut self, k: KeyEvent, pasted: bool) -> Act {
        if k.modifiers.contains(KeyModifiers::CONTROL) && k.code == KeyCode::Char('c') {
            return Act::Interrupt;
        }
        if self.frozen {
            return Act::None;
        }
        if self.pause.is_some() {
            return if k.code == KeyCode::Enter { Act::Submit } else { Act::None };
        }
        if self.help {
            self.help = false;
            return Act::None;
        }
        match &mut self.screen {
            Screen::Idle | Screen::Task(_) => Act::None,
            Screen::Select(s) => {
                s.message.clear();
                let n = s.rows.len().max(1);
                match k.code {
                    KeyCode::Up | KeyCode::Char('k') => s.focus = (s.focus + n - 1) % n,
                    KeyCode::Down | KeyCode::Char('j') | KeyCode::Tab => s.focus = (s.focus + 1) % n,
                    KeyCode::Char('?') => self.help = parts::has_help(s),
                    KeyCode::Char(' ') if s.multi => {
                        if let Some(r) = s.rows.get_mut(s.focus) {
                            if r.locked {
                                s.message = format!("필수 항목은 해제할 수 없습니다: {}", r.label);
                            } else if r.disabled {
                                s.message = format!("선택할 수 없습니다: {}", r.label);
                            } else {
                                r.checked = !r.checked;
                            }
                        }
                    }
                    KeyCode::Enter => {
                        if !s.multi && s.rows.get(s.focus).is_some_and(|r| r.disabled) {
                            s.message = format!("선택할 수 없습니다: {}", s.rows[s.focus].label);
                        } else {
                            return Act::Submit;
                        }
                    }
                    KeyCode::Esc if !s.esc.is_empty() => return Act::Back,
                    _ => {}
                }
                Act::None
            }
            Screen::Input(i) => {
                match k.code {
                    KeyCode::Enter if !pasted => return Act::Submit,
                    KeyCode::Esc if !i.esc.is_empty() => return Act::Back,
                    KeyCode::Backspace => {
                        i.value.pop();
                        i.error.clear();
                    }
                    KeyCode::Char('u') if k.modifiers.contains(KeyModifiers::CONTROL) => i.value.clear(),
                    KeyCode::Char(ch) if !k.modifiers.contains(KeyModifiers::CONTROL) => {
                        i.value.push(ch);
                        i.error.clear();
                    }
                    _ => {}
                }
                Act::None
            }
            Screen::Confirm(c) => {
                match k.code {
                    KeyCode::Left | KeyCode::Right | KeyCode::Up | KeyCode::Down | KeyCode::Tab => c.on_yes = !c.on_yes,
                    KeyCode::Enter => return Act::Submit,
                    KeyCode::Esc => return Act::Back,
                    _ => {}
                }
                Act::None
            }
        }
    }
}

/// 붙여넣기 판정: 글자 키 바로 뒤(30ms 안)에 온 Enter 는 붙여넣은 글의 줄바꿈이다
struct Paste(Instant);
impl Paste {
    fn new() -> Self {
        Self(Instant::now() - Duration::from_secs(1))
    }
    fn check(&mut self, k: &KeyEvent) -> bool {
        let pasted = k.code == KeyCode::Enter && self.0.elapsed() < Duration::from_millis(30);
        if matches!(k.code, KeyCode::Char(_)) {
            self.0 = Instant::now();
        }
        pasted
    }
}

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // panic 이 나도 터미널을 대체 화면 · raw mode 에 남기지 않는다 (복구한 뒤에 원래 hook 이 메시지를 찍는다)
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        leave();
        prev(info);
    }));
    let result = if let Some(name) = arg(&args, "--pipe") {
        match arg(&args, "--mode").as_deref() {
            None | Some("install") => run_pipe(&name),
            Some("monitor") => run_monitor(&name),
            Some(other) => {
                eprintln!("oxy-tui: 모르는 --mode 입니다: {other} (install · monitor)");
                Ok(2)
            }
        }
    } else if args.first().map(String::as_str) == Some("demo") {
        run_demo(args.get(1).map(String::as_str).unwrap_or("hub"), &args)
    } else if args.iter().any(|a| a == "--version") {
        // 모니터 모드를 아는지 Node 가 이 출력으로 판단한다 (예전 exe 는 monitor 가 없다)
        println!("oxy-tui {} monitor", env!("CARGO_PKG_VERSION"));
        Ok(0)
    } else {
        eprintln!(
            "usage: oxy-tui --pipe <name> [--mode install|monitor]\n       oxy-tui demo <{}|colors|panic> [--focus N] [--help-open] [--keylog <file>] [--exit-after <ms>]\n       oxy-tui demo monitor --model <json> [--exit-after <ms>] [--size WxH] [--now <ms>]",
            demo::SCREENS.join("|")
        );
        Ok(2)
    };
    if is_raw_mode_enabled().unwrap_or(false) {
        leave();
    }
    match result {
        Ok(code) => ExitCode::from(code as u8),
        Err(e) => {
            eprintln!("oxy-tui: {e}");
            ExitCode::from(1)
        }
    }
}

// ---------------------------------------------------------------- 데모
fn run_demo(name: &str, args: &[String]) -> io::Result<i32> {
    let keylog = arg(args, "--keylog");
    if name == "colors" {
        return run_colors();
    }
    if name == "monitor" {
        return run_monitor_demo(args);
    }
    let Some(mut app) = demo::app(if name == "panic" { "hub" } else { name }) else {
        eprintln!("화면 이름: {} colors panic", demo::SCREENS.join(" "));
        return Ok(2);
    };
    if let (Some(n), Screen::Select(s)) = (arg(args, "--focus").and_then(|x| x.parse::<usize>().ok()), &mut app.screen) {
        s.focus = n.min(s.rows.len().saturating_sub(1));
    }
    app.help = args.iter().any(|a| a == "--help-open");
    let exit_after = arg(args, "--exit-after").and_then(|x| x.parse::<usize>().ok()).map(|ms| ms / 80);
    let mut term = enter()?;
    let mut paste = Paste::new();
    let mut note = String::new();
    loop {
        term.draw(|f| view::render(f, &app))?;
        if name == "panic" && app.tick > 12 {
            panic!("데모: 일부러 낸 panic (터미널 복구 확인용)");
        }
        if !event::poll(Duration::from_millis(80))? {
            app.tick += 1;
            demo::advance(&mut app);
            if exit_after.is_some_and(|n| app.tick >= n) {
                break;
            }
            continue;
        }
        let ev = event::read()?;
        if let Some(path) = &keylog {
            if let Event::Key(k) = &ev {
                let mut f = OpenOptions::new().create(true).append(true).open(path)?;
                writeln!(f, "{:?} {:?} {:?}", k.code, k.modifiers, k.kind)?;
            }
        }
        let Event::Key(k) = ev else { continue }; // 창 크기가 바뀌면 다음 draw 가 새 크기로 다시 그린다
        if k.kind != KeyEventKind::Press {
            continue;
        }
        if k.code == KeyCode::Char('q') && !matches!(app.screen, Screen::Input(_)) {
            break;
        }
        let pasted = paste.check(&k);
        match app.key(k, pasted) {
            Act::None => {}
            Act::Interrupt => {
                leave();
                println!("중단되었습니다. 변경된 내용은 없습니다.");
                return Ok(130);
            }
            Act::Back if keylog.is_some() => {} // 키 기록 중에는 Esc 뒤의 키를 계속 받는다
            Act::Back => break,
            Act::Submit => {
                if let Screen::Input(i) = &mut app.screen {
                    let ok = i.value.len() >= 3 && i.value.as_bytes()[1] == b':' && i.value.as_bytes()[2] == b'\\';
                    if !ok {
                        i.error = r"드라이브 문자부터 전체 경로를 입력하세요. 예: C:\oxygen-pi".to_string();
                        continue;
                    }
                }
                note = match &app.screen {
                    Screen::Select(s) => s.rows.get(s.focus).map(|r| r.label.clone()).unwrap_or_default(),
                    Screen::Input(i) => i.value.clone(),
                    Screen::Confirm(c) => if c.on_yes { c.yes.clone() } else { c.no.clone() },
                    _ => String::new(),
                };
                break;
            }
        }
    }
    let size = term.size()?;
    leave();
    println!("{} · 데모 종료: {name} {}×{}{}", banner::wordmark("0.1.0"), size.width, size.height, if note.is_empty() { String::new() } else { format!(" · {note}") });
    Ok(0)
}

/// 색 견본: 글자색 후보를 mintty 와 Windows Terminal 에서 견준다
fn run_colors() -> io::Result<i32> {
    let mut term = enter()?;
    let sample = "서버 주소, API 키, 모델을 변경합니다. api.groq.com · 8개 중 7개 사용";
    let rows: Vec<(&str, Style)> = vec![
        ("기본 (Reset)", Style::new()),
        ("굵게", Style::new().add_modifier(Modifier::BOLD)),
        ("White", Style::new().fg(Color::White)),
        ("Gray", Style::new().fg(Color::Gray)),
        ("DarkGray", Style::new().fg(Color::DarkGray)),
        ("DIM", Style::new().add_modifier(Modifier::DIM)),
        ("Cyan", Style::new().fg(Color::Cyan)),
        ("Cyan 굵게", Style::new().fg(Color::Cyan).add_modifier(Modifier::BOLD)),
        ("LightCyan", Style::new().fg(Color::LightCyan)),
        ("Green", Style::new().fg(Color::Green)),
        ("배경 DarkGray", Style::new().bg(Color::DarkGray)),
        ("반전 LightCyan", Style::new().fg(Color::LightCyan).add_modifier(Modifier::REVERSED)),
    ];
    loop {
        term.draw(|f| {
            let mut lines: Vec<Line> = vec![Line::raw("")];
            for (name, st) in &rows {
                lines.push(Line::from(vec![Span::raw(format!("  {}", text::pad(name, 22))), Span::styled(sample, *st)]));
            }
            lines.push(Line::raw(""));
            lines.push(Line::from(vec![
                Span::raw("  기호  "),
                Span::styled("❯ ", theme::accent()),
                Span::styled("✓ ", theme::ok()),
                Span::styled("× ", theme::err()),
                Span::styled("! ", theme::warn()),
                Span::raw("▲▼ ←→ · … [✓] [■] [·] [ ] ⠋ █▀▄ ░ │─┌┐└┘"),
            ]));
            f.render_widget(Paragraph::new(lines), f.area());
        })?;
        if let Event::Key(k) = event::read()? {
            if k.kind == KeyEventKind::Press {
                break;
            }
        }
    }
    leave();
    Ok(0)
}

// ---------------------------------------------------------------- Node 의 지시를 받아 그리기
/// 본 화면에서 `Enter <뜻>` 을 기다린다 (verify 결과를 읽을 시간). Ctrl+C 면 Node 에 알리고 돌아온다
fn wait_enter(label: &str, link: &mut protocol::Link) -> io::Result<()> {
    print!("\n  Enter {label} ");
    io::stdout().flush()?;
    enable_raw_mode()?;
    loop {
        if let Event::Key(k) = event::read()? {
            if k.kind != KeyEventKind::Press {
                continue;
            }
            if k.code == KeyCode::Enter {
                break;
            }
            if k.modifiers.contains(KeyModifiers::CONTROL) && k.code == KeyCode::Char('c') {
                link.send(json!({ "event": "interrupt" }))?;
                break;
            }
        }
    }
    disable_raw_mode()?;
    println!();
    Ok(())
}

/// 대체 화면에 들어간 뒤 화면 전체를 한 번 다시 그리기까지의 시간
const REPAINT_AFTER: Duration = Duration::from_millis(300);

fn run_pipe(name: &str) -> io::Result<i32> {
    let mut link = protocol::connect(name)?;
    let mut app = App::new(FrameSpec::default(), Screen::Idle);
    let mut pending: Option<u64> = None;
    let mut paste = Paste::new();
    // None 이면 대체 화면 밖에 나가 있는 중 (suspend)
    let mut term = Some(enter()?);
    // 대체 화면에 들어간 직후의 첫 그리기에서 글자가 빠지는 터미널이 있어, 잠시 뒤 화면 전체를 한 번 다시 그린다
    let mut repaint_at = Some(Instant::now() + REPAINT_AFTER);
    loop {
        // 밀린 지시를 모두 반영한 뒤 한 번 그린다. 나가 있는 동안에는 지시만 기다린다
        let mut first = term.is_none();
        loop {
            let msg = if first { link.commands.recv_timeout(Duration::from_millis(100)).ok() } else { link.commands.try_recv().ok() };
            first = false;
            let Some(msg) = msg else { break };
            let Some(line) = msg else {
                // Node 가 사라졌다: 화면을 붙들고 있지 않는다
                leave();
                eprintln!("oxy-tui: 설치 프로그램과의 연결이 끊어져 종료합니다.");
                return Ok(1);
            };
            match protocol::apply(&mut app, &mut pending, &line) {
                Ok(protocol::Next::Continue) => {}
                Ok(protocol::Next::Suspend(id)) => {
                    if term.take().is_some() {
                        leave();
                    }
                    link.send(json!({ "id": id }))?;
                }
                Ok(protocol::Next::Resume(id, wait)) => {
                    if term.is_none() {
                        if !wait.is_empty() {
                            wait_enter(&wait, &mut link)?;
                        }
                        term = Some(enter()?);
                        repaint_at = Some(Instant::now() + REPAINT_AFTER);
                    }
                    link.send(json!({ "id": id }))?;
                }
                Ok(protocol::Next::Quit(code, summary)) => {
                    leave();
                    for l in summary {
                        println!("{l}");
                    }
                    return Ok(code);
                }
                Err(e) => link.send(json!({ "event": "error", "message": e }))?,
            }
        }
        let Some(t) = term.as_mut() else { continue };
        if repaint_at.is_some_and(|at| Instant::now() >= at) {
            repaint_at = None;
            // 화면을 지우지 않고(깜박임 없음) 직전 버퍼만 비워, 다음 그리기가 모든 칸을 다시 내보내게 한다
            t.swap_buffers();
        }
        t.draw(|f| view::render(f, &app))?;
        if !event::poll(Duration::from_millis(50))? {
            app.tick += 1;
            continue;
        }
        let Event::Key(k) = event::read()? else { continue };
        if k.kind != KeyEventKind::Press {
            continue;
        }
        let pasted = paste.check(&k);
        match app.key(k, pasted) {
            Act::None => {}
            Act::Interrupt => link.send(json!({ "event": "interrupt" }))?,
            Act::Back => {
                link.send(json!({ "id": pending.take(), "back": true }))?;
                app.frozen = true;
            }
            Act::Submit => {
                link.send(protocol::answer(pending.take(), &app))?;
                app.frozen = true;
            }
        }
    }
}

// ---------------------------------------------------------------- 모니터 모드
/// 모니터 화면의 키 하나를 Node 에 알릴 이름으로 (선택 · 펼치기 · 중지 · 닫기는 Node 가 정한다)
fn monitor_key(k: &KeyEvent) -> Option<&'static str> {
    if k.modifiers.contains(KeyModifiers::CONTROL) {
        return None;
    }
    match k.code {
        KeyCode::Up => Some("up"),
        KeyCode::Down => Some("down"),
        KeyCode::Left => Some("left"),
        KeyCode::Right => Some("right"),
        KeyCode::Enter => Some("enter"),
        KeyCode::Esc => Some("esc"),
        KeyCode::Char('s' | 'S') => Some("s"),
        KeyCode::Char('q' | 'Q') => Some("q"),
        _ => None,
    }
}

/// 스피너 모양: 시작한 뒤 지난 시간으로 (1초에 10번 바뀐다)
fn spinner_at(start: Instant) -> usize {
    monitor::spinner_frame(start.elapsed().as_millis())
}

/// `--pipe <이름> --mode monitor`: Node 가 보내는 보기 모델(`{"op":"monitor",…}`)을 그리고 키 · 창 크기를 이벤트로 돌려준다.
/// 연결은 설치 화면과 같다 (protocol.rs). 지시 연결이 끊기면 터미널을 되돌리고 끝낸다
fn run_monitor(name: &str) -> io::Result<i32> {
    theme::set_monitor(); // OXY_TUI_THEME=tokyo-night 는 모니터 화면에서만 쓴다
    let mut link = protocol::connect(name)?;
    let mut model: Option<monitor::MonitorModel> = None;
    let mut term = enter()?;
    let start = Instant::now();
    let mut repaint_at = Some(Instant::now() + REPAINT_AFTER);
    // 크기 이벤트: 시작하자마자 한 번, 그 뒤로는 크기가 달라졌을 때만 (터미널이 같은 크기를 거듭 알리기도 한다)
    let mut last_size = term.size()?;
    link.send(json!({ "event": "resize", "width": last_size.width, "height": last_size.height }))?;
    loop {
        // 밀린 지시를 모두 반영한 뒤 한 번 그린다
        loop {
            let line = match link.commands.try_recv() {
                Ok(Some(line)) => line,
                Ok(None) | Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                    leave();
                    eprintln!("oxy-tui: pi 와의 연결이 끊어져 종료합니다.");
                    return Ok(1);
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => break,
            };
            match monitor::apply(&mut model, &line) {
                Ok(monitor::Next::Continue) => {}
                Ok(monitor::Next::Quit(code, summary)) => {
                    leave();
                    for l in summary {
                        println!("{l}");
                    }
                    return Ok(code);
                }
                Err(e) => link.send(json!({ "event": "error", "message": e }))?,
            }
        }
        if repaint_at.is_some_and(|at| Instant::now() >= at) {
            repaint_at = None;
            term.swap_buffers(); // 대체 화면 진입 직후 빠진 글자를 채운다 (run_pipe 와 같다)
        }
        let (frame, now) = (spinner_at(start), monitor::now_ms());
        term.draw(|f| {
            if let Some(m) = &model {
                monitor::render(f, m, frame, now);
            }
        })?;
        if !event::poll(Duration::from_millis(50))? {
            continue;
        }
        match event::read()? {
            Event::Key(k) if k.kind == KeyEventKind::Press => {
                if k.modifiers.contains(KeyModifiers::CONTROL) && k.code == KeyCode::Char('c') {
                    link.send(json!({ "event": "interrupt" }))?;
                } else if let Some(key) = monitor_key(&k) {
                    link.send(json!({ "event": "key", "key": key }))?;
                }
            }
            Event::Resize(width, height) if (width, height) != (last_size.width, last_size.height) => {
                last_size = ratatui::layout::Size::new(width, height);
                link.send(json!({ "event": "resize", "width": width, "height": height }))?;
            }
            _ => {}
        }
    }
}

/// `demo monitor --model <JSON>`: 보기 모델 파일을 그린다 (스피너 · 경과가 움직인다. q 로 끝낸다).
/// 터미널이 아니면(파이프 · 시험) 화면을 만들지 않고 한 장면을 글자로 찍는다: `--size WxH`(기본 80x24), `--now <ms>`(경과를 셀 기준 시각)
fn run_monitor_demo(args: &[String]) -> io::Result<i32> {
    theme::set_monitor();
    let Some(path) = arg(args, "--model") else {
        eprintln!("usage: oxy-tui demo monitor --model <json> [--exit-after <ms>] [--size WxH] [--now <ms>]");
        return Ok(2);
    };
    let model: monitor::MonitorModel = match std::fs::read_to_string(&path).map_err(|e| e.to_string()).and_then(|s| serde_json::from_str(&s).map_err(|e| e.to_string())) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("oxy-tui: 보기 모델을 읽지 못했습니다: {path} ({e})");
            return Ok(2);
        }
    };
    let now = arg(args, "--now").and_then(|x| x.parse::<i64>().ok());
    if !io::stdout().is_terminal() || !io::stdin().is_terminal() {
        let (width, height) = arg(args, "--size").and_then(|s| s.split_once('x').and_then(|(a, b)| Some((a.parse::<u16>().ok()?, b.parse::<u16>().ok()?)))).unwrap_or((80, 24));
        for l in monitor::dump(&model, width, height, 0, now.unwrap_or_else(monitor::now_ms)) {
            println!("{l}");
        }
        return Ok(0);
    }
    let exit_after = arg(args, "--exit-after").and_then(|x| x.parse::<u64>().ok()).map(Duration::from_millis);
    let mut term = enter()?;
    let start = Instant::now();
    loop {
        let (frame, at) = (spinner_at(start), now.unwrap_or_else(monitor::now_ms));
        term.draw(|f| monitor::render(f, &model, frame, at))?;
        if exit_after.is_some_and(|d| start.elapsed() >= d) {
            break;
        }
        if !event::poll(Duration::from_millis(50))? {
            continue;
        }
        if let Event::Key(k) = event::read()? {
            if k.kind != KeyEventKind::Press {
                continue;
            }
            if k.modifiers.contains(KeyModifiers::CONTROL) && k.code == KeyCode::Char('c') {
                break;
            }
            if monitor_key(&k) == Some("q") {
                break;
            }
        }
    }
    let size = term.size()?;
    leave();
    println!("oxy-tui 데모 종료: monitor {}×{}", size.width, size.height);
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    #[test]
    fn monitor_keys_are_named_for_node_including_left_and_right() {
        for (code, name) in [
            (KeyCode::Up, "up"),
            (KeyCode::Down, "down"),
            (KeyCode::Left, "left"),
            (KeyCode::Right, "right"),
            (KeyCode::Enter, "enter"),
            (KeyCode::Esc, "esc"),
            (KeyCode::Char('s'), "s"),
            (KeyCode::Char('S'), "s"),
            (KeyCode::Char('q'), "q"),
        ] {
            assert_eq!(monitor_key(&key(code)), Some(name), "{code:?}");
        }
        assert_eq!(monitor_key(&key(KeyCode::Tab)), None);
        assert_eq!(monitor_key(&KeyEvent::new(KeyCode::Left, KeyModifiers::CONTROL)), None);
    }
}
