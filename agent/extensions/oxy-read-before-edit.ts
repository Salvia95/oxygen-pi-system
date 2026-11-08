/**
 * oxy-read-before-edit: 소형 모델이 기억에 의존해 파일을 고치지 않도록 한다.
 *
 * - edit: 이 세션에서 read 한 적 없는 파일, 또는 read 이후 디스크에서 바뀐 파일은 차단
 * - write: 이미 존재하는 파일은 read 후에만 허용 (부분 수정은 edit 권장). 새 파일 생성은 자유
 * - compaction 이 일어나면 기록을 비운다 (요약 후에는 파일 내용이 컨텍스트에 없으므로)
 * - 끄기: OXY_READ_BEFORE_EDIT=off
 */
import { statSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { blocked, enabled, pathKey } from "./_lib/common.ts";

/** 파일 리비전: 크기 + mtime (bash 의 sed -i 등 외부 수정도 감지) */
function revision(absPath: string): string | undefined {
  try {
    const s = statSync(absPath, { bigint: true });
    return s.isFile() ? `${s.size}:${s.mtimeNs}` : undefined;
  } catch {
    return undefined;
  }
}

export default function (pi: ExtensionAPI) {
  if (!enabled("READ_BEFORE_EDIT")) return;
  /** pathKey → 마지막으로 모델이 본(read 또는 자신이 쓴) 리비전 */
  const seen = new Map<string, string>();
  const reset = () => seen.clear();
  pi.on("session_start", reset);
  pi.on("session_compact", reset);

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return undefined;
    const rawPath = String((event.input as { path?: unknown }).path ?? "");
    if (!rawPath) return undefined;
    const key = pathKey(rawPath, ctx.cwd);
    const current = revision(key);
    if (current === undefined) return undefined; // 새 파일이거나 없는 파일: 도구가 알아서 처리

    const last = seen.get(key);
    if (last === undefined) {
      const msg = event.toolName === "edit"
        ? `You have not read "${rawPath}" in this session. Call read on it first, then edit using text copied exactly from the read output.`
        : `"${rawPath}" already exists and you have not read it. Read it first, then use edit for targeted changes. Use write on an existing file only to replace it entirely, after reading it.`;
      return { block: true, reason: blocked("read-before-edit", msg) };
    }
    if (last !== current) {
      return {
        block: true,
        reason: blocked("read-before-edit", `"${rawPath}" changed on disk since you last read it. Read it again before modifying it.`),
      };
    }
    return undefined;
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) return undefined;
    if (event.toolName !== "read" && event.toolName !== "edit" && event.toolName !== "write") return undefined;
    const rawPath = String((event.input as { path?: unknown })?.path ?? "");
    if (!rawPath) return undefined;
    const key = pathKey(rawPath, ctx.cwd);
    const rev = revision(key);
    if (rev !== undefined) seen.set(key, rev);
    return undefined;
  });
}
