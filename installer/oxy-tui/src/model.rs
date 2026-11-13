//! 화면 모델. Node(installer/tui.mjs)가 파이프로 보내는 JSON 과 같은 모양이다 (데모 모드는 같은 모델에 예시 값을 채운다).
//! 필드 설명이 곧 프로토콜 설명이다. 지시의 종류와 흐름은 protocol.rs 머리말에 있다.
use std::time::Instant;

use serde::Deserialize;

/// 프레임: 배너 아래에 보일 위치. 설치는 steps + current, 설정(Tweak)은 path
#[derive(Deserialize, Clone, Default, Debug)]
#[serde(default)]
pub struct FrameSpec {
    pub version: String,
    /// 흐름 이름 (`설치`, `다시 설정`)
    pub title: String,
    pub steps: Vec<String>,
    /// 단계의 짧은 이름 (`바로가기`). 배너 오른쪽처럼 좁은 자리에 쓴다. 비어 있으면 steps 를 쓴다
    pub short: Vec<String>,
    /// 지금 단계 (0부터). steps.len() 이상이면 모든 단계를 지나 작업하는 중이거나 마친 뒤다 (stage 를 보인다)
    pub current: usize,
    /// 단계를 모두 지난 뒤의 상태 (`설치 중` · `설치 완료`)
    pub stage: String,
    /// stage 가 끝난 상태인가 (단계 목록 패널에 ✓ 로 보인다)
    pub finished: bool,
    /// 설정 화면의 경로 조각 (`설정`, `LLM 연결`)
    pub path: Vec<String>,
    /// 위치 줄 오른쪽 (설치 폴더)
    pub right: String,
}

#[derive(Deserialize, Clone, Default, Debug)]
#[serde(default)]
pub struct Row {
    pub label: String,
    /// 값 열 (현재 값 · 한 줄 설명)
    pub value: String,
    /// 값 열 맨 앞의 상태 문구 (`반입 안 됨`). 잠금 행은 비워 두면 `필수`
    pub status: String,
    /// 포커스했을 때 보일 설명 문장 (최대 2줄). `! ` 로 시작하면 위험한 결과
    pub desc: Vec<String>,
    /// 관련 정보 (이름, 값). 상세 패널과 도움말에 보인다
    pub info: Vec<(String, String)>,
    /// 이 행 앞에서 묶음이 바뀐다 (자리가 있으면 빈 줄)
    pub gap: bool,
    pub disabled: bool,
    pub recommended: bool,
    pub current: bool,
    pub danger: bool,
    pub locked: bool,
    pub checked: bool,
}

#[derive(Deserialize, Clone, Default, Debug)]
#[serde(default)]
pub struct SelectSpec {
    pub header: String,
    /// 맥락 문장. 자리가 모자라면 접는다 (`? 도움말` 로 펼친다)
    pub context: Vec<String>,
    /// true 면 context 는 접지 않는다 (점검 결과 · 요약처럼 판단 근거가 되는 줄. 미리 맞춘 열은 그대로 둔다)
    pub keep: bool,
    /// 이름–값 요약 (설치 폴더 · 버전 등 여러 값을 한눈에 보일 때)
    pub summary: Vec<(String, String)>,
    pub rows: Vec<Row>,
    pub multi: bool,
    pub focus: usize,
    /// Esc 의 뜻 (`이전` · `종료` · `취소`). 비우면 Esc 를 받지 않는다
    pub esc: String,
    /// Enter 의 뜻 (`선택` · `다음` · `저장`)
    pub enter: String,
    /// 직전 작업의 결과 한 줄 (`GitLab 연결을 저장했습니다.`)
    pub result: String,
    /// 결과의 종류: `ok`(기본, ✓) · `warn`(!) · `err`(×)
    pub result_kind: String,
    /// 차단 안내 (필수 해제 등). 다음 키에서 지운다
    #[serde(skip)]
    pub message: String,
}

