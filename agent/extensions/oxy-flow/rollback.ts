// Completed Flow · Task 단위 되돌리기 (docs/flow-rollback-spec.md §3 · §5). store.ts 의 엔진이 부른다. pi 에 의존하지 않는다.
//   되돌리기: Flow F 안에서 Task T 뒤의 변경을 거꾸로 지금 상태에 얹는다 (git merge-tree 로 미리 보고, 충돌이면 하지 않음)
//   되돌리기 취소: 되돌리기를 다시 되돌린다 (D3)
//   기호: ok(✓) 완전히 되돌릴 수 있음 · partial(!) 스냅숏 밖 변경이 있음 · conflict(X) 충돌 예상 · none 되돌릴 지점 아님
import { type PlanItem } from "./plan.ts";
import { ShadowRepo, type Snapshot } from "./shadow.ts";

export type Mark = "ok" | "partial" | "conflict" | "none";

/** 작업 폴더 하나의 그림자 저장소 상태: 기준 · 마지막 · (끝난 Flow 면) 끝 스냅숏 */
export interface ShadowState { base: string; last: string; end?: string }

export interface RollbackRecord {
  at: number;
  flow: string;           // 되돌린 Flow id
  goal: string;
  task: string;           // 이 Task 가 끝난 상태로
  text: string;
  roots: Record<string, { pre: string; result: string }>;
  files: string[];
  incomplete: string[];   // 스냅숏 밖이라 에이전트에게 맡긴 것
  undone?: number;
}

/** 되돌리기 · 기호 계산에 쓰는 Flow 의 모양 (store.Flow 의 일부) */
export interface RollFlow {
  id: string; goal: string; plan: PlanItem[];
  shadow?: Record<string, ShadowState>;
  unsnapped?: string[];
}

/** 계획의 모든 항목 (항목 · 할 일) */
export const allItems = (plan: PlanItem[]): PlanItem[] => plan.flatMap((p) => [p, ...p.children]);

export function findTask(flow: RollFlow, id: string): PlanItem | null {
  return allItems(flow.plan).find((x) => x.id === id) ?? null;
}

/** T 뒤에 스냅숏을 남긴 항목들 (부모 · 할 일 모두, 시간순) */
export function tasksAfter(flow: RollFlow, t: PlanItem): PlanItem[] {
  const at = t.snapAt ?? 0;
  return allItems(flow.plan).filter((x) => x !== t && (x.snapAt ?? 0) > at && !t.children.includes(x)).sort((a, b) => (a.snapAt ?? 0) - (b.snapAt ?? 0));
}

/** T 뒤의 스냅숏 밖 변경 (부분 되돌리기의 이유) */
export function incompleteAfter(flow: RollFlow, t: PlanItem, current: boolean): string[] {
  const out = tasksAfter(flow, t).flatMap((x) => (x.incomplete ?? []).map((r) => `${x.id} ${r}`));
  if (current) out.push(...(flow.unsnapped ?? []).map((r) => `(지금) ${r}`));
  return [...new Set(out)];
}

/** 작업 폴더별로 되돌릴 목표 스냅숏: T 의 스냅숏, T 뒤에 따라가기 시작한 폴더면 그 폴더의 기준 */
export function targets(flow: RollFlow, t: PlanItem): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [root, st] of Object.entries(flow.shadow ?? {})) {
    const snap = t.snaps?.[root];
    if (snap) out[root] = snap;
    else if (st.base) out[root] = st.base;   // T 때는 아직 없던 폴더: 그 폴더의 변경은 모두 T 뒤의 것
  }
  return out;
}

export interface RollPlan {
  ok: boolean;
  reason?: string;
  files: string[];
  conflicts: string[];
  incomplete: string[];
  steps: Array<{ root: string; repo: ShadowRepo; pre: Snapshot; tree: string }>;
}

/**
 * 되돌리기를 준비한다 (지금 상태 스냅숏 + 미리 보기). 작업 폴더는 아직 바꾸지 않는다.
 * current: F 가 지금 Flow 인가 (그러면 base = 지금). curId: 지금 Flow id (pre 스냅숏을 이 Flow 에 남겨 정리되지 않게)
 */
