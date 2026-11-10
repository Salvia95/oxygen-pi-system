// 설치 TUI · Tweak 공용 입력(UI)을 가짜 터미널로 점검한다: 붙여넣기 · 단계 그림 · 화면 폭 · 상태 기호 · 줄 입력 문법 (docs/tui-spec.md §9)
//   node --test tests/unit-tui.test.mjs
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { readFileSync, readdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { InputEnded, UI, displayWidth, stepArt, stripAnsi, truncate, truncatePath } from "../installer/tui.mjs";

/** keypress 를 직접 내보내는 가짜 TTY. 출력은 버린다 */
function fakeTerm() {
  const input = new EventEmitter();
  Object.assign(input, { isTTY: true, setRawMode() {}, resume() {}, pause() {} });
  const output = { isTTY: true, columns: 100, write() { return true; } };
  const ui = new UI({ input, output, tty: true });
  const keys = (...evs) => { for (const [str, key] of evs) input.emit("keypress", str, key); };
  const ch = (s) => [...s].map((x) => [x, { name: /[a-z]/i.test(x) ? x.toLowerCase() : undefined, sequence: x }]);
  const enter = ["\r", { name: "return" }];
  return { ui, keys, ch, enter, tick: () => new Promise((r) => setImmediate(r)) };
}

test("붙여넣기: 한꺼번에 들어온 글자를 모두 받는다 (예전에는 첫 글자만 남음)", async () => {
  const t = fakeTerm();
  const p = t.ui.input("vLLM 주소");
  await t.tick();
  t.keys(...t.ch("http://vllm.example.internal:8000/v1"));   // 한 번에(동기적으로) 도착
  await t.tick();
  t.keys(t.enter);
  assert.equal(await p, "http://vllm.example.internal:8000/v1");
});

test("붙여넣기: 끝의 줄바꿈 · 중간 줄바꿈은 확정으로 보지 않는다", async () => {
  const t = fakeTerm();
  const p = t.ui.input("API 키");
  await t.tick();
  t.keys(...t.ch("abc"), t.enter, ["\n", { name: "enter" }], ...t.ch("def"));   // 복사한 텍스트에 줄바꿈이 섞임
  await t.tick();
  t.keys(t.enter);
  assert.equal(await p, "abcdef");
});

test("bracketed paste: paste-start ~ paste-end 사이의 줄바꿈은 무시", async () => {
  const t = fakeTerm();
  const p = t.ui.input("호스트");
  await t.tick();
  t.keys([undefined, { name: "paste-start" }], ...t.ch("gitlab.local"), t.enter, [undefined, { name: "paste-end" }]);
  await t.tick();
  await t.tick();
  t.keys(t.enter);
  assert.equal(await p, "gitlab.local");
});

test("한 글자씩 입력 · 지우기 · 확정", async () => {
  const t = fakeTerm();
  const p = t.ui.input("이름", { initial: "x" });
  for (const k of [...t.ch("ab"), ["\x7f", { name: "backspace" }], t.enter]) { await t.tick(); t.keys(k); }
  assert.equal(await p, "xa");
});

test("단계 그림: 지난 단계 ✔ · 현재 굵은 상자 · 좁은 폭에서는 줄바꿈", () => {
  const names = ["점검", "위치", "선택", "vLLM"];
  const plain = stepArt(names, 2, 200).replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(plain, /✔ 점검/);
  assert.match(plain, /┃ ▶ 선택 ┃/);
  assert.equal(plain.split("\n").length, 3);
  assert.equal(stepArt(names, 2, 30).split("\n").length, 6);
});

test("줄 입력 모드: 비밀값(mask)은 출력·로그에 되찍지 않는다", async () => {
  const { PassThrough } = await import("node:stream");
  const input = new PassThrough(), output = new PassThrough();
  let out = "";
  output.on("data", (d) => (out += d));
  const ui = new UI({ input, output, tty: false });
  input.write("gsk-secret-value\nplain-host\n");
  assert.equal(await ui.input("API 키", { mask: true }), "gsk-secret-value");
  assert.equal(await ui.input("호스트"), "plain-host");
  assert.ok(!out.includes("gsk-secret-value"), "비밀값이 출력에 남음");
  assert.ok(out.includes("(입력됨)") && out.includes("plain-host"));
});

// ---------------------------------------------------------------- 화면 규칙 (docs/tui-spec.md §9)
/** 출력을 모으는 가짜 TTY (cols × rows). 마지막으로 그린 화면을 색 없이 돌려준다 */
function screenTerm(cols = 80, rows = 24, { color = false } = {}) {
  const input = new EventEmitter();
  Object.assign(input, { isTTY: true, setRawMode() {}, resume() {}, pause() {} });
  let buf = "";
  const output = { isTTY: true, columns: cols, rows, write(s) { buf += s; return true; }, on() {} };
  const ui = new UI({ input, output, tty: true, color });
  ui.version = "0.1.0";
  const key = (str, k) => input.emit("keypress", str, k);
  const last = () => {
    const s = buf.slice(buf.lastIndexOf("\x1b[H") + 3).replace(/\x1b\[\d+;\d+H[\s\S]*$/, "");
    return stripAnsi(s).replace(/\n$/, "").split("\n");
  };
  return { ui, key, last, raw: () => buf, tick: () => new Promise((r) => setImmediate(r)) };
}
const LONG = String.raw`C:\Users\kim\AppData\Local\Programs\oxygen-pi\아주\긴\경로\이름이\이어지는\폴더`;
const STEPS = { steps: ["점검", "폴더", "구성요소", "LLM", "모델", "GitLab", "등록", "확인"], longSteps: ["환경 점검", "설치 폴더", "구성요소", "LLM 연결", "모델", "GitLab 연결", "실행 등록", "확인"] };
function manyRows(n = 13) {
  const rows = [];
  for (let g = 0; g < 4; g++) {
    rows.push({ header: `그룹 ${g}`, desc: "설명 문구가 길게 이어집니다 · 명령 실행 · API 시험" });
    for (let i = 0; i < Math.ceil(n / 4) && rows.filter((r) => !r.header).length < n; i++) {
      rows.push({ label: `항목 ${g}-${i} 이름`, value: `${g}-${i}`, checked: i % 2 === 0, hint: `${LONG} · 아주 긴 설명이 붙어 잘려야 합니다`,
        locked: g === 0 && i === 0, disabled: g === 2 && i === 1 ? "반입 안 됨" : false, why: "직접 반입해야 합니다", fix: "vendor/ 에 넣고 다시 번들링",
        detail: [["바뀌는 것", "bin/x.exe 복사"], ["되돌리기", "tweak.cmd › 도구 사용법"]] });
    }
  }
  return rows;
}

for (const [cols, rows] of [[80, 24], [60, 24], [100, 30]]) {
  test(`K1·K2·K3: ${cols}×${rows} 에서 모든 줄이 폭 안, 화면은 ${rows - 1}줄 이하 (select · multiselect · input · confirm)`, async () => {
    const screens = [
      (ui) => ui.select("어디에 설치할까요?", [{ label: "기본 위치에 설치", value: 1, recommended: true, hint: LONG, detail: [["바뀌는 것", "약 12,480개 복사"]] }, { label: "다른 폴더 직접 입력…", value: 2 }],
        { note: "번들(약 1GB)을 설치 폴더로 복사합니다. 이미 설치된 폴더를 고르면 설정을 유지한 채 업데이트합니다." }),
      (ui) => ui.multiselect("어떤 구성요소를 설치할까요?", manyRows(13), { note: "반입된 구성요소만 고를 수 있습니다. 고른 구성요소의 도구 사용법이 켜집니다. 세 번째 문장도 있습니다." }),
      (ui) => ui.input("어느 LLM 서버에 연결할까요?", { initial: "http://" + "x".repeat(120), note: ["vLLM 등 OpenAI 호환 주소입니다. /v1 이 없으면 자동으로 붙입니다.", "예: http://vllm.example.internal:8000/v1"] }),
      (ui) => ui.confirm("tdb 연결을 삭제할까요?", { yes: "tdb 연결 삭제", no: "삭제 취소", level: "medium", note: `connections.json 의 tdb · ${LONG}` }),
    ];
    for (const open of screens) {
      const t = screenTerm(cols, rows);
      t.ui.setFrame({ ...STEPS, current: 2, right: LONG });
      const p = open(t.ui);
      await t.tick();
      for (let k = 0; k < 8; k++) { t.key(undefined, { name: "down" }); await t.tick(); }
      const lines = t.last();
      for (const l of lines) assert.ok(displayWidth(l) <= cols, `${cols}칸 초과 (${displayWidth(l)}): ${l}`);
      assert.ok(lines.length <= rows - 1, `${lines.length}줄 > ${rows - 1}`);
      t.key(undefined, { name: "escape" }); await t.tick(); t.key(undefined, { name: "return" });
      await p;
    }
  });
}

test("K3: 목록이 넘치면 ↑/↓ n줄 더 와 포커스 행이 보인다", async () => {
  const t = screenTerm(80, 24);
  const p = t.ui.multiselect("어떤 구성요소를 설치할까요?", manyRows(13), { note: "한 줄\n두 줄\n세 줄" });
  await t.tick();
  for (let k = 0; k < 12; k++) { t.key(undefined, { name: "down" }); await t.tick(); }
  const s = t.last().join("\n");
  assert.match(s, /↑ 위에 \d+줄 더/);
  assert.match(s, /❯ 13 /);
  t.key("\r", { name: "return" });
  await p;
});

test("K4·K5: NO_COLOR 면 색 코드가 없고, 상태가 기호·문구로 구분된다", async () => {
  const before = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
  try {
    const input = new EventEmitter();
    Object.assign(input, { isTTY: true, setRawMode() {}, resume() {}, pause() {} });
    let buf = "";
    const ui = new UI({ input, output: { isTTY: true, columns: 80, rows: 40, write(s) { buf += s; return true; }, on() {} }, tty: true });
    const p = ui.multiselect("무엇을 켤까요?", [
      { label: "잠금", value: 1, locked: true }, { label: "선택됨", value: 2, checked: true }, { label: "안 됨", value: 3 },
      { label: "비활성", value: 4, disabled: "반입 안 됨" }, { label: "권장", value: 5, recommended: true }, { label: "위험", value: 6, danger: true },
    ]);
    await new Promise((r) => setImmediate(r));
    assert.ok(!/\x1b\[(3\d|9\d)m/.test(buf), "색 코드가 남음");
    const s = stripAnsi(buf);
    for (const mark of ["❯", "[■]", "[✔]", "[ ]", "[·]", "(추천)", "! 위험", "필수", "반입 안 됨"]) assert.ok(s.includes(mark), mark);
    input.emit("keypress", "\r", { name: "return" });
    await p;
  } finally { if (before === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = before; }
});

test("K4: TERM=dumb 이면 줄 입력 모드", () => {
  const before = process.env.TERM;
  process.env.TERM = "dumb";
  try {
    const input = Object.assign(new EventEmitter(), { isTTY: true });
    assert.equal(new UI({ input, output: { isTTY: true, write() {} } }).tty, false);
  } finally { process.env.TERM = before; }
});

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

test("K6: 줄 입력 multiselect — 빈칸 · 정확히 · +N -N · 섞으면 오류 · - · <", async () => {
  const cases = [["", ["a", "b", "e"]], ["2,3", ["a", "b", "c"]], ["+3 -5", ["a", "b", "c"]], ["-", ["a"]]];
  for (const [ans, want] of cases) assert.deepEqual(await lineUI([ans]).ui.multiselect("무엇을?", MS), want, ans);
  const mixed = lineUI(["2 +3", "4", "-1", "+3"]);
  assert.deepEqual(await mixed.ui.multiselect("무엇을?", MS), ["a", "b", "c", "e"]);
  const o = mixed.out();
  assert.match(o, /한 가지로 입력하세요/);
  assert.match(o, /4번 D은\(는\) 고를 수 없습니다/);
  assert.match(o, /1번 필수은\(는\) 필수라 해제할 수 없습니다/);
  assert.equal(await lineUI(["<"]).ui.multiselect("무엇을?", MS), (await import("../installer/tui.mjs")).BACK);
  assert.match(lineUI([]).out() + o, /\[■\] 필수 · \[✔\] B|\[■\] 필수/);
});

test("줄 입력 모드: 입력이 끝나면 기다리던 질문을 알린다 (스택 없음)", async () => {
  const { ui } = lineUI([]);
  await assert.rejects(ui.select("어디에 설치할까요?", [{ label: "a", value: 1 }]), (e) => e instanceof InputEnded && e.question === "어디에 설치할까요?");
});

test("K8: 숫자 키는 포커스만 옮긴다 (1 → 3 을 이어 누르면 13), 확정은 Enter", async () => {
  const t = screenTerm(80, 40);
  const opts = Array.from({ length: 14 }, (_, i) => ({ label: `항목 ${i + 1}`, value: i + 1 }));
  const p = t.ui.select("무엇을 바꿀까요?", opts);
  await t.tick();
  t.key("1", { name: "1" }); t.key("3", { name: "3" });
  await t.tick();
  assert.match(t.last().join("\n"), /❯ 13 /);
  t.key("\r", { name: "return" });
  assert.equal(await p, 13);
});

test("K9: 비활성 항목은 번호가 있고, Enter·Space 는 이유만 보이고 값을 돌려주지 않는다", async () => {
  const t = screenTerm(80, 24);
  const p = t.ui.select("무엇을 바꿀까요?", [{ label: "웹 페이지 자동화", value: "b", disabled: "사용 불가", why: "agent-browser 가 설치되지 않았습니다" }, { label: "종료", value: "x" }], { initial: 0 });
  await t.tick();
  t.key("\r", { name: "return" });
  await t.tick();
  const s = t.last().join("\n");
  assert.match(s, /1 {2}웹 페이지 자동화/);
  assert.match(s, /고를 수 없습니다: agent-browser 가 설치되지 않았습니다/);
  t.key(undefined, { name: "down" }); t.key("\r", { name: "return" });
  assert.equal(await p, "x");
});

test("K11: confirm 은 yes/no 레이블이 없으면 예외, 1 = 진행 · 2 = 안 함 · medium 은 초기 2", async () => {
  const { ui } = lineUI(["", ""]);
  await assert.rejects(ui.confirm("정말 할까요?"), /yes\/no/);
  assert.equal(await ui.confirm("tdb 연결을 삭제할까요?", { yes: "tdb 연결 삭제", no: "삭제 취소", level: "medium" }), false);
  assert.equal(await lineUI([""]).ui.confirm("동작 시험(verify)을 실행할까요?", { yes: "동작 시험 실행", no: "건너뛰기" }), true);
});

test("K13: 금지 문구가 installer/*.mjs 에 남아 있지 않다", () => {
  const dir = join(import.meta.dirname, "..", "installer");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".mjs"))) {
    const s = readFileSync(join(dir, f), "utf8");
    for (const bad of ["(권장)", "← 뒤로", "Enter 선택", "Enter 확인", "Enter 를 누르면", "label: \"예\"", "label: \"아니요\""]) {
      assert.ok(!s.includes(bad), `${f}: ${bad}`);
    }
  }
});

test("K15: task 는 fn 을 부르기 전에 레이블을 그리고, 폭을 넘는 경로는 가운데를 줄인다", async () => {
  const t = screenTerm(60, 24);
  let seen = "";
  await t.ui.task("파일 복사", async () => { seen = stripAnsi(t.raw()); }, { target: LONG });
  assert.match(seen, /파일 복사/);
  const line = stripAnsi(t.raw()).split("\r").at(-1).replace(/\x1b\[2K/g, "").split("\n")[0];
  assert.ok(displayWidth(line) < 60, line);
  assert.match(line, /…/);
});

test("K16: Ctrl+C 는 반쯤 된 상태를 한 줄로 알리고 130 으로 끝낸다", async () => {
  const t = screenTerm(80, 24);
  const exit = process.exit;
  let code = null;
  process.exit = (c) => { code = c; throw new Error("exit"); };
  try {
    t.ui.interruptNote = () => "중단했습니다. 아무것도 바꾸지 않았습니다.";
    t.ui.select("어디에 설치할까요?", [{ label: "a", value: 1 }]).catch(() => {});
    await t.tick();
    assert.throws(() => t.key("\x03", { name: "c", ctrl: true }), /exit/);
  } finally { process.exit = exit; }
  assert.equal(code, 130);
  assert.match(t.raw(), /중단했습니다\. 아무것도 바꾸지 않았습니다\./);
});

test("말줄임: 설명 끝 · 경로 가운데 · 2칸 글자 중간은 자르지 않음", () => {
  assert.equal(truncatePath(String.raw`C:\Users\kim\AppData\Local\Programs\oxygen-pi`, 34), String.raw`C:\Users\kim\…\Programs\oxygen-pi`);
  const t = truncate("터미널 멀티플렉서 (tmux 호환) · 대화형 프로그램 조작", 20);
  assert.ok(displayWidth(t) <= 20 && t.endsWith("…"), t);
  assert.ok(displayWidth(truncate("가나다라마바사", 6)) <= 6);
});

test("K17: 복사 전에 쓴 설치 표시(partial)가 있으면 같은 폴더를 우리 설치로 보고 이어서 설치한다", async () => {
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
