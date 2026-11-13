// bash 안의 fd · rg 를 알아보고 결과를 구조화한다 (docs/pi-tui-spec.md §7.2 §7.3) 순수 함수.
// 출력 모양 (2026-11-13, 번들 rg · fd, config/ripgreprc 로 경로 구분자 /):
//   rg -n  `경로:줄:내용`   rg  `경로:내용`   rg -l · --files  `경로`   rg -c  `경로:수`   문맥(-A/-B/-C) `경로-줄-내용` 과 `--`
//   fd     `경로` (한 줄에 하나)
import { type Measure, middle, spread } from "../layout.ts";
import type { BashParsed } from "./basic.ts";
import type { BodyLine, ResultView, ToolPaint } from "./frame.ts";
import { type GrepParsed, grepCollapsed, grepExpanded, grepSummary } from "./grep.ts";

export type SearchKind = { tool: "fd" } | { tool: "rg"; mode: "lines" | "paths" | "count" };

/**
 * 명령이 fd · rg 하나만 부르는지. 앞의 `cd <폴더> &&` 와 뒤의 `2>/dev/null` · `2>&1` 은 허용한다.
 * 파이프 · 여러 명령 · 리다이렉트 · 명령 치환이 있거나 `rg --json` 처럼 모르는 출력이면 null (일반 bash 그리기).
 */
