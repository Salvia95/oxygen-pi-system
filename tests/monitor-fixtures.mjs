// 모니터 화면(oxy-tui 의 모니터 모드)의 예시 보기 모델을 만든다 (docs/monitor-tui-spec.md §6 3단계).
// 모델을 손으로 쓰지 않고 agent/extensions/oxy-monitor/model.ts 의 flowModel · jobsModel 로 만든다 (형식이 어긋나지 않게).
// since(경과 시작 시각)는 now 기준으로 몇 초 전이다. 같은 now 로 만들면 같은 파일이 나온다 (unit-tui 가 이것으로 최신인지 본다).
//   node --experimental-strip-types --no-warnings tests/monitor-fixtures.mjs [출력 폴더] [--now <ms>] [--sizes 23x12,35x28]
//   기본 출력 폴더 tests/fixtures/monitor (cargo test 가 읽는다). 화면으로 볼 때는 다른 폴더에 현재 시각으로 만들어
//   oxy-tui demo monitor --model <폴더>/flow-23x12.json
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { displayWidth } from "../installer/tui.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DIR = join(HERE, "fixtures", "monitor");
/** 오른쪽 열 30%: 80×24 는 23칸(모니터 둘이면 11 · 12줄), 120×30 은 35칸(둘이면 14줄 안팎, 하나면 28줄) */
export const DEFAULT_SIZES = ["23x11", "23x12", "23x24", "35x14", "35x28"];

const sec = (n) => n * 1000;

/** 상태: flow(할 일 4개 · 커밋 3개 · 실패 한 건, 도구 실행 중) 와 jobs(실행 중 2 · 끝난 것 3) */
function scenario(now) {
  const item = (id, text, status, nodes = [], children = [], t = {}) => ({ id, text, status, at: now - sec(60), nodes, children, ...t });
  const took = (start, end) => ({ startedAt: now - sec(start), ...(end === undefined ? {} : { endedAt: now - sec(end) }) });   // 걸린 시간 (flow-view-spec §3)
  const plan = [
    item("p1", "환경 구성", "done", ["n1"], [], took(600, 420)),
    item("p2", "로그인 API", "doing", [], [
      item("p2.1", "라우트", "done", ["n2"], [], took(400, 210)),
      item("p2.2", "테스트 작성", "doing", [], [], took(42)),
      item("p2.3", "오류 처리", "todo"),
    ], took(400)),
    item("p3", "결제 연동", "todo"),
    item("p4", "배포 설정", "blocked"),
  ];
  const node = (id, title, decisions = [], files = []) => ({ id, commit: `abc${id}`, title, decisions, files });
  const flow = {
    goal: "로그인과 결제 기능 만들기",
    plan,
    nodes: [node("n1", "chore: 환경 구성"), node("n2", "feat: 로그인 라우트", [{ text: "세션은 쿠키로", why: "사내 SSO 와 같은 방식" }], ["src/login.ts", "src/routes.ts"]), node("n3", "fix: 린트 오류")],
    buffer: { decisions: [{ text: "테스트는 vitest 로" }], files: ["a.ts", "b.ts", "c.ts"], failures: [{ command: "npm test" }] },
  };
  return { plan, flow };
}

async function liveState(L, now) {
  let s = L.emptyLive(4242, now - sec(120));
  const at = (ago, ev) => { s = L.reduceLive(s, ev, now - sec(ago)); };
  at(90, { type: "user", text: "로그인 테스트를 작성하고 실패하면 고쳐줘" });
  at(88, { type: "agent_start" });
  at(87, { type: "turn_start", turnIndex: 0 });
  at(80, { type: "tool_start", id: "t1", name: "read", input: { path: String.raw`C:\Users\kim\project\src\components\payment\CheckoutSummary.tsx` } });
  at(79, { type: "tool_end", id: "t1", name: "read", ok: true });
  at(70, { type: "tool_start", id: "t2", name: "edit", input: { path: "src/components/payment/CheckoutSummary.test.tsx" } });
  at(69, { type: "tool_end", id: "t2", name: "edit", ok: true });
  at(60, { type: "event", kind: "commit", ok: true, text: "커밋 n2 feat: 로그인 라우트" });
  at(50, { type: "tool_start", id: "t3", name: "bash", input: { command: "npm test" } });
  at(45, { type: "tool_end", id: "t3", name: "bash", ok: false });
  at(44, { type: "event", kind: "plan", ok: true, text: "p2.2 진행 테스트 작성" });
  at(30, { type: "turn_start", turnIndex: 1 });
  at(12, { type: "tool_start", id: "t4", name: "bash", input: { command: "npm test -- --run login" } });
  at(1, { type: "context", percent: 41 });
  return s;
}

