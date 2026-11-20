// pi 계약 검사 (docs/upgrade-check-spec.md §3 C1): extension 이 기대는 pi 의 이름 · 이벤트 · 필드 · 프롬프트 문구가 번들 pi 에 그대로 있는지 본다.
//   node --experimental-strip-types --no-warnings tests/upgrade-check/pi-contract.mjs [extension 폴더] [pi node_modules 폴더]
// 기대는 것의 목록은 extension 소스에서 읽는다 (손으로 적지 않는다). 필드 · 메서드는 pi 의 .d.ts 어딘가에 선언돼 있는지만 본다 (느슨한 검사: 이름이 없어지거나 바뀐 것을 잡는다).
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..");

function walk(dir, ext) {
  const out = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) { if (n !== "node_modules") out.push(...walk(p, ext)); }
    else if (ext.some((e) => n.endsWith(e))) out.push(p);
  }
  return out;
}

const PI_MODULE = /^(@earendil-works\/[^/"']+|typebox)$/;

/** 소스들 → { 모듈: Set(값 이름) }. `import type {…}` 와 `type X` 는 빼고, `a as b` 는 a */
export function collectImports(sources) {
  const out = {};
  for (const src of sources) {
    for (const m of src.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
      if (m[1] || !PI_MODULE.test(m[3])) continue;
      for (let name of m[2].split(",")) {
        name = name.trim();
        if (!name || name.startsWith("type ")) continue;
        (out[m[3]] ??= new Set()).add(name.split(/\s+as\s+/)[0].trim());
      }
    }
  }
  return out;
}

/** 소스들 → [{ event, fields: Set }]. 처리 함수의 첫 인자 이름으로 그 처리 함수 안(다음 pi.on 앞까지)의 `인자.필드` 를 모은다 */
export function collectEvents(sources) {
  const byEvent = new Map();
  for (const src of sources) {
    const hits = [...src.matchAll(/pi\.on\(\s*["']([a-z_]+)["']\s*,\s*(?:async\s*)?\(?\s*([A-Za-z_$][\w$]*)?/g)];
    hits.forEach((h, i) => {
      const fields = byEvent.get(h[1]) ?? new Set();
      byEvent.set(h[1], fields);
      const param = h[2];
      if (!param || param === "async") return;
      const body = src.slice(h.index, hits[i + 1]?.index ?? src.length);
      for (const f of body.matchAll(new RegExp(`(?<![\\w$.])${param.replace(/\$/g, "\\$")}\\??\\.([A-Za-z_]\\w*)`, "g"))) fields.add(f[1]);
    });
  }
  return [...byEvent].map(([event, fields]) => ({ event, fields }));
}

/** 소스들 → { pi: Set, ctx: Set, "ctx.ui": Set, "ctx.sessionManager": Set } (부르는 메서드 · 읽는 필드 이름)
 *  pi extension API 를 가져오는 파일만 본다 (brand.ts 의 색 이름 `pi.purple` 같은 다른 `pi` 를 빼려고) */
export function collectApi(sources) {
  const out = { pi: new Set(), ctx: new Set(), "ctx.ui": new Set(), "ctx.sessionManager": new Set() };
  for (const src of sources.filter((s) => /from\s*["']@earendil-works\/pi-coding-agent["']/.test(s))) {
    for (const m of src.matchAll(/(?<![\w$.])pi\.([A-Za-z_]\w*)/g)) out.pi.add(m[1]);
    for (const m of src.matchAll(/(?<![\w$.])ctx\??\.([A-Za-z_]\w*)(?:\??\.([A-Za-z_]\w*))?/g)) {
      out.ctx.add(m[1]);
      if (m[2] && (m[1] === "ui" || m[1] === "sessionManager")) out[`ctx.${m[1]}`].add(m[2]);
    }
  }
  return out;
}

/** .d.ts 글에 그 이름이 속성 · 메서드로 선언돼 있는가 */
export const declared = (dts, name) => new RegExp(`(?<![\\w$])(?:readonly\\s+)?${name}\\??\\s*[:(<]`).test(dts);

/** pi 가 만든 시스템 프롬프트 → prompt-trim 이 기대는 것 중 없는 것 */
export async function promptProblems(prompt, sections) {
  const { docsPointer } = await import(pathToFileURL(join(ROOT, "agent", "extensions", "oxy-prompt-trim.ts")).href);
  const out = [];
  if (!docsPointer(prompt)) out.push("prompt-trim: 시스템 프롬프트에 `- Additional docs: <경로>` 줄이 없다 (prompt-trim 이 조용히 꺼진다)");
  if (sections && !("docs" in sections)) out.push(`prompt-trim: 프롬프트 섹션에 docs 가 없다 (있는 것: ${Object.keys(sections).join(", ")})`);
  return out;
}

function entryOf(modules, spec) {
  const dir = join(modules, ...spec.split("/"));
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const e = pkg.exports?.["."] ?? pkg.exports;
  const rel = typeof e === "string" ? e : e?.import ?? e?.default ?? pkg.module ?? pkg.main ?? "index.js";
  return { dir, file: join(dir, typeof rel === "string" ? rel : rel.default), version: pkg.version };
}

/** 검사 전체 → { lines: ["PASS …" | "FAIL …"], failed } */
export async function checkContract({ extDir = join(ROOT, "agent", "extensions"), modules = join(ROOT, "vendor", "pi", "node_modules") } = {}) {
  const lines = [];
  const pass = (m) => lines.push(`PASS ${m}`);
  const fail = (m) => lines.push(`FAIL ${m}`);
  const sources = walk(extDir, [".ts"]).map((f) => readFileSync(f, "utf8"));
  const coding = entryOf(modules, "@earendil-works/pi-coding-agent");
  lines.push(`INFO pi ${coding.version} (${coding.dir})`);

  // 1) 가져다 쓰는 값 이름
  const imports = collectImports(sources);
  for (const [spec, names] of Object.entries(imports)) {
    let mod;
    try { mod = await import(pathToFileURL(entryOf(modules, spec).file).href); }
    catch (err) { fail(`${spec}: 불러오지 못함 (${String(err?.message ?? err).split("\n")[0]})`); continue; }
    const missing = [...names].filter((n) => !(n in mod));
    if (missing.length) fail(`${spec}: 없는 이름 ${missing.join(", ")}`);
    else pass(`${spec}: 가져다 쓰는 이름 ${names.size}개 (${[...names].join(", ")})`);
  }

  // 2) 이벤트 이름 · 이벤트 필드 (pi 와 같이 오는 @earendil-works/* 의 .d.ts 전부)
  const ew = join(modules, "@earendil-works");
  const dts = readdirSync(ew).filter((p) => existsSync(join(ew, p, "dist"))).flatMap((p) => walk(join(ew, p, "dist"), [".d.ts"])).map((f) => readFileSync(f, "utf8")).join("\n");
  const events = collectEvents(sources);
  const noEvent = events.filter((e) => !dts.includes(`on(event: "${e.event}"`)).map((e) => e.event);
  if (noEvent.length) fail(`이벤트 없음: ${noEvent.join(", ")}`);
  else pass(`이벤트 ${events.length}종이 ExtensionAPI.on 에 있음`);
  const noField = events.flatMap((e) => [...e.fields].filter((f) => f !== "type" && !declared(dts, f)).map((f) => `${e.event}.${f}`));
  if (noField.length) fail(`이벤트 필드 선언 없음: ${noField.join(", ")}`);
  else pass(`이벤트 필드 ${events.reduce((n, e) => n + e.fields.size, 0)}개가 선언돼 있음`);

  // 3) pi · ctx 의 메서드 · 필드
  const api = collectApi(sources);
  const noApi = Object.entries(api).flatMap(([who, names]) => [...names].filter((n) => !declared(dts, n)).map((n) => `${who}.${n}`));
  if (noApi.length) fail(`API 선언 없음: ${noApi.join(", ")}`);
  else pass(`API ${Object.values(api).reduce((n, s) => n + s.size, 0)}개 (pi · ctx · ctx.ui · ctx.sessionManager) 가 선언돼 있음`);

  // 4) prompt-trim 이 읽는 시스템 프롬프트 문구
  let sp = null;
  for (const f of [coding.file, join(coding.dir, "dist", "core", "system-prompt.js")]) {
    try { const m = await import(pathToFileURL(f).href); if (typeof m.buildSystemPrompt === "function") { sp = m; break; } } catch { /* 다음 후보 */ }
  }
  if (!sp) fail("시스템 프롬프트를 만드는 함수(buildSystemPrompt)를 찾지 못함 — E2E 의 prompt-trim 검사로 확인");
  else {
    const cwd = mkdtempSync(join(tmpdir(), "oxy-contract-"));
    try {
      const input = { cwd, selectedTools: ["read", "bash", "edit", "write"] };
      const problems = await promptProblems(sp.buildSystemPrompt(input), sp.buildSystemPromptSections?.(input));
      if (problems.length) problems.forEach(fail);
      else pass("prompt-trim: `- Additional docs:` 줄 · docs 섹션 있음");
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  }
  return { lines, failed: lines.filter((l) => l.startsWith("FAIL")).length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [extDir, modules] = process.argv.slice(2);
  const { lines, failed } = await checkContract({ ...(extDir && { extDir }), ...(modules && { modules }) });
  for (const l of lines) console.log(`  ${l}`);
  console.log(failed ? `pi 계약 검사 실패 (${failed})` : "pi 계약 검사 통과");
  process.exit(failed ? 1 : 0);
}
