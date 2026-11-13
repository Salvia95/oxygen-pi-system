// oxy-jobs 의 background 도구 줄 (docs/ui-unify-spec.md §2.5) 순수 함수. 결과 글은 oxy-jobs/index.ts 의 모양을 읽기만 한다:
//   start  → `Started job-1: <명령>\nYou will get a message …`
//   status → `No jobs.` 또는 `<id> <kind> <state>[ exit=N] <걸린 시간> <이름>` 줄들
//   output → `<id> <state>\n<마지막 줄들>`
//   stop   → `Stopped job-1.` 또는 `job-1 is not running (<state>).`
import { commandHead } from "./basic.ts";

/** 작업 상태 → 한국어 (oxy-jobs 의 JobState) */
export const JOB_STATE: Record<string, string> = {
  queued: "대기", running: "실행 중", done: "끝남", failed: "실패", stopped: "중지됨",
};
const stateKo = (s: string) => JOB_STATE[s] ?? s;

/** 첫 줄 인자: `start <명령 첫 줄>` · `status` · `output job-1` · `stop job-1` */
export function backgroundArgs(a: any): string {
  const action = String(a?.action ?? "");
  if (action === "start") return `start ${commandHead(a?.command)}`;
  if (action === "status") return "status";
  return [action, a?.id].filter(Boolean).join(" ");
}

export interface JobView { summary: string; level: "success" | "error" | "text" | "warning"; body: string[]; keep: "head" | "tail" }

export function backgroundView(action: string, text: string): JobView {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (action === "start") {
    const m = lines[0].match(/^Started (\S+):/);
    return m ? { summary: `${m[1]} 시작 · 끝나면 알림`, level: "success", body: [], keep: "head" } : { summary: lines[0], level: "text", body: lines.slice(1), keep: "head" };
  }
  if (action === "status") {
    if (text.trim() === "No jobs.") return { summary: "작업 없음", level: "text", body: [], keep: "head" };
    const rows = lines.filter((l) => l.trim());
    const body = rows.map((l) => l.replace(/^(\S+) (\S+) (\S+)/, (_all, id, kind, st) => `${id} ${kind} ${stateKo(st)}`));
    const running = rows.filter((l) => /^\S+ \S+ (running|queued)\b/.test(l)).length;
    return { summary: `작업 ${rows.length}개${running ? ` · ${running}개 실행 중` : ""}`, level: "text", body, keep: "head" };
  }
  if (action === "output") {
    const m = lines[0].match(/^(\S+) (\S+)$/);
    const out = lines.slice(1);
    while (out.length && !out.at(-1)!.trim()) out.pop();
    return m
      ? { summary: `${m[1]} ${stateKo(m[2])} · 출력 ${out.length}줄`, level: m[2] === "failed" ? "error" : "text", body: out, keep: "tail" }
      : { summary: "출력", level: "text", body: lines, keep: "tail" };
  }
  if (action === "stop") {
    const s = lines[0].match(/^Stopped (\S+)\.$/);
    if (s) return { summary: `${s[1]} 중지함`, level: "success", body: [], keep: "head" };
    const n = lines[0].match(/^(\S+) is not running \((\S+)\)\.$/);
    if (n) return { summary: `${n[1]}: 실행 중이 아님 (${stateKo(n[2])})`, level: "warning", body: [], keep: "head" };
  }
  return { summary: lines[0] ?? "", level: "text", body: lines.slice(1), keep: "head" };
}
