// oxy-jobs 작업 관리자: 백그라운드 bash 작업과 subagent 를 같은 목록·대기열·로그로 관리한다.
//   로그는 실행 폴더(agent/jobs/run-<pid>-<시작 시각>/logs/)에 둔다. 상태 파일 형식은 state.ts
import { type ChildProcess, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, type WriteStream } from "node:fs";
import { dirname, join, relative } from "node:path";
import { type JobsState, type JobSnapshot, STATE_VERSION, clipResult, lastLine, runDirName } from "./state.ts";

export type JobKind = "bash" | "agent";
export type JobState = "queued" | "running" | "done" | "failed" | "stopped";

export interface Job {
  id: string;
  kind: JobKind;
  label: string;          // 화면 표시용 (명령 또는 "scout: 작업 요약")
  agent?: string;         // kind=agent: agent 이름
  task?: string;          // 맡긴 작업 전문 (bash: 명령 전문)
  target?: JobTarget;     // kind=agent: 자식 pi 가 쓰는 작업 수준 · 연결 · 모델 · thinking
  state: JobState;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  exitCode?: number | null;
  logFile: string;
  tail: string[];         // 마지막 출력 줄 (최대 TAIL_MAX)
  result?: string;        // subagent 최종 답변
  usage?: { turns: number; input: number; output: number };
  reported: boolean;      // 완료를 모델에게 알렸는지
  notify: boolean;        // 완료 시 모델에게 알릴지 (wait:false 로 시작한 작업)
  proc?: ChildProcess;
  kill?: () => void;      // 작업을 끝내는 방법 (bash 작업: MSYS 프로세스 그룹까지). 없으면 killTree(proc)
}

const TAIL_MAX = 200;

/** subagent 가 쓰는 모델 (작업 수준 · agent 정의 · 부모에서 정해진 값) */
export interface JobTarget { level?: string; connection?: string; provider?: string; model?: string; thinking?: string }

/** 동시 실행 개수 제한 (FIFO) */
export class Semaphore {
  private active = 0;
  private waiters: Array<() => void> = [];
  limit: number;
  constructor(limit: number) { this.limit = limit; }
  get running() { return this.active; }
  get waiting() { return this.waiters.length; }
  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) await new Promise<void>((ok) => this.waiters.push(ok));
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.waiters.shift()?.();
    };
  }
}

/** vLLM /metrics 에서 대기·실행 중 요청 수와 KV 캐시 사용률을 읽는다 (지표 이름은 버전마다 달라 여러 이름을 본다) */
export function parseVllmMetrics(text: string): { waiting: number; running: number; kvCache: number | null } {
  const sum = (names: string[]) => {
    let total = 0;
    let found = false;
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith("#")) continue;
      const m = line.match(/^([a-zA-Z_:]+)(?:\{[^}]*\})?\s+([0-9.eE+-]+)/);
      if (m && names.includes(m[1])) { total += Number(m[2]); found = true; }
    }
    return found ? total : null;
  };
  return {
    waiting: sum(["vllm:num_requests_waiting"]) ?? 0,
    running: sum(["vllm:num_requests_running"]) ?? 0,
    kvCache: sum(["vllm:kv_cache_usage_perc", "vllm:gpu_cache_usage_perc"]),
  };
}

/** Windows 에서는 자식까지 함께 종료해야 bash 가 띄운 프로세스가 남지 않는다 */
export function killTree(proc: ChildProcess | undefined) {
  if (!proc?.pid || proc.exitCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { windowsHide: true });
  else proc.kill("SIGTERM");
}

const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * bash 작업 명령: 먼저 bash 의 MSYS pid 를 pidFile 에 적고 나서 명령을 실행한다.
 * Git Bash(MSYS)는 fork/exec 를 흉내 내느라 손자 프로세스의 Windows 부모가 사라져 있어 taskkill /T 로는 끝나지 않는다
 * (서버 · sleep 이 남고 출력 파이프가 닫히지 않는다). 대신 Windows 프로세스가 띄운 MSYS bash 는 자기 프로세스 그룹의 리더이므로
 * 그 그룹 전체를 MSYS kill 로 끝낸다 (bashKiller).
 */
