/**
 * 모니터 보기 모델 (docs/monitor-tui-spec.md §3 · §4, M1 (a)).
 * 상태 파일(jobs state.json · flow.json · live.json)을 읽은 결과로 "무엇을 어떤 순서로 보일지"를 정한다.
 * 그리기(글자 폭에 맞춘 자르기, 기호, 색, 스피너, 경과 시간)는 oxy-tui 의 모니터 모드가 한다. 여기에는 색 코드를 넣지 않는다.
 * 높이 안에서 어느 줄을 보일지(스크롤)와 좁은 폭에서 뺄 열은 여기서 정해, 화면 프로그램은 받은 줄을 그대로 그린다.
 */
import type { JobSnapshot, JobsState } from "../oxy-jobs/state.ts";
import type { PlanItem } from "../oxy-flow/plan.ts";
import type { LiveState } from "./live.ts";

/** 상태 기호 이름 (기호 자체는 exe 가 정한다: spinner = 점자 스피너, todo ·, done ✓, failed ×, blocked !, stopped ■, dropped -) */
export type Marker = "spinner" | "todo" | "done" | "failed" | "blocked" | "stopped" | "dropped" | "none";
export interface Row {
  key?: string;          // 고를 수 있는 줄 (Enter · s 의 대상)
  marker: Marker;
  text: string;
  right?: string;        // 오른쪽 정렬 글 (since 가 있으면 exe 가 경과로 바꿔 그린다)
  since?: number;        // 경과 시작 시각 (ms). exe 가 1초마다 m:ss 로 그린다
  indent: number;
  emphasis?: boolean;    // 진행 중 · 제목 줄
  error?: boolean;       // 실패 · 오류색
}
export interface Section { title?: string; rows: Row[] }
export interface MonitorModel {
  op: "monitor";
  kind: "flow" | "jobs";
  title: string;
  right: string;
  now: Row[];            // 지금 (flow: 맨 위 · jobs: 맨 아래). 빈 배열이면 그리지 않는다
  nowAt: "top" | "bottom";
  sections: Section[];   // 사이에 가로줄을 긋는다
  selected: string | null;
  keys: string[];        // 키 안내 줄 (폭에 맞춰 이미 나눈 것)
}

export const NARROW = 30;               // 이 폭 미만이면 커밋 번호 · 종류 열을 뺀다 (80×24 의 오른쪽 열은 23칸)
export const LIVE_STALE_MS = 10000;     // live.json 은 5초마다 갱신된다. 두 번 놓치면 상태를 모른다고 본다
export const MANUAL_HOLD_MS = 10000;    // 사용자가 움직인 뒤 이 동안은 진행 중 항목으로 스크롤을 옮기지 않는다

/** 경과 m:ss (한 시간 넘으면 h:mm:ss) */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

/** 키 안내를 폭에 맞춰 줄로 나눈다 (한 줄에 다 들어가지 않으면 두 줄 이상) */
export function keyLines(keys: string[], width: number, w: (s: string) => number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const k of keys) {
    const next = cur ? `${cur}  ${k}` : k;
    if (!cur || w(next) <= width) cur = next;
    else { lines.push(cur); cur = k; }
  }
  if (cur) lines.push(cur);
  return lines;
}

// ------------------------------------------------------------------ 지금 (live.json)

const STATE_TEXT: Record<string, string> = { idle: "대기 중", thinking: "응답 생성 중", tool: "도구 실행 중", compacting: "compaction 중" };

/** pi 의 지금 상태 한 줄. live 가 없거나 오래되면 "알 수 없음" */
export function stateRow(live: LiveState | null, now: number): Row {
  if (!live || live.closed || now - live.updatedAt > LIVE_STALE_MS) return { marker: "none", text: "pi 상태를 알 수 없습니다", indent: 0 };
  const st = live.agent.state;
  if (st === "idle") return { marker: "none", text: STATE_TEXT.idle, indent: 0 };
  return { marker: "spinner", text: STATE_TEXT[st] ?? st, since: live.agent.since, indent: 0, emphasis: true };
}

const planMarker = (s: string): Marker =>
  s === "doing" ? "spinner" : s === "done" ? "done" : s === "blocked" ? "blocked" : s === "dropped" ? "dropped" : "todo";

