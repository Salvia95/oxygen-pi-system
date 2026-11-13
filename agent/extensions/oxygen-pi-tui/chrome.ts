// 입력창 · 푸터를 pi 에 붙인다 (docs/pi-tui-spec.md §5 §6). 그리기는 editor.ts · footer.ts 의 순수 함수.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CustomEditor, type ExtensionAPI, type ExtensionContext, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { type EditorTheme, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { enabled, harnessHome } from "../_lib/common.ts";
import { brandEnv, brandFg } from "./brand.ts";
import type { TuiConfig } from "./config.ts";
import { bottomLeftLabel, borderLine, modelLabel, topLeftLabel, usageLabel, usageLevel, withPrompt } from "./editor.ts";
import { footerLine, footerStatuses } from "./footer.ts";
import { headerLines } from "./header.ts";
import { glyphs, spinnerFrame } from "./glyphs.ts";
import { type Measure, homePath, widthClass } from "./layout.ts";

export const measure: Measure = {
  width: (s) => visibleWidth(s),
  trunc: (s, w, e = "…") => (visibleWidth(s) <= w ? s : truncateToWidth(s, w, e)),
};

/** 화면 상태 (index.ts 가 이벤트로 채운다) */
export interface ChromeState {
  workingSince: number | null;
  cost: number;
}

/** 하단 바(oxy-monitor)가 그려지는가. oxy-monitor 는 OXY_MONITOR 가 꺼져 있지 않으면 psmux 안팎 모두 바를 그린다 (2단계 실측) */
export function barMode(): boolean {
  return enabled("MONITOR");
}

/** 이번 세션 가지(branch)의 어시스턴트 응답 비용 합 */
export function sessionCost(ctx: ExtensionContext): number {
  let cost = 0;
  try {
    for (const e of ctx.sessionManager.getBranch() as any[]) {
      if (e?.type === "message" && e.message?.role === "assistant") cost += Number(e.message.usage?.cost?.total ?? 0) || 0;
    }
  } catch { /* 세션이 바뀌는 중 */ }
  return cost;
}

export function installEditor(pi: ExtensionAPI, ctx: ExtensionContext, cfg: TuiConfig, state: ChromeState): void {
  const g = glyphs(cfg.glyphs);
  class OxygenEditor extends CustomEditor {
    private indicator: any;
    private hiddenAbove = 0;
    constructor(tui: TUI, theme: EditorTheme, kb: KeybindingsManager) {
      super(tui, theme, kb, { paddingX: 3, embedWorkingStatus: true });
    }
    // pi 는 새 입력창에 사용자 설정 editorPaddingX 를 다시 넣는다. ` › ` 자리(3칸)를 지키려고 늘 3으로 둔다
    setPaddingX(_padding: number): void { super.setPaddingX(3); }
    // pi 가 작업 · 재시도 · 압축 표시를 테두리에 넘긴다 (embedWorkingStatus). 받아 두고 윗줄에 직접 그린다
    setWorkingStatusIndicator(indicator: any): void {
      this.indicator = indicator;
      super.setWorkingStatusIndicator(indicator);
    }
    private paintFor(working: boolean): (s: string) => string {
      const th = ctx.ui.theme;
      return working ? (s: string) => brandFg("sage", s, brandEnv(th)) : (s: string) => this.borderColor(s);
    }
    protected renderTopBorder(width: number, hiddenLineCount: number): string {
      this.hiddenAbove = hiddenLineCount;
      const th = ctx.ui.theme;
      const wc = widthClass(width);
      const kind: string | undefined = this.indicator?.kind;
      const working = Boolean(this.indicator);
      let left: string;
      if (!this.indicator) left = th.fg("text", topLeftLabel(null, hiddenLineCount));
      else if (kind === "working") {
        const since = state.workingSince ?? Date.now();
        const label = topLeftLabel({ frame: spinnerFrame(g, Date.now() - since), seconds: Math.floor((Date.now() - since) / 1000) }, hiddenLineCount);
        left = brandFg("sage", label, brandEnv(th));
      } else {
        left = this.indicator.renderInBorder(Math.max(1, width - 8));   // 재시도 · 압축 등 pi 의 문구 그대로
      }
      const m = ctx.model as any;
      const right = th.fg("muted", modelLabel({ provider: m?.provider, id: m?.id, reasoning: m?.reasoning, thinking: pi.getThinkingLevel() }, wc, g.sep));
      return borderLine(measure, g, width, [g.tl, g.tr], left, right, this.paintFor(working));
    }
    protected renderBottomBorder(width: number, hiddenLineCount: number): string {
      const th = ctx.ui.theme;
      const wc = widthClass(width);
      const u = (() => { try { return ctx.getContextUsage(); } catch { return undefined; } })();
      const label = usageLabel({ tokens: u?.tokens, contextWindow: u?.contextWindow, percent: u?.percent, cost: state.cost }, wc, g.sep);
      const lv = usageLevel(u?.percent);
      const right = th.fg(lv === "normal" ? "muted" : lv, label);
      const bl = bottomLeftLabel(hiddenLineCount);
      const left = bl ? th.fg("text", bl) : "";   // 한글은 회색으로 쓰지 않는다 (oxygen-design)
      return borderLine(measure, g, width, [g.bl, g.br], left, right, this.paintFor(Boolean(this.indicator)));
    }
    render(width: number): string[] {
      const lines = super.render(width);
      if (lines.length >= 3 && this.hiddenAbove === 0) lines[1] = withPrompt(lines[1], ctx.ui.theme.fg("accent", g.prompt));
      return lines;
    }
  }
  ctx.ui.setWorkingIndicator({ frames: [...g.spinner], intervalMs: 150 });
  ctx.ui.setEditorComponent((tui, theme, kb) => new OxygenEditor(tui, theme, kb));
}

