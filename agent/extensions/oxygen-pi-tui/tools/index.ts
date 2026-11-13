// 도구 줄 그리기를 pi 에 등록한다 (docs/pi-tui-spec.md §4 §7). 실행 · 모델이 받는 글은 바꾸지 않는다.
// registerToolRenderer 로 돌려준 그리기는 내장 도구의 그리기보다 앞선다 (1단계 실측 F3). 꺼져 있으면 next() 로 넘긴다.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { measure } from "../chrome.ts";
import { type Glyphs, glyphs } from "../glyphs.ts";
import { bashSummary, commandHead, diffStats, errorLines, lineCount, parseBash, readRange, relPath, textOf } from "./basic.ts";
import { type ResultView, type ToolPaint, type ToolStatus, callLine, fmtDuration, resultLines } from "./frame.ts";
import { grepArgs, grepExpanded, matcher, parseGrep } from "./grep.ts";
import { searchCommand, searchView } from "./search.ts";
import { backgroundArgs, backgroundView, parseJobNotice } from "./jobs.ts";
import { SYSTEM_TOOLS, systemDetails, systemSentence } from "./system.ts";
import { ONE_LINE_TOOLS, type Sentence, editSentence, failSentence, grepSentence, readSentence, runningSentence, writeSentence } from "./primitive.ts";
import { brandEnv, brandFg } from "../brand.ts";

/** width 마다 줄을 만드는 컴포넌트 */
function lines(fn: (width: number) => string[]): Component {
  return { render: (w: number) => fn(w), invalidate() {} } as Component;
}

/** pi 기본 그리기를 3칸 들여 붙인다 (펼친 read · edit) */
function indented(c: Component | undefined): Component | undefined {
  if (!c) return undefined;
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").trim();
  return {
    render: (w: number) => {
      const ls = c.render(Math.max(1, w - 3));
      while (ls.length && !strip(ls[0])) ls.shift();   // pi 기본 그리기는 빈 줄로 시작한다
      return ls.map((l) => `   ${l}`);
    },
    invalidate: () => c.invalidate?.(),
  } as Component;
}

function stack(parts: (Component | undefined)[]): Component {
  const cs = parts.filter(Boolean) as Component[];
  return { render: (w: number) => cs.flatMap((c) => c.render(w)), invalidate: () => cs.forEach((c) => c.invalidate?.()) } as Component;
}

const statusFrom = (c: any): ToolStatus => (c?.isError ? "fail" : c?.isPartial ? "running" : "ok");
const expandKey = (c: any): string => { try { return c?.keyText?.("app.tools.expand") || "ctrl+o"; } catch { return "ctrl+o"; } };

/** 접기 키 (입력창이 비어 있을 때만, index.ts 의 onTerminalInput). 입력 중의 Ctrl+K 는 pi 의 "줄 끝까지 지우기" 그대로 */
export const FOLD_KEY = "ctrl+k";
/** 접음 상태: 모든 도구 줄이 요약 줄만 보인다 (docs/pi-tui-spec.md §4). 그릴 때마다 읽는다 */
let folded = false;
export const isFolded = (): boolean => folded;
export function setFolded(v: boolean): void { folded = v; }

type Summarizer = {
  call(args: any, ctx: any): { title: string; args: string };
  result(r: { content: unknown; details: any }, o: { expanded: boolean; isPartial: boolean }, ctx: any, p: ToolPaint, g: Glyphs): { view: ResultView; extra?: "base" };
};

/** 오류 결과 공통: 첫 줄을 요약, 나머지를 본문 */
function errorView(text: string, p: ToolPaint): ResultView {
  const e = errorLines(text);
  return { summary: p.fg("error", e.first), body: e.rest.map((l) => p.fg("toolOutput", l)), keep: "head", max: 200, unit: "line" };
}

