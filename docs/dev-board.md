# 진행판

명세마다 지금 상태 · 막힌 이유 · 다음 할 일을 한곳에서 본다. 상태 이름과 전이 조건은 [개발 과정 명세](dev-process.md) §2, 고치는 사람은 §3 (부모만).

명세 상태: `초안` · `승인` · `구현` · `검증` · `완료` · `보류`. 단계 상태: `예정` · `구현` · `검증` · `완료`.
검사: `./runtime/node/node.exe tests/board-check.mjs` (`just hygiene` · `just test` 에 들어 있다).

## 명세

| ID | 명세 | 상태 | 대기 | 다음 (담당) | 승인 | 커밋 | 설치본 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `monitor` | `docs/monitor-spec.md` 모니터 pane · 하단 바 | 검증 | 부모: `monitor/4` 캡처 기록 | 기록이 있으면 §5 에 적고 `완료`, 없으면 tuicap 캡처 (tui-implementer) | 2026-11-12 | fc5fee7 b141f3c a3a689b ca8dd05 3a8d810 e6d8475 46a5128 b2b1033 f2b2878 | 기록 없음 |
| `llm-conn` | `docs/tui-spec.md` §11 LLM 연결 · 작업 수준 | 구현 | – | `llm-conn/3` 회귀 테스트 먼저 (부모) | 기록 없음 | a78dcae b2b1033 | 2026-11-12 (연결 편집으로 `dropParams` 보정) |
| `anthropic-ws` | `docs/tui-spec.md` §11 "Anthropic 워크스페이스" | 검증 | 사용자: 실제 조직 키 · 설치본 반영 승인 | 키가 생기면 `anthropic-ws/1` `anthropic-ws/2` 실측 (부모) | 2026-11-12 | c424194 | 2026-11-13 (`oxygen-pi-20261113.zip`) |
| `flow-session` | `docs/flow-spec.md` oxy-flow 세션 단위 기록 (사후 명세) | 검증 | 사용자: 과금 실측 요청 (`flow-session/3`) | 요청이 오면 `/3` 설치본의 하이쿠 키로 (부모) | 2026-11-12 | acd4aac | 2026-11-13 (`oxygen-pi-20261113.zip`) |
| `monitor-tui` | `docs/monitor-tui-spec.md` 모니터 화면 개편 (Ratatui) · 실시간 활동 | 완료 | – | 없음 (flow · jobs 화면은 `flow-view` · `jobs-view` 가 이어 바꿨다) | 2026-11-12 | 96de47e d5e23e7 2de77ce d096c67 f9ce774 5271186 | 2026-11-13 (`oxygen-pi-20261113.zip`) |
| `flow-view` | `docs/flow-view-spec.md` flow 모니터 구성 개편 (Current · Next · Overall) · Tokyo Night | 완료 | – | 없음 | 2026-11-13 | f8b4b5c 4ce6514 | 2026-11-13 (`oxygen-pi-20261113.zip`, oxy-tui 0.3.0) |
| `jobs-view` | `docs/jobs-view-spec.md` Job Monitor 구성 개편 (Main · Sub Context, subagent 의 셸) | 완료 | – | 없음. 후속: 업데이트가 WT 프로필을 다시 쓰지 않음 (아래 메모) | 2026-11-13 | f8b4b5c 4ce6514 | 2026-11-13 (`oxygen-pi-20261113.zip`, oxy-tui 0.3.0) |
| `skill-eval` | `tests/skill-eval/README.md` · `.claude/agents/skill-evaluator.md` 확정 사항 | 보류 | 사용자: 재개 요청 · 측정 모델 | 재개하면 `skill-eval/1` 을 #14 부터 (skill-evaluator) | 해당 없음 | eed08b1 751a808 b2b1033 | 해당 없음 |
| `agents` | `.claude/agents/skill-evaluator.md` · `.claude/agents/harness-engineer.md` · `.claude/agents/tui-implementer.md` 보고 · 검증 | 검증 | – | 다음 위임 한 번에서 새 보고 항목이 지켜지는지 확인 (부모) | 2026-11-12 | 안 됨 | 해당 없음 |
| `dev-process` | `docs/dev-process.md` · 이 진행판 · `.claude/rules/delegation-rule.md` | 검증 | – | 다음 위임 한 번을 이 진행판으로 기록해 보고 `완료` (부모) | 2026-11-12 | 안 됨 | 해당 없음 |

