// node apply-desc.mjs <skill-library 폴더> [후보 파일] : 후보 파일(기본 candidates.json, SKILL_EVAL_CANDIDATES)의 description 으로 SKILL.md frontmatter 를 바꾼다
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const lib = process.argv[2];
const C = JSON.parse(readFileSync(process.argv[3] ?? process.env.SKILL_EVAL_CANDIDATES ?? join(dirname(fileURLToPath(import.meta.url)), "candidates.json"), "utf8"));
for (const [name, d] of Object.entries(C)) {
  const f = join(lib, name, "SKILL.md");
  if (!existsSync(f)) continue; // 켜지지 않은 skill
  const s = readFileSync(f, "utf8");
  const next = s.replace(/^description: .*$/m, `description: ${d}`);
  if (next === s) throw new Error(`description 없음: ${f}`);
  writeFileSync(f, next);
}
console.log(`applied ${Object.keys(C).length}`);
