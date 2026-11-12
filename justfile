# oxygen-pi-system 작업 목록. Git Bash 에서 `source ./env.sh` 후 `just <recipe>`.
set shell := ["bash", "-uc"]
set windows-shell := ["bash", "-uc"]

# 사용 가능한 작업 목록
default:
    @just --list

# [인터넷 PC] 반입할 구성요소 선택 → 공식 배포처에서 직접 다운로드 + sha256 검증 + 배치
fetch *args:
    bash scripts/fetch-bundle.sh {{args}}

# [인터넷 PC] 버전을 바꾼 뒤 lock(sha256, npm lockfile) 갱신
lock:
    bash scripts/fetch-bundle.sh --update-lock

# [인터넷 PC] 필수 구성요소 검사 후 폐쇄망 반입용 zip 생성
package:
    bash scripts/package-bundle.sh

# [인터넷 PC] 번들링 전 구성요소 검사만
check:
    bash scripts/package-bundle.sh --check

# agent/oxy.env → agent/settings.json, models.json 생성
configure:
    bash scripts/configure.sh

# 오프라인 자가진단 (vLLM 연결 포함)
verify *args:
    bash scripts/verify.sh {{args}}

# 하네스로 pi 실행
pi *args:
    ./oxy {{args}}

# vLLM 없이 mock 서버로 하네스 E2E 점검 (pi → tool call → Git Bash → extension → 응답)
e2e:
    bash tests/e2e-mock.sh

# extension 단위 테스트
unit:
    ./runtime/node/node.exe --experimental-strip-types --no-warnings --test tests/unit-extensions.test.ts tests/unit-tui.test.mjs

# 전체 테스트 (위생 · 진행판 + 단위 + E2E)
test: hygiene unit e2e

# 저장소 위생 검사(tests/repo-hygiene.sh) + 진행판 검사(docs/dev-board.md 의 상태 · 증거)
hygiene:
    bash tests/repo-hygiene.sh
    ./runtime/node/node.exe tests/board-check.mjs

# 실제 vLLM 없이 mock 서버로 TUI 체험 (프롬프트에 scenario:git-push 등 입력)
demo *args:
    bash tests/demo-tui.sh {{args}}

# 설치 TUI 실행 (실제 설치)
install *args:
    ./runtime/node/node.exe installer/install.mjs {{args}}

# 설치 TUI 체험: mock vLLM + sandbox (PATH·바탕화면 등 실제 시스템은 건드리지 않음)
install-demo:
    bash tests/installer-demo.sh

# 설치 TUI 회귀 테스트 (sandbox, 몇 분 소요)
test-installer:
    bash tests/installer-sandbox.sh

# 설치·설정 TUI 의 화면 프로그램(Ratatui) 빌드 → bin/oxy-tui.exe (Rust 필요. 없으면 TUI 는 줄 입력 모드로 동작한다)
tui-build:
    cd installer/oxy-tui && PATH="$HOME/.cargo/bin:$PATH" cargo build --release
    cp installer/oxy-tui/target/release/oxy-tui.exe bin/oxy-tui.exe

# 화면 프로그램 단위 테스트 (글자 폭 · 배너 · 통신 규약)
tui-test:
    cd installer/oxy-tui && PATH="$HOME/.cargo/bin:$PATH" cargo test --release

# 종합 설정 TUI (모델·DB 연결·extension 등)
tweak *args:
    ./runtime/node/node.exe installer/tweak.mjs {{args}}
