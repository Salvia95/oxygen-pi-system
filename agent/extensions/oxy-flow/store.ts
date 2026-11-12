// oxy-flow 기본(내장) 작업 기록 엔진.
//   <프로젝트>/.oxy/flow/flow.json   작업 하나의 그래프: 커밋 단위 노드 + 각 노드의 결정 사항
//   <프로젝트>/.oxy/flow/FLOW.md     사람이 읽는 같은 내용 (변경할 때마다 다시 씀)
//   <프로젝트>/.oxy/flow/lock        쓰기 락 {pid, at} — 다른 살아 있는 pi 가 쥐고 있으면 읽기 전용
//   <프로젝트>/.oxy/flow/archive/    끝난 작업
// 엔진 경계(FlowEngine)를 두어 나중에 flowout 으로 바꿀 수 있게 한다. pi 에 의존하지 않아 단위 테스트가 가능하다.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type PlanInput, type PlanItem, addItem, currentItem, nextStep, renderPlanLines, renderPlanMarkdown, setPlan, updateItem } from "./plan.ts";

export type NoteKind = "decision" | "goal" | "next" | "blocked" | "done";
export interface Decision { at: number; text: string; why?: string }
export interface Failure { at: number; command: string; tail: string }
export interface FlowNode {
  id: string;            // n1, n2 …
  commit: string;        // git 커밋 해시 (짧은 형태 아님)
  title: string;         // 커밋 제목
  at: number;
  external?: boolean;    // pi 밖에서 만든 커밋 (나중에 발견)
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
  continueAt?: number;       // 세션 넘기기 표시 (store.markContinue)
  plan: PlanItem[];          // 앞으로 할 일: 항목 → 할 일 (plan.ts). 예전 파일에는 없다 (load 가 빈 배열로 채움)
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

const MAX_COMMANDS = 15, MAX_FAILURES = 5, MAX_FILES = 200, MAX_JOBS = 10;
const empty = (): Buffer => ({ decisions: [], files: [], commands: [], failures: [], jobs: [] });

export function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim();
  } catch { return null; }
}

/** 기록을 둘 프로젝트 루트: git 저장소면 최상위, 아니면 cwd */
export function projectRoot(cwd: string): string {
  return git(cwd, ["rev-parse", "--show-toplevel"]) ?? cwd;
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; }
}

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

export class FileFlowEngine implements FlowEngine {
  readonly dir: string;
  readonly root: string;
  writable = false;
  lockOwner: number | null = null;
  private flow: Flow | null = null;

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
    return { version: 1, id: `flow-${new Date(now).toISOString().slice(0, 19).replace(/[-:T]/g, "")}`, goal, next: "", blocked: "",
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
    const item = updateItem(this.load().plan, id, change);
    this.save();
    return item;
  }

  /** 세션 넘기기 직전에 표시: 다음 세션의 첫 요청은 같은 작업을 이어 가는 것 (2분 안에 쓰지 않으면 무효) */
  markContinue(): void {
    this.load().continueAt = Date.now();
    this.save();
  }

  /** 이어 가기 표시가 있으면 지우고 true */
  takeContinue(): boolean {
    const f = this.load();
    const on = typeof f.continueAt === "number" && Date.now() - f.continueAt < 120000;
    if (f.continueAt !== undefined) { delete f.continueAt; this.save(); }
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

  /**
   * 마지막 노드 이후 git 에 생긴 커밋을 노드로 만든다. 버퍼의 결정 사항·파일은 가장 최근 커밋 노드로 옮긴다.
   * pi 밖에서 사람이 한 커밋도 다음 호출 때 잡힌다 (external).
   */
  syncCommits(external = false): FlowNode[] {
    const f = this.load();
    const head = git(this.root, ["rev-parse", "HEAD"]);
    if (!head) return [];
    const last = f.nodes.at(-1)?.commit ?? f.baseCommit;
    if (last === head) return [];
    let hashes: string[] = [];
    const range = last ? git(this.root, ["rev-list", "--reverse", "--first-parent", `${last}..${head}`]) : null;
    if (range != null) hashes = range.split("\n").filter(Boolean);
    if (!hashes.length) hashes = [head]; // 브랜치 전환·rebase 등으로 이전 커밋이 조상이 아니면 HEAD 만 기록
    hashes = hashes.slice(-20);
    const made: FlowNode[] = [];
    for (const [i, h] of hashes.entries()) {
      const isLast = i === hashes.length - 1;
      const node: FlowNode = {
        id: `n${f.nodes.length + 1}`, commit: h, title: git(this.root, ["log", "-1", "--format=%s", h]) ?? "", at: Date.now(),
        ...(external ? { external: true } : {}),
        decisions: isLast ? f.buffer.decisions : [],
        // 커밋에 실제로 들어간 파일 (bash 로 만든 파일 포함)
        files: (git(this.root, ["show", "--name-only", "--format=", h]) ?? "").split("\n").filter(Boolean).slice(0, MAX_FILES),
      };
      f.nodes.push(node);
      made.push(node);
    }
    // 지금 진행 중인 할 일에 커밋을 붙인다 (계획이 있을 때)
    const cur = currentItem(f.plan);
    if (cur) for (const n of made) if (!cur.nodes.includes(n.id)) cur.nodes.push(n.id);
    f.buffer = { ...empty(), failures: f.buffer.failures, jobs: f.buffer.jobs };
    this.save();
    return made;
  }

  startNew(goal: string): Flow {
    const f = this.load();
    if (this.hasContent()) {
      const arch = join(this.dir, "archive");
      mkdirSync(arch, { recursive: true });
      writeAtomic(join(arch, `${f.id}.json`), JSON.stringify(f, null, 1));
    }
    this.flow = this.fresh(goal.trim());
    this.save();
    return this.flow;
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
  return [...head, ...mid, ...tail].join("\n");
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