// read · write · edit · grep 은 한 줄 문장 (oneLineRenderer, primitive.ts). 여기는 두 줄(실행 줄 + 요약) 도구
export const SUMMARIZERS: Record<string, Summarizer> = {
  // oxy-jobs 의 background (docs/ui-unify-spec.md §2.5)
  background: {
    call: (a) => ({ title: "background", args: backgroundArgs(a) }),
    result: (r, _o, c, p) => {
      const text = textOf(r.content);
      if (c?.isError) return { view: errorView(text, p) };
      const v = backgroundView(String(c?.args?.action ?? ""), text);
      return { view: { summary: p.fg(v.level, v.summary), body: v.body.map((l) => p.fg("toolOutput", l)), keep: v.keep, max: 200, unit: "line" } };
    },
  },
  bash: {
    call: (a) => ({ title: "$", args: commandHead(a?.command) }),
    result: (r, o, c, p) => {
      const b = parseBash(textOf(r.content), Boolean(c?.isError));
      const kind = o.isPartial ? null : searchCommand(c?.args?.command);
      const sv = kind ? searchView(measure, kind, b, o.expanded, p, glyphs().vbar) : null;
      if (sv) {
        if (sv.ok && c?.state) c.state.oxyStatus = "ok";       // rg 가 결과 없이 1로 끝남: 실패 표시(×)를 하지 않는다
        return { view: sv.view };
      }
      const s = bashSummary(b, o.isPartial);
      let summary = p.fg(s.level, s.text);
      if (b.truncated) summary += p.fg("warning", `, truncated (${b.truncated.total} lines in total${b.truncated.fullPath ? `: ${b.truncated.fullPath}` : ""})`);
      return { view: { summary, body: b.lines.map((l) => p.fg("toolOutput", l)), keep: "tail", max: 200, unit: "line" } };
    },
  },
};

export function registerToolRows(pi: ExtensionAPI, isOn: () => boolean, glyphMode: () => "unicode" | "ascii"): void {
  pi.registerToolRenderer((toolName, next) => {
    if (SYSTEM_TOOLS.has(toolName)) return isOn() ? systemRenderer(toolName, glyphMode) : next();
    if (ONE_LINE_TOOLS.has(toolName)) return isOn() ? oneLineRenderer(toolName, next(), glyphMode) : next();
    const s = SUMMARIZERS[toolName];
    if (!s || !isOn()) return next();
    const base = next();
    return {
      renderShell: "self",
      renderCall(args: any, theme: any, context: any) {
        const g = glyphs(glyphMode());
        const v = s.call(args, context);
        return lines((w) => [callLine(measure, g, w, { status: context?.state?.oxyStatus ?? statusFrom(context), title: v.title, args: v.args, durationMs: context?.durationMs }, theme)]);
      },
      renderResult(result: any, options: any, theme: any, context: any) {
        const g = glyphs(glyphMode());
        const { view, extra } = s.result(result, { expanded: Boolean(options?.expanded), isPartial: Boolean(options?.isPartial) }, context, theme, g);
        const own = lines((w) => resultLines(measure, g, w, view, Boolean(options?.expanded), { open: expandKey(context), fold: FOLD_KEY }, theme, folded));
        if (extra !== "base" || !base?.renderResult || folded) return own;
        let more: Component | undefined;
        try { more = base.renderResult(result, options, theme, { ...context, lastComponent: undefined }) as Component; } catch { more = undefined; }
        return stack([own, indented(more)]);
      },
    } as any;
  });
}