## 단계

| 단계 | 내용 | 상태 | 자동 검증 | 실측 | 증거 |
| --- | --- | --- | --- | --- | --- |
| `monitor/1` | oxy-jobs 상태 파일 · 요청 (§3) | 완료 | 단위 · `tests/rpc-jobs.mjs` (커밋 당시, 결과 줄 기록 없음) | 확인 방법이 자동 검증 | fc5fee7 |
| `monitor/2` | oxy-flow 계획 · `flow_plan` (§4) | 완료 | 단위 (커밋 당시) | Groq qwen3.8-27b 가 계획을 쓰고 커밋 뒤 done 으로 바꿈 | b141f3c `docs/monitor-spec.md` §4 |
| `monitor/3` | pane 관리 (§1) | 완료 | 단위 (psmux `-L oxytest-<pid>`) | psmux `list-panes` 로 위치 · 크기, 세션이 남지 않음 | a3a689b `docs/monitor-spec.md` §1 §6 |
| `monitor/4` | 모니터 jobs · flow 화면 (§5) | 검증 | 단위 (view 23 · 30 · 60칸) | 부족: §7 이 요구한 mintty 80×24 캡처의 날짜 · 경로가 없음 (§5 에 mintty 관찰만) | ca8dd05 |
| `monitor/5` | 하단 바 · 클릭 (§2) | 완료 | 단위 | mintty 창 클릭, WT 실제 커서 클릭 (2026-11-12) | 3a8d810 f2b2878 `docs/monitor-spec.md` §2 |
| `monitor/r` | 마무리: `-p` 세션 넘기기 · 손자 프로세스 · eval 복구 · WT 마우스 | 완료 | E2E (`-p -c` 50% 이상, subagent 중지 후 손자 sleep 없음) | WT 실제 클릭 | e6d8475 46a5128 b2b1033 f2b2878 |
| `llm-conn/1` | 연결 여러 개 · 작업 수준 · DPAPI 키 | 완료 | 단위 · E2E · 설치 흐름 (커밋 당시) | `oxy-claude` 등록 · 요청 형식, DPAPI 복호화 시간 (2026-11-12) | a78dcae `docs/tui-spec.md` §11 |
| `llm-conn/2` | 설치본 반영 후 상태 점검 | 검증 | 해당 없음 (실측만) | 실패 (2026-11-12): 설치본 `verify.sh` FAIL, Groq 가 `top_k` 거부. 원인: 구현 결함. 설치본은 Tweak 연결 편집으로 `dropParams` 4개 저장 (부모). 보정 뒤 `verify.sh` 다시 실행한 기록 없음 | a78dcae |
| `llm-conn/3` | 예전 `oxy.env` 를 옮길 때(`migrateLegacy`) 확장 파라미터 판정 | 예정 | 회귀 테스트 후보: mock 의 `MOCK_STRICT_PARAMS=top_k` 로 예전 `oxy.env` 를 옮긴 연결이 `dropParams` 를 갖는지 (고치기 전 실패 확인) | – | – |
| `anthropic-ws/1` | `workspaceId` · 모든 요청의 헤더 · 오류 판정 (라이브러리 · oxy-llm) | 검증 | 단위 · E2E (커밋 당시, 부모 보고) | 안 함: 실제 조직 키 (대기, 저장소의 Claude 키는 401) | c424194 |
| `anthropic-ws/2` | 상태 점검 PASS · FAIL 줄 | 검증 | E2E (커밋 당시, 부모 보고) | 안 함: 실제 조직 키 (대기) | c424194 |
| `anthropic-ws/3` | 화면: 설치 LLM 단계 · Tweak 추가 · 편집 (결정 2건 반영) | 완료 | 단위 59 · Rust 18 · 설치 흐름 59 (tui-implementer 보고) | 캡처 `01-install-ws-list` · `14-install-review-summary` 를 부모가 확인 (2026-11-12) | c424194 `docs/tui-spec.md` §11 |
| `flow-session/1` | 작업 기록을 세션 단위로 (§1) | 검증 | 단위 · E2E (커밋 당시). 2026-11-12 harness-engineer 가 `just test` 로 다시 실행: 통과 (`dev-process/1` 행) | 대화형 pi 1.5.0 + mock LLM: 새로 시작 → 빈 기록, `/resume` → 되살림. 실제 LLM 아님 | acd4aac `docs/flow-spec.md` §1 |
| `flow-session/2` | 설치본 반영 | 완료 | 해당 없음 (실측만) | 2026-11-13 `oxygen-pi-20261113.zip` 으로 업데이트 (사용자 승인), `verify.sh` `FAIL 0` (`monitor-tui/6` 과 같은 업데이트) | acd4aac 5271186 |
| `flow-session/3` | 실제 Claude Haiku 로 compaction (D4 로 `monitor` 에서 옮김) | 예정 | E2E (mock compaction) | 안 함: 과금. 설치본의 하이쿠 키는 유효 (2026-11-13 `llm-check` PASS, 저장소의 키는 401) | – |
| `flow-session/4` | 보관 기록 최근 50개만 유지 (§1, F1) | 완료 | 단위 `# tests 60` `# pass 60` `# fail 0` (기준 `HEAD 4b3fb08 + 미커밋`, 2026-11-12 부모) | 자동 검증으로 대신 (명세 §2 4) | `docs/flow-spec.md` §1 |
| `monitor-tui/1` | 실시간 활동 내보내기 `live.json` (§2) | 완료 | 단위 `# tests 62` `# pass 62` `# fail 0` · E2E `E2E 통과` (`liveTool` · `liveIdle`), 기준 `HEAD fba92fc + 미커밋` (2026-11-13 부모) | 대화형 pi 1.5.0 + mock, psmux 100×30: tool → thinking → idle, 최근 이벤트 · `closed` (2026-11-13) | `docs/monitor-tui-spec.md` §2 |
| `monitor-tui/2` | 보기 모델 (§3) | 완료 | 단위 `# tests 64` `# pass 64` `# fail 0` (23 · 35칸 × 11 · 24줄), 기준 `HEAD 96de47e + 미커밋` (2026-11-13 부모) | 자동 검증으로 대신 (명세 §6 2) | `docs/monitor-tui-spec.md` §4 |
| `monitor-tui/3` | `oxy-tui` 모니터 모드 (§3 §4, tui-implementer) | 완료 | `just tui-test` `33 passed; 0 failed` · 단위 `# pass 66` `# fail 0` (부모가 다시 실행, 기준 `HEAD d5e23e7 + 미커밋`, 2026-11-13) | mintty 80×24 · 120×30 · WT 캡처, 설치 화면 경로 (2026-11-13) | `docs/monitor-tui-spec.md` §4 |
| `monitor-tui/4` | `monitor.ts` 연결 · 예전 화면 대체 (§4) | 완료 | 단위 `# tests 67` `# pass 67` `# fail 0` · E2E `E2E 통과` (새 검사 `liveHeartbeat`: 고치기 전 FAIL · 고친 뒤 PASS), 기준 `HEAD 2de77ce + 미커밋` (2026-11-13 부모) | 대화형 pi + mock, mintty 120×30 · 80×24 실시간 갱신, pi-tui 대체 화면 (2026-11-13) | `docs/monitor-tui-spec.md` §4 |
| `monitor-tui/5` | 실제 LLM 실측 (하이쿠, 사용자 요청) | 완료 | 단위 `# pass 68` `# fail 0` (새 시험 `writeAtomic` 동시 읽기: 고치기 전 FAIL · 고친 뒤 PASS) · E2E `E2E 통과`, 기준 `HEAD d096c67 + 미커밋` (2026-11-13 부모) | 대화형 pi + claude-haiku-5-5, mintty 120×30 · 80×24: 계획 · 편집 · background · 커밋을 모니터가 따라감, 고친 뒤 실패 도구 0 (2026-11-13) | `docs/monitor-tui-spec.md` §4 |
| `monitor-tui/6` | `oxy-tui` 릴리스 · 번들 · 설치본 (승인 필요) | 완료 | 릴리스 워크플로 `oxy-tui-v0.2.0` 성공 (cargo test 33 통과), sha256 `ef141d11…547d47` 를 `manifest/tools.lock.tsv` 에 고정, 받은 exe 로 단위 `# pass 68` `# fail 0` (2026-11-13 부모) | 설치본 업데이트 후 `verify.sh` `PASS 47 / WARN 1 / FAIL 0` (WARN 은 SQLcl 미설치), 설치본 pi 에서 `/monitor flow` 가 oxy-tui 0.2.0 으로 열림 (2026-11-13) | 5271186 `docs/monitor-tui-spec.md` |
| `flow-view/1` | 걸린 시간 기록 (§3) | 완료 | 단위 `# pass 69` `# fail 0` (새 시험 "oxy-flow 걸린 시간") · E2E `E2E 통과` (새 검사 "flow 계획: 걸린 시간 기록"), 기준 `HEAD 4c0d4e8 + 미커밋` (2026-11-13 부모) | 자동 검증으로 대신 (명세 §5 1) | `docs/flow-view-spec.md` §3 |
| `flow-view/2` | 보기 모델 (§2) | 완료 | 단위 `# pass 69` `# fail 0` (flow 보기 모델 · 키 처리 시험을 새 구성으로, 23 · 35칸 × 11 · 15 · 24줄), 예시 모델 `tests/fixtures/monitor` 다시 만듦, 기준 `HEAD 4c0d4e8 + 미커밋` (2026-11-13 부모) | 자동 검증으로 대신 (명세 §5 2). 지금 exe(0.2.0)로 그린 글자 화면 확인 | `docs/flow-view-spec.md` §2 |
| `flow-view/3` | `oxy-tui` 그리기 · 모니터 팔레트 (tui-implementer) | 완료 | `just tui-test` `37 passed; 0 failed` · 단위 `# pass 70` `# fail 0` (부모가 다시 실행, 기준 `HEAD 4c0d4e8 + 미커밋`, 2026-11-13) | mintty 80×24 · 120×30 (기본 · tokyo-night) · WT 캡처, `◀` 1칸 확인 (2026-11-13) | `docs/flow-view-spec.md` §5 |
| `flow-view/4` | Tokyo Night 반입 · 적용 | 완료 | 단위 `# pass 70` · E2E `E2E 통과` · `tests/installer-sandbox.sh` 통과 (새 검사 WT 색 구성), 기준 `HEAD 4c0d4e8 + 미커밋` (2026-11-13 부모) | fetch 로 테마를 받아 configure 가 `theme: tokyo-night` 를 씀, 실제 pi 가 tokyo-night 로 뜸 (5단계와 함께, 2026-11-13) | `docs/flow-view-spec.md` §5 |
| `flow-view/5` | 실제 LLM 실측 (하이쿠) | 완료 | 해당 없음 (실측만) | 대화형 pi + claude-haiku-5-5, mintty 120×30 · 80×24: 2단 계획 · background · 커밋을 Current · Next · Overall 이 따라감, 걸린 시간, 실패 도구 0 (2026-11-13) | `docs/flow-view-spec.md` §5 |
| `flow-view/6` | `oxy-tui` 릴리스 · 번들 · 설치본 (승인 필요) | 완료 | 릴리스 워크플로 `oxy-tui-v0.3.0` 성공, sha256 `20e22ba9…228fbf` 를 `manifest/tools.lock.tsv` 에 고정, 받은 exe 로 단위 `# pass 72` `# fail 0` (2026-11-13 부모) | 설치본 업데이트 후 `verify.sh` `PASS 47 / WARN 1 / FAIL 0` (WARN 은 SQLcl 미설치), 설치본 pi 의 테마 tokyo-night, `/monitor flow` · `/monitor jobs` 가 Flow Monitor · Job Monitor 로 열림, WT 프로필은 업데이트가 다시 쓰지 않아 부모가 설치본 코드로 다시 씀 (2026-11-13) | 4ce6514 `docs/flow-view-spec.md` |
| `jobs-view/1` | subagent 의 셸 내보내기 (§3) | 완료 | 단위 `# pass 71` (새 시험 subagent 의 실행 폴더) · E2E `E2E 통과` (새 검사 subState · subStop · subDone), 기준 `HEAD 4c0d4e8 + 미커밋` (2026-11-13 부모) | 자동 검증으로 대신 (명세 §4 1), 실제 LLM 은 4단계 | `docs/jobs-view-spec.md` §3 |
| `jobs-view/2` | 보기 모델 · 키 처리 (§2) | 완료 | 단위 `# pass 71` `# fail 0` (Job Monitor 보기 모델 · 키 처리 시험을 새 구성으로), 예시 모델 `jobs-sub` · `jobs-popup` 추가, 기준 `HEAD 4c0d4e8 + 미커밋` (2026-11-13 부모) | 지금 exe(0.3.0 로컬)로 그린 글자 화면 확인, 빈 영역 `-` 가운데 | `docs/jobs-view-spec.md` §2 |
| `jobs-view/3` | 화면 프로그램: 팝업 · 배지 · ←→ (tui-implementer) | 완료 | `just tui-test` `45 passed; 0 failed` · 단위 `# pass 72` · `tests/installer-sandbox.sh` 통과 (부모가 다시 실행, 기준 `HEAD 4c0d4e8 + 미커밋`, 2026-11-13) | mintty 80×24 · 120×30 (tokyo-night · 기본) · WT 팝업 캡처 (2026-11-13) | `docs/jobs-view-spec.md` §4 |
| `jobs-view/4` | 실제 LLM 실측 (하이쿠) | 완료 | 해당 없음 (실측만) | 대화형 pi + claude-haiku-5-5, mintty 120×30: worker 의 셸 표시 · subagent 화면 · 팝업으로 그 셸만 중지 · 빈 영역 `-`, 모니터 pane 이 닫히던 결함을 찾아 고침 (2026-11-13) | `docs/jobs-view-spec.md` §4 |
| `jobs-view/5` | 릴리스 · 번들 · 설치본 (`flow-view/6` 과 함께, 승인 필요) | 완료 | 릴리스 워크플로 `oxy-tui-v0.3.0` 성공, sha256 `20e22ba9…228fbf` 를 `manifest/tools.lock.tsv` 에 고정, 받은 exe 로 단위 `# pass 72` `# fail 0` (2026-11-13 부모) | 설치본 업데이트 후 `verify.sh` `PASS 47 / WARN 1 / FAIL 0` (WARN 은 SQLcl 미설치), 설치본 pi 의 테마 tokyo-night, `/monitor flow` · `/monitor jobs` 가 Flow Monitor · Job Monitor 로 열림, WT 프로필은 업데이트가 다시 쓰지 않아 부모가 설치본 코드로 다시 씀 (2026-11-13) | 4ce6514 `docs/jobs-view-spec.md` |
| `skill-eval/1` | before 기준선 28문장 | 구현 | 해당 없음 (실측만) | 13 / 28 (Groq qwen/qwen3.8-27b, 한도로 중단). 13개 통과, #6 은 모델 오류 | 751a808 `tests/skill-eval/README.md` |
| `skill-eval/2` | after 후보 측정 | 예정 | – | – | – |
| `skill-eval/3` | 반영 (P · N · G 어느 것도 나빠지지 않을 때) + SKILL.md frontmatter 단위 테스트 | 예정 | – | – | – |
| `agents/1` | 세 정의의 검증 명령 · 보고 항목 (A10 ~ A12) | 검증 | 위생 · 진행판 검사 통과 (2026-11-12) | – | `.claude/agents/harness-engineer.md` |
| `dev-process/1` | §8 적용 (A1 ~ A15) | 검증 | `just test` (2026-11-12, 작업 트리 = `HEAD acd4aac` + 미커밋): 결과는 메모 | 새 E2E 표식이 다른 실행의 sleep 을 죽이지 않음 (메모) | `docs/dev-process.md` §8 |

