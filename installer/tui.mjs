// 의존성 없는 최소 TUI. 진짜 터미널(TTY)에서는 방향키 UI, 아니면(파이프, winpty 없는 mintty, TERM=dumb) 줄 단위 입력으로 동작한다.
// 화면 규칙(영역 순서 · 기준선 · 상태 기호 · 키 안내 · 문구)은 docs/tui-spec.md 를 따른다. 화면마다 다시 구현하지 않고 여기에 둔다.
//   영역: 프레임(3줄) → 헤더 → 맥락 → 목록 → 상세 → 메시지 → 푸터 → 빈 커서 줄
import { execFileSync } from "node:child_process";
import readline from "node:readline";

// ---------------------------------------------------------------- 색 (16색만)
// NO_COLOR · TERM=dumb · 출력이 TTY 아님이면 끈다. UI 인스턴스가 자기 output 기준으로 다시 정한다.
const wantsColor = (out) => !process.env.NO_COLOR && process.env.TERM !== "dumb" && Boolean(out?.isTTY);
let colorOn = wantsColor(process.stdout);
const sgr = (open, close) => (s) => (colorOn ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
export const c = {
  bold: sgr(1, 22), red: sgr(31, 39), green: sgr(32, 39), yellow: sgr(33, 39), cyan: sgr(36, 39), gray: sgr(90, 39),
};
/** 입력 칸의 커서 표시. NO_COLOR 는 색만 끄므로 반전은 유지한다 (TTY 에서만 쓰인다) */
const inverse = (s) => `\x1b[7m${s}\x1b[27m`;

export const BACK = Symbol("back");

/** 줄 입력 모드에서 입력이 끝났을 때 (회귀 테스트 입력 순서가 어긋난 경우 등) */
export class InputEnded extends Error {
  constructor(question) { super(`입력이 끝났습니다 (stdin EOF): ${question ?? ""}`); this.question = question ?? ""; }
}

// ---------------------------------------------------------------- 표시 폭 · 말줄임
export const stripAnsi = (s) => String(s ?? "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

/** 터미널 표시 폭 (한글·전각 문자는 2칸) */
export function displayWidth(s) {
  return [...stripAnsi(s)].reduce((n, ch) => n + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1), 0);
}

/** 표시 폭 기준으로 오른쪽을 공백으로 채운다 */
export function padDisplay(s, width) {
  return s + " ".repeat(Math.max(0, width - displayWidth(s)));
}

/** 설명문 끝 말줄임 (…, 1칸). 끝에서 8칸 안에 공백이 있으면 공백에서 자르고, 2칸 글자 중간은 자르지 않는다 */
export function truncate(s, w) {
  s = stripAnsi(s);
  if (w <= 0) return "";
  if (displayWidth(s) <= w) return s;
  let out = "";
  let n = 0;
  for (const ch of s) {
    const cw = displayWidth(ch);
    if (n + cw > w - 1) break;
    out += ch;
    n += cw;
  }
  const sp = out.lastIndexOf(" ");
  if (sp > 0 && displayWidth(out.slice(sp)) <= 8) out = out.slice(0, sp);
  return out.replace(/[\s·,]+$/, "") + "…";
}

/** Windows 경로 가운데 말줄임: 앞부분 + … + 마지막 두 단계 (그래도 길면 마지막 한 단계) */
export function truncatePath(p, w) {
  p = stripAnsi(p);
  if (displayWidth(p) <= w) return p;
  const sep = p.includes("\\") ? "\\" : "/";
  const parts = p.split(sep);
  for (const tail of [2, 1]) {
    for (let head = parts.length - tail - 1; head >= 1; head--) {
      const cand = [...parts.slice(0, head), "…", ...parts.slice(-tail)].join(sep);
      if (displayWidth(cand) <= w) return cand;
    }
  }
  return truncate(p, w);
}

/** 줄바꿈 (공백·\·/ 뒤에서 자른다. 그래도 길면 글자 경계). 위험 확인·요약처럼 자르면 안 되는 값에 쓴다 */
export function wrapText(s, w) {
  const tokens = stripAnsi(s).split(/(?<=[\\/ ])/);
  const lines = [];
  let cur = "";
  for (let t of tokens) {
    while (displayWidth(t) > w) {
      if (cur.trim()) { lines.push(cur.trimEnd()); cur = ""; }
      let head = "";
      for (const ch of t) { if (displayWidth(head + ch) > w) break; head += ch; }
      lines.push(head);
      t = t.slice(head.length);
    }
    if (cur && displayWidth(cur + t) > w) { lines.push(cur.trimEnd()); cur = t.trimStart(); } else cur += t;
  }
  if (cur.trim() || !lines.length) lines.push(cur.trimEnd());
  return lines;
}

/** 앞 들여쓰기를 유지한 채 줄바꿈 (색 코드가 있는 줄은 자르지 않는다) */
function wrapIndented(line, w) {
  if (displayWidth(line) <= w || /\x1b\[/.test(line)) return [line];
  const ind = line.match(/^ */)[0];
  return wrapText(line.slice(ind.length), Math.max(10, w - ind.length)).map((l) => ind + l);
}

/** 속성 이름 · 값 기준선(value rail). rows: [[이름, 값], ...] → 들여쓰기 2칸 + 이름 열 + 2칸 + 값 */
export function rail(rows, { indent = 2, width = 0, wrap = 0 } = {}) {
  const kw = width || Math.max(0, ...rows.filter(Boolean).map(([k]) => displayWidth(k)));
  const out = [];
  for (const r of rows.filter(Boolean)) {
    const [k, v] = r;
    const head = " ".repeat(indent) + c.gray(padDisplay(k, kw)) + "  ";
    const vals = wrap ? String(v).split("\n").flatMap((x) => (/\x1b\[/.test(x) ? [x] : wrapText(x, Math.max(10, wrap - indent - kw - 2)))) : String(v).split("\n");
    vals.forEach((x, i) => out.push((i ? " ".repeat(indent + kw + 2) : head) + x));
  }
  return out;
}

// ---------------------------------------------------------------- 오류 설명 (원인 · 해결)
/** 예외를 사람 말로: { cause, fix }. e.why / e.fix 를 붙여 던지면 그 문구를 쓴다 */
export function explainError(e) {
  if (e?.why) return { cause: e.why, fix: e.fix ?? "" };
  const code = String(e?.cause?.code ?? e?.code ?? "");
  const msg = String(e?.message ?? e);
  if (code === "ECONNREFUSED") return { cause: "서버가 연결을 거부했습니다 (ECONNREFUSED)", fix: "포트가 맞는지, vLLM 이 실행 중인지 확인하세요" };
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return { cause: `호스트 이름을 찾지 못했습니다 (${code})`, fix: "주소 철자와 사내 DNS 를 확인하세요" };
  if (e?.name === "TimeoutError" || code === "UND_ERR_CONNECT_TIMEOUT") return { cause: "6초 안에 응답이 없습니다", fix: "방화벽·프록시 설정을 확인하세요" };
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) return { cause: `서버 인증서를 신뢰하지 못했습니다 (${code})`, fix: "사내 CA 파일을 NODE_EXTRA_CA_CERTS 에 지정하고 다시 실행하세요" };
  const http = msg.match(/HTTP (\d{3})/);
  if (http && (http[1] === "401" || http[1] === "403")) return { cause: `API 키가 거부되었습니다 (HTTP ${http[1]})`, fix: "키를 다시 입력하세요" };
  if (http && http[1] === "404") return { cause: "/models 경로가 없습니다 (HTTP 404)", fix: "주소가 /v1 로 끝나는지 확인하세요" };
  if (code === "EBUSY" || code === "EPERM") {
    return { cause: `다른 프로그램이 파일을 쓰고 있습니다 (${code}${e.path ? " " + e.path : ""})`, fix: "실행 중인 oxy 창을 모두 닫고 install.cmd 를 다시 실행하세요. 복사한 부분은 두고 이어서 진행합니다" };
  }
  return { cause: msg, fix: e?.fix ?? "" };
}

/** 오류 블록: ✖ 제목 / 원인 / 해결 (해결이 마지막 줄. 빨강은 ✖ 만) */
export function errorBlock(title, e) {
  const { cause, fix } = e && typeof e === "object" && "cause" in e && "fix" in e && !(e instanceof Error) ? e : explainError(e);
  return [`  ${c.red("✖")} ${title}`, ...rail([["원인", cause], fix ? ["해결", fix] : null], { indent: 4, wrap: 78 })];
}

// ---------------------------------------------------------------- 용어 설명 (? 키)
export const GLOSSARY = {
  vLLM: "사내 GPU 서버에서 모델을 띄우는 서버 프로그램입니다. 이 하네스는 OpenAI 호환 주소(/v1)로 접속합니다.",
  "OpenAI 호환": "/v1/models, /v1/chat/completions 형식으로 요청을 받는 서버 규격입니다.",
  DPAPI: "Windows 가 현재 사용자 계정으로 암호화하는 기능입니다. 같은 PC 의 같은 사용자만 비밀번호를 풀 수 있습니다.",
  MCP: "pi 에 외부 도구를 붙이는 규격입니다. dbhub·graphin 이 MCP 서버로 붙습니다.",
  dbhub: "DB 를 pi 도구(execute_sql, search_objects)로 쓰게 해 주는 MCP 서버입니다.",
  usql: "여러 DB 를 하나의 명령으로 조회하는 CLI 입니다. 연결 이름으로 usql tdb 처럼 씁니다.",
  SQLcl: "Oracle 이 만든 Oracle 전용 CLI 입니다. Java 17 이상이 필요하고 오픈소스가 아닙니다.",
  compaction: "컨텍스트가 차면 pi 가 대화를 요약해 줄이는 동작입니다. oxy-flow 는 이를 작업 상태 요약으로 바꿉니다.",
  subagent: "pi 가 일을 나눠 맡기는 보조 에이전트입니다. 동시에 몇 개를 돌릴지가 vLLM 부하를 정합니다.",
  skill: "특정 도구를 쓰는 방법을 적은 안내서입니다. 해당 구성요소가 설치되어 있어야 의미가 있습니다.",
  extension: "pi 의 동작을 바꾸는 하네스 플러그인입니다 (위험 명령 차단 등).",
  thinking: "모델이 답하기 전에 추론 과정을 생성하는 모드입니다. 모델 계열마다 켜고 끄는 방식이 다릅니다.",
  max_model_len: "vLLM 이 그 모델에 허용하는 최대 토큰 수입니다. 컨텍스트 길이를 이 값 이하로 둡니다.",
  "Chrome for Testing": "Google 이 자동화용으로 배포하는 Chrome 빌드입니다. 버전이 고정되어 agent-browser 와 가장 잘 맞습니다.",
  sha256: "파일 지문입니다. manifest 에 적힌 값과 같으면 공식 배포 파일과 같은 파일입니다.",
  PATH: "명령 이름만으로 프로그램을 찾는 폴더 목록입니다. 등록하면 어느 터미널에서나 oxy 를 실행할 수 있습니다.",
  "Windows Terminal": "Windows Terminal 의 새 탭 종류(프로필)를 만듭니다. 하네스는 설정 파일을 고치지 않고 별도 fragment 파일을 만듭니다.",
  "rate limit": "서버가 분당 받는 토큰 수의 상한입니다. 넘으면 요청이 거부(HTTP 429)됩니다.",
  "사용량 제한": "서버가 분당 받는 토큰 수의 상한(rate limit)입니다. 넘으면 요청이 거부(HTTP 429)됩니다.",
};
const termsIn = (text) => Object.keys(GLOSSARY).filter((k) => text.includes(k));

// ---------------------------------------------------------------- banner (시작할 때 한 번, 넓은 창에서만)
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

function renderWord(text) {
  const rows = ["", "", "", "", ""];
  [...text].forEach((ch, i) => {
    const glyph = FONT[ch] ?? FONT[" "];
    for (let r = 0; r < 5; r++) rows[r] += (i ? " " : "") + glyph[r];
  });
  return rows;
}

export const SUBTITLE = "PI Based Coding Agent For Closed Network";

/** 큰 배너 (큰 글씨 한 줄 + 부제 + 버전). 폭 98 미만이면 빈 문자열 (두 줄 큰 글씨는 쓰지 않는다) */
export function banner(version, cols = process.stdout.columns || 100) {
  if (cols < 98) return "";
  const rows = renderWord("OXYGEN PI SYSTEM");
  const width = Math.max(...rows.map((r) => r.length));
  const ver = `v${version}`;
  return ["", ...rows.map((r) => "  " + c.cyan(c.bold(r))), "",
    "  " + SUBTITLE + " ".repeat(Math.max(2, width - SUBTITLE.length - ver.length)) + c.cyan(ver), ""].join("\n");
}

// ---------------------------------------------------------------- 단계 표시
/**
 * 진행 단계를 상자로 그린다. 지난 단계 ✔(초록) · 현재 단계 굵은 상자(청록) · 남은 단계(회색).
 * 폭이 모자라면 여러 줄로 나눈다. 프레임에서는 창이 높고(≥30) 한 줄에 들어갈 때만 쓴다.
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

// ---------------------------------------------------------------- 목록 행 도우미
/** 행 정규화. 레이블·설명의 색 코드는 지운다 (색은 상태 필드로 칠한다) */
function normRow(r) {
  if (r.header) return { ...r, header: stripAnsi(r.header), desc: stripAnsi(r.desc ?? "") };
  return { ...r, label: stripAnsi(r.label), hint: stripAnsi(r.hint ?? "") };
}
/** 레이블 + 상태 표시: 위험 `! ` · `(추천)` · `(현재)` */
function decorated(o) {
  return `${o.danger ? "! " : ""}${o.label}${o.recommended ? " (추천)" : ""}${o.current ? " (현재)" : ""}`;
}
function paintLabel(o, focused) {
  const base = o.disabled ? c.gray(o.label) : focused ? c.cyan(o.label) : o.danger ? c.yellow(o.label) : o.label;
  return `${o.danger ? c.yellow("! ") : ""}${base}${o.recommended ? " " + c.green("(추천)") : ""}${o.current ? " " + c.gray("(현재)") : ""}`;
}
/** 값 열 맨 앞의 상태 문구 (말줄임하지 않는다) */
const statusOf = (o) => (o.locked ? (o.status ?? "필수") : typeof o.disabled === "string" ? o.disabled : o.status ?? "");
const valueOf = (o) => [statusOf(o), o.hint].filter(Boolean).join(" · ");
/** 상세 줄: [[이름, 값]] 또는 문자열. 비활성 항목은 사용 불가 / 해결 */
function detailOf(o) {
  if (!o) return [];
  if (o.disabled) return [["사용 불가", o.why ?? (typeof o.disabled === "string" ? o.disabled : "지금은 고를 수 없습니다")], o.fix ? ["해결", o.fix] : null].filter(Boolean);
  return (o.detail ?? []).filter(Boolean);
}
function detailLines(entries, W) {
  const kv = entries.filter(Array.isArray);
  const kw = Math.max(0, ...kv.map(([k]) => displayWidth(k)));
  return entries.map((e) => (Array.isArray(e)
    ? `    ${c.gray(padDisplay(e[0], kw))}  ${truncate(e[1], W - 6 - kw)}`
    : `    ${truncate(e, W - 4)}`));
}
const toLines = (note) => (Array.isArray(note) ? note : String(note ?? "").split("\n")).map((l) => String(l)).filter((l, i, a) => !(l.trim() === "" && (i === 0 || i === a.length - 1)));

/** 처음 포커스: 지정값 → 권장 → 현재 값 → 첫 번째 선택 가능 항목 */
function startIndex(items, initial) {
  if (Number.isInteger(initial)) return Math.max(0, Math.min(items.length - 1, initial));
  for (const f of [(o) => o.recommended && !o.disabled, (o) => o.current && !o.disabled, (o) => !o.disabled]) {
    const k = items.findIndex(f);
    if (k >= 0) return k;
  }
  return 0;
}

// ---------------------------------------------------------------- UI
export class UI {
  /** input/output/tty 는 테스트에서 가짜 터미널을 넣을 때만 쓴다 */
  constructor({ input = process.stdin, output = process.stdout, tty, color } = {}) {
    this.in = input;
    this.out = output;
    this.tty = tty ?? Boolean(input.isTTY && output.isTTY && process.env.TERM !== "dumb");
    colorOn = color ?? (this.tty && wantsColor(output));
    this.version = "";
    this.frameSpec = {};
    this.lines = null;
    /** 받은 키 대기열. 붙여넣기는 keypress 가 한꺼번에 여러 개 오므로, 리스너를 하나만 상주시켜 하나도 잃지 않는다 */
    this.queue = [];
    this.waiter = null;
    /** 화면을 다시 그리기 전에 그 사이 출력(task·verify)을 스크롤백으로 밀어 올려야 하는가 */
    this.dirty = true;
    this.current = null;
    this.waitingFor = "";
    this.lastFrame = null;
    /** Ctrl+C 로 끝낼 때 알릴 한 줄 (반쯤 된 상태) */
    this.interruptNote = () => (this.current ? `중단했습니다. ${this.current.label} 을(를) 마치지 못했습니다.` : "중단했습니다. 아무것도 바꾸지 않았습니다.");
    if (input === process.stdin) process.on("SIGINT", () => this.abort());
  }

  get color() { return colorOn; }
  cols() { return this.out.columns || 80; }
  rows() { return this.out.rows || 24; }

  /** 프레임: { steps, longSteps, current, title } (설치 단계) 또는 { path } · right: 1행 오른쪽 (설치 폴더 · [sandbox]) */
  setFrame(spec = {}) { this.frameSpec = { right: this.frameSpec.right, ...spec }; }

  // ---- 공통 출력
  print(s = "") { this.out.write(s + "\n"); this.dirty = true; }

  /** 큰 배너. 프로그램 시작 때 한 번, 넓고 높은 창(또는 줄 입력 모드)에서만 */
  intro() {
    if (this.tty && (this.cols() < 98 || this.rows() < 24)) return;
    const b = banner(this.version, this.tty ? this.cols() : 100);
    if (b) this.print(b);
  }

  /** 자유 형식 화면 (진행 중 · 완료). body 는 들여쓰기된 줄들 */
  screen(body = "") {
    const lines = String(body).split("\n");
    if (!this.tty) { this.#lineFrame(); const t = lines.join("\n").replace(/^\n+/, ""); if (t.trim()) this.print(t); return; }
    this.#paint([...this.#frameLines(), "", ...lines]);
  }

  /** 알림 화면 + Enter 계속. kind: ok | warn | err */
  async notice(kind, msg, { fix = "", pause = "계속" } = {}) {
    const mark = kind === "err" ? c.red("✖") : kind === "ok" ? c.green("✔") : c.yellow("!");
    const [first, ...rest] = String(msg).split("\n");
    this.screen([`  ${mark} ${first}`, ...rest.map((l) => "    " + l), ...(fix ? rail([["해결", fix]], { indent: 4, wrap: this.cols() - 2 }) : [])].join("\n"));
    await this.pause(pause);
  }

  #frameText() {
    const f = this.frameSpec;
    if (f.steps) {
      const long = f.longSteps ?? f.steps;
      return f.current >= f.steps.length ? `${f.title ?? "설치"} 실행` : `${f.title ?? "설치"} ${f.current + 1}/${f.steps.length} ${long[f.current]}`;
    }
    return f.path ?? "";
  }
  #lineFrame() {
    const t = this.#frameText();
    if (!t || t === this.lastFrame) return;
    this.lastFrame = t;
    this.print(`── ${t} ${"─".repeat(Math.max(3, 74 - displayWidth(t)))}`);
  }
  #stepLine(cols) {
    const { steps, current } = this.frameSpec;
    const long = this.frameSpec.longSteps ?? steps;
    const N = steps.length;
    const W = cols - 2;
    const line = steps.map((n, i) => (i < current ? c.green("✔ " + n) : i === current ? c.cyan(c.bold("▶ " + n)) : c.gray(n))).join(c.gray(" › "));
    const lw = 2 + displayWidth(line);
    if (lw <= W) {
      const cnt = current < N ? `${current + 1}/${N}` : "";
      return cnt && lw + 2 + cnt.length <= W ? "  " + line + " ".repeat(W - lw - cnt.length) + c.gray(cnt) : "  " + line;
    }
    if (current >= N) return `  ${N}/${N} ${long[N - 1]} ${c.gray("· 실행")}`;
    return `  ${current + 1}/${N} ${c.bold(long[current])}${current + 1 < N ? c.gray(" · 다음: " + long[current + 1]) : ""}`;
  }
  #frameLines() {
    const cols = this.cols();
    const f = this.frameSpec;
    const W = cols - 2;
    const left = `  ${c.cyan(c.bold("OXYGEN PI SYSTEM"))}${this.version ? " v" + this.version : ""}`;
    let line1 = left;
    if (f.right) {
      const room = W - displayWidth(left) - 2;
      if (room >= 8) {
        const r = /[\\/]/.test(f.right) ? truncatePath(f.right, room) : truncate(f.right, room);
        line1 = left + " ".repeat(W - displayWidth(left) - displayWidth(r)) + c.gray(r);
      }
    }
    const out = [line1];
    if (f.steps) {
      const art = this.rows() >= 30 && cols >= 100 ? stepArt(f.steps, Math.min(f.current, f.steps.length), cols).split("\n") : null;
      if (art && art.length === 3) out.push(...art); else out.push(this.#stepLine(cols));
    } else out.push("  " + truncate(f.path ?? "", W - 2));
    out.push("  " + c.gray("─".repeat(Math.max(10, cols - 4))));
    return out;
  }

  /** 화면 전체를 다시 그린다. 스크롤백은 지우지 않는다 (커서를 맨 위로 옮기고 줄마다 지운다) */
  #paint(lines) {
    const pre = this.dirty ? "\n".repeat(this.rows()) : "";
    this.dirty = false;
    this.out.write(pre + "\x1b[H" + lines.map((l) => l + "\x1b[K").join("\n") + "\n\x1b[J");
  }

  /** 영역 배치 (§2.1): 프레임 · 빈 줄 · 헤더 · 맥락 · (빈 줄 · 목록) · 빈 줄 · 상세 · 메시지 · 푸터 */
  #compose({ header, context = [], list = [], detail = [], message = "", footer = "" }) {
    return [...this.#frameLines(), "", ...(header ? ["  " + c.bold(header)] : []), ...context.map((l) => "  " + l),
      ...(list.length ? ["", ...list] : []), "", ...detail, message ? "  " + message : "", "  " + footer];
  }
  #chromeHeight(ctx, detail) { return this.#frameLines().length + 1 + 1 + ctx + 1 + 1 + detail + 1 + 1 + 1; }

  /** 키 안내. 폭이 모자라면 번호 → ? 용어 → Ctrl+C 종료 → Esc 이전 순으로 뺀다 */
  #footer(parts) {
    let list = parts.filter(Boolean);
    const W = this.cols() - 4;
    for (const rank of [1, 2, 3, 4]) {
      if (displayWidth(list.map((p) => p[0]).join(" · ")) <= W) break;
      list = list.filter((p) => p[1] !== rank);
    }
    return c.gray(list.map((p) => p[0]).join(" · "));
  }

  // ---- 중단 (Ctrl+C) · 종료
  abort() {
    try { this.in.setRawMode?.(false); } catch { /* 이미 닫힘 */ }
    this.out.write(`${this.tty ? "\x1b[?2004l\x1b[?25h" : ""}\n${this.interruptNote()}\n`);
    process.exit(130);
  }

  /** main 을 실행하고 종료 코드로 끝낸다. 처리하지 못한 예외는 스택 대신 한 줄 (OXY_DEBUG=1 이면 스택) */
  async run(main) {
    let code = 1;
    try {
      code = await main();
    } catch (e) {
      if (e instanceof InputEnded) this.out.write(`\n입력이 끝나 중단했습니다 (줄 입력 모드). 기다리던 질문: ${e.question}\n`);
      else {
        this.out.write(`\n  ${c.red("✖")} 예기치 못한 오류: ${e?.message ?? e}\n`);
        if (process.env.OXY_DEBUG) this.out.write(`${e?.stack ?? e}\n`);
        else this.out.write("    자세한 내용: OXY_DEBUG=1 로 다시 실행\n");
      }
    } finally {
      this.close();
      if (this.tty) this.out.write("\x1b[?25h");
    }
    process.exit(code ?? 0);
  }

  // ---- TTY 키 입력
  #raw(on, { cursor = false } = {}) {
    if (!this.tty) return;
    if (on && !this.keysReady) {
      readline.emitKeypressEvents(this.in);
      this.in.on("keypress", (str, key = {}) => {
        if (key.ctrl && key.name === "c") { this.#raw(false); this.abort(); }
        this.#push({ str, key });
      });
      this.out.on?.("resize", () => this.#push({ str: "", key: { name: "resize" } }));
      this.keysReady = true;
    }
    if (on) this.queue.length = 0; // 이전 화면에서 남은 키는 버린다
    this.in.setRawMode?.(on);
    // bracketed paste: 붙여넣기 구간을 paste-start / paste-end 로 알려 준다 (Windows Terminal 등). 선택 화면에서는 커서를 숨긴다
    this.out.write(on ? `\x1b[?2004h${cursor ? "" : "\x1b[?25l"}` : "\x1b[?2004l\x1b[?25h");
    if (on) this.in.resume(); else this.in.pause();
  }
  #push(ev) {
    if (this.waiter) { const w = this.waiter; this.waiter = null; w(ev); } else this.queue.push(ev);
  }
  #key() {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    return new Promise((resolve) => { this.waiter = resolve; });
  }

  // ---- 줄 입력 (TTY 아님)
  async #line(prompt, { mask = false } = {}) {
    if (!this.lines) {
      this.rl = readline.createInterface({ input: this.in, terminal: false });
      this.lines = this.rl[Symbol.asyncIterator]();
    }
    this.out.write(prompt);
    const { value, done } = await this.lines.next();
    if (done) { this.out.write("\n"); throw new InputEnded(this.waitingFor); }
    // 입력을 되찍는 것은 로그에 답을 남기기 위함. 비밀값은 입력 여부만 남긴다
    this.out.write((mask ? (value ? "(입력됨)" : "") : value) + "\n");
    return value.trim();
  }

  /** 하나 고르기. options: [{label, value, hint, detail, disabled, why, fix, recommended, current, danger, status} | {header, desc}] */
  select(question, options, opts = {}) { return this.#choose(false, question, options, opts); }

  /**
   * 여러 개 고르기 → value[]. rows: [{label, value, checked, hint, locked, disabled, ...} | {header, desc}]
   * locked: 항상 선택된 상태로 고정 (해제 불가, 결과에 항상 포함) · disabled: 고를 수 없음 (이유 문구)
   */
  multiselect(question, rows, opts = {}) { return this.#choose(true, question, rows, opts); }

  async #choose(multi, question, rawRows, opts) {
    const { back = true, note = "", result = false, esc = "이전", message = "" } = opts;
    const rows = rawRows.map(normRow);
    const items = rows.filter((r) => !r.header);
    const checked = items.map((o) => !o.disabled && Boolean(o.checked || o.locked));
    const ctxAll = toLines(note);
    let focus = startIndex(items, opts.initial);
    const collect = () => (multi ? items.filter((o, j) => o.locked || (checked[j] && !o.disabled)).map((o) => o.value) : items[focus].value);
    const hasLocked = items.some((o) => o.locked);
    const hasDisabled = multi && items.some((o) => o.disabled);
    const legend = multi && (hasLocked || hasDisabled) ? c.gray([hasLocked && "[■] 필수", hasDisabled && "[·] 고를 수 없음"].filter(Boolean).join(" · ")) : "";
    const d = String(items.length).length;
    this.waitingFor = question;

    if (!this.tty) return this.#lineChoose({ multi, question, rows, items, checked, ctxAll, focus, back, esc, message, d, hasLocked, hasDisabled, collect });

    let msg = message;
    let explain = false;
    let scroll = 0;
    let digitBuf = "";
    let digitAt = 0;
    this.#raw(true);
    try {
      for (;;) {
        const cols = this.cols();
        const W = cols - 2;
        const prefixW = 4 + d + (multi ? 5 : 2);
        const plainLabels = items.map(decorated);
        let labelW = Math.min(24, Math.max(0, ...plainLabels.map(displayWidth)));
        const maxLabel = Math.max(0, ...plainLabels.map(displayWidth));
        if (maxLabel > 24 && W - prefixW - maxLabel - 2 >= 40) labelW = maxLabel;
        const fitsOneLine = items.every((o, j) => !valueOf(o) || prefixW + Math.max(labelW, displayWidth(plainLabels[j])) + 2 + displayWidth(valueOf(o)) <= W);
        const ctxW = ctxAll.flatMap((l) => wrapIndented(l, W - 2));
        const detailMax = Math.min(3, Math.max(0, ...items.map((o) => detailOf(o).length)));
        // 좁은 폭: ① 한 줄 → ② 설명을 둘째 줄로 → ③ 설명을 상세 첫 줄로 (§11.4)
        let mode = cols >= 80 || fitsOneLine ? 1 : 2;
        const headerCount = rows.length - items.length;
        let ctx = ctxW;
        const budgetFor = (cx, extra) => this.rows() - this.#chromeHeight(cx.length, Math.min(4, detailMax + extra));
        if (mode === 2 && items.length * 2 + headerCount > budgetFor(ctx, 0)) mode = 3;
        let budget = budgetFor(ctx, mode === 3 ? 1 : 0);
        const listLen = mode === 2 ? items.length * 2 + headerCount : rows.length;
        let folded = false;
        if (listLen > budget && !result && ctx.length > 1) {
          ctx = [truncate(stripAnsi(ctxAll.find((l) => l.trim()) ?? ""), W - 14) + c.gray(" (? 설명)")];
          folded = true;
          budget = budgetFor(ctx, mode === 3 ? 1 : 0);
        }

        // 행 그리기
        const lines = [];
        let k = 0;
        let focusLine = 0;
        let headerLine = -1;
        for (const r of rows) {
          if (r.header) {
            headerLine = lines.length;
            const head = " ".repeat(3 + d) + c.cyan(c.bold(r.header));
            const room = W - displayWidth(head) - 2;
            lines.push(head + (r.desc && room > 4 ? c.gray("  " + truncate(r.desc, room)) : ""));
            continue;
          }
          const j = k++;
          const o = r;
          const f = j === focus;
          if (f) focusLine = lines.length;
          const num = String(j + 1).padStart(d);
          const box = multi ? `${o.locked ? c.gray("[■]") : o.disabled ? c.gray("[·]") : checked[j] ? c.green("[✔]") : "[ ]"} ` : "";
          const head = `  ${f ? c.cyan("❯") : " "} ${f ? c.cyan(num) : num}${multi ? " " : "  "}${box}${paintLabel(o, f)}`;
          const lw = displayWidth(plainLabels[j]);
          const status = statusOf(o);
          if (mode === 1) {
            const v = valueOf(o);
            if (!v) { lines.push(head); continue; }
            const pad = Math.max(2, labelW - lw + 2);
            const room = W - prefixW - lw - pad;
            const hintRoom = status ? room - displayWidth(status) - 3 : room;
            const hint = o.hint && hintRoom > 3 ? truncate(o.hint, hintRoom) : "";
            lines.push(head + " ".repeat(pad) + c.gray([status, hint].filter(Boolean).join(" · ")));
          } else if (mode === 2) {
            lines.push(head + (status ? "  " + c.gray(status) : ""));
            lines.push(" ".repeat(prefixW) + c.gray(truncate(o.hint ?? "", W - prefixW)));
          } else lines.push(head + (status ? "  " + c.gray(status) : ""));
        }
        // 스크롤 창 (포커스한 행과 그 그룹 제목은 항상 보인다). 숨은 줄은 첫 줄·마지막 줄 자리에 개수로 표시
        let shown = lines;
        if (lines.length > budget) {
          const cap = Math.max(3, budget);
          const endOf = (s) => { let e = s + cap - (s > 0 ? 1 : 0); if (e < lines.length) e -= 1; return Math.min(e, lines.length); };
          const focusEnd = focusLine + (mode === 2 ? 1 : 0);
          let s = Math.min(scroll, lines.length - 1);
          if (focusLine < s) s = focusLine;
          while (focusEnd >= endOf(s) && s < focusLine) s++;
          const gh = headerLine >= 0 ? lastHeaderBefore(rows, focus, mode) : -1;
          if (gh >= 0 && gh < s && focusEnd < endOf(gh)) s = gh;
          scroll = s;
          const e = endOf(s);
          const ind = " ".repeat(3 + d);
          shown = [...(s > 0 ? [ind + c.gray(`↑ 위에 ${s}줄 더`)] : []), ...lines.slice(s, e), ...(e < lines.length ? [ind + c.gray(`↓ 아래에 ${lines.length - e}줄 더`)] : [])];
        }

        // 상세 · 용어 설명
        const fo = items[focus];
        const terms = termsIn(stripAnsi([question, ...ctxAll, fo?.label, fo?.hint].join(" ")));
        let detail;
        if (explain) {
          const ex = [...(folded ? ctxAll.map((l) => stripAnsi(l).trim()).filter(Boolean) : []), ...terms.map((t) => [t, GLOSSARY[t]])];
          detail = detailLines(ex.slice(0, Math.max(4, detailMax)), W);
        } else {
          detail = detailLines([...(mode === 3 && fo?.hint ? [["설명", fo.hint]] : []), ...detailOf(fo)].slice(0, 4), W);
        }
        const footer = this.#footer([
          ["↑↓ 이동", 0], ["번호", 1], multi && ["Space 선택/해제", 0], ["Enter 확정", 0],
          back && [`Esc ${esc}`, esc === "종료" ? 0 : 4], (terms.length || folded) && ["? 용어", 2], esc !== "종료" && ["Ctrl+C 종료", 3],
        ]);
        this.#paint(this.#compose({ header: question, context: ctx, list: shown, detail, message: msg || legend, footer }));
        msg = "";

        const { str, key } = await this.#key();
        const name = key.name ?? "";
        if (explain) { explain = false; continue; }
        const n = items.length;
        if (name === "up" || name === "k") focus = (focus - 1 + n) % n;
        else if (name === "down" || name === "j" || name === "tab") focus = (focus + 1) % n;
        else if (/^[0-9]$/.test(str ?? "") && !key.ctrl) {
          const now = Date.now();
          const two = digitBuf && now - digitAt < 600 ? Number(digitBuf + str) : NaN;
          if (two >= 1 && two <= n) { focus = two - 1; digitBuf = ""; }
          else { if (Number(str) >= 1 && Number(str) <= n) focus = Number(str) - 1; digitBuf = str; digitAt = now; }
        } else if (str === "?") explain = Boolean(terms.length || folded);
        else if (multi && name === "space") {
          const o = items[focus];
          if (o.locked) msg = c.yellow(`${o.label}은(는) 필수라 해제할 수 없습니다`);
          else if (o.disabled) msg = c.yellow(o.blocked ?? `${o.label}은(는) ${statusOf(o) || "사용 불가"} 상태라 고를 수 없습니다`);
          else checked[focus] = !checked[focus];
        } else if (name === "return" || name === "enter") {
          const o = items[focus];
          if (!multi && o.disabled) msg = c.yellow(o.blocked ?? `${o.label}은(는) 고를 수 없습니다: ${o.why ?? statusOf(o)}`);
          else return collect();
        } else if (back && name === "escape") return BACK;
      }
    } finally { this.#raw(false); }
  }

  async #lineChoose({ multi, question, rows, items, checked, ctxAll, focus, back, esc, message, d, hasLocked, hasDisabled, collect }) {
    this.#lineFrame();
    if (message) this.print(message);
    this.print(question);
    for (const l of ctxAll) lineWrap(l).forEach((x) => this.print(x));
    const hasHeaders = rows.some((r) => r.header);
    const ind = " ".repeat(hasHeaders ? 4 : 2);
    const labelW = Math.min(24, Math.max(0, ...items.map((o) => displayWidth(decorated(o)))));
    let k = 0;
    const listing = [];
    for (const r of rows) {
      if (r.header) { listing.push(`  ${r.header}${r.desc ? "  " + r.desc : ""}`); continue; }
      const j = k++;
      const box = multi ? `[${r.locked ? "■" : r.disabled ? "·" : checked[j] ? "✔" : " "}] ` : "";
      const v = valueOf(r);
      listing.push(`${ind}${String(j + 1).padStart(d)}) ${box}${v ? padDisplay(decorated(r), labelW) + "  — " + v : decorated(r)}`);
      if (r.danger) detailOf(r).forEach((e) => listing.push(`${ind}     ${Array.isArray(e) ? e.join("  ") : e}`));
    }
    listing.forEach((l) => this.print(l));
    if (multi && (hasLocked || hasDisabled)) this.print([hasLocked && "[■] 필수(항상 포함)", hasDisabled && "[·] 고를 수 없음"].filter(Boolean).join(" · "));
    const explainAll = () => {
      items.forEach((o, j) => { const dl = detailOf(o); if (dl.length) this.print(`  ${j + 1}) ${o.label}: ${dl.map((e) => (Array.isArray(e) ? e.join(" ") : e)).join(" / ")}`); });
      termsIn([question, ...ctxAll, ...items.map((o) => `${o.label} ${o.hint}`)].join(" ")).forEach((t) => this.print(`  ${t}: ${GLOSSARY[t]}`));
    };
    const bad = (s) => this.print(`  ✖ ${s}`);
    for (;;) {
      if (!multi) {
        const a = await this.#line(`번호 [${focus + 1}]${back ? ` · < ${esc}` : ""} · ? 설명: `);
        if (back && a === "<") return BACK;
        if (a === "?") { explainAll(); continue; }
        const n = a === "" ? focus + 1 : Number(a);
        if (!(Number.isInteger(n) && n >= 1 && n <= items.length)) { bad(`1~${items.length} 사이의 번호를 입력하세요`); continue; }
        const o = items[n - 1];
        if (o.disabled) { bad(`${n}번 ${o.label}은(는) 고를 수 없습니다: ${o.why ?? statusOf(o)}`); continue; }
        return o.value;
      }
      const a = await this.#line(`번호 (예: 2,4 · +6 -3 · 빈칸=표시된 대로${hasLocked ? " · -=필수만" : ""}${back ? ` · < ${esc}` : ""}): `);
      if (back && a === "<") return BACK;
      if (a === "?") { explainAll(); continue; }
      if (a === "") return collect();
      if (a === "-") { checked.fill(false); return collect(); }
      const toks = a.split(/[\s,]+/).filter(Boolean);
      const rel = toks.every((t) => /^[+-]\d+$/.test(t));
      const abs = toks.every((t) => /^\d+$/.test(t));
      if (!rel && !abs) { bad("숫자만(2,4) 또는 +숫자·-숫자(+6 -3) 중 한 가지로 입력하세요"); continue; }
      const nums = toks.map((t) => Math.abs(Number(t)));
      if (!nums.every((n) => Number.isInteger(n) && n >= 1 && n <= items.length)) { bad(`1~${items.length} 사이의 번호를 쉼표로 구분해 입력하세요`); continue; }
      const on = abs ? nums : toks.filter((t) => t[0] === "+").map((t) => Number(t.slice(1)));
      const off = abs ? [] : toks.filter((t) => t[0] === "-").map((t) => Number(t.slice(1)));
      const blocked = on.find((n) => items[n - 1].disabled);
      if (blocked) { bad(`${blocked}번 ${items[blocked - 1].label}은(는) 고를 수 없습니다: ${items[blocked - 1].why ?? statusOf(items[blocked - 1])}`); continue; }
      const lockedOff = off.find((n) => items[n - 1].locked);
      if (lockedOff) { bad(`${lockedOff}번 ${items[lockedOff - 1].label}은(는) 필수라 해제할 수 없습니다`); continue; }
      if (abs) checked.fill(false);
      on.forEach((n) => { checked[n - 1] = true; });
      off.forEach((n) => { checked[n - 1] = false; });
      return collect();
    }
  }

  /**
   * 문자열 입력. validate(v) → 오류 문자열(✖ 뒤에 붙는 문구) 또는 null
   * note(또는 hint): 맥락 영역 (형식 예시 `예: …`) · footer / prompt: 무거운 확인처럼 키 안내를 바꿀 때
   */
  async input(question, { initial = "", mask = false, validate = () => null, hint = "", note, back = true, footer, prompt } = {}) {
    const ctx = toLines(note ?? hint);
    this.waitingFor = question;
    if (!this.tty) {
      this.#lineFrame();
      this.print(question);
      ctx.forEach((l) => lineWrap(l).forEach((x) => this.print(x)));
      if (mask) wrapText("줄 입력 모드에서는 입력한 글자가 보일 수 있습니다. Windows Terminal 에서 실행하면 가려집니다.", 78).forEach((x) => this.print(c.gray(x)));
      for (;;) {
        const shown = mask && initial ? "저장됨" : initial;
        const p = prompt ?? `> ${shown ? `[${shown}] ` : ""}${back ? "· < 이전" : ""}`;
        const a = await this.#line(`${p.trimEnd()}${p.trim() === ">" ? " " : ": "}`, { mask });
        if (back && a === "<") return BACK;
        const v = a === "" ? initial : a;
        const err = validate(v);
        if (!err) return v;
        this.print(`  ✖ ${err}`);
      }
    }
    let v = initial;
    let err = null;
    let pasting = false;
    const name = (ev) => ev.key.name ?? "";
    const printable = (ev) => Boolean(ev.str) && !ev.key.ctrl && !ev.key.meta && ev.str >= " " && !name(ev).startsWith("paste-");
    this.#raw(true, { cursor: true });
    let height = 0;
    try {
      for (;;) {
        const W = this.cols() - 2;
        let shown = mask ? "•".repeat([...v].length) : v;
        if (displayWidth(shown) > W - 6) { let t = ""; for (const ch of [...shown].reverse()) { if (displayWidth(t) + displayWidth(ch) > W - 7) break; t = ch + t; } shown = "…" + t; }
        // 입력 칸에서는 ? 가 글자로 들어가므로(URL 등) 용어 설명 키를 두지 않는다
        const foot = footer ?? this.#footer([["Enter 확정", 0], ["Ctrl+U 지우기", 0], ["Ctrl+V·우클릭 붙여넣기", 3], back && ["Esc 이전", 4]]);
        const lines = this.#compose({
          header: question, context: ctx.flatMap((l) => wrapIndented(l, W - 2)),
          list: [`  ${c.cyan("❯")} ${shown}${inverse(" ")}`], message: err ? c.red("✖ " + err) : "", footer: typeof foot === "string" && footer ? c.gray(footer) : foot,
        });
        this.#paint(lines);
        height = lines.length;
        // 실제 커서를 입력 칸 끝에 둔다
        const row = lines.findIndex((l) => l.includes("❯")) + 1;
        this.out.write(`\x1b[${row};${5 + displayWidth(shown)}H\x1b[?25h`);
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
    } finally {
      this.out.write(`\x1b[${height + 1};1H`);
      this.#raw(false);
    }
  }

  /**
   * 확인 (2지선다, 1 = 진행 · 2 = 안 함 고정). yes/no 레이블은 필수 (예/아니요 금지).
   * level: light(초기 포커스 1) | medium | heavy (초기 포커스 2 = 안 함, 진행 레이블에 ! 표시)
   */
  async confirm(question, { yes, no, initial, level = "light", danger, note = "", detail = {}, back = false, recommended = false } = {}) {
    if (!yes || !no) throw new Error("confirm: yes/no 레이블이 필요합니다 (예/아니요 단독 레이블 금지)");
    const def = initial ?? level === "light";
    const v = await this.select(question, [
      { label: yes, value: true, danger: danger ?? level !== "light", recommended, detail: detail.yes },
      { label: no, value: false, detail: detail.no },
    ], { initial: def ? 0 : 1, back, note, result: true });
    return v === BACK ? BACK : v === true;
  }

  /** 무거운 확인: 정해진 단어(폴더 이름)를 입력해야 진행. Esc · < → false */
  async confirmTyped(question, { word, note = "" } = {}) {
    const v = await this.input(question, {
      note, back: true,
      validate: (s) => (s === word ? null : "폴더 이름과 다릅니다. 그만두려면 Esc 를 누르세요"),
      footer: "Enter 삭제 · Ctrl+U 지우기 · Esc 취소",
      prompt: `> 확인하려면 ${word} 입력 · < 취소`,
    });
    return v !== BACK && v === word;
  }

  /**
   * 진행 표시와 함께 작업 실행. 시작하자마자(fn 을 부르기 전) 레이블을 그린다.
   * fn(update): update(text, pct) 로 진행 문구 변경 (pct 를 주면 TTY 아님에서 25% 마다 한 줄)
   * 실패하면 오류 블록(원인 · 해결)을 출력하고 다시 던진다 (e.reported = true)
   */
  async task(label, fn, { target = "" } = {}) {
    const frames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
    let k = 0;
    let extra = "";
    let lastStep = 0;
    this.current = { label, extra: "" };
    const draw = (mark) => {
      const head = `  ${mark} ${label}`;
      const room = this.cols() - 1 - displayWidth(head);
      const tail = [target, extra].filter(Boolean).join("  ");
      const t = tail && room > 6 ? "  " + (target && !extra ? truncatePath(tail, room - 2) : truncate(tail, room - 2)) : "";
      this.out.write(`\r\x1b[2K${head}${c.gray(t)}`);
    };
    this.dirty = true;
    if (this.tty) draw(c.cyan(frames[0])); else this.print(`  … ${label}${target ? "  " + target : ""}`);
    const timer = this.tty ? setInterval(() => draw(c.cyan(frames[++k % frames.length])), 80) : null;
    const update = (t, pct) => {
      extra = t;
      this.current.extra = t;
      if (!this.tty && pct != null && pct >= lastStep + 25 && pct < 100) { lastStep = Math.floor(pct / 25) * 25; this.print(`  … ${label}  ${t}`); }
    };
    try {
      const r = await fn(update);
      if (timer) clearInterval(timer);
      extra = typeof r === "string" ? r : extra;
      if (this.tty) { draw(c.green("✔")); this.out.write("\n"); } else this.print(`  ✔ ${label}${extra ? "  " + extra : ""}`);
      return r;
    } catch (e) {
      if (timer) clearInterval(timer);
      const stopped = e?.stoppedAt ?? "";
      extra = stopped;
      if (this.tty) { draw(c.red("✖")); this.out.write("\n"); } else this.print(`  ✖ ${label}${stopped ? "  " + stopped : ""}`);
      const { cause, fix } = explainError(e);
      rail([["원인", cause], fix ? ["해결", fix] : null], { indent: 4, wrap: this.cols() - 2 }).forEach((l) => this.print(l));
      if (e && typeof e === "object") e.reported = true;
      throw e;
    } finally { this.current = null; }
  }

  /** Enter 계속 / Enter 종료 */
  async pause(what = "계속") {
    if (!this.tty) { try { await this.#line(`Enter ${what}: `); } catch { /* EOF 는 계속 */ } return; }
    this.print("\n  " + c.gray(`Enter ${what}`));
    this.#raw(true);
    try { for (;;) { const { key } = await this.#key(); if (key.name === "return" || key.name === "enter") return; } }
    finally { this.#raw(false); }
  }

  close() { this.rl?.close(); }
}

/** 스크롤 창에서 포커스한 행의 그룹 제목 줄 번호 */
function lastHeaderBefore(rows, focus, mode) {
  let line = 0;
  let k = 0;
  let head = -1;
  for (const r of rows) {
    if (r.header) { head = line; line++; continue; }
    if (k === focus) return head;
    k++;
    line += mode === 2 ? 2 : 1;
  }
  return head;
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

/** 줄 입력 모드의 맥락 줄: 들여쓰지 않은 문장만 78칸에서 줄바꿈한다 (속성·결과 줄은 로그 검색을 위해 자르지 않는다) */
function lineWrap(l) {
  return /^\s/.test(stripAnsi(l)) ? [l] : wrapIndented(l, 78);
}
