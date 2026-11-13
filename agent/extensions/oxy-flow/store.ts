// oxy-flow 기본(내장) 작업 기록 엔진.
//   <프로젝트>/.oxy/flow/flow.json   작업 하나의 그래프: 커밋 단위 노드 + 각 노드의 결정 사항
//   <프로젝트>/.oxy/flow/FLOW.md     사람이 읽는 같은 내용 (변경할 때마다 다시 씀)
//   <프로젝트>/.oxy/flow/lock        쓰기 락 {pid, at} — 다른 살아 있는 pi 가 쥐고 있으면 읽기 전용
//   <프로젝트>/.oxy/flow/archive/    끝난 작업 · 다른 세션의 작업 (그 세션을 다시 열면 되살린다, bindSession)
// 엔진 경계(FlowEngine)를 두어 나중에 flowout 으로 바꿀 수 있게 한다. pi 에 의존하지 않아 단위 테스트가 가능하다.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { writeAtomic } from "../_lib/common.ts";
import { type PlanInput, type PlanItem, addItem, currentItem, findItem, nextStep, renderPlanLines, renderPlanMarkdown, setPlan, updateItem } from "./plan.ts";
import { type Mark, type RollbackRecord, type ShadowState, allItems, applyRollback, findTask, planRollback, targets, taskMarks, undoRollback } from "./rollback.ts";
import { ShadowRepo, pruneShadows } from "./shadow.ts";

export type NoteKind = "decision" | "goal" | "next" | "blocked" | "done";
export interface Decision { at: number; text: string; why?: string }
export interface Failure { at: number; command: string; tail: string }
export interface FlowNode {
  id: string;            // n1, n2 …
  commit: string;        // git 커밋 해시 (짧은 형태 아님)
  title: string;         // 커밋 제목
  at: number;
  external?: boolean;    // pi 밖에서 만든 커밋 (나중에 발견)
  repo?: string;         // 커밋이 있는 저장소 (기록을 둔 곳과 다를 때만, docs/flow-spec.md "작업 저장소")
  decisions: Decision[];
  files: string[];
}
export interface Buffer {          // 마지막 노드 이후 아직 커밋되지 않은 작업
  decisions: Decision[];
  files: string[];
  commands: { at: number; command: string; ok: boolean }[];
  failures: Failure[];
  jobs: string[];
}
export interface Flow {
  version: 1;
  id: string;
  goal: string;
  next: string;
  blocked: string;
  status: "active" | "done";
  startedAt: number;
  updatedAt: number;
  baseCommit: string | null; // 작업을 시작할 때의 HEAD
  /**
   * 메인 컨텍스트가 실제로 작업하는 git 저장소 (pi 를 시작한 폴더와 다를 때). 고친 파일 · cd 한 폴더로 정한다 (noteWorkPath).
   * 커밋 찾기 · 되돌리기는 이 저장소에서 한다. 없으면 기록을 둔 곳(root)
   */
  work?: { root: string; baseCommit: string | null };
  continueAt?: number;       // 세션 넘기기 표시 (store.markContinue)
  /**
   * 세션 넘기기 직전의 마지막 요청과 답 (docs/flow-spec.md §1-5). 새 세션의 첫 요청에 넣고 지운다.
   * 답에 선택지가 있었는데 사용자가 "2번으로 할게" 로 답하며 넘어가면, 새 세션이 그 선택지를 몰랐다 (2026-11-14)
   */
  handoff?: { user: string; reply: string; at: number };
  continueBy?: string;       // 그 표시를 이어받은 세션 (bindSession). 한 세션만 이어받는다
  sessions?: string[];       // 이 작업을 한 pi 세션 id (세션 넘기기로 이어진 세션 포함). 예전 파일에는 없다
  plan: PlanItem[];          // 앞으로 할 일: 항목 → 할 일 (plan.ts). 예전 파일에는 없다 (load 가 빈 배열로 채움)
  /** 그림자 저장소로 따라가는 작업 폴더 (docs/flow-rollback-spec.md §4, D11): 폴더 → 기준 · 마지막 · 끝 스냅숏 */
  shadow?: Record<string, ShadowState>;
  /** 마지막 Task 스냅숏 뒤 스냅숏에 들어가지 않은 변경 (다음 Task 스냅숏 때 그 Task 의 incomplete 로 옮긴다) */
  unsnapped?: string[];
  /** 이 Flow 에서 한 되돌리기 (대상은 이 Flow 또는 끝난 Flow) */
  rollbacks?: RollbackRecord[];
  nodes: FlowNode[];
  buffer: Buffer;
}

/** 작업 기록 엔진 경계. 내장 엔진(FileFlowEngine)과 이후 flowout 어댑터가 같은 형태를 따른다. */
export interface FlowEngine {
  readonly dir: string;
  readonly writable: boolean;
  load(): Flow;
  note(kind: NoteKind, text: string, why?: string): Flow;
  setPlan(items: PlanInput[]): PlanItem[];
  addPlan(text: string, parent?: string): PlanItem;
  updatePlan(id: string, change: { status?: string; text?: string }): PlanItem;
  recordFile(path: string): void;
  recordCommand(command: string, ok: boolean, tail: string): void;
  recordJob(text: string): void;
  syncCommits(external?: boolean): FlowNode[]; // git HEAD 와 맞춰 새 커밋을 노드로 만든다
  startNew(goal: string): Flow;      // 현재 작업을 보관하고 새 작업 시작
  release(): void;
}

/**
 * 보관하는 Flow 수 (docs/flow-rollback-spec.md D10: 기본 10, Tweak 에서 조절 → OXY_FLOW_KEEP). 넘으면 오래된 Flow 의 기록 · 스냅숏부터 정리한다.
 * (예전: archive/ 50개, docs/flow-spec.md F1)
 */
