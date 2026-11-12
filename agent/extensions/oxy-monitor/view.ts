// 모니터 화면 (docs/monitor-spec.md §5). 상태 → 줄 목록을 만드는 순수 함수만 둔다 (터미널 없이 단위 테스트한다).
// 폭 계산은 pi-tui 의 함수를 받는다 (한글 · 기호는 2칸). 모든 줄은 width 칸 이하, 결과는 정확히 height 줄이다.
import type { JobsState, JobSnapshot } from "../oxy-jobs/state.ts";
import type { PlanItem } from "../oxy-flow/plan.ts";

export interface Fit {
  width: (s: string) => number;                       // 표시 폭
  trunc: (s: string, w: number) => string;            // w 칸에 맞게 자름 (넘치면 …)
  wrap: (s: string, w: number) => string[];           // w 칸으로 줄바꿈
}

export const ESC = "\x1b[";
const style = {
  bold: (s: string) => `${ESC}1m${s}${ESC}22m`,
  dim: (s: string) => `${ESC}2m${s}${ESC}22m`,
  inv: (s: string) => `${ESC}7m${s}${ESC}27m`,
  green: (s: string) => `${ESC}32m${s}${ESC}39m`,
  red: (s: string) => `${ESC}31m${s}${ESC}39m`,
  yellow: (s: string) => `${ESC}33m${s}${ESC}39m`,
  cyan: (s: string) => `${ESC}36m${s}${ESC}39m`,
};
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, "");

export const JOB_ICON: Record<string, string> = { queued: "·", running: "⏳", done: "✓", failed: "✗", stopped: "■" };
const jobColor = (state: string) => (state === "done" ? style.green : state === "failed" ? style.red : state === "running" ? style.yellow : style.dim);

export function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

/** 왼쪽 글과 오른쪽 글을 한 줄에 (넘치면 왼쪽을 자른다) */
function leftRight(f: Fit, left: string, right: string, width: number): string {
  const rw = f.width(right);
  if (rw >= width) return f.trunc(right, width);
  const l = f.trunc(left, Math.max(0, width - rw - 1));
  return `${l}${" ".repeat(Math.max(1, width - f.width(l) - rw))}${right}`;
}

/** 키 안내: 넓으면 한 줄, 좁으면 칸에 맞춰 여러 줄 */
function footer(f: Fit, keys: string[], width: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const k of keys) {
    const next = cur ? `${cur}  ${k}` : k;
    if (f.width(next) <= width || !cur) cur = next;
    else { lines.push(cur); cur = k; }
  }
  if (cur) lines.push(cur);
  return lines.map((l) => f.trunc(l, width));   // mintty 에서 회색 한글은 읽기 어려워 기본 색
}

/** 본문을 height 줄로 (선택한 줄이 보이게 스크롤) */
function frame(f: Fit, head: string[], body: string[], foot: string[], width: number, height: number, focus = -1): string[] {
  const room = Math.max(0, height - head.length - foot.length);
  let start = 0;
  if (focus >= 0 && body.length > room) start = Math.min(Math.max(0, focus - Math.floor(room / 2)), body.length - room);
  const shown = body.slice(start, start + room);
  while (shown.length < room) shown.push("");
  return [...head, ...shown, ...foot].slice(0, height).map((l) => f.trunc(l, width));
}

// ------------------------------------------------------------------ jobs
export interface JobsUi { sel: number; mode: "list" | "log" | "confirm"; scroll: number; notice?: string }

/** 목록 순서: 실행 중 · 대기 → 최근에 끝난 것 */
export function jobOrder(jobs: JobSnapshot[]): JobSnapshot[] {
  const active = (j: JobSnapshot) => j.state === "running" || j.state === "queued";
  return [...jobs].sort((a, b) => Number(active(b)) - Number(active(a)) || (b.endedAt ?? b.createdAt) - (a.endedAt ?? a.createdAt));
}

const targetText = (j: JobSnapshot) => (j.target ? [j.target.level, j.target.model, j.target.thinking && j.target.thinking !== "off" ? j.target.thinking : ""].filter(Boolean).join(" · ") : "");

