// 설치 TUI · Tweak 공용 입력(UI)을 점검한다. 화면은 oxy-tui.exe 가 그리므로(installer/oxy-tui, cargo test) 여기서는
//   원격 모드: UI 가 exe 에 보내는 지시와, 받은 결과를 값으로 바꾸는 것 (가짜 연결로 exe 없이)
//   줄 입력 모드: 번호 입력 문법 · 비밀값 · 입력이 끝났을 때
//   node --test tests/unit-tui.test.mjs
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { existsSync, readFileSync, readdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { BACK, InputEnded, UI, displayWidth, explainError, truncate, truncatePath } from "../installer/tui.mjs";

// ---------------------------------------------------------------- 원격 모드 (가짜 연결)
/** exe 대신 지시를 모으고, reply(지시) 가 돌려준 답을 다음 틱에 넣어 준다 */
function remoteUI(reply = () => null) {
  const sent = [];
  const link = { send(m) { sent.push(m); const r = reply(m, sent); if (r) setImmediate(() => link.onMessage({ id: m.id, ...r })); } };
  const ui = new UI({ input: new EventEmitter(), output: { isTTY: true, columns: 80, rows: 24, write() { return true; } }, tty: true, remote: link });
  ui.version = "0.1.0";
  return { ui, sent, link, ops: () => sent.map((m) => m.op), last: (op) => sent.filter((m) => m.op === op).at(-1) };
}

test("원격 select: 행을 exe 가 받는 모양으로 보내고, index 를 값으로 돌려준다", async () => {
  const t = remoteUI((m) => (m.op === "select" ? { index: 1 } : null));
  t.ui.setFrame({ path: ["설정", "LLM 연결"], right: "C:\\oxygen-pi" });
  const v = await t.ui.select("어떤 설정을 변경할까요?", [
    { label: "LLM 연결", value: "llm", hint: "api.example · m", detail: "서버 주소, API 키, 모델을 변경합니다.", info: [["서버", "http://x/v1"]] },
    { label: "브라우저", value: "browser", gap: true, hint: "Chromium", disabled: "사용 불가", why: "agent-browser가 설치되지 않았습니다.", fix: "번들을 다시 만드세요." },
    { label: "종료", value: "exit", lineOnly: true },
  ], { esc: "종료", message: "\x1b[32m✔\x1b[39m GitLab 연결을 저장했습니다." });
  assert.equal(v, "browser");
  assert.deepEqual(t.ops(), ["frame", "select"]);
  assert.deepEqual(t.last("frame"), { op: "frame", version: "0.1.0", title: "", steps: [], short: [], current: 0, stage: "", finished: false, path: ["설정", "LLM 연결"], right: "C:\\oxygen-pi" });
  const s = t.last("select");
  assert.equal(s.rows.length, 2, "lineOnly 행(종료)은 화면에 보내지 않는다");
  assert.deepEqual(s.rows[0], { label: "LLM 연결", value: "api.example · m", status: "", desc: ["서버 주소, API 키, 모델을 변경합니다."], info: [["서버", "http://x/v1"]],
    gap: false, disabled: false, recommended: false, current: false, danger: false, locked: false, checked: false });
  assert.deepEqual([s.rows[1].gap, s.rows[1].disabled, s.rows[1].status, s.rows[1].desc], [true, true, "사용 불가", ["agent-browser가 설치되지 않았습니다.", "번들을 다시 만드세요."]]);
  assert.deepEqual([s.esc, s.enter, s.multi, s.result, s.result_kind], ["종료", "선택", false, "GitLab 연결을 저장했습니다.", "ok"]);
  // 결과 줄의 종류는 맨 앞 기호로 정한다 (! 주의 · × 실패). 기호는 exe 가 다시 그린다
  await t.ui.select("q", [{ label: "a", value: 1 }, { label: "b", value: 2 }], { message: "\x1b[33m!\x1b[39m 상태 점검에서 문제가 발견되었습니다." });
  assert.deepEqual([t.last("select").result, t.last("select").result_kind], ["상태 점검에서 문제가 발견되었습니다.", "warn"]);
  // 설치 단계: 긴 이름(steps)과 짧은 이름(short)을 함께 보낸다
  t.ui.setFrame({ steps: ["점검", "폴더"], longSteps: ["환경 점검", "설치 폴더"], current: 1, title: "설치" });
  await t.ui.select("q", [{ label: "a", value: 1 }, { label: "b", value: 2 }]);
  assert.deepEqual([t.last("frame").steps, t.last("frame").short], [["환경 점검", "설치 폴더"], ["점검", "폴더"]]);
  // 단계를 모두 지난 뒤: 상태 낱말(stage)과 마쳤는지(finished)를 보낸다
  t.ui.setFrame({ steps: ["점검", "폴더"], current: 2, title: "설치", stage: "설치 완료", finished: true });
  await t.ui.select("q", [{ label: "a", value: 1 }, { label: "b", value: 2 }]);
  assert.deepEqual([t.last("frame").current, t.last("frame").stage, t.last("frame").finished], [2, "설치 완료", true]);
});

test("원격 select: 예전 형식 detail([[이름, 값]])은 값만 문장으로, {header} 는 묶음 경계로, Esc 는 BACK", async () => {
  const t = remoteUI((m) => (m.op === "select" ? { back: true } : null));
  const v = await t.ui.select("무엇을 바꿀까요?", [
    { header: "연결" },
    { label: "a", value: 1, detail: [["바뀌는 것", "주소를 다시 입력합니다"], ["끄면", "확인이 없어집니다"]] },
    { header: "이 PC" },
    { label: "b", value: 2, recommended: true },
  ], { note: ["\x1b[90m맥락 한 줄\x1b[39m", "  ✔ Git Bash  C:\\Git"], result: true });
  assert.equal(v, BACK);
  const s = t.last("select");
  assert.deepEqual(s.rows.map((r) => [r.label, r.gap, r.desc]), [["a", false, ["주소를 다시 입력합니다", "끄면 확인이 없어집니다"]], ["b", true, []]]);
  assert.deepEqual([s.context, s.keep, s.focus], [["맥락 한 줄", "  ✓ Git Bash  C:\\Git"], true, 1], "색 코드를 떼고 옛 기호를 바꾼다 · 처음 포커스는 추천 항목");
});

test("원격 multiselect: indices 를 값으로 (잠긴 행은 항상 포함, 선택할 수 없는 행은 제외)", async () => {
  const t = remoteUI((m) => (m.op === "select" ? { indices: [0, 2, 3] } : null));
  const v = await t.ui.multiselect("어떤 구성요소를 설치할까요?", [
    { label: "기본", value: "core", locked: true }, { label: "just", value: "just", checked: true }, { label: "hurl", value: "hurl" },
    { label: "graphin", value: "graphin", disabled: "반입 안 됨" },
  ], { enter: "다음" });
  assert.deepEqual(v, ["core", "hurl"]);
  const s = t.last("select");
  assert.deepEqual([s.multi, s.enter, s.rows.map((r) => r.checked), s.rows[3].status], [true, "다음", [true, true, false, false], "반입 안 됨"]);
});

test("원격 input: 검증에 걸리면 invalid 를 같은 id 로 보내고 다시 받는다 · 비밀값은 mask", async () => {
  const answers = [{ value: "oxygen-pi" }, { value: "C:\\oxygen-pi" }];
  const t = remoteUI((m) => (m.op === "input" || m.op === "invalid" ? answers.shift() : null));
  const v = await t.ui.input("설치 폴더", { initial: "C:\\x", note: "예: C:\\oxygen-pi", enter: "다음", validate: (s) => (/^[A-Z]:\\/.test(s) ? null : "전체 경로를 입력하세요") });
  assert.equal(v, "C:\\oxygen-pi");
  assert.deepEqual(t.ops(), ["frame", "input", "invalid"]);
  const [i, bad] = [t.last("input"), t.last("invalid")];
  assert.deepEqual([i.header, i.context, i.value, i.mask, i.esc, i.enter], ["설치 폴더", ["예: C:\\oxygen-pi"], "C:\\x", false, "이전", "다음"]);
  assert.deepEqual([bad.id, bad.message], [i.id, "전체 경로를 입력하세요"]);
  const k = remoteUI((m) => (m.op === "input" ? { back: true } : null));
  assert.equal(await k.ui.input("API 키", { mask: true }), BACK);
  assert.equal(k.last("input").mask, true);
  // error: 처음부터 보일 오류 (앞 화면에서 이 값으로 해 본 일이 실패했을 때). 없으면 빈 문자열
  assert.equal(i.error, "");
  const e = remoteUI((m) => (m.op === "input" ? { value: "wrkspc_a" } : null));
  await e.ui.input("워크스페이스 ID", { initial: "wrkspc_x", error: "이 키로 사용할 수 없는 워크스페이스입니다." });
  assert.equal(e.last("input").error, "이 키로 사용할 수 없는 워크스페이스입니다.");
});

test("원격 confirm: 위험한 확인은 팝업(confirm), 가벼운 확인은 목록(select)", async () => {
  const t = remoteUI((m) => (m.op === "confirm" ? { yes: false } : m.op === "select" ? { index: 0 } : null));
  await assert.rejects(t.ui.confirm("정말 할까요?"), /yes\/no/);
  const no = await t.ui.confirm("oxygen-pi-system을 이 PC에서 제거할까요?", { title: "제거", level: "heavy", yes: "설치 폴더 삭제", no: "제거 취소",
    summary: [["삭제", "C:\\oxygen-pi"]], warning: "삭제하면 복구할 수 없습니다." });
  assert.equal(no, false);
  const c = t.last("confirm");
  assert.deepEqual([c.title, c.yes, c.no, c.danger, c.on_yes, c.summary, c.warning], ["제거", "설치 폴더 삭제", "제거 취소", true, false, [["삭제", "C:\\oxygen-pi"]], "삭제하면 복구할 수 없습니다."]);
  const yes = await t.ui.confirm("상태 점검(verify)을 실행할까요?", { yes: "상태 점검 실행", no: "건너뛰기", recommended: true });
  assert.equal(yes, true);
  const s = t.last("select");
  assert.deepEqual([s.rows.map((r) => r.label), s.focus, s.rows[0].recommended, s.rows[0].danger], [["상태 점검 실행", "건너뛰기"], 0, true, false]);
});

test("원격 task: 시작하자마자 진행 화면을 보내고, 끝나면 done · 실패하면 fail 과 원인 · 해결 방법", async () => {
  const t = remoteUI((m) => (m.op === "pause" ? {} : null));
  t.ui.setFrame({ steps: ["점검", "폴더"], longSteps: ["환경 점검", "설치 폴더"], current: 2, title: "설치" });
  t.ui.screen("  \x1b[1m설치하는 중입니다\x1b[22m\n  C:\\oxygen-pi\n");
  let seen = null;
  await t.ui.task("파일 복사", async (update) => { seen = structuredClone(t.last("task")); update("4,210/12,480 (34%)", 34); return "12,480개"; });
  assert.deepEqual([seen.title, seen.lines, seen.items, seen.percent], ["설치하는 중입니다", ["C:\\oxygen-pi"], [{ label: "파일 복사", state: "run", extra: "" }], -1], "fn 을 부르기 전에 이미 보냈다");
  assert.deepEqual(t.last("task").items, [{ label: "파일 복사", state: "done", extra: "12,480개" }]);
  assert.deepEqual(t.last("frame").steps, ["환경 점검", "설치 폴더"]);
  const err = Object.assign(new Error("x"), { why: "서버가 연결을 거부했습니다", fix: "포트를 확인하세요" });
  await assert.rejects(t.ui.task("모델 목록", async () => { throw err; }), (e) => e.reported === true);
  const items = t.last("task").items;
  assert.deepEqual(items[1], { label: "모델 목록", state: "fail", extra: "" });
  assert.deepEqual(items.slice(2).map((x) => [x.state, x.label.replace(/\s+/g, " ")]), [["text", " 원인 서버가 연결을 거부했습니다"], ["text", " 해결 방법 포트를 확인하세요"]]);
  await t.ui.pause("종료");
  assert.equal(t.last("pause").label, "종료");
});

test("원격 outside: suspend → fn → resume(Enter 를 기다릴 뜻) 순서 · end 는 quit 에 남길 줄을 실어 보낸다", async () => {
  const t = remoteUI((m) => (m.op === "suspend" || m.op === "resume" ? {} : null));
  const order = [];
  const r = await t.ui.outside(() => { order.push(...t.ops()); return "passed"; }, { title: "상태 점검 (verify)" });
  assert.equal(r, "passed");
  assert.deepEqual(order, ["frame", "suspend"], "fn 은 suspend 의 답을 받은 뒤에 돈다");
  assert.equal(t.last("resume").wait, "계속");
  t.ui.screen("  ✔ 설치를 마쳤습니다  C:\\oxygen-pi\n\n  시작하기\n    실행  oxy");
  await t.ui.end(0);
  const q = t.last("quit");
  assert.deepEqual([q.code, q.summary], [0, ["  ✓ 설치를 마쳤습니다  C:\\oxygen-pi", "  ", "  시작하기", "    실행  oxy"]], "마지막 진행 화면을 본 화면에 남긴다");
});

test("모드: TTY + exe 있음 → 원격 · exe 없음 → 줄 입력(한 줄로 알림) · OXY_TUI=line → 줄 입력 · TTY 아님 → 줄 입력", () => {
  const tty = () => ({ input: Object.assign(new EventEmitter(), { isTTY: true }), output: { isTTY: true, write() { return true; } } });
  const dir = mkdtempSync(join(tmpdir(), "oxy-tui-"));
  const before = process.env.OXY_TUI;
  try {
    const exe = join(dir, "oxy-tui.exe");
    const missing = new UI({ ...tty(), exe });
    assert.equal(missing.mode, "line");
    assert.match(missing.fallbackNote, /oxy-tui\.exe.*줄 입력 모드/);
    writeFileSync(exe, "");
    assert.equal(new UI({ ...tty(), exe }).mode, "remote");
    process.env.OXY_TUI = "line";
    const forced = new UI({ ...tty(), exe });
    assert.deepEqual([forced.mode, forced.fallbackNote], ["line", ""]);
    delete process.env.OXY_TUI;
    assert.equal(new UI({ input: new PassThrough(), output: new PassThrough(), exe }).mode, "line");
  } finally {
    if (before === undefined) delete process.env.OXY_TUI; else process.env.OXY_TUI = before;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 줄 입력 모드
/** 줄 입력 모드 UI: 답을 넣고 출력을 모은다 */
function lineUI(answers) {
  const input = new PassThrough(), output = new PassThrough();
  let out = "";
  output.on("data", (d) => (out += d));
  const ui = new UI({ input, output, tty: false });
  input.write(answers.map((a) => a + "\n").join(""));
  input.end();
  return { ui, out: () => out };
}
const MS = [{ label: "필수", value: "a", locked: true }, { label: "B", value: "b", checked: true }, { label: "C", value: "c" },
  { label: "D", value: "d", disabled: "반입 안 됨" }, { label: "E", value: "e", checked: true }];

test("줄 입력: 비밀값(mask)은 출력·로그에 되찍지 않는다", async () => {
  const t = lineUI(["gsk-secret-value", "plain-host"]);
  assert.equal(await t.ui.input("API 키", { mask: true }), "gsk-secret-value");
  assert.equal(await t.ui.input("호스트"), "plain-host");
  assert.ok(!t.out().includes("gsk-secret-value"), "비밀값이 출력에 남음");
  assert.ok(t.out().includes("(입력됨)") && t.out().includes("plain-host"));
});

test("줄 입력 multiselect: 빈칸 · 정확히 · +N -N · 섞으면 오류 · - · <", async () => {
  const cases = [["", ["a", "b", "e"]], ["2,3", ["a", "b", "c"]], ["+3 -5", ["a", "b", "c"]], ["-", ["a"]]];
  for (const [ans, want] of cases) assert.deepEqual(await lineUI([ans]).ui.multiselect("무엇을?", MS), want, ans);
  const mixed = lineUI(["2 +3", "4", "-1", "+3"]);
  assert.deepEqual(await mixed.ui.multiselect("무엇을?", MS), ["a", "b", "c", "e"]);
  const o = mixed.out();
  assert.match(o, /형식 중 하나로 입력하세요/);
  assert.match(o, /선택할 수 없습니다: 4번 D \(반입 안 됨\)/);
  assert.match(o, /필수 항목은 해제할 수 없습니다: 1번 필수/);
  assert.match(o, /1\) \[■\] 필수 {2}필수\n {2}2\) \[✓\] B\n {2}3\) \[ \] C\n {2}4\) \[·\] D {5}반입 안 됨/);
  assert.equal(await lineUI(["<"]).ui.multiselect("무엇을?", MS), BACK);
});

