// 설치 TUI · Tweak 공용 입력(UI). 화면을 직접 그리지 않는다. 두 가지 방식으로 동작한다:
//   원격 모드   진짜 터미널(TTY)이고 bin/oxy-tui.exe 가 있을 때. 화면과 키 입력은 exe(Ratatui, installer/oxy-tui)가 맡고,
//               여기서는 "이 목록을 보여 줘" 식의 지시를 이름 있는 파이프로 보낸 뒤 결과를 받는다 (규약: installer/oxy-tui/src/protocol.rs)
//   줄 입력 모드 그 밖의 경우(파이프 입력, TERM=dumb, exe 없음, OXY_TUI=line). 번호를 입력받는다. 회귀 테스트가 이 모드로 돈다
// 두 모드에서 같은 결정을 모두 내릴 수 있다. 문구 규칙은 docs/tui-spec.md.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------- 색 (줄 입력 모드에서만. 16색)
// NO_COLOR · TERM=dumb · 출력이 TTY 아님이면 끈다. 원격 모드에서는 색을 exe 가 정하므로 여기서는 끈다.
const wantsColor = (out) => !process.env.NO_COLOR && process.env.TERM !== "dumb" && Boolean(out?.isTTY);
let colorOn = wantsColor(process.stdout);
const sgr = (open, close) => (s) => (colorOn ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
export const c = {
  bold: sgr(1, 22), red: sgr(31, 39), green: sgr(32, 39), yellow: sgr(33, 39), cyan: sgr(36, 39), gray: sgr(90, 39),
};

/** 상태 기호. mintty 와 Windows Terminal 양쪽에서 1칸으로 그려지는 글자만 쓴다 (✔ ✖ 는 그림 글자로 그려져 옆 글자를 덮는다) */
export const SYM = { ok: "✓", err: "×", warn: "!", busy: "…" };

export const BACK = Symbol("back");
const DEBUG_HINT = "자세한 내용을 보려면 OXY_DEBUG=1로 다시 실행하세요.";

/** 줄 입력 모드에서 입력이 끝났을 때 (회귀 테스트 입력 순서가 어긋난 경우 등) */
export class InputEnded extends Error {
  constructor(question) { super(`입력이 끝났습니다 (stdin EOF): ${question ?? ""}`); this.question = question ?? ""; }
}

// ---------------------------------------------------------------- 표시 폭 · 말줄임
export const stripAnsi = (s) => String(s ?? "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
/** exe 로 보낼 글: 색 코드를 떼고, 호출부에 남아 있는 옛 기호를 지금 기호로 바꾼다 */
const plain = (s) => stripAnsi(s).replaceAll("✔", SYM.ok).replaceAll("✖", SYM.err);

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

/** 이름 · 값 요약표. rows: [[이름, 값], ...] → 들여쓰기 2칸 + 이름 열 + 2칸 + 값. 여러 값을 한눈에 보일 때만 쓴다 */
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

// ---------------------------------------------------------------- 오류 설명 (원인 · 해결 방법)
/** 예외를 사람 말로: { cause, fix }. e.why / e.fix 를 붙여 던지면 그 문구를 쓴다 */
export function explainError(e) {
  if (e?.why) return { cause: e.why, fix: e.fix ?? "" };
  const code = String(e?.cause?.code ?? e?.code ?? "");
  const msg = String(e?.message ?? e);
  if (code === "ECONNREFUSED") return { cause: "서버가 연결을 거부했습니다 (ECONNREFUSED)", fix: "포트가 맞는지, vLLM이 실행 중인지 확인하세요" };
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return { cause: `호스트를 찾을 수 없습니다 (${code})`, fix: "주소와 사내 DNS 설정을 확인하세요" };
  if (e?.name === "TimeoutError" || code === "UND_ERR_CONNECT_TIMEOUT") return { cause: "응답 시간이 초과되었습니다 (6초)", fix: "방화벽·프록시 설정을 확인하세요" };
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) return { cause: `서버 인증서를 신뢰할 수 없습니다 (${code})`, fix: "사내 CA 파일을 NODE_EXTRA_CA_CERTS에 지정하고 다시 실행하세요" };
  const http = msg.match(/HTTP (\d{3})/);
  if (http && (http[1] === "401" || http[1] === "403")) return { cause: `API 키가 올바르지 않습니다 (HTTP ${http[1]})`, fix: "키를 다시 입력하세요" };
  if (http && http[1] === "404") return { cause: "/models 경로를 찾을 수 없습니다 (HTTP 404)", fix: "주소가 /v1로 끝나는지 확인하세요" };
  if (code === "EBUSY" || code === "EPERM") {
    return { cause: `다른 프로그램이 파일을 사용 중입니다 (${code}${e.path ? " " + e.path : ""})`, fix: "실행 중인 oxy 창을 모두 닫고 install.cmd를 다시 실행하세요. 복사된 파일은 그대로 두고 이어서 설치합니다" };
  }
  return { cause: msg, fix: e?.fix ?? "" };
}

/** 오류 블록: × 제목 / 원인 / 해결 방법 (해결 방법이 마지막 줄. 빨강은 × 만) */
export function errorBlock(title, e) {
  const { cause, fix } = e && typeof e === "object" && "cause" in e && "fix" in e && !(e instanceof Error) ? e : explainError(e);
  return [`  ${c.red(SYM.err)} ${title}`, ...rail([["원인", cause], fix ? ["해결 방법", fix] : null], { indent: 4, wrap: 78 })];
}

// ---------------------------------------------------------------- 용어 설명 (줄 입력 모드의 ? 설명)
export const GLOSSARY = {
  vLLM: "사내 GPU 서버에서 모델을 실행하는 서버 프로그램입니다. OpenAI 호환 주소(/v1)로 접속합니다.",
  "OpenAI 호환": "/v1/models, /v1/chat/completions 형식으로 요청을 받는 서버 규격입니다.",
  DPAPI: "Windows가 현재 사용자 계정으로 암호화하는 기능입니다. 같은 PC의 같은 사용자만 비밀번호를 풀 수 있습니다.",
  MCP: "pi에 외부 도구를 연결하는 규격입니다. dbhub와 graphin이 MCP 서버로 연결됩니다.",
  dbhub: "에이전트가 pi 도구(execute_sql, search_objects)로 DB를 조회하게 해 주는 MCP 서버입니다.",
  usql: "여러 DB를 하나의 명령으로 조회하는 CLI입니다. 연결 이름을 붙여 usql tdb처럼 실행합니다.",
  SQLcl: "Oracle이 만든 Oracle 전용 CLI입니다. Java 17 이상이 필요하며 오픈소스가 아닙니다.",
  compaction: "컨텍스트가 차면 pi가 대화를 요약해 줄이는 동작입니다.",
  subagent: "pi가 작업을 나눠 맡기는 보조 에이전트입니다. 동시 실행 수가 LLM 서버 부하에 영향을 줍니다.",
  스킬: "특정 도구를 사용하는 방법을 에이전트에게 알려 주는 안내서(skill)입니다. 해당 구성요소가 설치되어 있어야 합니다.",
  "확장 기능": "pi의 동작을 바꾸는 플러그인(extension)입니다. 위험 명령 차단 등이 있습니다.",
  thinking: "모델이 답하기 전에 추론 과정을 생성하는 모드입니다. 모델 계열마다 켜고 끄는 방식이 다릅니다.",
  max_model_len: "vLLM이 그 모델에 허용하는 최대 토큰 수입니다. 컨텍스트 길이는 이 값 이하로 설정합니다.",
  "Chrome for Testing": "Google이 자동화용으로 배포하는 Chrome 빌드입니다. 버전이 고정되어 있어 agent-browser와 가장 잘 맞습니다.",
  sha256: "파일의 체크섬입니다. manifest에 기록된 값과 같으면 공식 배포 파일과 같은 파일입니다.",
  PATH: "명령 이름만으로 프로그램을 찾는 폴더 목록입니다. 추가하면 어느 터미널에서나 oxy를 실행할 수 있습니다.",
  "Windows Terminal": "Windows Terminal의 새 탭 목록에 프로필을 추가합니다. 설정 파일은 수정하지 않고 별도 파일을 만듭니다.",
  "사용량 제한": "서버가 분당 받는 토큰 수의 제한(rate limit)입니다. 넘으면 요청이 거부됩니다 (HTTP 429).",
};
const termsIn = (text) => Object.keys(GLOSSARY).filter((k) => text.includes(k));

/** 줄 입력 모드에서 시작할 때 한 번 찍는 머리말 (원격 모드의 배너는 exe 가 모든 화면 위에 그린다) */
export function banner(version) {
  return `\nOXYGEN PI SYSTEM${version ? ` v${version}` : ""}`;
}

// ---------------------------------------------------------------- 목록 행 도우미
/** 행 정규화. 레이블·설명의 색 코드는 지운다 */
function normRow(r) {
  if (r.header) return r;
  return { ...r, label: stripAnsi(r.label), hint: stripAnsi(r.hint ?? "") };
}
/** 레이블 + 상태 표시: 위험 `! ` · `(추천)` · `(현재)` */
function decorated(o) {
  return `${o.danger ? "! " : ""}${o.label}${o.recommended ? " (추천)" : ""}${o.current ? " (현재)" : ""}`;
}
/** 값 열 맨 앞의 상태 문구 */
const statusOf = (o) => (o.locked ? (o.status ?? "필수") : typeof o.disabled === "string" ? o.disabled : o.status ?? "");
const valueOf = (o) => [statusOf(o), o.hint].filter(Boolean).join(" · ");
/** 속성명 달린 예전 상세([[이름, 값]])에서 문장 앞에 남겨야 뜻이 통하는 이름 */
const LEGACY_LEAD = { 끄면: "끄면 ", 나중에: "나중에 " };
/**
 * 설명 문장들 (포커스한 항목을 선택하면 무엇을 하는가). detail: 문자열 | 문자열 배열 | 예전 형식 [[이름, 값]] (값만 문장으로 보인다)
 * 선택할 수 없는 항목은 이유 한 문장 + 할 일 한 문장. `! ` 로 시작하는 문장은 위험한 결과다
 */
function descOf(o) {
  if (!o) return [];
  if (o.disabled) return [o.why ?? (typeof o.disabled === "string" ? o.disabled : "지금은 선택할 수 없습니다"), o.fix].filter(Boolean).map(plain);
  const d = o.detail == null ? [] : Array.isArray(o.detail) ? o.detail : [o.detail];
  return d.filter(Boolean).map((e) => plain(Array.isArray(e) ? (LEGACY_LEAD[e[0]] ?? "") + e[1] : String(e)));
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

// ---------------------------------------------------------------- exe 와의 연결 (원격 모드)
const EXE = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "oxy-tui.exe");
const RESTORE = "\x1b[?25h\x1b[?1049l";

/**
 * oxy-tui.exe 를 실행하고 파이프로 지시를 보낸다. exe 는 같은 이름에 두 번 접속한다 (지시용 · 결과용).
 * 지시용 연결이 붙기 전에 보낸 지시는 모아 두었다가 순서대로 보낸다.
 */
class ExeLink {
  constructor(exe, onMessage) {
    this.onMessage = onMessage;
    this.commands = null;
    this.backlog = [];
    this.child = null;
    this.exited = new Promise((resolve) => { this.onExit = resolve; });
    const name = `oxy-tui-${process.pid}-${randomBytes(4).toString("hex")}`;
    this.server = net.createServer((sock) => {
      let buf = "";
      sock.setEncoding("utf8");
      sock.on("data", (d) => {
        buf += d;
        for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          let m;
          try { m = JSON.parse(line); } catch { continue; }
          if (m.hello === "commands") { this.commands = sock; for (const l of this.backlog.splice(0)) sock.write(l); }
          else if (!m.hello) this.onMessage(m);
        }
      });
      sock.on("error", () => { /* exe 가 끝나며 끊긴다 */ });
    });
    this.server.listen(`\\\\.\\pipe\\${name}`, () => {
      this.child = spawn(exe, ["--pipe", name], { stdio: "inherit", windowsHide: false });
      this.child.on("exit", (code) => { this.server.close(); this.onExit(code); });
      this.child.on("error", () => { this.server.close(); this.onExit(1); });
    });
  }
  send(m) {
    const line = JSON.stringify(m) + "\n";
    if (this.commands) this.commands.write(line); else this.backlog.push(line);
  }
  get alive() { return Boolean(this.child) && this.child.exitCode === null; }
  /** Node 가 quit 을 보내지 못하고 끝날 때: exe 를 끝내고 터미널을 직접 되돌린다 (Node 가 죽으면 exe 는 복구할 틈 없이 함께 죽을 수 있다) */
  killAndRestore(out) {
    if (!this.alive) return;
    try { this.child.kill(); } catch { /* 이미 끝남 */ }
    try { out.write(RESTORE); } catch { /* 닫힘 */ }
    // exe 가 지우지 못한 표식 파일 (install.cmd · tweak.cmd 가 이 파일이 남아 있으면 터미널을 한 번 더 되돌린다)
    try { if (process.env.OXY_TUI_MARK) rmSync(process.env.OXY_TUI_MARK, { force: true }); } catch { /* 없음 */ }
    try { process.stdin.setRawMode(true); process.stdin.setRawMode(false); } catch { /* TTY 아님 */ }
  }
}

