// 의존성 없는 최소 TUI. 진짜 터미널(TTY)에서는 방향키 UI, 아니면(파이프, mintty) 줄 단위 입력으로 동작한다.
import readline from "node:readline";

const useColor = !process.env.NO_COLOR && process.stdout.isTTY;
const sgr = (open, close) => (s) => (useColor ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
export const c = {
  bold: sgr(1, 22), dim: sgr(2, 22), red: sgr(31, 39), green: sgr(32, 39), yellow: sgr(33, 39),
  cyan: sgr(36, 39), gray: sgr(90, 39), inverse: sgr(7, 27),
};
const c256 = (n) => (s) => (useColor ? `\x1b[38;5;${n}m${s}\x1b[39m` : s);

export const BACK = Symbol("back");

// ---------------------------------------------------------------- banner
const FONT = {
  O: [" ███ ", "█   █", "█   █", "█   █", " ███ "],
  X: ["█   █", " █ █ ", "  █  ", " █ █ ", "█   █"],
  Y: ["█   █", " █ █ ", "  █  ", "  █  ", "  █  "],
  G: [" ████", "█    ", "█  ██", "█   █", " ███ "],
  E: ["█████", "█    ", "████ ", "█    ", "█████"],
  N: ["█   █", "██  █", "█ █ █", "█  ██", "█   █"],
  P: ["████ ", "█   █", "████ ", "█    ", "█    "],
  I: ["███", " █ ", " █ ", " █ ", "███"],
  S: [" ████", "█    ", " ███ ", "    █", "████ "],
  T: ["█████", "  █  ", "  █  ", "  █  ", "  █  "],
  M: ["█   █", "██ ██", "█ █ █", "█   █", "█   █"],
  " ": ["  ", "  ", "  ", "  ", "  "],
};
const GRADIENT = [51, 45, 39, 33, 27];

function renderWord(text) {
  const rows = ["", "", "", "", ""];
  [...text].forEach((ch, i) => {
    const glyph = FONT[ch] ?? FONT[" "];
    for (let r = 0; r < 5; r++) rows[r] += (i ? " " : "") + glyph[r];
  });
  return rows;
}

// 부제·버전용 3x5 픽셀 폰트. 위아래 반쪽 블록(▀▄█)으로 합쳐 3줄 높이로 그린다.
const MINI = {
  A: [".#.", "#.#", "###", "#.#", "#.#"], B: ["##.", "#.#", "##.", "#.#", "##."], C: [".##", "#..", "#..", "#..", ".##"],
  D: ["##.", "#.#", "#.#", "#.#", "##."], E: ["###", "#..", "##.", "#..", "###"], F: ["###", "#..", "##.", "#..", "#.."],
  G: [".##", "#..", "#.#", "#.#", ".##"], I: ["###", ".#.", ".#.", ".#.", "###"], K: ["#.#", "#.#", "##.", "#.#", "#.#"],
  L: ["#..", "#..", "#..", "#..", "###"], N: ["#..#", "##.#", "#.##", "#..#", "#..#"], O: [".#.", "#.#", "#.#", "#.#", ".#."],
  P: ["##.", "#.#", "##.", "#..", "#.."], R: ["##.", "#.#", "##.", "#.#", "#.#"], S: [".##", "#..", ".#.", "..#", "##."],
  T: ["###", ".#.", ".#.", ".#.", ".#."], W: ["#.#", "#.#", "###", "###", "#.#"],
  0: ["###", "#.#", "#.#", "#.#", "###"], 1: [".#.", "##.", ".#.", ".#.", "###"], 2: ["##.", "..#", ".#.", "#..", "###"],
  3: ["##.", "..#", ".#.", "..#", "##."], 4: ["#.#", "#.#", "###", "..#", "..#"], 5: ["###", "#..", "##.", "..#", "##."],
  6: [".##", "#..", "###", "#.#", "###"], 7: ["###", "..#", ".#.", ".#.", ".#."], 8: ["###", "#.#", "###", "#.#", "###"],
  9: ["###", "#.#", "###", "..#", "##."], v: ["...", "...", "#.#", "#.#", ".#."], ".": [".", ".", ".", ".", "#"],
  "-": ["...", "...", "###", "...", "..."], " ": ["..", "..", "..", "..", ".."],
};

/** 작은 픽셀 폰트로 3줄 텍스트를 만든다 */
function renderMini(text) {
  const px = ["", "", "", "", "", ""]; // 5픽셀 + 아래 여백 1픽셀
  [...text].forEach((ch, i) => {
    const g = MINI[ch] ?? MINI[ch.toUpperCase()] ?? MINI[" "];
    for (let r = 0; r < 5; r++) px[r] += (i ? "." : "") + g[r];
    px[5] += (i ? "." : "") + ".".repeat(g[0].length);
  });
  const rows = [0, 2, 4].map((k) => [...px[k]].map((t, x) => {
    const top = t === "#";
    const bot = px[k + 1][x] === "#";
    return top && bot ? "█" : top ? "▀" : bot ? "▄" : " ";
  }).join(""));
  return { rows, width: px[0].length };
}

export const SUBTITLE = "PI Based Coding Agent For Closed Network";

/**
 * 배너: "OXYGEN PI SYSTEM"(큰 글씨, 폭이 좁으면 두 줄) + 부제(작은 글씨, 배너 폭에 맞춰 줄바꿈)
 * + 버전(작은 글씨, 마지막 부제 줄 오른쪽 끝).
 */
export function banner(version) {
  const cols = process.stdout.columns || 100;
  const blocks = cols >= 98 ? [renderWord("OXYGEN PI SYSTEM")] : [renderWord("OXYGEN PI"), renderWord("SYSTEM")];
  const bigWidth = Math.max(...blocks.flat().map((r) => r.length));
  const out = [""];
  blocks.forEach((rows, bi) => {
    rows.forEach((row, r) => out.push("  " + c256(GRADIENT[r])(row)));
    if (bi < blocks.length - 1) out.push("");
  });
  out.push("");

  // 부제: 넓은 화면은 큰 배너 폭에 맞추고, 좁은 화면은 터미널 폭까지 써서 줄 수를 줄인다
  const wrapWidth = blocks.length === 1 ? bigWidth : Math.max(bigWidth, cols - 4);
  const lines = [];
  for (const w of SUBTITLE.split(" ")) {
    const cand = lines.length ? `${lines.at(-1)} ${w}` : w;
    if (lines.length && renderMini(cand).width <= wrapWidth) lines[lines.length - 1] = cand;
    else lines.push(w);
  }
  const sub = lines.map(renderMini);
  const ver = renderMini(`v${version}`);
  const last = sub.at(-1);
  const total = Math.max(bigWidth, last.width + 4 + ver.width);
  const inline = total + 2 <= cols;
  const subColor = c256(250);
  const verColor = c256(45);

  sub.forEach((s, i) => {
    s.rows.forEach((row, r) => {
      if (i === sub.length - 1 && inline) {
        out.push("  " + subColor(row) + " ".repeat(total - s.width - ver.width) + verColor(ver.rows[r]));
      } else out.push("  " + subColor(row));
    });
  });
  if (!inline) ver.rows.forEach((row) => out.push("  " + " ".repeat(Math.max(0, bigWidth - ver.width)) + verColor(row)));
  out.push("");
  return out.join("\n");
}

// ---------------------------------------------------------------- UI
export class UI {
  constructor() {
    this.tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    /** 매 화면 위쪽에 그릴 내용 (배너 + 단계 표시) */
    this.frame = () => "";
    this.lines = null;
  }

  // ---- 공통 출력
  clear() { if (this.tty) process.stdout.write("\x1b[2J\x1b[3J\x1b[H"); }
  screen(body) { this.clear(); process.stdout.write(this.frame() + "\n" + body + "\n"); }
  print(s = "") { process.stdout.write(s + "\n"); }

  // ---- TTY 키 입력
  #raw(on) {
    if (!this.tty) return;
    if (on && !this.keysReady) { readline.emitKeypressEvents(process.stdin); this.keysReady = true; }
    process.stdin.setRawMode(on);
    if (on) process.stdin.resume(); else process.stdin.pause();
  }
  #key() {
    return new Promise((resolve) => {
      process.stdin.once("keypress", (str, key = {}) => {
        if (key.ctrl && key.name === "c") { this.#raw(false); process.stdout.write("\x1b[?25h\n"); process.exit(130); }
        resolve({ str, key });
      });
    });
  }

  // ---- 줄 입력 (TTY 아님)
  async #line(prompt) {
    if (!this.lines) {
      this.rl = readline.createInterface({ input: process.stdin, terminal: false });
      this.lines = this.rl[Symbol.asyncIterator]();
    }
    process.stdout.write(prompt);
    const { value, done } = await this.lines.next();
    if (done) throw new Error("입력이 끝났습니다 (stdin EOF)");
    process.stdout.write(value + "\n");
    return value.trim();
  }

  /** 하나 고르기. options: [{label, value, hint}] */
  async select(question, options, { initial = 0, back = true, note = "" } = {}) {
    if (!this.tty) {
      this.print(`\n${question}${note ? "\n" + note : ""}`);
      options.forEach((o, i) => this.print(`  ${i + 1}) ${o.label}${o.hint ? c.gray("  " + o.hint) : ""}`));
      for (;;) {
        const a = await this.#line(`번호 [${initial + 1}]${back ? " (<: 이전)" : ""}: `);
        if (back && a === "<") return BACK;
        const n = a === "" ? initial + 1 : Number(a);
        if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1].value;
        this.print(c.red(`  ✖ 1~${options.length} 사이의 번호를 입력하세요`));
      }
    }
    let i = initial;
    this.#raw(true);
    try {
      for (;;) {
        const body = options.map((o, k) => {
          const line = `${k === i ? c.cyan("❯ " + o.label) : "  " + o.label}${o.hint ? c.gray("  " + o.hint) : ""}`;
          return "  " + line;
        });
        this.screen(`  ${c.bold(question)}\n${note ? note + "\n" : ""}\n${body.join("\n")}\n\n  ${c.gray(`↑↓ 이동 · Enter 선택${back ? " · Esc 이전" : ""} · Ctrl+C 종료`)}`);
        const { str, key } = await this.#key();
        if (key.name === "up" || key.name === "k") i = (i - 1 + options.length) % options.length;
        else if (key.name === "down" || key.name === "j" || key.name === "tab") i = (i + 1) % options.length;
        else if (key.name === "return" || key.name === "enter") return options[i].value;
        else if (back && key.name === "escape") return BACK;
        else if (/^[1-9]$/.test(str ?? "") && Number(str) <= options.length) i = Number(str) - 1;
      }
    } finally { this.#raw(false); }
  }

  /** 여러 개 고르기. options: [{label, value, checked, hint}] → value[] */
  async multiselect(question, options, { back = true, note = "" } = {}) {
    const checked = options.map((o) => Boolean(o.checked));
    if (!this.tty) {
      this.print(`\n${question}${note ? "\n" + note : ""}`);
      options.forEach((o, k) => this.print(`  ${k + 1}) [${checked[k] ? "x" : " "}] ${o.label}${o.hint ? c.gray("  " + o.hint) : ""}`));
      for (;;) {
        const a = await this.#line(`선택할 번호들 (예: 1,3 / 빈칸=표시된 대로 / -=없음${back ? " / <=이전" : ""}): `);
        if (back && a === "<") return BACK;
        if (a === "") return options.filter((_, k) => checked[k]).map((o) => o.value);
        if (a === "-") return [];
        const nums = a.split(/[\s,]+/).map(Number);
        if (nums.every((n) => Number.isInteger(n) && n >= 1 && n <= options.length)) return nums.map((n) => options[n - 1].value);
      }
    }
    let i = 0;
    this.#raw(true);
    try {
      for (;;) {
        const body = options.map((o, k) => {
          const box = checked[k] ? c.green("[✔]") : "[ ]";
          const label = k === i ? c.cyan(o.label) : o.label;
          return `  ${k === i ? c.cyan("❯") : " "} ${box} ${label}${o.hint ? c.gray("  " + o.hint) : ""}`;
        });
        this.screen(`  ${c.bold(question)}\n${note ? note + "\n" : ""}\n${body.join("\n")}\n\n  ${c.gray(`↑↓ 이동 · Space 선택/해제 · Enter 확정${back ? " · Esc 이전" : ""}`)}`);
        const { key } = await this.#key();
        if (key.name === "up" || key.name === "k") i = (i - 1 + options.length) % options.length;
        else if (key.name === "down" || key.name === "j" || key.name === "tab") i = (i + 1) % options.length;
        else if (key.name === "space") checked[i] = !checked[i];
        else if (key.name === "return" || key.name === "enter") return options.filter((_, k) => checked[k]).map((o) => o.value);
        else if (back && key.name === "escape") return BACK;
      }
    } finally { this.#raw(false); }
  }

  /** 문자열 입력. validate(v) → 오류 문자열 또는 null */
  async input(question, { initial = "", mask = false, validate = () => null, hint = "", back = true } = {}) {
    if (!this.tty) {
      this.print(`\n${question}${hint ? "\n" + c.gray(hint) : ""}`);
      for (;;) {
        const shown = mask && initial ? "****" : initial;
        const a = await this.#line(`> ${shown ? `[${shown}] ` : ""}${back ? "(<: 이전) " : ""}`);
        if (back && a === "<") return BACK;
        const v = a === "" ? initial : a;
        const err = validate(v);
        if (!err) return v;
        this.print(c.red(`  ✖ ${err}`));
      }
    }
    let v = initial;
    let err = null;
    this.#raw(true);
    try {
      for (;;) {
        const shown = mask ? "•".repeat(v.length) : v;
        this.screen(
          `  ${c.bold(question)}\n${hint ? "  " + c.gray(hint) + "\n" : ""}\n  ${c.cyan("❯")} ${shown}${c.inverse(" ")}\n` +
          `${err ? "\n  " + c.red("✖ " + err) + "\n" : "\n"}\n  ${c.gray(`Enter 확인 · Ctrl+U 지우기${back ? " · Esc 이전" : ""}`)}`,
        );
        const { str, key } = await this.#key();
        if (key.name === "return" || key.name === "enter") {
          err = validate(v);
          if (!err) return v;
        } else if (back && key.name === "escape") return BACK;
        else if (key.name === "backspace") v = [...v].slice(0, -1).join("");
        else if (key.ctrl && key.name === "u") v = "";
        else if (str && !key.ctrl && !key.meta && str >= " ") { v += str.replace(/[\r\n]/g, ""); err = null; }
      }
    } finally { this.#raw(false); }
  }

  async confirm(question, { initial = true, note = "" } = {}) {
    const v = await this.select(question, [{ label: "예", value: true }, { label: "아니요", value: false }],
      { initial: initial ? 0 : 1, back: false, note });
    return v === true;
  }

  /** 진행 표시와 함께 비동기 작업 실행. fn(update) 의 update(text) 로 진행 문구 변경 */
  async task(label, fn) {
    const frames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
    let k = 0;
    let extra = "";
    const draw = (mark) => {
      if (this.tty) process.stdout.write(`\r\x1b[2K  ${mark} ${label}${extra ? c.gray("  " + extra) : ""}`);
    };
    const timer = this.tty ? setInterval(() => draw(c.cyan(frames[k++ % frames.length])), 80) : null;
    if (!this.tty) this.print(`  … ${label}`);
    try {
      const r = await fn((t) => { extra = t; });
      if (timer) clearInterval(timer);
      extra = typeof r === "string" ? r : extra;
      if (this.tty) { draw(c.green("✔")); process.stdout.write("\n"); } else this.print(`  ✔ ${label}${extra ? "  " + extra : ""}`);
      return r;
    } catch (e) {
      if (timer) clearInterval(timer);
      extra = "";
      if (this.tty) { draw(c.red("✖")); process.stdout.write("\n"); } else this.print(`  ✖ ${label}`);
      this.print(c.red(`    ${e.message}`));
      throw e;
    }
  }

  async pause(msg = "Enter 를 누르면 계속합니다") {
    if (!this.tty) { try { await this.#line(`\n${msg}: `); } catch { /* EOF 는 계속 */ } return; }
    this.print("\n  " + c.gray(msg));
    this.#raw(true);
    try { for (;;) { const { key } = await this.#key(); if (key.name === "return" || key.name === "enter") return; } }
    finally { this.#raw(false); }
  }

  close() { this.rl?.close(); }
}