## 메모

`monitor`
- 실제 Claude compaction 확인은 D4 에 따라 `flow-session/3` 으로 옮겼다. 남은 것은 `monitor/4` 의 캡처 기록뿐이다 (이미 본 캡처가 있으면 날짜 · 창 크기 · 경로만 §5 에 적으면 된다).
- `설치본` 열: 2026-11-12 번들 업데이트에 이 커밋들이 들어갔는지 기록이 없다 (부모 확인).

`llm-conn`
- §11 에 사용자 승인 표시(`결정된 사항 (사용자, 날짜)`)가 없다. 승인은 대화에서만 있었다.
- `llm-conn/2` 원인 (부모, 2026-11-12): 예전 `oxy.env` 에서 `llm.json` 으로 옮긴 vllm 연결(주소는 Groq)에 `dropParams` 가 없어 Groq 가 `top_k` 를 거부했다. `migrateLegacy` 가 확장 파라미터를 판정하지 않는 구현 결함이다.
  완료된 단계 뒤의 회귀이므로 T9: `llm-conn/3` 의 회귀 테스트를 먼저 더하고 지금 코드에서 실패하는 것을 확인한 뒤 고친다. 화면과 무관한 코드라 위임 규칙상 부모가 맡는다.

`anthropic-ws`
- 결정 2건은 사용자가 권장안대로 승인했고(2026-11-12) `docs/tui-spec.md` 의 그 절에 `결정된 사항` 으로 적었다.
- 화면 프로그램의 새 릴리스는 필요 없다: 배포된 `oxy-tui` v0.1.0 exe 가 이미 `InputSpec.error` 를 읽는다 (tui-implementer 보고, Rust 변경은 주석 · 테스트뿐). 단계 `anthropic-ws/4` 는 지웠다.