// ---------------------------------------------------------------- UI
export class UI {
  /**
   * input/output/tty/remote/exe 는 테스트에서만 넣는다.
   * remote: 가짜 연결 { send(지시), onMessage(결과를 넣어 주는 함수가 여기에 꽂힌다) } — exe 없이 원격 모드를 테스트한다
   */
  constructor({ input = process.stdin, output = process.stdout, tty, remote, exe = EXE } = {}) {
    this.in = input;
    this.out = output;
    this.tty = tty ?? Boolean(input.isTTY && output.isTTY && process.env.TERM !== "dumb");
    const forcedLine = process.env.OXY_TUI === "line";
    /** "remote" | "line" */
    this.mode = remote ? "remote" : this.tty && !forcedLine && existsSync(exe) ? "remote" : "line";
    /** TTY 인데 exe 가 없어서 줄 입력 모드가 된 경우 한 번 알린다 */
    this.fallbackNote = this.tty && this.mode === "line" && !forcedLine ? "화면 프로그램(bin\\oxy-tui.exe)이 없어 줄 입력 모드로 진행합니다. 번호를 입력하세요." : "";
    colorOn = this.mode === "line" && wantsColor(output);
    this.exe = exe;
    this.link = remote ?? null;
    if (remote) remote.onMessage = (m) => this.#receive(m);
    this.seq = 0;
    this.waiters = new Map();
    this.version = "";
    this.frameSpec = {};
    this.sentFrame = "";
    this.lines = null;
    /** 진행 화면 (screen · task · print 가 함께 쓴다): { title, lines, items } */
    this.work = null;
    this.workTimer = null;
    this.current = null;
    this.waitingFor = "";
    this.lastFrame = null;
    /** 끝낼 때 본 화면에 남길 줄들 (원격 모드. 비워 두면 마지막 진행 화면의 내용을 남긴다) */
    this.summary = [];
    this.ended = false;
    /** Enter 의 뜻 기본값 (키 안내). 설치 단계 흐름에서는 "다음". 비워 두면 목록은 선택 · 여러 개 선택과 입력은 확인 */
    this.enterLabel = null;
    /** Ctrl+C 로 끝낼 때 알릴 한 줄 (반쯤 된 상태) */
    this.interruptNote = () => (this.current ? `중단되었습니다. 완료하지 못한 작업: ${this.current.label}` : "중단되었습니다. 변경된 내용은 없습니다.");
    if (input === process.stdin) {
      process.on("SIGINT", () => this.abort());
      process.on("exit", () => { if (this.link instanceof ExeLink) this.link.killAndRestore(this.out); });
      // 처리하지 못한 예외: 터미널을 먼저 되돌린 뒤에 알린다 (대체 화면에 찍힌 오류는 화면과 함께 사라진다)
      process.on("uncaughtException", (e) => {
        if (this.link instanceof ExeLink) this.link.killAndRestore(this.out);
        this.out.write(`\n  ${SYM.err} 예기치 않은 오류가 발생했습니다: ${e?.message ?? e}\n${process.env.OXY_DEBUG ? String(e?.stack ?? e) : `    ${DEBUG_HINT}`}\n`);
        process.exit(1);
      });
    }
  }

