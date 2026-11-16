// 큰 저장소 탐색과 위임 (suite "explore", 2026-11-16). SWE-Explore 벤치마크(arXiv 2606.07297)의 이슈 일부로,
// 컨텍스트를 채울 만한 탐색에서 메인 에이전트가 subagent 에 맡기는지, 맡기면 탐색 품질 · 메인 컨텍스트 · 비용이 어떻게 달라지는지 본다.
//   조건 a: 지금 기준(AGENTS.md) 그대로 모델이 고른다.  조건 b: 탐색을 하위 에이전트에 맡기라고 프롬프트에서 지시한다.
// 데이터셋은 CC BY-NC-ND 4.0 이라 저장소에 넣지 않는다: SWE_EXPLORE_DIR (기본 %TEMP%/swe-explore) 에 받아 둔 파일만 읽는다.
//   bench.final.public.jsonl (정답 구간) · picked.jsonl (원 벤치마크의 instance_id · repo · base_commit · problem_statement)
//   저장소는 GitHub codeload 의 커밋 tarball 을 repos/<instance_id>/ 에 한 번 풀어 두고, 시나리오 폴더는 그곳을 가리키는 junction 이다 (읽기만 한다).
// 지표는 논문의 채점 스크립트가 아니라 같은 정답으로 계산한 단순판이다: 파일 재현율, 줄 정밀도 · 재현율 (예측 구간은 순서대로 500줄까지만 센다).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const D = process.env.SWE_EXPLORE_DIR ?? path.join(os.tmpdir(), "swe-explore");
const BUDGET = 500;
const LANG = { "apache__": "Java", "projectlombok__": "Java", "vuejs__": "TS", "facebook__": "TS", "django__": "Python", "scikit-learn__": "Python", "sympy__": "Python" };

function load() {
  const pf = path.join(D, "picked.jsonl"), bf = path.join(D, "bench.final.public.jsonl");
  if (!fs.existsSync(pf) || !fs.existsSync(bf)) return [];
  const picked = fs.readFileSync(pf, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((p) => p?.instance_id);
  const want = new Set(picked.map((p) => p.instance_id));
  const gt = new Map();
  for (const l of fs.readFileSync(bf, "utf8").split("\n")) {
    if (!l) continue;
    const id = /"instance_id":\s*"([^"]+)"/.exec(l)?.[1];
    if (want.has(id)) gt.set(id, JSON.parse(l).ground_truth);
  }
  return picked.filter((p) => gt.has(p.instance_id)).map((p) => ({ ...p, gt: gt.get(p.instance_id) }));
}

/** repos/<id>/ 에 커밋 tarball 을 한 번 풀어 둔다 */
function ensureRepo(p) {
  const dest = path.join(D, "repos", p.instance_id);
  if (fs.existsSync(path.join(dest, ".ready"))) return dest;
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  const tgz = path.join(D, "repos", `${p.instance_id}.tar.gz`);
  if (!fs.existsSync(tgz)) {
    const r = spawnSync("curl", ["-sSfL", "-o", tgz, `https://codeload.github.com/${p.repo}/tar.gz/${p.base_commit}`], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`저장소 받기 실패 ${p.repo}@${p.base_commit}: ${r.stderr}`);
  }
  const msys = (x) => x.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
  const r = spawnSync("bash", ["-c", `tar -xzf "${msys(tgz)}" -C "${msys(dest)}" --strip-components=1`], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`압축 풀기 실패 ${p.instance_id}: ${r.stderr.slice(0, 300)}`);
  fs.writeFileSync(path.join(dest, ".ready"), p.base_commit);
  return dest;
}

/** 시나리오 폴더(dir)를 받아 둔 저장소로 가리키는 junction 으로 바꾼다 */
function linkRepo(dir, repo) {
  fs.rmSync(dir, { recursive: true, force: true });
  const r = spawnSync("cmd", ["/c", "mklink", "/J", dir, repo], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`junction 실패: ${r.stdout}${r.stderr}`);
}

