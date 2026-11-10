/**
 * oxy-prompt-trim: 매 요청에 실리는 고정 시스템 프롬프트를 줄인다.
 *
 * - pi 의 <docs> 섹션(약 1,400자: 문서 위치 3줄 + 주제별 파일 안내 + "전부 읽어라")을 한 문단으로 바꾼다.
 *   pi 문서는 pi 자체(extension, skill, 설정 …)를 물을 때만 쓰이는데 안내문은 모든 요청에 실린다.
 *   pi 는 내용이 빈 섹션을 건너뛰지만 이 섹션은 기본값이 있어 "삭제" 는 안 되므로 짧은 안내로 덮어쓴다.
 *   문서 경로는 pi 가 만든 프롬프트에서 읽어 온다 (설치 위치를 따로 추측하지 않는다).
 *
 * 끄기 OXY_PROMPT_TRIM=off
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { enabled } from "./_lib/common.ts";

/** pi 기본 프롬프트에서 문서 폴더를 찾아 짧은 안내문을 만든다. 찾지 못하면 undefined (원문 유지). */
export function docsPointer(systemPrompt: string): string | undefined {
  const dir = systemPrompt.match(/^- Additional docs: (.+)$/m)?.[1]?.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!dir) return undefined;
  const examples = systemPrompt.match(/^- Examples: (\S+)/m)?.[1]?.replace(/\\/g, "/").replace(/\/+$/, "");
  return (
    `Pi harness docs — read only when the user asks about pi itself: ${dir}/<topic>.md ` +
    `(extensions, skills, prompt-templates, themes, tui, keybindings, settings, sdk, custom-provider, models, packages, environment-variables, mcp, codemode)` +
    (examples ? `; examples: ${examples}` : "") +
    `. Read only the topic you need; large files in parts.`
  );
}

export default function (pi: ExtensionAPI) {
  if (!enabled("PROMPT_TRIM")) return;
  pi.on("before_agent_start", async (event: any) => {
    const options = event.systemPromptOptions;
    // 사용자가 시스템 프롬프트를 통째로 바꾼 경우(customPrompt)에는 docs 섹션이 없다
    if (!options || options.customPrompt) return undefined;
    const pointer = docsPointer(String(event.systemPrompt ?? ""));
    if (pointer) (options.sections ??= {}).docs = pointer;
    return undefined;
  });
}