/** 진행 중인 할 일 (첫 번째 doing 할 일, 없으면 doing 항목) */
export function doingItem(plan: PlanItem[]): PlanItem | null {
  for (const p of plan) {
    const c = p.children.find((x) => x.status === "doing");
    if (c) return c;
    if (p.status === "doing" && !p.children.length) return p;
  }
  return plan.find((p) => p.status === "doing") ?? null;
}

/** flow 화면 맨 위 "지금": 상태 · 실행 중인 도구 · 진행 중인 할 일 (최대 max 줄) */
export function nowRows(live: LiveState | null, plan: PlanItem[], now: number, max = 4): Row[] {
  const rows: Row[] = [stateRow(live, now)];
  const doing = doingItem(plan);
  const toolRoom = Math.max(0, max - 1 - (doing ? 1 : 0));
  const known = rows[0].text !== "pi 상태를 알 수 없습니다";
  const tools = known ? live?.tools ?? [] : [];
  if (tools.length && toolRoom) {
    const shown = tools.length > toolRoom ? tools.slice(0, toolRoom - 1) : tools;
    for (const t of shown) rows.push({ marker: "none", text: t.summary ? `${t.name} ${t.summary}` : t.name, indent: 2 });
    if (shown.length < tools.length) rows.push({ marker: "none", text: `외 ${tools.length - shown.length}개`, indent: 2 });
  }
  if (doing) rows.push({ marker: "spinner", text: `${doing.id} ${doing.text}`, indent: 0, emphasis: true });
  return rows.slice(0, max);
}

/** 최근 이벤트 (새 것이 아래) */
export function recentRows(live: LiveState | null, n: number): Row[] {
  if (!live || n <= 0) return [];
  return live.events.slice(-n).map((e) => ({
    marker: e.kind === "user" ? "none" : e.ok ? "done" : "failed",
    text: e.kind === "user" ? `요청 ${e.text}` : e.text,
    indent: 0,
    error: !e.ok,
  }));
}

// ------------------------------------------------------------------ flow

export interface FlowLike {
  goal: string; plan?: PlanItem[];
  nodes: Array<{ id: string; commit: string; title: string; decisions: Array<{ text: string; why?: string }>; files: string[] }>;
  buffer: { decisions: Array<{ text: string; why?: string }>; files: string[]; failures: Array<{ command: string }> };
}
export interface FlowUiState { sel: string | null; open: Set<string>; manualAt: number }

/** 계획 구역의 줄: 항목 → 할 일 (끝난 항목은 접힘, open 이면 반대) → 펼친 커밋의 결정 · 파일 → 계획 밖 커밋 → 커밋 전 작업 */
export function planRows(flow: FlowLike, open: Set<string>, width: number): Row[] {
  const rows: Row[] = [];
  const plan = flow.plan ?? [];
  const narrow = width < NARROW;
  const nodeById = new Map(flow.nodes.map((n) => [n.id, n]));
  const commitDetail = (id: string, indent: number) => {
    const n = nodeById.get(id);
    if (!n || !open.has(`n:${id}`)) return;
    for (const d of n.decisions) rows.push({ marker: "none", text: `${d.text}${d.why ? ` (${d.why})` : ""}`, indent });
    if (n.files.length) rows.push({ marker: "none", text: `파일 ${n.files.length}개: ${n.files.slice(0, 5).join(", ")}${n.files.length > 5 ? " …" : ""}`, indent });
  };
  const commitRows = (ids: string[], indent: number) => {
    for (const id of ids) {
      const n = nodeById.get(id);
      if (!n) continue;
      rows.push({ key: `n:${id}`, marker: "done", text: `${id} ${n.title}`, indent });
      commitDetail(id, indent + 2);
    }
  };
  for (const p of plan) {
    const kids = p.children.filter((c) => c.status !== "dropped");
    const right = kids.length ? `${kids.filter((c) => c.status === "done").length}/${kids.length}` : narrow ? "" : p.nodes.join(" ");
    rows.push({ key: `p:${p.id}`, marker: planMarker(p.status), text: `${p.id} ${p.text}`, right: right || undefined, indent: 0, emphasis: p.status === "doing" });
    const folded = (p.status === "done") !== open.has(`p:${p.id}`);
    if (folded) continue;
    if (open.has(`p:${p.id}`)) commitRows(p.nodes, 2);
    for (const c of p.children) {
      rows.push({ key: `p:${c.id}`, marker: planMarker(c.status), text: `${c.id} ${c.text}`, right: narrow || !c.nodes.length ? undefined : c.nodes.join(" "),
        indent: 2, emphasis: c.status === "doing" });
      if (open.has(`p:${c.id}`)) commitRows(c.nodes, 4);
    }
  }
  if (!plan.length && flow.goal) rows.push({ marker: "none", text: flow.goal, indent: 0 });
  const linked = new Set(plan.flatMap((p) => [...p.nodes, ...p.children.flatMap((c) => c.nodes)]));
  const outside = flow.nodes.filter((n) => !linked.has(n.id)).map((n) => n.id);
  if (outside.length) {
    rows.push({ marker: "none", text: plan.length ? "계획 밖 커밋" : "커밋", indent: 0, emphasis: true });
    commitRows(outside.slice(-20), 0);
  }
  const b = flow.buffer;
  if (b.decisions.length || b.files.length || b.failures.length) {
    rows.push({ marker: "none", text: "커밋 전 작업", indent: 0, emphasis: true });
    for (const d of b.decisions) rows.push({ marker: "none", text: d.text, indent: 2 });
    if (b.files.length) rows.push({ marker: "none", text: `변경 파일 ${b.files.length}개`, indent: 2 });
    for (const x of b.failures) rows.push({ marker: "failed", text: x.command, indent: 2, error: true });
  }
  if (!rows.length) rows.push({ marker: "none", text: "작업 기록이 없습니다.", indent: 0 });
  return rows;
}

