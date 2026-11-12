// oxy-jobs 상태 파일: 모니터 pane(별도 프로세스)이 작업 목록을 보고 중지를 요청할 수 있게 한다 (docs/monitor-spec.md §3).
//   agent/jobs/run-<pid>-<시작 시각>/state.json   현재 상태 (임시 파일에 쓰고 이름 바꾸기)
//   agent/jobs/run-<pid>-<시작 시각>/logs/        작업 로그
//   agent/jobs/run-<pid>-<시작 시각>/control/     모니터 → pi 요청 ({seq, op:"stop", id})
// pi 에 의존하지 않는다: pi 쪽(writer · inbox)과 모니터 쪽(find · read · send)이 같은 형식을 이 파일에서 가져다 쓴다.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "../_lib/common.ts";

export { writeAtomic };

export const STATE_VERSION = 1;
const RESULT_MAX = 2000;

export type JobKindS = "bash" | "agent";
export type JobStateS = "queued" | "running" | "done" | "failed" | "stopped";

export interface JobSnapshot {
  id: string;
  kind: JobKindS;
  state: JobStateS;
  label: string;
  agent?: string;
  task?: string;
  target?: { level?: string; connection?: string; provider?: string; model?: string; thinking?: string }; // subagent 의 작업 수준 · 연결 · 모델 · thinking
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  exitCode: number | null;
  usage: { turns: number; input: number; output: number } | null;
  log: string;          // 실행 폴더 기준 상대 경로 (/ 구분)
  last: string;         // 마지막 출력 한 줄
  result: string | null; // subagent 최종 답변 앞부분
}

export interface SlotSnapshot { running: number; limit: number; waiting: number }

export interface ControlResult { seq: string; ok: boolean; message: string; at: number }

export interface JobsState {
  version: number;
  pid: number;
  startedAt: number;
  updatedAt: number;
  closed: boolean;      // pi 가 이 실행을 끝냈다 (세션 종료 · 교체). 모니터는 새 실행 폴더로 옮겨 가거나 끝낸다
  cwd: string;
  slots: { agents: SlotSnapshot; bash: SlotSnapshot; byConnection?: Record<string, SlotSnapshot> };
  jobs: JobSnapshot[];
  control: ControlResult | null;
}

export interface ControlRequest { seq: string; op: "stop"; id: string }

/** 실행 폴더 이름: run-<pid>-<시작 시각 ms> */
export const runDirName = (pid: number, startedAt: number) => `run-${pid}-${startedAt}`;

export function parseRunDirName(name: string): { pid: number; startedAt: number } | null {
  const m = name.match(/^run-(\d+)-(\d+)$/);
  return m ? { pid: Number(m[1]), startedAt: Number(m[2]) } : null;
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; }
}

/** 마지막 출력 한 줄 (빈 줄 제외, 공백 정리) */
export function lastLine(tail: string[], max = 200): string {
  for (let i = tail.length - 1; i >= 0; i--) {
    const t = tail[i].replace(/\s+/g, " ").trim();
    if (t) return t.slice(0, max);
  }
  return "";
}

export function clipResult(s: string | undefined | null): string | null {
  if (s == null) return null;
  return s.length > RESULT_MAX ? `${s.slice(0, RESULT_MAX)} …` : s;
}

// ---------------------------------------------------------------- pi 쪽: 상태 쓰기

/**
 * 변경이 생기면 상태 파일을 다시 쓴다. 변경은 minGapMs(기본 250ms = 초당 4번) 간격으로 묶고,
 * 변경이 없어도 heartbeatMs(기본 5초)마다 updatedAt 을 갱신해 모니터가 pi 가 살아 있는지 알 수 있게 한다.
 */
export class StateWriter {
  readonly file: string;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private beat: ReturnType<typeof setInterval> | null = null;
  private lastWrite = 0;
  private stopped = false;
  private snapshot: () => any;
  private minGapMs: number;

  /** fileName: 같은 실행 폴더에 다른 상태 파일을 쓸 때 (oxy-monitor 의 live.json) */
  constructor(runDir: string, snapshot: () => any, opts: { minGapMs?: number; heartbeatMs?: number; fileName?: string } = {}) {
    mkdirSync(runDir, { recursive: true });
    this.file = join(runDir, opts.fileName ?? "state.json");
    this.snapshot = snapshot;
    this.minGapMs = opts.minGapMs ?? 250;
    const hb = opts.heartbeatMs ?? 5000;
    if (hb > 0) { this.beat = setInterval(() => this.flush(), hb); this.beat.unref?.(); }
    this.flush();
  }

  /** 변경 알림: 곧(최대 minGapMs 뒤) 다시 쓴다 */
  changed(): void {
    if (this.stopped || this.timer) return;
    const wait = Math.max(0, this.lastWrite + this.minGapMs - Date.now());
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, wait);
    this.timer.unref?.();
  }

  flush(): void {
    if (this.stopped) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.lastWrite = Date.now();
    try { writeAtomic(this.file, JSON.stringify(this.snapshot(), null, 1)); } catch { /* 모니터용 부가 기능: 실패해도 작업은 계속 */ }
  }

  /** 마지막으로 closed=true 를 쓰고 멈춘다 */
  close(): void {
    if (this.stopped) return;
    if (this.beat) { clearInterval(this.beat); this.beat = null; }
    try {
      const s = this.snapshot();
      writeAtomic(this.file, JSON.stringify({ ...s, closed: true, updatedAt: Date.now() }, null, 1));
    } catch { /* 무시 */ }
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.stopped = true;
  }
}

