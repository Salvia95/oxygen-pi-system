// bash · read · edit · write 요약 (docs/pi-tui-spec.md §7.4) 순수 함수. 모델이 받는 결과 글은 바꾸지 않고 읽기만 한다.
import { homePath, lastSegment } from "../layout.ts";

/** 도구 결과의 글 (content 의 text 를 잇는다) */
export function textOf(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content.filter((c: any) => c?.type === "text" && typeof c.text === "string").map((c: any) => c.text).join("\n");
}

export interface BashParsed {
  /** 종료 코드 (정상 종료면 0, 알 수 없으면 null) */
  exit: number | null;
  /** 종료 코드 대신의 끝난 사유 (중단 · 시간 제한 · 코드 없음 · 그 밖의 오류 첫 줄) */
  reason?: string;
  /** 출력 줄 (pi 가 덧붙인 상태 · 잘림 안내를 뺀 것, 끝 빈 줄 제거) */
  lines: string[];
  truncated?: { shown: string; total: number; fullPath?: string };
}

/**
 * pi bash 도구의 결과 글을 읽는다 (pi 1.5.0 core/tools/bash.js 의 formatOutput · appendStatus):
 *   <출력>\n\nCommand exited with code N · Command aborted · Command timed out after N seconds · Command terminated without an exit code
 *   <출력>\n\n[Showing lines a-b of N. Full output: <path>]
 */
export function parseBash(text: string, isError: boolean): BashParsed {
  let t = text.replace(/\r\n/g, "\n");
  let exit: number | null = isError ? null : 0;
  let reason: string | undefined;
  const status = t.match(/(?:^|\n\n)(Command exited with code (\d+)|Command aborted|Command timed out after (\d+) seconds|Command terminated without an exit code)\s*$/);
  if (status) {
    t = t.slice(0, status.index);
    if (status[2] != null) exit = Number(status[2]);
    else if (status[1] === "Command aborted") reason = "Task aborted..";
    else if (status[3] != null) reason = `Task timed out after ${status[3]}s..`;
    else reason = "Task ended without an exit code..";
  }
  let truncated: BashParsed["truncated"];
  const tr = t.match(/\n\n\[Showing (lines (\d+)-(\d+) of (\d+)[^\]]*?|last [^\]]*?)\. Full output: ([^\]]+)\]\s*$/);
  if (tr) {
    t = t.slice(0, tr.index);
    truncated = { shown: tr[2] ? `${tr[2]}-${tr[3]}` : "", total: Number(tr[4] ?? 0), fullPath: tr[5]?.trim() };
  }
  if (t.trim() === "(no output)") t = "";
  if (isError && !status && exit === null) {
    // bash 가 실행되지 못함 (막힘 · 잘못된 인자 등): 첫 줄이 사유
    const first = t.split("\n").find((l) => l.trim()) ?? "실패";
    reason = first.trim();
  }
  const lines = t.split("\n");
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  while (lines.length && !lines[0].trim()) lines.shift();
  return { exit, reason, lines, truncated };
}

/** bash 요약 글 (색 없이) 과 수준 */
/**
 * bash 요약 (사용자, 2026-11-13: bash 명령 하나는 Task, background 는 Job): 끝남 `Task done!, print 25 lines` · 실패 `Task failed.., print 25 lines`.
 * 실행 중 `Task running.., print 3 lines`. 중단 · 시간 제한 · 막힘은 그 사유 한 줄.
 */
export function bashSummary(b: BashParsed, partial: boolean): { text: string; level: "success" | "error" | "text" | "warning" } {
  const n = b.lines.length;
  const out = `print ${n} ${n === 1 ? "line" : "lines"}`;
  if (partial) return { text: `Task running.., ${out}`, level: "warning" };
  if (b.reason) return { text: b.reason, level: "error" };
  if (b.exit !== 0) return { text: `Task failed.., ${out}`, level: "error" };
  return { text: `Task done!, ${out}`, level: "success" };
}

/** `$ <명령 첫 줄>` 의 인자 부분. 여러 줄이면 ` …` */
export function commandHead(command: unknown): string {
  const c = typeof command === "string" ? command.trim() : "";
  const [first, ...rest] = c.split(/\r?\n/);
  // 앞의 `cd <긴 경로> &&` 는 마지막 폴더만 (실제 명령이 잘려 보이지 않게): `cd …/extensions && fd -e ts`
  const head = first.replace(/^cd\s+(?:"([^"]*)"|'([^']*)'|(\S+))\s*&&\s*/, (_all, a, b, d) => {
    const dir = String(a ?? b ?? d);
    return `cd ${dir.length > 24 ? lastSegment(dir.replace(/[\\/]+$/, "")) : dir} && `;
  });
  return rest.some((l) => l.trim()) ? `${head} …` : head;
}

/** 작업 폴더 기준 상대 경로 (아래가 아니면 홈을 ~ 로, / 로) */
export function relPath(p: unknown, cwd: string, home: string | undefined = process.env.USERPROFILE ?? process.env.HOME): string {
  const s = (typeof p === "string" ? p : "").replace(/\\/g, "/").replace(/^@/, "");
  const c = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  if (c && s.toLowerCase().startsWith(`${c.toLowerCase()}/`)) return s.slice(c.length + 1);
  return homePath(s, home);
}

/** read 의 줄 범위 `:<시작>-<끝>` (offset 은 1부터, limit 은 줄 수) */
export function readRange(offset: unknown, limit: unknown): string {
  const o = Number.isFinite(Number(offset)) && Number(offset) > 0 ? Number(offset) : undefined;
  const l = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Number(limit) : undefined;
  if (o == null && l == null) return "";
  const start = o ?? 1;
  return l != null ? `:${start}-${start + l - 1}` : `:${start}-`;
}

/** 읽은 줄 수 (끝 빈 줄 제외) */
export function lineCount(text: string): number {
  if (!text) return 0;
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  while (lines.length && lines.at(-1) === "") lines.pop();
  return lines.length;
}

/** unified diff 의 추가 · 삭제 줄 수 */
export function diffStats(diff: unknown): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const l of String(diff ?? "").split("\n")) {
    if (l.startsWith("+") && !l.startsWith("+++")) added++;
    else if (l.startsWith("-") && !l.startsWith("---")) removed++;
  }
  return { added, removed };
}

/** 오류 결과의 첫 줄과 나머지 */
export function errorLines(text: string): { first: string; rest: string[] } {
  const lines = text.replace(/\r\n/g, "\n").split("\n").filter((l, i, a) => l.trim() || (i > 0 && i < a.length - 1));
  return { first: (lines[0] ?? "실패").trim(), rest: lines.slice(1) };
}
