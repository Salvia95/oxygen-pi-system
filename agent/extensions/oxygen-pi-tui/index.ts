/**
 * oxygen-pi-tui: pi 대화 화면(헤더 · 메시지창 · 입력창 · 푸터)을 Oxygen 기준으로 다시 그리고, 기본 도구 출력을 구조화해 보인다.
 * 명세: docs/pi-tui-spec.md. 색 · 글꼴 · 기호 기준: .claude/rules/oxygen-design.md
 *   /oxygen-pi-tui           지금 상태
 *   /oxygen-pi-tui on | off  켜기 · 끄기 (pi 기본 화면으로 되돌림). <agent>/oxygen-pi-tui.json 에 저장
 * 대화형 모드(tui)에서만 동작한다. -p · json · rpc · subagent 에서는 아무것도 하지 않는다.
 * 끄기(이번 실행만): OXY_PI_TUI=off
 */
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { enabled } from "../_lib/common.ts";
import { type ChromeState, installEditor, installFooter, installHeader, restoreChrome, sessionCost } from "./chrome.ts";
import { type TuiConfig, loadConfig, saveConfig } from "./config.ts";
import { FOLD_KEY, isFolded, registerJobNotices, registerToolRows, setFolded } from "./tools/index.ts";
import { markUser } from "./user.ts";
import { matchesKey } from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI) {
  if (!enabled("PI_TUI")) return;
  const file = join(getAgentDir(), "oxygen-pi-tui.json");
  let cfg: TuiConfig = loadConfig(file);
  let applied = false;
  const state: ChromeState = { workingSince: null, cost: 0 };

  let offKeys: (() => void) | undefined;
  /**
   * 도구 줄 접기 (docs/pi-tui-spec.md §4): 입력창이 비어 있을 때 Ctrl+K 는 접기 · 풀기. 입력 중의 Ctrl+K 는 pi 의
   * "줄 끝까지 지우기" 그대로 둔다. Ctrl+O(펼치기)는 접힌 것도 푼다 (pi 의 펼치기 동작은 그대로 이어진다).
   * 바꾼 뒤 pi 의 펼침 값을 다시 넣어 모든 도구 줄을 다시 그리게 한다.
   */
  const watchKeys = (ctx: ExtensionContext) => {
    offKeys?.();
    offKeys = ctx.ui.onTerminalInput((data: string) => {
      if (matchesKey(data, FOLD_KEY) && ctx.ui.getEditorText() === "") {
        setFolded(!isFolded());
        // pi 는 같은 값이면 다시 그리지 않는다 (setToolsExpanded 가 그냥 돌아감). 한 번 뒤집었다 되돌려 모든 도구 줄을 다시 그린다
        const target = isFolded() ? false : ctx.ui.getToolsExpanded();
        ctx.ui.setToolsExpanded(!target);
        ctx.ui.setToolsExpanded(target);
        return { consume: true };
      }
      if (matchesKey(data, "ctrl+o") && isFolded()) setFolded(false);
      return undefined;
    });
  };

  const apply = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui" || !cfg.enabled) return;
    state.cost = sessionCost(ctx);
    installHeader(pi, ctx, cfg);
    installEditor(pi, ctx, cfg, state);
    installFooter(ctx, cfg);
    watchKeys(ctx);
    applied = true;
  };
  const restore = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;
    restoreChrome(ctx);
    offKeys?.(); offKeys = undefined;
    setFolded(false);
    applied = false;
  };

  // 도구 줄: 등록은 한 번, 켜짐 여부는 그릴 때마다 본다 (꺼지면 pi 기본 그리기)
  registerToolRows(pi, () => cfg.enabled, () => cfg.glyphs);
  registerJobNotices(pi, () => cfg.enabled, () => cfg.glyphs);
  // 사용자 입력 앞 `>` (user.ts). 꺼져 있으면 그대로
  pi.registerMarkdownTransformer((md, c) => (cfg.enabled && c.messageType === "user" ? markUser(md) : md));

  pi.on("session_start", (_e, ctx) => apply(ctx));
  pi.on("agent_start", () => { state.workingSince = Date.now(); });
  pi.on("agent_settled", () => { state.workingSince = null; });
  pi.on("message_end", (_e, ctx) => { state.cost = sessionCost(ctx); });

  pi.registerCommand("oxygen-pi-tui", {
    description: "Oxygen 화면 켜기 · 끄기 (on | off)",
    getArgumentCompletions: (prefix: string) =>
      ["on", "off"].filter((a) => a.startsWith(prefix.trim())).map((a) => ({ value: a, label: a })),
    handler: async (args, ctx) => {
      const a = args.trim().toLowerCase();
      if (a === "on" || a === "off") {
        cfg = { ...cfg, enabled: a === "on" };
        saveConfig(file, cfg);
        if (cfg.enabled) apply(ctx); else restore(ctx);
        ctx.ui.notify(cfg.enabled ? "Oxygen 화면을 켰습니다." : "Oxygen 화면을 껐습니다. pi 기본 화면으로 돌아갑니다.", "info");
        return;
      }
      if (a) { ctx.ui.notify("사용법: /oxygen-pi-tui on | off", "warning"); return; }
      ctx.ui.notify(`Oxygen 화면: ${cfg.enabled ? "켜짐" : "꺼짐"}${applied ? "" : " (이 화면에는 적용되지 않음)"} · 기호 ${cfg.glyphs}`, "info");
    },
  });
}
