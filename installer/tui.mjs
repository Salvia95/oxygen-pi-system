// 의존성 없는 최소 TUI. 진짜 터미널(TTY)에서는 방향키 UI, 아니면(파이프, mintty) 줄 단위 입력으로 동작한다.
import { execFileSync } from "node:child_process";
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


// ---------------------------------------------------------------- 단계 표시 (상자 그림)
/** 터미널 표시 폭 (한글·전각 문자는 2칸) */
export function displayWidth(s) {
  return [...String(s).replace(/\x1b\[[0-9;]*m/g, "")]
    .reduce((n, ch) => n + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1), 0);
}

/**
 * 진행 단계를 상자로 그린다. 지난 단계 ✔(초록) · 현재 단계 굵은 상자(청록) · 남은 단계(회색).
 * 폭이 모자라면 여러 줄로 나눈다.
 *   ╭──────╮  ╭──────╮  ┏━━━━━━━━┓  ╭──────╮
 *   │✔ 점검│──│✔ 위치│━━┃▶ 선택  ┃──│ vLLM │
 *   ╰──────╯  ╰──────╯  ┗━━━━━━━━┛  ╰──────╯
 */
export function stepArt(names, current, cols = process.stdout.columns || 100) {
  const boxes = names.map((n, i) => {
    const label = ` ${i < current ? "✔" : i === current ? "▶" : " "} ${n} `;
    const w = displayWidth(label);
    const [tl, tr, bl, br, h, v] = i === current ? ["┏", "┓", "┗", "┛", "━", "┃"] : ["╭", "╮", "╰", "╯", "─", "│"];
    const paint = i < current ? c.green : i === current ? (s) => c.cyan(c.bold(s)) : c.gray;
    return { w: w + 2, rows: [paint(tl + h.repeat(w) + tr), paint(v) + (i === current ? c.bold(label) : i < current ? label : c.gray(label)) + paint(v), paint(bl + h.repeat(w) + br)] };
  });
  const lines = [];
  let row = [["", "", ""]];
  let width = 2;
  boxes.forEach((b, i) => {
    const link = i === 0 ? null : i <= current ? c.green("──") : c.gray("──");
    if (i > 0 && width + 2 + b.w > cols - 2) { lines.push(row); row = [["", "", ""]]; width = 2; }
    const r = row[0];
    if (width > 2) { r[0] += "  "; r[1] += link; r[2] += "  "; width += 2; }
    r[0] += b.rows[0]; r[1] += b.rows[1]; r[2] += b.rows[2]; width += b.w;
  });
  lines.push(row);
  return lines.map(([[a, b, d]]) => `  ${a}\n  ${b}\n  ${d}`).join("\n");
}

// ---------------------------------------------------------------- UI
export class UI {
  /** input/output/tty 는 테스트에서 가짜 터미널을 넣을 때만 쓴다 */
  constructor({ input = process.stdin, output = process.stdout, tty } = {}) {
    this.in = input;
    this.out = output;
    this.tty = tty ?? Boolean(input.isTTY && output.isTTY);
    /** 매 화면 위쪽에 그릴 내용 (배너 + 단계 표시) */
    this.frame = () => "";
    this.lines = null;
    /** 받은 키 대기열. 붙여넣기는 keypress 가 한꺼번에 여러 개 오므로, 리스너를 하나만 상주시켜 하나도 잃지 않는다 */
    this.queue = [];
    this.waiter = null;
  }

  // ---- 공통 출력
  clear() { if (this.tty) this.out.write("\x1b[2J\x1b[3J\x1b[H"); }
  screen(body) { this.clear(); this.out.write(this.frame() + "\n" + body + "\n"); }
  print(s = "") { this.out.write(s + "\n"); }

