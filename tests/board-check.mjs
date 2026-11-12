// 진행판(docs/dev-board.md) 검사. 형식과 증거만 본다. 증거가 충분한지는 사람이 본다.
//   ./runtime/node/node.exe tests/board-check.mjs [저장소 루트] [진행판 경로]     FAIL 이 있으면 종료코드 1
// 규칙: docs/dev-process.md §2 · §3
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const root = process.argv[2] ?? process.cwd();
const boardPath = process.argv[3] ?? join(root, "docs", "dev-board.md");
const SPEC_STATES = ["초안", "승인", "구현", "검증", "완료", "보류"];
const STEP_STATES = ["예정", "구현", "검증", "완료"];
const AFTER_APPROVAL = ["승인", "구현", "검증", "완료"];
let F = 0, W = 0;
const fail = (m) => { console.log(`  FAIL ${m}`); F++; };
const warn = (m) => { console.log(`  WARN ${m}`); W++; };

const text = readFileSync(boardPath, "utf8");
if (text.includes("\r")) fail("진행판이 CRLF 다");

function table(heading) {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (at < 0) { fail(`'## ${heading}' 절이 없다`); return []; }
  const rows = [];
  for (let i = at + 1; i < lines.length && !lines[i].startsWith("## "); i++) {
    const l = lines[i].trim();
    if (!l.startsWith("|")) continue;
    rows.push(l.slice(1, -1).split("|").map((c) => c.trim()));
  }
  const [head, , ...body] = rows;
  return (body ?? []).map((cells) => Object.fromEntries((head ?? []).map((h, k) => [h, cells[k] ?? ""])));
}
const id = (s) => s.replace(/`/g, "").trim();
const empty = (s) => !s || /^[–-]$/.test(s.trim());

const hashCache = new Map();
function commitExists(h) {
  if (!hashCache.has(h)) {
    try { execFileSync("git", ["-C", root, "cat-file", "-e", `${h}^{commit}`], { stdio: "ignore" }); hashCache.set(h, true); }
    catch { hashCache.set(h, false); }
  }
  return hashCache.get(h);
}
const hashes = (s) => (s.match(/\b[0-9a-f]{7,40}\b/g) ?? []).filter((h) => /[a-f]/.test(h) && /[0-9]/.test(h));
const paths = (s) => [...s.matchAll(/`((?:docs|tests|scripts|agent|installer|\.claude)\/[^`\s]+?\.(?:md|mjs|ts|sh|json))`/g)].map((m) => m[1]);
// 참조를 확인하고, 확인된 참조가 하나라도 있으면 true
function refs(where, s) {
  let ok = false;
  for (const h of hashes(s)) commitExists(h) ? (ok = true) : fail(`${where}: 없는 커밋 ${h}`);
  for (const p of paths(s)) existsSync(join(root, p)) ? (ok = true) : fail(`${where}: 없는 파일 ${p}`);
  return ok;
}

const specs = table("명세");
const steps = table("단계");
const specIds = new Set();
for (const r of specs) {
  const sid = id(r["ID"] ?? "");
  if (!sid) { fail("명세 표에 ID 가 빈 행"); continue; }
  if (specIds.has(sid)) fail(`명세 ID 중복: ${sid}`);
  specIds.add(sid);
  if (!SPEC_STATES.includes(r["상태"])) fail(`${sid}: 명세 상태 '${r["상태"]}' 는 정해진 이름이 아니다 (${SPEC_STATES.join(" ")})`);
  refs(`${sid} 명세`, r["명세"] ?? "");
  refs(`${sid} 커밋`, r["커밋"] ?? "");
  if (AFTER_APPROVAL.includes(r["상태"]) && !/\d{4}-\d{2}-\d{2}/.test(r["승인"] ?? "")) warn(`${sid}: 상태가 ${r["상태"]} 인데 승인 날짜 기록이 없다`);
}
const stepIds = new Set();
for (const r of steps) {
  const st = id(r["단계"] ?? "");
  if (stepIds.has(st)) fail(`단계 ID 중복: ${st}`);
  stepIds.add(st);
  const sid = st.split("/")[0];
  if (!specIds.has(sid)) fail(`${st}: 명세 표에 '${sid}' 가 없다`);
  if (!STEP_STATES.includes(r["상태"])) fail(`${st}: 단계 상태 '${r["상태"]}' 는 정해진 이름이 아니다 (${STEP_STATES.join(" ")})`);
  const hasRef = refs(st, r["증거"] ?? "");
  if (["검증", "완료"].includes(r["상태"]) && empty(r["자동 검증"])) fail(`${st}: ${r["상태"]} 인데 자동 검증 기록이 없다 (없으면 '해당 없음')`);
  if (r["상태"] === "완료") {
    if (empty(r["실측"])) fail(`${st}: 완료인데 실측 기록이 없다`);
    if (!hasRef) fail(`${st}: 완료인데 확인할 수 있는 증거(커밋 · 문서 경로)가 없다`);
  }
}
for (const r of specs) {
  const sid = id(r["ID"] ?? "");
  const mine = steps.filter((s) => id(s["단계"]).split("/")[0] === sid);
  if (r["상태"] === "완료" && mine.some((s) => s["상태"] !== "완료")) fail(`${sid}: 명세가 완료인데 완료가 아닌 단계가 있다`);
  if (r["상태"] === "초안" && mine.some((s) => ["구현", "검증"].includes(s["상태"]))) warn(`${sid}: 명세가 초안인데 구현 · 검증 중인 단계가 있다 (사후 명세이거나 승인 전 구현)`);
}
// 진행판에 없는 명세 파일
const listed = specs.map((r) => r["명세"] ?? "").join(" ");
for (const f of readdirSync(join(root, "docs")).filter((f) => f.endsWith("-spec.md")))
  if (!listed.includes(`docs/${f}`)) fail(`docs/${f} 가 진행판 명세 표에 없다`);

console.log(F ? `진행판 검사 실패 ${F} 건 (WARN ${W})` : `진행판 검사 통과 (WARN ${W})`);
process.exit(F ? 1 : 0);