const norm = (p) => String(p ?? "").replace(/\\/g, "/").replace(/^\.?\//, "").replace(/^\/?testbed\//, "");

/** 답의 마지막 JSON 배열 [{path, start, end}] */
export function parseRegions(text, max = 5) {
  const all = [...String(text ?? "").matchAll(/\[\s*\{[\s\S]*?\}\s*\]/g)].map((m) => m[0]);
  for (const s of all.reverse()) {
    try {
      const arr = JSON.parse(s);
      const ok = arr.filter((r) => r && r.path && Number.isFinite(Number(r.start)) && Number.isFinite(Number(r.end)))
        .map((r) => ({ path: norm(r.path), start: Math.max(1, Number(r.start)), end: Math.max(Number(r.start), Number(r.end)) }));
      if (ok.length) return ok.slice(0, max);
    } catch { /* 다음 후보 */ }
  }
  return [];
}

/** 답에 있는 모든 JSON 배열의 구간 (이슈마다 배열을 따로 적는 답이 있다). 같은 구간은 한 번만 */
export function parseAllRegions(text) {
  const out = [], seen = new Set();
  const t = String(text ?? "");
  // ```json 블록 전체를 먼저, 없으면 맨 바깥 배열 후보. 안쪽까지 내려가며 {path, start, end} 를 모은다 ({issue, ranges:[…]} 처럼 묶어 적는 답이 있다)
  const blocks = [...t.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  const cands = blocks.length ? blocks : [...t.matchAll(/\[[\s\S]*\]/g)].map((m) => m[0]);
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== "object") return;
    if (v.path && Number.isFinite(Number(v.start)) && Number.isFinite(Number(v.end))) {
      const x = { path: norm(v.path), start: Math.max(1, Number(v.start)), end: Math.max(Number(v.start), Number(v.end)) };
      const k = `${x.path}:${x.start}:${x.end}`;
      if (!seen.has(k)) { seen.add(k); out.push(x); }
      return;
    }
    Object.values(v).forEach(walk);
  };
  // 블록 첫 줄에 저장소 이름을 적는 답이 있어 통째로 안 읽히면 처음 [ 부터 마지막 ] 까지만 읽는다
  for (const c of cands) {
    try { walk(JSON.parse(c)); continue; } catch { /* 아래에서 다시 */ }
    try { walk(JSON.parse(c.slice(c.indexOf("["), c.lastIndexOf("]") + 1))); } catch { /* JSON 이 아닌 블록 */ }
  }
  return out;
}

/** 파일 재현율 · 줄 정밀도 · 줄 재현율 (예측은 순서대로 BUDGET 줄까지) */
export function score(pred, gt) {
  const gtFiles = new Set(gt.read_core_files.map(norm));
  const gtLines = new Map();
  for (const r of gt.read_core_regions) {
    const f = norm(r.path);
    if (!gtLines.has(f)) gtLines.set(f, new Set());
    for (let i = r.start; i <= r.end; i++) gtLines.get(f).add(i);
  }
  const gtTotal = [...gtLines.values()].reduce((a, s) => a + s.size, 0);
  let left = BUDGET, used = 0, hit = 0;
  const seen = new Set();
  for (const r of pred) {
    for (let i = r.start; i <= r.end && left > 0; i++, left--) {
      const k = `${r.path}:${i}`;
      if (seen.has(k)) continue;
      seen.add(k); used++;
      if (gtLines.get(r.path)?.has(i)) hit++;
    }
  }
  const predFiles = new Set(pred.map((r) => r.path));
  const fileHit = [...gtFiles].filter((f) => predFiles.has(f)).length;
  return { fileRecall: gtFiles.size ? fileHit / gtFiles.size : 0, linePrec: used ? hit / used : 0, lineRecall: gtTotal ? hit / gtTotal : 0, regions: pred.length };
}

