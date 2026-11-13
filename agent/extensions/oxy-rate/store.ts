// 연결별 요청 기록을 pi 프로세스들이 함께 본다 (docs/rate-limit-spec.md §4): 본 대화 · subagent · 다른 oxy 세션.
//   <agent>/rate/<연결 id>/<pid>.json = { pid, updatedAt, events: [{at, tokens}], blockedUntil }
// 프로세스마다 자기 파일만 쓰고(원자적 교체), 읽을 때 모두 더한다 → 잠금이 없다. 동시에 보낸 요청은 한도를 조금 넘을 수 있다 (soft limit).
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "../_lib/common.ts";
import { type RateEvent, WINDOW_MS } from "./limiter.ts";

interface FileState { pid: number; updatedAt: number; events: RateEvent[]; blockedUntil: number }

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; }
}

export class RateStore {
  readonly dir: string;
  private own: FileState;
  private readonly file: string;
  constructor(agentDir: string, connId: string, pid = process.pid) {
    this.dir = join(agentDir, "rate", connId.replace(/[^\w.-]/g, "_"));
    this.file = join(this.dir, `${pid}.json`);
    this.own = { pid, updatedAt: 0, events: [], blockedUntil: 0 };
  }

  private save(now: number): void {
    this.own.events = this.own.events.filter((e) => e.at > now - WINDOW_MS);
    this.own.updatedAt = now;
    try { mkdirSync(this.dir, { recursive: true }); writeAtomic(this.file, JSON.stringify(this.own)); } catch { /* 기록 실패는 이 프로세스만 세게 될 뿐 */ }
  }

  /** 요청 하나 (어림 토큰) → 나중에 실제 토큰으로 바꿀 수 있게 그 사건을 돌려준다 */
  add(at: number, tokens: number): RateEvent {
    const ev = { at, tokens: Math.max(0, Math.round(tokens)) };
    this.own.events.push(ev);
    this.save(at);
    return ev;
  }

  /** 응답이 끝나면 어림 토큰을 실제 값으로 */
  settle(ev: RateEvent, tokens: number, now: number): void {
    if (tokens > 0) ev.tokens = Math.round(tokens);
    this.save(now);
  }

  /** 서버가 429 로 알려 준 시각까지 이 연결의 요청을 멈춘다 (다른 프로세스도 읽는다) */
  block(until: number, now: number): void {
    if (until > this.own.blockedUntil) this.own.blockedUntil = until;
    this.save(now);
  }

  /** 모든 프로세스의 윈도우 안 기록 · 가장 늦은 멈춤 시각. 죽은 프로세스의 오래된 파일은 지운다 */
  readAll(now: number): { events: RateEvent[]; blockedUntil: number; processes: number } {
    const events: RateEvent[] = [...this.own.events];
    let blockedUntil = this.own.blockedUntil;
    let processes = 1;
    let names: string[] = [];
    try { names = readdirSync(this.dir).filter((n) => n.endsWith(".json")); } catch { return { events, blockedUntil, processes }; }
    for (const n of names) {
      const path = join(this.dir, n);
      if (path === this.file) continue;
      try {
        const s = JSON.parse(readFileSync(path, "utf8")) as FileState;
        if (now - (s.updatedAt ?? 0) > WINDOW_MS && !pidAlive(s.pid)) { rmSync(path, { force: true }); continue; }
        for (const e of s.events ?? []) if (e.at > now - WINDOW_MS) events.push(e);
        blockedUntil = Math.max(blockedUntil, Number(s.blockedUntil) || 0);
        processes++;
      } catch {
        try { if (now - statSync(path).mtimeMs > 10 * WINDOW_MS) rmSync(path, { force: true }); } catch { /* 이미 없음 */ }
      }
    }
    return { events, blockedUntil, processes };
  }

}
