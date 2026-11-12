/**
 * oxy-monitor: psmux 오른쪽 열에 모니터 pane 을 열고 닫는다 (docs/monitor-spec.md §1).
 *   /monitor jobs · /monitor flow   켜고 끄기 (하단 바의 Enter · 클릭도 같은 동작, §2)
 *   pi 를 끝내면(quit) 이 pi 가 연 모니터 pane 을 닫는다. 모니터는 pi pid 가 사라지면 스스로도 끝난다
 * psmux 안($TMUX · $TMUX_PANE)에서만 pane 을 연다. 끄기: OXY_MONITOR=off
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { enabled, harnessHome } from "../_lib/common.ts";
import { PaneManager, monitorCommand, psmuxRunner } from "./pane.ts";

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

export default function (pi: ExtensionAPI) {
  if (!enabled("MONITOR")) return;
  const agentDir = process.env.PI_CODING_AGENT_DIR || getAgentDir();
  const script = join(agentDir, "extensions", "oxy-monitor", "monitor.ts");
  const dirs = { agent: agentDir, root: harnessHome(join(agentDir, "..")) ?? join(agentDir, "..") };
  let cwd = process.cwd();

  const toggle = (kind: MonitorKind): { ok: boolean; message: string } => {
    const { mgr, why } = paneManager();
    if (!mgr) return { ok: false, message: why! };
    try {
      const r = mgr.toggle(kind, monitorCommand(process.execPath, script, kind, process.pid, cwd, dirs), cwd);
      return { ok: true, message: r === "opened" ? `${kind} 모니터를 열었습니다.` : `${kind} 모니터를 닫았습니다.` };
    } catch (e: any) {
      return { ok: false, message: String(e?.message ?? e) };
    }
  };
  // 하단 바(5단계)가 같은 동작을 쓴다
  (globalThis as any)[Symbol.for("oxy.monitor")] = { toggle, kinds: MONITOR_KINDS };

  pi.registerCommand("monitor", {
    description: "모니터 pane 켜고 끄기: /monitor jobs · /monitor flow (psmux 안에서)",
    handler: async (args: string, ctx: any) => {
      cwd = ctx.cwd ?? cwd;
      const kind = args.trim() as MonitorKind;
      if (!MONITOR_KINDS.includes(kind)) { ctx.ui.notify(`사용법: /monitor ${MONITOR_KINDS.join(" · /monitor ")}`, "info"); return; }
      const r = toggle(kind);
      ctx.ui.notify(r.message, r.ok ? "info" : "warning");
    },
  });

  pi.on("session_start", async (_e: any, ctx: any) => { cwd = ctx.cwd ?? cwd; });
  // pi 를 끝낼 때만 닫는다 (/new · 세션 넘기기는 같은 pi 라 모니터를 그대로 둔다)
  pi.on("session_shutdown", async (e: any) => {
    if (e?.reason !== "quit") return;
    try { paneManager().mgr?.closeAll(); } catch { /* 이미 닫힘 */ }
  });
}
