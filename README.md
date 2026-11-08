# oxygen-pi-system

폐쇄망 Windows 11 + Git Bash 환경에서 사내 vLLM(Qwen 계열, 128K)을 사용하는 [pi coding agent](https://pi.dev) 하네스.
실행에 필요한 Node, pi, CLI 도구, 브라우저를 모두 번들에 포함하며 **실행 중 외부 네트워크 접속을 하지 않는다**.

## 구성요소

`manifest/tools.lock.tsv` 에 버전, URL, sha256 이 고정되어 있다. pi 는 npm lockfile(`manifest/pi-package-lock.json`)로 고정한다.

| 구성요소 | 위치 | 용도 |
|---|---|---|
| Node.js 22 (portable) | `runtime/node` | pi 실행 (시스템 Node 버전과 무관) |
| pi coding agent | `vendor/pi` | 에이전트 본체 |
| fd, rg, jq, just, hurl, glab, agent-browser | `bin/` | 에이전트·사용자 공용 CLI |
| Chrome for Testing | `vendor/browsers/chrome-win64` | agent-browser 전용 브라우저 |
| SQLcl | `runtime/sqlcl` | Oracle DB 작업 (시스템 Java 17+ 사용) |

전제: 폐쇄망 PC에 **Git for Windows** 와 **Java 17 이상**이 설치되어 있어야 한다.

## 1) 인터넷 PC: 번들 만들기

```bash
bash scripts/fetch-bundle.sh      # lock 기준 다운로드 + sha256 검증
source env.sh
just package                      # → dist/oxygen-pi-YYYYMMDD.zip (+ .sha256)
```

버전을 올릴 때는 `manifest/tools.lock.tsv` 의 version/url 을 수정하고 `just lock` 을 실행한다.

## 2) 폐쇄망 PC: 설치

```bash
# zip 해제 후 해당 폴더에서 (Git Bash)
bash scripts/configure.sh         # 최초 실행 시 agent/oxy.env 생성 → 편집 후 재실행
bash scripts/verify.sh            # 오프라인 자가진단 (PASS/WARN/FAIL)
bash tests/e2e-mock.sh            # vLLM 없이 mock 서버로 pi 전체 루프 점검
./oxy                             # 실행 (cmd / Windows Terminal 에서는 oxy.cmd)
```

`agent/oxy.env` 에서 설정하는 값: vLLM 주소, API 키, served-model-name, 컨텍스트 길이, GitLab 호스트.

## 사내 vLLM 요구사항

pi 는 OpenAI Chat Completions 의 tool calling 을 사용한다. vLLM 서버에 다음 옵션이 필요하다.

```
--enable-auto-tool-choice --tool-call-parser <모델에 맞는 파서, 예: qwen3_coder / hermes>
--max-model-len 131072
--served-model-name <oxy.env 의 OXY_MODEL_* 값>
# 하이브리드 thinking 모델: --reasoning-parser qwen3
```

`just verify` 가 `/v1/models` 조회와 tool call 왕복을 실제로 시험한다.

## 오프라인 보장 장치

- `PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1`, `PI_TELEMETRY=0`, `enableInstallTelemetry=false`
- `PI_CODING_AGENT_DIR=agent/` : 설정·세션·skill 이 모두 하네스 안에 있음 (`~/.pi` 미사용)
- `agent/bin/{fd,rg}.exe` : pi 가 GitHub 에서 자동 다운로드하지 않도록 미리 배치
- `AGENT_BROWSER_EXECUTABLE_PATH` : agent-browser 가 브라우저를 내려받지 않도록 번들 Chrome 지정
- `npm_config_offline=true`

## 디렉터리

```
oxy, oxy.cmd, env.sh   런처 / 환경
wrappers/              Git Bash 보정 래퍼 (sql)
tests/                 mock vLLM + E2E 점검
justfile               작업 목록 (just --list)
manifest/              버전·해시 고정 파일
scripts/               fetch / package / configure / verify
agent/                 PI_CODING_AGENT_DIR
  AGENTS.md            전역 규칙 (모델에게 주는 환경 설명)
  templates/           settings.json, models.json 템플릿
  extensions/ skills/ prompts/
```

## Git Bash 보정

- `wrappers/sql` : SQLcl 을 sh 런처(`bin/sql`)로 호출한다.
  - `sql.exe` 는 설치 경로가 약 120자를 넘으면 접근 위반으로 크래시하므로 사용하지 않는다 (26.3.1 에서 확인).
  - sh 런처는 `JAVA_HOME` 을 그대로 믿으므로, 유효하지 않으면 실제 `java` 위치로 보정한다.
  - Git Bash 가 `/nolog` 를 `C:/Program Files/Git/nolog` 로 바꾸는 문제를 `MSYS_NO_PATHCONV=1` 로 막는다.
- pi 를 스크립트에서 `-p` 로 실행할 때 stdin 이 TTY 가 아니면 입력을 기다린다 → `< /dev/null` 을 붙일 것.

## Windows 터미널 참고

pi 문서상 mintty(기본 Git Bash 창)에서는 화면에 이상한 문자가 섞일 수 있다. **Windows Terminal 의 Git Bash 프로필**에서 실행하는 것을 권장한다.