export function jobsView(f: Fit, state: JobsState | null, ui: JobsUi, width: number, height: number, now = Date.now(), logLines: string[] = []): string[] {
  const jobs = state ? jobOrder(state.jobs) : [];
  const active = jobs.filter((j) => j.state === "running" || j.state === "queued").length;
  const slots = state ? `${active ? `${active}개 실행 중` : "실행 중 없음"}` : "";
  const head = [leftRight(f, style.bold("jobs"), slots, width)];
  if (!state) return frame(f, head, ["작업 정보를 기다리는 중입니다.", "pi가 작업을 시작하면 표시됩니다."], footer(f, ["q 닫기"], width), width, height);
  const j = jobs[Math.min(ui.sel, jobs.length - 1)];

  if (ui.mode === "log" && j) {
    const title = leftRight(f, style.bold(`${j.id} 로그`), jobColor(j.state)(`${JOB_ICON[j.state]} ${j.state}`), width);
    const info = [j.target ? style.cyan(f.trunc(targetText(j), width)) : null].filter(Boolean) as string[];
    const body = logLines.flatMap((l) => f.wrap(stripAnsi(l), width));
    const room = Math.max(0, height - 1 - info.length - 2);
    const end = Math.max(0, body.length - ui.scroll);
    const shown = body.slice(Math.max(0, end - room), end);
    const foot = footer(f, [ui.scroll ? "End 끝으로" : "↑↓ 스크롤", "Esc 목록", ...(j.state === "running" || j.state === "queued" ? ["s 중지"] : [])], width);
    return frame(f, [title, ...info], shown, foot, width, height);
  }

  const body: string[] = [];
  let focus = -1;
  jobs.forEach((x, i) => {
    const dur = fmtDur((x.endedAt ?? now) - (x.startedAt ?? x.createdAt));
    const icon = jobColor(x.state)(JOB_ICON[x.state] ?? "?");
    const label = width >= 40 ? `${x.id} ${x.label}` : x.label;
    let line = leftRight(f, `${icon} ${label}`, style.dim(dur), width);
    if (i === ui.sel) { line = style.inv(f.trunc(stripAnsi(line), width)); focus = body.length; }
    body.push(line);
  });
  if (!jobs.length) body.push("작업이 없습니다.");
  // 선택한 작업의 자세한 정보 (아래쪽 2줄)
  const detail: string[] = [];
  if (j) {
    const t = targetText(j);
    if (t) detail.push(style.cyan(f.trunc(t, width)));
    if (j.last) detail.push(f.trunc(j.last, width));
  }
  const keys = ui.mode === "confirm" && j
    ? [style.red(`${j.id} 작업을 중지할까요?`), "s 중지", "Esc 취소"]
    : ["↑↓ 이동", "Enter 로그", ...(j && (j.state === "running" || j.state === "queued") ? ["s 중지"] : []), "q 닫기"];
  const foot = [...(ui.notice ? [f.trunc(ui.notice, width)] : []), ...detail, ...footer(f, keys, width)];
  return frame(f, head, body, foot, width, height, focus);
}

// ------------------------------------------------------------------ flow
export const PLAN_ICON: Record<string, string> = { todo: "·", doing: "⏳", done: "✓", blocked: "!", dropped: "–" };
const planColor = (s: string) => (s === "done" ? style.green : s === "doing" ? style.yellow : s === "blocked" ? style.red : style.dim);

/** flow 화면의 한 줄 (선택할 수 있는 줄은 key 가 있다) */
export interface FlowRow { key?: string; text: string; indent: number }

export interface FlowLike {
  goal: string; next?: string; status?: string; plan?: PlanItem[];
  nodes: Array<{ id: string; commit: string; title: string; decisions: Array<{ text: string; why?: string }>; files: string[]; external?: boolean }>;
  buffer: { decisions: Array<{ text: string; why?: string }>; files: string[]; failures: Array<{ command: string }> };
}

export interface FlowUi { sel: number; open: Set<string> }