const ask = (p, delegate) => [
  "아래 이슈를 해결하려면 이 저장소에서 어떤 코드를 봐야 하는지 찾아줘. 코드는 고치지 마.",
  ...(delegate ? ["저장소가 커서 탐색 결과가 컨텍스트를 많이 차지할 수 있으니, 저장소 탐색은 하위 에이전트에게 맡기고 너는 그 결과로 답을 정리해."] : []),
  "", "<이슈>", p.problem_statement.trim(), "</이슈>", "",
  "답의 마지막에 이 이슈와 관련도가 높은 순서로 코드 구간을 최대 5개, 다음 형식의 JSON 배열로 적어 줘 (경로는 저장소 기준):",
  `[{"path": "src/a/B.java", "start": 120, "end": 180}]`,
].join("\n");

const short = (id) => id.replace(/__/, "-").replace(/^(apache|projectlombok|vuejs|facebook|django|scikit-learn|sympy)-/, "").replace(/scikit-learn/, "sklearn");

// ---------------------------------------------------------------- 병렬 위임 (suite "parallel", 2026-11-16 사용자: "메인 컨텍스트의 부담을 얼마나 덜어줄 수 있냐와
// 병렬 실행으로 어느정도의 시간을 절약할 수 있느냐"). 한 요청에 서로 다른 저장소의 이슈 3개. 작업 폴더 아래에 저장소마다 junction 을 둔다.
//   self: 위임 없이 직접 · seq: 하나씩 차례로 위임 · par: 셋을 동시에 위임 · free: 지시 없음
const TRIOS = [
  ["projectlombok__lombok-3009", "django__django-11239", "sympy__sympy-13852"],
  ["apache__druid-16875", "vuejs__core-11739", "scikit-learn__scikit-learn-13496"],
  ["apache__lucene-13301", "facebook__docusaurus-10130", "projectlombok__lombok-3697"],
];
const HOW = {
  self: "하위 에이전트나 백그라운드 작업을 쓰지 말고 네가 직접 차례로 조사해.",
  seq: "각 이슈의 조사는 하위 에이전트에게 맡겨. 한 번에 하나만 맡기고, 그 결과를 받은 뒤에 다음 이슈를 맡겨.",
  par: "세 이슈의 조사를 하위 에이전트들에게 동시에 병렬로 맡겨.",
  free: "",
};
const askTrio = (ps, how) => [
  "이 폴더 아래에 저장소 세 개가 있어. 각 저장소의 이슈를 해결하려면 어떤 코드를 봐야 하는지 찾아줘. 코드는 고치지 마.",
  ...((HOW[how] ?? SAY[how]) ? [HOW[how] ?? SAY[how]] : []),
  ...ps.flatMap((p) => ["", `<이슈 저장소="${short(p.instance_id)}/">`, p.problem_statement.trim(), "</이슈>"]),
  "",
  "답의 마지막에 이슈마다 관련도가 높은 순서로 코드 구간을 최대 5개씩, 하나의 JSON 배열로 적어 줘. 경로는 이 폴더 기준(저장소 폴더 이름으로 시작):",
  `[{"path": "${short(ps[0].instance_id)}/src/a/B.java", "start": 120, "end": 180}]`,
].join("\n");

// 사용자 표현 단계 (실험 2): 하위 에이전트라는 말 없이 어디까지 말해야 부르는가
const SAY = {
  say1: "세 저장소를 각각 따로 조사해.",
  say2: "세 저장소를 나눠서 동시에 조사해.",
  say3: "세 저장소 조사를 병렬로 진행해.",
};
const EXPECT = { self: "self", seq: "subagent", par: "subagent", free: "free", say1: "free", say2: "free", say3: "free" };