`flow-session`
- 사후 명세 `docs/flow-spec.md` 를 썼다. 2026-11-12 사용자가 승인하고 F1 ~ F3 을 권장안 (a) 로 정했다 (T2). 구현이 이미 있어 T3b 로 `검증` 에 옮겼다: `dev-process/1` 의 `just test` 통과 + 부모의 단위 60 통과.
- F1 (보관 기록 50개)은 `flow-session/4` 로 구현했다 (`pruneArchive`). 커밋 메시지 "Keep only the latest 50 archived flow logs".
- 다시 연 세션의 첫 요청에 계획 · `Next` 가 들어가는지 검사를 E2E 에 되살렸다 (`dev-process/1`, A9 (c)).

`skill-eval`
- 사용자 요청이 있을 때만 재개한다. `tests/skill-eval/README.md` 의 진행 표를 `results.json`(before 13개)과 맞췄다.
- 이어서 잴 때 측정 모델이 before 13개와 같아야 한다 (Groq `qwen/qwen3.8-27b`). `results.json` 에는 모델이 적혀 있지 않다.

`agents` · `dev-process`
- `완료` 조건: 다음 위임 한 번에서 부모가 `.claude/rules/delegation-rule.md` 와 `docs/dev-process.md` §4 로 넘기고, 에이전트가 새 보고 항목(결과 줄 · 기준 · 확인한 것과 추측 · 뺀 검사)으로 돌려주고, 부모가 이 진행판에 옮긴 것을 확인했을 때.
- `dev-process/1` 의 `just test` 결과 (2026-11-12, `bash -c 'cd /c/… && source ./env.sh && just test'`, 종료코드 0, 4분 54초): `저장소 위생 검사 통과` · `진행판 검사 통과 (WARN 2)` · 단위 `# tests 59` `# pass 59` `# fail 0` · `[oxy] E2E 통과` (E2E PASS 65, FAIL 0).
- A9 증거: E2E 와 `just test` 전에 다른 실행처럼 보이는 `sleep 41 500` · `sleep 41.5 500` 을 띄워 두었고, 끝난 뒤에도 살아 있었다. 같은 두 프로세스에 예전 정리 명령(시스템 전체의 `*41*` 종료)을 돌리자 둘 다 죽었다. 새 세기 조건은 이 실행의 표식으로 남은 sleep 은 1 로 세고, 표식의 앞부분만 같은 값은 0 으로 센다.