export const FLOW_KEEP_DEFAULT = 10;
export function flowKeep(): number {
  const n = Number(process.env.OXY_FLOW_KEEP);
  return Number.isInteger(n) && n >= 1 && n <= 100 ? n : FLOW_KEEP_DEFAULT;
}
/** 그림자 저장소를 쓰는가 (OXY_FLOW_SHADOW=off 로 끈다) */
export const shadowEnabled = () => (process.env.OXY_FLOW_SHADOW ?? "on").toLowerCase() !== "off";
/** 프로젝트 표시 파일: git 이 아닌 폴더에서 작업 폴더의 최상위를 정할 때 */
const PROJECT_MARKERS = ["pom.xml", "package.json", "build.gradle", "build.gradle.kts", "settings.gradle", "pyproject.toml", "setup.py", "Cargo.toml", "go.mod", "composer.json", "Gemfile", "Makefile", ".gitignore"];

/**
 * 경로가 속한 작업 폴더: git 저장소면 최상위, 아니면 위로 올라가며 처음 만나는 프로젝트 폴더(pom.xml · package.json 등). 없으면 null.
 * (설치본 cozy-example 의 실제 작업 폴더 library-rental 은 git 이 아니어서 작업 저장소를 따라가지 못했다, 2026-11-14)
 */
export function workFolderOf(path: string): string | null {
  // 홈 폴더 · 드라이브 루트처럼 너무 넓은 곳은 따라가지 않는다 (홈 전체를 스냅숏하지 않게)
  const tooBroad = (d: string) => {
    const n = (p: string) => p.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
    const h = n(homedir()), x = n(d);
    return !x || x === h || h.startsWith(x + "/") || /^[a-z]:$/.test(x) || x === "";
  };
  const top = repoOf(path);
  if (top) return tooBroad(top) ? null : top;
  let dir = path;
  for (let i = 0; i < 40 && dir && !existsSync(dir); i++) dir = dirname(dir);
  try { if (existsSync(dir) && !statSync(dir).isDirectory()) dir = dirname(dir); } catch { return null; }
  for (let i = 0; i < 12 && dir; i++) {
    if (tooBroad(dir)) return null;
    if (PROJECT_MARKERS.some((m) => existsSync(join(dir, m)))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}
const MAX_COMMANDS = 15, MAX_FAILURES = 5, MAX_FILES = 200, MAX_JOBS = 10;
/** 넘기기 때 남기는 마지막 답의 길이 (끝에서부터) */
export const HANDOFF_REPLY_MAX = 3000;
const empty = (): Buffer => ({ decisions: [], files: [], commands: [], failures: [], jobs: [] });

export function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim();
  } catch { return null; }
}

/** 경로 비교용 (Windows 는 대소문자 · 구분자 무시) */
const samePath = (a: string, b: string) => {
  const n = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
};

/** 경로(파일 · 폴더, 아직 없는 것 포함)가 속한 git 저장소의 최상위 (없으면 null) */
export function repoOf(path: string): string | null {
  let dir = path;
  for (let i = 0; i < 40 && dir && !existsSync(dir); i++) dir = dirname(dir);
  try { if (existsSync(dir) && !statSync(dir).isDirectory()) dir = dirname(dir); } catch { return null; }
  return dir && existsSync(dir) ? git(dir, ["rev-parse", "--show-toplevel"]) : null;
}

/**
 * bash 명령이 들어가는 폴더들: `cd <폴더>` (&& · ; · || 뒤 포함)와 `git -C <폴더>`. 따옴표를 벗긴다. 나온 순서대로
 */
