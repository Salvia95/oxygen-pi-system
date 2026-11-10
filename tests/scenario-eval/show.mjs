// 한 실행의 도구 호출과 결과 앞부분을 보여 준다.  node show.mjs <label> <scenario> [chars]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [label, scenario, n = "600"] = process.argv.slice(2);
const file = path.join(os.tmpdir(), "oxy-scenario-eval", label, `events-${scenario}.jsonl`);
const textOf = (c) => typeof c === "string" ? c : (c ?? []).filter((x) => x?.type === "text").map((x) => x.text).join("");
for (const line of fs.readFileSync(file, "utf8").split("\n")) {
  if (!line.trim()) continue;
  let e; try { e = JSON.parse(line); } catch { continue; }
  if (e.type === "tool_execution_start") console.log(`\n▶ ${e.toolName} ${JSON.stringify(e.args)}`);
  else if (e.type === "tool_execution_end") console.log(`${e.isError ? "✗" : "◀"} ${textOf(e.result?.content).slice(0, Number(n))}`);
  else if (e.type === "message_end" && e.message?.role === "assistant") {
    const t = textOf(e.message.content).trim();
    if (t) console.log(`\n💬 ${t.slice(0, Number(n))}`);
    if (e.message.errorMessage) console.log(`⚠ ${String(e.message.errorMessage).replace(/org_[A-Za-z0-9]+/g, "org_***").slice(0, 300)}`);
  }
}
