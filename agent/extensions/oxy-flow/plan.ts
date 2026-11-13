// oxy-flow 계획(할 일) 트리: 작업 흐름의 항목 → 그 항목의 할 일 (2단까지). docs/monitor-spec.md §4
// 순수 함수만 둔다 (store.ts 의 엔진과 모니터가 같이 쓴다). 상태를 바꾸는 함수는 넘겨받은 배열을 직접 고친다.

export type PlanStatus = "todo" | "doing" | "done" | "blocked" | "dropped";
export const PLAN_STATUSES: PlanStatus[] = ["todo", "doing", "done", "blocked", "dropped"];

export interface PlanItem {
  id: string;            // p1, p1.2
  text: string;
  status: PlanStatus;
  at: number;            // 마지막으로 상태·글이 바뀐 시각
  startedAt?: number;    // 처음 doing 이 된 시각 (docs/flow-view-spec.md §3). todo 에서 바로 done 이 되면 없다
  endedAt?: number;      // done 이 된 시각. done 이 아니게 되면 지운다
  nodes: string[];       // 이 항목이 doing 일 때 생긴 커밋 노드 (n3 …)
  children: PlanItem[];  // 할 일 (2단째는 children 이 늘 빈 배열)
  /** 끝났을 때(done · dropped) 남긴 스냅숏: 작업 폴더 → 그림자 저장소 커밋 (docs/flow-rollback-spec.md §4) */
  snaps?: Record<string, string>;
  snapAt?: number;
  /** 이 Task 동안 스냅숏에 들어가지 않은 변경 (작업 폴더 밖 파일 · 큰 파일 · 설치 · DB 명령) → 되돌리기 기호 ! */
  incomplete?: string[];
}

export interface PlanInput { text: string; children?: { text: string }[] }

export const PLAN_MAX_ITEMS = 20;
export const PLAN_MAX_CHILDREN = 15;
export const PLAN_TEXT_MAX = 200;

/** 사람이 보는 표시 (FLOW.md · 모니터) */
export const PLAN_ICON: Record<PlanStatus, string> = { todo: "·", doing: "⏳", done: "✓", blocked: "!", dropped: "–" };

const closed = (s: PlanStatus) => s === "done" || s === "dropped";

/** 상태를 바꾸고 시작 · 끝 시각을 맞춘다 (걸린 시간 표시용, docs/flow-view-spec.md §3) */
export function setStatus(x: PlanItem, s: PlanStatus, now: number): void {
  x.status = s;
  if (s === "doing" && x.startedAt === undefined) x.startedAt = now;
  if (s === "done") x.endedAt = now;
  else delete x.endedAt;
}

/** 걸린 시간 (ms). 끝난 것만. 할 일이 있으면 가장 이른 할 일 시작 ~ 가장 늦은 할 일 끝. 시각을 모르면 null (지어내지 않는다) */
export function itemDuration(x: PlanItem): number | null {
  if (x.status !== "done") return null;
  const parts = x.children.length ? x.children.filter((c) => c.status === "done") : [x];
  const starts = parts.map((c) => c.startedAt).filter((t): t is number => typeof t === "number");
  const ends = parts.map((c) => c.endedAt).filter((t): t is number => typeof t === "number");
  if (!starts.length || !ends.length) return null;
  const d = Math.max(...ends) - Math.min(...starts);
  return d >= 0 ? d : null;
}

/** 경과 m:ss (한 시간 넘으면 h:mm:ss) */
export function clock(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), r = sec % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

export function cleanText(s: unknown): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  if (!t) throw new Error("text is required");
  return t.length > PLAN_TEXT_MAX ? `${t.slice(0, PLAN_TEXT_MAX)} …` : t;
}

const key = (s: string) => s.toLowerCase();

/** 할 일이 있는 항목의 상태는 할 일을 따른다 */
export function rollUp(p: PlanItem, now = Date.now()): void {
  if (!p.children.length) return;
  const st = p.children.map((c) => c.status);
  let next: PlanStatus;
  if (st.every((s) => s === "dropped")) next = "dropped";
  else if (st.every(closed)) next = "done";
  else if (st.includes("doing")) next = "doing";
  else if (st.includes("done")) next = "doing";              // 일부만 끝남 = 진행 중
  else if (st.every((s) => s === "blocked" || closed(s))) next = "blocked";
  else next = p.status === "doing" || p.status === "blocked" ? p.status : "todo"; // 모두 todo: 직접 지정한 doing/blocked 는 유지
  if (next !== p.status) { setStatus(p, next, now); p.at = now; }
}