/** 높이 room 안에 보일 구간: target 줄이 보이게 (가능하면 가운데보다 조금 위) */
export function windowAround(total: number, room: number, target: number): number {
  if (total <= room || target < 0) return 0;
  return Math.min(Math.max(0, target - Math.floor(room / 3)), total - room);
}

/** 최근 구역 줄 수: 높이 16줄 미만이면 두지 않는다 (spec §3) */
export const recentCount = (height: number) => (height >= 24 ? 5 : height >= 20 ? 4 : height >= 16 ? 3 : 0);

export function flowModel(flow: FlowLike | null, live: LiveState | null, ui: FlowUiState, width: number, height: number, now: number,
  w: (s: string) => number): MonitorModel {
  const plan = flow?.plan ?? [];
  const leaves = plan.flatMap((p) => (p.children.length ? p.children : [p])).filter((x) => x.status !== "dropped");
  const right = leaves.length ? `할 일 ${leaves.filter((x) => x.status === "done").length}/${leaves.length}` : "";
  const keys = keyLines(["↑↓ 이동", "Enter 펼치기", "q 닫기"], width, w);
  const now4 = nowRows(live, plan, now, 4);
  const nRecent = recentCount(height);
  const recent = recentRows(live, nRecent);
  const rows = flow ? planRows(flow, ui.open, width) : [{ marker: "none" as Marker, text: "작업 기록이 없습니다.", indent: 0 }];
  // 높이: 제목 1 + 지금 + 가로줄 1 + 계획 + (가로줄 1 + 최근) + 키 안내
  const room = Math.max(1, height - 1 - now4.length - 1 - (recent.length ? 1 + recent.length : 0) - keys.length);
  const keyed = rows.map((r, i) => (r.key ? i : -1)).filter((i) => i >= 0);
  const selIdx = ui.sel ? rows.findIndex((r) => r.key === ui.sel) : -1;
  const doing = doingItem(plan);
  const doingIdx = doing ? rows.findIndex((r) => r.key === `p:${doing.id}`) : -1;
  const manual = now - ui.manualAt < MANUAL_HOLD_MS;
  const target = manual && selIdx >= 0 ? selIdx : doingIdx >= 0 ? doingIdx : selIdx >= 0 ? selIdx : keyed[0] ?? 0;
  const start = windowAround(rows.length, room, target);
  const selected = selIdx >= 0 ? ui.sel : keyed.length ? rows[keyed[0]].key! : null;
  return {
    op: "monitor", kind: "flow", title: "flow", right, now: now4, nowAt: "top",
    sections: [{ rows: rows.slice(start, start + room) }, ...(recent.length ? [{ title: "최근", rows: recent }] : [])],
    selected, keys,
  };
}

// ------------------------------------------------------------------ jobs

const jobMarker = (s: string): Marker => (s === "running" ? "spinner" : s === "queued" ? "todo" : s === "done" ? "done" : s === "failed" ? "failed" : "stopped");

