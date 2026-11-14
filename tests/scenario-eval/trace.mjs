// 도구 호출 꼬리표 (run.mjs 가 기록에 trace 로 남기고, report.mjs --suite habit 이 events 파일에서 다시 만든다)
// 2026-11-14: 처음에는 run.mjs 끝에 const 로 두어, 맨 위 실행 루프에서 TDZ 오류로 bash 꼬리표가 빠졌다 (hb-on-r1 기록의 trace). 그래서 따로 둔다
import { detectHints } from "../../agent/extensions/oxy-tool-hints.ts";

const TOOL_HEADS = new Set(["rg", "fd", "hurl", "usql", "jq", "ast-grep", "sg", "just", "obscura", "agent-browser", "psmux", "gh", "glab", "sqlite3", "node", "java", "mvn", "sed", "awk", "head", "tail", "find", "ls"]);

/**
 * 도구 호출 하나의 꼬리표 (습관 판정용): read 도구 = "read" · skill 을 읽으면 "skill:<이름>", grep 도구 = "grep-tool",
 * bash = "bash(…)" 안에 습관(oxy-tool-hints 와 같은 판정: bash-grep 파일 검색 · bash-cat 소스 읽기 · curl HTTP)과 아는 명령 머리 낱말(rg, hurl, usql …).
 */
export function tagCall(name, args) {
  if (name === "read") {
    const sk = String(args?.path ?? args?.file_path ?? "").match(/skills[\\/]([\w-]+)[\\/]SKILL\.md$/i);
    return sk ? `skill:${sk[1]}` : "read";
  }
  if (name === "grep") return "grep-tool";
  if (name !== "bash") return name;
  const cmd = String(args?.command ?? "");
  const tags = new Set(detectHints(cmd).map((k) => (k === "curl" ? "curl" : `bash-${k}`)));
  for (const seg of cmd.split(/&&|\|\||[;|\n]|\$\(|`/)) {
    const words = seg.trim().split(/\s+/).filter((w) => !/^[A-Z_][A-Z0-9_]*=/.test(w));
    const w = (words[0] ?? "").replace(/^.*[\\/]/, "").replace(/\.exe$/i, "");
    if (TOOL_HEADS.has(w)) tags.add(w);
  }
  return tags.size ? `bash(${[...tags].join("+")})` : "bash";
}

/** events-<시나리오>.jsonl (pi --mode json) 에서 trace 를 다시 만든다 */
export function traceFromEvents(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.includes("tool_execution_start")) continue;
    try { const e = JSON.parse(line); if (e.type === "tool_execution_start") out.push(tagCall(e.toolName, e.args)); } catch { /* 깨진 줄 */ }
  }
  return out;
}
