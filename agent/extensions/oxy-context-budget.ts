/**
 * oxy-context-budget: 128K 컨텍스트를 소형 모델에 맞게 아껴 쓴다.
 *
 * - 도구 출력 상한: bash/grep/find/ls 출력이 길면 앞 60% + 뒤 40% 만 남긴다
 *   (pi 기본 상한 50KB/2000줄은 한 번에 약 12K 토큰이라 소형 모델에는 크다)
 *   read 는 pi 가 offset/limit 안내를 붙이므로 상한을 더 크게 두고, 꼬리를 보존해 그 안내가 남게 한다.
 * - 상태줄: 매 턴 컨텍스트 사용률 표시 (TUI)
 * - 압축 루프 경고: 짧은 간격으로 compaction 이 반복되면 사용자에게 새 세션을 권한다
 *   (자동 compaction 시점 자체는 settings.json 의 compaction.reserveTokens 로 조정)
 *
 * 환경변수: OXY_TOOL_OUTPUT_MAX_CHARS(기본 12000), OXY_READ_MAX_CHARS(기본 40000), 끄기 OXY_CONTEXT_BUDGET=off
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { enabled, envInt, textOf } from "./_lib/common.ts";

const SHELLISH = new Set(["bash", "grep", "find", "ls"]);

export function clip(text: string, max: number, hint: string): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n\n…[oxy: ${omitted} characters omitted from the middle. ${hint}]…\n\n${text.slice(-tail)}`;
}

export default function (pi: ExtensionAPI) {
  if (!enabled("CONTEXT_BUDGET")) return;
  const TOOL_MAX = envInt("OXY_TOOL_OUTPUT_MAX_CHARS", 12000);
  const READ_MAX = envInt("OXY_READ_MAX_CHARS", 40000);

  pi.on("tool_result", async (event) => {
    const isShell = SHELLISH.has(event.toolName);
    if (!isShell && event.toolName !== "read") return undefined;
    const text = textOf(event.content);
    const max = isShell ? TOOL_MAX : READ_MAX;
    if (text.length <= max) return undefined;
    const hint = isShell
      ? "Narrow the command (filters, head/tail, rg -l, fd with a pattern) instead of printing everything."
      : "Use read with offset/limit to view the part you need.";
    const others = Array.isArray(event.content) ? event.content.filter((c: any) => c?.type !== "text") : [];
    return { content: [{ type: "text", text: clip(text, max, hint) }, ...others] };
  });

  let turn = 0;
  let compactTurns: number[] = [];
  pi.on("session_start", () => { turn = 0; compactTurns = []; });

  pi.on("turn_end", async (_event, ctx) => {
    turn++;
    if (!ctx.hasUI) return undefined;
    const u = ctx.getContextUsage();
    if (u?.percent != null && u.tokens != null) {
      ctx.ui.setStatus("oxy-ctx", `ctx ${Math.round(u.percent)}% (${Math.round(u.tokens / 1000)}K/${Math.round(u.contextWindow / 1000)}K)`);
    }
    return undefined;
  });

  pi.on("session_compact", async (_event, ctx) => {
    compactTurns = [...compactTurns.filter((t) => turn - t <= 10), turn];
    if (compactTurns.length >= 3 && ctx.hasUI) {
      ctx.ui.notify(
        "[oxy] 최근 10턴 사이에 컨텍스트 압축이 3번 일어났습니다. 작업을 나눠 /new 로 새 세션에서 이어가는 것을 권장합니다.",
        "warning",
      );
    }
  });
}
