/**
 * oxy-monitor: psmux 오른쪽 열의 모니터 pane (docs/monitor-spec.md §1) 과 입력창 아래 하단 바 (§2).
 *   하단 바  ▸ jobs 2 실행 중 · 1 완료   ▸ flow 3/7
 *            빈 입력창에서 ↓ 로 들어가 ←→ 로 고르고 Enter 로 열고 닫는다. ↑ · Esc 는 입력창으로, 글자 키는 입력창에 그대로 들어간다.
 *            클릭도 같다 (pi fullscreen 모드에서만 마우스를 받는다)
 *   /monitor jobs · /monitor flow   같은 동작
 *   psmux 안($TMUX · $TMUX_PANE)이면 모니터 pane 을, 밖이면 /jobs · /flow 를 연다.
 *   pi 를 끝내면(quit) 이 pi 가 연 모니터 pane 을 닫는다. 모니터는 pi pid 가 사라지면 스스로도 끝난다.
 * 끄기: OXY_MONITOR=off
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { enabled, harnessHome } from "../_lib/common.ts";
import { type BarKind, type BarRange, type FlowSummary, type JobsSummary, barItems, barLine, itemAt } from "./bar.ts";
import { PaneManager, monitorCommand, psmuxRunner } from "./pane.ts";
import { reassertMouseWhenReady } from "./mouse.ts";
import { type LiveInput, type LiveState, emptyLive, flowEvents, jobEvents, reduceLive } from "./live.ts";
import { StateWriter } from "../oxy-jobs/state.ts";

export const MONITOR_KINDS = ["jobs", "flow"] as const;
export type MonitorKind = (typeof MONITOR_KINDS)[number];

/** 하네스에 반입된 psmux.exe (없으면 null) */
function psmuxExe(): string | null {
  const home = harnessHome();
  const p = home ? join(home, "bin", "psmux.exe") : "";
  return p && existsSync(p) ? p : null;
}

/** psmux pane 안이면 관리자, 아니면 null (이유) */
export function paneManager(): { mgr: PaneManager | null; why?: string } {
  if (!process.env.TMUX || !process.env.TMUX_PANE) return { mgr: null, why: "psmux 세션 안에서 실행할 때만 모니터 pane을 열 수 있습니다." };
  const exe = psmuxExe();
  if (!exe) return { mgr: null, why: "psmux가 설치되지 않았습니다." };
  return { mgr: new PaneManager(psmuxRunner(exe), process.env.TMUX_PANE) };
}

const shared = <T>(name: string): T | undefined => (globalThis as any)[Symbol.for(name)];

