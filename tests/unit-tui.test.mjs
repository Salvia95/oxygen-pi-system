// 설치 TUI · Tweak 공용 입력(UI)을 가짜 터미널로 점검한다: 붙여넣기 · 단계 그림
//   node --test tests/unit-tui.test.mjs
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { stepArt, UI } from "../installer/tui.mjs";

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
