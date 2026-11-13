// 도구 줄 그리기를 pi 에 등록한다 (docs/pi-tui-spec.md §4 §7). 실행 · 모델이 받는 글은 바꾸지 않는다.
// registerToolRenderer 로 돌려준 그리기는 내장 도구의 그리기보다 앞선다 (1단계 실측 F3). 꺼져 있으면 next() 로 넘긴다.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { measure } from "../chrome.ts";
import { type Glyphs, glyphs } from "../glyphs.ts";
import { bashSummary, commandHead, diffStats, errorLines, lineCount, parseBash, readRange, relPath, textOf } from "./basic.ts";
import { type ResultView, type ToolPaint, type ToolStatus, callLine, resultLines } from "./frame.ts";
import { grepArgs, grepCollapsed, grepExpanded, grepSummary, matcher, parseGrep } from "./grep.ts";
import { searchCommand, searchView } from "./search.ts";
import { backgroundArgs, backgroundView, parseJobNotice } from "./jobs.ts";
import { SYSTEM_TOOLS, systemDetails, systemSentence } from "./system.ts";
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
  grep: {
    call: (a, c) => ({ title: "grep", args: grepArgs(a, relPath(a?.path, c?.cwd ?? "")) }),
    result: (r, o, c, p, g) => {
      const text = textOf(r.content);
      if (c?.isError) return { view: errorView(text, p) };
      const parsed = parseGrep(text);
      if (!parsed) return { view: { summary: p.fg("text", "결과"), body: text.split("\n").map((l) => p.fg("toolOutput", l)), keep: "head", max: 200, unit: "line" } };
      const s = grepSummary(parsed, r.details);
      const summary = p.fg(parsed.matches ? "success" : "text", s.text) + (s.warn ? p.fg("warning", ` · ${s.warn}`) : "");
      const a = c?.args ?? {};
      const body = o.expanded
        ? grepExpanded(measure, parsed, matcher(a.pattern, { literal: a.literal, ignoreCase: a.ignoreCase }), g.vbar, p)
        : grepCollapsed(measure, parsed, p);
      return { view: { summary, body, keep: "head", max: 200, unit: o.expanded ? "line" : "file" } };
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
  read: {
    call: (a, c) => ({ title: "read", args: `${relPath(a?.path, c?.cwd ?? "")}${readRange(a?.offset, a?.limit)}` }),
    result: (r, o, c, p) => {
      const text = textOf(r.content);
      if (c?.isError) return { view: errorView(text, p) };
      const img = Array.isArray(r.content) && r.content.some((x: any) => x?.type === "image");
      const n = lineCount(text);
      const total = r.details?.truncation?.totalLines;
      const summary = img ? p.fg("success", "이미지") : p.fg("success", total && total > n ? `전체 ${total}줄 중 ${n}줄` : `${n}줄`);
      return { view: { summary, body: [], keep: "head", max: 0, unit: "line" }, extra: o.expanded ? "base" : undefined };
    },
  },
  edit: {
    call: (a, c) => ({ title: "edit", args: relPath(a?.path, c?.cwd ?? "") }),
    result: (r, o, c, p) => {
      const text = textOf(r.content);
      if (c?.isError) return { view: errorView(text, p) };
      const d = diffStats(r.details?.diff);
      const summary = d.added || d.removed ? `${p.fg("success", `+${d.added}`)} ${p.fg("error", `-${d.removed}`)}` : p.fg("success", "고침");
      return { view: { summary, body: [], keep: "head", max: 0, unit: "line" }, extra: o.expanded ? "base" : undefined };
    },
  },
  write: {
    call: (a, c) => ({ title: "write", args: relPath(a?.path, c?.cwd ?? "") }),
    result: (r, _o, c, p) => {
      const text = textOf(r.content);
      if (c?.isError) return { view: errorView(text, p) };
      return { view: { summary: p.fg("success", `${lineCount(String(c?.args?.content ?? ""))}줄 씀`), body: [], keep: "head", max: 0, unit: "line" } };
    },
  },
};

export function registerToolRows(pi: ExtensionAPI, isOn: () => boolean, glyphMode: () => "unicode" | "ascii"): void {
  pi.registerToolRenderer((toolName, next) => {
    if (SYSTEM_TOOLS.has(toolName)) return isOn() ? systemRenderer(toolName, glyphMode) : next();
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
