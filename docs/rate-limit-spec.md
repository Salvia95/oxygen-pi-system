# 연결별 요청 한도 대기 명세

LLM 연결마다 분당 요청 수(RPM) · 분당 토큰 수(TPM) 한도를 두고, 한도에 닿으면 pi 가 요청을 보내기 전에 기다린다.
진행 상태: [진행판](dev-board.md) 의 `rate-limit` 행. 관련: `docs/pi-tui-spec.md` §6.1 (푸터 표시).

## 0. 요청과 결정

- 요청 (사용자, 2026-11-14): "vllm 연결에 대해서는 rpm(request per minite, tpm(token per minute) 표시 기능(1분 슬라이딩 윈도우를 사용할거야)을 추가해줘 … 일단 표시부터 구현하고 요청을 이를 고려해서 대기하거나, 재시도할 수 있는지도 분석해서 말해줘"
- 결정 (사용자, 2026-11-14, §6 에 대한 답): "1. 넣지마 대화 입력창에 표시되는걸로 충분해 2. Pending for n sec: RPM Limit으로 하고 남은시간도 보여주자 3. 고쳐줘" — Tweak 입력 화면은 만들지 않는다(설정은 llm.json), 대기 글은 영어 `Pending for 17 sec: RPM Limit` (n = 남은 초), Flow Monitor 의 Current Task 에도 보인다.
- 결정 (사용자, 2026-11-14): "설치본 반영하고 한도 대기기능 만들자" — 분석에서 제안한 방식(연결별 rpm · tpm 설정, 프로세스 사이 공유, 대기 표시)으로 만든다.

## 1. 확인된 사실

- pi 1.5.0 은 요청 직전 이벤트 `before_provider_request` 의 핸들러를 기다린다 (`core/extensions/runner.js` `emitBeforeProviderRequest`). 확장이 요청을 붙잡아 둘 수 있다. `ctx.signal` 로 사용자의 멈춤(Esc)을 안다.
- 응답 직후 `after_provider_response` 로 상태 코드 · 헤더를 받는다. pi 는 429 · 5xx 에 재시도하고 `Retry-After` 를 지킨다 (횟수 · 최대 대기는 render-config 가 `settings.json` 에).
- vLLM 자체에는 RPM/TPM 한도가 없다 (바쁘면 줄을 세워 느려진다). 429 는 앞단 게이트웨이(LiteLLM · nginx 등)가 있을 때 나온다.
- 본 대화 · subagent(oxy-jobs 의 자식 pi) · 다른 oxy 세션은 서로 다른 프로세스다. 한도는 서버 하나에 걸리므로 함께 세야 한다.

## 2. 설정

- `agent/llm.json` 연결의 `request.rpm` · `request.tpm` (0 이상의 정수, 없거나 0 이면 제한 없음). 모든 연결 종류에 쓸 수 있다 (`LLM_KINDS[*].request` 에 `rpm` · `tpm`).
- 끄기: `OXY_RATE=off`.
- Tweak 입력 화면은 두지 않는다 (사용자 결정, 입력창 표시로 충분). 한도는 `llm.json` 을 고쳐 정한다.

## 3. 대기 규칙 (`agent/extensions/oxy-rate/limiter.ts`)

- 1분 슬라이딩 윈도우. 요청은 보낼 때 1 (재시도 포함), 토큰은 보낼 때 어림(지금 컨텍스트 토큰, 모르면 본문 길이 / 4)으로 넣고 응답이 끝나면 실제 입력 + 출력(캐시 포함)으로 바꾼다.
- RPM: 윈도우 안 요청이 한도면 가장 오래된 것 하나가 빠질 때까지. TPM: 윈도우 안 토큰 + 어림이 한도를 넘으면 넘지 않을 만큼 빠질 때까지. 둘 다면 더 긴 쪽. 요청 하나가 TPM 한도보다 크면 기다려도 소용없어 바로 보낸다.
- 429: `Retry-After`(초 · 날짜) → `x-ratelimit-reset-requests` · `-tokens` → 없으면 10초. 그 시각까지 이 연결의 모든 프로세스가 기다린다 (pi 의 재시도도 그 뒤에 나간다).
- 기다리는 동안 1초마다 다시 본다. Esc 로 멈추면 바로 끝내고, 한 요청이 5분을 넘게 기다리면 보내고 서버 · pi 재시도에 맡긴다.

## 4. 프로세스 사이 공유 (`store.ts`)

- `agent/rate/<연결 id>/<pid>.json` = `{ pid, updatedAt, events: [{at, tokens}], blockedUntil }`. 프로세스마다 자기 파일만 원자적으로 바꾸고, 읽을 때 모두 더한다 (잠금 없음).
- 같은 순간에 여럿이 보내면 한도를 조금 넘을 수 있다 (soft limit). 죽은 프로세스의 1분 넘은 파일은 읽을 때 지운다.

## 5. 표시

- 푸터 (`docs/pi-tui-spec.md` §6.1): vLLM 연결이면 모든 프로세스를 더한 값. 한도가 있으면 `3/20 rpm · 12.4K/100K tpm`, 한도에 닿으면 노랑.
- 기다리는 동안 푸터 상태 글과 Flow Monitor 의 Current Task 맨 위: `Pending for 17 sec: RPM Limit` (`TPM Limit` · 429 면 `Server Limit`), 숫자는 남은 초로 줄어든다. 모니터에는 oxy-rate → oxy-monitor live.json 의 `pending` 으로 전해진다. 입력창 윗줄의 `작업 중 n초` 는 그대로 센다.

## 6. 정할 것

- O1 (Tweak 입력 화면): 만들지 않는다. O2 (Flow Monitor 표시): 보인다, 문구 `Pending for n sec: RPM Limit` (사용자 2026-11-14).

## 7. 구현 기록 (2026-11-14, 부모)

- `oxy-rate/limiter.ts` (planWait · usage · retryAt · parseDuration), `store.ts` (RateStore), `index.ts` (before_provider_request 대기 · message_end 실제 토큰 · after_provider_response 429). 푸터는 `oxygen-pi-tui/rate.ts` `sharedStats` (1초 캐시).
- `scripts/llm-connections.mjs`: `request.rpm` · `tpm` 검사.
- 단위: 대기 시간(RPM · TPM · 둘 다 · 너무 큰 요청 · 429), 대기 시각 헤더, 두 프로세스 합산 · 429 공유, 설정 검사.
- 실측 (mock pi, mintty 90×30 D2Coding, vLLM 연결 rpm 3): 요청 6번 시나리오에서 3번 뒤 `3/3 rpm`(노랑) · `요청 대기 중 · rpm 한도 · 48초 → 28초 → 17초` (이후 `Pending for 46 sec: RPM Limit` 으로 바꿈, live.json `pending` 확인), 첫 요청이 윈도우를 벗어난 뒤 이어서 끝남(`tools checked`), 1분 뒤 `0/3 rpm`. 증거: scratchpad `caps/rate-wait.png`.
