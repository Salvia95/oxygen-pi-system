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

# vLLM 없이 mock 서버로 하네스 E2E 점검 (pi → tool call → Git Bash → 응답)
e2e:
    bash tests/e2e-mock.sh