test("줄 입력 select: lineOnly 행(종료)이 번호를 갖고, 질문 앞뒤와 목록 뒤에 빈 줄이 있다", async () => {
  const t = lineUI(["3"]);
  t.ui.setFrame({ path: "설정" });
  const rows = [{ label: "LLM 연결", value: "llm", hint: "api.example" }, { label: "브라우저", value: "b", gap: true, disabled: "사용 불가", why: "agent-browser가 없습니다" },
    { label: "종료", value: "exit", lineOnly: true }];
  assert.equal(await t.ui.select("어떤 설정을 변경할까요?", rows, { esc: "종료" }), "exit");
  assert.ok(t.out().includes("\n── 설정\n\n어떤 설정을 변경할까요?\n\n  1) LLM 연결  api.example\n  2) 브라우저  사용 불가\n  3) 종료\n\n번호 (Enter=1, <=종료, ?=설명): 3\n"), t.out());
  const blocked = lineUI(["2", ""]);
  assert.equal(await blocked.ui.select("무엇을?", rows), "llm");
  assert.match(blocked.out(), /선택할 수 없습니다: 2번 브라우저 \(agent-browser가 없습니다\)/);
});

test("줄 입력 confirm: 1 = 진행 · 2 = 안 함, 위험한 확인은 처음 값이 2 이고 요약과 경고를 보인다", async () => {
  const t = lineUI([""]);
  assert.equal(await t.ui.confirm("tdb 연결을 삭제할까요?", { yes: "tdb 연결 삭제", no: "삭제 취소", level: "medium", summary: [["삭제", "tdb"]], warning: "삭제하면 복구할 수 없습니다." }), false);
  assert.match(t.out(), /삭제 {2}tdb\n\n {2}1\) ! tdb 연결 삭제\n {7}! 삭제하면 복구할 수 없습니다\.\n {2}2\) 삭제 취소\n\n번호 \(Enter=2, \?=설명\)/);
  assert.equal(await lineUI([""]).ui.confirm("상태 점검(verify)을 실행할까요?", { yes: "상태 점검 실행", no: "건너뛰기" }), true);
});

