/**
 * oxy-tool-hints: bash 로 하던 일을 맞는 도구 · 스킬로 하도록 결과에 짧은 안내를 붙인다 (막지 않는다, 세션마다 종류별 한 번).
 * 사용자 (2026-11-14): Haiku 세션 9개 · bash 270개를 보니 스킬은 한 번도 읽지 않았고, 파일 검색은 bash grep 102번(grep 도구 1번 · rg 0번),
 * 파일 읽기는 cat 80번, HTTP 확인은 curl 68번(hurl 0번)이었다 → "다 진행해줘".
 *   grep <패턴> <파일 · 폴더>  → grep 도구(또는 rg)
 *   cat <소스 · 설정 파일>      → read 도구
 *   curl http://…              → http-api-testing 스킬의 hurl (스킬과 hurl 이 있을 때만)
 * 파이프 안의 grep(curl … | grep -o x)처럼 파일을 읽지 않는 것은 그대로 둔다.
 * 끄기: OXY_TOOL_HINTS=off
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { enabled, harnessHome } from "./_lib/common.ts";
import { splitSegments } from "./oxy-bash-guard.ts";

export type HintKind = "grep" | "cat" | "curl";

export const HINTS: Record<HintKind, string> = {
  grep: "[oxy-hint] To search files, use the grep tool (or `rg` in bash) instead of grep in bash: it skips ignored folders and prints file:line. Keep bash grep for filtering another command's output.",
  cat: "[oxy-hint] To read a file, use the read tool instead of cat: it numbers lines and takes offset/limit for large files.",
  curl: "[oxy-hint] To check an HTTP endpoint, read the http-api-testing skill and use `hurl`: it handles cookies and CSRF forms and keeps the check as a re-runnable .hurl file.",
};

const SOURCE_EXT = /\.(java|kt|kts|xml|ya?ml|properties|html?|sql|md|json|jsonc|toml|ts|tsx|js|mjs|cjs|py|go|rs|gradle|sh|css|scss|vue|txt|conf|ini|env)$/i;
const tokens = (s: string) => (s.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((t) => t.replace(/^["']|["']$/g, ""));
/** grep 의 옵션 가운데 값을 받는 것 */
const GREP_ARG_OPTS = new Set(["-e", "-f", "-A", "-B", "-C", "-m", "--include", "--exclude", "--exclude-dir", "--color", "--regexp", "--file", "--max-count"]);

/** bash 명령에서 안내할 것 (없으면 빈 배열) */
export function detectHints(command: string): HintKind[] {
  const out = new Set<HintKind>();
  for (const seg of splitSegments(command)) {
    const t = tokens(seg);
    const cmd = (t[0] ?? "").split(/[\\/]/).pop()!.replace(/\.exe$/i, "");
    if (cmd === "grep" || cmd === "egrep") {
      // 옵션 · 값을 건너뛰고 패턴(‑e 가 없으면 첫 낱말) 뒤에 파일 · 폴더가 있으면 파일 검색
      let pattern = t.some((x) => x === "-e" || x.startsWith("--regexp"));
      const rest: string[] = [];
      for (let i = 1; i < t.length; i++) {
        const x = t[i];
        if (x === ">" || x === ">>" || x.startsWith("2>") || x.startsWith(">")) break;
        if (x.startsWith("-")) { if (GREP_ARG_OPTS.has(x)) i++; continue; }
        if (!pattern) { pattern = true; continue; }
        rest.push(x);
      }
      if (rest.some((x) => x !== "-" && x !== "/dev/null")) out.add("grep");
    } else if (cmd === "cat") {
      if (/<<|>/.test(seg)) continue;   // heredoc · 파일 쓰기
      if (t.slice(1).some((x) => !x.startsWith("-") && SOURCE_EXT.test(x))) out.add("cat");
    } else if (cmd === "curl") {
      if (t.some((x) => /^https?:\/\//i.test(x) || /^\$\{?\w+\}?\//.test(x))) out.add("curl");
    }
  }
  return [...out];
}

export default function (pi: ExtensionAPI) {
  if (!enabled("TOOL_HINTS")) return;
  const home = harnessHome();
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? (home ? join(home, "agent") : "");
  // curl 안내는 스킬과 hurl 이 있을 때만 (반입하지 않은 도구를 권하지 않는다)
  const curlOk = () => Boolean(agentDir && existsSync(join(agentDir, "skills", "http-api-testing", "SKILL.md")) && home && existsSync(join(home, "bin", "hurl.exe")));
  let given = new Set<HintKind>();
  pi.on("session_start", async () => { given = new Set(); });
  pi.on("tool_result", async (event: any) => {
    if (event.toolName !== "bash") return undefined;
    const kinds = detectHints(String(event.input?.command ?? "")).filter((k) => !given.has(k) && (k !== "curl" || curlOk()));
    if (!kinds.length) return undefined;
    for (const k of kinds) given.add(k);
    const content = Array.isArray(event.content) ? event.content : [{ type: "text", text: String(event.content ?? "") }];
    return { content: [...content, { type: "text", text: kinds.map((k) => HINTS[k]).join("\n") }] };
  });
}
