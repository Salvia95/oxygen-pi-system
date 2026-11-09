# oxygen-pi-system

폐쇄망 Windows 11 + Git Bash 환경에서 사내 vLLM(Qwen 계열, 128K)을 사용하는 [pi coding agent](https://pi.dev) 하네스.
**실행 중 외부 네트워크 접속을 하지 않는다.**

이 저장소는 **하네스(pi 설정·extension·skill·스크립트·설치 TUI)만** 제공하고 바이너리는 배포하지 않는다.
필요한 바이너리는 각 사용자가 인터넷 PC 에서 공식 배포처로부터 **직접 내려받아 번들로 묶은 뒤, 본인이 반입**한다.

```
[인터넷 PC]  fetch (구성요소 선택 → 직접 다운로드·검증)  →  package (필수 구성요소 검사 → zip)
                                                                  │  본인이 반입
[폐쇄망 PC]                                   install.cmd (설치 TUI)  ←┘
```

## 구성요소

`manifest/tools.lock.tsv` 에 버전, URL, sha256, 라이선스, 구분(`role`), 계층(`group`)이 고정되어 있다.
npm 패키지(pi, dbhub)는 `manifest/<이름>-package-lock.json` 으로 고정한다. 표시 정보와 skill 연결은 `installer/components.mjs` 의 CATALOG.

같은 계층 안에서 여러 개를 고를 수 있고, 호환성이 가장 검증된 대안에 **추천** 표시가 붙는다.

| 계층 | 구성요소 | 종류 | 라이선스 | 연결되는 skill |
|---|---|---|---|---|
| **core** (필수) | Node.js 22, pi coding agent | 런타임 | MIT | — |
| | fd, ripgrep | 도구 | Apache-2.0·MIT / Unlicense·MIT | `find-code` |
| | jq | 도구 | MIT | `json-querying` |
| **dev-tools** | just | 도구 | CC0-1.0 | `project-task-running` |
| | hurl | 도구 | Apache-2.0 | `http-api-testing` |
| **repository** | glab (GitLab) | 도구 | MIT | `gitlab-workflow` |
| | gh (GitHub / GHE) | 도구 | MIT | `github-workflow` |
| **internet-browsing** | agent-browser **추천** | 도구 (페이지 조작) | Apache-2.0 | `web-page-automation` |
| | obscura | 도구 (읽기·수집) + 엔진 | Apache-2.0 | `web-page-reading` |
| | Chrome for Testing **추천** | 엔진 | Google Chrome 약관 (비오픈소스) | — |
| | Chromium 오픈소스 빌드 | 엔진 | BSD-3-Clause | — |
| **database** | usql **추천** | CLI (PostgreSQL·MySQL·SQLite·SQL Server·Oracle 등) | MIT | `sql-querying` |
| | Oracle SQLcl | CLI (Oracle 전용, Java 17+) | Oracle Free Use T&C (비오픈소스) | `oracle-db-querying` |
| | dbhub | MCP 커넥터 (pi 도구로 SQL 실행) | MIT | — (연결은 Tweak TUI 의 DB 연결에서 등록) |

- agent-browser 의 브라우저 엔진은 설치 TUI 에서 고른다: Chrome for Testing (추천) / Chromium / obscura / PC 의 Edge·Chrome / 사용 안 함.
  obscura 를 고르면 `wrappers/agent-browser` 가 obscura CDP 서버를 필요할 때 띄우고 연결한다 (Chrome 대비 약 1/3 용량, 일부 CDP 기능 미지원).
- usql 의 Oracle 드라이버는 순수 Go 라 Oracle Instant Client 가 필요 없다. SQLcl 은 Oracle 전용 기능(`info`, `ddl` 등)이 필요할 때 추가한다.

전제: 폐쇄망 PC에 **Git for Windows** 가 설치되어 있어야 한다. **Java 17 이상**은 SQLcl 을 쓸 때만 필요하다.

### 구성요소 원칙

- 저장소에는 바이너리를 넣지 않는다. URL·버전·sha256 만 고정하고, 각 사용자가 공식 배포처에서 직접 받는다.
- `role=required`: 하네스 동작에 필요한 것. fetch 선택 화면에서 **기본 체크(해제 불가)**, 번들링할 때 없으면 실패한다.
- `role=optional`: 사용자가 필요한 것만 고른다. 반입하지 않으면 verify 는 WARN 으로 알리고 해당 skill 만 쓸 수 없다.
- 오픈소스가 아닌 라이선스(SQLcl, Chrome for Testing)는 고를 때 약관을 보여 주고 동의를 받는다. 만든 번들은 본인 반입용이다.
- 다른 런타임에 의존하는 도구(예: agent-browser 의 브라우저)는 설치 TUI 에서 **여러 선택지를 보여 주고, 호환성이 가장 검증된 것에 (추천)** 을 붙인다.
- 새 바이너리를 추가할 때도 같은 기준을 따른다 (`installer/components.mjs` 의 CATALOG 에 설명·확인 파일 추가).

## 1) 인터넷 PC: 직접 받아서 번들링

```bash
bash scripts/fetch-bundle.sh      # 선택 화면: 필수 항목은 체크된 채 고정, 나머지는 골라서 (이전 선택 기억)
source env.sh
just package                      # 필수 구성요소 검사 → dist/oxygen-pi-YYYYMMDD.zip (+ .sha256)
```

비대화형 실행:

```bash
bash scripts/fetch-bundle.sh --defaults                         # 필수만
bash scripts/fetch-bundle.sh --select=glab,hurl,agent-browser,chromium
bash scripts/fetch-bundle.sh --all --accept-license             # 전부 (비오픈소스 약관 동의를 미리 표시)
bash scripts/package-bundle.sh --check                          # 번들링 전 검사만
```

- 선택에서 뺀 구성요소가 이전에 받아져 있으면 지운다 (번들에 원치 않는 파일이 들어가지 않도록).
- 버전을 올릴 때는 `manifest/tools.lock.tsv` 의 version/url 을 수정하고 `--update-lock` 을 붙여 실행한다.
- 번들에 없는 SQLcl·Chrome for Testing 은 폐쇄망 PC 에서 zip 으로 추가할 수도 있다: 받은 `sqlcl-*.zip` / `chrome-win64.zip` 을
  `Downloads` 폴더나 번들의 `optional/` 에 두면 설치 TUI 가 찾는다.

## 2) 폐쇄망 PC: 설치

zip 을 푼 폴더의 **`install.cmd` 를 더블클릭**하면 설치 TUI 가 열린다 (Git Bash 에서는 `./install.sh`).

```
1. 점검    Git Bash · Java 17+ · 번들의 필수 구성요소
2. 위치    기본 %LOCALAPPDATA%\Programs\oxygen-pi (또는 현재 폴더 그대로 / 직접 입력)
3. 선택    SQLcl: 번들에 있으면 설치 / 직접 받은 zip 지정 (sha256 을 manifest 와 대조) / 설치 안 함
           브라우저: Chrome for Testing (추천) / Chromium / PC 의 Edge·Chrome / 사용 안 함  (고른 것만 복사)
4. vLLM    주소·API 키 입력 → /v1/models 로 연결 확인
5. 모델    코딩 모델 / 범용 모델(선택) 고르기, max_model_len 으로 컨텍스트 자동 입력
6. GitLab  사내 호스트 (선택)
7. 등록    PATH · Windows Terminal 'Oxygen Pi' 프로필 · 바탕화면 바로가기
8. 확인    요약 → 설치 → 자가진단(verify)
```

- 방향키·Enter·Space 로 조작하고, **Esc 는 이전 단계**로 돌아간다.
- 설치 후 다시 실행하면 **설정 변경 / 자가진단 / 업데이트 / 제거** 메뉴가 나온다.
  - 업데이트할 때 `agent/oxy.env` 는 유지된다.
  - 제거할 때 `oxy.env` 는 `%APPDATA%\oxygen-pi\oxy.env.bak` 으로 백업된다.
- 선택 구성요소를 설치하지 않으면 verify 는 FAIL 이 아니라 WARN 으로 표시한다. 나중에 "설정 변경"에서 추가할 수 있다.
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

## 3) 종합 설정 (Tweak TUI)

설치 폴더의 **`tweak.cmd`** (Git Bash 에서는 `./tweak.sh`, `just tweak`) 로 설치 후 설정을 한곳에서 바꾼다.

| 메뉴 | 내용 |
|---|---|
| 모델 · vLLM · 브라우저 · SQLcl · 시스템 등록 | 설치 TUI 의 "설정 변경"과 같은 흐름 (Esc 로 메뉴 복귀) |
| DB 연결 | PostgreSQL · MySQL · MariaDB · SQL Server · Oracle · SQLite 연결 추가·편집·연결 시험·삭제. 연결마다 **usql**(CLI) / **dbhub**(pi MCP 도구) 중 쓸 도구와 읽기 전용 여부를 고른다 |
| extension | 안전장치 4종 켜기/끄기, 출력 한도·반복 차단 횟수 |
| 자가진단 | verify 실행 |

DB 연결은 다음처럼 저장된다 (모두 PC 로컬, git·번들 제외):

- `agent/connections.json`: 연결 정보 원본 (비밀번호 없음)
- `agent/secrets.json`: 비밀번호. **Windows DPAPI** 로 암호화돼 현재 Windows 사용자만 복호화할 수 있다 (PowerShell 에는 stdin 으로 전달, 평문 파일·명령줄 없음)
- `agent/usql.yaml`: usql 이름 붙은 연결 (비밀번호 없음). `wrappers/usql` 이 실행할 때만 비밀번호를 넣은 임시 설정을 만들고 바로 지운다
- `agent/dbhub.toml` + `agent/mcp.json`: dbhub 소스와 pi MCP 등록 (`exposure: direct`, 연결마다 `lazy` 접속).
  비밀번호는 `${OXY_DB_<ID>_PASSWORD}` 로 참조하고, pi 가 서버를 띄울 때 `!command` 로 복호화해 넘긴다 (전역 환경변수에 남지 않음)
- 모델이 비밀 저장소를 읽거나 복호화하는 명령은 bash-guard 가 차단한다 (`secret-access`)

pi 도구 이름: 연결이 하나면 `mcp__dbhub__execute_sql`, 여러 개면 `mcp__dbhub__execute_sql_<연결 이름>` (search_objects 도 같음). 실행 중인 pi 에는 `/reload` 로 반영된다.

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
- `AGENT_BROWSER_EXECUTABLE_PATH` : agent-browser 가 브라우저를 내려받지 않도록, 설치할 때 고른 브라우저(`OXY_BROWSER`)를 지정
- `npm_config_offline=true`

## 디렉터리

```
install.cmd, install.sh 설치 TUI 실행 (installer/)
tweak.cmd, tweak.sh     종합 설정 TUI (installer/tweak.mjs)
oxy, oxy.cmd, env.sh   런처 / 환경
VERSION                하네스 버전 (설치 TUI 배너에 표시)
wrappers/              Git Bash 보정 래퍼 (sql, jq, usql, agent-browser)
config/                도구 설정 (ripgreprc)
tests/                 mock vLLM + E2E 점검
justfile               작업 목록 (just --list)
manifest/              버전·해시 고정 파일
scripts/               fetch / package / configure / verify
agent/                 PI_CODING_AGENT_DIR
  AGENTS.md            전역 규칙 (모델에게 주는 환경 설명)
  templates/           settings.json, models.json 템플릿
  extensions/ prompts/
  skill-library/       skill 원본 (설치된 구성요소의 것만 skills/ 로 켜짐)
```

## 소형 모델용 extension (`agent/extensions/`)

pi 는 권한 시스템이 없고 기본 동작이 대형 모델 기준이므로 다음 4종을 기본으로 로드한다. 각각 환경변수로 끌 수 있다.

| extension | 동작 | 끄기 |
|---|---|---|
| `oxy-bash-guard` | 체인 명령을 세그먼트별로 검사. **차단**: 루트/홈/드라이브 삭제, 디스크 포맷, 종료, 패키지 설치(폐쇄망). **확인**: 재귀 삭제, `git push`/`reset --hard` 등, glab·gh 쓰기, DB 변경 SQL(sql·usql, `@script.sql`·`-f` 파일 내용 포함). 확인 UI 가 없는 `-p` 모드에서는 확인 대상도 차단 | `OXY_BASH_GUARD=off` |
| `oxy-read-before-edit` | 읽지 않았거나 읽은 뒤 디스크에서 바뀐 파일의 edit 차단, 기존 파일 write 는 read 후에만 허용. compaction 후 기록 초기화 | `OXY_READ_BEFORE_EDIT=off` |
| `oxy-loop-guard` | 텍스트로 쓴 tool call(`<tool_call>` 등) 감지 시 재호출 안내(최대 2회), 빈 응답 1회 재촉, 같은 호출 3번째 차단(파일 수정 시 초기화) | `OXY_LOOP_GUARD=off` (`OXY_REPEAT_LIMIT`) |
| `oxy-context-budget` | bash/grep/find/ls 출력 12K자, read 40K자 초과 시 앞뒤만 남김. 상태줄에 컨텍스트 사용률 표시, 압축 반복 경고 | `OXY_CONTEXT_BUDGET=off` (`OXY_TOOL_OUTPUT_MAX_CHARS`, `OXY_READ_MAX_CHARS`) |

컨텍스트 관리(작업 기록 · 세션 넘기기 · compaction 교체)는 아래 oxy-flow 참고.
테스트: `just test` (단위 테스트 + mock vLLM E2E 9개 시나리오), `just test-installer` (설치 TUI 전체 흐름, sandbox).
`just demo` 는 mock vLLM 으로 pi TUI 를 직접 써 보는 명령이다 (프롬프트에 `scenario:git-push` 등 입력).

## 작업 흐름 기록 · 컨텍스트 관리 (`agent/extensions/oxy-flow/`)

LLM 요약(compaction)에 기대지 않고, **작업 기록 파일**로 컨텍스트를 이어간다. 기록은 프로젝트의 `.oxy/flow/`에 남는다
(`.oxy/.gitignore` 를 스스로 만들어 사용자 저장소에는 잡히지 않는다).

| 구분 | 동작 |
|---|---|
| 커밋 단위 노드 | `git commit` 이 성공하면 노드(`n1`, `n2` …)를 만들고 그 사이의 **결정 사항**과 커밋 파일을 붙인다. pi 밖에서 한 커밋도 다음 요청 때 노드로 잡힌다 |
| 자동 기록 | 수정한 파일, 명령 성공/실패(실패는 마지막 출력, 같은 명령이 성공하면 해결로 처리), 백그라운드 작업·subagent |
| 모델 도구 | `flow_note` (결정+이유 · 목표 · 다음 단계 · 막힌 점 · 완료) / `flow_show` (현재 상태 · `node=n3` 세부 · `query=` 결정 검색) |
| 새 세션 | 첫 요청에 작업 상태(목표 · 최근 노드의 결정 · 커밋 전 작업 · 해결 안 된 실패)를 넣는다. 오래된 노드는 제목만 (`OXY_FLOW_CONTEXT_MAX_CHARS`, 기본 6000자) |
| 세션 넘기기 | 컨텍스트가 `OXY_FLOW_ROLLOVER_PCT`(기본 50%) 이상인 상태에서 새 메시지를 보내면, **그 메시지를 새 세션에서** 작업 상태와 함께 처리한다. 직접: `/oxy-rollover [메시지]` |
| 작업 도중 한도 | 도구를 연달아 쓰는 중에는 세션을 바꿀 수 없으므로 pi compaction 이 안전망으로 남는다. 이때 **LLM 요약 대신 작업 상태 + 최근 요청**으로 교체한다 (요약 호출 없음). `OXY_FLOW_COMPACT=llm` 이면 pi 기본 요약 |
| `/flow` | 기록 보기 · `show n3` · `trace 키워드`(결정 추적) · `new 목표`(현재 작업 보관 후 새로 시작) · `rollback n3`(확인 후 이후 커밋을 `git revert`, 이력은 지우지 않음) |
| 락 | 프로젝트마다 쓰는 pi 는 하나 (`.oxy/flow/lock`, PID). 다른 pi 가 쓰는 중이면 읽기 전용, 주인이 없으면 넘겨받는다. subagent 는 기록하지 않는다 |

컨텍스트 여유분: `compaction.reserveTokens=49152` (128K 의 약 62% 에서 compaction). 응답 최대 32K + 도구 출력 한 묶음을 담을 수 있는 크기다.
기록 엔진은 `store.ts` 의 `FlowEngine` 경계 뒤에 있어, 이후 flowout 으로 바꿀 수 있다. 끄기: `OXY_FLOW=off` · 세션 넘기기만 끄기: `OXY_FLOW_ROLLOVER=off`.

## 백그라운드 작업 · subagent (`agent/extensions/oxy-jobs/`)

작은 컨텍스트를 아끼기 위해, 오래 걸리는 명령과 넓은 탐색을 본 대화 밖으로 뺀다.

| 도구 | 동작 |
|---|---|
| `background` | `action=start` 로 명령을 백그라운드 실행 → 바로 작업 id 반환. **끝나면 결과(종료 코드·마지막 출력)를 메시지로 알려 새 턴을 시작**하므로 모델이 polling 하지 않는다. `status` / `output` / `stop`. bash-guard 검사를 똑같이 거친다 |
| `subagent` | `agent/agents/*.md` 의 도우미(scout · reviewer · worker)를 별도 pi 프로세스(독립 컨텍스트)로 실행. `tasks=[...]` 로 병렬, `wait=false` 면 백그라운드로 돌리고 완료 시 결과를 알린다. 자식에는 agent 에 지정한 도구만 주어 재귀 실행을 막는다 |

- **동시 실행 제한**: `OXY_LLM_MAX_CONCURRENT` (subagent, 기본 2) · `OXY_JOBS_MAX_CONCURRENT` (bash, 기본 4). 넘치는 작업은 대기열에서 순서대로 시작한다.
  사내 vLLM 의 실제 한계는 요청 수보다 **동시에 처리하는 긴 컨텍스트 요청의 KV 캐시**이므로, 128K 기준으로 2 에서 시작해 조정한다.
- **vLLM 혼잡 감지** (선택): `OXY_VLLM_METRICS=on` 이면 subagent 를 시작하기 전에 vLLM `/metrics` 의 대기 요청 수와 KV 캐시 사용률
  (`OXY_VLLM_KV_LIMIT`, 기본 0.9)을 보고 잠시 기다린다. 지표 이름은 vLLM 버전에 따라 다를 수 있어 사내 서버에서 확인 후 켠다.
- **가시성**: 입력창 위 작업 패널(`⏳ job-3 bash  npm test  1m12s  마지막 출력`), 상태줄(`jobs 2 · agents 1/2`),
  `/jobs` (로그 보기 · Windows Terminal 이면 옆 창에 `tail -f` 로 로그 열기 · 중지). 로그는 `agent/jobs/*.log` (최근 50개 보관).
- **비대화형(`-p`)**: 대화가 끝나기 전에 남은 작업을 기다렸다가 결과를 모아 넘기고 이어서 진행한다 (`OXY_JOBS_WAIT_MS`, 기본 30분).
- pi 를 종료하면 실행 중인 작업은 프로세스 트리째 정리한다. 자가진단이 남은 subagent 프로세스를 찾아 알린다.
- 켜기/끄기·혼잡 감지·동시 실행 수는 Tweak TUI 의 extension 메뉴에서 바꾼다 (`OXY_JOBS=off` 로 끔).

## 도구별 skill (`agent/skill-library/` → `agent/skills/`)

skill 이름은 도구가 아니라 **용도** 기준이고, description 은 "무엇을 · 언제 쓰는지"를 구체적으로 적는다.
원본은 `agent/skill-library/` 에 있고, configure 와 설치 TUI 가 **설치된 구성요소의 skill 만** `agent/skills/` 로 켠다
(브라우저를 "사용 안 함"으로 고르면 `web-page-automation` 도 끈다). `agent/skills/` 에 직접 넣은 사용자 skill 은 건드리지 않는다.
시스템 프롬프트에는 켜진 skill 의 이름과 설명만 들어가고, 모델이 필요할 때 SKILL.md 를 read 로 읽는다.
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
| `github-workflow` | PR·리뷰·이슈·Actions·GitHub API (gh) | `--json --jq`, 쓰기는 승인 후, `--web` 금지, `gh api -f` 는 쓰기 |
| `sql-querying` | 여러 DB 의 데이터·스키마 조회, .sql 실행 (usql) | 이름 붙은 연결(`agent/usql.yaml`), `-w -q --csv`, DB별 행 수 제한 문법 |
| `web-page-reading` | 페이지 내용·링크 추출, 여러 페이지 수집 (obscura) | `--dump markdown/text`, `--selector` 는 대기만, 일부 추출은 `scrape --eval` |

환경 쪽 보정:
- `wrappers/agent-browser`: `OXY_BROWSER=obscura` 이면 obscura CDP 서버를 띄우고 `AGENT_BROWSER_CDP` 로 연결한다.
- `wrappers/usql`: PC 로컬 연결 설정 `agent/usql.yaml` (git·번들 제외)이 있으면 자동으로 `--config` 로 넘긴다.
- obscura: 기본은 사설망 주소 접속을 막으므로(SSRF 방지) `OBSCURA_ALLOW_PRIVATE_NETWORK=1` 을 켠다.
- gh: 업데이트 확인·텔레메트리·진행 애니메이션을 끈다 (`GH_*`).
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

이 저장소는 바이너리를 포함하지도 배포하지도 않는다. `scripts/fetch-bundle.sh` 로 각 사용자가 공식 배포처에서 직접 받는
서드파티 구성요소(Node.js, pi, fd, ripgrep, jq, just, hurl, glab, agent-browser, Chromium, Chrome for Testing, Oracle SQLcl)는
각자의 라이선스를 따른다. 오픈소스가 아닌 Chrome for Testing 과 Oracle SQLcl 은 받을 때 약관 동의를 받으며,
이를 포함해 만든 번들은 본인 반입용이다. 다른 사람에게 배포하려면 해당 약관을 따로 확인한다.