/** 한 줄 문장 (primitive.ts): ` ✓ Read sample.txt, 12 lines        0.0s` — 동사 굵게 · 대상 강조색 · 결과 본문색, 오른쪽 걸린 시간 */
function sentenceLine(g: Glyphs, width: number, status: ToolStatus, v: Sentence, p: ToolPaint, durationMs?: number): string {
  const glyph = status === "running" ? p.fg("warning", g.running) : status === "fail" ? p.fg("error", g.fail) : p.fg("success", g.ok);
  const tail = v.parts ? v.parts.map((x) => p.fg(x.tone, x.text)).join("") : v.detail ? p.fg(status === "fail" ? "error" : "text", v.detail) : "";
  const dur = status === "running" ? "" : fmtDuration(durationMs);
  const right = dur ? `${p.fg("muted", dur)} ` : "";
  const room = width - (right ? measure.width(right) + 1 : 0);
  // 넘치면 결과(tail)는 두고 대상(긴 경로 · 패턴)을 줄인다
  const fixed = measure.width(` ${glyph} ${p.bold(v.verb)} `) + measure.width(tail);
  const target = v.target && fixed + measure.width(v.target) > room && room - fixed >= 8 ? measure.trunc(v.target, room - fixed, "…") : v.target;
  const left = ` ${glyph} ${p.fg("toolTitle", p.bold(v.verb))}${target ? ` ${p.fg("accent", target)}` : ""}${tail}`;
  const l = measure.width(left) > room ? measure.trunc(left, Math.max(1, room), "…") : left;
  const gap = Math.max(1, width - measure.width(l) - measure.width(right));
  return right ? l + " ".repeat(gap) + right : l;
}

/** 도구 대상: read · write · edit 는 파일, grep 은 패턴 + 위치 */
function targetOf(toolName: string, a: any, cwd: string): string {
  if (toolName === "grep") return grepArgs(a, relPath(a?.path, cwd));
  const t = relPath(a?.path, cwd);
  return toolName === "read" ? `${t}${readRange(a?.offset, a?.limit)}` : t;
}

/**
 * 기본 도구 한 줄 (docs/pi-tui-spec.md §7.6): 실행 중에는 실행 줄(`○ Reading x..`), 끝나면 결과 줄 하나(`✓ Read x, 12 lines`).
 * 세부 내용(파일 내용 · diff · 찾은 줄 · 오류 나머지)은 펼쳤을 때만 (기본 접힘), Ctrl+K 는 다른 줄처럼 접는다
 */
function oneLineRenderer(toolName: string, base: any, glyphMode: () => "unicode" | "ascii"): any {
  return {
    renderShell: "self",
    renderCall(args: any, theme: any, context: any) {
      // 결과가 오면(걸린 시간이 생기면) 실행 줄은 그리지 않는다. 결과 줄이 대신한다
      if (context?.durationMs !== undefined || context?.state?.oxyDone) return lines(() => []);
      const g = glyphs(glyphMode());
      return lines((w) => [sentenceLine(g, w, "running", runningSentence(toolName, targetOf(toolName, args, context?.cwd ?? "")), theme)]);
    },
    renderResult(result: any, options: any, theme: any, context: any) {
      if (context?.state && !options?.isPartial) context.state.oxyDone = true;
      const g = glyphs(glyphMode());
      const a = context?.args ?? {};
      const target = targetOf(toolName, a, context?.cwd ?? "");
      const text = textOf(result?.content);
      const expanded = Boolean(options?.expanded) && !folded;
      const indent = (ls: string[]) => ls.map((l) => `   ${l}`);
      if (context?.isError) {
        const e = errorLines(text);
        return lines((w) => [sentenceLine(g, w, "fail", failSentence(toolName, target, e.first), theme, context?.durationMs),
          ...(expanded ? indent(e.rest.map((l) => theme.fg("toolOutput", l))).map((l) => measure.trunc(l, w, "…")) : [])]);
      }
      let v: Sentence;
      let body: ((w: number) => string[]) | null = null;
      if (toolName === "grep") {
        const parsed = parseGrep(text);
        const d = result?.details;
        v = parsed ? grepSentence(target, parsed.matches, parsed.files.length, { limit: d?.matchLimitReached, size: d?.truncation?.truncated, lines: d?.linesTruncated })
          : { verb: "Searched", target };
        if (expanded) {
          body = parsed
            ? (w) => { const ex = grepExpanded(measure, parsed, matcher(a.pattern, { literal: a.literal, ignoreCase: a.ignoreCase }), g.vbar, theme); const all = typeof ex === "function" ? ex(Math.max(1, w - 3)) : ex.map((l: any) => (typeof l === "function" ? l(Math.max(1, w - 3)) : l)); return indent(all); }
            : () => indent(text.split("\n").map((l) => theme.fg("toolOutput", l)));
        }
      } else if (toolName === "read") {
        const img = Array.isArray(result?.content) && result.content.some((x: any) => x?.type === "image");
        v = readSentence(target, lineCount(text), result?.details?.truncation?.totalLines, img);
      } else if (toolName === "edit") {
        const d = diffStats(result?.details?.diff);
        v = editSentence(target, d.added, d.removed);
      } else {
        v = writeSentence(target, lineCount(String(a.content ?? "")));
      }
      const head = lines((w) => [sentenceLine(g, w, statusFrom(context), v, theme, context?.durationMs), ...(body ? body(w).map((l) => measure.trunc(l, w, "…")) : [])]);
      // read · edit · write 의 펼친 내용은 pi 기본 그리기 (파일 내용 · diff)를 3칸 들여 붙인다
      if (toolName === "grep" || !expanded || !base?.renderResult) return head;
      let more: Component | undefined;
      try { more = base.renderResult(result, options, theme, { ...context, lastComponent: undefined }) as Component; } catch { more = undefined; }
      return stack([head, indented(more)]);
    },
  };
}