test("줄 입력: 입력이 끝나면 기다리던 질문을 알린다 (스택 없음)", async () => {
  const { ui } = lineUI([]);
  await assert.rejects(ui.select("어디에 설치할까요?", [{ label: "a", value: 1 }]), (e) => e instanceof InputEnded && e.question === "어디에 설치할까요?");
});

test("줄 입력 task: 시작 · 25% 마다 · 끝을 한 줄씩 (회귀 테스트가 grep 하는 `레이블  결과` 형식)", async () => {
  const t = lineUI([]);
  await t.ui.task("tdb 접속", async (update) => { update("1/4 (25%)", 25); update("2/4 (50%)", 50); return "성공"; });
  assert.equal(t.out(), "  … tdb 접속\n  … tdb 접속  1/4 (25%)\n  … tdb 접속  2/4 (50%)\n  ✓ tdb 접속  성공\n");
});

// ---------------------------------------------------------------- 공용 도우미 · 문구
/** 주석(// … · /* … *\/)을 제외한 코드 줄. 문자열 안의 // 는 주석이 아니다 */
function codeLines(src) {
  const out = [];
  let inBlock = false;
  for (const line of src.split(/\r?\n/)) {
    let code = "";
    let q = null;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inBlock) { if (ch === "*" && line[i + 1] === "/") { i++; inBlock = false; } continue; }
      if (q) { code += ch; if (ch === "\\") code += line[++i] ?? ""; else if (ch === q) q = null; continue; }
      if (ch === '"' || ch === "'" || ch === "`") { q = ch; code += ch; continue; }
      if (ch === "/" && line[i + 1] === "/") break;
      if (ch === "/" && line[i + 1] === "*") { inBlock = true; i++; continue; }
      code += ch;
    }
    out.push(code);
  }
  return out;
}

