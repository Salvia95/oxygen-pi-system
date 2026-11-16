<div align="center">

# Oxygen Pi System

작은 모델과 적은 예산으로 돌리는 Windows용 코딩 에이전트

[기능](#기능) · [다루지 않는 것](#다루지-않는-것) · [설치](#설치) · [사용](#사용) · [내장 스킬](#내장-스킬) · [도구](#도구) · [문서](#문서) · [기여하기](#기여하기)

</div>

Oxygen Pi System은 오픈소스 코딩 에이전트 [pi](https://pi.dev)를 **작은 모델에 맞게 보정**하고 Windows용 설치 도구를 더한 배포판입니다.
도구 호출이 서툴고 컨텍스트가 짧은 모델에게도 파일 수정부터 테스트 실행까지 맡길 수 있습니다. LLM은 OpenAI 호환 API(직접 띄운 서버 포함)와 Anthropic API를 모두 연결할 수 있습니다.

이런 경우에 쓰려고 만들었습니다.

- 직접 띄운 LLM 서버로 코딩 에이전트를 쓰고 싶을 때
- 무료나 저가 API의 요청 한도 안에서 써야 할 때
- 인터넷이 안 되는 PC에서 써야 할 때

## 기능

### 작은 모델 보정

모델이 도구 호출을 본문에 글로 써 버리면 다시 호출하라고 알려 주고, 같은 호출을 되풀이하거나 읽지 않은 파일을 고치려 하면 **실행 전에 차단**합니다.
긴 명령 출력은 앞뒤만 남기고 줄입니다.

### 요약 대신 작업 기록

컨텍스트가 가득 차면 대화를 요약하는 대신, 따로 기록해 둔 목표, 계획, 결정, 커밋을 **새 세션에 넘겨** 작업을 이어 갑니다.
잘못된 작업이 있어도 계획, 커밋 단위로 되돌릴 수 있습니다.

### 모델 나눠 쓰기

LLM 연결을 여러 개 등록해 쉬운 일은 **저렴한 모델**에, 어려운 일은 성능 좋은 모델에 맡깁니다.
LLM API의 분당 요청 한도, 토큰 한도에 걸리지 않도록 요청 속도도 조절합니다.

### 오프라인 설치와 실행

필요한 도구를 **번들 하나**로 묶어 인터넷이 없는 PC에도 설치하고 실행할 수 있습니다.

### 위험 명령 확인

재귀 삭제, `git push`, DB 변경 같은 명령은 **실행 전에 사용자에게 묻고**, 시스템을 망가뜨릴 수 있는 명령은 차단합니다.

### 비밀 정보 보관

API 키와 비밀번호는 암호화해 보관하며, **정보를 입력한 Windows 계정에서만** 사용할 수 있습니다.

### 백그라운드 작업과 모니터

오래 걸리는 명령은 백그라운드에서, 여러 계층에 걸친 탐색이나 독립된 개발 작업은 **하위 에이전트**에서 돌려 메인 대화의 컨텍스트를 아낍니다.
진행 상황은 터미널 옆에 띄운 `Flow Monitor`와 `Job Monitor`에서 볼 수 있습니다.

## 다루지 않는 것

- **Windows(x64) 전용**입니다. macOS와 Linux에서는 실행되지 않습니다.
- LLM 서버나 모델을 포함하지 않으며, 사용에는 별도의 LLM API가 필요합니다.
- 외부 도구의 실행 파일을 직접 포함하지 않으며, 사용자의 필요에 따른 번들링 기능만 제공합니다.
- **독립된 실행 환경이 아닙니다.** 모든 명령은 사용자 계정의 권한으로 실행됩니다.
- IDE 확장이나 웹페이지는 지원하지 않습니다.

## 설치

인터넷 접속이 가능한 PC에서 번들(Oxygen Pi System과 도구 실행 파일을 담은 폴더)을 만든 뒤, 사용할 PC에 옮겨 설치합니다.
번들을 만든 PC에 바로 설치할 수도 있으며, **관리자 권한은 필요 없습니다.**

### 준비물

번들을 만들 PC

| 항목 | 내용 |
| --- | --- |
| 운영체제 | Windows (Linux, Mac 지원 예정) |
| 디스크 | ~4GB |
| 필요한 도구 | [Git for Windows](https://gitforwindows.org/) (Git Bash 포함) |

Oxygen Pi System을 사용할 PC

| 항목 | 내용 |
| --- | --- |
| 운영체제 | Windows x64 |
| 디스크 | ~2GB |
| 필요한 도구 | Git for Windows |
| LLM | 도구 호출(tool calling)을 지원하는 LLM API |
| 인터넷 | 불필요 |

> Git for Windows는 번들에 들어 있지 않습니다. 인터넷이 없는 PC라면 설치 파일을 따로 옮겨야 합니다.
>
> Oracle SQLcl을 쓰려면 사용할 PC에 Java 17 이상이 필요합니다.
>
> 직접 띄운 vLLM 서버라면 `--enable-auto-tool-choice`와 `--tool-call-parser` 옵션을 켜야 도구 호출이 동작합니다.

### 번들 만들기

#### Windows (추천)

Git Bash에서 실행합니다. 선택 화면에서 고른 도구를 공식 배포처에서 내려받아 sha256으로 검증합니다.

```bash
git clone https://github.com/Salvia95/oxygen-pi-system.git
cd oxygen-pi-system
bash scripts/fetch-bundle.sh      # 도구 선택, 내려받기, 검증
bash scripts/package-bundle.sh    # 다른 PC로 옮길 zip 생성 → dist/oxygen-pi-YYYYMMDD.zip, .sha256
```

#### Linux

지원 예정입니다. 지금은 Windows PC에서 만든 번들을 사용합니다.

#### Mac

지원 예정입니다. 지금은 Windows PC에서 만든 번들을 사용합니다.

### 설치하기

#### 번들을 만든 PC에 설치

저장소 폴더의 Git Bash에서 실행합니다. 탐색기에서 `install.cmd`를 더블클릭해도 됩니다.

```bash
cd oxygen-pi-system
./install.sh
```

#### 다른 PC에 설치

`oxygen-pi-YYYYMMDD.zip`과 `.sha256` 파일을 옮긴 뒤, 쓰는 셸에 맞춰 무결성 확인, 압축 해제, 설치 순서로 실행합니다.

##### PowerShell

```powershell
cd $HOME\Downloads
(Get-FileHash .\oxygen-pi-YYYYMMDD.zip).Hash -eq (Get-Content .\oxygen-pi-YYYYMMDD.zip.sha256).Split(" ")[0]   # True면 정상
Expand-Archive .\oxygen-pi-YYYYMMDD.zip -DestinationPath $HOME\oxygen-pi-bundle
cd $HOME\oxygen-pi-bundle\oxygen-pi-system
.\install.cmd
```

##### 명령 프롬프트 (cmd)

```bat
cd %USERPROFILE%\Downloads
REM 출력된 해시가 .sha256 파일의 값과 같으면 정상
certutil -hashfile oxygen-pi-YYYYMMDD.zip SHA256
mkdir %USERPROFILE%\oxygen-pi-bundle
%SystemRoot%\System32\tar.exe -xf oxygen-pi-YYYYMMDD.zip -C %USERPROFILE%\oxygen-pi-bundle
cd %USERPROFILE%\oxygen-pi-bundle\oxygen-pi-system
install.cmd
```

##### Git Bash

```bash
cd ~/Downloads
sha256sum -c oxygen-pi-YYYYMMDD.zip.sha256    # OK가 나오면 정상
unzip -q oxygen-pi-YYYYMMDD.zip -d ~/oxygen-pi-bundle
cd ~/oxygen-pi-bundle/oxygen-pi-system
./install.sh
```

설치 명령을 실행하면 설치 TUI가 열립니다. 설치 폴더, 사용할 도구, LLM 연결과 모델, 터미널 설정을 **필요에 맞게 골라** 설치할 수 있습니다.

### 설치 확인하기

새 터미널(Windows Terminal의 Oxygen Pi 프로필 또는 Git Bash)을 열고 차례로 실행합니다. 점검 결과가 **`FAIL 0`이면** 설치가 끝난 것입니다.

```bash
oxy --version                                              # pi 버전이 나오면 PATH 등록 완료
bash ~/AppData/Local/Programs/oxygen-pi/scripts/verify.sh  # 기본 설치 폴더 기준. 결과: PASS n / WARN n / FAIL 0
oxy -p "안녕"                                               # 답이 오면 LLM 연결 정상
```

> `WARN`은 설치하지 않은 선택 도구를 알리는 것으로, 동작과는 무관합니다.

## 사용

### 시작하기

Windows Terminal의 Oxygen Pi 프로필이나 바탕화면 바로가기로 셸을 열고, 프로젝트 폴더에서 `oxy`를 실행합니다.

```bash
cd ~/work/my-service
oxy                                         # 대화형으로 시작 (할 일은 한국어로 입력)
oxy -c                                      # 이 폴더의 마지막 세션 이어서 열기
oxy -r                                      # 이어서 열 세션 고르기
oxy -p "테스트를 돌리고 실패 원인을 알려줘"     # 화면 없이 한 번 실행하고 끝내기
oxy mux                                     # 이번만 psmux 세션에서 실행 (모니터 사용 가능)
oxy --no-mux                                # 이번만 psmux 없이 지금 창에서 실행
```

### 자주 쓰는 명령

| 명령 | 설명 |
| --- | --- |
| `/flow` | 작업 목표, 계획, 결정, 커밋 기록 보기 |
| `/flow rollback <기록 번호>` | 그 기록 이후의 작업 되돌리기 (커밋은 `git revert`) |
| `/jobs` | 백그라운드 작업과 하위 에이전트의 진행 확인, 중지 |
| `/monitor flow` | `Flow Monitor` 열기, 닫기 (psmux 세션에서) |
| `/monitor jobs` | `Job Monitor` 열기, 닫기 (psmux 세션에서) |

### 설정 변경, 업데이트, 제거

`tweak.cmd`는 설치된 항목을 하나씩 바꾸는 **설정 화면**이고, `install.cmd`는 설치 자체를 다시 하거나 지우는 **관리 화면**입니다. 둘 다 설치 폴더에 있습니다.

| 실행 파일 | 지원하는 작업 |
| --- | --- |
| `tweak.cmd` | LLM 연결과 모델, DB 연결, GitLab 연결, 브라우저, 확장 기능과 스킬 켜기/끄기, 실행 제한, PATH와 바로가기, 상태 점검 |
| `install.cmd` | 처음부터 다시 설정, 상태 점검, 제거 |
| 새 번들의 `install.cmd` | 업데이트 (설정과 연결 유지) |

## 내장 스킬

내장 스킬은 번들 도구의 사용법을 담은 문서입니다. **시스템 프롬프트에는 이름과 한 줄 설명만 실리고**, 모델은 필요할 때 본문을 읽습니다. 현재 13개를 제공합니다.

- 이름이 하는 일 기준(`sql-querying`, `http-api-testing`)이라, 모델이 도구 이름을 몰라도 알맞은 스킬을 찾습니다.
- 설치한 도구의 스킬만 켜지므로 프롬프트가 불필요하게 길어지지 않습니다.
- 명령은 번들에 든 도구 버전으로, 설명은 실제 모델로 시험해 검증합니다.

직접 만든 스킬은 설치 폴더의 `agent/skills/`에 두면 내장 스킬과 함께 쓰입니다. 내장 스킬 목록은 [사용 안내서](docs/guide.md#도구별-skill-agentskill-library--agentskills)에 있습니다.

## 도구

모델은 실행 중인 셸 내에서 사용 가능한 CLI 도구를 선택해 사용합니다. 번들에 포함되는 도구는 다음 기준에 따라 선정됩니다.

- Windows용 공식 빌드가 있고, 설치 프로그램 없이 실행할 수 있을 것
- 버전을 고정하고 해시로 검증할 수 있을 것
- 실행 중 인터넷에 접속하지 않거나, 그 동작을 끌 수 있을 것
- 오픈소스를 우선하고, 그 밖의 도구는 내려받을 때 약관 동의를 거칠 것

전체 도구와 용도는 [도구 목록](docs/tools.md)에 있습니다.

## 문서

| 문서 | 대상 | 내용 |
| --- | --- | --- |
| [사용 안내서](docs/guide.md) | 사용자 | 설치 옵션, 설정 파일, LLM과 DB 연결, 기능별 상세 동작 |
| [도구 목록](docs/tools.md) | 사용자 | 번들에 넣을 수 있는 도구, 용도, 연결되는 스킬 |
| [개발 과정](docs/dev-process.md) | 기여자 | 개발 순서, 명세 문서 위치 |

## 기여하기

버그 제보와 기능 제안은 [GitHub 이슈](https://github.com/Salvia95/oxygen-pi-system/issues)로 받습니다.
코드를 고칠 때는 관련 명세를 먼저 고친 뒤 [개발 과정](docs/dev-process.md)의 순서를 따르고, PR을 보내기 전에 아래 검사를 통과시켜 주세요.

```bash
bash scripts/fetch-bundle.sh   # 검사에 쓰는 도구 내려받기 (just 포함)
source ./env.sh                # 번들 도구를 PATH에 추가
just test                      # 저장소 검사, 단위 테스트, mock LLM 기반 E2E 시나리오
just tui-test                  # 설치, 설정 화면과 모니터 테스트 (Rust 필요)
just test-installer            # 임시 폴더에 설치하는 전체 흐름
```

## 라이선스

이 저장소의 코드는 [Apache License 2.0](LICENSE)을 따르며, 저작권 표기는 [NOTICE](NOTICE)에 있습니다.
번들에 들어가는 외부 프로그램은 각자의 라이선스를 따르고, 그 목록은 [사용 안내서](docs/guide.md#라이선스)에 있습니다.
