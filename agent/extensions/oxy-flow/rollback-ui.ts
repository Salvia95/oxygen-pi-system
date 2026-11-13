// 되돌리기 화면 문구 · 에이전트 안내 (docs/flow-rollback-spec.md §3.1 · §5). 순수 함수만 둔다 (모니터 · /flow 가 같이 쓴다).
import { type PlanItem } from "./plan.ts";

/** D12: "원격저장소에 없는 변경은 작업기록을 토대로 에이전트가 되돌리기를 시도합니다." (사용자 문구 그대로) */
export const PARTIAL_LINE = "원격저장소에 없는 변경은 작업기록을 토대로 에이전트가 되돌리기를 시도합니다.";

/** 되돌리기 확인 문구 (§3.1). 줄 목록 (제목 · 버튼은 화면이 붙인다) */
export function rollbackConfirmLines(taskLabel: string, files: number, partial: boolean): string[] {
  return [`"${taskLabel}" 이 끝난 상태로`, "되돌립니다.", `파일 ${files}개가 바뀌거나 삭제됩니다.`, ...(partial ? [PARTIAL_LINE] : []), "계속할까요?"];
}

/** 되돌리기 취소 확인 문구 */
export function undoConfirmLines(taskLabel: string, files: number): string[] {
  return [`마지막 되돌리기("${taskLabel}" 까지)를 취소합니다.`, `파일 ${files}개가 바뀌거나 삭제됩니다.`, "계속할까요?"];
}

export interface DecisionLike { at: number; text: string; why?: string }

/**
 * 스냅숏 밖 변경을 에이전트에게 맡기는 안내 (§5 의 4). 되돌린 지점 뒤의 Task 이름 · 그 사이 결정 · 남은 변경 이유를 준다
 */
export function partialRollbackPrompt(goal: string, task: PlanItem, after: PlanItem[], decisions: DecisionLike[], incomplete: string[], files: number): string {
  const from = task.snapAt ?? 0;
  const lines = [
    `[oxy-flow] The user rolled back the task "${goal}" to the end of ${task.id} "${task.text}". ${files} file(s) were restored from the task snapshots.`,
    "These changes made after that point were not in the snapshots, so they were NOT reverted:",
    ...incomplete.map((r) => `- ${r}`),
    "Tasks after that point (newest last):",
    ...after.map((x) => `- ${x.id} ${x.text}`),
  ];
  const dec = decisions.filter((d) => d.at >= from);
  if (dec.length) lines.push("Decisions recorded after that point:", ...dec.slice(-10).map((d) => `- ${d.text}${d.why ? ` (why: ${d.why})` : ""}`));
  lines.push("Using this task log, revert those remaining changes so the project matches the state right after that task.",
    "Ask the user before anything destructive or outside the project folder (uninstalling packages, changing a database, deleting data).");
  return lines.join("\n");
}

/** 다 되돌린 경우 모델에게 알리는 짧은 글 (다음 요청에 붙는다) */
export function rollbackNotice(goal: string, task: PlanItem, files: number, undo = false): string {
  return undo
    ? `[oxy-flow] The user undid the last rollback (to ${task.id} "${task.text}" of "${goal}"). ${files} file(s) changed back. Re-read files before editing them.`
    : `[oxy-flow] The user rolled back "${goal}" to the end of ${task.id} "${task.text}". ${files} file(s) changed. Re-read files before editing them.`;
}

/** 화면에 보이는 Task 이름: 같은 단계 안의 위치 `[2/5] loan 반납` (docs/flow-view-spec.md §2 와 같은 꼴) */
export function taskLabel(plan: PlanItem[], id: string): string {
  for (const [i, p] of plan.entries()) {
    if (p.id === id) return `[${i + 1}/${plan.length}] ${p.text}`;
    const j = p.children.findIndex((c) => c.id === id);
    if (j >= 0) return `[${j + 1}/${p.children.length}] ${p.children[j].text}`;
  }
  return id;
}