// ---------------------------------------------------------------- pi 쪽: 요청 받기

/**
 * control/ 폴더의 요청 파일을 이름 순서대로 처리하고 지운다. fs.watch 로 바로 반응하고, watch 가 놓치는 경우를 위해 pollMs 마다 확인한다.
 * handle 은 처리 결과를 돌려준다. 결과는 onResult 로 넘겨 상태 파일에 싣는다.
 */
export class ControlInbox {
  readonly dir: string;
  private watcher: FSWatcher | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private handle: (req: ControlRequest) => { ok: boolean; message: string };
  private onResult: (r: ControlResult) => void;

  constructor(runDir: string, handle: (req: ControlRequest) => { ok: boolean; message: string },
    onResult: (r: ControlResult) => void, opts: { pollMs?: number } = {}) {
    this.dir = join(runDir, "control");
    mkdirSync(this.dir, { recursive: true });
    this.handle = handle;
    this.onResult = onResult;
    try { this.watcher = watch(this.dir, () => this.drain()); this.watcher.on("error", () => { /* poll 이 대신한다 */ }); } catch { /* poll 만 */ }
    const pollMs = opts.pollMs ?? 1000;
    if (pollMs > 0) { this.poll = setInterval(() => this.drain(), pollMs); this.poll.unref?.(); }
    this.drain();
  }

  drain(): void {
    if (this.busy) return;
    this.busy = true;
    try {
      let names: string[] = [];
      try { names = readdirSync(this.dir).filter((f) => f.endsWith(".json")).sort(); } catch { return; }
      for (const name of names) {
        const file = join(this.dir, name);
        let req: any;
        try { req = JSON.parse(readFileSync(file, "utf8")); } catch {
          // 쓰는 중이라 아직 읽을 수 없는 파일일 수 있다: 10초가 지나도 깨져 있으면 버린다
          try { if (Date.now() - statSync(file).mtimeMs > 10000) rmSync(file, { force: true }); } catch { /* 무시 */ }
          continue;
        }
        rmSync(file, { force: true });
        const seq = typeof req?.seq === "string" ? req.seq : name.replace(/\.json$/, "");
        let r: { ok: boolean; message: string };
        if (req?.op !== "stop") r = { ok: false, message: `unknown op: ${String(req?.op)}` };
        else if (typeof req.id !== "string" || !req.id) r = { ok: false, message: "id is required" };
        else { try { r = this.handle({ seq, op: "stop", id: req.id }); } catch (e: any) { r = { ok: false, message: String(e?.message ?? e) }; } }
        this.onResult({ seq, ...r, at: Date.now() });
      }
    } finally { this.busy = false; }
  }

  close(): void {
    this.watcher?.close(); this.watcher = null;
    if (this.poll) { clearInterval(this.poll); this.poll = null; }
  }
}

// ---------------------------------------------------------------- 모니터 쪽

/** pid 의 실행 폴더 중 가장 최근 것 (없으면 null) */
export function findRun(jobsDir: string, pid: number): string | null {
  let best: { dir: string; at: number } | null = null;
  let names: string[] = [];
  try { names = readdirSync(jobsDir); } catch { return null; }
  for (const n of names) {
    const r = parseRunDirName(n);
    if (!r || r.pid !== pid) continue;
    if (!best || r.startedAt > best.at) best = { dir: join(jobsDir, n), at: r.startedAt };
  }
  return best?.dir ?? null;
}

export function readState(runDir: string): JobsState | null {
  try {
    const s = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    return s && s.version === STATE_VERSION ? (s as JobsState) : null;
  } catch { return null; }
}

/** 요청을 보낸다. 돌려준 seq 로 state.control 에서 결과를 찾는다 */
export function sendControl(runDir: string, op: "stop", id: string): string {
  const dir = join(runDir, "control");
  mkdirSync(dir, { recursive: true });
  const seq = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  writeAtomic(join(dir, `${seq}.json`), JSON.stringify({ seq, op, id }));
  return seq;
}

// ---------------------------------------------------------------- 정리

/**
 * 실행 폴더 정리: 살아 있는 pi 의 폴더(와 except)는 남기고, 끝난 폴더는 최근 keep 개만 남긴다.
 * 지금 pid 의 이전 실행(세션 교체)도 끝난 것으로 본다.
 */
export function pruneRuns(jobsDir: string, keep = 20, except: string[] = []): void {
  if (!existsSync(jobsDir)) return;
  const dead: { dir: string; at: number }[] = [];
  for (const n of readdirSync(jobsDir)) {
    const r = parseRunDirName(n);
    if (!r) continue;
    const dir = join(jobsDir, n);
    if (except.includes(dir)) continue;
    const live = r.pid !== process.pid && pidAlive(r.pid);
    if (live) continue;
    dead.push({ dir, at: r.startedAt });
  }
  dead.sort((a, b) => b.at - a.at);
  for (const { dir } of dead.slice(keep)) rmSync(dir, { recursive: true, force: true });
}