/**
 * 계획 전체를 새로 쓴다. 같은 글의 항목(할 일은 같은 항목 아래 같은 글)은 상태·시각·커밋 연결을 이어받는다. id 는 순서대로 다시 매긴다.
 */
export function setPlan(old: PlanItem[], items: PlanInput[], now = Date.now()): PlanItem[] {
  if (!Array.isArray(items) || !items.length) throw new Error("items must be a non-empty list of {text, children?}");
  if (items.length > PLAN_MAX_ITEMS) throw new Error(`at most ${PLAN_MAX_ITEMS} items`);
  const prev = new Map<string, PlanItem>();
  for (const p of old) {
    prev.set(key(p.text), p);
    for (const c of p.children) prev.set(`${key(p.text)}\u0000${key(c.text)}`, c);
  }
  const make = (k: string, text: string, id: string, children: PlanItem[]): PlanItem => {
    const o = prev.get(k);
    const item: PlanItem = { id, text, status: o?.status ?? "todo", at: o?.at ?? now, nodes: o ? [...o.nodes] : [], children };
    if (o?.startedAt !== undefined) item.startedAt = o.startedAt;
    if (o?.endedAt !== undefined) item.endedAt = o.endedAt;
    // 되돌리기 지점도 이어받는다 (docs/flow-rollback-spec.md §4)
    if (o?.snaps) { item.snaps = { ...o.snaps }; item.snapAt = o.snapAt; }
    if (o?.incomplete?.length) item.incomplete = [...o.incomplete];
    return item;
  };
  const plan = items.map((it, i) => {
    const text = cleanText(it?.text);
    const kids = Array.isArray(it?.children) ? it.children : [];
    if (kids.length > PLAN_MAX_CHILDREN) throw new Error(`at most ${PLAN_MAX_CHILDREN} sub-tasks per item`);
    const children = kids.map((c, j) => {
      const ct = cleanText(c?.text);
      return make(`${key(text)}\u0000${key(ct)}`, ct, `p${i + 1}.${j + 1}`, []);
    });
    return make(key(text), text, `p${i + 1}`, children);
  });
  for (const p of plan) rollUp(p, now);
  return plan;
}

export function findItem(plan: PlanItem[], id: string): { item: PlanItem; parent: PlanItem | null } | null {
  const k = String(id ?? "").trim().toLowerCase();
  for (const p of plan) {
    if (p.id === k) return { item: p, parent: null };
    for (const c of p.children) if (c.id === k) return { item: c, parent: p };
  }
  return null;
}

const ids = (plan: PlanItem[]) => plan.flatMap((p) => [p.id, ...p.children.map((c) => c.id)]).join(", ") || "none";

/** 항목(parent 없음) 또는 할 일(parent = 항목 id) 하나를 끝에 더한다 */
export function addItem(plan: PlanItem[], text: string, parentId?: string, now = Date.now()): PlanItem {
  const t = cleanText(text);
  if (!parentId) {
    if (plan.length >= PLAN_MAX_ITEMS) throw new Error(`at most ${PLAN_MAX_ITEMS} items`);
    const n = plan.reduce((m, p) => Math.max(m, Number(p.id.slice(1)) || 0), 0) + 1;
    const item: PlanItem = { id: `p${n}`, text: t, status: "todo", at: now, nodes: [], children: [] };
    plan.push(item);
    return item;
  }
  const hit = findItem(plan, parentId);
  if (!hit) throw new Error(`unknown item "${parentId}". Items: ${ids(plan)}`);
  if (hit.parent) throw new Error(`plans have 2 levels: add the sub-task to ${hit.parent.id} instead of ${hit.item.id}`);
  const p = hit.item;
  if (p.children.length >= PLAN_MAX_CHILDREN) throw new Error(`at most ${PLAN_MAX_CHILDREN} sub-tasks per item`);
  const n = p.children.reduce((m, c) => Math.max(m, Number(c.id.split(".")[1]) || 0), 0) + 1;
  const item: PlanItem = { id: `${p.id}.${n}`, text: t, status: "todo", at: now, nodes: [], children: [] };
  p.children.push(item);
  rollUp(p, now);
  return item;
}

/**
 * 상태·글 바꾸기. 할 일을 바꾸면 위 항목은 rollUp 으로 따라간다.
 * 할 일이 있는 항목을 done/dropped 로 바꾸면 끝나지 않은 할 일도 같이 바꾼다.
 */
