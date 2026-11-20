// 구성요소 업데이트 검증 (docs/upgrade-check-spec.md) 의 순수 로직 · 표 점검
//   node --test tests/unit-upgrade.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readLock } from "../installer/components.mjs";
import { mapProblems, plan, readMap } from "./upgrade-check/map.mjs";
import { collectApi, collectEvents, collectImports, declared, promptProblems } from "./upgrade-check/pi-contract.mjs";
import { collectUsage, parseLine } from "./upgrade-check/tool-usage.mjs";
import { changedSince, commandOf, fingerprints, gateProblem, lockId, resultLine } from "./upgrade-check/run.mjs";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("영향 표: lock 의 모든 구성요소가 표에 있고, 표의 검사 이름이 정해진 것", () => {
  assert.deepEqual(mapProblems(readLock(root), readMap(root)), []);
});

test("영향 표: 빠진 행 · 남는 행 · 모르는 검사 · 중복을 잡는다", () => {
  const lock = [{ name: "a" }, { name: "b" }];
  assert.deepEqual(mapProblems(lock, [{ name: "a", checks: ["unit"], manual: [] }]), ["영향 표에 없음: b"]);
  assert.deepEqual(
    mapProblems(lock, [{ name: "a", checks: ["unit"], manual: [] }, { name: "b", checks: ["e2e"], manual: [] }, { name: "c", checks: ["unit"], manual: [] }]),
    ["lock 에 없음: c"],
  );
  assert.deepEqual(mapProblems([{ name: "a" }], [{ name: "a", checks: ["unti"], manual: [] }]), ["모르는 검사: a unti"]);
  assert.deepEqual(mapProblems([{ name: "a" }], [{ name: "a", checks: [], manual: [] }]), ["자동 검사 없음: a"]);
  assert.deepEqual(
    mapProblems([{ name: "a" }], [{ name: "a", checks: ["unit"], manual: [] }, { name: "a", checks: ["unit"], manual: [] }]),
    ["중복: a"],
  );
});

test("영향 표: 바뀐 구성요소 → 돌릴 검사(가벼운 것부터) · 도구 확인 대상 · 남는 실측", () => {
  const map = [
    { name: "pi", checks: ["hygiene", "unit", "contract", "e2e"], manual: ["화면 캡처"] },
    { name: "jq", checks: ["hygiene", "unit", "tools", "e2e"], manual: [] },
    { name: "fd", checks: ["tools"], manual: [] },
  ];
  assert.deepEqual(plan(map, ["jq", "pi"]), {
    checks: ["hygiene", "unit", "contract", "tools", "e2e"],
    tools: ["jq"],
    manual: ["pi: 화면 캡처"],
  });
  // 표에 없는 이름 · 빈 목록이어도 위생 · 단위는 돈다
  assert.deepEqual(plan(map, []), { checks: ["hygiene", "unit"], tools: [], manual: [] });
});

test("영향 표: pi 를 올리면 계약 · 타입 · E2E · 설치 흐름과 화면 실측이 들어간다", () => {
  const p = plan(readMap(root), ["pi"]);
  for (const c of ["contract", "typecheck", "e2e", "installer"]) assert.ok(p.checks.includes(c), c);
  assert.ok(p.manual.some((m) => m.includes("WT 실제 클릭")));
});

// ---------------------------------------------------------------- pi 계약 검사 (§3 C1)

test("pi 계약: 값 import 만 모으고 type · 다른 모듈 · 별칭을 가린다", () => {
  const got = collectImports([
    `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";`,
    `import { type ExtensionAPI, getAgentDir, CustomEditor as CE } from "@earendil-works/pi-coding-agent";`,
    `import { Type } from "typebox";\nimport { join } from "node:path";\nimport { x } from "./local.ts";`,
  ]);
  assert.deepEqual(Object.fromEntries(Object.entries(got).map(([k, v]) => [k, [...v]])), {
    "@earendil-works/pi-coding-agent": ["getAgentDir", "CustomEditor"],
    typebox: ["Type"],
  });
});

