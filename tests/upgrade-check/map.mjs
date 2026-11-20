// 구성요소 업데이트 검증 영향 표 (tests/upgrade-check/map.tsv) 읽기. docs/upgrade-check-spec.md §2
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** 자동 검사 이름 (map.tsv 둘째 열). 순서가 실행 순서다 (가벼운 것 → 무거운 것) */
export const CHECKS = ["hygiene", "unit", "contract", "typecheck", "tools", "rust", "e2e", "installer"];

/** map.tsv → [{ name, checks: string[], manual: string[] }] */
export function readMap(root) {
  return readFileSync(join(root, "tests", "upgrade-check", "map.tsv"), "utf8").split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const [name, checks = "", manual = "-"] = l.split("\t");
      return { name, checks: checks.split(/\s+/).filter(Boolean), manual: manual.trim() === "-" ? [] : manual.split(" ; ").map((s) => s.trim()) };
    });
}

/** 바뀐 구성요소들 → 돌릴 자동 검사(CHECKS 순서) · 남는 실측. hygiene · unit 은 늘 넣는다 */
export function plan(map, names) {
  const rows = map.filter((r) => names.includes(r.name));
  const want = new Set(["hygiene", "unit", ...rows.flatMap((r) => r.checks)]);
  return {
    checks: CHECKS.filter((c) => want.has(c)),
    tools: rows.filter((r) => r.checks.includes("tools")).map((r) => r.name),
    manual: rows.flatMap((r) => r.manual.map((m) => `${r.name}: ${m}`)),
  };
}

/** lock 과 영향 표가 어긋난 곳 (빈 배열이면 맞음) */
export function mapProblems(lock, map) {
  const out = [];
  const inMap = new Set(map.map((r) => r.name));
  const inLock = new Set(lock.map((r) => r.name));
  for (const r of lock) if (!inMap.has(r.name)) out.push(`영향 표에 없음: ${r.name}`);
  for (const r of map) if (!inLock.has(r.name)) out.push(`lock 에 없음: ${r.name}`);
  for (const r of map) {
    if (!r.checks.length) out.push(`자동 검사 없음: ${r.name}`);
    for (const c of r.checks) if (!CHECKS.includes(c)) out.push(`모르는 검사: ${r.name} ${c}`);
  }
  const seen = new Set();
  for (const r of map) { if (seen.has(r.name)) out.push(`중복: ${r.name}`); seen.add(r.name); }
  return out;
}
