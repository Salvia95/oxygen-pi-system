/**
 * 실시간 활동 (docs/monitor-tui-spec.md §2): pi 본 대화가 지금 무엇을 하는지를 모니터(별도 프로세스)가 읽을 수 있게 만든다.
 * 이 파일은 pi 에 의존하지 않는 순수 함수만 둔다 (이벤트 → 상태, 작업 · 계획 변화 → 이벤트). 파일 쓰기는 index.ts 가 StateWriter 로 한다.
 * 도구 출력 · 파일 내용 · 모델 응답은 담지 않는다.
 */

export const LIVE_VERSION = 1;
export const LIVE_EVENTS_MAX = 20;
const SUMMARY_MAX = 120;
const USER_MAX = 60;

export type AgentState = "idle" | "thinking" | "tool" | "compacting";
export type LiveEventKind = "tool" | "user" | "commit" | "plan" | "job";
export interface LiveTool { id: string; name: string; summary: string; startedAt: number }
export interface LiveEvent { at: number; kind: LiveEventKind; ok: boolean; text: string }
export interface LiveState {
  version: number;
  pid: number;
  updatedAt: number;
  closed: boolean;
  agent: { state: AgentState; since: number; turn: number; running: boolean };   // running: agent_start ~ agent_settled 사이
  tools: LiveTool[];
  model: string | null;
  context: { percent: number | null };
  events: LiveEvent[];
}

export type LiveInput =
  | { type: "agent_start" }
  | { type: "turn_start"; turnIndex: number }
  | { type: "tool_start"; id: string; name: string; input: unknown }
  | { type: "tool_end"; id: string; name: string; ok: boolean; input?: unknown }
  | { type: "compact_start" }
  | { type: "compact_end" }
  | { type: "settled" }
  | { type: "user"; text: string }
  | { type: "event"; kind: LiveEventKind; ok: boolean; text: string }
  | { type: "model"; model: string | null }
  | { type: "context"; percent: number | null };

export function emptyLive(pid: number, now: number): LiveState {
  return { version: LIVE_VERSION, pid, updatedAt: now, closed: false, agent: { state: "idle", since: now, turn: 0, running: false },
    tools: [], model: null, context: { percent: null }, events: [] };
}

const oneLine = (s: unknown, max: number): string => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** 도구 한 줄 요약: bash 는 명령 첫 줄, read · edit · write 는 경로, grep 은 찾는 말, subagent 는 agent: 일 */
export function toolSummary(name: string, input: unknown): string {
  const a: any = input && typeof input === "object" ? input : {};
  let s = "";
  if (name === "bash") s = String(a.command ?? "").split(/\r?\n/).find((l) => l.trim()) ?? "";
  else if (name === "read" || name === "edit" || name === "write") s = a.path ?? a.file_path ?? "";
  else if (name === "grep") s = a.pattern ?? "";
  else if (name === "subagent") s = a.agent ? `${a.agent}: ${a.task ?? ""}` : Array.isArray(a.tasks) ? `${a.tasks.length}개 작업` : "";
  else if (name === "background") s = a.action === "start" ? String(a.command ?? "") : String(a.action ?? "");
  else if (name === "flow_plan") s = [a.action, a.id, a.status].filter(Boolean).join(" ");
  else if (name === "flow_note") s = [a.kind, a.text].filter(Boolean).join(" ");
  return oneLine(s, SUMMARY_MAX);
}

const push = (s: LiveState, e: LiveEvent): void => {
  s.events.push(e);
  if (s.events.length > LIVE_EVENTS_MAX) s.events.splice(0, s.events.length - LIVE_EVENTS_MAX);
};
const setState = (s: LiveState, st: AgentState, now: number): void => {
  if (s.agent.state !== st) { s.agent.state = st; s.agent.since = now; }
};