export function updateItem(plan: PlanItem[], id: string, change: { status?: string; text?: string }, now = Date.now()): PlanItem {
  const hit = findItem(plan, id);
  if (!hit) throw new Error(`unknown item "${id}". Items: ${ids(plan)}`);
  const { item, parent } = hit;
  if (change.status === undefined && change.text === undefined) throw new Error("give status or text");
  if (change.text !== undefined) item.text = cleanText(change.text);
  if (change.status !== undefined) {
    const s = change.status as PlanStatus;
    if (!PLAN_STATUSES.includes(s)) throw new Error(`status must be one of ${PLAN_STATUSES.join(", ")}`);
    setStatus(item, s, now);
    if (item.children.length && closed(s)) {
      for (const c of item.children) if (!closed(c.status)) { setStatus(c, s, now); c.at = now; }
    }
  }
  item.at = now;
  if (parent) rollUp(parent, now);
  return item;
}

/** 커밋을 붙일 항목: 가장 최근에 doing 이 된 할 일(할 일이 없는 항목 포함). 없으면 doing 인 항목. 없으면 null */
export function currentItem(plan: PlanItem[]): PlanItem | null {
  const leaves = plan.flatMap((p) => (p.children.length ? p.children : [p])).filter((x) => x.status === "doing");
  const pool = leaves.length ? leaves : plan.filter((p) => p.status === "doing");
  return pool.reduce<PlanItem | null>((best, x) => (!best || x.at >= best.at ? x : best), null);
}

/** 다음에 할 일: 첫 번째 doing 할 일, 없으면 첫 번째 todo 할 일 ("p2.2 text (in p2 text)") */
export function nextStep(plan: PlanItem[]): string | null {
  const leaves = plan.flatMap((p) => (p.children.length ? p.children.map((c) => ({ c, p })) : [{ c: p, p: null as PlanItem | null }]));
  const hit = leaves.find((x) => x.c.status === "doing") ?? leaves.find((x) => x.c.status === "todo");
  if (!hit) return null;
  return `${hit.c.id} ${hit.c.text}${hit.p ? ` (in ${hit.p.id} ${hit.p.text})` : ""}`;
}

/** 완료/전체 할 일 수 (dropped 제외). 할 일이 없는 항목은 그 항목 하나를 센다 */
export function progress(plan: PlanItem[]): { done: number; total: number } {
  const leaves = plan.flatMap((p) => (p.children.length ? p.children : [p])).filter((x) => x.status !== "dropped");
  return { done: leaves.filter((x) => x.status === "done").length, total: leaves.length };
}

/**
 * 모델용 계획 줄. collapse=true 면 끝난 항목의 할 일은 개수만 쓴다 (컨텍스트 절약).
 * maxChars 를 넘으면 todo 항목의 할 일부터 접고, 그래도 넘으면 뒤를 자른다.
 */
export function renderPlanLines(plan: PlanItem[], opts: { collapse?: boolean; maxChars?: number } = {}): string[] {
  const collapse = opts.collapse ?? true;
  const maxChars = opts.maxChars ?? Infinity;
  const head = (p: PlanItem, extra = "") => `- ${p.id} [${p.status}] ${p.text}${p.nodes.length ? ` (commits ${p.nodes.join(" ")})` : ""}${extra}`;
  const kid = (c: PlanItem) => `  - ${c.id} [${c.status}] ${c.text}${c.nodes.length ? ` (commits ${c.nodes.join(" ")})` : ""}`;
  const build = (fold: (p: PlanItem) => boolean) => plan.flatMap((p) => {
    if (!p.children.length) return [head(p)];
    if (fold(p)) {
      const d = p.children.filter((c) => c.status === "done").length;
      return [head(p, ` (${d}/${p.children.length} sub-tasks done)`)];
    }
    return [head(p), ...p.children.map(kid)];
  });
  const size = (ls: string[]) => ls.reduce((n, l) => n + l.length + 1, 0);
  let lines = build((p) => collapse && closed(p.status));
  if (size(lines) > maxChars) lines = build((p) => closed(p.status) || p.status === "todo");
  if (size(lines) > maxChars) {
    const out: string[] = [];
    let n = 0;
    for (const l of lines) { if (n + l.length + 1 > maxChars - 2) { out.push("…"); break; } out.push(l); n += l.length + 1; }
    lines = out;
  }
  return lines;
}

/** 사람이 보는 계획 (FLOW.md) */
export function renderPlanMarkdown(plan: PlanItem[]): string[] {
  const line = (x: PlanItem, indent: string) => {
    const d = itemDuration(x);
    return `${indent}- ${PLAN_ICON[x.status]} ${x.id} ${x.text}${d !== null ? ` (${clock(d)})` : ""}${x.nodes.length ? ` — ${x.nodes.join(" ")}` : ""}`;
  };
  return plan.flatMap((p) => [line(p, ""), ...p.children.map((c) => line(c, "  "))]);
}