## 회고

- 2026-11-12 `monitor/5`: WT 클릭이 안 된 원인이 ConPTY 의 순서였다 (raw 모드 전 마우스 요청을 버림). → 명세 확정(§2)과 함정 목록 5. 테스트: 단위 테스트가 시퀀스를 확인한다. pi 버전을 올리면 다시 실측.
- 2026-11-12 `monitor/r`: 두 에이전트가 동시에 테스트를 돌려 `sleep` 수 검사와 설치 폴더 삭제 대기가 오탐했다. → 공유 자원 표(§4)와 A9 (a): E2E 가 실행마다 다른 표식으로 sleep 을 세고 정리한다 (예전에는 끝날 때 시스템 전체의 `*41*` sleep 을 죽였다).
- 2026-11-12 `flow-session/1`: E2E 가 시스템 프롬프트에도 있는 문구를 찾아 오탐, 초 단위 id 충돌로 단위 테스트가 가끔만 실패. → 함정 13 · 14, A9 (b): flow 검사는 시스템 프롬프트를 뺀 메시지(`CONV`)에서 찾는다. id 는 무작위 꼬리로 고쳤다.
- 2026-11-12 `llm-conn/2`: 업데이트 후 상태 점검 FAIL 을 실제 설치본에서야 발견. 원인은 `migrateLegacy`. → 회귀 테스트 후보 `llm-conn/3` (아직 만들지 않음).
- 2026-11-12 (여러 단계): Git Bash 의 `source env.sh` 가 설치본을 읽음, 로그 경로 `NUL` 이 실제 파일이 되어 키가 든 요청 헤더가 남음, python 으로 고친 파일이 CRLF. → `tests/repo-hygiene.sh` (A5). `env.sh:2` 주석 1건을 고쳤다 (A6).
- 2026-11-12 (부모): 근거 없이 추측을 사실처럼 말함 (Groq 라고 안내했는데 Claude, 워크스페이스 키 추측이 틀림). → 보고 항목 "확인한 것과 추측", skill-evaluator 의 판정 모델 확인 규칙, 함정 16. 검사로는 만들 수 없다.
- 2026-11-12 (harness-engineer): Claude Code Bash 도구의 맨 위 셸에서 `source ./env.sh` 후 `just` 를 찾지 못함 (pwd 가 `C:/…`). → 함정 2, 에이전트 정의의 검증 명령을 `./bin/just.exe` 로.
- 2026-11-12 `dev-process/1`: 인자 없는 `cat > 파일` 을 실수로 남겨 명령이 입력을 기다리며 멈췄다 (한 번). → 만들지 않음: 한 번뿐이고 피해가 없었다.
- 2026-11-13 `monitor-tui/3`: 설치 점검 화면의 `번들 구성요소  C:\…\oxygen-pi-sys… (필수 5개 확인)` 줄은 경로 뒤에 괄호 설명이 붙어 `fit` 의 경로 줄임이 적용되지 않고 끝이 잘린다. 후속: `install.mjs` 문구에서 괄호 설명을 경로 앞으로 (tui-spec 범위, 아직 진행판 단계 없음).
- 2026-11-13 `monitor-tui/4`: 실측에서 `live.json` 의 `updatedAt` 이 이벤트 없는 동안 갱신되지 않아 긴 도구에서 "pi 상태를 알 수 없습니다". 1단계 E2E 는 3초 도구라 놓쳤다. → E2E 를 8초 도구로 바꾸고 갱신 검사를 더했다 (회고: 시간 경계가 있는 동작은 그 경계를 넘는 시험을 둔다).
- 2026-11-13 `jobs-view/4`: subagent 가 끝날 때 본 대화의 모니터 pane 이 닫혔다. 모니터 pane 기능(`monitor`) 때부터 있던 결함인데, 그동안의 실측에 subagent 가 없어 드러나지 않았다. 또 같은 날 전체 E2E 가 한 번 임시 폴더(`requests.jsonl`)가 사라져 중간에 멈췄고 다시 돌리면 통과했다 (원인 미확인). → 회고: 실측 시나리오에는 그 기능과 함께 쓰이는 다른 기능(subagent · background · 모니터)을 한 번은 함께 넣는다.
- 2026-11-13 `flow-view/6`: 설치 TUI 의 업데이트는 파일 복사와 설정 파일만 다시 만들고 PATH · WT 프로필 · 바로가기는 다시 쓰지 않는다. 그래서 WT 프로필의 Tokyo Night 색 구성(`flow-view` T3)이 업데이트로는 기존 설치본에 들어가지 않았다 (이 PC 는 부모가 설치본의 `addTerminalProfile` 로 다시 씀, 기존 파일은 scratchpad `wt-fragment.bak.json`). 후속: 업데이트가 등록된 WT 프로필을 다시 쓰도록 (`docs/tui-spec.md` 의 업데이트 단계, tui-implementer).
- 2026-11-13 `jobs-view/1`: E2E `liveHeartbeat` 가 한 번 실패, 다시 돌리면 통과. 원인: 8초 도구에서 상태를 늦게 읽으면 다음 5초 갱신 전에 도구가 끝난다 → 도구를 12초로. 같은 날 단위 시험의 `FLOW.md` 걸린 시간 `(0:00)` 도 커밋이 1초를 넘으면 실패 → `m:ss` 형태만 본다 (회고: 시간 값을 정확히 맞추는 시험은 경계보다 넉넉한 여유를 둔다).
- 2026-11-13 `monitor-tui/5`: 실제 LLM 실측에서 모니터가 `flow.json` 을 읽는 순간 oxy-flow 의 쓰기(이름 바꾸기)가 Windows EPERM 으로 실패. mock E2E 는 모니터 pane 을 띄우지 않아 놓쳤다. → 공용 `writeAtomic` 으로 다시 시도, 동시 읽기 단위 시험 추가 (회고: 다른 프로세스가 읽는 파일을 쓰는 코드는 동시 읽기 시험을 둔다).