export function bashJobScript(command: string, pidFile: string): string {
  return `printf %s "$$" > ${shQuote(pidFile.replace(/\\/g, "/"))}\n${command}`;
}

/** bashJobScript 로 시작한 작업을 끝낸다: MSYS 프로세스 그룹 → 실패하면 그 bash 하나 → 마지막으로 Windows 트리 */
export function bashKiller(shell: string, proc: ChildProcess, pidFile: string): () => void {
  return () => {
    let pid = "";
    try { pid = readFileSync(pidFile, "utf8").trim(); } catch { /* 아직 시작 전 */ }
    if (/^\d+$/.test(pid) && proc.exitCode === null) {
      spawnSync(shell, ["-c", `kill -9 -- -${pid} 2>/dev/null || kill -9 ${pid} 2>/dev/null`], { windowsHide: true, timeout: 5000 });
    }
    killTree(proc);
  };
}

export function fmtDuration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

export class JobManager {
  jobs = new Map<string, Job>();
  private seq = 0;
  private listeners = new Set<() => void>();
  readonly bashSlots: Semaphore;
  readonly agentSlots: Semaphore;              // 연결을 모를 때(llm.json 없음)의 subagent 동시 실행 제한
  private connSlots = new Map<string, Semaphore>();

  readonly jobsDir: string;
  readonly runDir: string;    // 이 실행(세션)의 폴더. 첫 작업의 로그를 쓸 때 만든다
  readonly startedAt: number;
  constructor(jobsDir: string, opts: { maxBash: number; maxAgents: number }) {
    this.jobsDir = jobsDir;
    this.startedAt = Date.now();
    this.runDir = join(jobsDir, runDirName(process.pid, this.startedAt));
    this.bashSlots = new Semaphore(opts.maxBash);
    this.agentSlots = new Semaphore(opts.maxAgents);
    mkdirSync(jobsDir, { recursive: true });
  }

  /** 연결마다 따로 두는 subagent 동시 실행 제한 (사내 vLLM 이 꽉 차도 다른 연결로 가는 작업은 기다리지 않는다) */
  slotsFor(connection: string | undefined, limit: number): Semaphore {
    if (!connection) return this.agentSlots;
    let s = this.connSlots.get(connection);
    if (!s) { s = new Semaphore(limit); this.connSlots.set(connection, s); }
    s.limit = limit;
    return s;
  }

  /** 모든 subagent 슬롯 (상태줄 · 상태 파일) */
  agentSlotTotals(): { running: number; limit: number; waiting: number } {
    // 연결별 슬롯을 쓰면 기본 슬롯은 쓰는 중일 때만 센다 (llm.json 이 있으면 보통 쓰지 않는다)
    const all = [this.agentSlots, ...this.connSlots.values()].filter((s, i) => i > 0 || s.running || s.waiting || !this.connSlots.size);
    return { running: all.reduce((n, s) => n + s.running, 0), limit: all.reduce((n, s) => n + s.limit, 0), waiting: all.reduce((n, s) => n + s.waiting, 0) };
  }