export function installFooter(ctx: ExtensionContext, cfg: TuiConfig): void {
  const g = glyphs(cfg.glyphs);
  const bar = barMode();
  ctx.ui.setFooter((tui, theme, data: any) => {
    const unsub = data.onBranchChange?.(() => tui.requestRender());
    return {
      dispose: () => unsub?.(),
      invalidate() {},
      render(width: number): string[] {
        const statuses = footerStatuses(data.getExtensionStatuses?.() ?? new Map(), bar);
        const cwd = homePath(ctx.cwd, homedir());
        return [footerLine(measure, width, cwd, data.getGitBranch?.() ?? undefined, statuses, {
          muted: (s) => theme.fg("muted", s), text: (s) => theme.fg("text", s), accent: (s) => theme.fg("accent", s), sep: g.sep,
        })];
      },
    };
  });
}

/** Oxygen Pi 버전 (설치 폴더의 VERSION 파일) */
export function oxygenVersion(): string {
  const home = harnessHome();
  const file = home ? join(home, "VERSION") : "";
  try { return file && existsSync(file) ? readFileSync(file, "utf8").trim() : ""; } catch { return ""; }
}

/** 헤더 (§3) · 숨긴 생각 라벨 (§4). 브랜치는 띄울 때 한 번 git 으로 읽는다 */
export function installHeader(pi: ExtensionAPI, ctx: ExtensionContext, cfg: TuiConfig): void {
  const g = glyphs(cfg.glyphs);
  const version = oxygenVersion();
  ctx.ui.setHeader((_tui, theme) => {
    const env = () => brandEnv(theme);
    return {
      invalidate() {},
      render(width: number): string[] {
        return headerLines(measure, g, width, widthClass(width), { version }, {
          brand: (s) => theme.bold(brandFg("sage", s, env())), pi: (s) => theme.bold(brandFg("purple", s, env())),
          frame: (s) => brandFg("mid", s, env()), sub: (s) => brandFg("mid", s, env()),
          text: (s) => theme.fg("text", s), muted: (s) => theme.fg("muted", s), accent: (s) => theme.fg("accent", s), env: env(),
        });
      },
    };
  });
  ctx.ui.setHiddenThinkingLabel("생각 과정");
}

export function restoreChrome(ctx: ExtensionContext): void {
  ctx.ui.setHeader(undefined);
  ctx.ui.setHiddenThinkingLabel(undefined);
  ctx.ui.setEditorComponent(undefined);
  ctx.ui.setFooter(undefined);
  ctx.ui.setWorkingIndicator(undefined);
}
