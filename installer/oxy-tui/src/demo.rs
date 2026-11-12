//! 데모 모드: `oxy-tui demo <화면>`. 예시 값으로 화면을 그린다 (디자인 확인 · 캡처용. 아무것도 저장하지 않는다).
//!   화면: hub manage components input confirm task
use crate::model::{App, ConfirmSpec, FrameSpec, InputSpec, Row, Screen, SelectSpec, TaskItem, TaskSpec};

pub const SCREENS: [&str; 6] = ["hub", "manage", "components", "input", "confirm", "task"];
const HOME: &str = r"C:\Users\kim\AppData\Local\Programs\oxygen-pi";
const STEPS: [&str; 8] = ["환경 점검", "설치 폴더", "구성요소", "LLM 연결", "모델", "GitLab 연결", "PATH·바로가기", "확인"];

fn s(x: &str) -> String {
    x.to_string()
}
fn v(xs: &[&str]) -> Vec<String> {
    xs.iter().map(|x| x.to_string()).collect()
}
fn kv(xs: &[(&str, &str)]) -> Vec<(String, String)> {
    xs.iter().map(|(k, x)| (k.to_string(), x.to_string())).collect()
}
fn row(label: &str, value: &str, desc: &[&str]) -> Row {
    Row { label: s(label), value: s(value), desc: v(desc), ..Row::default() }
}

fn install_frame(current: usize) -> FrameSpec {
    FrameSpec { version: s("0.1.0"), title: s("설치"), steps: v(&STEPS), current, ..FrameSpec::default() }
}

fn hub() -> SelectSpec {
    let rows = vec![
        Row {
            info: kv(&[("서버", "https://api.groq.com/openai/v1"), ("코딩 모델", "qwen/qwen3.8-27b"), ("범용 모델", "openai/gpt-oss-120b"), ("컨텍스트", "131,072 토큰")]),
            ..row("LLM 연결", "api.groq.com · qwen/qwen3.8-27b 외 1개", &["서버 주소, API 키, 모델을 변경합니다."])
        },
        Row {
            info: kv(&[("tdb", r"PostgreSQL · db.example.internal:5432"), ("appdb", r"SQLite · C:\work\app.db")]),
            ..row("DB 연결", "2개 (tdb, appdb)", &["에이전트가 조회할 DB 연결을 추가하거나 수정합니다."])
        },
        Row { info: kv(&[("호스트", "gitlab.example.internal"), ("토큰 등록", "glab auth login")]), ..row("GitLab 연결", "gitlab.example.internal", &["GitLab 서버 주소를 변경합니다."]) },
        Row { gap: true, info: kv(&[("브라우저", "Chromium"), ("사용하는 스킬", "web-page-automation")]), ..row("브라우저", "Chromium", &["웹 페이지 자동화(agent-browser)에 사용할 브라우저를 선택합니다."]) },
        Row { info: kv(&[("사용 중", "7개"), ("꺼짐", "LLM 서버 혼잡 감지")]), ..row("확장 기능", "8개 중 7개 사용", &["위험 명령 차단 같은 확장 기능을 켜거나 끕니다."]) },
        Row { info: kv(&[("사용 중", "12개"), ("꺼짐", "terminal-session-control")]), ..row("스킬", "13개 중 12개 사용", &["에이전트가 사용할 스킬을 켜거나 끕니다."]) },
        Row {
            info: kv(&[("명령 출력", "12,000자"), ("파일 읽기", "40,000자"), ("반복 호출", "3회"), ("동시 실행", "1개")]),
            ..row("실행 제한", "출력 12,000자 · 동시 실행 1개", &["출력 길이, 반복 호출 횟수, 동시 실행 수의 제한 값을 변경합니다."])
        },
        Row { gap: true, info: kv(&[("PATH", "등록됨"), ("Windows Terminal 프로필", "등록됨"), ("바탕화면 바로가기", "등록됨")]), ..row("PATH·바로가기", "PATH, Windows Terminal, 바탕화면", &["PATH 등록, Windows Terminal 프로필, 바탕화면 바로가기를 관리합니다."]) },
        Row { info: kv(&[("소요 시간", "약 30초"), ("결과 위치", "화면을 잠시 나가 터미널에 출력")]), ..row("상태 점검", "", &["도구, 설정, LLM 연결이 정상인지 확인합니다.", "설정은 변경되지 않습니다."]) },
    ];
    SelectSpec { header: s("어떤 설정을 변경할까요?"), rows, esc: s("종료"), enter: s("선택"), ..SelectSpec::default() }
}

