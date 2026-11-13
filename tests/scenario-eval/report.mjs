// results.jsonl 을 시나리오 × 구성 표로 보여 준다.  node report.mjs [--model id] [--calls] [--suite combo]
// --suite combo: results-combo.jsonl 을 skill 사용(읽음/실행) · 비용과 함께 (docs/skill-combo-spec.md §3)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const model = args.includes("--model") ? args[args.indexOf("--model") + 1] : null;
const showCalls = args.includes("--calls");
const combo = args.includes("--suite") && args[args.indexOf("--suite") + 1] === "combo";
const rows = fs.readFileSync(path.join(HERE, combo ? "results-combo.jsonl" : "results.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  .filter((r) => !model || r.model === model);

const labels = [...new Set(rows.map((r) => `${r.label} @${r.model}`))];
const scenarios = [...new Set(rows.map((r) => r.scenario))];
for (const s of scenarios) {
  console.log(`\n${s}`);
  for (const l of labels) {
    const r = rows.find((x) => x.scenario === s && `${x.label} @${x.model}` === l);
    if (!r) continue;
    if (combo) {
      const ok = r.pass && (r.skillsUsed ?? 0) >= 2;
      const sk = (r.skills ?? []).map((u) => `${u.skill}:${u.read ? "읽음" : "-"}/${u.ran ? "실행" : "-"}`).join(" ");
      console.log(`  ${l.padEnd(34)} ${ok ? "합격" : "불합격"} 결과 ${r.pass ? "PASS" : "FAIL"} skill ${r.skillsUsed}/${r.skillsExpected} [${sk}] 요청 ${r.requests} 비용 ${r.cost ?? "?"} ${r.seconds}s — ${r.note}`);
      if (showCalls) for (const c of r.calls) console.log(`      ${c.name} ${c.args} → ${c.out}자${c.err ? " (오류)" : ""}`);
      continue;
    }
    console.log(`  ${l.padEnd(34)} ${r.pass ? "PASS" : "FAIL"} 요청 ${r.requests} 입력 ${String(r.inTok).padStart(6)} 도구출력 ${String(r.toolOut).padStart(5)}자(원본 ${r.toolRaw}) ${String(r.seconds).padStart(3)}s  ${r.calls.map((c) => c.name + (c.err ? "!" : "")).join(",") || "-"}  — ${r.note}`);
    if (showCalls) for (const c of r.calls) console.log(`      ${c.name} ${c.args} → ${c.out}자${c.err ? " (오류)" : ""}`);
  }
}
console.log("\n합계");
for (const l of labels) {
  const rs = rows.filter((x) => `${x.label} @${x.model}` === l);
  const sum = (k) => rs.reduce((a, r) => a + r[k], 0);
  if (combo) {
    console.log(`  ${l.padEnd(34)} 합격 ${rs.filter((r) => r.pass && (r.skillsUsed ?? 0) >= 2).length}/${rs.length}  결과 PASS ${rs.filter((r) => r.pass).length}  skill 실행 ${sum("skillsUsed")}/${sum("skillsExpected")}  요청 ${sum("requests")}  비용 ${sum("cost").toFixed(4)}  ${sum("seconds")}s`);
    continue;
  }
  console.log(`  ${l.padEnd(34)} ${rs.filter((r) => r.pass).length}/${rs.length} 통과  요청 ${sum("requests")}  입력 ${sum("inTok")}  출력 ${sum("outTok")}  도구출력 ${sum("toolOut")}자  첫요청 ${Math.round(sum("firstIn") / rs.length)}`);
}
