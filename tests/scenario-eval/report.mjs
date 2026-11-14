// results.jsonl 을 시나리오 × 구성 표로 보여 준다.  node report.mjs [--model id] [--calls] [--suite combo]
// --suite habit: results-habit.jsonl 을 습관(bash grep · cat · curl 대 grep 도구 · read · 번들 도구) 수로. label 끝의 -r<n> 은 반복으로 묶는다
// --suite combo: results-combo.jsonl 을 skill 사용(읽음/실행) · 비용과 함께 (docs/skill-combo-spec.md §3)
// --gate <label 앞부분> [--baseline 파일] [--markdown 파일]: 그 label 들(반복)을 합쳐 CI 판정. 통과 0 · 실패 1. markdown 은 Job Summary 용 표
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gate } from "./gate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const model = args.includes("--model") ? args[args.indexOf("--model") + 1] : null;
const showCalls = args.includes("--calls");
const combo = args.includes("--suite") && args[args.indexOf("--suite") + 1] === "combo";
if (args.includes("--suite") && args[args.indexOf("--suite") + 1] === "habit") { await habitReport(); process.exit(0); }
const rows =fs.readFileSync(path.join(HERE, combo ? "results-combo.jsonl" : "results.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  .filter((r) => !model || r.model === model);

if (args.includes("--gate")) {
  const prefix = args[args.indexOf("--gate") + 1];
  const bf = args.includes("--baseline") ? args[args.indexOf("--baseline") + 1] : path.join(HERE, "baseline-combo.json");
  const baseline = fs.existsSync(bf) ? JSON.parse(fs.readFileSync(bf, "utf8")) : { accepted: [] };
  const mine = rows.filter((r) => r.label.startsWith(prefix));
  if (!mine.length) { console.error(`${prefix} 로 시작하는 기록이 없음`); process.exit(1); }
  const g = gate(mine, baseline);
  const cost = mine.reduce((a, r) => a + (r.cost ?? 0), 0);
  const md = [`### skill 상황 시험 (${prefix}, ${mine[0].model})`, "", "| 시나리오 | 합격 | 반복 | 기준선 | skill 실행 (반복별) |", "| --- | --- | --- | --- | --- |",
    ...g.scenarios.map((s) => `| ${s.id} | ${s.accepted ? "✓" : "×"} | ${s.passCount}/${s.runs} | ${s.inBaseline ? "합격" : "-"} | ${mine.filter((r) => r.scenario === s.id).map((r) => `${r.skillsUsed}/${r.skillsExpected}${r.pass ? "" : " (결과 FAIL)"}`).join(", ")} |`),
    "", `판정: **${g.ok ? "통과" : "실패"}**${g.regressed.length ? ` — 기준선보다 나빠짐: ${g.regressed.join(", ")}` : ""}${g.improved.length ? ` · 새로 합격: ${g.improved.join(", ")}` : ""} · 비용 ${cost.toFixed(4)}`];
  console.log(md.join("\n"));
  if (args.includes("--markdown")) fs.appendFileSync(args[args.indexOf("--markdown") + 1], md.join("\n") + "\n");
  process.exit(g.ok ? 0 : 1);
}
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

/**
 * habit suite 표: 시나리오 × 구성(label 에서 -r<n> 을 뗀 것)마다 반복을 합쳐, 결과 PASS 수와 도구 습관 수를 보인다.
 * trace 는 events 파일(%TEMP%/oxy-scenario-eval/<label>/events-<id>.jsonl)이 남아 있으면 거기서 다시 만든다 (기록의 trace 보다 우선).
 */
async function habitReport() {
  const os = await import("node:os");
  const { traceFromEvents } = await import("./trace.mjs");
  const rs = fs.readFileSync(path.join(HERE, "results-habit.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => !model || r.model === model);
  const ev = (r) => path.join(os.tmpdir(), "oxy-scenario-eval", r.label, `events-${r.scenario}.jsonl`);
  for (const r of rs) if (fs.existsSync(ev(r))) r.trace = traceFromEvents(fs.readFileSync(ev(r), "utf8"));
  const cnt = (r, re) => (r.trace ?? []).filter((t) => re.test(t)).length;
  const K = { "bash grep": /bash-grep/, "grep 도구": /^grep-tool$/, rg: /\brg\b/, cat: /bash-cat/, read: /^read$/, curl: /\bcurl\b/, hurl: /\bhurl\b/, usql: /\busql\b/,
    "브라우저": /agent-browser|obscura/, "skill 읽음": /^skill:/ };
  const group = (l) => l.replace(/-r\d+$/, "");
  const groups = [...new Set(rs.map((r) => `${group(r.label)} @${r.model}`))];
  console.log(`| 시나리오 | 구성 | 반복 | PASS | ${Object.keys(K).join(" | ")} | 안내 | 비용 |`);
  console.log(`|---|---|---|---|${Object.keys(K).map(() => "---|").join("")}---|---|`);
  for (const s of [...new Set(rs.map((r) => r.scenario))]) {
    for (const g of groups) {
      const xs = rs.filter((r) => r.scenario === s && `${group(r.label)} @${r.model}` === g);
      if (!xs.length) continue;
      const sum = (re) => xs.map((r) => cnt(r, re)).join("/");
      const skills = [...new Set(xs.flatMap((r) => (r.trace ?? []).filter((t) => t.startsWith("skill:")).map((t) => t.slice(6))))];
      console.log(`| ${s} | ${g.split(" @")[0]} | ${xs.length} | ${xs.filter((r) => r.pass).length} | ${Object.entries(K).map(([k, re]) => k === "skill 읽음" ? `${sum(re)}${skills.length ? ` (${skills.join(",")})` : ""}` : sum(re)).join(" | ")} | ${xs.map((r) => r.hints ?? 0).join("/")} | ${xs.reduce((a, r) => a + (r.cost ?? 0), 0).toFixed(4)} |`);
      if (showCalls) for (const r of xs) console.log(`|  | ${r.label} |  |  | ${(r.trace ?? []).join(" ")} |`);
    }
  }
  console.log(`\n비용 합계 ${rs.reduce((a, r) => a + (r.cost ?? 0), 0).toFixed(4)} (pi 가 계산한 값, 기록 ${rs.length}건)`);
}