export default function (pi: ExtensionAPI) {
  if (!enabled("MONITOR")) return;
  const agentDir = process.env.PI_CODING_AGENT_DIR || getAgentDir();
  const script = join(agentDir, "extensions", "oxy-monitor", "monitor.ts");
  const dirs = { agent: agentDir, root: harnessHome(join(agentDir, "..")) ?? join(agentDir, "..") };
  let cwd = process.cwd();
  const inPsmux = Boolean(process.env.TMUX && process.env.TMUX_PANE && psmuxExe());

  // ---------------------------------------------------------------- 모니터 pane
  let open = new Set<string>();
  const refreshOpen = () => {
    if (!inPsmux) return false;
    try {
      const now = new Set(paneManager().mgr?.list().map((p) => p.kind) ?? []);
      const changed = now.size !== open.size || [...now].some((k) => !open.has(k));
      open = now;
      return changed;
    } catch { return false; }
  };
  const toggle = (kind: MonitorKind): { ok: boolean; message: string } => {
    const { mgr, why } = paneManager();
    if (!mgr) return { ok: false, message: why! };
    try {
      const r = mgr.toggle(kind, monitorCommand(process.execPath, script, kind, process.pid, cwd, dirs), cwd);
      refreshOpen();
      return { ok: true, message: r === "opened" ? `${kind} 모니터를 열었습니다.` : `${kind} 모니터를 닫았습니다.` };
    } catch (e: any) {
      return { ok: false, message: String(e?.message ?? e) };
    }
  };

  /** 바 항목을 연다: psmux 안이면 모니터 pane, 밖이면 /jobs · /flow (§2) */
  let uiCtx: any = null;
  const activate = (kind: BarKind) => {
    if (inPsmux) {
      const r = toggle(kind);
      if (!r.ok) uiCtx?.ui?.notify(r.message, "warning");
      return;
    }
    // 명령으로 실행되게 expandPromptTemplates (없으면 "/jobs" 가 모델에게 보내는 메시지가 된다 — 실측). 대화상자가 열리므로 바에서 나온다
    focus = -1;
    setTimeout(() => void pi.sendUserMessage(`/${kind}`, { expandPromptTemplates: true }), 0);
  };

  pi.registerCommand("monitor", {
    description: "모니터 pane 켜고 끄기: /monitor jobs · /monitor flow (psmux 안에서)",
    handler: async (args: string, ctx: any) => {
      cwd = ctx.cwd ?? cwd;
      const kind = args.trim() as MonitorKind;
      if (!MONITOR_KINDS.includes(kind)) { ctx.ui.notify(`사용법: /monitor ${MONITOR_KINDS.join(" · /monitor ")}`, "info"); return; }
      const r = toggle(kind);
      ctx.ui.notify(r.message, r.ok ? "info" : "warning");
      tui?.requestRender();
    },
  });

  // ---------------------------------------------------------------- 하단 바
  let tui: any = null;
  let focus = -1;            // 키보드로 바에 들어온 동안 선택한 항목 (-1 = 바에 없음)
  let ranges: BarRange[] = [];
  const items = () => barItems(shared<{ summary(): JobsSummary }>("oxy.jobs")?.summary() ?? null,
    shared<{ summary(): FlowSummary | null }>("oxy.flow")?.summary() ?? null, open);

  const barComponent = (t: any, theme: any) => {
    tui = t;
    return {
      render(width: number): string[] {
        const list = items();
        if (focus >= list.length) focus = list.length - 1;
        if (!list.length) { ranges = []; return []; }
        const r = barLine(list, focus, width, {
          width: visibleWidth,
          item: (s, isOpen) => (isOpen ? theme.fg("accent", theme.bold(s)) : theme.fg("text", s)),
          focus: (s) => theme.bg("selectedBg", theme.fg("accent", theme.bold(s))),
          hint: (s) => theme.fg("text", s),
        });
        ranges = r.ranges;
        return [r.line];
      },
      handleMouse(e: any) {
        if (e.type !== "click" || e.button !== "left" || e.y !== 0) return undefined;
        const kind = itemAt(ranges, e.x);
        if (!kind) return undefined;
        activate(kind);
        return { handled: true, render: true };
      },
      invalidate() {},
    };
  };

  /** 입력창에 포커스가 있는지 (대화상자 · 오버레이에 있는 ↓ 는 가로채지 않는다) */
  const editorFocused = () => {
    const f = tui?.getFocusedComponent?.();
    return Boolean(f && typeof f.getText === "function" && typeof f.setText === "function" && !tui.hasOverlay?.());
  };

  const onInput = (data: string) => {
    if (focus < 0) {
      if (!matchesKey(data, "down") || !editorFocused() || uiCtx?.ui?.getEditorText?.() !== "") return undefined;
      if (!items().length) return undefined;
      focus = 0;
      tui?.requestRender();
      return { consume: true };
    }
    const n = items().length;
    if (matchesKey(data, "right")) focus = (focus + 1) % Math.max(1, n);
    else if (matchesKey(data, "left")) focus = (focus - 1 + n) % Math.max(1, n);
    else if (matchesKey(data, "enter")) { const it = items()[focus]; if (it) activate(it.kind); }
    else if (matchesKey(data, "up") || matchesKey(data, "escape")) focus = -1;
    else { focus = -1; tui?.requestRender(); return undefined; }   // 글자 키: 입력창으로 돌아가며 그대로 입력
    tui?.requestRender();
    return { consume: true };
  };

  // ---------------------------------------------------------------- 실시간 활동 live.json (docs/monitor-tui-spec.md §2)
  // 본 대화가 지금 무엇을 하는지(상태 · 실행 중인 도구 · 최근 이벤트)를 oxy-jobs 실행 폴더에 쓴다. 대화형만 (hasUI)
  let live: LiveState | null = null;
  let liveWriter: StateWriter | null = null;
  const feed = (ev: LiveInput) => {
    if (!live) return;
    live = reduceLive(live, ev, Date.now());
    liveWriter?.changed();
  };
  const modelName = (m: any): string | null => (m?.id ? (m.provider ? `${m.provider}/${m.id}` : String(m.id)) : null);
  const feedContext = (ctx: any) => {
    try { feed({ type: "context", percent: ctx?.getContextUsage?.()?.percent ?? null }); } catch { /* 사용률 없음 */ }
  };
  const startLive = (ctx: any) => {
    if (liveWriter || !ctx?.hasUI) return;
    const jobs = shared<any>("oxy.jobs");
    const dir: string | undefined = jobs?.runDir?.();
    if (!dir) return;                       // oxy-jobs 가 꺼져 있으면 모니터도 없다
    live = emptyLive(process.pid, Date.now());
    live.model = modelName(ctx.model);
    liveWriter = new StateWriter(dir, () => live, { fileName: "live.json" });
    feedContext(ctx);
    // 작업 시작 · 끝, 할 일 변화 · 새 커밋: 처음 본 상태를 기준으로 그 뒤의 변화만 알린다
    let jobsSeen = new Map<string, string>((jobs.jobs?.() ?? []).map((j: any) => [j.id, j.state]));
    let flowSeen: Parameters<typeof flowEvents>[0] = null;
    const onJobs = () => {
      const r = jobEvents(jobsSeen, jobs.jobs?.() ?? []);
      jobsSeen = r.seen;
      for (const e of r.events) feed({ type: "event", ...e });
    };
    const onFlow = () => {
      const f = shared<any>("oxy.flow")?.summary?.();
      if (!f) return;
      const r = flowEvents(flowSeen, f.items ?? [], f.lastNode ?? null);
      flowSeen = r.seen;
      for (const e of r.events) feed({ type: "event", ...e });
    };
    onFlow();
    for (const [name, fn] of [["oxy.jobs", onJobs], ["oxy.flow", onFlow]] as const) {
      const off = shared<{ onChange(fn: () => void): unknown }>(name)?.onChange(fn);
      if (typeof off === "function") cleanup.push(off as () => void);
    }
    cleanup.push(() => { liveWriter?.close(); liveWriter = null; live = null; });
  };
  pi.on("agent_start", async () => { feed({ type: "agent_start" }); });
  pi.on("turn_start", async (e: any) => { feed({ type: "turn_start", turnIndex: Number(e?.turnIndex ?? 0) }); });
  pi.on("tool_execution_start", async (e: any) => { feed({ type: "tool_start", id: String(e?.toolCallId ?? ""), name: String(e?.toolName ?? ""), input: e?.args }); });
  pi.on("tool_execution_end", async (e: any) => {
    feed({ type: "tool_end", id: String(e?.toolCallId ?? ""), name: String(e?.toolName ?? ""), ok: !e?.isError, input: e?.args });
  });
  pi.on("session_before_compact", async () => { feed({ type: "compact_start" }); return undefined; });
  pi.on("session_compact", async () => { feed({ type: "compact_end" }); });
  pi.on("session_compact_failed", async () => { feed({ type: "compact_end" }); });
  pi.on("turn_end", async (_e: any, ctx: any) => { feedContext(ctx); });
  pi.on("agent_settled", async (_e: any, ctx: any) => { feed({ type: "settled" }); feedContext(ctx); });
  pi.on("model_select", async (e: any) => { feed({ type: "model", model: modelName(e?.model) }); });
  pi.on("before_agent_start", async (e: any) => {
    if (e?.messageType === "user") feed({ type: "user", text: String(e?.prompt ?? "") });
    return undefined;
  });

  pi.on("session_start", async (_e: any, ctx: any) => {
    cwd = ctx.cwd ?? cwd;
    startLive(ctx);
    if (!ctx.hasUI || (ctx.mode && ctx.mode !== "tui")) return;
    uiCtx = ctx;
    refreshOpen();
    ctx.ui.setWidget("oxy-bar", barComponent, { placement: "belowEditor" });
    cleanup.push(ctx.ui.onTerminalInput(onInput));
    cleanup.push(reassertMouseWhenReady(() => tui));   // Windows: pi 의 마우스 켜기가 ConPTY 에서 버려지는 문제 (mouse.ts)
    // 작업 · 기록이 바뀌면 다시 그리고, 모니터 pane 이 열려 있는지는 2초마다 본다 (모니터가 스스로 닫힐 수 있다)
    for (const name of ["oxy.jobs", "oxy.flow"]) {
      const off = shared<{ onChange(fn: () => void): unknown }>(name)?.onChange(() => tui?.requestRender());
      if (typeof off === "function") cleanup.push(off as () => void);
    }
    const timer = setInterval(() => { if (refreshOpen() || items().some((i) => i.kind === "jobs")) tui?.requestRender(); }, 2000);
    timer.unref?.();
    cleanup.push(() => clearInterval(timer));
  });
  const cleanup: Array<() => void> = [];
  pi.on("session_shutdown", async (e: any) => {
    // 세션이 바뀌면 이 extension 은 새로 로드되므로 입력 가로채기 · 타이머를 정리한다
    for (const fn of cleanup.splice(0)) { try { fn(); } catch { /* 이미 정리됨 */ } }
    // 모니터 pane 은 pi 를 끝낼 때만 닫는다 (/new · 세션 넘기기는 같은 pi 라 그대로 둔다)
    if (e?.reason !== "quit") return;
    try { paneManager().mgr?.closeAll(); } catch { /* 이미 닫힘 */ }
  });
}