export function commandDirs(command: string): string[] {
  const out: string[] = [];
  const re = /(?:^|&&|\|\||;|\n)\s*cd\s+("[^"]*"|'[^']*'|[^\s;&|]+)|\bgit\s+-C\s+("[^"]*"|'[^']*'|\S+)/g;
  for (const m of command.matchAll(re)) {
    const raw = (m[1] ?? m[2] ?? "").replace(/^["']|["']$/g, "");
    if (raw && raw !== "-" && !raw.startsWith("$")) out.push(raw);
  }
  return out;
}

/** 기록을 둘 프로젝트 루트: git 저장소면 최상위, 아니면 cwd */
export function projectRoot(cwd: string): string {
  return git(cwd, ["rev-parse", "--show-toplevel"]) ?? cwd;
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; }
}

export class FileFlowEngine implements FlowEngine {
  readonly dir: string;
  readonly root: string;
  writable = false;
  lockOwner: number | null = null;
  private flow: Flow | null = null;
  private session: string | null = null;   // 지금 pi 세션 id (bindSession). 기록을 저장할 때 flow.sessions 에 더한다

  constructor(cwd: string, readOnly = false) {
    this.root = projectRoot(cwd);
    this.dir = join(this.root, ".oxy", "flow");
    if (!readOnly) this.acquire();
  }

  /** 락: 내가 쥐거나, 주인이 죽었으면 넘겨받는다. 살아 있는 다른 pi 가 쥐고 있으면 읽기 전용. */
  private acquire(): void {
    mkdirSync(this.dir, { recursive: true });
    const oxy = join(this.root, ".oxy");
    // 사용자 프로젝트의 .gitignore 를 건드리지 않고 .oxy 를 git 에서 제외
    if (!existsSync(join(oxy, ".gitignore"))) writeFileSync(join(oxy, ".gitignore"), "*\n");
    const lock = join(this.dir, "lock");
    try {
      const cur = JSON.parse(readFileSync(lock, "utf8"));
      if (cur.pid !== process.pid && pidAlive(cur.pid)) { this.lockOwner = cur.pid; return; }
    } catch { /* 락 없음 */ }
    writeAtomic(lock, JSON.stringify({ pid: process.pid, at: Date.now() }));
    this.writable = true;
  }

  release(): void {
    if (!this.writable) return;
    const lock = join(this.dir, "lock");
    try { if (JSON.parse(readFileSync(lock, "utf8")).pid === process.pid) rmSync(lock); } catch { /* 이미 없음 */ }
    this.writable = false;
  }

  load(): Flow {
    if (this.flow) return this.flow;
    const file = join(this.dir, "flow.json");
    try {
      this.flow = JSON.parse(readFileSync(file, "utf8")) as Flow;
      this.flow.buffer = { ...empty(), ...this.flow.buffer };
      if (!Array.isArray(this.flow.plan)) this.flow.plan = [];
    } catch {
      this.flow = this.fresh("");
    }
    return this.flow;
  }

  private fresh(goal: string): Flow {
    const now = Date.now();
    // id 는 보관 파일 이름이 된다. 같은 초에 두 작업이 생길 수 있으므로(세션 전환 · /flow new) 무작위 꼬리를 붙인다
    const tail = Math.random().toString(16).slice(2, 6).padEnd(4, "0");
    return { version: 1, id: `flow-${new Date(now).toISOString().slice(0, 19).replace(/[-:T]/g, "")}-${tail}`, goal, next: "", blocked: "",
      status: "active", startedAt: now, updatedAt: now, baseCommit: git(this.root, ["rev-parse", "HEAD"]), plan: [], nodes: [], buffer: empty() };
  }

  /** 기록이 실제로 있는가 (빈 작업이면 컨텍스트에 넣지 않는다) */
  hasContent(): boolean {
    const f = this.load();
    return Boolean(f.goal || this.hasWork());
  }

  /** 목표 말고 진행 기록이 있는가 (계획 · 커밋 노드 · 결정 · 변경 · 실패 · 다음 단계 · 막힌 점). 목표만 있으면 주입할 가치가 없다 */
  hasWork(): boolean {
    const f = this.load();
    const b = f.buffer;
    return Boolean(f.next || f.blocked || f.plan.length || f.nodes.length || b.decisions.length || b.files.length || b.failures.length);
  }

  private save(): void {
    if (!this.writable || !this.flow) return;
    const ss = this.flow.sessions ?? [];
    if (this.session && !ss.includes(this.session) && this.hasContent()) this.flow.sessions = [...ss, this.session];
    this.flow.updatedAt = Date.now();
    writeAtomic(join(this.dir, "flow.json"), JSON.stringify(this.flow, null, 1));
    writeAtomic(join(this.dir, "FLOW.md"), renderMarkdown(this.flow));
  }

  note(kind: NoteKind, text: string, why?: string): Flow {
    const f = this.load();
    const t = text.trim();
    if (kind === "decision") f.buffer.decisions.push({ at: Date.now(), text: t, ...(why?.trim() ? { why: why.trim() } : {}) });
    else if (kind === "goal") f.goal = t;
    else if (kind === "next") f.next = t;
    else if (kind === "blocked") f.blocked = t;
    else if (kind === "done") { f.status = "done"; f.next = t || f.next; }
    // 새 다음 단계 · 끝을 기록하면 막힘은 풀린 것으로 본다 (2026-11-14: 재개한 뒤에도 "작업 중단" 이 남아 모델에게 계속 전달됐다)
    if (kind === "next" || kind === "done") f.blocked = "";
    if (kind !== "done" && f.status === "done") f.status = "active";
    this.save();
    return f;
  }

  /** 계획 전체 쓰기 (같은 글의 항목은 상태를 이어받는다) */
  setPlan(items: PlanInput[]): PlanItem[] {
    const f = this.load();
    f.plan = setPlan(f.plan, items);
    if (f.status === "done") f.status = "active";
    this.save();
    return f.plan;
  }

  addPlan(text: string, parent?: string): PlanItem {
    const f = this.load();
    const item = addItem(f.plan, text, parent);
    if (f.status === "done") f.status = "active";
    this.save();
    return item;
  }

  updatePlan(id: string, change: { status?: string; text?: string }): PlanItem {
    const f = this.load();
    const item = updateItem(f.plan, id, change);
    if (change.status === "doing") { f.blocked = ""; if (f.status === "done") f.status = "active"; }   // 다시 시작하면 막힘이 풀린다
    // Task 가 끝나면 스냅숏 (되돌리기 지점, docs/flow-rollback-spec.md §4). 할 일이 끝나 위 항목도 끝났으면 위 항목도 같은 지점
    if (change.status === "done" || change.status === "dropped") {
      this.snapTask(item);
      const parent = findItem(f.plan, item.id)?.parent;
      if (parent && (parent.status === "done" || parent.status === "dropped") && item.snaps) { parent.snaps = { ...item.snaps }; parent.snapAt = item.snapAt; }
    }
    this.save();
    return item;
  }

  /** 세션 넘기기 직전에 표시: 다음 세션의 첫 요청은 같은 작업을 이어 가는 것 (2분 안에 쓰지 않으면 무효) */
  markContinue(): void {
    this.load().continueAt = Date.now();
    this.save();
  }

  /** 이어 가기 표시가 아직 유효한가 (지우지 않는다) */
  private continuing(): boolean {
    const f = this.load();
    return typeof f.continueAt === "number" && Date.now() - f.continueAt < 120000 && !f.continueBy;
  }

  /**
   * pi 세션이 열릴 때 기록을 그 세션에 맞춘다 (작업 기록은 세션 단위, 프로젝트 폴더에는 지금 세션의 작업 하나).
   *   kept     이 세션의 작업 (같은 세션을 다시 열었거나 /resume · -c)
   *   adopted  세션 넘기기로 새 세션이 됐다 → 같은 작업을 이어 간다
   *   restored 보관된 작업 중 이 세션의 것이 있다 → 지금 기록을 보관하고 그것을 되살린다
   *   parked   다른 세션의 작업이 남아 있다 → 보관하고 빈 기록으로 시작 (예전: 새로 시작해도 이전 작업이 그대로 보이고 새 요청이 섞였다)
   *   empty    기록이 없다 · readonly 다른 pi 가 쓰는 중이라 건드리지 않는다
   */
  bindSession(id: string): "kept" | "adopted" | "restored" | "parked" | "empty" | "readonly" {
    this.session = id || null;
    if (!this.writable) return "readonly";
    if (!id) return "empty";
    const f = this.load();
    if ((f.sessions ?? []).includes(id)) return "kept";
    if (this.continuing() && this.hasContent()) { f.continueBy = id; this.save(); return "adopted"; }
    const arch = this.findArchived(id);
    if (!arch && !this.hasContent()) return "empty";
    if (this.hasContent()) this.archiveCurrent();
    if (arch) {
      this.flow = arch.flow;
      this.flow.buffer = { ...empty(), ...this.flow.buffer };
      if (!Array.isArray(this.flow.plan)) this.flow.plan = [];
      this.save();
      rmSync(arch.file, { force: true });
      return "restored";
    }
    this.flow = this.fresh("");
    this.save();
    return "parked";
  }

  /** 보관된 작업 중 이 세션이 한 것 (가장 최근) */
  private findArchived(id: string): { file: string; flow: Flow } | null {
    const arch = join(this.dir, "archive");
    let best: { file: string; flow: Flow } | null = null;
    let names: string[] = [];
    try { names = readdirSync(arch).filter((n) => n.endsWith(".json")); } catch { return null; }
    for (const n of names) {
      try {
        const f = JSON.parse(readFileSync(join(arch, n), "utf8")) as Flow;
        if ((f.sessions ?? []).includes(id) && (!best || f.updatedAt > best.flow.updatedAt)) best = { file: join(arch, n), flow: f };
      } catch { /* 깨진 파일은 건너뛴다 */ }
    }
    return best;
  }

  /** 지금 기록을 archive/ 에 보관 → 보관 파일 경로. 같은 이름(예전 초 단위 id)이 있으면 덮어쓰지 않고 번호를 붙인다 */
  private archiveCurrent(): string {
    const f = this.load();
    this.snapAll("end", f.goal || "end");
    const arch = join(this.dir, "archive");
    mkdirSync(arch, { recursive: true });
    let file = join(arch, `${f.id}.json`);
    for (let i = 2; existsSync(file); i++) file = join(arch, `${f.id}-${i}.json`);
    writeAtomic(file, JSON.stringify(f, null, 1));
    pruneArchive(arch, flowKeep(), file);
    this.pruneShadow();
    return file;
  }

  /** 넘기기 직전의 마지막 요청 · 답을 남긴다 (답은 끝부분 — 선택지 · 질문은 대개 끝에 있다) */
  setHandoff(user: string, reply: string): void {
    const f = this.load();
    const u = user.trim(), r = reply.trim();
    if (!u && !r) { delete f.handoff; this.save(); return; }
    f.handoff = { user: u.length > 800 ? `${u.slice(0, 800)} …` : u, reply: r.length > HANDOFF_REPLY_MAX ? `… ${r.slice(-HANDOFF_REPLY_MAX)}` : r, at: Date.now() };
    this.save();
  }

  /** 넘기기 기록을 지운다 (새 세션의 첫 요청에 넣은 뒤) */
  clearHandoff(): void {
    const f = this.load();
    if (!f.handoff) return;
    delete f.handoff;
    this.save();
  }

  /** 이어 가기 표시가 있으면 지우고 true */
  takeContinue(): boolean {
    const f = this.load();
    const on = typeof f.continueAt === "number" && Date.now() - f.continueAt < 120000;
    if (f.continueAt !== undefined || f.continueBy !== undefined) { delete f.continueAt; delete f.continueBy; this.save(); }
    return on;
  }

  /** 첫 요청을 목표로 삼는다 (목표가 비어 있을 때만) */
  ensureGoal(prompt: string): void {
    const f = this.load();
    const p = prompt.trim();
    if (f.goal || !p || p.startsWith("/")) return;
    f.goal = p.length > 400 ? `${p.slice(0, 400)} …` : p;
    this.save();
  }

  recordFile(path: string): void {
    const b = this.load().buffer;
    if (b.files.includes(path)) return;
    b.files.push(path);
    if (b.files.length > MAX_FILES) b.files.shift();
    this.save();
  }

  recordCommand(command: string, ok: boolean, tail: string): void {
    const b = this.load().buffer;
    const cmd = command.length > 200 ? `${command.slice(0, 200)} …` : command;
    b.commands.push({ at: Date.now(), command: cmd, ok });
    if (b.commands.length > MAX_COMMANDS) b.commands.shift();
    if (!ok) {
      b.failures.push({ at: Date.now(), command: cmd, tail: tail.slice(-600) });
      if (b.failures.length > MAX_FAILURES) b.failures.shift();
    } else {
      // 같은 명령이 나중에 성공하면 실패 기록은 해결된 것으로 본다
      b.failures = b.failures.filter((x) => x.command !== cmd);
    }
    this.save();
  }

  recordJob(text: string): void {
    const b = this.load().buffer;
    b.jobs.push(text.length > 200 ? `${text.slice(0, 200)} …` : text);
    if (b.jobs.length > MAX_JOBS) b.jobs.shift();
    this.save();
  }

  /** 커밋을 찾을 저장소: 메인 컨텍스트가 작업하는 곳 (없으면 기록을 둔 곳) */
  workRoot(): string {
    return this.load().work?.root ?? this.root;
  }

  /**
   * 메인 컨텍스트가 건드린 경로(고친 파일 · cd 한 폴더)로 작업 저장소를 정한다. 다른 git 저장소로 옮겨 가면 그 저장소의 HEAD 부터
   * 커밋을 찾는다 (pi 를 다른 폴더에서 시작해도 실제 작업을 따라간다). 바뀌었으면 true
   */
  noteWorkPath(absPath: string): boolean {
    const top = repoOf(absPath);
    if (!top || samePath(top, this.workRoot())) return false;
    const f = this.load();
    if (samePath(top, this.root)) delete f.work;
    else f.work = { root: top, baseCommit: git(top, ["rev-parse", "HEAD"]) };
    this.save();
    return true;
  }

  /**
   * 마지막 노드 이후 git 에 생긴 커밋을 노드로 만든다. 버퍼의 결정 사항·파일은 가장 최근 커밋 노드로 옮긴다.
   * pi 밖에서 사람이 한 커밋도 다음 호출 때 잡힌다 (external).
   */
  syncCommits(external = false): FlowNode[] {
    const f = this.load();
    const repo = this.workRoot();
    const other = !samePath(repo, this.root);
    const head = git(repo, ["rev-parse", "HEAD"]);
    if (!head) return [];
    // 같은 저장소의 마지막 노드부터 (저장소를 옮겨 왔으면 옮긴 때의 HEAD 부터)
    const lastNode = [...f.nodes].reverse().find((n) => samePath(n.repo ?? this.root, repo));
    const last = lastNode?.commit ?? (other ? f.work?.baseCommit ?? null : f.baseCommit);
    if (last === head) return [];
    let hashes: string[] = [];
    const range = last ? git(repo, ["rev-list", "--reverse", "--first-parent", `${last}..${head}`]) : null;
    if (range != null) hashes = range.split("\n").filter(Boolean);
    if (!hashes.length) hashes = [head]; // 브랜치 전환·rebase 등으로 이전 커밋이 조상이 아니면 HEAD 만 기록
    hashes = hashes.slice(-20);
    const made: FlowNode[] = [];
    for (const [i, h] of hashes.entries()) {
      const isLast = i === hashes.length - 1;
      const node: FlowNode = {
        id: `n${f.nodes.length + 1}`, commit: h, title: git(repo, ["log", "-1", "--format=%s", h]) ?? "", at: Date.now(),
        ...(external ? { external: true } : {}), ...(other ? { repo } : {}),
        decisions: isLast ? f.buffer.decisions : [],
        // 커밋에 실제로 들어간 파일 (bash 로 만든 파일 포함)
        files: (git(repo, ["show", "--name-only", "--format=", h]) ?? "").split("\n").filter(Boolean).slice(0, MAX_FILES),
      };
      f.nodes.push(node);
      made.push(node);
    }
    // 지금 진행 중인 할 일에 커밋을 붙인다 (계획이 있을 때)
    const cur = currentItem(f.plan);
    if (cur) for (const n of made) if (!cur.nodes.includes(n.id)) cur.nodes.push(n.id);
    // 커밋하면 커밋 전 작업(결정 · 파일 · 실패)을 비운다: Flow Monitor 의 Before Commit Task 가 사라진다 (docs/flow-view-spec.md). 작업 목록은 둔다
    f.buffer = { ...empty(), jobs: f.buffer.jobs };
    this.save();
    return made;
  }

  startNew(goal: string): Flow {
    if (this.hasContent()) this.archiveCurrent();
    this.flow = this.fresh(goal.trim());
    this.save();
    return this.flow;
  }

  // ---------------------------------------------------------------- 그림자 저장소 · 되돌리기 (docs/flow-rollback-spec.md)

  private repo(root: string): ShadowRepo { return new ShadowRepo(this.dir, root); }

  /** 이 작업 폴더를 따라가는가 */
  private tracked(root: string): string | null {
    return Object.keys(this.load().shadow ?? {}).find((r) => samePath(r, root)) ?? null;
  }

  /** 작업 폴더를 그림자 저장소로 따라가기 시작한다 (처음이면 기준 스냅숏). 고치기 전에 불러야 원래 상태가 남는다 */
  trackFolder(root: string): boolean {
    if (!this.writable || !shadowEnabled() || !root || this.tracked(root)) return false;
    const f = this.load();
    try {
      const snap = this.repo(root).snapshot(f.id, "base", f.goal || "start");
      f.shadow = { ...f.shadow, [root]: { base: snap.sha, last: snap.sha } };
      this.save();
      return true;
    } catch { return false; }
  }

  /** 경로가 따라가는 작업 폴더 안인가 */
  insideTracked(absPath: string): boolean {
    return Object.keys(this.load().shadow ?? {}).some((r) => {
      const rel = relativeTo(r, absPath);
      return rel !== null;
    });
  }

  /** 스냅숏에 들어가지 않는 변경을 적는다 (다음 Task 스냅숏 때 그 Task 의 ! 이유가 된다) */
  noteIncomplete(reason: string): void {
    if (!this.writable) return;
    const f = this.load();
    const r = reason.length > 160 ? `${reason.slice(0, 160)} …` : reason;
    if ((f.unsnapped ?? []).includes(r)) return;
    f.unsnapped = [...(f.unsnapped ?? []), r].slice(-10);
    this.save();
  }

  /** 따라가는 모든 작업 폴더의 스냅숏 → 폴더별 커밋 · 넣지 못한 큰 파일 */
  private snapAll(kind: "task" | "end", title: string): { snaps: Record<string, string>; skipped: string[]; failed: boolean } {
    const f = this.load();
    const snaps: Record<string, string> = {}, skipped: string[] = [];
    let failed = false;
    if (!shadowEnabled()) return { snaps, skipped, failed };
    for (const root of Object.keys(f.shadow ?? {})) {
      try {
        const s = this.repo(root).snapshot(f.id, kind, title);
        snaps[root] = s.sha;
        f.shadow![root] = { ...f.shadow![root], last: s.sha, ...(kind === "end" ? { end: s.sha } : {}) };
        skipped.push(...s.skipped.map((x) => `큰 파일 ${x}`));
      } catch { failed = true; }
    }
    return { snaps, skipped, failed };
  }

  private snapTask(item: PlanItem): void {
    const f = this.load();
    if (!f.shadow || !Object.keys(f.shadow).length) return;
    const r = this.snapAll("task", `${item.id} ${item.text}`);
    if (!Object.keys(r.snaps).length) return;
    item.snaps = r.snaps;
    item.snapAt = Date.now();
    const inc = [...(f.unsnapped ?? []), ...r.skipped, ...(r.failed ? ["스냅숏 실패"] : [])];
    if (inc.length) item.incomplete = [...new Set([...(item.incomplete ?? []), ...inc])];
    f.unsnapped = [];
  }

  /** 정리: 보관하는 Flow (지금 + archive/) 밖의 스냅숏을 지운다 (D10) */
  private pruneShadow(): void {
    const keep = new Set([this.load().id, ...this.completedFlows().map((x) => x.id)]);
    try { pruneShadows(this.dir, keep); } catch { /* 정리 실패는 다음에 */ }
  }

  /** 끝난 Flow (archive/, 최근 것부터, 보관 개수까지) */
  completedFlows(): Flow[] {
    return readCompleted(this.dir, flowKeep());
  }

  private flowById(id: string): { flow: Flow; current: boolean; file?: string } | null {
    const cur = this.load();
    if (!id || id === cur.id) return { flow: cur, current: true };
    const hit = readCompleted(this.dir, flowKeep(), true).find((x) => x.id === id);
    return hit ? { flow: hit, current: false, file: (hit as any).__file } : null;
  }

  /**
   * Flow 의 Task 까지 되돌리기 (§5). 확인은 부른 쪽(모니터 팝업 · /flow 확인 창)이 한다.
   * 충돌이 예상되면 아무것도 바꾸지 않는다. 스냅숏 밖 변경은 incomplete 로 돌려준다 (에이전트에게 맡김)
   */
  rollbackTo(flowId: string, taskId: string, dryRun = false): { ok: boolean; reason?: string; record?: RollbackRecord; files: string[]; conflicts: string[]; incomplete: string[]; flow?: Flow; task?: PlanItem } {
    if (!this.writable) return { ok: false, reason: "작업 기록이 읽기 전용입니다", files: [], conflicts: [], incomplete: [] };
    const hit = this.flowById(flowId);
    if (!hit) return { ok: false, reason: `Flow 를 찾지 못했습니다: ${flowId}`, files: [], conflicts: [], incomplete: [] };
    const t = findTask(hit.flow, taskId);
    if (!t) return { ok: false, reason: `Task 를 찾지 못했습니다: ${taskId}`, files: [], conflicts: [], incomplete: [] };
    const cur = this.load();
    const p = planRollback(this.dir, hit.flow, t, hit.current, cur.id);
    const base = { files: p.files, conflicts: p.conflicts, incomplete: p.incomplete, flow: hit.flow, task: t };
    if (!p.ok || dryRun) return { ok: p.ok, reason: p.reason, ...base };
    const rec = applyRollback(p, hit.flow, t, cur.id);
    cur.rollbacks = [...(cur.rollbacks ?? []), rec];
    for (const [root, x] of Object.entries(rec.roots)) {
      const r = this.tracked(root);
      if (r) cur.shadow![r] = { ...cur.shadow![r], last: x.result };
    }
    cur.buffer.decisions.push({ at: Date.now(), text: `Rolled back to ${hit.current ? "" : `${hit.flow.id} `}${t.id} "${t.text}" (${rec.files.length} files)`, why: "user request (flow rollback)" });
    this.save();
    return { ok: true, record: rec, ...base };
  }

  /** 마지막 되돌리기를 취소 (D3) */
  undoLast(dryRun = false): { ok: boolean; reason?: string; record?: RollbackRecord; files: string[]; conflicts: string[] } {
    if (!this.writable) return { ok: false, reason: "작업 기록이 읽기 전용입니다", files: [], conflicts: [] };
    const cur = this.load();
    const rec = [...(cur.rollbacks ?? [])].reverse().find((r) => !r.undone);
    if (!rec) return { ok: false, reason: "취소할 되돌리기가 없습니다", files: [], conflicts: [] };
    if (dryRun) return { ok: true, record: rec, files: rec.files, conflicts: [] };
    const r = undoRollback(this.dir, rec, cur.id);
    if (!r.ok) return { ok: false, reason: r.reason, record: rec, files: r.files, conflicts: r.conflicts };
    rec.undone = Date.now();
    for (const [root, sha] of Object.entries(r.results)) { const t = this.tracked(root); if (t) cur.shadow![t] = { ...cur.shadow![t], last: sha }; }
    cur.buffer.decisions.push({ at: Date.now(), text: `Undid rollback to ${rec.task} "${rec.text}"`, why: "user request (flow undo)" });
    this.save();
    return { ok: true, record: rec, files: r.files, conflicts: [] };
  }

  /** 기호 (지금 Flow + 끝난 Flow) → .oxy/flow/marks.json 에 쓴다. 모니터가 읽는다 */
  writeMarks(): Record<string, Record<string, Mark>> {
    const cur = this.load();
    const latest: Record<string, string> = {};
    for (const [root, st] of Object.entries(cur.shadow ?? {})) latest[root] = st.last;
    const out: Record<string, Record<string, Mark>> = {};
    const file: Record<string, Record<string, { mark: Mark; files: number }>> = {};
    // 확인 팝업의 "파일 N개": 그 Task 의 스냅숏 ↔ 지금(지금 Flow) · 끝(끝난 Flow) 사이에 바뀐 파일 수
    const count = (fl: Flow, t: PlanItem, current: boolean): number => {
      let n = 0;
      for (const [root, theirs] of Object.entries(targets(fl, t))) {
        const st = fl.shadow?.[root];
        const to = current ? st?.last : st?.end ?? st?.last;
        if (to && to !== theirs) { try { n += this.repo(root).changed(theirs, to).length; } catch { /* 모름 */ } }
      }
      return n;
    };
    const put = (fl: Flow, current: boolean, marks: Record<string, Mark>) => {
      out[fl.id] = marks;
      file[fl.id] = {};
      for (const t of allItems(fl.plan)) file[fl.id][t.id] = { mark: marks[t.id] ?? "none", files: marks[t.id] && marks[t.id] !== "none" ? count(fl, t, current) : 0 };
    };
    try {
      put(cur, true, taskMarks(this.dir, cur, true, latest));
      for (const fl of this.completedFlows()) {
        const lat: Record<string, string> = {};
        for (const root of Object.keys(fl.shadow ?? {})) { const r = Object.keys(latest).find((x) => samePath(x, root)); if (r) lat[root] = latest[r]; }
        put(fl, false, taskMarks(this.dir, fl, false, lat));
      }
      writeAtomic(join(this.dir, "marks.json"), JSON.stringify({ at: Date.now(), flows: file }));
    } catch { /* 기호 계산 실패는 화면에 기호를 보이지 않을 뿐 */ }
    return out;
  }

  findNode(id: string): FlowNode | undefined {
    const f = this.load();
    const k = id.trim().toLowerCase();
    return f.nodes.find((n) => n.id === k || (k.length >= 7 && n.commit.startsWith(k)));
  }
}

// ---------------------------------------------------------------- 렌더링

const short = (h: string) => h.slice(0, 8);
const dec = (d: Decision) => `${d.text}${d.why ? ` (why: ${d.why})` : ""}`;

/**
 * 모델 컨텍스트에 넣을 작업 상태. maxChars 안에 들어가도록 최근 노드는 결정 사항까지, 오래된 노드는 제목만 넣는다.
 */
export function renderContext(f: Flow, maxChars = 6000, mode: "continue" | "reference" = "continue"): string {
  const b = f.buffer;
  // continue: 같은 작업을 이어서 하는 경우 (세션 넘기기 · compaction 교체)
  // reference: 새 세션의 새 요청 — 마지막 기록이 이번 요청과 다른 작업일 수 있다
  const head: string[] = mode === "continue"
    ? ["[oxy-flow] Task state (from .oxy/flow — this is the source of truth for earlier work)",
      `Goal: ${f.goal || "(not set — record it with flow_note kind=goal)"}`]
    : ["[oxy-flow] Task state — the last task recorded in this project (from .oxy/flow). Use it if the request continues that work.",
      `Last task goal: ${f.goal || "(not set)"}`,
      "If the user's request is a different task, first call flow_note(kind=\"goal\") with the new goal."];
  if (f.status === "done") head.push("Status: done");
  // pi 를 시작한 폴더와 다른 저장소에서 작업 중이면 알린다 (cd 를 잊고 엉뚱한 폴더에서 git · 빌드를 하지 않게)
  if (f.work) head.push(`Work repository: ${f.work.root} (pi was started elsewhere; run git and builds there)`);
  const next = nextStep(f.plan) ?? f.next;   // 계획이 있으면 첫 doing(없으면 todo) 할 일
  if (next) head.push(`Next: ${next}`);
  if (f.blocked) head.push(`Blocked: ${f.blocked}`);
  if (f.plan.length) head.push("Plan (update it with flow_plan):", ...renderPlanLines(f.plan, { maxChars: Math.floor(maxChars * 0.4) }));

  const tail: string[] = [];
  if (b.decisions.length || b.files.length || b.failures.length || b.jobs.length) {
    tail.push("", "Uncommitted work since the last commit:");
    for (const d of b.decisions) tail.push(`- decision: ${dec(d)}`);
    if (b.files.length) tail.push(`- changed files: ${b.files.slice(-30).join(", ")}${b.files.length > 30 ? ` (+${b.files.length - 30} more)` : ""}`);
    for (const x of b.failures) tail.push(`- unresolved failure: \`${x.command}\`\n  ${x.tail.trim().split("\n").slice(-4).join("\n  ")}`);
    for (const j of b.jobs.slice(-5)) tail.push(`- job: ${j}`);
  }
  tail.push("", "Use flow_show(node=\"nN\") for details of an older step. Record new decisions with flow_note.");

  const budget = maxChars - head.join("\n").length - tail.join("\n").length - 80; // 80: 구역 제목·줄바꿈
  const nodes = [...f.nodes].reverse();
  const full: string[] = [];
  const titles: string[] = [];
  let used = 0;
  for (const n of nodes) {
    const lines = [`- ${n.id} ${short(n.commit)} ${n.title}${n.external ? " (outside pi)" : ""}`];
    for (const d of n.decisions) lines.push(`    · ${dec(d)}`);
    const text = lines.join("\n");
    if (titles.length === 0 && used + text.length <= budget * 0.8) { full.push(text); used += text.length + 1; }
    else {
      const t = `${n.id} ${n.title.slice(0, 60)}`;
      if (used + t.length + 3 > budget) { titles.push("…"); break; }
      titles.push(t); used += t.length + 3;
    }
  }
  const mid: string[] = [];
  if (full.length) mid.push("", "Steps (commits, newest first):", ...full);
  if (titles.length) mid.push(`Older steps: ${titles.join(" | ")}`);
  // 세션 넘기기: 앞 세션의 마지막 요청 · 답 (사용자의 새 메시지는 이 답에 대한 대답일 수 있다 — 선택지 번호 · 승인)
  const h = mode === "continue" && f.handoff ? f.handoff : null;
  const hand = h ? ["", "The session was switched to save context. The last exchange in the previous session:",
    ...(h.user ? [`User: ${h.user}`] : []), ...(h.reply ? [`You replied: ${h.reply}`] : []),
    "The user's next message may answer that reply (for example a choice number or an approval). Read it in that light."] : [];
  return [...head, ...mid, ...hand, ...tail].join("\n");
}

export function renderNode(n: FlowNode): string {
  return [`${n.id} ${n.commit} ${n.title}${n.external ? " (commit made outside pi)" : ""}`,
    `time: ${new Date(n.at).toISOString()}`,
    n.decisions.length ? `decisions:\n${n.decisions.map((d) => `- ${dec(d)}`).join("\n")}` : "decisions: (none recorded)",
    n.files.length ? `files: ${n.files.join(", ")}` : ""].filter(Boolean).join("\n");
}

export function renderMarkdown(f: Flow): string {
  const out = [`# ${f.goal || "(목표 미정)"}`, "", `- 작업: ${f.id} · ${f.status} · 시작 ${new Date(f.startedAt).toLocaleString()}`];
  const next = nextStep(f.plan) ?? f.next;
  if (next) out.push(`- 다음: ${next}`);
  if (f.blocked) out.push(`- 막힘: ${f.blocked}`);
  if (f.plan.length) out.push("", "## 계획", "", ...renderPlanMarkdown(f.plan));
  out.push("", "## 단계 (커밋)");
  if (!f.nodes.length) out.push("", "(아직 커밋 없음)");
  for (const n of f.nodes) {
    out.push("", `### ${n.id} \`${short(n.commit)}\` ${n.title}${n.external ? " _(pi 밖 커밋)_" : ""}`);
    for (const d of n.decisions) out.push(`- ${dec(d)}`);
    if (n.files.length) out.push(`- 파일: ${n.files.join(", ")}`);
  }
  const b = f.buffer;
  out.push("", "## 커밋 전 작업");
  for (const d of b.decisions) out.push(`- 결정: ${dec(d)}`);
  if (b.files.length) out.push(`- 변경 파일: ${b.files.join(", ")}`);
  for (const x of b.failures) out.push(`- 실패: \`${x.command}\``);
  for (const j of b.jobs) out.push(`- 작업: ${j}`);
  return `${out.join("\n")}\n`;
}

/** 결정 사항 검색 (결정 추적): 키워드가 들어간 결정과 그 노드 */
export function traceDecisions(f: Flow, keyword: string): string[] {
  const k = keyword.toLowerCase();
  const hits: string[] = [];
  for (const n of f.nodes) for (const d of n.decisions) if (dec(d).toLowerCase().includes(k)) hits.push(`${n.id} ${short(n.commit)} ${n.title}: ${dec(d)}`);
  for (const d of f.buffer.decisions) if (dec(d).toLowerCase().includes(k)) hits.push(`(uncommitted): ${dec(d)}`);
  return hits;
}

/** dir 이 path 를 담는 폴더면 상대 경로 (아니면 null) */
function relativeTo(dir: string, path: string): string | null {
  const n = (p: string) => { const s = p.replace(/\\/g, "/").replace(/\/+$/, ""); return process.platform === "win32" ? s.toLowerCase() : s; };
  const d = n(dir), p = n(path);
  return p === d ? "" : p.startsWith(`${d}/`) ? p.slice(d.length + 1) : null;
}

/** 끝난 Flow (archive/*.json, 최근 것부터 keep 개). withFile: 파일 경로를 __file 로 붙인다 */
export function readCompleted(flowDir: string, keep: number, withFile = false): Flow[] {
  const arch = join(flowDir, "archive");
  let names: string[] = [];
  try { names = readdirSync(arch).filter((n) => n.endsWith(".json")); } catch { return []; }
  const out: Flow[] = [];
  for (const n of names) {
    try {
      const fl = JSON.parse(readFileSync(join(arch, n), "utf8")) as Flow;
      if (!Array.isArray(fl.plan)) fl.plan = [];
      if (withFile) (fl as any).__file = join(arch, n);
      out.push(fl);
    } catch { /* 깨진 파일은 건너뛴다 */ }
  }
  return out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).slice(0, keep);
}

/** archive/ 의 보관 기록을 최근 keep 개만 남긴다 (수정 시각 기준, 방금 쓴 파일은 지우지 않는다) */
export function pruneArchive(dir: string, keep: number, justWritten?: string): number {
  let files: { path: string; at: number }[] = [];
  try {
    files = readdirSync(dir).filter((n) => n.endsWith(".json")).map((n) => {
      const path = join(dir, n);
      let at = 0;
      try { at = statSync(path).mtimeMs; } catch { /* 지워진 파일 */ }
      return { path, at };
    });
  } catch { return 0; }
  files.sort((a, b) => b.at - a.at);
  let removed = 0;
  for (const f of files.slice(keep)) {
    if (f.path === justWritten) continue;
    try { rmSync(f.path, { force: true }); removed++; } catch { /* 다른 프로세스가 쓰는 중 */ }
  }
  return removed;
}
