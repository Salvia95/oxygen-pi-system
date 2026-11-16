// 변경 영향 조사 (suite "impact", 2026-11-16 사용자: "특정 모듈의 의존성을 쫓으면서 관련된 모든 파일을 찾아 수정 대상에 올리는 작업이라면 좀 다를까?").
// Apache Lucene 의 실제 API 변경 커밋 5개를 정답으로 쓴다: 커밋 직전 상태에서 "이렇게 바꾸려 한다, 함께 고쳐야 할 파일을 모두 찾아라" 를 묻고
// 커밋이 실제로 고친 .java 파일 목록과 비교한다 (커밋에 섞인 정리 변경도 정답에 들어가므로 정밀도는 낮게 나올 수 있다).
//   self: 위임 없이 직접 · par: 하위 에이전트들에게 나눠 병렬로 · free: 지시 없음
// 자료는 저장소에 넣지 않는다: LUCENE_HIST (기본 %TEMP%/lucene-hist, 이력만 받은 clone) 에서 정답을, 커밋 직전 tarball 은 %TEMP%/lucene-impact/ 에 받는다.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const HIST = process.env.LUCENE_HIST ?? path.join(os.tmpdir(), "lucene-hist");
const CACHE = path.join(os.tmpdir(), "lucene-impact");

const CASES = [
  { id: "hasvectors", commit: "3da48d0403",
    ask: "FieldInfo#hasVectors() 와 FieldInfos#hasVectors() 의 이름을 hasTermVectors() 로 바꾸려고 해 (밀집 벡터와 텀 벡터를 헷갈리지 않게)." },
  { id: "brtostring", commit: "9206bdeb06",
    ask: "여러 클래스에 각자 들어 있는 brToString(BytesRef) · brToString(byte[]) 같은 BytesRef 문자열 변환 메서드를 없애고, org.apache.lucene.util.ToStringUtils 의 static 메서드 하나로 모으려고 해." },
  { id: "ioread", commit: "32d692049f",
    ask: "IOContext.READ 와 IOContext.Context.READ 를 없애고, 쓰던 곳은 모두 IOContext.DEFAULT (Context.DEFAULT) 를 쓰게 바꾸려고 해." },
  { id: "sortpos", commit: "2e2c4818d1",
    ask: "SortField.getComparator(int numHits, int sortPos) 의 두 번째 매개변수를 boolean enableSkipping 으로 바꾸려고 해. sortPos 는 스킵을 켤지 정하는 데만 쓰이고 있어." },
  { id: "pointvalues", commit: "842a47158f",
    ask: "LeafReader#getPointValues(String) 의 throws IOException 을 없애려고 해." },
];

const git = (...a) => spawnSync("git", ["-C", HIST, ...a], { encoding: "utf8", maxBuffer: 64 << 20 });

/** 정답: 커밋이 고친 .java 파일 (추가 · 삭제 포함) */
function truth(commit) {
  const r = git("show", "--name-only", "--format=", commit, "--", "*.java");
  if (r.status !== 0) throw new Error(`git show 실패 ${commit}: ${r.stderr}`);
  return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** 커밋 직전 tarball 을 한 번 풀어 둔다 */
function ensureParent(commit) {
  const parent = git("rev-parse", `${commit}^`).stdout.trim();
  const dest = path.join(CACHE, "repos", parent);
  if (fs.existsSync(path.join(dest, ".ready"))) return dest;
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  const tgz = path.join(CACHE, "repos", `${parent}.tar.gz`);
  if (!fs.existsSync(tgz)) {
    const r = spawnSync("curl", ["-sSfL", "-o", tgz, `https://codeload.github.com/apache/lucene/tar.gz/${parent}`], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`받기 실패 ${parent}: ${r.stderr}`);
  }
  const msys = (x) => x.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
  const r = spawnSync("bash", ["-c", `tar -xzf "${msys(tgz)}" -C "${msys(dest)}" --strip-components=1`], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`압축 풀기 실패: ${r.stderr.slice(0, 300)}`);
  fs.writeFileSync(path.join(dest, ".ready"), parent);
  return dest;
}

function linkRepo(dir, repo) {
  fs.rmSync(dir, { recursive: true, force: true });
  const r = spawnSync("cmd", ["/c", "mklink", "/J", dir, repo], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`junction 실패: ${r.stdout}${r.stderr}`);
}

const norm = (p) => String(p ?? "").replace(/\\/g, "/").replace(/^\.?\//, "").trim();

/** 답의 JSON 배열에서 .java 경로 (문자열 배열이든 {path} 배열이든). 여러 배열이면 모두 */
export function parseFiles(text) {
  const out = new Set();
  const t = String(text ?? "");
  const blocks = [...t.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  const walk = (v) => {
    if (typeof v === "string") { if (/\.java$/.test(v.trim())) out.add(norm(v)); return; }
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === "object") { if (v.path) walk(String(v.path)); else Object.values(v).forEach(walk); }
  };
  for (const c of blocks.length ? blocks : [t]) {
    try { walk(JSON.parse(c)); continue; } catch { /* 아래 */ }
    try { walk(JSON.parse(c.slice(c.indexOf("["), c.lastIndexOf("]") + 1))); } catch { /* JSON 아님 */ }
  }
  return [...out];
}

const HOW = {
  self: "하위 에이전트나 백그라운드 작업을 쓰지 말고 네가 직접 조사해.",
  par: "조사할 범위를 나눠서 하위 에이전트들에게 병렬로 맡기고, 결과를 모아서 정리해.",
  free: "",
};

const ask = (c, how) => [
  `이 저장소는 Apache Lucene 이야. ${c.ask}`,
  "이 변경 때문에 함께 고쳐야 하는 Java 파일(정의, 재정의 · 구현, 호출하는 곳, 테스트 포함)을 모두 찾아줘. 코드는 고치지 마.",
  ...(HOW[how] ? [HOW[how]] : []),
  "",
  "답의 마지막에 고쳐야 하는 파일의 저장소 기준 경로를 빠짐없이 하나의 JSON 배열로 적어 줘:",
  `["lucene/module/src/java/org/apache/lucene/pkg/Example.java", "..."]`,
].join("\n");

export const IMPACT = (() => {
  if (!fs.existsSync(path.join(HIST, ".git"))) return [];
  return CASES.flatMap((c) => {
    let gt;
    try { gt = truth(c.commit); } catch { return []; }
    return Object.keys(HOW).map((how) => ({
      id: `${c.id}-${how}`, group: "impact", expect: { self: "self", par: "subagent", free: "free" }[how],
      prompt: () => ask(c, how),
      setup(dir) { linkRepo(dir, ensureParent(c.commit)); return {}; },
      check({ text }) {
        const pred = parseFiles(text);
        const g = new Set(gt.map(norm));
        const hit = pred.filter((p) => g.has(p)).length;
        const m = { recall: g.size ? hit / g.size : 0, precision: pred.length ? hit / pred.length : 0, found: hit, gt: g.size, listed: pred.length,
          missed: [...g].filter((x) => !pred.includes(x)).map((x) => x.split("/").pop()) };
        const f = (x) => x.toFixed(2);
        return { pass: m.recall >= 0.8, note: `재현율 ${f(m.recall)} (${hit}/${g.size}) · 정밀도 ${f(m.precision)} (목록 ${pred.length})`, metrics: m };
      },
    }));
  });
})();