test("금지 문구가 installer/*.mjs 의 화면 문구에 남아 있지 않다 (주석 제외)", () => {
  const dir = join(import.meta.dirname, "..", "installer");
  // 속성 이름을 단 설명 · 입말 · 조사 병기 · 기호로 이은 경로 (docs/tui-spec.md 문구 규칙)
  const banned = /\(권장\)|← 뒤로|Enter 확정|Enter 를 누르면|label: "예"|label: "아니요"|바뀌는 것|되돌리기|빠른 길|고르|고른|골라|밟|묻습니다|은\(는\)|을\(를\)|이\(가\)|시험| › | — /;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".mjs"))) {
    codeLines(readFileSync(join(dir, f), "utf8")).forEach((l, i) => {
      const m = l.match(banned);
      assert.ok(!m, `${f}:${i + 1}: ${m?.[0]} (${l.trim().slice(0, 80)})`);
    });
  }
});

test("Enter 의 뜻: 기본은 선택/확인, enterLabel 을 두면 그 값, 화면에서 지정하면 지정한 값", async () => {
  const t = remoteUI((m) => (m.op === "select" ? (m.multi ? { indices: [] } : { index: 0 }) : m.op === "input" ? { value: "x" } : null));
  const rows = [{ label: "a", value: 1 }];
  await t.ui.select("q", rows);
  await t.ui.multiselect("q", rows);
  await t.ui.input("이름");
  assert.deepEqual(t.sent.filter((m) => m.enter).map((m) => m.enter), ["선택", "확인", "확인"]);
  t.ui.enterLabel = "다음";
  await t.ui.select("q", rows);
  await t.ui.input("이름");
  await t.ui.select("q", rows, { enter: "선택" });
  await t.ui.input("이름", { enter: "저장" });
  await t.ui.confirm("계속할까요?", { yes: "계속", no: "취소" });
  assert.deepEqual(t.sent.filter((m) => m.enter).slice(3).map((m) => m.enter), ["다음", "다음", "선택", "저장", "선택"]);
});

