// skill 본문이 쓰는 하위 명령 · 옵션 목록 (docs/upgrade-check-spec.md §3 C3). 손으로 적지 않고 agent/skill-library/*/*.md 에서 읽는다.
//   node tests/upgrade-check/tool-usage.mjs [skill-library 폴더]  →  "도구<TAB>하위 명령<TAB>옵션 …" 줄
// 새 버전의 `<도구> <하위 명령> --help` 에 그 옵션이 있는지는 tools.sh 가 본다.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 도구마다: 하위 명령을 몇 단어까지 읽는가 (0 = 하위 명령 없음), 앞에 오는 전역 옵션(값 하나를 받는 것) */
export const TOOLS = {
  gh: { depth: 2 }, glab: { depth: 3 },
  "agent-browser": { depth: 1, globals: ["--session"] }, obscura: { depth: 1 }, "ast-grep": { depth: 1 },
  hurl: { depth: 0 }, usql: { depth: 0 }, rg: { depth: 0 }, fd: { depth: 0 }, jq: { depth: 0 }, just: { depth: 0 },
};

/** 따옴표 안 · 주석 · 파이프 뒤를 지운 낱말들 */
export function words(line) {
  return line.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, " Q ").replace(/\s#.*$/, "").split(/\s+\|\s*|\s+\d?>&?\d?\s*/)[0].trim().split(/\s+/);
}

/** 명령 줄 하나 → { tool, sub, flags } (도구 줄이 아니면 null) */
export function parseLine(line) {
  const w = words(line.trim().replace(/^\$\s+/, ""));
  const spec = TOOLS[w[0]];
  if (!spec) return null;
  let i = 1;
  const flags = [];
  for (const g of spec.globals ?? []) if (w[i] === g) { flags.push(g); i += 2; }
  const sub = [];
  while (sub.length < spec.depth && /^[a-z][a-z-]*$/.test(w[i] ?? "")) sub.push(w[i++]);
  for (; i < w.length; i++) {
    const m = w[i].match(/^(--[a-z][a-z0-9-]*)(=.*)?$|^(-[A-Za-z])$/);
    if (m) flags.push(m[1] ?? m[3]);
  }
  return { tool: w[0], sub: sub.join(" "), flags };
}

/** skill 문서들 → Map("도구\t하위 명령" → Set(옵션)). 코드 블록(```) 안의 줄만 본다 */
export function collectUsage(texts) {
  const out = new Map();
  for (const text of texts) {
    let code = false;
    for (const line of text.split(/\r?\n/)) {
      if (/^\s*```/.test(line)) { code = !code; continue; }
      if (!code) continue;
      const p = parseLine(line);
      if (!p) continue;
      const k = `${p.tool}\t${p.sub}`;
      const s = out.get(k) ?? new Set();
      p.flags.forEach((f) => s.add(f));
      out.set(k, s);
    }
  }
  return out;
}

function mdFiles(dir) {
  return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? mdFiles(p) : n.endsWith(".md") ? [p] : []; });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const lib = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..", "agent", "skill-library");
  for (const [k, flags] of collectUsage(mdFiles(lib).map((f) => readFileSync(f, "utf8")))) console.log(`${k}\t${[...flags].join(" ")}`);
}