#[derive(Deserialize, Clone, Default, Debug)]
#[serde(default)]
pub struct InputSpec {
    /// 입력할 값의 이름 (명사형: `설치 폴더`, `API 키`)
    pub header: String,
    pub context: Vec<String>,
    pub value: String,
    pub mask: bool,
    /// 검증 오류 (Node 가 `invalid` 로 되돌려 준 문구. `input` 의 error 로 처음부터 보일 수도 있다). 입력을 고치면 지운다
    pub error: String,
    pub esc: String,
    pub enter: String,
}

/// 위험 확인 팝업. 일반 확인(2지선다)은 Node 가 `select` 로 보낸다
#[derive(Deserialize, Clone, Default, Debug)]
#[serde(default)]
pub struct ConfirmSpec {
    pub title: String,
    pub header: String,
    pub context: Vec<String>,
    pub summary: Vec<(String, String)>,
    /// 되돌릴 수 없는 결과 한 줄 (`삭제하면 복구할 수 없습니다.`)
    pub warning: String,
    pub yes: String,
    pub no: String,
    pub danger: bool,
    /// 포커스가 진행 쪽에 있는가 (위험 확인은 false 로 시작)
    pub on_yes: bool,
}

#[derive(Deserialize, Clone, Default, Debug)]
#[serde(default)]
pub struct TaskItem {
    pub label: String,
    /// done | run | fail | warn | wait | text (warn 은 실패해도 멈추지 않는 작업: `!` 노랑. text 는 작업이 아니라 그냥 한 줄: 오류의 원인 · 해결 방법, 결과 요약)
    pub state: String,
    pub extra: String,
}

/// 진행 화면. Node 는 상태가 바뀔 때마다 전체를 다시 보낸다 (돌아가는 표시는 exe 가 움직인다)
#[derive(Deserialize, Clone, Debug)]
#[serde(default)]
pub struct TaskSpec {
    pub title: String,
    /// 제목 아래의 본문 줄 (대상 경로 · 완료 화면의 안내). 미리 맞춘 열은 그대로 둔다
    pub lines: Vec<String>,
    pub items: Vec<TaskItem>,
    /// 진행률 0~100. 알 수 없으면 -1 (게이지를 그리지 않는다)
    pub percent: i32,
}

impl Default for TaskSpec {
    fn default() -> Self {
        Self { title: String::new(), lines: vec![], items: vec![], percent: -1 }
    }
}

#[derive(Clone, Debug)]
pub enum Screen {
    /// 다음 지시를 기다리는 중 (배너만)
    Idle,
    Select(SelectSpec),
    Input(InputSpec),
    Confirm(ConfirmSpec),
    Task(TaskSpec),
}

pub struct App {
    pub frame: FrameSpec,
    pub screen: Screen,
    /// 팝업(확인) 아래에 깔리는 화면
    pub under: Option<Screen>,
    pub help: bool,
    /// `Enter 계속` 을 기다리는 중이면 그 뜻 (`계속` · `종료`)
    pub pause: Option<String>,
    /// 답을 보냈고 다음 지시를 기다리는 중 (화면은 그대로 두고 키는 받지 않는다)
    pub frozen: bool,
    /// 지금 화면을 그대로 둔 채 알리는 잠깐의 작업 (키 안내 자리에 돌아가는 표시와 함께 보인다). 다음 화면이 오면 사라진다
    pub busy: Option<String>,
    pub tick: usize,
    /// 이 화면 프로그램을 시작한 때 (돌아가는 표시의 모양을 시간으로 정한다)
    pub born: Instant,
}

impl App {
    pub fn new(frame: FrameSpec, screen: Screen) -> Self {
        Self { frame, screen, under: None, help: false, pause: None, frozen: false, busy: None, tick: 0, born: Instant::now() }
    }

    /// 돌아가는 표시의 지금 모양 (프레임 하나가 150ms)
    pub fn spinner(&self) -> &'static str {
        crate::theme::SPINNER[crate::theme::spinner_frame(self.born.elapsed().as_millis())]
    }
}

impl Row {
    /// 값 열에 보일 글: 상태 문구 · 값
    pub fn value_text(&self) -> String {
        let status = if self.locked && self.status.is_empty() { "필수" } else { self.status.as_str() };
        [status, self.value.as_str()].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" · ")
    }
}
