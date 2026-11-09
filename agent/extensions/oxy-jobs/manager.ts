// oxy-jobs 작업 관리자: 백그라운드 bash 작업과 subagent 를 같은 목록·대기열·로그로 관리한다.
import { type ChildProcess, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, type WriteStream } from "node:fs";
import { join } from "node:path";

export type JobKind = "bash" | "agent";
export type JobState = "queued" | "running" | "done" | "failed" | "stopped";

export interface Job {
  id: string;
  kind: JobKind;
  label: string;          // 화면 표시용 (명령 또는 "scout: 작업 요약")
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
}

const TAIL_MAX = 200;

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

export function fmtDuration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

export class JobManager {
  jobs = new Map<string, Job>();
  private seq = 0;
  private listeners = new Set<() => void>();
  readonly bashSlots: Semaphore;
  readonly agentSlots: Semaphore;

  readonly jobsDir: string;
  constructor(jobsDir: string, opts: { maxBash: number; maxAgents: number }) {
    this.jobsDir = jobsDir;
    this.bashSlots = new Semaphore(opts.maxBash);
    this.agentSlots = new Semaphore(opts.maxAgents);
    mkdirSync(jobsDir, { recursive: true });
  }

  onChange(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  changed() { for (const fn of this.listeners) { try { fn(); } catch { /* UI 오류는 무시 */ } } }

  create(kind: JobKind, label: string, notify: boolean): Job {
    const id = `job-${++this.seq}`;
    const job: Job = {
      id, kind, label, state: "queued", createdAt: Date.now(), logFile: join(this.jobsDir, `${Date.now()}-${id}.log`),
      tail: [], reported: !notify, notify,
    };
    this.jobs.set(id, job);
    this.changed();
    return job;
  }

  /** 로그 파일과 tail 에 한 줄 기록 */
  writer(job: Job): { line: (s: string) => void; chunk: (s: string) => void; close: () => void } {
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
    killTree(job.proc);
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

  /** 오래된 로그 정리 (최근 keep 개만 남김) */
  pruneLogs(keep = 50) {
    if (!existsSync(this.jobsDir)) return;
    const files = readdirSync(this.jobsDir).filter((f) => f.endsWith(".log"))
      .map((f) => ({ f, t: statSync(join(this.jobsDir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(keep)) rmSync(join(this.jobsDir, f), { force: true });
  }
}