/** 이벤트 하나를 반영한 새 상태 (입력은 바꾸지 않는다) */
export function reduceLive(prev: LiveState, ev: LiveInput, now: number): LiveState {
  const s: LiveState = structuredClone(prev);
  s.updatedAt = now;
  switch (ev.type) {
    case "agent_start":
      s.agent.running = true; s.agent.turn = 0; s.tools = [];
      s.agent.state = "thinking"; s.agent.since = now;
      break;
    case "turn_start":
      s.agent.turn = ev.turnIndex + 1;
      if (!s.tools.length && s.agent.state !== "compacting") setState(s, "thinking", now);
      break;
    case "tool_start":
      if (!s.tools.some((t) => t.id === ev.id)) s.tools.push({ id: ev.id, name: ev.name, summary: toolSummary(ev.name, ev.input), startedAt: now });
      if (s.agent.state !== "compacting") setState(s, "tool", now);
      break;
    case "tool_end": {
      const t = s.tools.find((x) => x.id === ev.id);
      s.tools = s.tools.filter((x) => x.id !== ev.id);
      const summary = t?.summary ?? toolSummary(ev.name, ev.input);
      push(s, { at: now, kind: "tool", ok: ev.ok, text: summary ? `${ev.name} ${summary}` : ev.name });
      if (!s.tools.length && s.agent.state === "tool") setState(s, s.agent.running ? "thinking" : "idle", now);
      break;
    }
    case "compact_start":
      setState(s, "compacting", now);
      break;
    case "compact_end":
      if (s.agent.state === "compacting") setState(s, s.tools.length ? "tool" : s.agent.running ? "thinking" : "idle", now);
      break;
    case "settled":
      s.agent.running = false; s.tools = [];
      setState(s, "idle", now);
      break;
    case "user": {
      const t = oneLine(ev.text, USER_MAX);
      if (t) push(s, { at: now, kind: "user", ok: true, text: t });
      break;
    }
    case "event":
      push(s, { at: now, kind: ev.kind, ok: ev.ok, text: oneLine(ev.text, SUMMARY_MAX) });
      break;
    case "model":
      s.model = ev.model;
      break;
    case "context":
      s.context = { percent: ev.percent == null || !Number.isFinite(ev.percent) ? null : Math.round(ev.percent) };
      break;
  }
  return s;
}

// ---------------------------------------------------------------- 다른 extension 의 변화 → 이벤트

export interface JobLite { id: string; state: string; label: string; exitCode?: number | null }
/** 작업 상태 변화 → 이벤트. prev 는 지난번에 본 상태 (id → state). 처음 본 작업이 이미 끝나 있으면 알리지 않는다 */
export function jobEvents(prev: Map<string, string>, jobs: JobLite[]): { events: Omit<LiveEvent, "at">[]; seen: Map<string, string> } {
  const events: Omit<LiveEvent, "at">[] = [];
  const seen = new Map<string, string>();
  for (const j of jobs) {
    seen.set(j.id, j.state);
    const was = prev.get(j.id);
    if (was === j.state) continue;
    const exit = j.exitCode != null ? ` (exit ${j.exitCode})` : "";
    if (j.state === "running" && was !== "running") events.push({ kind: "job", ok: true, text: `${j.id} 시작 ${j.label}` });
    else if (was === undefined && j.state !== "queued") continue;
    else if (j.state === "done") events.push({ kind: "job", ok: true, text: `${j.id} 완료${exit}` });
    else if (j.state === "failed") events.push({ kind: "job", ok: false, text: `${j.id} 실패${exit}` });
    else if (j.state === "stopped") events.push({ kind: "job", ok: false, text: `${j.id} 중지` });
  }
  return { events, seen };
}

export interface PlanLite { id: string; status: string; text: string }
/** 할 일 상태 변화 · 새 커밋 노드 → 이벤트. 처음 부르면(prev 가 null) 기준만 잡는다 */
export function flowEvents(prev: { items: Map<string, string>; node: string } | null, items: PlanLite[], node: { id: string; title: string } | null):
  { events: Omit<LiveEvent, "at">[]; seen: { items: Map<string, string>; node: string } } {
  const events: Omit<LiveEvent, "at">[] = [];
  const seen = { items: new Map(items.map((i) => [i.id, i.status])), node: node?.id ?? "" };
  if (!prev) return { events, seen };
  for (const i of items) {
    const was = prev.items.get(i.id);
    if (was !== undefined && was !== i.status) events.push({ kind: "plan", ok: i.status !== "blocked", text: `${i.id} → ${i.status} ${i.text}` });
  }
  if (node && node.id && node.id !== prev.node) events.push({ kind: "commit", ok: true, text: `커밋 ${node.id} ${node.title}` });
  return { events, seen };
}
