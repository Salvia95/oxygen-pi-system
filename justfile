# oxygen-pi-system 작업 목록. Git Bash 에서 `source env.sh` 후 `just <recipe>`.
set shell := ["bash", "-uc"]
set windows-shell := ["bash", "-uc"]

# 사용 가능한 작업 목록
default:
    @just --list

# [인터넷 PC] lock 에 고정된 구성요소 다운로드 + sha256 검증 + 배치
fetch:
    bash scripts/fetch-bundle.sh

# [인터넷 PC] 버전을 바꾼 뒤 lock(sha256, npm lockfile) 갱신
lock:
    bash scripts/fetch-bundle.sh --update-lock

# [인터넷 PC] 폐쇄망 반입용 zip 생성
package:
    bash scripts/package-bundle.sh

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
    ./runtime/node/node.exe --experimental-strip-types --no-warnings --test tests/unit-extensions.test.ts

# 전체 테스트 (단위 + E2E)
test: unit e2e

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
