// oxy-jobs 의 background 도구 줄 · 끝남 알림 (docs/ui-unify-spec.md §2.5) 순수 함수. 결과 글은 oxy-jobs/index.ts 의 모양을 읽기만 한다:
//   start  → `Started job-1: <명령>\nYou will get a message …`
//   status → `No jobs.` 또는 `<id> <kind> <state>[ exit=N] <걸린 시간> <이름>` 줄들
//   output → `<id> <state>\n<마지막 줄들>`
//   stop   → `Stopped job-1.` 또는 `job-1 is not running (<state>).`
//   알림   → `[oxy-jobs] job-1 done (exit 0) after 2s: <명령>\nlast output:\n…` · `[oxy-jobs] job-2 (<이름>) failed in 1m 3s, 4 turns:\n…`
// 문구 (사용자, 2026-11-13): `Job-1 done!` · `Job-1 failed..` · `Job-1 stopped..`. 색: 좋은 것 초록 · 나쁜 것 빨강 · 그 밖 노랑
import { commandHead } from "./basic.ts";

export type Tone = "success" | "error" | "warning";

/** `job-1` → `Job-1` */
export const jobName = (id: string): string => (id ? id[0].toUpperCase() + id.slice(1) : id);

/** 작업 상태 → 문구와 색 */
export function jobPhrase(state: string): { text: string; tone: Tone } {
  switch (state) {
    case "done": return { text: "done!", tone: "success" };
    case "failed": return { text: "failed..", tone: "error" };
    case "stopped": return { text: "stopped..", tone: "error" };
    case "queued": return { text: "queued..", tone: "warning" };
    case "running": return { text: "running..", tone: "warning" };
    default: return { text: `${state}..`, tone: "warning" };
  }
}

const lines = (n: number) => `${n} ${n === 1 ? "line" : "lines"}`;

/**
 * 작업 출력의 꼬리에서 oxy-jobs 가 덧붙인 줄을 뺀다: 맨 앞 `$ <명령>` (runBash 의 w.line) 과 맨 끝 `[exit N]`.
 * 실제 출력 줄 수를 세려고
 */
export function cleanTail(out: string[]): string[] {
  const o = [...out];
  while (o.length && !o.at(-1)!.trim()) o.pop();
  if (o.length && /^\[exit -?\d+\]$/.test(o.at(-1)!.trim())) o.pop();
  if (o.length && o[0].startsWith("$ ")) o.shift();
  while (o.length && !o.at(-1)!.trim()) o.pop();
  return o;
}

/** 첫 줄 인자: `start <명령 첫 줄>` · `status` · `output job-1` · `stop job-1` */
export function backgroundArgs(a: any): string {
  const action = String(a?.action ?? "");
  if (action === "start") return `start ${commandHead(a?.command)}`;
  if (action === "status") return "status";
  return [action, a?.id].filter(Boolean).join(" ");
}

export interface JobView { summary: string; level: Tone; body: string[]; keep: "head" | "tail" }

export function backgroundView(action: string, text: string): JobView {
  const ls = text.replace(/\r\n/g, "\n").split("\n");
  if (action === "start") {
    const m = ls[0].match(/^Started (\S+):/);
    return m ? { summary: `${jobName(m[1])} started..`, level: "warning", body: [], keep: "head" } : { summary: ls[0], level: "warning", body: ls.slice(1), keep: "head" };
  }
  if (action === "status") {
    if (text.trim() === "No jobs.") return { summary: "No jobs..", level: "warning", body: [], keep: "head" };
    const rows = ls.filter((l) => l.trim());
    const running = rows.filter((l) => /^\S+ \S+ (running|queued)\b/.test(l)).length;
    const failed = rows.filter((l) => /^\S+ \S+ (failed|stopped)\b/.test(l)).length;
    return { summary: `${rows.length} ${rows.length === 1 ? "job" : "jobs"}, ${running} running${failed ? `, ${failed} failed` : ""}`,
      level: failed ? "error" : "warning", body: rows.map((l) => l.replace(/^job-/, "Job-")), keep: "head" };
  }
  if (action === "output") {
    const m = ls[0].match(/^(\S+) (\S+)$/);
    const out = cleanTail(ls.slice(1));
    if (!m) return { summary: "Output", level: "warning", body: ls, keep: "tail" };
    const p = jobPhrase(m[2]);
    return { summary: `${jobName(m[1])} ${p.text}, print ${lines(out.length)}`, level: p.tone, body: out, keep: "tail" };
  }
  if (action === "stop") {
    const s = ls[0].match(/^Stopped (\S+)\.$/);
    if (s) return { summary: `${jobName(s[1])} stopped..`, level: "error", body: [], keep: "head" };
    const n = ls[0].match(/^(\S+) is not running \((\S+)\)\.$/);
    if (n) { const p = jobPhrase(n[2]); return { summary: `${jobName(n[1])} is not running (${p.text})`, level: "warning", body: [], keep: "head" }; }
  }
  return { summary: ls[0] ?? "", level: "warning", body: ls.slice(1), keep: "head" };
}

export interface JobNotice { id: string; state: string; title: string; duration: string; body: string[]; tone: Tone; summary: string }

/** 끝남 알림 메시지(customType oxy-jobs) 읽기. 모르는 모양이면 null (pi 기본 그리기) */
export function parseJobNotice(text: string): JobNotice | null {
  const ls = text.replace(/\r\n/g, "\n").split("\n");
  const bash = ls[0].match(/^\[oxy-jobs\] (\S+) (\S+) \(exit [^)]*\) after ([^:]+): (.*)$/);
  if (bash) {
    const out = cleanTail(ls.slice(ls[1] === "last output:" ? 2 : 1));
    const p = jobPhrase(bash[2]);
    return { id: bash[1], state: bash[2], title: commandHead(bash[4]), duration: bash[3].trim(), body: out, tone: p.tone,
      summary: `${jobName(bash[1])} ${p.text}, print ${lines(out.length)}` };
  }
  const agent = ls[0].match(/^\[oxy-jobs\] (\S+) \((.*)\) (\S+) in ([^,]+), (\d+) turns:$/);
  if (agent) {
    const out = ls.slice(1);
    while (out.length && !out.at(-1)!.trim()) out.pop();
    const p = jobPhrase(agent[3]);
    return { id: agent[1], state: agent[3], title: agent[2], duration: agent[4].trim(), body: out, tone: p.tone,
      summary: `${jobName(agent[1])} ${p.text}, ${agent[5]} ${agent[5] === "1" ? "turn" : "turns"}` };
  }
  return null;
}
