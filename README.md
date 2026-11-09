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

zip 을 푼 폴더의 **`install.cmd` 를 더블클릭**하면 설치 TUI 가 열린다 (Git Bash 에서는 `./install.sh`).

```
1. 점검    Git Bash · Java 17+ · 번들 구성요소
2. 위치    기본 %LOCALAPPDATA%\Programs\oxygen-pi (또는 현재 폴더 그대로 / 직접 입력)
3. vLLM    주소·API 키 입력 → /v1/models 로 연결 확인
4. 모델    코딩 모델 / 범용 모델(선택) 고르기, max_model_len 으로 컨텍스트 자동 입력
5. GitLab  사내 호스트 (선택)
6. 등록    PATH · Windows Terminal 'Oxygen Pi' 프로필 · 바탕화면 바로가기
7. 확인    요약 → 설치 → 자가진단(verify)
```

- 방향키·Enter·Space 로 조작하고, **Esc 는 이전 단계**로 돌아간다.
- 설치 후 다시 실행하면 **설정 변경 / 자가진단 / 업데이트 / 제거** 메뉴가 나온다.
  - 업데이트할 때 `agent/oxy.env` 는 유지된다.
  - 제거할 때 `oxy.env` 는 `%APPDATA%\oxygen-pi\oxy.env.bak` 으로 백업된다.
- 설치 기록은 `%APPDATA%\oxygen-pi\install.json` 에 남는다.
- 진짜 콘솔이 아닌 환경(파이프 입력, winpty 없는 mintty)에서는 번호를 입력하는 줄 입력 모드로 동작한다.
- `--sandbox <폴더>` 를 주면 레지스트리(PATH)·바탕화면·AppData 대신 그 폴더에만 기록한다 (체험·테스트용).
  `just install-demo` 는 mock vLLM 과 sandbox 로 설치 TUI 를 체험하는 명령이다.

수동 설치도 가능하다:

```bash
bash scripts/configure.sh         # 최초 실행 시 agent/oxy.env 생성 → 편집 후 재실행
bash scripts/verify.sh            # 오프라인 자가진단 (PASS/WARN/FAIL)
./oxy                             # 실행 (cmd / Windows Terminal 에서는 oxy.cmd)
```

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
install.cmd, install.sh 설치 TUI 실행 (installer/)
oxy, oxy.cmd, env.sh   런처 / 환경
VERSION                하네스 버전 (설치 TUI 배너에 표시)
wrappers/              Git Bash 보정 래퍼 (sql, jq)
config/                도구 설정 (ripgreprc)
tests/                 mock vLLM + E2E 점검
justfile               작업 목록 (just --list)
manifest/              버전·해시 고정 파일
scripts/               fetch / package / configure / verify
agent/                 PI_CODING_AGENT_DIR
  AGENTS.md            전역 규칙 (모델에게 주는 환경 설명)
  templates/           settings.json, models.json 템플릿
  extensions/ skills/ prompts/