  // ---- TTY 키 입력
  #raw(on) {
    if (!this.tty) return;
    if (on && !this.keysReady) {
      readline.emitKeypressEvents(this.in);
      this.in.on("keypress", (str, key = {}) => {
        if (key.ctrl && key.name === "c") { this.#raw(false); this.out.write("\x1b[?25h\n"); process.exit(130); }
        const ev = { str, key };
        if (this.waiter) { const w = this.waiter; this.waiter = null; w(ev); } else this.queue.push(ev);
      });
      this.keysReady = true;
    }
    if (on) this.queue.length = 0; // 이전 화면에서 남은 키는 버린다
    this.in.setRawMode?.(on);
    // bracketed paste: 붙여넣기 구간을 paste-start / paste-end 로 알려 준다 (Windows Terminal 등)
    this.out.write(on ? "\x1b[?2004h" : "\x1b[?2004l");
    if (on) this.in.resume(); else this.in.pause();
  }
  #key() {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    return new Promise((resolve) => { this.waiter = resolve; });
  }

  // ---- 줄 입력 (TTY 아님)
  async #line(prompt) {
    if (!this.lines) {
      this.rl = readline.createInterface({ input: this.in, terminal: false });
      this.lines = this.rl[Symbol.asyncIterator]();
    }
    this.out.write(prompt);
    const { value, done } = await this.lines.next();
    if (done) throw new Error("입력이 끝났습니다 (stdin EOF)");
    this.out.write(value + "\n");
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

  /**
   * 여러 개 고르기. options: [{label, value, checked, hint, locked}] → value[]
   * locked: 항상 선택된 상태로 고정 (해제 불가, 결과에 항상 포함)
   */
  async multiselect(question, rows, { back = true, note = "" } = {}) {
    // rows 에 {header: "제목", desc} 를 섞으면 계층 제목 줄로 표시한다 (선택 대상 아님, 번호 없음)
    const options = rows.filter((r) => !r.header);
    const checked = options.map((o) => Boolean(o.checked || o.locked));
    const withLocked = (vals) => [...new Set([...options.filter((o) => o.locked).map((o) => o.value), ...vals])]
      .sort((a, b) => options.findIndex((o) => o.value === a) - options.findIndex((o) => o.value === b));
    const headerLine = (r) => `  ${c.bold(c.cyan(r.header))}${r.desc ? c.gray("  " + r.desc) : ""}`;
    if (!this.tty) {
      this.print(`\n${question}${note ? "\n" + note : ""}`);
      let k = 0;
      for (const r of rows) {
        if (r.header) { this.print(headerLine(r)); continue; }
        this.print(`   ${String(k + 1).padStart(2)}) [${r.locked ? "#" : checked[k] ? "x" : " "}] ${r.label}${r.hint ? c.gray("  " + r.hint) : ""}`);
        k++;
      }
      if (options.some((o) => o.locked)) this.print(c.gray("  [#] 는 필수 항목이라 항상 포함됩니다"));
      for (;;) {
        const a = await this.#line(`선택할 번호들 (예: 1,3 / 빈칸=표시된 대로 / -=필수만${back ? " / <=이전" : ""}): `);
        if (back && a === "<") return BACK;
        if (a === "") return withLocked(options.filter((_, j) => checked[j]).map((o) => o.value));
        if (a === "-") return withLocked([]);
        const nums = a.split(/[\s,]+/).map(Number);
        if (nums.every((n) => Number.isInteger(n) && n >= 1 && n <= options.length)) return withLocked(nums.map((n) => options[n - 1].value));
        this.print(c.red(`  ✖ 1~${options.length} 사이의 번호를 쉼표로 구분해 입력하세요`));
      }
    }
    let msg = "";
    let i = 0;
    this.#raw(true);
    try {
      for (;;) {
        let k = 0;
        const body = rows.map((r) => {
          if (r.header) return headerLine(r);
          const j = k++;
          const box = r.locked ? c.gray("[■]") : checked[j] ? c.green("[✔]") : "[ ]";
          const label = j === i ? c.cyan(r.label) : r.label;
          return `   ${j === i ? c.cyan("❯") : " "} ${box} ${label}${r.hint ? c.gray("  " + r.hint) : ""}`;
        });
        const legend = options.some((o) => o.locked) ? " · [■] 필수(해제 불가)" : "";
        this.screen(`  ${c.bold(question)}\n${note ? note + "\n" : ""}\n${body.join("\n")}\n\n` +
          `${msg ? "  " + c.yellow(msg) + "\n" : ""}  ${c.gray(`↑↓ 이동 · Space 선택/해제 · Enter 확정${back ? " · Esc 이전" : ""}${legend}`)}`);
        msg = "";
        const { key } = await this.#key();
        if (key.name === "up" || key.name === "k") i = (i - 1 + options.length) % options.length;
        else if (key.name === "down" || key.name === "j" || key.name === "tab") i = (i + 1) % options.length;
        else if (key.name === "space") { if (options[i].locked) msg = `${options[i].label.trim()} 은(는) 필수 항목이라 해제할 수 없습니다`; else checked[i] = !checked[i]; }
        else if (key.name === "return" || key.name === "enter") return withLocked(options.filter((_, j) => checked[j]).map((o) => o.value));
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
    let pasting = false;
    const name = (ev) => ev.key.name ?? "";
    const printable = (ev) => Boolean(ev.str) && !ev.key.ctrl && !ev.key.meta && ev.str >= " " && !name(ev).startsWith("paste-");
    this.#raw(true);
    try {
      for (;;) {
        const shown = mask ? "•".repeat([...v].length) : v;
        this.screen(
          `  ${c.bold(question)}\n${hint ? "  " + c.gray(hint) + "\n" : ""}\n  ${c.cyan("❯")} ${shown}${c.inverse(" ")}\n` +
          `${err ? "\n  " + c.red("✖ " + err) + "\n" : "\n"}\n  ${c.gray(`Enter 확인 · Ctrl+U 지우기 · Ctrl+V/우클릭 붙여넣기${back ? " · Esc 이전" : ""}`)}`,
        );
        const ev = await this.#key();
        const { key } = ev;
        if (name(ev) === "paste-start") { pasting = true; continue; }
        if (name(ev) === "paste-end") { pasting = false; continue; }
        if (name(ev) === "return" || name(ev) === "enter") {
          // 붙여넣은 내용 안의 줄바꿈은 확정으로 보지 않는다 (붙여넣기 구간이거나, 바로 뒤에 글자가 이어서 들어온 경우)
          if (pasting || this.queue.length) continue;
          err = validate(v);
          if (!err) return v;
        } else if (back && name(ev) === "escape" && !pasting) return BACK;
        else if (name(ev) === "backspace") v = [...v].slice(0, -1).join("");
        else if (key.ctrl && name(ev) === "u") v = "";
        else if (key.ctrl && name(ev) === "v") { v += readClipboard(); err = null; } // Ctrl+V 가 그대로 들어오는 콘솔
        else if (printable(ev)) {
          v += ev.str;
          // 한꺼번에 들어온 글자(붙여넣기)는 화면을 다시 그리지 않고 모두 받는다
          while (this.queue.length) {
            const n = this.queue[0];
            if (name(n) === "paste-start") pasting = true;
            else if (name(n) === "paste-end") pasting = false;
            else if (printable(n)) v += n.str;
            else if (!(name(n) === "return" || name(n) === "enter") || !(pasting || this.queue.length > 1)) break;
            this.queue.shift();
          }
          err = null;
        }
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
      if (this.tty) this.out.write(`\r\x1b[2K  ${mark} ${label}${extra ? c.gray("  " + extra) : ""}`);
    };
    const timer = this.tty ? setInterval(() => draw(c.cyan(frames[k++ % frames.length])), 80) : null;
    if (!this.tty) this.print(`  … ${label}`);
    try {
      const r = await fn((t) => { extra = t; });
      if (timer) clearInterval(timer);
      extra = typeof r === "string" ? r : extra;
      if (this.tty) { draw(c.green("✔")); this.out.write("\n"); } else this.print(`  ✔ ${label}${extra ? "  " + extra : ""}`);
      return r;
    } catch (e) {
      if (timer) clearInterval(timer);
      extra = "";
      if (this.tty) { draw(c.red("✖")); this.out.write("\n"); } else this.print(`  ✖ ${label}`);
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

/** 클립보드 텍스트 (Windows). 줄바꿈과 제어 문자는 뺀다 */
function readClipboard() {
  if (process.platform !== "win32") return "";
  try {
    const t = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw"],
      { encoding: "utf8", windowsHide: true, timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    return t.replace(/[\r\n]+$/, "").replace(/[\r\n]+/g, "").replace(/[\x00-\x1f]/g, "");
  } catch { return ""; }
}

/** 터미널 표시 폭 기준으로 오른쪽을 공백으로 채운다 (한글·전각 문자는 2칸) */
export function padDisplay(s, width) {
  return s + " ".repeat(Math.max(0, width - displayWidth(s)));
}