fn manage() -> SelectSpec {
    let rows = vec![
        row("다시 설정", "", &["LLM 연결, 모델, GitLab, PATH·바로가기를 순서대로 다시 설정합니다.", "한 항목만 변경하려면 tweak.cmd를 사용하세요."]),
        row("상태 점검", "", &["도구, 설정, LLM 연결이 정상인지 확인합니다.", "설정은 변경되지 않습니다."]),
        Row { status: s("사용 불가"), disabled: true, ..row("업데이트", "", &["설치된 폴더에서 실행했기 때문에 업데이트할 수 없습니다.", "새로 반입한 번들 폴더의 install.cmd를 실행하세요."]) },
        row("제거", "", &["! 설치 폴더와 PATH·바로가기 등록을 삭제합니다. 삭제하면 복구할 수 없습니다.", "다음 화면에서 삭제 대상을 확인한 뒤 진행합니다."]),
    ];
    SelectSpec { header: s("어떤 작업을 할까요?"), summary: kv(&[("설치 폴더", HOME), ("설치 버전", "v0.1.0 (2026-11-01)")]), rows, esc: s("종료"), enter: s("선택"), ..SelectSpec::default() }
}

fn components() -> SelectSpec {
    let on = |label: &str, value: &str, desc: &[&str]| Row { checked: true, ..row(label, value, desc) };
    let rows = vec![
        Row { locked: true, checked: true, ..row("기본 도구 5개", "node, pi, fd, rg, jq", &["실행에 필요한 도구라서 항상 설치됩니다."]) },
        Row { gap: true, ..on("just", "프로젝트 명령 실행 (build, test)", &["justfile에 정의된 프로젝트 명령을 실행합니다.", "함께 켜지는 스킬: project-task-running"]) },
        on("hurl", "HTTP API 테스트", &["HTTP API를 호출하고 응답을 확인합니다."]),
        on("psmux", "터미널 세션 제어 (tmux 호환)", &["대화형 프로그램을 터미널 세션에서 실행하고 제어합니다."]),
        Row { gap: true, ..on("glab", "GitLab MR, 이슈, CI", &["GitLab의 MR, 이슈, CI를 다룹니다."]) },
        on("gh", "GitHub PR, 이슈, Actions", &["GitHub의 PR, 이슈, Actions를 다룹니다."]),
        Row { gap: true, ..on("ast-grep", "구문(AST) 기반 코드 검색", &["코드를 구문 단위로 검색하고 일괄 치환합니다."]) },
        Row {
            disabled: true,
            status: s("반입 안 됨"),
            ..row("graphin", "코드 그래프 탐색 (MCP)", &["번들에 포함되지 않아 선택할 수 없습니다.", "graphin.exe를 vendor/graphin/에 넣고 번들을 다시 만드세요."])
        },
        Row { gap: true, recommended: true, ..on("agent-browser", "웹 페이지 조작 (클릭, 입력, 스크린샷)", &["브라우저를 열어 사내 웹 페이지를 조작합니다."]) },
        on("obscura", "웹 페이지 읽기", &["웹 페이지를 렌더링해 텍스트로 읽습니다."]),
        Row { gap: true, recommended: true, ..on("usql", "SQL 조회 (PostgreSQL, MySQL, SQLite 등)", &["여러 종류의 DB를 하나의 명령으로 조회합니다."]) },
        on("SQLcl", "Oracle 전용 CLI (Java 17 필요)", &["Oracle이 제공하는 Oracle 전용 CLI입니다. 오픈소스가 아닙니다."]),
        on("dbhub", "에이전트용 DB 조회 도구 (MCP)", &["에이전트가 등록된 DB에 SQL을 실행할 수 있게 합니다."]),
    ];
    SelectSpec {
        header: s("어떤 구성요소를 설치할까요?"),
        context: v(&["번들에 포함된 구성요소만 선택할 수 있습니다."]),
        rows,
        multi: true,
        focus: 1,
        esc: s("이전"),
        enter: s("다음"),
        ..SelectSpec::default()
    }
}

