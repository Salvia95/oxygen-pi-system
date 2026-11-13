// 시스템 작업 줄 (docs/pi-tui-spec.md §7.5): oxy-flow 의 flow_plan · flow_note · flow_show.
// 사용자 (2026-11-14): "flow_plan, flow_note 등은 시스템 차원의 작업인 만큼 별도의 구분되는 색으로 표시해주고 … 세부적인 내용은 펼치면 노출되게
//   (ctrl + o, ctrl + k 를통한 펼치기 접기 조작 동일, 기본값이 접힌 상태) … flow_plan과 같이 표현하지 말고 추상화된 문장으로 컴팩트하지만 모든 의미가 전달되는 짧은 문장"
// 접힌 줄: ` ◇ Finished [1/2] Write a.txt!` (시그니처 둘째 색 o2.mid). 펼치면 아래에 넘긴 값과 결과 글. 순수 함수만 둔다.

export const SYSTEM_TOOLS = new Set(["flow_plan", "flow_note", "flow_show"]);

const clip = (s: string, n = 80) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

interface PlanLine { id: string; status: string; text: string; depth: number }
/** 결과 글의 계획 줄 (`- p1 [done] Write a` · `  - p1.1 [todo] …`) */
export function planLines(result: string): PlanLine[] {
  const out: PlanLine[] = [];
  for (const l of result.split("\n")) {
    const m = l.match(/^(\s*)- (p\d+(?:\.\d+)?) \[(\w+)\] (.*)$/);
    if (m) out.push({ id: m[2], status: m[3], depth: m[1].length ? 1 : 0, text: m[4].replace(/ \((?:commits [^)]*|\d+\/\d+ sub-tasks done)\)/g, "").trim() });
  }
  return out;
}

/** 화면의 Task 이름 `[2/5] 이름` (같은 단계 안의 위치). 결과에 없으면 id */
export function taskName(lines: PlanLine[], id: string): string {
  const i = lines.findIndex((x) => x.id === id);
  if (i < 0) return id;
  const me = lines[i];
  const parent = me.depth ? id.split(".")[0] : null;
  const sibs = lines.filter((x) => x.depth === me.depth && (!parent || x.id.startsWith(`${parent}.`)));
  return `[${sibs.indexOf(me) + 1}/${sibs.length}] ${clip(me.text, 60)}`;
}

/** 접힌 줄의 문장. error 면 실패 문장 */
export function systemSentence(tool: string, args: any, result: string, isError: boolean): string {
  const first = (result.split("\n").find((l) => l.trim()) ?? "").trim();
  const a = args ?? {};
  if (tool === "flow_plan") {
    const lines = planLines(result);
    if (isError) return `Plan update failed.., ${clip(first, 70)}`;
    if (a.action === "set") {
      const items = Array.isArray(a.items) ? a.items : [];
      const subs = items.reduce((n: number, it: any) => n + (Array.isArray(it?.children) ? it.children.length : 0), 0);
      return `Plan set, ${items.length} ${items.length === 1 ? "task" : "tasks"}${subs ? `, ${subs} sub-${subs === 1 ? "task" : "tasks"}` : ""}`;
    }
    if (a.action === "add") {
      const id = first.match(/^Added (p[\d.]+)\./)?.[1] ?? "";
      return `${a.parent ? "Sub-task" : "Task"} added, ${id ? taskName(lines, id) : clip(a.text, 60)}`;
    }
    const id = String(a.id ?? "");
    const name = taskName(lines, id);
    switch (a.status) {
      case "doing": return `Started ${name}..`;
      case "done": return `Finished ${name}!`;
      case "dropped": return `Dropped ${name}..`;
      case "blocked": return `Blocked on ${name}..`;
      case "todo": return `Reopened ${name}..`;
      default: return `Renamed ${name}`;
    }
  }
  if (tool === "flow_note") {
    if (isError) return `Note failed.., ${clip(first, 70)}`;
    const t = clip(a.text, 70);
    switch (a.kind) {
      case "decision": return `Decision noted, ${t}`;
      case "next": return `Next step noted, ${t}`;
      case "blocked": return `Blocker noted, ${t}`;
      case "goal": return `Goal set, ${t}`;
      case "done": return t ? `Flow finished!, ${t}` : "Flow finished!";
      default: return `Noted, ${t}`;
    }
  }
  if (tool === "flow_show") {
    if (isError) return `Flow log failed.., ${clip(first, 70)}`;
    if (a.node) return `Step ${clip(a.node, 20)} read`;
    if (a.query) return `Decisions searched, "${clip(a.query, 40)}"`;
    return "Flow log read";
  }
  return clip(first, 80);
}

/** 펼친 내용: 넘긴 값 한 줄 + 결과 글 */
export function systemDetails(args: any, result: string): string[] {
  const parts = Object.entries(args ?? {}).map(([k, v]) => `${k}=${typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v)}`);
  const body = result.replace(/\r\n/g, "\n").split("\n");
  while (body.length && !body.at(-1)!.trim()) body.pop();
  return [...(parts.length ? [parts.join(" ")] : []), ...body];
}