  onChange(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  changed() { for (const fn of this.listeners) { try { fn(); } catch { /* UI 오류는 무시 */ } } }

  create(kind: JobKind, label: string, notify: boolean, extra: { agent?: string; task?: string; target?: JobTarget } = {}): Job {
    const id = `job-${++this.seq}`;
    const job: Job = {
      id, kind, label, ...extra, state: "queued", createdAt: Date.now(), logFile: join(this.runDir, "logs", `${id}.log`),
      tail: [], reported: !notify, notify,
    };
    this.jobs.set(id, job);
    this.changed();
    return job;
  }

  /** 로그 파일과 tail 에 한 줄 기록 */
  writer(job: Job): { line: (s: string) => void; chunk: (s: string) => void; close: () => void } {
    mkdirSync(dirname(job.logFile), { recursive: true });
    const stream: WriteStream = createWriteStream(job.logFile, { flags: "a" });
    let partial = "";
    const push = (l: string) => { job.tail.push(l); if (job.tail.length > TAIL_MAX) job.tail.shift(); };
    return {
      line: (s) => { stream.write(s + "\n"); push(s); this.changed(); },
      chunk: (s) => {
        stream.write(s);
        const parts = (partial + s).split(/\r?\n/);
        partial = parts.pop() ?? "";
        for (const p of parts) push(p);
        if (parts.length) this.changed();
      },
      close: () => { if (partial) push(partial); stream.end(); },
    };
  }

  get(id: string) { return this.jobs.get(id); }
  list() { return [...this.jobs.values()]; }
  active() { return this.list().filter((j) => j.state === "queued" || j.state === "running"); }
  unreported() { return this.list().filter((j) => !j.reported && j.state !== "queued" && j.state !== "running"); }

  stop(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || (job.state !== "running" && job.state !== "queued")) return false;
    job.state = "stopped";
    job.endedAt = Date.now();
    if (job.kill) job.kill(); else killTree(job.proc);
    this.changed();
    return true;
  }

  stopAll() { for (const j of this.active()) this.stop(j.id); }

  /** 작업이 끝날 때까지 기다린다 (timeoutMs 가 지나면 false) */
  waitAll(jobs: Job[], timeoutMs: number): Promise<boolean> {
    const done = () => jobs.every((j) => j.state !== "queued" && j.state !== "running");
    if (done()) return Promise.resolve(true);
    return new Promise((ok) => {
      const t = setTimeout(() => { off(); ok(false); }, timeoutMs);
      const off = this.onChange(() => { if (done()) { clearTimeout(t); off(); ok(true); } });
    });
  }

  /** 모니터용 상태 (state.ts 의 JobsState) */
  snapshot(cwd: string, control: JobsState["control"] = null): JobsState {
    const slot = (s: Semaphore) => ({ running: s.running, limit: s.limit, waiting: s.waiting });
    const jobs: JobSnapshot[] = this.list().map((j) => ({
      id: j.id, kind: j.kind, state: j.state, label: j.label,
      ...(j.agent ? { agent: j.agent } : {}), ...(j.task ? { task: j.task } : {}), ...(j.target ? { target: { ...j.target } } : {}),
      createdAt: j.createdAt, startedAt: j.startedAt ?? null, endedAt: j.endedAt ?? null, exitCode: j.exitCode ?? null,
      usage: j.usage ? { ...j.usage } : null,
      log: relative(this.runDir, j.logFile).replace(/\\/g, "/"),
      last: lastLine(j.tail), result: clipResult(j.result),
    }));
    return {
      version: STATE_VERSION, pid: process.pid, startedAt: this.startedAt, updatedAt: Date.now(), closed: false,
      cwd: cwd.replace(/\\/g, "/"), slots: { agents: this.agentSlotTotals(), bash: slot(this.bashSlots),
        byConnection: Object.fromEntries([...this.connSlots].map(([k, v]) => [k, slot(v)])) }, jobs, control,
    };
  }

  /** 이전 버전이 jobs 폴더 바로 아래에 남긴 로그 정리 (최근 keep 개만 남김) */
  pruneLogs(keep = 50) {
    if (!existsSync(this.jobsDir)) return;
    const files = readdirSync(this.jobsDir).filter((f) => f.endsWith(".log"))
      .map((f) => ({ f, t: statSync(join(this.jobsDir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(keep)) rmSync(join(this.jobsDir, f), { force: true });
  }
}