  get color() { return colorOn; }
  cols() { return this.out.columns || 80; }
  /** 미리 줄바꿈해서 보내는 줄(원인 · 해결 방법)의 폭. 원격 모드에서는 넓은 창의 본문 블록(단계 목록 패널 옆)에도 들어가게 76칸까지 */
  #wrapWidth() { return this.mode === "remote" ? Math.min(this.cols() - 2, 76) : this.cols() - 2; }
  rows() { return this.out.rows || 24; }

  /**
   * 프레임: { steps, longSteps, current, title } (설치 단계) 또는 { path: ["설정", "LLM 연결"] } · right: 위치 줄 오른쪽 (설치 폴더)
   * 단계를 모두 지난 뒤(current = steps.length)에는 stage(`설치 중` · `설치 완료`)와 finished 를 함께 준다
   */
  setFrame(spec = {}) { this.frameSpec = { right: this.frameSpec.right, ...spec }; }

  // ---- 원격 모드: 지시 보내기 · 결과 받기
  #send(m) {
    if (!this.link) {
      this.link = new ExeLink(this.exe, (msg) => this.#receive(msg));
      // exe 가 먼저 끝나 버리면(비정상 종료) 답을 영영 기다리게 되므로 여기서 끝낸다
      this.link.exited.then((code) => {
        if (this.ended) return;
        this.out.write(`\n화면 프로그램(oxy-tui.exe)이 예기치 않게 종료되었습니다 (종료 코드 ${code}). OXY_TUI=line으로 다시 실행하면 줄 입력 모드로 진행합니다.\n`);
        process.exit(1);
      });
    }
    this.link.send(m);
  }
  /** 위치가 바뀌었으면 화면 지시 앞에 frame 을 보낸다 */
  #frame() {
    const f = this.frameSpec;
    // short: 단계의 짧은 이름 (배너 오른쪽처럼 좁은 자리에 쓴다)
    // stage · finished: 단계를 모두 지난 뒤의 상태 (`설치 중` · `설치 완료`)
    const m = { op: "frame", version: this.version, title: f.title ?? "", steps: f.steps ? (f.longSteps ?? f.steps) : [], short: f.steps ?? [], current: f.current ?? 0,
      stage: f.stage ?? "", finished: Boolean(f.finished), path: f.steps ? [] : this.#locParts(), right: plain(f.right ?? "") };
    const key = JSON.stringify(m);
    if (key !== this.sentFrame) { this.sentFrame = key; this.#send(m); }
  }
  /** 답이 오는 지시. id 를 주면 그 id 로 다시 기다린다 (입력 검증 실패 뒤의 다시 입력) */
  #ask(m, id = ++this.seq) {
    return new Promise((resolve) => { this.waiters.set(id, resolve); this.#send({ ...m, id }); });
  }
  #receive(m) {
    if (m.event === "interrupt") return this.abort();
    if (m.id != null) { const w = this.waiters.get(m.id); this.waiters.delete(m.id); w?.(m); }
  }
  /** 답을 받는 화면을 보이기 전: 진행 화면을 닫고 위치를 맞춘다 */
  #prompt() {
    this.#flushWork();
    this.work = null;
    this.#frame();
  }