export function searchCommand(command: unknown): SearchKind | null {
  if (typeof command !== "string") return null;
  let c = command.trim();
  if (c.includes("\n")) return null;
  for (;;) {
    const m = c.match(/^cd\s+("[^"]*"|'[^']*'|[^\s;&|]+)\s*&&\s*/);
    if (!m) break;
    c = c.slice(m[0].length);
  }
  c = c.replace(/\s+2>\/dev\/null\b/g, "").replace(/\s+2>&1\b/g, "").trim();
  if (/[|;<>`]|&&|\$\(/.test(c)) return null;
  const tokens = c.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const bin = (tokens[0] ?? "").replace(/^.*[\\/]/, "").replace(/\.exe$/i, "");
  if (bin === "fd" || bin === "fdfind") return { tool: "fd" };
  if (bin !== "rg") return null;
  let mode: "lines" | "paths" | "count" = "lines";
  for (const t of tokens.slice(1)) {
    if (t === "--") break;
    if (t === "--json" || t === "--vimgrep" || t === "--heading" || t === "--stats" || t === "--type-list" || t === "--help" || t === "--version") return null;
    if (t === "--files" || t === "--files-with-matches" || t === "--files-without-match") mode = "paths";
    else if (t === "--count" || t === "--count-matches") mode = "count";
    else if (/^-[a-zA-Z]+$/.test(t)) {
      if (t.includes("l")) mode = "paths";
      else if (t.includes("c")) mode = "count";
    }
  }
  return { tool: "rg", mode };
}

const strip = (s: string) => s.replace(/\r$/, "");
const clean = (lines: string[]) => lines.map(strip).filter((l) => l.trim());

export interface PathGroup { dir: string; names: string[] }
export interface PathsParsed { groups: PathGroup[]; files: number; dirs: number }

/** 경로 목록 → 바로 위 폴더별 묶음 (처음 나온 순서). 끝이 / 인 줄은 폴더 */
export function groupPaths(lines: string[]): PathsParsed {
  const groups: PathGroup[] = [];
  const by = new Map<string, PathGroup>();
  let files = 0, dirs = 0;
  for (const raw of clean(lines)) {
    let p = raw.replace(/\\/g, "/").replace(/^\.\//, "");
    const isDir = p.endsWith("/");
    if (isDir) { dirs++; p = p.slice(0, -1); } else files++;
    const i = p.lastIndexOf("/");
    const dir = i >= 0 ? `${p.slice(0, i)}/` : "./";
    const name = `${p.slice(i + 1)}${isDir ? "/" : ""}`;
    let g = by.get(dir);
    if (!g) { g = { dir, names: [] }; by.set(dir, g); groups.push(g); }
    g.names.push(name);
  }
  return { groups, files, dirs };
}

/** `폴더 3개에 파일 23개` · `폴더 2개` · `찾은 파일 없음` (폴더 = 묶음 수) */
export function pathsSummary(p: PathsParsed): string {
  if (!p.files && !p.dirs) return "찾은 파일 없음";
  if (!p.files) return `폴더 ${p.dirs}개`;
  return `폴더 ${p.groups.length}개에 파일 ${p.files}개`;
}

/** 접힘: 폴더마다 한 줄 + 오른쪽 끝에 수 */
export function pathsCollapsed(m: Measure, p: PathsParsed, paint: ToolPaint): BodyLine[] {
  return p.groups.map((g) => (w: number) => {
    const count = String(g.names.length);
    return spread(m, paint.fg("accent", middle(m, g.dir, Math.max(4, w - m.width(count) - 2))), paint.fg("muted", count), w);
  });
}

/** 펼침: 폴더 아래에 이름을 너비에 맞춰 여러 칸으로 (줄 수가 너비에 따라 바뀐다) */
export function pathsExpanded(m: Measure, p: PathsParsed, paint: ToolPaint): (width: number) => string[] {
  return (w: number) => {
    const out: string[] = [];
    for (const g of p.groups) {
      out.push(paint.fg("accent", middle(m, g.dir, Math.max(4, w))));
      const nameW = Math.min(40, Math.max(...g.names.map((n) => m.width(n))));
      const cell = nameW + 3;
      const per = Math.max(1, Math.floor((w - 2) / cell));
      for (let i = 0; i < g.names.length; i += per) {
        const row = g.names.slice(i, i + per).map((n) => {
          const shown = m.width(n) > nameW ? middle(m, n, nameW) : n;
          return paint.fg("toolOutput", shown) + " ".repeat(cell - m.width(shown));
        });
        out.push(`  ${row.join("").trimEnd()}`);
      }
    }
    return out;
  };
}

/** rg 줄 출력 → grep 과 같은 묶음 (줄 번호가 없으면 n = 0) */
export function parseRgLines(lines: string[]): GrepParsed | null {
  const files: GrepParsed["files"] = [];
  const by = new Map<string, GrepParsed["files"][number]>();
  for (const raw of clean(lines)) {
    if (raw === "--") continue;
    const m = raw.match(/^((?:[A-Za-z]:)?[^:]*?):(\d+):(.*)$/) ?? raw.match(/^((?:[A-Za-z]:)?[^:]*?)-(\d+)-(.*)$/) ?? raw.match(/^((?:[A-Za-z]:)?[^:]+):(.*)$/);
    if (!m) return null;
    const ctx = !raw.startsWith(`${m[1]}:`);
    const [path, n, text] = m.length === 4 ? [m[1], Number(m[2]), m[3]] : [m[1], 0, m[2]];
    let f = by.get(path);
    if (!f) { f = { path, matches: 0, lines: [] }; by.set(path, f); files.push(f); }
    f.lines.push({ n, text, match: !ctx });
    if (!ctx) f.matches++;
  }
  return { files, matches: files.reduce((s, f) => s + f.matches, 0) };
}

/** rg -c 출력 `경로:수` → 묶음 (줄 없음) */
export function parseRgCount(lines: string[]): GrepParsed | null {
  const files: GrepParsed["files"] = [];
  for (const raw of clean(lines)) {
    const m = raw.match(/^((?:[A-Za-z]:)?[^:]*):(\d+)$/);
    if (!m) return null;
    files.push({ path: m[1], matches: Number(m[2]), lines: [] });
  }
  return { files, matches: files.reduce((s, f) => s + f.matches, 0) };
}

/**
 * bash 안의 fd · rg 결과 (docs/pi-tui-spec.md §7.2 §7.3). 읽을 수 없거나 진짜 실패면 null (일반 bash 그리기).
 * ok: rg 가 결과 없이 종료 1 로 끝남 (오류가 아님)
 */
export function searchView(m: Measure, kind: SearchKind, b: BashParsed, expanded: boolean, p: ToolPaint, vbar = "│"): { view: ResultView; ok?: boolean } | null {
  if (b.reason) return null;
  const noMatch = kind.tool === "rg" && b.exit === 1 && b.lines.length === 0;
  if (b.exit !== 0 && !noMatch) return null;
  const warn = b.truncated ? p.fg("warning", ` · 잘림 · 전체 ${b.truncated.total}줄`) : "";
  if (noMatch) return { view: { summary: p.fg("text", "결과 없음"), body: [], keep: "head", max: 0, unit: "줄" }, ok: true };
  if (kind.tool === "fd" || kind.mode === "paths") {
    const parsed = groupPaths(b.lines);
    return { view: {
      summary: p.fg(parsed.files || parsed.dirs ? "success" : "text", pathsSummary(parsed)) + warn,
      body: expanded ? pathsExpanded(m, parsed, p) : pathsCollapsed(m, parsed, p),
      keep: "head", max: 200, unit: expanded ? "줄" : "개 폴더",
    } };
  }
  const parsed = kind.mode === "count" ? parseRgCount(b.lines) : parseRgLines(b.lines);
  if (!parsed) return null;
  const s = grepSummary(parsed, undefined);
  return { view: {
    summary: p.fg(parsed.matches ? "success" : "text", s.text) + warn,
    body: expanded && kind.mode === "lines" ? grepExpanded(m, parsed, null, vbar, p) : grepCollapsed(m, parsed, p),
    keep: "head", max: 200, unit: expanded && kind.mode === "lines" ? "줄" : "개 파일",
  } };
}