/** 트리 줄: 목표 → 항목 → 할 일 (끝난 항목은 접혀 있다. open 에 있으면 반대로) → 계획 밖 커밋 → 커밋 전 작업 */
export function flowRows(flow: FlowLike, open: Set<string>): FlowRow[] {
  const rows: FlowRow[] = [];
  const plan = flow.plan ?? [];
  const nodeById = new Map(flow.nodes.map((n) => [n.id, n]));
  const commitRows = (ids: string[], indent: number) => {
    for (const id of ids) {
      const n = nodeById.get(id);
      if (!n) continue;
      rows.push({ key: `n:${id}`, text: `${style.dim(`${id} ${n.commit.slice(0, 8)}`)} ${n.title}`, indent });
      if (open.has(`n:${id}`)) {
        for (const d of n.decisions) rows.push({ text: `· ${d.text}${d.why ? ` (${d.why})` : ""}`, indent: indent + 2 });
        if (n.files.length) rows.push({ text: (`파일 ${n.files.length}개: ${n.files.slice(0, 5).join(", ")}${n.files.length > 5 ? " …" : ""}`), indent: indent + 2 });
      }
    }
  };
  for (const p of plan) {
    const kids = p.children.length;
    const doneKids = p.children.filter((c) => c.status === "done").length;
    const folded = (p.status === "done") !== open.has(`p:${p.id}`);
    rows.push({ key: `p:${p.id}`, text: `${planColor(p.status)(PLAN_ICON[p.status] ?? "?")} ${p.text}${kids ? style.dim(` ${doneKids}/${kids}`) : ""}`, indent: 0 });
    if (folded) continue;
    commitRows(p.nodes, 2);
    for (const c of p.children) {
      rows.push({ key: `p:${c.id}`, text: `${planColor(c.status)(PLAN_ICON[c.status] ?? "?")} ${c.text}`, indent: 2 });
      commitRows(c.nodes, 4);
    }
  }
  const linked = new Set(plan.flatMap((p) => [...p.nodes, ...p.children.flatMap((c) => c.nodes)]));
  const outside = flow.nodes.filter((n) => !linked.has(n.id)).map((n) => n.id);
  if (outside.length) {
    rows.push({ text: "", indent: 0 });
    rows.push({ text: style.bold(plan.length ? "계획 밖 커밋" : "커밋"), indent: 0 });
    commitRows(outside.slice(-20), 0);
  }
  const b = flow.buffer;
  if (b.decisions.length || b.files.length || b.failures.length) {
    rows.push({ text: "", indent: 0 });
    rows.push({ text: style.bold("커밋 전 작업"), indent: 0 });
    for (const d of b.decisions) rows.push({ text: `· ${d.text}`, indent: 0 });
    if (b.files.length) rows.push({ text: `변경 파일 ${b.files.length}개`, indent: 0 });
    for (const x of b.failures) rows.push({ text: style.red(`✗ ${x.command}`), indent: 0 });
  }
  return rows;
}

export function flowView(f: Fit, flow: FlowLike | null, ui: FlowUi, width: number, height: number): string[] {
  const leaves = (flow?.plan ?? []).flatMap((p) => (p.children.length ? p.children : [p])).filter((x) => x.status !== "dropped");
  const prog = leaves.length ? `할 일 ${leaves.filter((x) => x.status === "done").length}/${leaves.length}` : "";
  const head = [leftRight(f, style.bold("flow"), prog, width)];
  if (!flow || (!flow.goal && !flow.nodes.length && !(flow.plan ?? []).length)) {
    return frame(f, head, ["작업 기록이 없습니다.", "pi가 작업을 시작하면 표시됩니다."], footer(f, ["q 닫기"], width), width, height);
  }
  if (flow.goal) head.push(...f.wrap(style.cyan(flow.goal), width).slice(0, 2));
  const rows = flowRows(flow, ui.open);
  const selectable = rows.map((r, i) => (r.key ? i : -1)).filter((i) => i >= 0);
  const selRow = selectable[Math.min(ui.sel, selectable.length - 1)] ?? -1;
  const body = rows.map((r, i) => {
    const pad = " ".repeat(r.indent);
    const line = f.trunc(`${pad}${r.text}`, width);
    return i === selRow ? style.inv(f.trunc(stripAnsi(line), width)) : line;
  });
  const keys = ["↑↓ 이동", "Enter 펼치기", "q 닫기"];
  return frame(f, head, body, footer(f, keys, width), width, height, selRow);
}

/** flow 화면에서 선택할 수 있는 줄의 key 목록 (Enter 로 펼치고 접는 대상) */
export const flowKeys = (flow: FlowLike, open: Set<string>) => flowRows(flow, open).filter((r) => r.key).map((r) => r.key!);