test("pi 계약: 이벤트마다 그 처리 함수 안에서 읽는 필드를 모은다", () => {
  const got = collectEvents([
    `pi.on("tool_call", async (event: any, ctx) => { if (event.toolName === "bash") use(event.input?.command, ctx.cwd); });
     pi.on("session_start", () => reset());
     pi.on("before_agent_start", async (e) => { e.systemPromptOptions.sections; other.event.nope; });`,
  ]);
  assert.deepEqual(got.map((g) => [g.event, [...g.fields]]), [
    ["tool_call", ["toolName", "input"]],
    ["session_start", []],
    ["before_agent_start", ["systemPromptOptions"]],
  ]);
});

test("pi 계약: pi · ctx API 는 pi extension API 를 가져오는 파일에서만 모은다", () => {
  const api = collectApi([
    `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";\npi.registerTool({}); ctx.ui.notify("x"); ctx?.sessionManager.getEntries(); ctx.cwd;`,
    `export const pi = { purple: "#A798D7" }; pi.purple;`,
  ]);
  assert.deepEqual([...api.pi], ["registerTool"]);
  assert.deepEqual([...api.ctx].sort(), ["cwd", "sessionManager", "ui"]);
  assert.deepEqual([...api["ctx.ui"]], ["notify"]);
  assert.deepEqual([...api["ctx.sessionManager"]], ["getEntries"]);
});

test("pi 계약: .d.ts 선언 찾기 (속성 · 선택 속성 · 메서드 · readonly)", () => {
  const dts = `interface A { readonly systemPrompt: string; payload?: unknown; notify(msg: string): void; on<T>(e: T): void; }`;
  for (const n of ["systemPrompt", "payload", "notify", "on"]) assert.ok(declared(dts, n), n);
  for (const n of ["system", "notifyX", "load"]) assert.ok(!declared(dts, n), n);
});

test("pi 계약: prompt-trim 이 읽는 `- Additional docs:` 줄 · docs 섹션이 없으면 알린다", async () => {
  const good = "...\n- Additional docs: C:\oxy\vendor\pi\docs\n- Examples: C:\oxy\vendor\pi\examples\n";
  assert.deepEqual(await promptProblems(good, { docs: "x" }), []);
  const bad = await promptProblems(good.replace("Additional docs", "More docs"), { tools: "x" });
  assert.equal(bad.length, 2);
  assert.match(bad[0], /Additional docs/);
  assert.match(bad[1], /docs 가 없다 \(있는 것: tools\)/);
});

// ---------------------------------------------------------------- 도구 확인: skill 본문의 하위 명령 · 옵션 (§3 C3)
test("도구 확인: 명령 줄 → 하위 명령 · 옵션 (따옴표 · 주석 · 파이프 · <자리표시> 를 가린다)", () => {
  assert.deepEqual(parseLine(`gh pr list --state open --json number,title --jq '.[] | "\(.number)"'`), { tool: "gh", sub: "pr list", flags: ["--state", "--json", "--jq"] });
  assert.deepEqual(parseLine("gh run view <run-id> --log-failed                  # only failed"), { tool: "gh", sub: "run view", flags: ["--log-failed"] });
  assert.deepEqual(parseLine("glab mr note create 123 -m \"comment text\""), { tool: "glab", sub: "mr note create", flags: ["-m"] });
  assert.deepEqual(parseLine("glab mr list --author=@me -F json"), { tool: "glab", sub: "mr list", flags: ["--author", "-F"] });
  assert.deepEqual(parseLine("agent-browser --session $S snapshot -i -c"), { tool: "agent-browser", sub: "snapshot", flags: ["--session", "-i", "-c"] });
  assert.deepEqual(parseLine("hurl -v --variable base=http://x form.hurl 2>&1 >/dev/null | grep -E '^< HTTP'"), { tool: "hurl", sub: "", flags: ["-v", "--variable"] });
  assert.deepEqual(parseLine("rg -n 'a|b' src | head"), { tool: "rg", sub: "", flags: ["-n"] });
  assert.equal(parseLine("echo hi"), null);
});

test("도구 확인: 코드 블록 안의 줄만 모으고, 같은 하위 명령의 옵션을 합친다", () => {
  const md = "gh pr list --state open\n```bash\ngh pr list --state open\ngh pr list --json x\njq -r .a f\n```\njq -s .\n";
  const got = Object.fromEntries([...collectUsage([md])].map(([k, v]) => [k, [...v]]));
  assert.deepEqual(got, { "gh\tpr list": ["--state", "--json"], "jq\t": ["-r"] });
});

