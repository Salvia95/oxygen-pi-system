// 기본 도구 한 줄 문장 (docs/pi-tui-spec.md §7.6): read · write · edit · grep.
// 사용자 (2026-11-14): "read, write, grep과 같은 프리머티브 툴들의 메세지도 동일한 원칙을 적용해서 수정하고 반영하자"
//   → 시스템 작업 줄(§7.5)과 같은 원칙: 도구 이름 · 인자 줄 대신 짧은 문장 한 줄, 세부 내용은 Ctrl+O 로 펼칠 때만 (기본 접힘), 말투는 다른 줄과 같게.
// 실행 중: `○ Reading sample.txt..` / 끝: `✓ Read sample.txt, 12 lines   0.0s` / 실패: `× Read sample.txt failed.., <첫 줄>`.
// 순수 함수만 둔다 (색은 tools/index.ts 가 입힌다).

export const ONE_LINE_TOOLS = new Set(["read", "write", "edit", "grep"]);

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

export interface Sentence {
  verb: string;      // Read · Wrote · Edited · Searched (굵게)
  target: string;    // 파일 · 패턴 (강조색)
  detail?: string;   // ", 12 lines" (본문색. edit 의 +a -b 처럼 색을 따로 입힐 것은 parts 로)
  parts?: Array<{ text: string; tone: "text" | "success" | "error" | "warning" }>;
}

/** 실행 중 문장 */
export function runningSentence(tool: string, target: string): Sentence {
  const verb = tool === "read" ? "Reading" : tool === "write" ? "Writing" : tool === "edit" ? "Editing" : tool === "grep" ? "Searching" : tool;
  return { verb, target, detail: ".." };
}

export function readSentence(target: string, lines: number, total: number | undefined, image: boolean): Sentence {
  if (image) return { verb: "Read", target, detail: ", image" };
  return { verb: "Read", target, detail: total && total > lines ? `, ${lines.toLocaleString("en-US")} of ${plural(total, "line")}` : `, ${plural(lines, "line")}` };
}

export function writeSentence(target: string, lines: number): Sentence {
  return { verb: "Wrote", target, detail: `, ${plural(lines, "line")}` };
}

export function editSentence(target: string, added: number, removed: number): Sentence {
  if (!added && !removed) return { verb: "Edited", target };
  return { verb: "Edited", target, parts: [{ text: ", ", tone: "text" }, { text: `+${added}`, tone: "success" }, { text: " ", tone: "text" }, { text: `-${removed}`, tone: "error" }] };
}

/** grep: 결과 수 · 멈춘 이유 (경고색) */
export function grepSentence(target: string, matches: number, files: number, warn: { limit?: number; size?: boolean; lines?: boolean } = {}): Sentence {
  const parts: Sentence["parts"] = [{ text: matches ? `, ${plural(matches, "match", "matches")} in ${plural(files, "file")}` : ", no matches", tone: "text" }];
  const w = [warn.limit ? `stopped at ${plural(warn.limit, "match", "matches")}` : "", warn.size ? "cut by size limit" : "", warn.lines ? "some lines cut" : ""].filter(Boolean);
  if (w.length) parts.push({ text: `, ${w.join(", ")}`, tone: "warning" });
  return { verb: "Searched", target, parts };
}

/** 실패: `Read sample.txt failed.., <첫 줄>` */
export function failSentence(tool: string, target: string, first: string): Sentence {
  const verb = tool === "read" ? "Read" : tool === "write" ? "Write" : tool === "edit" ? "Edit" : tool === "grep" ? "Search" : tool;
  return { verb, target, detail: ` failed..${first ? `, ${first}` : ""}` };
}
