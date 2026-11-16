# 도구 목록

Oxygen Pi System 번들에 넣을 수 있는 도구입니다. 번들을 만들 때 `fetch-bundle.sh` 선택 화면에서 고르며, 필수 도구는 항상 들어갑니다.
버전, 내려받는 주소, sha256, 라이선스는 [`manifest/tools.lock.tsv`](../manifest/tools.lock.tsv)에 고정되어 있습니다.

## 실행 환경

| 도구 | 구분 | 용도 |
| --- | --- | --- |
| Node.js | 필수 | pi와 설치 도구를 실행하는 런타임 |
| pi | 필수 | 코딩 에이전트 본체 |

## 모델이 쓰는 도구

| 묶음 | 도구 | 구분 | 용도 | 연결되는 스킬 |
| --- | --- | --- | --- | --- |
| core | fd | 필수 | 파일 이름으로 찾기 | `find-code` |
| | ripgrep | 필수 | 파일 내용 검색 | `find-code` |
| | jq | 필수 | JSON 추출, 필터, 변환 | `json-querying` |
| dev-tools | just | 선택 | 프로젝트의 빌드, 테스트 명령 실행 | `project-task-running` |
| | hurl | 선택 | HTTP API 호출과 응답 확인 | `http-api-testing` |
| | psmux | 선택 | 입력을 기다리는 프로그램 조작, 모니터 창 (Windows용 tmux 호환 멀티플렉서) | `terminal-session-control` |
| repository | glab | 선택 | GitLab 머지 요청, 이슈, 파이프라인 | `gitlab-workflow` |
| | gh | 선택 | GitHub PR, 이슈, Actions | `github-workflow` |
| code-intel | ast-grep | 선택 | 문법 구조로 코드 찾기, 여러 곳 일괄 수정 | `structural-code-search` |
| | graphin | 선택 (직접 빌드) | 코드 그래프 검색 MCP 서버. Windows 릴리스가 없어 직접 빌드한 실행 파일을 넣습니다 | `code-graph-search` |
| internet-browsing | agent-browser | 선택 (추천) | 웹 페이지 조작, 화면 확인, 폼 제출 | `web-page-automation` |
| | obscura | 선택 | 웹 페이지 내용 읽기와 수집 | `web-page-reading` |
| | Chrome for Testing | 선택 (추천, 약관 동의) | agent-browser가 쓰는 브라우저 엔진 | - |
| | Chromium | 선택 | agent-browser가 쓰는 오픈소스 브라우저 엔진 | - |
| database | usql | 선택 (추천) | PostgreSQL, MySQL, SQL Server, Oracle, SQLite 조회 | `sql-querying` |
| | Oracle SQLcl | 선택 (약관 동의, Java 17 이상) | Oracle 전용 기능이 필요할 때 | `oracle-db-querying` |
| | dbhub | 선택 | pi 안에서 SQL을 실행하는 MCP 서버 | - |

## 함께 받는 것

| 항목 | 용도 |
| --- | --- |
| oxy-tui | 설치, 설정 화면과 모니터를 그리는 화면 프로그램 (이 저장소의 GitHub Release) |
| D2Coding | 한글이 많은 화면에 맞춘 터미널 글꼴 |

이 둘은 선택 화면에 나오지 않고 항상 함께 받습니다. oxy-tui가 없으면 설치 화면이 번호 입력 방식으로 바뀌고, D2Coding이 없으면 터미널 기본 글꼴을 씁니다.

## 선정 기준

- Windows용 공식 빌드가 있고, 설치 프로그램 없이 실행할 수 있을 것
- 버전을 고정하고 해시로 검증할 수 있을 것
- 실행 중 인터넷에 접속하지 않거나, 그 동작을 끌 수 있을 것
- 오픈소스를 우선하고, 그 밖의 도구는 내려받을 때 약관 동의를 거칠 것
- 같은 일을 하는 도구가 여럿이면, 함께 시험을 가장 많이 한 것에 "추천"을 붙일 것

각 도구의 설정과 Git Bash 보정은 [사용 안내서](guide.md#구성요소)에 있습니다.