test("busy: 지금 화면을 둔 채 알린다 (원격은 busy 지시, 줄 입력은 한 줄)", async () => {
  const t = remoteUI();
  await t.ui.busy("삭제할 파일을 세는 중입니다");
  assert.deepEqual(t.sent, [{ op: "busy", label: "삭제할 파일을 세는 중입니다" }]);
  const l = lineUI([]);
  await l.ui.busy("삭제할 파일을 세는 중입니다");
  assert.equal(l.out(), "  … 삭제할 파일을 세는 중입니다\n");
});

test("오류 설명: 원인과 해결 방법을 사람 말로", () => {
  assert.deepEqual(explainError(Object.assign(new Error("x"), { cause: { code: "ECONNREFUSED" } })), { cause: "서버가 연결을 거부했습니다 (ECONNREFUSED)", fix: "포트가 맞는지, vLLM이 실행 중인지 확인하세요" });
  assert.match(explainError(new Error("HTTP 401 Unauthorized")).cause, /API 키가 올바르지 않습니다/);
  assert.deepEqual(explainError(Object.assign(new Error("x"), { why: "모델이 없습니다", fix: "확인하세요" })), { cause: "모델이 없습니다", fix: "확인하세요" });
});

test("말줄임: 설명 끝 · 경로 가운데 · 2칸 글자 중간은 자르지 않음", () => {
  assert.equal(truncatePath(String.raw`C:\Users\kim\AppData\Local\Programs\oxygen-pi`, 34), String.raw`C:\Users\kim\…\Programs\oxygen-pi`);
  const t = truncate("터미널 멀티플렉서 (tmux 호환) · 대화형 프로그램 조작", 20);
  assert.ok(displayWidth(t) <= 20 && t.endsWith("…"), t);
  assert.ok(displayWidth(truncate("가나다라마바사", 6)) <= 6);
});