```

## 소형 모델용 extension (`agent/extensions/`)

pi 는 권한 시스템이 없고 기본 동작이 대형 모델 기준이므로 다음 4종을 기본으로 로드한다. 각각 환경변수로 끌 수 있다.

| extension | 동작 | 끄기 |
|---|---|---|
| `oxy-bash-guard` | 체인 명령을 세그먼트별로 검사. **차단**: 루트/홈/드라이브 삭제, 디스크 포맷, 종료, 패키지 설치(폐쇄망). **확인**: 재귀 삭제, `git push`/`reset --hard` 등, glab 쓰기, DB 변경 SQL(`@script.sql` 내용 포함). 확인 UI 가 없는 `-p` 모드에서는 확인 대상도 차단 | `OXY_BASH_GUARD=off` |
| `oxy-read-before-edit` | 읽지 않았거나 읽은 뒤 디스크에서 바뀐 파일의 edit 차단, 기존 파일 write 는 read 후에만 허용. compaction 후 기록 초기화 | `OXY_READ_BEFORE_EDIT=off` |
| `oxy-loop-guard` | 텍스트로 쓴 tool call(`<tool_call>` 등) 감지 시 재호출 안내(최대 2회), 빈 응답 1회 재촉, 같은 호출 3번째 차단(파일 수정 시 초기화) | `OXY_LOOP_GUARD=off` (`OXY_REPEAT_LIMIT`) |
| `oxy-context-budget` | bash/grep/find/ls 출력 12K자, read 40K자 초과 시 앞뒤만 남김. 상태줄에 컨텍스트 사용률 표시, 압축 반복 경고 | `OXY_CONTEXT_BUDGET=off` (`OXY_TOOL_OUTPUT_MAX_CHARS`, `OXY_READ_MAX_CHARS`) |

자동 compaction 은 `settings.json` 의 `compaction.reserveTokens=24576` (128K 의 약 81%) 에서 시작한다.
테스트: `just test` (단위 테스트 + mock vLLM E2E 9개 시나리오), `just test-installer` (설치 TUI 전체 흐름, sandbox).
`just demo` 는 mock vLLM 으로 pi TUI 를 직접 써 보는 명령이다 (프롬프트에 `scenario:git-push` 등 입력).

## 도구별 skill (`agent/skills/`)

skill 이름은 도구가 아니라 **용도** 기준이고, description 은 "무엇을 · 언제 쓰는지"를 구체적으로 적는다.
시스템 프롬프트에는 이름과 설명만 들어가고(7개 합쳐 약 900 토큰), 모델이 필요할 때 SKILL.md 를 read 로 읽는다.
명령과 옵션은 번들 버전의 `--help` 와 실제 실행으로 확인한 것만 넣었다.

| skill | 쓰는 때 (도구) | 핵심 |
|---|---|---|
| `find-code` | 심볼 정의·사용처, 파일 유형·날짜별 목록, 일괄 처리 (rg, fd) | 단순 검색은 내장 grep/find 우선, fd 첫 인자는 패턴 |
| `json-querying` | JSON 필드 추출·필터·CSV 변환·값 수정 (jq) | `--arg` 로 값 전달, 파일 수정은 임시 파일 경유 |
| `oracle-db-querying` | 테이블 데이터·스키마·DDL·PL/SQL 조회, .sql 실행 (sql) | 저장된 연결(`-name`), heredoc/`@script` 만 (`-e` 는 콘솔 없이 실패), SP2- 오류는 종료코드 0 |
| `gitlab-workflow` | MR·리뷰 코멘트·이슈·파이프라인·GitLab API (glab) | `-F json --jq`, 쓰기는 승인 후, `glab api -F` 는 암묵적 POST |
| `http-api-testing` | API 호출·응답 확인·API 테스트 작성 (hurl) | `.hurl` 파일 + `--variable`, Asserts/Captures, `--test` |
| `web-page-automation` | 화면 확인·UI 흐름·폼 제출·스크린샷 (agent-browser) | 세션 이름 필수, snapshot 의 `@ref` 만 사용 |
| `project-task-running` | 빌드·테스트 명령 찾기·작업 추가 (just) | `just --list` 우선, recipe 작성 규칙 |

환경 쪽 보정:
- `wrappers/jq`: `jq.exe` 의 CRLF 출력을 막기 위해 `-b`(LF)를 항상 붙인다.
- `config/ripgreprc`: rg 경로를 `/` 로 출력한다. pi 의 grep 도구는 `--no-config` 라 영향 없음.
- `wrappers/sql`: SQLcl 에 `-noupdates` 를 붙인다.
- glab: 업데이트 확인·텔레메트리·Duo CLI 자동 다운로드·하이퍼링크 제어문자를 끈다 (`GLAB_*`).
- agent-browser: 버전 일치 가이드 `vendor/agent-browser-skill-data` 를 `AGENT_BROWSER_SKILLS_DIR` 로 지정한다.

## Git Bash 보정

- `wrappers/sql` : SQLcl 을 sh 런처(`bin/sql`)로 호출한다.
  - `sql.exe` 는 설치 경로가 약 120자를 넘으면 접근 위반으로 크래시하므로 사용하지 않는다 (26.3.1 에서 확인).
  - sh 런처는 `JAVA_HOME` 을 그대로 믿으므로, 유효하지 않으면 실제 `java` 위치로 보정한다.
  - Git Bash 가 `/nolog` 를 `C:/Program Files/Git/nolog` 로 바꾸는 문제를 `MSYS_NO_PATHCONV=1` 로 막는다.
- pi 를 스크립트에서 `-p` 로 실행할 때 stdin 이 TTY 가 아니면 입력을 기다린다 → `< /dev/null` 을 붙일 것.

## Windows 터미널 참고

pi 문서상 mintty(기본 Git Bash 창)에서는 화면에 이상한 문자가 섞일 수 있다. **Windows Terminal 의 Git Bash 프로필**에서 실행하는 것을 권장한다.

## 라이선스

이 저장소의 코드는 [Apache License 2.0](LICENSE) 을 따른다 (저작권 표기: [NOTICE](NOTICE)).

`scripts/fetch-bundle.sh` 가 내려받아 번들에 넣는 서드파티 구성요소(Node.js, pi, fd, ripgrep, jq, just, hurl, glab,
agent-browser, Chrome for Testing, Oracle SQLcl)는 이 저장소에 포함되지 않으며 각자의 라이선스를 따른다.
특히 Oracle SQLcl 은 Oracle 의 라이선스 조건이 적용되므로, 번들을 사내에 배포하기 전에 해당 조건을 확인한다.