// ---------------------------------------------------------------- just upgrade-check · 번들링 막기 (§4, D2 · D3)
function fakeManifest(rows, npmLock = "{}") {
  const d = mkdtempSync(join(tmpdir(), "oxy-upg-"));
  mkdirSync(join(d, "manifest"));
  writeFileSync(join(d, "manifest", "tools.lock.tsv"), "# 주석\n" + rows.map((r) => r.join("\t")).join("\n") + "\n");
  writeFileSync(join(d, "manifest", "pi-package-lock.json"), npmLock);
  return d;
}

test("upgrade-check: 지문은 버전 · 주소 · sha256 과 npm lockfile 내용이 바뀌면 달라진다", () => {
  const rows = [["jq", "1.8.2", "https://x/jq.exe", "aa", "MIT", "required", "core"], ["pi", "1.5.0", "@p/pi@1.5.0", "npm-lock", "MIT", "required", "core"]];
  const a = fakeManifest(rows, '{"v":1}'), b = fakeManifest(rows, '{"v":2}'), c = fakeManifest([[...rows[0].slice(0, 3), "bb", ...rows[0].slice(4)], rows[1]], '{"v":1}');
  try {
    const fa = fingerprints(a), fb = fingerprints(b), fc = fingerprints(c);
    assert.equal(fa.jq, fb.jq);
    assert.notEqual(fa.pi, fb.pi);          // 같은 버전이어도 npm lockfile 이 바뀜
    assert.notEqual(fa.jq, fc.jq);          // sha256 이 바뀜
    assert.match(fa.pi, /^1\.5\.0 /);
    assert.notEqual(lockId(fa), lockId(fb));
  } finally { for (const d of [a, b, c]) rmSync(d, { recursive: true, force: true }); }
});

test("upgrade-check: 지난 통과 기록과 비교해 바뀐 구성요소를 고르고, 기록이 없으면 전부", () => {
  const fp = { jq: "1.8.3 h2", fd: "10.5.2 h1", pi: "1.5.0 h9" };
  assert.deepEqual(changedSince(fp, []).names, ["jq", "fd", "pi"]);
  const results = [
    { pass: true, lock: { jq: "1.8.1 h0", fd: "10.5.2 h1", pi: "1.5.0 h8" } },
    { pass: true, lock: { jq: "1.8.2 h1", fd: "10.5.2 h1", pi: "1.5.0 h8" } },
    { pass: false, lock: fp },               // 실패한 기록은 기준이 아니다
  ];
  assert.deepEqual(changedSince(fp, results), { names: ["jq", "pi"], notes: ["jq 1.8.2 → 1.8.3", "pi 1.5.0 → 1.5.0 (lock 내용)"] });
});

test("upgrade-check: 번들링 막기 — 지금 lock 으로 통과한 기록이 있어야 한다", () => {
  const fp = { jq: "1.8.3 h2" };
  assert.match(gateProblem(fp, []), /통과한 기록이 없습니다 .*just upgrade-check/);
  assert.match(gateProblem(fp, [{ pass: false, lockId: lockId(fp), lock: fp }]), /통과한 기록이 없습니다/);
  assert.match(gateProblem(fp, [{ pass: true, lockId: "other", lock: { jq: "1.8.2 h1" } }]), /jq 1\.8\.2 → 1\.8\.3/);
  assert.equal(gateProblem(fp, [{ pass: true, lockId: lockId(fp), lock: fp }]), null);
});

test("upgrade-check: 검사마다 결과 줄을 고른다 (통과: 마지막 줄, 실패: 첫 실패 줄)", () => {
  assert.equal(resultLine("# tests 3\n# pass 3\n# fail 0\n", commandOf("unit", []).line, true), "# pass 3 · # fail 0");
  assert.equal(resultLine("  PASS a\n  FAIL glab: 옵션 없음\n도구 확인 실패 (1)\n", commandOf("tools", ["glab"]).line, false), "FAIL glab: 옵션 없음");
  assert.equal(resultLine("\x1b[36m[oxy]\x1b[0m E2E 통과\r\n", commandOf("e2e", []).line, true), "E2E 통과");
  assert.match(commandOf("tools", ["jq", "fd"]).cmd, /tools\.sh jq fd$/);
});
