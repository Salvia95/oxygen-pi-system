/**
 * oxy-loop-guard: 소형 모델에서 자주 나오는 세 가지 실패를 바로잡는다.
 *
 * 1) 텍스트로 쓴 tool call: vLLM tool parser 가 인식하지 못해 `<tool_call>{...}` 같은 텍스트로만 남은 경우,
 *    실행되지 않았다는 사실을 알리고 정식 function calling 으로 다시 호출하게 한다.
 * 2) 빈 응답: 텍스트도 tool call 도 없이 끝난 경우 한 번 이어서 진행하게 한다.
 * 3) 반복 호출: 같은 도구·같은 인자를 연달아 반복하면 차단하고 접근을 바꾸게 한다.
 *
 * 각 보정은 사용자 프롬프트 1회(agent run)당 횟수 제한이 있어 무한 루프를 만들지 않는다.
 * - 끄기: OXY_LOOP_GUARD=off
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { blocked, enabled, envInt } from "./_lib/common.ts";

const TEXT_TOOL_CALL =
  /<tool_call>|<\/tool_call>|<function=\w+>|<\|tool_call|"(?:name|tool)"\s*:\s*"(?:bash|read|edit|write|grep|find|ls)"\s*,\s*"(?:arguments|parameters|input)"/i;

const MAX_TEXT_CALL_NUDGES = 2;
const MAX_EMPTY_NUDGES = 1;

function assistantParts(message: any): { text: string; toolCalls: number } {
  const blocks: any[] = Array.isArray(message?.content) ? message.content : [];
  let text = "";
  let toolCalls = 0;
  for (const b of blocks) {
    if (b?.type === "text" && typeof b.text === "string") text += b.text;
    else if (b?.type === "toolCall") toolCalls++;
  }
  if (typeof message?.content === "string") text += message.content;
  return { text, toolCalls };
}

export default function (pi: ExtensionAPI) {
  if (!enabled("LOOP_GUARD")) return;
  const REPEAT_LIMIT = envInt("OXY_REPEAT_LIMIT", 3); // 같은 호출이 이 횟수째면 차단

  let textCallNudges = 0;
  let emptyNudges = 0;
  let recent: string[] = [];

  pi.on("agent_start", () => {
    textCallNudges = 0;
    emptyNudges = 0;
    recent = [];
  });

  pi.on("tool_call", async (event) => {
    const key = `${event.toolName}:${JSON.stringify(event.input)}`;
    const window = recent.slice(-6);
    const repeats = window.filter((k) => k === key).length;
    recent.push(key);
    if (repeats + 1 >= REPEAT_LIMIT) {
      return {
        block: true,
        reason: blocked(
          "loop-guard",
          `You already made this exact ${event.toolName} call ${repeats} times in this task and it will return the same result. ` +
            "Do something different: change the arguments, use another tool, or explain the problem to the user.",
        ),
      };
    }
    return undefined;
  });

  // 파일이 바뀌면 같은 read/테스트 명령을 다시 실행하는 것은 정상이므로 반복 기록을 초기화
  pi.on("tool_result", async (event) => {
    if (!event.isError && (event.toolName === "edit" || event.toolName === "write")) recent = [];
    return undefined;
  });

  pi.on("turn_end", async (event) => {
    if (event.outcome !== "completed" || event.toolResults.length > 0) return undefined;
    if ((event.message as any)?.role !== "assistant") return undefined;
    const { text, toolCalls } = assistantParts(event.message);
    if (toolCalls > 0) return undefined;

    if (TEXT_TOOL_CALL.test(text) && textCallNudges < MAX_TEXT_CALL_NUDGES) {
      textCallNudges++;
      return {
        entries: [
          ...event.entries,
          {
            type: "custom_message",
            customType: "oxy-loop-guard",
            content:
              "[oxy-loop-guard] Your last reply contained a tool call written as plain text, so it was NOT executed. " +
              "Call the tool again using the function-calling interface. Do not write tool calls as XML or JSON text.",
            display: false,
          },
        ],
        continue: true,
      };
    }

    if (text.trim() === "" && emptyNudges < MAX_EMPTY_NUDGES) {
      emptyNudges++;
      return {
        entries: [
          ...event.entries,
          {
            type: "custom_message",
            customType: "oxy-loop-guard",
            content: "[oxy-loop-guard] Your last reply was empty. Continue the task, or give your final answer to the user.",
            display: false,
          },
        ],
        continue: true,
      };
    }
    return undefined;
  });
}