function trioCheck(ps) {
  return ({ text }) => {
    const all = parseAllRegions(text);
    const per = ps.map((p) => {
      const pre = `${short(p.instance_id)}/`;
      const mine = all.filter((r) => r.path.startsWith(pre)).map((r) => ({ ...r, path: r.path.slice(pre.length) })).slice(0, 5);
      return { id: short(p.instance_id), ...score(mine, p.gt) };
    });
    const avg = (k) => per.reduce((a, x) => a + x[k], 0) / per.length;
    const m = { fileRecall: avg("fileRecall"), linePrec: avg("linePrec"), lineRecall: avg("lineRecall"), regions: all.length, per };
    const f = (x) => x.toFixed(2);
    return { pass: per.every((x) => x.regions > 0), note: `평균 파일 재현율 ${f(m.fileRecall)} · 줄 정밀도 ${f(m.linePrec)} · 줄 재현율 ${f(m.lineRecall)} · 구간 ${all.length} (${per.map((x) => `${x.id}:${x.regions}`).join(" ")})`, metrics: m };
  };
}
const linkAll = (dir, ps) => { fs.mkdirSync(dir, { recursive: true }); for (const p of ps) linkRepo(path.join(dir, short(p.instance_id)), ensureRepo(p)); return {}; };
const askOneIn = (p, how) => [
  `이 폴더의 ${short(p.instance_id)}/ 저장소에서 아래 이슈를 해결하려면 어떤 코드를 봐야 하는지 찾아줘. 코드는 고치지 마.`,
  ...(how ? [how] : []), "", "<이슈>", p.problem_statement.trim(), "</이슈>", "",
  "답의 마지막에 관련도가 높은 순서로 코드 구간을 최대 5개, JSON 배열로 적어 줘. 경로는 이 폴더 기준(저장소 폴더 이름으로 시작):",
  `[{"path": "${short(p.instance_id)}/src/a/B.java", "start": 120, "end": 180}]`,
].join("\n");

export const PARALLEL = (() => {
  const all = new Map(load().map((p) => [p.instance_id, p]));
  const trios = TRIOS.map((ids) => ids.map((id) => all.get(id)).filter(Boolean)).filter((ps) => ps.length === 3);
  if (trios.length !== TRIOS.length) return [];
  const out = trios.flatMap((ps, t) => [...Object.keys(HOW), ...Object.keys(SAY)].map((how) => ({
    id: `t${t + 1}-${how}`, group: "parallel", expect: EXPECT[how],
    prompt: () => askTrio(ps, how),
    setup(dir) { return linkAll(dir, ps); },
    check: trioCheck(ps),
  })));
  // 대화가 이미 긴 상태 (실험 1 · 3): 묶음 2 · 3 을 직접 조사한 뒤(앞 요청 둘) 같은 세션에서 묶음 1 또는 단일 이슈를 묻는다
  const [t1, t2, t3] = trios;
  const nine = [...t1, ...t2, ...t3];
  const pre = [() => askTrio(t2, "self"), () => askTrio(t3, "self")];
  for (const how of ["free", "self", "par"]) {
    out.push({ id: `long-${how}`, group: "long", expect: EXPECT[how], turns: [...pre, () => askTrio(t1, how)], setup(dir) { return linkAll(dir, nine); }, check: trioCheck(t1) });
  }
  const one = t1[1];   // django
  out.push({ id: "long-single", group: "long", expect: "free", turns: [...pre, () => askOneIn(one, "")], setup(dir) { return linkAll(dir, nine); }, check: trioCheck([one]) });
  return out;
})();

export const EXPLORE = load().flatMap((p) => ["a", "b"].map((cond) => ({
  id: `${short(p.instance_id)}-${cond}`, group: `explore-${LANG[Object.keys(LANG).find((k) => p.instance_id.startsWith(k))] ?? "?"}`,
  expect: cond === "b" ? "subagent" : "free",
  prompt: () => ask(p, cond === "b"),
  setup(dir) { linkRepo(dir, ensureRepo(p)); return {}; },
  check({ text }) {
    const pred = parseRegions(text);
    const m = score(pred, p.gt);
    const f = (x) => x.toFixed(2);
    return { pass: m.fileRecall >= 0.5, note: `파일 재현율 ${f(m.fileRecall)} · 줄 정밀도 ${f(m.linePrec)} · 줄 재현율 ${f(m.lineRecall)} · 구간 ${m.regions}`, metrics: m };
  },
})));