  // ---- 진행 화면 (원격 모드)
  #sendWork() {
    if (!this.work) return;
    const run = this.work.items.find((t) => t.state === "run" && t.percent != null);
    this.#frame();
    this.#send({ op: "task", title: this.work.title, lines: this.work.lines, percent: run ? Math.round(run.percent) : -1,
      items: this.work.items.map((t) => ({ label: plain(t.label), state: t.state, extra: plain([t.target, t.extra].filter(Boolean).join("  ")) })) });
  }
  /** 진행률은 자주 바뀌므로 100ms 에 한 번만 보낸다 */
  #touchWork() {
    this.workTimer ??= setTimeout(() => { this.workTimer = null; this.#sendWork(); }, 100);
  }
  #flushWork() {
    if (!this.workTimer) return;
    clearTimeout(this.workTimer);
    this.workTimer = null;
    this.#sendWork();
  }

  // ---- 공통 출력
  /** 한 줄 출력. 원격 모드에서는 진행 화면의 작업 목록 아래에 쌓인다 */
  print(s = "") {
    if (this.mode === "line") { this.#note(); this.out.write(s + "\n"); return; }
    this.work ??= { title: "", lines: [], items: [] };
    for (const l of plain(s).split("\n")) this.work.items.push({ state: "text", label: l.replace(/^ {2}/, "") });
    this.#sendWork();
  }
  #note() {
    if (!this.fallbackNote) return;
    const n = this.fallbackNote;
    this.fallbackNote = "";
    this.out.write(n + "\n");
  }

  /** 줄 입력 모드에서 시작할 때 한 번 찍는 머리말 */
  intro() {
    if (this.mode === "line") this.print(banner(this.version));
  }

  /** 진행 화면 (진행 중 · 완료). body 의 첫 줄이 제목이다. 이어지는 task · print 가 그 아래에 쌓인다 */
  screen(body = "") {
    const lines = String(body).replace(/\n+$/, "").split("\n");
    if (this.mode === "line") { this.#lineFrame(); const t = lines.join("\n").replace(/^\n+/, ""); if (t.trim()) { this.print(""); this.print(t); } return; }
    const text = lines.map(plain);
    while (text.length && !text[0].trim()) text.shift();
    this.work = { title: (text.shift() ?? "").trim(), lines: text.map((l) => l.replace(/^ {2}/, "")), items: [] };
    while (this.work.lines.length && !this.work.lines.at(-1).trim()) this.work.lines.pop();
    this.#sendWork();
  }

  /** 알림 화면 + Enter 계속. kind: ok | warn | err */
  async notice(kind, msg, { fix = "", pause = "계속" } = {}) {
    const mark = kind === "err" ? c.red(SYM.err) : kind === "ok" ? c.green(SYM.ok) : c.yellow(SYM.warn);
    const [first, ...rest] = String(msg).split("\n");
    this.screen([`  ${mark} ${first}`, ...rest.map((l) => "    " + l), ...(fix ? rail([["해결 방법", fix]], { indent: 4, wrap: this.#wrapWidth() }) : [])].join("\n"));
    await this.pause(pause);
  }

  // ---- 위치
  /** 위치를 조각으로: 설치 단계는 ["설치 3/8", "구성요소"], 그 밖에는 path 배열 그대로 */
  #locParts() {
    const f = this.frameSpec;
    if (f.steps) {
      const long = f.longSteps ?? f.steps;
      const title = f.title ?? "설치";
      return f.current >= f.steps.length ? [f.stage || "진행 중"] : [`${title} ${f.current + 1}/${f.steps.length}`, long[f.current]];
    }
    return [f.path ?? []].flat().map(String).filter(Boolean);
  }
  #lineFrame() {
    const t = this.#locParts().join(" · ");
    if (!t || t === this.lastFrame) return;
    this.lastFrame = t;
    this.print("");
    this.print(`── ${t}`);
  }

  // ---- 중단 (Ctrl+C) · 종료
  /** 끝낸다. 원격 모드에서는 exe 가 터미널을 되돌리고 summary 를 본 화면에 찍은 뒤 끝날 때까지 기다린다 */
  async end(code = 0) {
    if (this.ended) return;
    this.ended = true;
    this.close();
    if (this.mode !== "remote" || !this.link) return;
    this.#flushWork();
    this.#send({ op: "quit", code, summary: this.summary.length ? this.summary.map(plain) : this.#workSummary() });
    if (this.link instanceof ExeLink) await Promise.race([this.link.exited, new Promise((r) => setTimeout(r, 3000))]);
  }
  /** 마지막 화면이 진행 화면이었으면 그 내용을 본 화면에 남긴다 (완료 안내 · 오류의 원인과 해결 방법) */
  #workSummary() {
    if (!this.work) return [];
    const mark = { done: SYM.ok, fail: SYM.err, run: SYM.busy, wait: "·" };
    const lines = [this.work.title, ...this.work.lines, ...this.work.items.map((t) => (t.state === "text" ? t.label : `${mark[t.state]} ${plain(t.label)}${t.extra ? "  " + plain(t.extra) : ""}`))];
    return lines.filter((l, i) => l.trim() || (i > 0 && i < lines.length - 1)).slice(-16).map((l) => "  " + l);
  }
  abort() {
    const note = this.interruptNote();
    if (this.mode === "line") { this.out.write(`\n${note}\n`); process.exit(130); }
    this.summary = [note];
    this.end(130).then(() => process.exit(130));
  }

  /** main 을 실행하고 종료 코드로 끝낸다. 처리하지 못한 예외는 스택 대신 한 줄 (OXY_DEBUG=1 이면 스택) */
  async run(main) {
    let code = 1;
    try {
      code = await main();
    } catch (e) {
      const lines = e instanceof InputEnded ? ["", `입력이 끝나 중단되었습니다. 대기 중이던 질문: ${e.question}`]
        : ["", `  ${SYM.err} 예기치 않은 오류가 발생했습니다: ${e?.message ?? e}`, process.env.OXY_DEBUG ? String(e?.stack ?? e) : `    ${DEBUG_HINT}`];
      if (this.mode === "line") this.out.write(lines.join("\n") + "\n"); else this.summary = lines;
    }
    await this.end(code ?? 0);
    process.exit(code ?? 0);
  }

  /**
   * 화면 밖(본 화면)에서 fn 을 실행한다. 출력이 길어 스크롤백에 남아야 하는 것(verify)에 쓴다.
   * 원격 모드: exe 가 대체 화면에서 나가고(suspend) → fn 실행 → 본 화면에서 Enter 를 기다린 뒤 돌아온다(resume)
   */
  async outside(fn, { title = "", pause = "계속", lineWait = true } = {}) {
    if (this.mode === "line") {
      if (title) { this.#lineFrame(); this.print(""); this.print(`  ${title}`); this.print(""); }
      const r = await fn();
      if (pause && lineWait) await this.pause(pause);   // lineWait: false 면 줄 입력 모드에서는 기다리지 않는다 (출력이 그대로 남으므로)
      return r;
    }
    this.#prompt();
    await this.#ask({ op: "suspend" });
    if (title) this.out.write(`\n  ${title}\n\n`);
    try { return await fn(); } finally { await this.#ask({ op: "resume", wait: pause || "" }); }
  }

  // ---- 줄 입력 (줄 입력 모드)
  async #line(prompt, { mask = false } = {}) {
    if (!this.lines) {
      this.rl = readline.createInterface({ input: this.in, terminal: false });
      this.lines = this.rl[Symbol.asyncIterator]();
    }
    this.#note();
    this.out.write(prompt);
    const { value, done } = await this.lines.next();
    if (done) { this.out.write("\n"); throw new InputEnded(this.waitingFor); }
    // 입력을 되찍는 것은 로그에 답을 남기기 위함. 비밀값은 입력 여부만 남긴다
    this.out.write((mask ? (value ? "(입력됨)" : "") : value) + "\n");
    return value.trim();
  }

  /**
   * 하나 선택. options: [{label, value, hint, detail, info, disabled, why, fix, recommended, current, danger, status, gap, lineOnly} | {header}]
   * hint: 값 열 (현재 값 · 한 줄 설명) · detail: 포커스했을 때의 설명 문장(들) · info: 관련 정보 [[이름, 값]] (상세 패널 · 도움말)
   * gap: 이 행 앞에서 묶음이 바뀐다 (자리가 있으면 빈 줄) · {header} 행도 묶음 경계로만 쓴다 (제목은 그리지 않는다)
   * lineOnly: 줄 입력 모드에만 보이는 행 (원격 모드에서는 Esc 가 같은 일을 하는 `종료` · `이전`)
   * opts: note(맥락) · result(맥락을 접지 않는다) · message(직전 결과 한 줄) · esc · enter · initial · back · summary([[이름, 값]])
   */
  select(question, options, opts = {}) { return this.#choose(false, question, options, opts); }

  /**
   * 여러 개 선택 → value[]. rows: [{label, value, checked, hint, locked, disabled, ...} | {header}]
   * locked: 항상 선택된 상태로 고정 (해제 불가, 결과에 항상 포함) · disabled: 선택할 수 없음 (이유 문구)
   */
  multiselect(question, rows, opts = {}) { return this.#choose(true, question, rows, opts); }

  async #choose(multi, question, rawRows, opts) {
    const { back = true, note = "", result = false, esc = "이전", message = "", summary = [] } = opts;
    const enter = opts.enter ?? this.enterLabel ?? (multi ? "확인" : "선택");
    // 묶음 경계: {header} 행 다음 항목과 gap 이 붙은 항목
    const items = [];
    let boundary = false;
    for (const r of rawRows.map(normRow)) {
      if (r.header) { boundary = items.length > 0; continue; }
      items.push({ ...r, gap: Boolean(r.gap || boundary) && items.length > 0 });
      boundary = false;
    }
    const checked = items.map((o) => !o.disabled && Boolean(o.checked || o.locked));
    const ctxAll = toLines(note);
    const first = startIndex(items, opts.initial);
    const collect = (k) => (multi ? items.filter((o, j) => o.locked || (checked[j] && !o.disabled)).map((o) => o.value) : items[k].value);
    this.waitingFor = question;
    if (this.mode === "line") return this.#lineChoose({ multi, question, items, checked, ctxAll, summary, focus: first, back, esc, message, collect });

    const vis = items.map((o, j) => ({ o, j })).filter((x) => !x.o.lineOnly);
    this.#prompt();
    const r = await this.#ask({
      op: "select", header: plain(question), context: ctxAll.map(plain), keep: Boolean(result), summary: summary.map(([k, v]) => [plain(k), plain(v)]),
      multi, focus: Math.max(0, vis.findIndex((x) => x.j === first)), esc: back ? esc : "", enter,
      // 직전 결과 한 줄. 맨 앞 기호가 종류다 (✓ 됨 · ! 주의 · × 실패). 기호는 exe 가 종류에 맞춰 다시 그린다
      result: plain(message).replace(/^[✓!×]\s*/, ""), result_kind: { "!": "warn", "×": "err" }[plain(message).trim()[0]] ?? "ok",
      rows: vis.map(({ o, j }) => ({
        label: o.label, value: plain(o.hint ?? ""), status: o.locked && !o.status ? "" : plain(statusOf(o)), desc: descOf(o), info: (o.info ?? []).map(([k, v]) => [plain(k), plain(v)]),
        gap: o.gap, disabled: Boolean(o.disabled), recommended: Boolean(o.recommended), current: Boolean(o.current), danger: Boolean(o.danger),
        locked: Boolean(o.locked), checked: checked[j],
      })),
    });
    if (r.back) return BACK;
    if (!multi) return items[vis[r.index].j].value;
    const on = new Set(r.indices.map((i) => vis[i].j));
    return items.filter((o, j) => o.locked || (on.has(j) && !o.disabled)).map((o) => o.value);
  }

  async #lineChoose({ multi, question, items, checked, ctxAll, summary, focus, back, esc, message, collect }) {
    this.#lineFrame();
    if (message) { this.print(""); this.print(message); }
    this.print("");
    this.print(question);
    for (const l of ctxAll) lineWrap(l).forEach((x) => this.print(x));
    rail(summary).forEach((l) => this.print(l));
    this.print("");
    const d = String(items.length).length;
    const labelW = Math.min(24, Math.max(0, ...items.map((o) => displayWidth(decorated(o)))));
    items.forEach((r, j) => {
      const box = multi ? `[${r.locked ? "■" : r.disabled ? "·" : checked[j] ? SYM.ok : " "}] ` : "";
      const v = valueOf(r);
      this.print(`  ${String(j + 1).padStart(d)}) ${box}${v ? padDisplay(decorated(r), labelW) + "  " + v : decorated(r)}`);
      if (r.danger) descOf(r).forEach((e) => this.print(`  ${" ".repeat(d)}    ${e}`));
    });
    this.print("");
    const hasLocked = items.some((o) => o.locked);
    const explainAll = () => {
      this.print("");
      items.forEach((o, j) => {
        const dl = [...descOf(o), ...(o.info ?? []).map(([k, v]) => `${k}: ${stripAnsi(v)}`)];
        if (dl.length) this.print(`  ${String(j + 1).padStart(d)}) ${o.label}: ${dl.join(" ")}`);
      });
      termsIn([question, ...ctxAll, ...items.map((o) => `${o.label} ${o.hint}`)].join(" ")).forEach((t) => this.print(`  ${t}: ${GLOSSARY[t]}`));
      this.print("");
    };
    const bad = (s) => this.print(`  ${SYM.err} ${s}`);
    const blockedText = (k) => `선택할 수 없습니다: ${k}번 ${items[k - 1].label} (${items[k - 1].why ?? statusOf(items[k - 1])})`;
    for (;;) {
      if (!multi) {
        const a = await this.#line(`번호 (Enter=${focus + 1}${back ? `, <=${esc}` : ""}, ?=설명): `);
        if (back && a === "<") return BACK;
        if (a === "?") { explainAll(); continue; }
        const k = a === "" ? focus + 1 : Number(a);
        if (!(Number.isInteger(k) && k >= 1 && k <= items.length)) { bad(`1~${items.length} 사이의 번호를 입력하세요`); continue; }
        if (items[k - 1].disabled) { bad(blockedText(k)); continue; }
        return items[k - 1].value;
      }
      const a = await this.#line(`번호 (예: 2,4 또는 +6 -3, Enter=그대로${hasLocked ? ", -=필수만" : ""}${back ? `, <=${esc}` : ""}, ?=설명): `);
      if (back && a === "<") return BACK;
      if (a === "?") { explainAll(); continue; }
      if (a === "") return collect();
      if (a === "-") { checked.fill(false); return collect(); }
      const toks = a.split(/[\s,]+/).filter(Boolean);
      const rel = toks.every((t) => /^[+-]\d+$/.test(t));
      const abs = toks.every((t) => /^\d+$/.test(t));
      if (!rel && !abs) { bad("2,4 또는 +6 -3 형식 중 하나로 입력하세요"); continue; }
      const nums = toks.map((t) => Math.abs(Number(t)));
      if (!nums.every((k) => Number.isInteger(k) && k >= 1 && k <= items.length)) { bad(`1~${items.length} 사이의 번호를 쉼표로 구분해 입력하세요`); continue; }
      const on = abs ? nums : toks.filter((t) => t[0] === "+").map((t) => Number(t.slice(1)));
      const off = abs ? [] : toks.filter((t) => t[0] === "-").map((t) => Number(t.slice(1)));
      const blocked = on.find((k) => items[k - 1].disabled);
      if (blocked) { bad(blockedText(blocked)); continue; }
      const lockedOff = off.find((k) => items[k - 1].locked);
      if (lockedOff) { bad(`필수 항목은 해제할 수 없습니다: ${lockedOff}번 ${items[lockedOff - 1].label}`); continue; }
      if (abs) checked.fill(false);
      on.forEach((k) => { checked[k - 1] = true; });
      off.forEach((k) => { checked[k - 1] = false; });
      return collect();
    }
  }

  /**
   * 문자열 입력. validate(v) → 오류 문자열(× 뒤에 붙는 문구) 또는 null
   * question: 입력할 값의 이름 (명사형: `포트`, `API 키`) · note(또는 hint): 맥락 (형식 예시 `예: …`)
   * enter · esc: 키 안내의 뜻 · prompt: 줄 입력 모드의 프롬프트를 바꿀 때 (무거운 확인)
   * error: 처음부터 보일 오류 (앞 화면에서 이 값으로 해 본 일이 실패했을 때. 입력을 고치면 사라진다)
   */
  async input(question, { initial = "", mask = false, validate = () => null, hint = "", note, back = true, enter, esc = "이전", prompt, error = "" } = {}) {
    enter ??= this.enterLabel ?? "확인";
    const ctxAll = toLines(note ?? hint);
    this.waitingFor = question;
    if (this.mode === "line") {
      this.#lineFrame();
      this.print("");
      this.print(question);
      ctxAll.forEach((l) => lineWrap(l).forEach((x) => this.print(x)));
      if (mask) wrapText("이 터미널에서는 입력한 내용이 화면에 보일 수 있습니다.", 78).forEach((x) => this.print(x));
      this.print("");
      if (error) this.print(`  ${SYM.err} ${plain(error)}`);
      for (;;) {
        const shown = mask && initial ? "저장된 값" : initial;
        const p = prompt ?? `입력 (${[shown && `Enter=${shown} 유지`, back && `<=${esc}`].filter(Boolean).join(", ")})`.replace(" ()", "");
        const a = await this.#line(`${p}: `, { mask });
        if (back && a === "<") return BACK;
        const v = a === "" ? initial : a;
        const err = validate(v);
        if (!err) return v;
        this.print(`  ${SYM.err} ${err}`);
      }
    }
    this.#prompt();
    let r = await this.#ask({ op: "input", header: plain(question), context: ctxAll.map(plain), value: initial, mask, esc: back ? esc : "", enter, error: plain(error) });
    for (;;) {
      if (r.back) return BACK;
      const err = validate(r.value);
      if (!err) return r.value;
      r = await this.#ask({ op: "invalid", message: plain(err) }, r.id);   // 오류를 보인 채 다시 입력받는다
    }
  }

  /**
   * 확인 (2지선다, 1 = 진행 · 2 = 안 함 고정). yes/no 레이블은 필수 (예/아니요 금지).
   * level: light(초기 포커스 1) | medium | heavy (초기 포커스 2 = 안 함, 진행 레이블에 ! 표시)
   * 위험한 확인(danger)은 원격 모드에서 팝업으로 뜬다: title · summary([[이름, 값]]) · warning(되돌릴 수 없는 결과 한 줄)
   */
  async confirm(question, { yes, no, initial, level = "light", danger, note = "", detail = {}, back = false, recommended = false, title = "", summary = [], warning = "" } = {}) {
    if (!yes || !no) throw new Error("confirm: yes/no 레이블이 필요합니다 (예/아니요 단독 레이블 금지)");
    const def = initial ?? level === "light";
    const risky = danger ?? level !== "light";
    if (this.mode === "remote" && risky) {
      this.#flushWork();
      this.#frame();
      const r = await this.#ask({ op: "confirm", title: plain(title || yes), header: plain(question), context: toLines(note).map(plain),
        summary: summary.map(([k, v]) => [plain(k), plain(v)]), warning: plain(warning), yes: plain(yes), no: plain(no), danger: true, on_yes: Boolean(def) });
      this.work = null;
      return r.back ? (back ? BACK : false) : r.yes === true;
    }
    const v = await this.select(question, [
      { label: yes, value: true, danger: risky, recommended, detail: detail.yes ?? (warning ? `! ${warning}` : undefined) },
      { label: no, value: false, detail: detail.no },
    ], { initial: def ? 0 : 1, back, note, result: true, summary, enter: "선택" });
    return v === BACK ? BACK : v === true;
  }

  /** 무거운 확인: 정해진 단어(폴더 이름)를 입력해야 진행. Esc · < → false */
  async confirmTyped(question, { word, note = "" } = {}) {
    const v = await this.input(question, {
      note, back: true, esc: "취소", enter: "삭제",
      validate: (s) => (s === word ? null : "폴더 이름이 일치하지 않습니다. 취소하려면 Esc를 누르세요"),
      prompt: `삭제하려면 ${word} 입력 (<=취소)`,
    });
    return v !== BACK && v === word;
  }

  /**
   * 진행 표시와 함께 작업 실행. 시작하자마자(fn 을 부르기 전) 레이블을 보인다. 원격 모드에서는 진행 화면의 작업 목록에 쌓인다.
   * fn(update): update(text, pct) 로 진행 문구 변경 (pct 를 주면 원격 모드는 게이지, 줄 입력 모드는 25% 마다 한 줄)
   * 실패하면 원인 · 해결 방법을 출력하고 다시 던진다 (e.reported = true)
   */
  async task(label, fn, { target = "" } = {}) {
    const remote = this.mode === "remote";
    let lastStep = 0;
    const t = { state: "run", label, target, extra: "", percent: null };
    this.current = t;
    if (remote) { this.work ??= { title: "", lines: [], items: [] }; this.work.items.push(t); this.#sendWork(); }
    else this.print(`  ${SYM.busy} ${label}${target ? "  " + target : ""}`);
    const update = (text, pct) => {
      t.extra = text;
      if (pct != null) t.percent = pct;
      if (remote) { t.target = ""; this.#touchWork(); }
      else if (pct != null && pct >= lastStep + 25 && pct < 100) { lastStep = Math.floor(pct / 25) * 25; this.print(`  ${SYM.busy} ${label}  ${text}`); }
    };
    try {
      const r = await fn(update);
      t.extra = typeof r === "string" ? r : t.extra;
      t.state = "done";
      t.percent = null;
      if (remote) { t.target = ""; this.#flushWork(); this.#sendWork(); } else this.print(`  ${SYM.ok} ${label}${t.extra ? "  " + t.extra : ""}`);
      return r;
    } catch (e) {
      t.extra = e?.stoppedAt ?? "";
      t.state = "fail";
      t.percent = null;
      if (!remote) this.print(`  ${SYM.err} ${label}${t.extra ? "  " + t.extra : ""}`);
      const { cause, fix } = explainError(e);
      rail([["원인", cause], fix ? ["해결 방법", fix] : null], { indent: 4, wrap: this.#wrapWidth() }).forEach((l) => this.print(l));
      if (e && typeof e === "object") e.reported = true;
      throw e;
    } finally { this.current = null; }
  }

  /**
   * 잠깐 걸리는 일을 지금 화면을 그대로 둔 채 알린다 (키 안내 자리에 진행 표시). 다음 화면 지시가 오면 사라진다.
   * 방금 답한 목록을 바닥에 둔 채 확인 팝업을 보이기 전에 쓴다 (제거: 삭제할 파일 세기)
   */
  async busy(label) {
    if (this.mode === "line") { this.print(`  ${SYM.busy} ${label}`); return; }
    this.#send({ op: "busy", label: plain(label) });
    // 이어지는 일이 이벤트 루프를 막아도(동기 파일 탐색) 지시가 먼저 나가 그려지도록 잠깐 양보한다
    await new Promise((r) => setTimeout(r, 60));
  }

  /** Enter 계속 / Enter 종료. 원격 모드에서는 지금 화면(진행 화면)을 그대로 두고 키 안내만 바꾼다 */
  async pause(what = "계속") {
    if (this.mode === "line") { try { await this.#line(`Enter ${what}: `); } catch { /* EOF 는 계속 */ } return; }
    this.#flushWork();
    if (!this.work) { this.work = { title: "", lines: [], items: [] }; this.#sendWork(); }
    await this.#ask({ op: "pause", label: what });
  }

  close() { this.rl?.close(); }
}

/** 줄 입력 모드의 맥락 줄: 들여쓰지 않은 문장만 78칸에서 줄바꿈한다 (속성·결과 줄은 로그 검색을 위해 자르지 않는다) */
function lineWrap(l) {
  return /^\s/.test(stripAnsi(l)) ? [l] : wrapIndented(l, 78);
}
