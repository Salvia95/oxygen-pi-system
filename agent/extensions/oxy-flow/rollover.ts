// 세션 넘기기 (oxy-flow /oxy-rollover) 의 순수 부분: 기다리는 안내 줄 · 새 세션에 넘기는 모델 (docs/flow-spec.md §1-4)

/** 세션 넘기기 전 기다리는 초 (사용자, 2026-11-13: "… Please wait ... 5 sec 로 표시하고 카운팅 한 후 넘어가면") */
export const ROLLOVER_WAIT_SEC = 5;

export interface RolloverPaint { warn: (s: string) => string; oxygen: (s: string) => string; pi: (s: string) => string }
const plain: RolloverPaint = { warn: (x) => x, oxygen: (x) => x, pi: (x) => x };

/**
 * 넘기기 안내 (입력창 위). Oxygen · Pi 는 브랜드 색, 나머지는 노랑(좋음도 나쁨도 아님).
 * 한 줄이면 80칸에서 `N sec` 만 다음 줄로 밀려(실측) 쉼표 뒤에서 두 줄로 나눈다: 남은 초가 늘 같은 자리에 보인다
 */
export function rolloverLines(sec: number, paint: RolloverPaint = plain): string[] {
  return [
    ` ${paint.warn("Summarize and rollover this session to new ")}${paint.oxygen("Oxygen")} ${paint.pi("Pi")}${paint.warn(" session,")}`,
    ` ${paint.warn(`Please wait ... ${sec} sec`)}`,
  ];
}

/**
 * 넘기기 때 지금 모델 · thinking 을 새 세션에 넘긴다. 새 세션은 settings.json 의 기본 모델로 시작하므로,
 * 넘기기 직전에 여기에 두고 새 세션의 oxy-flow(다시 불러온 확장)가 session_start 에서 꺼내 맞춘다.
 * oxy-jobs 도 이 표시를 보고 실행 중인 작업을 멈추지 않고 새 세션에 넘긴다
 */
export const ROLLOVER_KEY = Symbol.for("oxy.rollover");
export interface RolloverCarry { provider: string; modelId: string; thinking?: string; at: number }