test("복사 전에 쓴 설치 표시(partial)가 있으면 같은 폴더를 우리 설치로 보고 이어서 설치한다", async () => {
  const { createSystem } = await import("../installer/system.mjs");
  const dir = mkdtempSync(join(tmpdir(), "oxy-partial-"));
  try {
    writeFileSync(join(dir, "half-copied.txt"), "x");
    const sys = createSystem({ root: join(import.meta.dirname, ".."), sandbox: dir });
    assert.equal(sys.inspectTarget(dir), "foreign");
    sys.writeMarker(dir, { partial: true });
    assert.equal(sys.inspectTarget(dir), "ours");
    assert.equal(sys.readMarker(dir).partial, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("멀티플렉서 정의: 표의 모든 id 에 어댑터(scripts/mux/<id>.sh)와 구성요소가 있고, 문구는 한 줄(74칸) 안", async () => {
  const { CATALOG, MULTIPLEXERS } = await import("../installer/components.mjs");
  const root = join(import.meta.dirname, "..");
  assert.ok(MULTIPLEXERS.length >= 1);
  for (const m of MULTIPLEXERS) {
    assert.match(m.id, /^[a-z0-9-]+$/, m.id);
    assert.notEqual(m.id, "none");
    assert.ok(CATALOG[m.component], `${m.id}: CATALOG 에 ${m.component} 없음`);
    const adapter = readFileSync(join(root, "scripts", "mux", `${m.id}.sh`), "utf8");
    for (const fn of ["oxy_mux_ready", "oxy_mux_inside", "oxy_mux_exec"]) assert.ok(adapter.includes(`${fn}()`), `${m.id}: ${fn} 없음`);
    for (const s of [m.hint, ...m.detail]) assert.ok(displayWidth(s) <= 74, `${m.id}: ${s}`);
  }
});

test("터미널 셸: 프로필과 바로가기가 선택한 셸을 하네스 환경으로 연다 (cmd · PowerShell 은 설치 폴더만 PATH 앞에)", async () => {
  const { createSystem, normShell } = await import("../installer/system.mjs");
  const dir = mkdtempSync(join(tmpdir(), "oxy-shell-"));
  try {
    const sys = createSystem({ root: join(import.meta.dirname, ".."), sandbox: dir });
    const inst = String.raw`C:\Users\kim\Programs\oxygen-pi`;
    const bash = String.raw`C:\Program Files\Git\bin\bash.exe`;
    assert.equal(normShell("zsh"), "git-bash");
    assert.equal(normShell(undefined), "git-bash");
    const g = sys.launchSpec("git-bash", inst, bash);
    assert.equal(g.exe, bash);
    assert.match(g.args, /source '\/c\/Users\/kim\/Programs\/oxygen-pi\/env\.sh' && cd ~ && exec bash -i/);
    const c = sys.launchSpec("cmd", inst, bash);
    assert.match(c.exe, /cmd\.exe$/i);
    assert.equal(c.args, String.raw`/k "set "OXY_HOME=C:\Users\kim\Programs\oxygen-pi" & set "PATH=C:\Users\kim\Programs\oxygen-pi;%PATH%""`);
    const p = sys.launchSpec("powershell", inst, bash);
    assert.match(p.exe, /(pwsh|powershell)\.exe$/i);
    assert.equal(p.args, String.raw`-NoLogo -NoExit -Command "$env:OXY_HOME='C:\Users\kim\Programs\oxygen-pi'; $env:Path='C:\Users\kim\Programs\oxygen-pi;'+$env:Path"`);
    // Windows Terminal 프로필: cmd 는 아이콘 없음 · commandline 은 실행 파일 + 인수
    const prof = JSON.parse(readFileSync(sys.addTerminalProfile(inst, bash, "cmd"), "utf8")).profiles[0];
    assert.equal(prof.commandline, `"${c.exe}" ${c.args}`);
    assert.equal(prof.icon, undefined);
    // Tokyo Night 색 구성을 같은 조각 파일에 두고 프로필이 그것을 쓴다 (flow-view-spec §4 T3)
    const frag = JSON.parse(readFileSync(sys.addTerminalProfile(inst, bash, "cmd"), "utf8"));
    assert.equal(prof.colorScheme, "Tokyo Night (Oxygen Pi)");
    assert.deepEqual([frag.schemes.length, frag.schemes[0].name, frag.schemes[0].background], [1, "Tokyo Night (Oxygen Pi)", "#1A1B26"]);
    // 바로가기 (Windows Terminal 프로필 없이): 셸을 직접 연다
    const lnk = JSON.parse(readFileSync(sys.addShortcut(inst, bash, false, "powershell"), "utf8"));
    assert.deepEqual(lnk, { target: p.exe, args: p.args });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- LLM 연결 화면의 공용 로직 (installer/llm-edit.mjs, docs/tui-spec.md §11)
test("LLM 연결 편집: 주소 정리 · thinking 맞추기 · 연결 합치기(이름 바꾸기, 없는 모델을 가리키던 수준) · 사용량 제한 프리셋", async () => {
  const E = await import("../installer/llm-edit.mjs");
  const root = join(import.meta.dirname, "..");
  assert.equal(E.normalizeBaseUrl("vllm", "http://h:8000/"), "http://h:8000/v1");
  assert.equal(E.normalizeBaseUrl("openai", "https://api.groq.com/openai/v1/"), "https://api.groq.com/openai/v1");
  assert.equal(E.normalizeBaseUrl("anthropic", "https://api.anthropic.com/"), "https://api.anthropic.com");   // Anthropic 형식은 /v1 을 붙이지 않는다
  assert.equal(E.closestThinking(["off", "high"], "medium"), "off");
  assert.equal(E.closestThinking(["low", "medium", "high"], "off"), "low");
  assert.equal(E.closestThinking(["off", "low", "high"], "xhigh"), "high");
  const draft = { id: "site", kind: "vllm", baseUrl: "http://h/v1", maxConcurrent: 2, request: { retries: 0, dropParams: ["top_k"], bogus: 1 },
    models: [{ id: "qwen3.6-coder-30b", family: "qwen-coder", contextWindow: 131072, maxOutput: 16384 }, { id: "qwen3.8-27b", family: "qwen-thinking", contextWindow: 131072, maxOutput: 16384 }] };
  // 새 설치: 기본 모델 + 기본 세 수준 모두 기본 모델 (thinking 은 지원하는 수준으로)
  const a = E.mergeConnection(root, null, draft, { main: { model: "qwen3.8-27b", thinking: "medium" } });
  assert.deepEqual(a.main, { connection: "site", model: "qwen3.8-27b", thinking: "off" });
  assert.deepEqual(a.levels.map((l) => `${l.id}=${l.connection}/${l.model}/${l.thinking}`), ["light=site/qwen3.8-27b/off", "normal=site/qwen3.8-27b/off", "deep=site/qwen3.8-27b/off"]);
  assert.deepEqual(a.connections[0].request, { retries: 0, dropParams: ["top_k"] }, "종류에 있는 요청 설정 항목만 남긴다");
  assert.equal(a.connections[0].name, "사내 vLLM");
  // 다시 설정: 이름을 바꾸고 모델 하나를 빼면 기본 모델 · 수준이 새 이름을 따라가고, 빠진 모델을 가리키던 수준은 기본 모델로
  const b0 = structuredClone(a);
  b0.main = { connection: "site", model: "qwen3.6-coder-30b", thinking: "off" };
  b0.levels[2] = { ...b0.levels[2], model: "qwen3.8-27b", thinking: "high" };
  b0.connections.push({ id: "claude", kind: "anthropic", models: [{ id: "claude-haiku-5-5", contextWindow: 131072, maxOutput: 16384 }] });
  b0.levels.push({ id: "review", label: "r", use: "u", connection: "claude", model: "claude-haiku-5-5", thinking: "high" });
  const b = E.mergeConnection(root, b0, { ...draft, id: "vllm2", models: [draft.models[0]] }, { origId: "site", main: { model: "qwen3.6-coder-30b", thinking: "off" } });
  assert.deepEqual(b.connections.map((c) => c.id), ["vllm2", "claude"]);
  assert.deepEqual(b.levels.map((l) => `${l.id}=${l.connection}/${l.model}/${l.thinking}`),
    ["light=vllm2/qwen3.6-coder-30b/off", "normal=vllm2/qwen3.6-coder-30b/off", "deep=vllm2/qwen3.6-coder-30b/off", "review=claude/claude-haiku-5-5/high"]);
  // Tweak 의 새 연결 추가(main 없음): 기존 기본 모델 · 수준은 그대로
  const c = E.mergeConnection(root, b, { id: "openai", kind: "openai", baseUrl: "http://g/v1", request: { retries: 4, dropParams: ["x"] }, models: [{ id: "m", family: "generic", contextWindow: 9000, maxOutput: 1000 }] });
  assert.deepEqual([c.main.connection, c.levels.length, c.connections[2].request], ["vllm2", 4, { retries: 4 }]);
  // 연결을 지우고 맞추면 그 연결을 가리키던 수준은 기본 모델로
  const d = E.fixPointers(root, { ...c, connections: c.connections.filter((x) => x.id !== "claude") });
  assert.equal(d.levels.at(-1).connection, "vllm2");
  assert.deepEqual(E.endpointPreset(8000), { retries: 4, maxOut: 1000, concurrency: 1 });
});

test("LLM 연결 편집: Anthropic 워크스페이스 (저장 · 화면으로 이어지는 실패 · 목록 순서)", async () => {
  const E = await import("../installer/llm-edit.mjs");
  const m = [{ id: "claude-haiku-5-5", contextWindow: 131072, maxOutput: 16384 }];
  // 워크스페이스를 쓰는 종류만, 값이 있을 때만 저장한다 (없으면 필드 자체가 없다)
  assert.equal(E.cleanConnection({ id: "claude", kind: "anthropic", models: m, workspaceId: "wrkspc_a1" }).workspaceId, "wrkspc_a1");
  assert.equal("workspaceId" in E.cleanConnection({ id: "claude", kind: "anthropic", models: m }), false);
  assert.equal("workspaceId" in E.cleanConnection({ id: "claude", kind: "anthropic", models: m, workspaceId: "" }), false);
  assert.equal("workspaceId" in E.cleanConnection({ id: "site", kind: "vllm", baseUrl: "http://h/v1", models: m, workspaceId: "wrkspc_a1" }), false);
  // 화면으로 이어지는 실패: 워크스페이스를 쓰는 종류의 미지정 · 형식 · 없는 워크스페이스. 그 밖의 실패(키, 네트워크)는 기존 실패 화면
  for (const w of ["unscoped", "invalid", "not-found"]) assert.equal(E.needsWorkspace("anthropic", { workspace: w }), true, w);
  assert.equal(E.needsWorkspace("anthropic", { status: 401, workspace: null }), false);
  assert.equal(E.needsWorkspace("anthropic", new Error("fetch failed")), false);
  assert.equal(E.needsWorkspace("vllm", { workspace: "unscoped" }), false);
  // 기본 워크스페이스 먼저, 나머지는 받은 순서, 같은 ID 는 한 번만
  assert.deepEqual(E.sortWorkspaces([{ id: "wrkspc_b", name: "b" }, { id: "wrkspc_d", name: "Default", isDefault: true }, { id: "wrkspc_a", name: "a" }, { id: "wrkspc_b", name: "b2" }])
    .map((w) => w.id), ["wrkspc_d", "wrkspc_b", "wrkspc_a"]);
  assert.deepEqual(E.sortWorkspaces(undefined), []);
});

test("LLM 연결 종류 표: 화면 문구(label · hint · detail · urlExample · contextNote)가 한 줄(74칸) 안 · 기본 주소가 없으면 주소 예시가 있다", async () => {
  const { LLM_KINDS } = await import("../scripts/llm-connections.mjs");
  for (const [id, k] of Object.entries(LLM_KINDS)) {
    for (const s of [k.label, k.hint, ...k.detail, k.urlExample ?? "", k.contextNote]) assert.ok(displayWidth(s) <= 74, `${id}: ${s}`);
    assert.ok(k.baseUrl || k.urlExample, `${id}: 기본 주소도 주소 예시도 없음`);
    assert.ok(k.contextNote, `${id}: contextNote 없음`);
  }
});

// ---------------------------------------------------------------- 모니터 모드 (docs/monitor-tui-spec.md, installer/oxy-tui/src/monitor.rs)
test("모니터 예시 모델: model.ts 가 지금 만드는 것과 tests/fixtures/monitor 가 같다 (cargo test 가 이 파일을 읽는다)", async () => {
  const { writeFixtures, DEFAULT_DIR } = await import("./monitor-fixtures.mjs");
  const dir = mkdtempSync(join(tmpdir(), "oxy-monfx-"));
  try {
    const index = JSON.parse(readFileSync(join(DEFAULT_DIR, "index.json"), "utf8"));
    const files = await writeFixtures({ outDir: dir, now: index.generatedAt });
    assert.deepEqual(files, index.files, "index.json 의 크기 · modelHeight");
    for (const f of readdirSync(dir)) {
      assert.equal(readFileSync(join(dir, f), "utf8"), readFileSync(join(DEFAULT_DIR, f), "utf8"),
        `${f}: model.ts 와 어긋남. node --experimental-strip-types --no-warnings tests/monitor-fixtures.mjs 로 다시 만든 뒤 just tui-test`);
    }
    // since 는 now 기준 몇 초 전, 모든 모델의 줄 수는 높이 안
    for (const f of files) assert.ok(f.modelHeight <= f.height, `${f.file}: ${f.modelHeight} > ${f.height}`);
    const flow = JSON.parse(readFileSync(join(dir, "flow-23x12.json"), "utf8"));
    assert.deepEqual([flow.op, flow.kind, flow.title, flow.sections[0].title, flow.sections[0].rows[0].since], ["monitor", "flow", "Flow Monitor", "Current Task", index.generatedAt - 42000]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("oxy-tui.exe: --version 에 monitor, demo monitor --model --exit-after 가 종료 코드 0 이고 그린 줄이 폭 안", async (t) => {
  const exe = join(import.meta.dirname, "..", "bin", "oxy-tui.exe");
  if (!existsSync(exe)) return t.skip("bin/oxy-tui.exe 없음 (just tui-build 또는 fetch)");
  const { spawnSync } = await import("node:child_process");
  const { DEFAULT_DIR } = await import("./monitor-fixtures.mjs");
  const v = spawnSync(exe, ["--version"], { encoding: "utf8" });
  assert.match(v.stdout.trim(), /^oxy-tui \d+\.\d+\.\d+ monitor$/, "예전 exe 는 monitor 를 출력하지 않는다. just tui-build");
  const at = JSON.parse(readFileSync(join(DEFAULT_DIR, "index.json"), "utf8")).generatedAt;
  for (const [name, size] of [["flow-23x12", [23, 12]], ["jobs-23x12", [23, 12]], ["flow-35x28", [35, 28]], ["jobs-35x28", [35, 28]]]) {
    const r = spawnSync(exe, ["demo", "monitor", "--model", join(DEFAULT_DIR, `${name}.json`), "--exit-after", "300", "--size", size.join("x"), "--now", String(at + 5000)], { encoding: "utf8", timeout: 10000 });
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    const lines = r.stdout.replace(/\r/g, "").split("\n").slice(0, -1);
    assert.equal(lines.length, size[1], `${name}: 줄 수`);
    for (const l of lines) assert.ok(displayWidth(l) <= size[0], `${name}: ${size[0]}칸 넘음: ${l}`);
    assert.match(lines.join("\n"), /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/, `${name}: 스피너`);
    const clock = name.startsWith("flow") ? "0:47" : "0:17";   // flow: 지금 할 일 42초 전 시작, jobs: 작업 12초 전 시작 (+ 5초)
    assert.ok(new RegExp("\\b" + clock + "\\b").test(lines.join("\n")), `${name}: 경과 m:ss (${clock})`);
  }
  const bad = spawnSync(exe, ["demo", "monitor", "--model", join(DEFAULT_DIR, "없는파일.json")], { encoding: "utf8" });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /보기 모델을 읽지 못했습니다/);
  assert.equal(spawnSync(exe, ["--pipe", "x", "--mode", "nope"], { encoding: "utf8" }).status, 2);
});