fn input() -> InputSpec {
    InputSpec {
        header: s("설치 폴더"),
        context: v(&[r"폴더가 없으면 새로 만듭니다. 예: C:\oxygen-pi"]),
        value: s("oxygen-pi"),
        error: s(r"드라이브 문자부터 전체 경로를 입력하세요. 예: C:\oxygen-pi"),
        esc: s("이전"),
        enter: s("다음"),
        ..InputSpec::default()
    }
}

fn confirm() -> ConfirmSpec {
    ConfirmSpec {
        title: s("제거"),
        header: s("oxygen-pi-system을 이 PC에서 제거할까요?"),
        summary: kv(&[
            ("삭제", HOME),
            ("", "12,480개 파일 · 1.1GB"),
            ("함께 삭제", "DB 연결 2개와 저장된 비밀번호"),
            ("등록 해제", "PATH, Windows Terminal 프로필, 바탕화면 바로가기"),
            ("설정 백업", r"%APPDATA%\oxygen-pi\oxy.env.bak"),
        ]),
        warning: s("삭제하면 복구할 수 없습니다."),
        yes: s("설치 폴더 삭제"),
        no: s("제거 취소"),
        danger: true,
        on_yes: false,
        ..ConfirmSpec::default()
    }
}

fn task() -> TaskSpec {
    let item = |label: &str, state: &str, extra: &str| TaskItem { label: s(label), state: s(state), extra: s(extra) };
    TaskSpec {
        title: s("설치하는 중입니다"),
        lines: v(&[HOME]),
        items: vec![
            item("설치 정보 기록", "done", ""),
            item("파일 복사", "run", ""),
            item("설정 파일 생성", "wait", ""),
            item("PATH 등록", "wait", ""),
            item("Windows Terminal 프로필 등록", "wait", ""),
            item("바탕화면 바로가기 등록", "wait", ""),
        ],
        percent: 34,
    }
}

pub fn app(name: &str) -> Option<App> {
    let tweak = FrameSpec { version: s("0.1.0"), path: v(&["설정"]), right: s(HOME), ..FrameSpec::default() };
    let admin = FrameSpec { version: s("0.1.0"), path: v(&["설치 관리"]), ..FrameSpec::default() };
    let (frame, screen, under) = match name {
        "hub" => (tweak, Screen::Select(hub()), None),
        "manage" => (admin, Screen::Select(manage()), None),
        "components" => (install_frame(2), Screen::Select(components()), None),
        "input" => (install_frame(1), Screen::Input(input()), None),
        "confirm" => {
            let mut m = manage();
            m.focus = 3;
            (FrameSpec { path: v(&["설치 관리", "제거"]), ..admin }, Screen::Confirm(confirm()), Some(Screen::Select(m)))
        }
        "task" => (FrameSpec { stage: s("설치 중"), ..install_frame(8) }, Screen::Task(task()), None),
        _ => return None,
    };
    let mut app = App::new(frame, screen);
    app.under = under;
    Some(app)
}

/// 진행 화면을 움직인다 (파일 복사가 끝나면 다음 작업으로)
pub fn advance(app: &mut App) {
    const TOTAL: u64 = 12480;
    let Screen::Task(t) = &mut app.screen else { return };
    let Some(i) = t.items.iter().position(|it| it.state == "run") else { return };
    if i == 1 && t.percent < 100 {
        if app.tick % 2 == 0 {
            t.percent += 1;
        }
        let done = TOTAL * t.percent as u64 / 100;
        t.items[i].extra = format!("{}/{} ({}%)", crate::text::num(done), crate::text::num(TOTAL), t.percent);
    } else if app.tick % 6 == 0 {
        t.items[i].state = "done".to_string();
        t.items[i].extra = if i == 1 { format!("{}개", crate::text::num(TOTAL)) } else { String::new() };
        t.percent = -1;
        if let Some(next) = t.items.get_mut(i + 1) {
            next.state = "run".to_string();
        }
    }
}