function jobsState(now) {
  const job = (id, kind, state, label, extra = {}) => ({ id, kind, state, label, createdAt: now - sec(300), startedAt: null, endedAt: null, exitCode: null, usage: null, log: `${id}/log.txt`, last: "", result: null, ...extra });
  return {
    version: 1, pid: 4242, cwd: ".", updatedAt: now, closed: false, slots: { running: 2, limit: 3, waiting: 0 }, control: null,
    jobs: [
      job("job-1", "bash", "running", "npm run build", { startedAt: now - sec(41) }),
      job("job-2", "agent", "running", "scout: 로그 찾기", { startedAt: now - sec(12) }),
      job("job-3", "bash", "done", "npm test", { startedAt: now - sec(200), endedAt: now - sec(137), exitCode: 0 }),
      job("job-4", "bash", "failed", "npm run lint", { startedAt: now - sec(260), endedAt: now - sec(250), exitCode: 1 }),
      job("job-5", "agent", "stopped", "reviewer: 검토", { startedAt: now - sec(290), endedAt: now - sec(280) }),
    ],
  };
}

/** subagent(job-2 scout)가 띄운 셸: 진행 중 1 · 끝난 것 1 (docs/jobs-view-spec.md §3) */
function subStates(now) {
  const job = (id, state, label, extra = {}) => ({ id, kind: "bash", state, label, createdAt: now - sec(30), startedAt: now - sec(20), endedAt: null, exitCode: null, usage: null, log: `logs/${id}.log`, last: "", result: null, ...extra });
  return new Map([["job-2", { version: 1, pid: 4343, cwd: ".", updatedAt: now, closed: false, slots: {}, control: null,
    jobs: [job("job-1", "running", "npm test -- login"), job("job-2", "done", "npm run build", { endedAt: now - sec(5), exitCode: 0 })] }]]);
}

/** 예시 보기 모델을 outDir 에 쓰고 index.json 에 크기 · model.ts 가 계산한 줄 수를 적는다 */
export async function writeFixtures({ outDir = DEFAULT_DIR, now = Date.now(), sizes = DEFAULT_SIZES } = {}) {
  const M = await import("../agent/extensions/oxy-monitor/model.ts");
  const L = await import("../agent/extensions/oxy-monitor/live.ts");
  const { flow } = scenario(now);
  const live = await liveState(L, now);
  const jobs = jobsState(now);
  const subs = subStates(now);
  mkdirSync(outDir, { recursive: true });
  const files = [];
  for (const size of sizes) {
    const [width, height] = size.split("x").map(Number);
    const models = {
      flow: M.flowModel(flow, live, { sel: "p:p2.2", open: new Set(), manualAt: 0 }, width, height, now, displayWidth),
      jobs: M.jobsModel(jobs, subs, live, { ...M.jobsUiInit(), sel: "s:job-2" }, width, height, now, displayWidth),
      "jobs-sub": M.jobsModel(jobs, subs, live, { ...M.jobsUiInit(), mode: "sub", sub: "job-2", sel: "c:job-1" }, width, height, now, displayWidth),
      "jobs-popup": M.jobsModel(jobs, subs, live, { ...M.jobsUiInit(), sel: "s:job-2", confirm: { scope: "main", id: "job-2", label: "scout: 로그 찾기", agent: true, focus: "no" } }, width, height, now, displayWidth),
    };
    for (const [kind, model] of Object.entries(models)) {
      const file = `${kind}-${size}.json`;
      writeFileSync(join(outDir, file), `${JSON.stringify(model, null, 2)}\n`);
      files.push({ file, kind, width, height, modelHeight: M.modelHeight(model) });
    }
  }
  writeFileSync(join(outDir, "index.json"), `${JSON.stringify({ generatedAt: now, files }, null, 2)}\n`);
  return files;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const outDir = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--")) ?? DEFAULT_DIR;
  const files = await writeFixtures({ outDir: resolve(outDir), now: opt("--now") ? Number(opt("--now")) : Date.now(), sizes: opt("--sizes")?.split(",") ?? DEFAULT_SIZES });
  console.log(`${files.length}개 예시 모델을 ${resolve(outDir)} 에 썼습니다.`);
}