/**
 * 시스템 작업 줄 (system.ts, docs/pi-tui-spec.md §7.5): 한 줄 문장(o2.mid, 실패는 오류색). 펼치면(Ctrl+O) 넘긴 값 · 결과, 기본은 접힘.
 * 실행 줄은 그리지 않는다 (도구 이름을 보이지 않는다). 결과가 오기 전에는 아무것도 보이지 않는다
 */
function systemRenderer(toolName: string, glyphMode: () => "unicode" | "ascii"): any {
  return {
    renderShell: "self",
    renderCall() { return lines(() => []); },
    renderResult(result: any, options: any, theme: any, context: any) {
      const g = glyphs(glyphMode());
      const text = textOf(result?.content);
      const isError = Boolean(context?.isError);
      const sentence = systemSentence(toolName, context?.args, text, isError);
      const env = brandEnv(theme);
      const mid = (x: string) => brandFg("mid", x, env);
      const head = isError ? ` ${theme.fg("error", g.fail)} ${theme.fg("error", sentence)}` : ` ${mid(g.system)} ${mid(sentence)}`;
      const open = Boolean(options?.expanded) && !folded;
      return lines((w) => [measure.trunc(head, w, "…"),
        ...(open ? systemDetails(context?.args, text).map((l) => measure.trunc(`   ${theme.fg("toolOutput", l)}`, w, "…")) : [])]);
    },
  };
}

/**
 * background 작업이 끝났다는 알림(customType oxy-jobs, oxy-jobs 가 sendMessage 로 넣음)을 도구 줄과 같은 틀로 그린다
 * (docs/ui-unify-spec.md §2.5): `✓ background <명령>  2s` / `└ Job-1 done!, print 12 lines` + 마지막 3줄. 모르는 모양이면 pi 기본
 */
export function registerJobNotices(pi: ExtensionAPI, isOn: () => boolean, glyphMode: () => "unicode" | "ascii"): void {
  pi.registerMessageRenderer("oxy-jobs", (message: any, options: any, theme: any) => {
    if (!isOn()) return undefined;
    const text = typeof message?.content === "string" ? message.content : textOf(message?.content);
    const n = parseJobNotice(text);
    if (!n) return undefined;
    const g = glyphs(glyphMode());
    const status: ToolStatus = n.tone === "success" ? "ok" : n.tone === "error" ? "fail" : "running";
    let open = "ctrl+o";
    try { open = options?.keyText?.("app.tools.expand") || open; } catch { /* 기본 키 */ }
    const view: ResultView = { summary: theme.fg(n.tone, n.summary), body: n.body.map((l) => theme.fg("toolOutput", l)), keep: "tail", max: 200, unit: "line" };
    return lines((w) => ["", callLine(measure, g, w, { status, title: "background", args: n.title, right: n.duration }, theme),
      ...resultLines(measure, g, w, view, Boolean(options?.expanded), { open, fold: FOLD_KEY }, theme, folded)]);
  });
}