/** 목록 순서: 실행 중 · 대기 → 최근에 끝난 것 */
export function jobOrder(jobs: JobSnapshot[]): JobSnapshot[] {
  const active = (j: JobSnapshot) => j.state === "running" || j.state === "queued";
  return [...jobs].sort((a, b) => Number(active(b)) - Number(active(a)) || (b.endedAt ?? b.createdAt) - (a.endedAt ?? a.createdAt));
}

export interface JobsUiState { sel: string | null; mode: "list" | "log" | "confirm"; notice?: string }

export function jobsModel(state: JobsState | null, live: LiveState | null, ui: JobsUiState, width: number, height: number, now: number,
  w: (s: string) => number, logLines: string[] = []): MonitorModel {
  const jobs = state ? jobOrder(state.jobs) : [];
  const running = jobs.filter((j) => j.state === "running" || j.state === "queued").length;
  const finished = jobs.length - running;
  const right = !state ? "" : [running ? `실행 중 ${running}` : "", finished ? `완료 ${finished}` : ""].filter(Boolean).join(" · ") || "작업 없음";
  const sel = jobs.find((j) => j.id === ui.sel) ?? jobs[0];
  const active = (j?: JobSnapshot) => Boolean(j && (j.state === "running" || j.state === "queued"));
  const nowRow = [stateRow(live, now)];

  if (ui.mode === "log" && sel) {
    const keys = keyLines(["↑↓ 스크롤", "Esc 목록", ...(active(sel) ? ["s 중지"] : [])], width, w);
    const room = Math.max(1, height - 1 - keys.length);
    const lines = logLines.slice(-room).map((l) => ({ marker: "none" as Marker, text: l, indent: 0 }));
    return { op: "monitor", kind: "jobs", title: `${sel.id} 로그`, right: sel.state, now: [], nowAt: "bottom", sections: [{ rows: lines }], selected: null, keys };
  }

  const narrow = width < NARROW;
  const rows: Row[] = jobs.map((j) => {
    const kind = narrow ? "" : `${j.kind === "agent" ? "sub" : "bg"}  `;
    const done = !active(j);
    return { key: j.id, marker: jobMarker(j.state), text: `${kind}${j.label}`, indent: 0, error: j.state === "failed",
      ...(done ? { right: clock((j.endedAt ?? now) - (j.startedAt ?? j.createdAt)) } : { since: j.startedAt ?? j.createdAt }) };
  });
  if (!state) rows.push({ marker: "none", text: "작업 정보를 기다리는 중입니다.", indent: 0 });
  else if (!jobs.length) rows.push({ marker: "none", text: "작업이 없습니다.", indent: 0 });
  const keys = ui.mode === "confirm" && sel
    ? keyLines([`${sel.id} 작업을 중지할까요?`, "s 중지", "Esc 취소"], width, w)
    : keyLines(["↑↓ 이동", "Enter 로그", ...(active(sel) ? ["s 중지"] : []), "q 닫기"], width, w);
  const notice = ui.notice ? [{ marker: "none" as Marker, text: ui.notice, indent: 0 }] : [];
  // 높이: 제목 1 + 목록 + 가로줄 1 + 지금 1 + 알림 + 키 안내
  const room = Math.max(1, height - 1 - 1 - nowRow.length - notice.length - keys.length);
  const selIdx = sel ? rows.findIndex((r) => r.key === sel.id) : -1;
  const start = windowAround(rows.length, room, selIdx);
  return {
    op: "monitor", kind: "jobs", title: "jobs", right, now: nowRow, nowAt: "bottom",
    sections: [{ rows: [...rows.slice(start, start + room), ...notice] }], selected: sel?.id ?? null, keys,
  };
}

/** 모델이 차지하는 줄 수 (화면 프로그램이 그리는 규칙과 같다: 제목 · 지금 · 구역 사이 가로줄 · 구역 제목 · 키 안내) */
export function modelHeight(m: MonitorModel): number {
  const sections = m.sections.reduce((a, s) => a + s.rows.length + (s.title ? 1 : 0), 0);
  // 가로줄: 지금과 첫 구역 사이 1 (지금이 있을 때), 구역 사이 (구역 수 - 1). 구역 제목은 가로줄 자리에 함께 쓴다
  const rules = (m.now.length ? 1 : 0) + Math.max(0, m.sections.length - 1);
  const titles = m.sections.filter((s, i) => s.title && i > 0).length;
  return 1 + m.now.length + rules + sections - titles + m.keys.length;
}