export function planRollback(flowDir: string, flow: RollFlow, t: PlanItem, current: boolean, curId: string): RollPlan {
  const res: RollPlan = { ok: false, files: [], conflicts: [], incomplete: incompleteAfter(flow, t, current), steps: [] };
  if (!t.snaps || !Object.keys(t.snaps).length) return { ...res, reason: "이 Task 에는 스냅숏이 없습니다" };
  for (const [root, theirs] of Object.entries(targets(flow, t))) {
    const repo = new ShadowRepo(flowDir, root);
    if (!repo.exists()) return { ...res, reason: `그림자 저장소가 없습니다: ${root}` };
    const pre = repo.snapshot(curId, "pre", `before rollback to ${flow.id}:${t.id}`);
    const st = flow.shadow?.[root];
    const base = current ? pre.sha : st?.end ?? st?.last ?? pre.sha;
    const pv = repo.preview(base, pre.sha, theirs);
    if (pv.error) return { ...res, reason: pv.error };
    if (!pv.clean) { res.conflicts.push(...pv.conflicts.map((c) => `${root}: ${c}`)); continue; }
    res.files.push(...pv.files);
    res.steps.push({ root, repo, pre, tree: pv.tree! });
  }
  if (res.conflicts.length) return { ...res, reason: "되돌리면 뒤의 작업과 충돌합니다" };
  return { ...res, ok: true };
}

/** 준비한 되돌리기를 작업 폴더에 쓴다 → 기록 */
export function applyRollback(p: RollPlan, flow: RollFlow, t: PlanItem, curId: string): RollbackRecord {
  const roots: RollbackRecord["roots"] = {};
  for (const s of p.steps) {
    const done = s.repo.apply(s.pre.sha, s.tree, curId, "rollback", `rollback to ${flow.id}:${t.id} ${t.text}`);
    roots[s.root] = { pre: s.pre.sha, result: done.sha };
  }
  return { at: Date.now(), flow: flow.id, goal: flow.goal, task: t.id, text: t.text, roots, files: p.files, incomplete: p.incomplete };
}

/** 되돌리기 취소: 되돌린 결과 → 그 전 상태 (D3). 충돌이면 하지 않는다 */
export function undoRollback(flowDir: string, r: RollbackRecord, curId: string): { ok: boolean; reason?: string; files: string[]; conflicts: string[]; results: Record<string, string> } {
  const steps: Array<{ root: string; repo: ShadowRepo; now: Snapshot; tree: string }> = [];
  const files: string[] = [], conflicts: string[] = [];
  const results: Record<string, string> = {};
  for (const [root, x] of Object.entries(r.roots)) {
    const repo = new ShadowRepo(flowDir, root);
    const now = repo.snapshot(curId, "pre", "before undo");
    const pv = repo.preview(x.result, now.sha, x.pre);
    if (pv.error) return { ok: false, reason: pv.error, files, conflicts, results };
    if (!pv.clean) { conflicts.push(...pv.conflicts.map((c) => `${root}: ${c}`)); continue; }
    files.push(...pv.files);
    steps.push({ root, repo, now, tree: pv.tree! });
  }
  if (conflicts.length) return { ok: false, reason: "되돌린 뒤의 작업과 충돌합니다", files, conflicts, results };
  for (const s of steps) results[s.root] = s.repo.apply(s.now.sha, s.tree, curId, "undo", `undo rollback to ${r.flow}:${r.task}`).sha;
  return { ok: true, files, conflicts, results };
}

/**
 * 기호 (작업 폴더를 바꾸지 않음). latest: 작업 폴더별 지금 Flow 의 마지막 스냅숏 (끝난 Flow 의 충돌을 볼 기준)
 */
export function taskMarks(flowDir: string, flow: RollFlow, current: boolean, latest: Record<string, string>): Record<string, Mark> {
  const out: Record<string, Mark> = {};
  const repos = new Map<string, ShadowRepo>();
  const repo = (root: string) => { let r = repos.get(root); if (!r) { r = new ShadowRepo(flowDir, root); repos.set(root, r); } return r; };
  for (const t of allItems(flow.plan)) {
    if (!t.snaps || !Object.keys(t.snaps).length) { out[t.id] = "none"; continue; }
    let mark: Mark = incompleteAfter(flow, t, current).length ? "partial" : "ok";
    if (!current) {
      for (const [root, theirs] of Object.entries(targets(flow, t))) {
        const st = flow.shadow?.[root];
        const base = st?.end ?? st?.last;
        const ours = latest[root] ?? base;
        if (!base || !ours || ours === base) continue;
        try {
          const r = repo(root);
          if (!r.exists()) continue;
          const pv = r.preview(base, ours, theirs);
          if (!pv.clean) { mark = "conflict"; break; }
        } catch { /* 계산 실패는 기호를 바꾸지 않는다 */ }
      }
    }
    out[t.id] = mark;
  }
  return out;
}

/** Flow 의 기호: 가장 나쁜 Task 의 것 (conflict > partial > ok) */
export function flowMark(marks: Record<string, Mark>): Mark {
  const v = Object.values(marks);
  return v.includes("conflict") ? "conflict" : v.includes("partial") ? "partial" : v.includes("ok") ? "ok" : "none";
}
