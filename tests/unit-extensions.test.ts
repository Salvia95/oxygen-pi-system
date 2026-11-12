// oxy extension 순수 로직 단위 테스트 (외부 의존성 없음)
//   node --experimental-strip-types --test tests/unit-extensions.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect, muxPayloads, splitSegments } from "../agent/extensions/oxy-bash-guard.ts";
import { clip } from "../agent/extensions/oxy-context-budget.ts";
import { docsPointer } from "../agent/extensions/oxy-prompt-trim.ts";
import { pathKey } from "../agent/extensions/_lib/common.ts";
import { existsSync as existsSyncTop } from "node:fs";
import { join } from "node:path";

const ids = (cmd: string) => inspect(cmd, process.cwd()).map((f) => `${f.rule.level}:${f.rule.id}`);

test("splitSegments: 체인/따옴표/서브셸", () => {
  assert.deepEqual(splitSegments(`echo "a; b" && rm -rf / ; ls | wc -l`), [`echo "a; b"`, "rm -rf /", "ls", "wc -l"]);
  assert.deepEqual(splitSegments("FOO=1 sudo git push origin main"), ["git push origin main"]);
  assert.deepEqual(splitSegments("echo $(rm -rf ~)"), ["echo", "rm -rf ~"]);
  assert.deepEqual(splitSegments("find . -name x | xargs -0 rm -rf"), ["find . -name x", "rm -rf"]);
  assert.deepEqual(splitSegments("/usr/bin/git.exe push"), ["git push"]);
});

test("deny: 파괴적 명령", () => {
  for (const c of ["rm -rf /", "rm -rf ~", "rm -fr /c/", "rm -rf C:\\", "rm -rf .", "rm -rf *", "cd x && rm -r -f /", "dd if=/dev/zero of=/dev/sda", "shutdown -s"]) {
    assert.ok(ids(c).some((i) => i.startsWith("deny:")), c);
  }
});

test("deny: 비밀 저장소 접근", () => {
  for (const c of [
    "cat agent/secrets.json", "node installer/secrets.mjs get db/app --agent agent",
    "\"$OXY_NODE\" installer/connections.mjs usql-config /tmp/x.yaml", "type %USERPROFILE%\\x\\mcp-auth.json",
  ]) {
    assert.ok(ids(c).includes("deny:secret-access"), c);
  }
  assert.deepEqual(ids("usql appdb -w -c 'select 1'"), []);
});

test("deny: 폐쇄망 패키지 설치", () => {
  for (const c of ["npm install", "npm i lodash", "pnpm add x", "pip install requests", "python -m pip install x", "uv add httpx", "go get x", "cd app && yarn add y"]) {
    assert.deepEqual(ids(c), ["deny:offline-install"], c);
  }
});

test("ask: 재귀 삭제 / git / glab / sql 변경", () => {
  assert.deepEqual(ids("rm -rf build"), ["ask:rm-recursive"]);
  assert.deepEqual(ids("git push origin main"), ["ask:git-history"]);
  assert.deepEqual(ids("git reset --hard HEAD~1"), ["ask:git-history"]);
  assert.deepEqual(ids("glab mr merge 12"), ["ask:glab-write"]);
  assert.deepEqual(ids("glab api projects/1 -X DELETE"), ["ask:glab-write"]);
  // glab api 는 -F/-f(필드)를 주면 -X 없이도 POST 가 된다
  assert.deepEqual(ids("glab api projects/1/issues -F title=x"), ["ask:glab-write"]);
  assert.deepEqual(ids("glab api projects/1/issues --raw-field title=x"), ["ask:glab-write"]);
  assert.deepEqual(ids("glab api --method=PUT projects/1"), ["ask:glab-write"]);
  assert.deepEqual(ids(`sql -S u/p@db <<'EOF'\nupdate emp set sal = 1;\ncommit;\nEOF`), ["ask:sql-write"]);
  assert.deepEqual(ids(`echo "delete from t;" | sql -S u/p@db`), ["ask:sql-write"]);
  // usql
  assert.deepEqual(ids(`usql appdb -w -c "update users set name = 'x' where id = 1"`), ["ask:sql-write"]);
  assert.deepEqual(ids(`usql appdb -w -c "drop table users"`), ["ask:sql-write"]);
  // gh
  assert.deepEqual(ids("gh pr merge 12 --squash"), ["ask:gh-write"]);
  assert.deepEqual(ids("gh pr create --title x --body-file pr.md"), ["ask:gh-write"]);
  assert.deepEqual(ids("gh api repos/o/r/issues -f title=x"), ["ask:gh-write"]);
  assert.deepEqual(ids("gh api -X DELETE repos/o/r"), ["ask:gh-write"]);
  assert.deepEqual(ids("gh workflow run deploy.yml"), ["ask:gh-write"]);
});

test("허용: 일반 개발 명령", () => {
  for (const c of [
    "ls -la", "rm file.txt", "rm -f a.log", "git status", "git push --help | head", "git commit -m 'update x set'",
    "glab mr list", "glab mr view 3", "glab api projects/1/merge_requests --paginate", "glab mr list -F json", "npm test", "npm run build", "pip list", "fd -e ts | xargs rg foo",
    `sql -S u/p@db <<'EOF'\nselect * from emp where name like 'update%';\nEOF`,
    "echo 'npm install'", "rg 'rm -rf /' src",
    `usql appdb -w -q --csv -c "select * from users where note like 'update%' limit 50"`, "usql appdb -c '\\d users'",
    "gh pr list --json number,title", "gh pr view 3 --comments", "gh run view 99 --log-failed", "gh api repos/o/r/pulls --jq '.[].title'",
    "obscura fetch http://intranet/ --dump text",
  ]) {
    assert.deepEqual(ids(c), [], c);
  }
});

test("pathKey: Git Bash 경로 / 상대경로 / 대소문자", { skip: process.platform !== "win32" }, () => {
  const cwd = "C:\\Work\\Proj";
  assert.equal(pathKey("/c/Work/Proj/a.ts", cwd), pathKey("a.ts", cwd));
  assert.equal(pathKey("C:/WORK/proj/A.ts", cwd), pathKey("@a.ts", cwd));
  assert.equal(pathKey("./src/../a.ts", cwd), "c:\\work\\proj\\a.ts");
});

test("harnessHome: Git Bash 경로(OXY_HOME=/c/…)도 Node 경로로 (MSYS_NO_PATHCONV=1 이면 변환되지 않음)", { skip: process.platform !== "win32" }, async () => {
  const { harnessHome } = await import("../agent/extensions/_lib/common.ts");
  const prev = process.env.OXY_HOME;
  try {
    process.env.OXY_HOME = "/c/Users/me/oxygen-pi";
    assert.equal(harnessHome(), "C:/Users/me/oxygen-pi");
    process.env.OXY_HOME = "/cygdrive/d/x";
    assert.equal(harnessHome(), "D:/x");
    process.env.OXY_HOME = "C:/Users/me/oxygen-pi";
    assert.equal(harnessHome(), "C:/Users/me/oxygen-pi");
    delete process.env.OXY_HOME;
    assert.equal(harnessHome("fb"), "fb");
  } finally { if (prev === undefined) delete process.env.OXY_HOME; else process.env.OXY_HOME = prev; }
});

test("clip: 앞/뒤 보존 + 안내", () => {
  const s = "H".repeat(100) + "M".repeat(1000) + "T".repeat(100);
  const out = clip(s, 200, "narrow it");
  assert.ok(out.startsWith("H".repeat(100)) && out.endsWith("T".repeat(80)));
  assert.match(out, /1000 characters omitted.*narrow it/);
  assert.equal(clip("short", 200, "x"), "short");
});

test("prompt-trim: pi 문서 안내를 한 문단으로 (경로는 pi 프롬프트에서 읽음)", () => {
  const base = [
    "<docs>",
    "Pi documentation (read only when the user asks about the harness itself):",
    String.raw`- Main documentation: C:\oxy\vendor\pi\README.md`,
    String.raw`- Additional docs: C:\oxy\vendor\pi\docs`,
    String.raw`- Examples: C:\oxy\vendor\pi\examples (extensions, custom tools, SDK)`,
    "- Before implementing harness changes, read the relevant docs and examples in full.",
    "</docs>",
  ].join("\n");
  const out = docsPointer(base)!;
  assert.ok(out.includes("C:/oxy/vendor/pi/docs/<topic>.md"), out);
  assert.ok(out.includes("examples: C:/oxy/vendor/pi/examples."), out);
  assert.ok(out.includes("prompt-templates"), out);
  assert.ok(!out.includes("\\") && !out.includes("in full") && out.length < 500, out);
  // 문서 위치를 찾지 못하면(사용자 지정 프롬프트 등) 손대지 않는다
  assert.equal(docsPointer("You are a custom agent."), undefined);
});

test("skill 자동 활성화: 설치된 구성요소의 skill 만", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, cpSync, readdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { syncSkills, CATALOG } = await import("../installer/components.mjs");
  const root = mkdtempSync(join(tmpdir(), "oxy-skill-"));
  cpSync("agent/skill-library", join(root, "agent", "skill-library"), { recursive: true });
  const touch = (rel: string) => { mkdirSync(join(root, rel, ".."), { recursive: true }); writeFileSync(join(root, rel), ""); };
  // 필수만 반입한 번들
  for (const n of ["node", "pi", "fd", "rg", "jq"]) touch((CATALOG as any)[n].check);
  assert.deepEqual(syncSkills(root, join(root, "agent")), ["find-code", "json-querying"]);
  // usql + agent-browser 추가, 브라우저는 사용 안 함
  for (const n of ["usql", "agent-browser"]) touch((CATALOG as any)[n].check);
  mkdirSync(join(root, "agent", "skills", "my-custom"), { recursive: true });
  assert.deepEqual(syncSkills(root, join(root, "agent"), { browser: "none" }), ["find-code", "json-querying", "sql-querying"]);
  assert.ok(readdirSync(join(root, "agent", "skills")).includes("my-custom"), "사용자 skill 은 유지");
});

test("skill 끄기 (OXY_SKILLS_OFF): 끈 skill 은 지우고, 구성요소를 나중에 설치해도 꺼진 채 남는다 · CLI --off", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, cpSync, existsSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { execFileSync } = await import("node:child_process");
  const { syncSkills, parseSkillsOff, CATALOG } = await import("../installer/components.mjs");
  const root = mkdtempSync(join(tmpdir(), "oxy-skill-off-"));
  try {
    cpSync("agent/skill-library", join(root, "agent", "skill-library"), { recursive: true });
    const touch = (rel: string) => { mkdirSync(join(root, rel, ".."), { recursive: true }); writeFileSync(join(root, rel), ""); };
    for (const n of ["node", "pi", "fd", "rg", "jq", "just"]) touch((CATALOG as any)[n].check);
    const agent = join(root, "agent");
    assert.deepEqual(parseSkillsOff(" json-querying, ,psmux-x "), ["json-querying", "psmux-x"]);
    assert.deepEqual(syncSkills(root, agent), ["find-code", "json-querying", "project-task-running"]);
    // 켜져 있던 것을 끄면 agent/skills 에서 지운다
    assert.deepEqual(syncSkills(root, agent, { off: "json-querying,terminal-session-control" }), ["find-code", "project-task-running"]);
    assert.ok(!existsSync(join(agent, "skills", "json-querying")));
    // 끈 skill 의 구성요소(psmux)를 나중에 설치해도 꺼진 채
    touch((CATALOG as any).psmux.check);
    assert.deepEqual(syncSkills(root, agent, { off: ["json-querying", "terminal-session-control"] }), ["find-code", "project-task-running"]);
    // configure.sh 가 쓰는 CLI 경로도 --off 를 따른다
    const out = execFileSync(process.execPath, ["installer/components.mjs", "sync-skills", "--root", root, "--agent", agent, "--browser", "", "--off", "project-task-running"], { encoding: "utf8" });
    assert.equal(out.trim(), "find-code json-querying terminal-session-control");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("oxy-jobs: Semaphore 동시 실행 제한 · vLLM metrics 해석", async () => {
  const { Semaphore, parseVllmMetrics, fmtDuration } = await import("../agent/extensions/oxy-jobs/manager.ts");
  const s = new Semaphore(2);
  const order: string[] = [];
  const work = async (n: string, ms: number) => { const rel = await s.acquire(); order.push(`+${n}`); await new Promise((r) => setTimeout(r, ms)); order.push(`-${n}`); rel(); };
  await Promise.all([work("a", 30), work("b", 30), work("c", 5)]);
  assert.deepEqual(order.slice(0, 2).sort(), ["+a", "+b"]);          // c 는 앞의 둘 중 하나가 끝난 뒤에 시작
  assert.ok(order.indexOf("+c") > Math.min(order.indexOf("-a"), order.indexOf("-b")));
  assert.equal(s.running, 0);
  const m = parseVllmMetrics('# HELP\nvllm:num_requests_waiting{model_name="a"} 2\nvllm:num_requests_waiting{model_name="b"} 1\nvllm:num_requests_running{model_name="a"} 4\nvllm:gpu_cache_usage_perc{model_name="a"} 0.93\n');
  assert.deepEqual(m, { waiting: 3, running: 4, kvCache: 0.93 });
  assert.deepEqual(parseVllmMetrics("other_metric 1\n"), { waiting: 0, running: 0, kvCache: null });
  assert.equal(fmtDuration(72000), "1m12s");
});

test("oxy-jobs 상태 파일: 실행 폴더 · 스냅샷 · 묶어 쓰기 · 종료 표시 (monitor-spec §3)", async () => {
  const { JobManager } = await import("../agent/extensions/oxy-jobs/manager.ts");
  const { StateWriter, readState, findRun, parseRunDirName } = await import("../agent/extensions/oxy-jobs/state.ts");
  const { mkdtempSync, existsSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, basename } = await import("node:path");
  const jobsDir = mkdtempSync(join(tmpdir(), "oxy-jobs-"));
  try {
    const mgr = new JobManager(jobsDir, { maxBash: 4, maxAgents: 2 });
    assert.deepEqual(parseRunDirName(basename(mgr.runDir)), { pid: process.pid, startedAt: mgr.startedAt });
    const job = mgr.create("bash", "npm test", true, { task: "npm test --all" });
    const w = mgr.writer(job);
    w.line("$ npm test");
    w.chunk("ok 1\nok 2\n\n");
    w.close();
    assert.equal(job.logFile, join(mgr.runDir, "logs", "job-1.log"));
    const agent = mgr.create("agent", "scout: look", false, { agent: "scout", task: "look at x" });
    agent.result = "y".repeat(2500);

    let writes = 0;
    const sw = new StateWriter(mgr.runDir, () => { writes++; return mgr.snapshot("C:\\work\\p", null); }, { minGapMs: 80, heartbeatMs: 0 });
    assert.equal(writes, 1);                                       // 만들 때 바로 한 번
    const s = readState(mgr.runDir)!;
    assert.equal(s.version, 1);
    assert.equal(s.pid, process.pid);
    assert.equal(s.closed, false);
    assert.equal(s.cwd, "C:/work/p");
    assert.deepEqual(s.slots.agents, { running: 0, limit: 2, waiting: 0 });
    const [j1, j2] = s.jobs;
    assert.equal(j1.log, "logs/job-1.log");
    assert.equal(j1.last, "ok 2");                                  // 빈 줄은 건너뛴다
    assert.equal(j1.task, "npm test --all");
    assert.equal(j1.agent, undefined);
    assert.equal(j2.agent, "scout");
    assert.ok(j2.result!.length < 2100 && j2.result!.endsWith(" …")); // 답변 앞부분만
    const logText = async () => {                                  // 로그는 스트림으로 비동기 기록된다
      const t0 = Date.now();
      while (Date.now() - t0 < 3000) {
        try { const t = readFileSync(join(mgr.runDir, j1.log), "utf8"); if (t.includes("ok 2")) return t; } catch { /* 아직 */ }
        await new Promise((r) => setTimeout(r, 20));
      }
      return "";
    };
    assert.ok((await logText()).includes("$ npm test"));

    for (let i = 0; i < 10; i++) sw.changed();                     // 여러 번 바뀌어도 한 번으로 묶는다
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(writes, 2);
    sw.close();
    assert.equal(readState(mgr.runDir)!.closed, true);
    sw.changed(); sw.flush();                                      // 닫은 뒤에는 쓰지 않는다
    assert.equal(readState(mgr.runDir)!.closed, true);
    assert.equal(findRun(jobsDir, process.pid), mgr.runDir);
    assert.equal(findRun(jobsDir, process.pid + 1), null);
    assert.ok(!existsSync(join(mgr.runDir, "state.json.tmp")));
  } finally { rmSync(jobsDir, { recursive: true, force: true }); }
});

test("oxy-jobs 중지: Git Bash 작업의 손자 프로세스까지 끝나고 출력이 닫힌다", { skip: process.platform !== "win32" || !existsSyncTop("C:/Program Files/Git/bin/bash.exe") }, async () => {
  const { bashJobScript, bashKiller } = await import("../agent/extensions/oxy-jobs/manager.ts");
  const { spawn } = await import("node:child_process");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "oxy-kill-"));
  const sh = "C:/Program Files/Git/bin/bash.exe";
  const pidFile = join(dir, "job.pid");
  try {
    // taskkill /T 만으로는 sleep 이 남아 30초 뒤에야 close 가 왔다 (MSYS fork/exec 로 Windows 부모가 끊김)
    const proc = spawn(sh, ["-c", bashJobScript("echo started; sleep 30 & sleep 31; echo never", pidFile)], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    proc.stdout.on("data", (d) => { out += d; });
    const closed = new Promise<number>((ok) => proc.on("close", () => ok(Date.now())));
    const t0 = Date.now();
    while (!out.includes("started") && Date.now() - t0 < 10000) await new Promise((r) => setTimeout(r, 50));
    const killedAt = Date.now();
    bashKiller(sh, proc, pidFile)();
    const at = await Promise.race([closed, new Promise<number>((ok) => setTimeout(() => ok(-1), 10000))]);
    assert.ok(at > 0 && at - killedAt < 5000, `close 가 늦음: ${at < 0 ? "10초 넘게 안 옴" : `${at - killedAt}ms`}`);
    assert.ok(!out.includes("never"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("oxy-jobs subagent: 자식 pi 가 부모의 provider · 모델 · thinking 을 따른다 (agent 정의 값 우선)", async () => {
  const { childArgs } = await import("../agent/extensions/oxy-jobs/subagent.ts");
  const base = { name: "scout", description: "", tools: ["read", "grep"], prompt: "" };
  const parent = { provider: "anthropic", id: "claude-haiku-5-5", thinking: "low" };
  const a = childArgs("cli.js", base, "find x", parent, "p.md");
  assert.deepEqual(a, ["cli.js", "--mode", "json", "-p", "--no-session", "--provider", "anthropic", "--model", "claude-haiku-5-5",
    "--thinking", "low", "--tools", "read,grep", "--append-system-prompt", "p.md", "Task: find x"]);
  // id 에 / 가 들어간 모델도 provider 와 나눠 넘긴다
  const q = childArgs("cli.js", base, "t", { provider: "oxy-vllm", id: "qwen/qwen3.8-27b", thinking: "off" });
  assert.deepEqual(q.slice(5, 11), ["--provider", "oxy-vllm", "--model", "qwen/qwen3.8-27b", "--thinking", "off"]);
  // agent 정의의 값이 우선: model 만 → 부모 provider 의 그 모델 / provider 만 다르면 → 그 provider 의 기본 모델 / thinking
  assert.deepEqual(childArgs("cli.js", { ...base, model: "qwen3.6-coder-30b" }, "t", { provider: "oxy-vllm", id: "qwen3.8-27b" }).slice(5, 9),
    ["--provider", "oxy-vllm", "--model", "qwen3.6-coder-30b"]);
  const other = childArgs("cli.js", { ...base, provider: "oxy-vllm", thinking: "off" }, "t", parent);
  assert.equal(other.includes("--model"), false);
  assert.deepEqual(other.slice(5, 7), ["--thinking", "off"]);
  // 부모 모델을 모르면 settings 기본값 (인자 없음)
  assert.deepEqual(childArgs("cli.js", { ...base, tools: [] }, "t", {}), ["cli.js", "--mode", "json", "-p", "--no-session", "Task: t"]);
});

test("oxy-jobs subagent: 작업 수준이 agent 정의 · 부모보다 우선", async () => {
  const { argsFor } = await import("../agent/extensions/oxy-jobs/subagent.ts");
  const agent = { name: "scout", description: "", tools: [], prompt: "", provider: "oxy-vllm", model: "qwen3.6-coder-30b", thinking: "off" };
  const target = { level: "deep", connection: "claude", provider: "oxy-claude", id: "claude-haiku-5-5", thinking: "high" };
  assert.deepEqual(argsFor("cli.js", agent, "t", { target, parent: { provider: "oxy-x", id: "y" } }).slice(5, 11),
    ["--provider", "oxy-claude", "--model", "claude-haiku-5-5", "--thinking", "high"]);
  assert.deepEqual(argsFor("cli.js", agent, "t", { target: null, parent: { provider: "oxy-x", id: "y", thinking: "low" } }).slice(5, 11),
    ["--provider", "oxy-vllm", "--model", "qwen3.6-coder-30b", "--thinking", "off"]);
});

test("oxy-monitor pane: 오른쪽 30% 열 · 호출 순서대로 위→아래 · 같은 높이 · 켜고 끄기 · 스스로 끝나도 다시 맞춤 (monitor-spec §1)",
  { skip: !existsSyncTop(join(import.meta.dirname, "..", "bin", "psmux.exe")) }, async () => {
  const { PaneManager, psmuxRunner, monitorCommand } = await import("../agent/extensions/oxy-monitor/pane.ts");
  const run = psmuxRunner(join(import.meta.dirname, "..", "bin", "psmux.exe"), ["-L", `oxytest-${process.pid}`]);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  try {
    run(["new-session", "-d", "-s", "t", "-x", "120", "-y", "30", "sleep 120"]);
    await sleep(1500);
    const pi = run(["list-panes", "-t", "t", "-F", "#{pane_id}"]).stdout.trim();
    const mgr = new PaneManager(run, pi);
    const geo = () => Object.fromEntries(run(["list-panes", "-t", pi, "-F", "#{pane_id} #{pane_left} #{pane_top} #{pane_width} #{pane_height}"]).stdout
      .trim().split(/\r?\n/).map((l) => { const [id, x, y, w, h] = l.split(" "); return [id, { x: +x, y: +y, w: +w, h: +h }]; }));
    const j = mgr.open("jobs", "sleep 120");
    await sleep(300);
    let g = geo();
    assert.ok(g[j].x > 0 && g[j].w >= 33 && g[j].w <= 38, `오른쪽 30% 열: ${JSON.stringify(g)}`);
    assert.equal(g[pi].x, 0);
    const f = mgr.open("flow", "sleep 120");
    await sleep(300);
    g = geo();
    assert.ok(g[j].y < g[f].y && g[j].x === g[f].x, `호출 순서대로 위→아래: ${JSON.stringify(g)}`);
    assert.ok(Math.abs(g[j].h - g[f].h) <= 1, `같은 높이: ${g[j].h} / ${g[f].h}`);
    assert.equal(mgr.open("jobs", "sleep 120"), j);                         // 종류마다 하나
    assert.deepEqual(mgr.list().map((p) => p.kind), ["jobs", "flow"]);
    assert.equal(mgr.toggle("jobs", "sleep 120"), "closed");                // 다시 누르면 닫힌다
    await sleep(300);
    g = geo();
    assert.ok(!g[j] && g[f].h >= 29, `닫으면 남은 모니터가 열을 채운다: ${JSON.stringify(g)}`);
    const s = mgr.open("short", "sleep 1");                                  // 스스로 끝나는 모니터
    await sleep(300);
    assert.ok(Math.abs(geo()[s].h - geo()[f].h) <= 1);
    await sleep(2500);
    g = geo();
    assert.ok(!g[s] && g[f].h >= 29, `스스로 끝나도 hook 이 다시 맞춘다: ${JSON.stringify(g)}`);
    assert.equal(mgr.closeAll(), 1);
    await sleep(300);
    assert.equal(geo()[pi].w, 120);                                          // 모두 닫으면 pi 가 전체 폭
  } finally { run(["kill-server"]); }
  // pane 의 셸(Git Bash)이 해석하는 명령: exec 로 시작하고 경로는 / · 작은따옴표
  assert.equal(monitorCommand("C:\\a b\\node.exe", "C:\\x\\monitor.ts", "jobs", 42, "C:\\it's", { agent: "D:\\ag", root: "D:/h" }),
    "exec 'C:/a b/node.exe' --disable-warning=ExperimentalWarning 'C:/x/monitor.ts' jobs --pi-pid 42 --cwd 'C:/it'\\''s' --agent 'D:/ag' --root 'D:/h'");
});

test("oxy-monitor 화면: jobs · flow 가 좁은 폭(23칸)에서도 폭 · 줄 수를 지킨다 (monitor-spec §5)", async () => {
  const { pathToFileURL } = await import("node:url");
  const t: any = await import(pathToFileURL(join(import.meta.dirname, "..", "vendor", "pi", "node_modules", "@earendil-works", "pi-tui", "dist", "index.js")).href);
  const { jobsView, flowView, flowKeys } = await import("../agent/extensions/oxy-monitor/view.ts");
  const fit = { width: (s: string) => t.visibleWidth(s), trunc: (s: string, w: number) => (t.visibleWidth(s) <= w ? s : t.truncateToWidth(s, w, "…")),
    wrap: (s: string, w: number) => (s ? t.wrapTextWithAnsi(s, Math.max(1, w)) : [""]) };
  const plain = (ls: string[]) => ls.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
  const check = (ls: string[], w: number, h: number) => {
    assert.equal(ls.length, h);
    for (const l of ls) assert.ok(t.visibleWidth(l) <= w, `폭 ${t.visibleWidth(l)} > ${w}: ${JSON.stringify(l)}`);
  };
  const now = 1_000_000;
  const job = (id: string, state: string, extra: any = {}) => ({ id, kind: "bash", state, label: `npm run 테스트 전체 ${id}`, createdAt: now - 90_000, startedAt: now - 72_000,
    endedAt: state === "running" ? null : now - 10_000, exitCode: null, usage: null, log: `logs/${id}.log`, last: "통과 12 · 실패 0", result: null, ...extra });
  const state: any = { version: 1, pid: 1, startedAt: 0, updatedAt: now, closed: false, cwd: "C:/w", slots: { agents: { running: 1, limit: 2, waiting: 0 }, bash: { running: 1, limit: 4, waiting: 0 } },
    control: null, jobs: [job("job-1", "done"), job("job-2", "running", { kind: "agent", label: "scout: 결제 흐름 찾기", target: { level: "deep", model: "claude-haiku-5-5", thinking: "high" } })] };
  for (const w of [23, 30, 60]) {
    const ls = jobsView(fit, state, { sel: 0, mode: "list", scroll: 0 }, w, 14, now);
    check(ls, w, 14);
    const p = plain(ls);
    assert.match(p[0], /^jobs/);
    assert.match(p[1], /⏳.*scout: 결제|⏳.*결제/);                     // 실행 중인 작업이 위로
    assert.match(p[1], /1m12s$/);
    assert.ok(p.some((l) => /deep · claude-haiku-5-5 · high/.test(l) || /deep · claude-haiku/.test(l)), "작업 수준이 보인다");
    check(jobsView(fit, state, { sel: 0, mode: "confirm", scroll: 0 }, w, 14, now), w, 14);
    const log = jobsView(fit, state, { sel: 0, mode: "log", scroll: 0 }, w, 14, now, ["$ npm test", "\x1b[32mok\x1b[0m 아주 긴 출력 줄 ".repeat(5), "[exit 0]"]);
    check(log, w, 14);
    assert.match(plain(log).join("\n"), /\[exit 0\]/);                      // 로그 끝을 따라간다
  }
  assert.ok(plain(jobsView(fit, state, { sel: 0, mode: "confirm", scroll: 0 }, 40, 14, now)).some((l) => l.includes("job-2 작업을 중지할까요?")));
  check(jobsView(fit, null, { sel: 0, mode: "list", scroll: 0 }, 23, 10, now), 23, 10);   // 상태 파일이 아직 없음

  const flow: any = {
    goal: "결제 모듈을 리팩터링하고 테스트를 보강한다", plan: [
      { id: "p1", text: "기존 구조 파악", status: "done", at: 0, nodes: ["n1"], children: [{ id: "p1.1", text: "결제 흐름 읽기", status: "done", at: 0, nodes: [], children: [] }] },
      { id: "p2", text: "PaymentService 분리", status: "doing", at: 0, nodes: [], children: [
        { id: "p2.1", text: "인터페이스 정의", status: "done", at: 0, nodes: ["n2"], children: [] },
        { id: "p2.2", text: "구현 옮기기", status: "doing", at: 0, nodes: [], children: [] }] },
      { id: "p3", text: "통합 테스트", status: "todo", at: 0, nodes: [], children: [] }],
    nodes: [{ id: "n1", commit: "a".repeat(40), title: "docs: 구조 메모", decisions: [], files: ["a.md"] },
      { id: "n2", commit: "b".repeat(40), title: "refactor: PaymentService 인터페이스", decisions: [{ text: "인터페이스를 분리", why: "테스트 쉬움" }], files: ["p.ts"] },
      { id: "n3", commit: "c".repeat(40), title: "chore: 사람이 한 커밋", decisions: [], files: [], external: true }],
    buffer: { decisions: [{ text: "캐시는 나중에" }], files: ["x.ts", "y.ts"], failures: [{ command: "npm test" }] },
  };
  for (const w of [23, 30, 60]) check(flowView(fit, flow, { sel: 0, open: new Set() }, w, 20), w, 20);
  const p = plain(flowView(fit, flow, { sel: 0, open: new Set() }, 60, 24)).join("\n");
  assert.match(p, /flow\s+할 일 2\/4/);
  assert.match(p, /✓ 기존 구조 파악 1\/1/);
  assert.ok(!p.includes("결제 흐름 읽기"), "끝난 항목은 접혀 있다");
  assert.match(p, /⏳ PaymentService 분리 1\/2\n\s+✓ 인터페이스 정의\n\s+n2 bbbbbbbb refactor/);
  assert.match(p, /계획 밖 커밋\nn3 cccccccc chore: 사람이 한 커밋/);
  assert.match(p, /커밋 전 작업\n· 캐시는 나중에\n변경 파일 2개\n✗ npm test/);
  // Enter 로 펼치기: 끝난 항목은 펼치고, 커밋은 결정 · 파일을 보인다
  const keys = flowKeys(flow, new Set());
  assert.deepEqual(keys.slice(0, 4), ["p:p1", "p:p2", "p:p2.1", "n:n2"]);
  const opened = plain(flowView(fit, flow, { sel: 0, open: new Set(["p:p1", "n:n2"]) }, 60, 30)).join("\n");
  assert.match(opened, /결제 흐름 읽기/);
  assert.match(opened, /· 인터페이스를 분리 \(테스트 쉬움\)/);
  check(flowView(fit, null, { sel: 0, open: new Set() }, 23, 8), 23, 8);
});

test("oxy-monitor 하단 바: 보일 항목 · 한 줄 · 클릭 범위 (monitor-spec §2)", async () => {
  const { barItems, barLine, itemAt } = await import("../agent/extensions/oxy-monitor/bar.ts");
  const none = new Set<string>();
  assert.deepEqual(barItems({ active: 0, recent: 0 }, { hasContent: false, done: 0, total: 0, node: "" }, none), []);   // 보일 것이 없으면 바도 없다
  const items = barItems({ active: 2, recent: 1 }, { hasContent: true, done: 3, total: 7, node: "n4" }, new Set(["flow"]));
  assert.deepEqual(items.map((i) => [i.label, i.open]), [["jobs 2 실행 중 · 1 완료", false], ["flow 3/7", true]]);
  assert.equal(barItems(null, { hasContent: true, done: 0, total: 0, node: "n4" }, none)[0].label, "flow n4");   // 계획이 없으면 마지막 단계
  assert.equal(barItems({ active: 0, recent: 0 }, null, new Set(["jobs"]))[0].label, "jobs");                     // 열린 모니터는 닫을 수 있게 보인다
  const w = (s: string) => [...s].reduce((n, ch) => n + (/[가-힣]/.test(ch) ? 2 : 1), 0);
  const st = { width: w, item: (s: string, o: boolean) => (o ? `<${s}>` : s), focus: (s: string) => `[${s}]`, hint: (s: string) => `{${s}}` };
  const r = barLine(items, -1, 80, st);
  assert.equal(r.line, "▸ jobs 2 실행 중 · 1 완료   <▸ flow 3/7>");
  assert.deepEqual(r.ranges, [{ kind: "jobs", start: 0, end: 25 }, { kind: "flow", start: 28, end: 38 }]);
  assert.equal(itemAt(r.ranges, 5), "jobs");
  assert.equal(itemAt(r.ranges, 26), undefined);                        // 항목 사이
  assert.equal(itemAt(r.ranges, 30), "flow");
  const f = barLine(items, 1, 80, st);
  assert.match(f.line, /\[▸ flow 3\/7\]    \{←→ 이동  Enter 열기·닫기  ↑ 입력창\}$/);   // 바에 들어오면 키 안내
  assert.equal(barLine(items, 0, 30, st).ranges.length, 1);             // 좁으면 들어가는 항목까지만
});

test("oxy-jobs 중지: ps -W 에서 트리 안 MSYS 프로세스의 그룹 찾기", async () => {
  const { msysGroupsOf } = await import("../agent/extensions/oxy-jobs/manager.ts");
  const ps = [
    "      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND",
    "  4194308       0       0          4  ?              0   Nov 11 System",
    "    20889       1   20889      28124  ?         197609 13:48:17 /usr/bin/bash",
    "    20891   20889   20889      27980  ?         197609 13:48:17 /usr/bin/sleep",
    "I   30001       1   30001      11111  ?         197609 13:48:17 /usr/bin/bash",
    "    40000       1   40000      22222  ?         197609 13:48:17 /usr/bin/bash",
  ].join("\n");
  assert.deepEqual(msysGroupsOf(ps, new Set([28124, 11111, 4, 99])), ["20889", "30001"]);   // 트리 밖(22222)과 Windows 프로세스(PGID 0)는 빼고, 상태 글자가 붙은 줄도 읽는다
});

test("oxy-jobs 중지 요청: 모니터 sendControl → pi ControlInbox → 결과 · 정리 규칙", async () => {
  const { ControlInbox, sendControl, findRun, pruneRuns, runDirName } = await import("../agent/extensions/oxy-jobs/state.ts");
  const { mkdtempSync, mkdirSync, readdirSync, writeFileSync, rmSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const jobsDir = mkdtempSync(join(tmpdir(), "oxy-ctl-"));
  try {
    const runDir = join(jobsDir, runDirName(process.pid, 1000));
    const handled: string[] = [];
    const results: any[] = [];
    const inbox = new ControlInbox(runDir,
      (req) => { handled.push(req.id); return req.id === "job-1" ? { ok: true, message: "Stopped job-1." } : { ok: false, message: "unknown" }; },
      (r) => results.push(r), { pollMs: 50 });
    const seq = sendControl(runDir, "stop", "job-1");
    writeFileSync(join(runDir, "control", "zz-bad-op.json"), JSON.stringify({ op: "rm", id: "job-1" }));
    sendControl(runDir, "stop", "job-9");
    const t0 = Date.now();
    while (results.length < 3 && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 30));
    inbox.close();
    assert.deepEqual(handled, ["job-1", "job-9"]);                  // 알 수 없는 op 는 handle 까지 가지 않는다
    const first = results.find((r) => r.seq === seq);
    assert.equal(first.ok, true);
    assert.equal(first.message, "Stopped job-1.");
    assert.equal(results.find((r) => r.seq === "zz-bad-op").ok, false);
    assert.equal(readdirSync(join(runDir, "control")).length, 0);   // 처리한 요청 파일은 지운다

    // 정리: 끝난 실행은 최근 20개만, 살아 있는 pi(부모 프로세스)의 폴더와 except 는 남긴다
    const dead = 999999;
    for (let i = 0; i < 25; i++) mkdirSync(join(jobsDir, runDirName(dead, 2000 + i)));
    const live = join(jobsDir, runDirName(process.ppid, 1));
    mkdirSync(live);
    mkdirSync(join(jobsDir, "not-a-run"));
    pruneRuns(jobsDir, 20, [runDir]);
    const left = readdirSync(jobsDir);
    assert.equal(left.filter((n) => n.startsWith(`run-${dead}-`)).length, 20);
    assert.ok(!left.includes(runDirName(dead, 2000)) && left.includes(runDirName(dead, 2024)));   // 오래된 것부터 지운다
    assert.ok(existsSync(live) && existsSync(runDir) && left.includes("not-a-run"));
    assert.equal(findRun(jobsDir, dead), join(jobsDir, runDirName(dead, 2024)));
  } finally { rmSync(jobsDir, { recursive: true, force: true }); }
});

test("oxy-flow: 커밋 단위 노드 · 결정 기록 · pi 밖 커밋 · 락 · 렌더 상한", async () => {
  const { FileFlowEngine, renderContext, traceDecisions } = await import("../agent/extensions/oxy-flow/store.ts");
  const { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "oxyflow-"));
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir, stdio: "ignore" });
  try {
    g("init", "-q"); writeFileSync(join(dir, "a.txt"), "1"); g("add", "."); g("commit", "-qm", "base");
    const e = new FileFlowEngine(dir);
    assert.equal(e.writable, true);
    assert.equal(e.hasContent(), false);
    e.ensureGoal("Add login API");
    e.note("decision", "Use JWT", "stateless servers");
    e.recordFile("a.txt");
    e.recordCommand("npm test", false, "FAIL x\n1 failing");
    writeFileSync(join(dir, "a.txt"), "2"); g("commit", "-qam", "feat: login");
    const made = e.syncCommits(false);
    assert.equal(made.length, 1);
    assert.deepEqual(made[0].decisions.map((d) => d.text), ["Use JWT"]);   // 버퍼의 결정이 커밋 노드로 이동
    assert.equal(e.load().buffer.decisions.length, 0);
    assert.equal(e.load().buffer.failures.length, 1);                          // 해결 안 된 실패는 남는다
    e.recordCommand("npm test", true, "ok");
    assert.equal(e.load().buffer.failures.length, 0);                          // 같은 명령이 성공하면 해결
    writeFileSync(join(dir, "b.txt"), "x"); g("add", "."); g("commit", "-qm", "outside 1");
    writeFileSync(join(dir, "c.txt"), "x"); g("add", "."); g("commit", "-qm", "outside 2");
    const ext = e.syncCommits(true);
    assert.deepEqual(ext.map((n) => [n.id, n.title, n.external]), [["n2", "outside 1", true], ["n3", "outside 2", true]]);
    assert.deepEqual(ext[0].files, ["b.txt"]);
    assert.equal(e.syncCommits(true).length, 0);
    // 다른 살아 있는 프로세스가 쥔 락 → 읽기 전용 / 주인이 죽은 락 → 넘겨받음
    const lock = join(dir, ".oxy", "flow", "lock");
    writeFileSync(lock, JSON.stringify({ pid: process.ppid, at: 0 }));
    const other = new FileFlowEngine(dir);
    assert.equal(other.writable, false);
    assert.equal(other.load().nodes.length, 3);
    writeFileSync(lock, JSON.stringify({ pid: 999999, at: 0 }));
    assert.equal(new FileFlowEngine(dir).writable, true);
    assert.equal(readFileSync(join(dir, ".oxy", ".gitignore"), "utf8"), "*\n");
    assert.ok(existsSync(join(dir, ".oxy", "flow", "FLOW.md")));
    // 렌더: 상한 안에서 최근 노드는 결정까지, 나머지는 제목만
    for (let i = 0; i < 40; i++) e.load().nodes.push({ id: `n${4 + i}`, commit: "f".repeat(40), title: `step ${i} `.repeat(5), at: 0, decisions: [{ at: 0, text: "d".repeat(80) }], files: [] });
    const r = renderContext(e.load(), 3000);
    assert.ok(r.length <= 3000, `len ${r.length}`);
    assert.match(r, /Goal: Add login API/);
    assert.match(r, /Older steps: /);
    assert.deepEqual(traceDecisions(e.load(), "jwt").length, 1);
    e.release();
    assert.equal(existsSync(lock), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("oxy-flow 계획 트리: 쓰기 · 추가 · 상태 · 상위 항목 따라가기 · 다시 쓰기 (monitor-spec §4)", async () => {
  const { setPlan, addItem, updateItem, currentItem, nextStep, progress, renderPlanLines, findItem } = await import("../agent/extensions/oxy-flow/plan.ts");
  let plan = setPlan([], [
    { text: "기존 구조 파악", children: [{ text: "결제 흐름 읽기" }, { text: "테스트 현황 확인" }] },
    { text: "PaymentService 분리", children: [{ text: "인터페이스 정의" }, { text: "구현 옮기기" }] },
    { text: "통합 테스트" },
  ], 1);
  assert.deepEqual(plan.map((p) => [p.id, p.status, p.children.map((c) => c.id)]),
    [["p1", "todo", ["p1.1", "p1.2"]], ["p2", "todo", ["p2.1", "p2.2"]], ["p3", "todo", []]]);
  assert.equal(nextStep(plan), "p1.1 결제 흐름 읽기 (in p1 기존 구조 파악)");
  updateItem(plan, "p1.1", { status: "doing" }, 2);
  assert.equal(findItem(plan, "p1")!.item.status, "doing");                  // 할 일이 시작되면 항목도 진행 중
  updateItem(plan, "p1.1", { status: "done" }, 3);
  assert.equal(findItem(plan, "p1")!.item.status, "doing");                  // 일부만 끝남
  updateItem(plan, "P1.2", { status: "done" }, 4);                             // id 대소문자 무시
  assert.equal(findItem(plan, "p1")!.item.status, "done");                   // 모두 끝나면 항목도 끝
  updateItem(plan, "p2.1", { status: "doing" }, 5);
  assert.equal(currentItem(plan)!.id, "p2.1");
  assert.equal(nextStep(plan), "p2.1 인터페이스 정의 (in p2 PaymentService 분리)");
  const added = addItem(plan, "호출부 바꾸기", "p2", 6);
  assert.equal(added.id, "p2.3");
  assert.equal(addItem(plan, "문서", undefined, 7).id, "p4");
  assert.throws(() => addItem(plan, "x", "p2.1"), /2 levels: add the sub-task to p2/);
  assert.throws(() => updateItem(plan, "p9", { status: "done" }), /unknown item "p9". Items: p1, p1.1/);
  assert.throws(() => updateItem(plan, "p3", { status: "finished" }), /status must be one of/);
  assert.throws(() => setPlan(plan, []), /non-empty/);
  assert.deepEqual(progress(plan), { done: 2, total: 7 });
  // 할 일이 있는 항목을 done 으로: 끝나지 않은 할 일도 done
  updateItem(plan, "p2", { status: "done" }, 8);
  assert.deepEqual(findItem(plan, "p2")!.item.children.map((c) => c.status), ["done", "done", "done"]);
  // 다시 쓰기: 같은 글은 상태 유지, 순서·id 는 새로, 새 항목은 todo
  plan = setPlan(plan, [{ text: "PaymentService 분리", children: [{ text: "인터페이스 정의" }, { text: "새 할 일" }] }, { text: "통합 테스트" }], 9);
  assert.deepEqual(plan.map((p) => [p.id, p.status]), [["p1", "doing"], ["p2", "todo"]]);
  assert.deepEqual(plan[0].children.map((c) => [c.id, c.status]), [["p1.1", "done"], ["p1.2", "todo"]]);
  // 모델용 줄: 끝난 항목의 할 일은 접는다
  const done = setPlan([], [{ text: "A", children: [{ text: "a1" }] }, { text: "B", children: [{ text: "b1" }] }]);
  updateItem(done, "p1.1", { status: "done" });
  assert.deepEqual(renderPlanLines(done), ["- p1 [done] A (1/1 sub-tasks done)", "- p2 [todo] B", "  - p2.1 [todo] b1"]);
  const big = setPlan([], Array.from({ length: 20 }, (_, i) => ({ text: `step ${i} `.repeat(8), children: Array.from({ length: 10 }, (_, j) => ({ text: `sub ${j} `.repeat(8) })) })));
  const lines = renderPlanLines(big, { maxChars: 2000 });
  assert.ok(lines.join("\n").length <= 2000, `len ${lines.join("\n").length}`);
});

test("oxy-flow 계획 + 엔진: 저장 · 커밋이 진행 중인 할 일에 붙음 · 컨텍스트 · FLOW.md · 예전 파일", async () => {
  const { FileFlowEngine, renderContext, renderMarkdown } = await import("../agent/extensions/oxy-flow/store.ts");
  const { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "oxyplan-"));
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir, stdio: "ignore" });
  try {
    g("init", "-q"); writeFileSync(join(dir, "a.txt"), "1"); g("add", "."); g("commit", "-qm", "base");
    // 예전 형식(plan 없음) 파일도 읽힌다
    mkdirSync(join(dir, ".oxy", "flow"), { recursive: true });
    writeFileSync(join(dir, ".oxy", "flow", "flow.json"), JSON.stringify({ version: 1, id: "flow-old", goal: "old", next: "", blocked: "", status: "active", startedAt: 0, updatedAt: 0, baseCommit: null, nodes: [], buffer: {} }));
    const e = new FileFlowEngine(dir);
    assert.deepEqual(e.load().plan, []);
    assert.equal(e.hasWork(), false);
    e.setPlan([{ text: "Login API", children: [{ text: "route" }, { text: "tests" }] }]);
    assert.equal(e.hasWork(), true);                                              // 계획만 있어도 진행 기록
    e.updatePlan("p1.1", { status: "doing" });
    writeFileSync(join(dir, "a.txt"), "2"); g("commit", "-qam", "feat: route");
    const [n1] = e.syncCommits(false);
    assert.deepEqual(e.load().plan[0].children[0].nodes, [n1.id]);              // 진행 중인 할 일에 커밋 연결
    e.updatePlan("p1.1", { status: "done" });
    writeFileSync(join(dir, "a.txt"), "3"); g("commit", "-qam", "chore: between sub-tasks");
    e.syncCommits(false);
    assert.deepEqual(e.load().plan[0].children.map((c) => c.nodes), [["n1"], []]);
    assert.deepEqual(e.load().plan[0].nodes, ["n2"]);                           // 진행 중인 할 일이 없으면 진행 중인 항목에
    const again = new FileFlowEngine(dir, true);                                // 다른 프로세스(모니터)가 읽기 전용으로 읽음
    assert.equal(again.load().plan[0].children[0].status, "done");
    const ctx = renderContext(e.load(), 6000);
    assert.match(ctx, /Next: p1\.2 tests \(in p1 Login API\)/);
    assert.match(ctx, /Plan \(update it with flow_plan\):\n- p1 \[doing\] Login API \(commits n2\)\n  - p1\.1 \[done\] route \(commits n1\)\n  - p1\.2 \[todo\] tests/);
    e.updatePlan("p1", { status: "done" });
    writeFileSync(join(dir, "a.txt"), "4"); g("commit", "-qam", "docs: after plan");
    e.syncCommits(false);
    assert.equal(e.load().plan[0].nodes.includes("n3"), false);                  // 진행 중인 항목이 없으면 붙이지 않는다
    assert.match(renderContext(e.load(), 6000), /- p1 \[done\] Login API \(commits n2\) \(2\/2 sub-tasks done\)/);
    e.updatePlan("p1.2", { status: "todo" });
    const md = renderMarkdown(e.load());
    assert.match(md, /## 계획\n\n- ⏳ p1 Login API — n2\n  - ✓ p1\.1 route — n1\n  - · p1\.2 tests/);
    assert.match(readFileSync(join(dir, ".oxy", "flow", "FLOW.md"), "utf8"), /## 계획/);
    e.startNew("next task");
    assert.deepEqual(e.load().plan, []);                                          // 새 작업은 빈 계획 (이전 계획은 archive 에)
    e.release();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("code-intel: ast-grep skill · graphin 을 넣으면 MCP 등록 + skill, 빼면 해제 (다른 서버 유지)", async () => {
  const { syncSkills } = await import("../installer/components.mjs");
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "oxyci-"));
  const agent = join(root, "agent");
  try {
    cpSync(join(import.meta.dirname, "..", "agent", "skill-library"), join(agent, "skill-library"), { recursive: true });
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "bin", "ast-grep.exe"), "");
    writeFileSync(join(agent, "mcp.json"), JSON.stringify({ mcpServers: { dbhub: { command: "x" } } }));
    let skills = syncSkills(root, agent);
    assert.ok(skills.includes("structural-code-search"));
    assert.ok(!skills.includes("code-graph-search"));
    assert.equal(JSON.parse(readFileSync(join(agent, "mcp.json"), "utf8")).mcpServers.graphin, undefined);
    mkdirSync(join(root, "vendor", "graphin", "models"), { recursive: true });
    writeFileSync(join(root, "vendor", "graphin", "graphin.exe"), "");
    skills = syncSkills(root, agent);
    assert.ok(skills.includes("code-graph-search"));
    const g = JSON.parse(readFileSync(join(agent, "mcp.json"), "utf8")).mcpServers;
    assert.ok(g.dbhub, "다른 MCP 서버 유지");
    assert.deepEqual(g.graphin.args.slice(0, 3), ["--workspace", ".", "--offline"]);
    assert.ok(g.graphin.args.includes("--model-dir") && !g.graphin.args.includes("--ort-lib"));
    assert.equal(g.graphin.exposure, "direct");
    rmSync(join(root, "vendor"), { recursive: true });
    syncSkills(root, agent);
    assert.equal(JSON.parse(readFileSync(join(agent, "mcp.json"), "utf8")).mcpServers.graphin, undefined);
    assert.ok(existsSync(join(agent, "mcp.json")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("LLM 연결: 계열 프리셋 · 제외 파라미터 · 응답 최대 길이 · Claude 내장 모델 (providerConfig)", async () => {
  const { providerConfig, escapeKey } = await import("../scripts/llm-connections.mjs");
  const root = join(import.meta.dirname, "..");
  const vllm = (extra: any = {}, models?: any[]) => ({ id: "site", kind: "vllm", baseUrl: "http://x/v1", request: { retries: 0, dropParams: [] }, ...extra,
    models: models ?? [{ id: "qwen3.6-coder-30b", family: "qwen-coder", contextWindow: 131072, maxOutput: 16384 },
      { id: "qwen3.8-27b", family: "qwen-thinking", contextWindow: 131072, maxOutput: 32768 }] });
  const models = (conn: any) => {
    const list = providerConfig(root, conn, undefined).config.models;
    return { c: list[0], g: list[1] };
  };
  const cfg = providerConfig(root, vllm(), undefined).config;
  assert.equal(cfg.apiKey, "EMPTY");                                   // 키 없는 vLLM
  assert.equal(cfg.api, "openai-completions");
  assert.equal(cfg.authHeader, true);
  assert.equal(cfg.compat, undefined);                                 // registerProvider 는 provider 단위 compat 를 쓰지 않아 모델마다 넣는다
  assert.equal(cfg.models[0].compat.maxTokensField, "max_tokens");
  assert.equal(cfg.models[0].compat.supportsStore, false);
  let m = models(vllm());
  assert.equal(m.c.samplingParams.repetition_penalty, 1.05);
  assert.equal(m.c.maxTokens, 16384);
  assert.equal(m.g.compat.thinkingFormat, "qwen-chat-template");
  m = models(vllm({ request: { dropParams: ["repetition_penalty"] } }));   // 사내 게이트웨이에서 실제로 거부된 값
  assert.equal(m.c.samplingParams.repetition_penalty, undefined);
  assert.equal(m.c.samplingParams.top_k, 20);                          // 받아 주는 것은 남긴다
  assert.equal(m.g.reasoning, true);
  m = models(vllm({ request: { dropParams: ["top_k", "repetition_penalty", "chat_template_kwargs", "bogus"] } }));
  assert.deepEqual(m.c.samplingParams, { temperature: 0.7, top_p: 0.8 });
  assert.equal(m.g.reasoning, false);
  assert.equal(m.g.compat.thinkingFormat, undefined);
  assert.deepEqual(m.g.samplingParams, { temperature: 0.7, top_p: 0.8 });   // thinking 끈 상태의 샘플링
  // 모델 계열: gpt-oss 는 reasoning_effort, 거부되면 thinking 제어 없이 / 계열이 없으면 id 로 추정
  const oss = (drop: string[]) => models(vllm({ request: { dropParams: drop } }, [{ id: "openai/gpt-oss-120b", contextWindow: 131072, maxOutput: 1000 }])).c;
  assert.equal(oss([]).compat.supportsReasoningEffort, true);
  assert.equal(oss([]).thinkingLevelMap.off, "low");
  assert.equal(oss([]).maxTokens, 1000);
  assert.equal(oss(["reasoning_effort"]).reasoning, false);
  assert.equal(oss(["reasoning_effort"]).compat.supportsReasoningEffort, false);   // 종류의 기본값(false)으로
  assert.match(oss(["reasoning_effort"]).name, /thinking 제어 없음/);
  assert.equal(oss(["chat_template_kwargs"]).reasoning, true);          // 다른 방식의 거부는 영향 없음
  assert.equal(models(vllm({}, [{ id: "qwen/qwen3.8-27b", family: "qwen-coder", contextWindow: 1, maxOutput: 1 }])).c.samplingParams.repetition_penalty, 1.05);
  assert.deepEqual(models(vllm({}, [{ id: "my-llama", contextWindow: 1, maxOutput: 1 }])).c.samplingParams, { temperature: 0.7 });
  // Claude: pi 내장 카탈로그의 모델 정보에 입력한 길이를 덮어쓴다. 키의 $ · 앞의 ! 는 글자 그대로 넘어가게 이스케이프
  const claude = { id: "claude", kind: "anthropic", models: [{ id: "claude-haiku-5-5", contextWindow: 131072, maxOutput: 16384 }, { id: "no-such-model", contextWindow: 1, maxOutput: 1 }] };
  const r = providerConfig(root, claude, "sk-a$b!c");
  assert.equal(r.config.api, "anthropic-messages");
  assert.equal(r.config.baseUrl, "https://api.anthropic.com");
  assert.equal(r.config.apiKey, "sk-a$$b!c");
  assert.equal(escapeKey("!cmd"), "$!cmd");
  assert.deepEqual(r.missing, ["no-such-model"]);
  const h = r.config.models[0];
  assert.deepEqual([h.id, h.contextWindow, h.maxTokens, h.compat.forceAdaptiveThinking, h.provider, h.baseUrl], ["claude-haiku-5-5", 131072, 16384, true, undefined, undefined]);
  assert.throws(() => providerConfig(root, { ...claude, models: [] }, undefined), /API 키가 없습니다/);
});

test("LLM 연결: 예전 oxy.env 값 옮기기 · settings · 검사 · 작업 수준 · thinking 선택지", async () => {
  const L = await import("../scripts/llm-connections.mjs");
  const root = join(import.meta.dirname, "..");
  const env = { OXY_VLLM_BASE_URL: "http://vllm/v1/", OXY_VLLM_API_KEY: "sk-1", OXY_MODEL_CODER: "qwen3.6-coder-30b", OXY_MODEL_GENERAL: "qwen3.8-27b",
    OXY_DEFAULT_MODEL: "qwen3.6-coder-30b", OXY_CONTEXT_WINDOW: "65536", OXY_VLLM_DROP_PARAMS: "top_k,bogus", OXY_PROVIDER_RETRIES: "4", OXY_MAX_OUTPUT_TOKENS: "20000", OXY_LLM_MAX_CONCURRENT: "1" };
  const r = L.migrateLegacy(null, env)!;
  const v = r.llm.connections[0];
  assert.deepEqual([v.id, v.kind, v.baseUrl, v.maxConcurrent, v.request], ["vllm", "vllm", "http://vllm/v1", 1, { retries: 4, dropParams: ["top_k"] }]);
  assert.deepEqual(v.models.map((m: any) => [m.id, m.family, m.contextWindow, m.maxOutput]),
    [["qwen3.6-coder-30b", "qwen-coder", 65536, 16384], ["qwen3.8-27b", "qwen-thinking", 65536, 20000]]);   // 상한은 예전 기본값과 OXY_MAX_OUTPUT_TOKENS 중 작은 값
  assert.deepEqual(r.llm.main, { connection: "vllm", model: "qwen3.6-coder-30b", thinking: "off" });
  assert.deepEqual(r.llm.levels.map((l: any) => [l.id, l.connection, l.model, l.thinking]),
    [["light", "vllm", "qwen3.6-coder-30b", "off"], ["normal", "vllm", "qwen3.6-coder-30b", "off"], ["deep", "vllm", "qwen3.6-coder-30b", "off"]]);
  assert.deepEqual([r.key, r.keyAction], ["sk-1", "set"]);
  assert.equal(L.migrateLegacy(null, { ...env, OXY_VLLM_API_KEY: "EMPTY" })!.keyAction, "delete");
  assert.equal(L.migrateLegacy(null, { OXY_GITLAB: "x" }), null);                         // 옮길 값 없음
  // 이미 다른 연결이 기본 모델이면 그대로 두고 vllm 연결만 갱신한다
  const claude = { id: "claude", kind: "anthropic", models: [{ id: "claude-haiku-5-5", contextWindow: 131072, maxOutput: 16384 }] };
  const mixed = { version: 1, connections: [claude, v], main: { connection: "claude", model: "claude-haiku-5-5", thinking: "low" },
    levels: [{ id: "deep", label: "d", use: "u", connection: "claude", model: "claude-haiku-5-5", thinking: "high" }] };
  const r2 = L.migrateLegacy(mixed, { ...env, OXY_VLLM_BASE_URL: "http://other/v1" })!;
  assert.deepEqual(r2.llm.connections.map((c: any) => [c.id, c.baseUrl ?? null]), [["claude", null], ["vllm", "http://other/v1"]]);
  assert.equal(r2.llm.main.connection, "claude");
  assert.equal(r2.llm.levels.length, 1);
  // vllm 연결의 모델이 바뀌면, 없는 모델을 가리키던 작업 수준은 기본 모델로 되돌린다 (다른 연결의 수준은 그대로)
  const stale = { ...r.llm, levels: [...r.llm.levels.map((l: any) => ({ ...l, model: "gone-model", thinking: "high" })),
    { id: "deep2", connection: "claude", model: "claude-haiku-5-5", thinking: "high" }] };
  const r3 = L.migrateLegacy({ ...stale, connections: [...stale.connections, claude] }, env)!;
  assert.deepEqual(r3.llm.levels.map((l: any) => [l.id, l.model, l.thinking]),
    [["light", "qwen3.6-coder-30b", "off"], ["normal", "qwen3.6-coder-30b", "off"], ["deep", "qwen3.6-coder-30b", "off"], ["deep2", "claude-haiku-5-5", "high"]]);
  assert.deepEqual(L.validateLlm(r3.llm, root), []);
  // oxy.env 에서 옮긴 키만 지운다 (주석 · 다른 키 유지)
  assert.equal(L.removeEnvKeys("# c\nOXY_VLLM_BASE_URL=x\nGITLAB_HOST=g\n# OXY_MODEL_CODER=y\n", L.LEGACY_ENV_KEYS), "# c\nGITLAB_HOST=g\n# OXY_MODEL_CODER=y\n");
  // settings.json 값
  assert.deepEqual(L.settingsFromLlm(r2.llm), { enabledModels: ["oxy-claude/**", "oxy-vllm/**"], defaultProvider: "oxy-claude", defaultModel: "claude-haiku-5-5",
    defaultThinkingLevel: "low", retries: 4 });
  // 검사
  assert.deepEqual(L.validateLlm(r2.llm, root), []);
  const bad = structuredClone(r2.llm);
  bad.main = { connection: "vllm", model: "qwen3.6-coder-30b", thinking: "high" };       // Coder 계열은 thinking 없음
  bad.levels.push({ id: "x", connection: "nope", model: "m" });
  bad.connections.push({ id: "Bad Id", kind: "anthropic", models: [{ id: "claude-nope", contextWindow: 1, maxOutput: 1 }] });
  const errs = L.validateLlm(bad, root).join(" | ");
  assert.match(errs, /기본 모델: qwen3.6-coder-30b 은 thinking high 을 지원하지 않음/);
  assert.match(errs, /작업 수준 x: 연결 nope 이 없음/);
  assert.match(errs, /연결 이름이 규칙에 맞지 않음: Bad Id/);
  assert.match(errs, /claude-nope: pi 내장 모델 목록에 없음/);
  // 작업 수준 → 자식 대상
  assert.deepEqual(L.resolveLevel(r2.llm, "deep"), { level: "deep", connection: "claude", provider: "oxy-claude", id: "claude-haiku-5-5", thinking: "high" });
  assert.equal(L.resolveLevel(r2.llm, "nope"), null);
  assert.deepEqual(L.connectionUsers(r2.llm, "claude"), ["기본 모델", "작업 수준 deep"]);
  // thinking 선택지
  const conn = r.llm.connections[0];
  assert.deepEqual(L.thinkingChoices(root, conn, "qwen3.6-coder-30b"), ["off"]);
  assert.deepEqual(L.thinkingChoices(root, conn, "qwen3.8-27b"), ["off", "high"]);
  assert.deepEqual(L.thinkingChoices(root, { ...conn, request: { dropParams: ["chat_template_kwargs"] } }, "qwen3.8-27b"), ["off"]);
  assert.deepEqual(L.thinkingChoices(root, { ...conn, models: [] }, "openai/gpt-oss-120b"), ["low", "medium", "high"]);
  assert.deepEqual(L.thinkingChoices(root, claude, "claude-haiku-5-5"), ["off", "low", "medium", "high", "xhigh", "max"]);
});

test("renderConfig: oxy.env 의 예전 vLLM 값 → llm.json · 키는 DPAPI(secrets.json) · settings.json", { skip: process.platform !== "win32" }, async () => {
  const { renderConfig } = await import("../scripts/render-config.mjs");
  const { getSecrets } = await import("../installer/secrets.mjs");
  const { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "oxyrc-"));
  const root = join(import.meta.dirname, "..");
  try {
    cpSync(join(root, "agent", "templates"), join(dir, "templates"), { recursive: true });
    writeFileSync(join(dir, "oxy.env"), "# site\nOXY_VLLM_BASE_URL=http://x/v1\nOXY_VLLM_API_KEY='k$1 !x'\nOXY_MODEL_CODER=qwen3.6-coder-30b\nOXY_DEFAULT_MODEL=qwen3.6-coder-30b\nGITLAB_HOST=g\n");
    renderConfig(dir, { OXY_SHELL_PATH: "C:/bash.exe" }, { root });
    const llm = JSON.parse(readFileSync(join(dir, "llm.json"), "utf8"));
    assert.equal(llm.connections[0].baseUrl, "http://x/v1");
    assert.equal(getSecrets(dir, ["llm/vllm"])["llm/vllm"], "k$1 !x");
    assert.ok(!readFileSync(join(dir, "secrets.json"), "utf8").includes("k$1"));          // 평문이 남지 않는다
    assert.equal(readFileSync(join(dir, "oxy.env"), "utf8"), "# site\nGITLAB_HOST=g\n");
    const st = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
    assert.deepEqual([st.defaultProvider, st.defaultModel, st.defaultThinkingLevel, st.enabledModels], ["oxy-vllm", "qwen3.6-coder-30b", "off", ["oxy-vllm/**"]]);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "models.json"), "utf8")).providers, {});
    // 설치 TUI 가 키 없이 다시 쓰면(EMPTY) 저장된 키를 지운다 · 두 번째 실행은 아무것도 옮기지 않는다
    writeFileSync(join(dir, "oxy.env"), "OXY_VLLM_BASE_URL=http://y/v1\nOXY_VLLM_API_KEY=EMPTY\nOXY_MODEL_CODER=qwen3.6-coder-30b\n");
    renderConfig(dir, { OXY_SHELL_PATH: "C:/bash.exe" }, { root });
    assert.equal(getSecrets(dir, ["llm/vllm"])["llm/vllm"], undefined);
    assert.equal(JSON.parse(readFileSync(join(dir, "llm.json"), "utf8")).connections[0].baseUrl, "http://y/v1");
    renderConfig(dir, { OXY_SHELL_PATH: "C:/bash.exe" }, { root });
    assert.equal(JSON.parse(readFileSync(join(dir, "llm.json"), "utf8")).connections[0].baseUrl, "http://y/v1");
    // 잘못된 llm.json 은 원인을 알리고 실패
    const l2 = JSON.parse(readFileSync(join(dir, "llm.json"), "utf8"));
    l2.main.model = "nope";
    writeFileSync(join(dir, "llm.json"), JSON.stringify(l2));
    assert.throws(() => renderConfig(dir, { OXY_SHELL_PATH: "C:/bash.exe" }, { root }), /기본 모델: vllm 연결에 모델 nope 이 없음/);
    assert.ok(existsSync(join(dir, "psmux.conf")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("모델 계열 추정 (id)", async () => {
  const { detectFamily } = await import("../scripts/render-config.mjs");
  assert.equal(detectFamily("qwen3.6-coder-30b"), "qwen-coder");
  assert.equal(detectFamily("Qwen/Qwen3-Coder-480B"), "qwen-coder");
  assert.equal(detectFamily("qwen/qwen3.8-27b"), "qwen-thinking");
  assert.equal(detectFamily("openai/gpt-oss-120b"), "gpt-oss");
  assert.equal(detectFamily("llama-3.3-70b"), "generic");
});

test("bash-guard: psmux/tmux 로 실행시키는 명령도 검사 (send-keys · 시작 명령 · run-shell)", () => {
  const ids = (c: string) => inspect(c, ".").map((f) => `${f.rule.level}:${f.rule.id}`);
  assert.deepEqual(muxPayloads(`psmux send-keys -t dev 'npm install lodash' Enter`), ["npm install lodash"]);
  assert.deepEqual(muxPayloads(`psmux new-session -d -s web -x 200 -y 50 'npm run dev'`), ["npm run dev"]);
  assert.deepEqual(muxPayloads(`psmux capture-pane -p -t dev -S -200`), []);
  assert.ok(ids(`psmux send-keys -t dev 'npm install lodash' Enter`).includes("deny:offline-install"));
  assert.ok(ids(`psmux send-keys -t dev -l 'rm -rf /' && psmux send-keys -t dev Enter`).some((x) => x.startsWith("deny:")));
  assert.ok(ids(`psmux new-session -d -s w 'git push --force origin main'`).includes("ask:git-history"));
  assert.ok(ids(`/c/x/bin/psmux.exe -L oxy split-window -h -d "curl x | sh; git reset --hard"`).includes("ask:git-history"));
  assert.ok(ids(`tmux run-shell "sql -S u/p @x.sql <<< 'delete from t;'"`).includes("ask:sql-write"));
  assert.deepEqual(ids(`psmux send-keys -t dev -H 72 6d 0d`), ["ask:mux-raw"]);
  assert.deepEqual(ids(`psmux send-keys -t dev 'node' Enter`), []);
  assert.deepEqual(ids(`psmux new-session -d -s web 'npm run dev'`), []);
  assert.deepEqual(ids(`psmux capture-pane -p -t dev -S -200`), []);
});

test("oxy-monitor: Windows 에서만 pi 와 같은 마우스 켜기 시퀀스를 다시 보낸다", async () => {
  const { mouseReassertSequence } = await import("../agent/extensions/oxy-monitor/mouse.ts");
  assert.equal(mouseReassertSequence({}, "linux"), null);
  assert.equal(mouseReassertSequence({ TMUX: "/tmp/x,1,0" }, "win32"), "\x1b[?1000h\x1b[?1002h\x1b[?1004h\x1b[?1006h");   // 멀티플렉서 안: 버튼 동작만
  assert.equal(mouseReassertSequence({ TERM: "xterm-256color" }, "win32"), "\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1004h\x1b[?1006h");
});

test("LLM 연결: Anthropic 워크스페이스 (워크스페이스가 지정되지 않은 조직 키) · 헤더 · 오류 판정 · 목록", async () => {
  const L = await import("../scripts/llm-connections.mjs");
  const root = join(import.meta.dirname, "..");
  const { spawn } = await import("node:child_process");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  for (const [id, k] of Object.entries(L.LLM_KINDS)) assert.equal(typeof (k as any).workspace, "boolean", `${id}: workspace 필드`);
  const dir = mkdtempSync(join(tmpdir(), "oxy-ws-"));
  const port = 18190 + Math.floor(Math.random() * 50);
  const mock = spawn(process.execPath, [join(root, "tests/mock-anthropic.mjs"), String(port), join(dir, "log.jsonl")],
    { env: { ...process.env, MOCK_ANTHROPIC_WORKSPACE: "wrkspc_ok1" }, stdio: "ignore" });
  try {
    await new Promise((r) => setTimeout(r, 800));
    const conn: any = { id: "claude", kind: "anthropic", baseUrl: `http://127.0.0.1:${port}`, request: { retries: 0 },
      models: [{ id: "claude-haiku-5-5", contextWindow: 131072, maxOutput: 16384 }] };
    // 헤더 없음 → 400 unscoped
    await assert.rejects(L.listModels(conn, "k"), (e: any) => e.status === 400 && e.workspace === "unscoped");
    // 목록: 보관된 것은 빼고, Default 는 isDefault
    assert.deepEqual(await L.listWorkspaces(conn, "k"), [{ id: "wrkspc_default0", name: "Default", isDefault: true }, { id: "wrkspc_ok1", name: "oxy-test", isDefault: false }]);
    // 다른 ID → 404 not-found, 형식 오류 → invalid (검사는 llm.json 단계에서도)
    await assert.rejects(L.listModels({ ...conn, workspaceId: "wrkspc_other" }, "k"), (e: any) => e.status === 404 && e.workspace === "not-found");
    await assert.rejects(L.listModels({ ...conn, workspaceId: "bad id" }, "k"), (e: any) => e.workspace === "invalid");
    // 맞는 ID → 모델 목록 · tool call 요청 모두 헤더가 붙는다
    const ok = { ...conn, workspaceId: "wrkspc_ok1" };
    assert.equal((await L.listModels(ok, "k")).models[0].id, "claude-haiku-5-5");
    const t = await L.checkToolCall(conn, "k", "claude-haiku-5-5");
    assert.equal(t.ok, false); assert.equal(t.workspace, "unscoped");
    // pi provider 등록 설정에 헤더 (값이 없으면 headers 자체가 없다)
    assert.deepEqual(L.providerConfig(root, ok, "k").config.headers, { "anthropic-workspace-id": "wrkspc_ok1" });
    assert.equal(L.providerConfig(root, conn, "k").config.headers, undefined);
    // 검사: 형식 · 종류
    const llm = (c: any) => ({ version: 1, connections: [c], main: { connection: c.id, model: c.models[0].id, thinking: "off" }, levels: [] });
    assert.deepEqual(L.validateLlm(llm(ok), root), []);
    assert.match(L.validateLlm(llm({ ...conn, workspaceId: "ws1" }), root).join(), /워크스페이스 ID 형식/);
    assert.match(L.validateLlm(llm({ id: "site", kind: "vllm", baseUrl: "http://x/v1", workspaceId: "wrkspc_a", models: [{ id: "m", family: "generic", contextWindow: 1, maxOutput: 1 }] })).join(), /워크스페이스 ID를 쓰지 않음/);
    assert.equal(L.workspaceProblem(500, "x"), null);
  } finally { mock.kill(); rmSync(dir, { recursive: true, force: true }); }
});

test("oxy-flow: 작업 기록은 세션 단위 (새 세션은 빈 기록 · /resume 하면 되살림 · 세션 넘기기는 이어 감)", async () => {
  const { FileFlowEngine } = await import("../agent/extensions/oxy-flow/store.ts");
  const { mkdtempSync, rmSync, readdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "oxy-flow-sess-"));
  const open = (sid: string) => { const e = new FileFlowEngine(dir); const r = e.bindSession(sid); return { e, r }; };
  try {
    // 세션 A: 작업 (아래 B · A 전환은 모두 같은 초 안에 일어난다: 예전 초 단위 id 는 보관 파일이 서로를 덮어썼다)
    let { e, r } = open("A");
    assert.equal(r, "empty");
    e.ensureGoal("build the calendar app");
    e.setPlan([{ text: "screens" }, { text: "tests" }]);
    assert.deepEqual(e.load().sessions, ["A"]);
    e.release();
    // A 를 다시 열면 그대로
    ({ e, r } = open("A")); assert.equal(r, "kept"); assert.equal(e.load().goal, "build the calendar app"); e.release();
    // 새 세션 B: 이전 작업은 보관, 빈 기록 (예전: A 의 목표 · 계획이 그대로 보이고 B 의 요청이 섞였다)
    ({ e, r } = open("B"));
    assert.equal(r, "parked");
    assert.equal(e.hasContent(), false);
    assert.equal(readdirSync(join(dir, ".oxy/flow/archive")).length, 1);
    e.ensureGoal("fix the login bug");
    e.release();
    // A 를 /resume: B 의 작업을 보관하고 A 를 되살린다
    ({ e, r } = open("A"));
    assert.equal(r, "restored");
    assert.equal(e.load().goal, "build the calendar app");
    assert.equal(e.load().plan.length, 2);
    assert.equal(readdirSync(join(dir, ".oxy/flow/archive")).length, 1);   // 보관 목록에는 B 만
    // 세션 넘기기: 이어 가기 표시 → 새 세션 C 가 같은 작업을 이어 간다
    e.markContinue(); e.release();
    ({ e, r } = open("C"));
    assert.equal(r, "adopted");
    assert.deepEqual(e.load().sessions, ["A", "C"]);
    e.release();
    // B 를 다시 열면 B 의 기록
    ({ e, r } = open("B")); assert.equal(r, "restored"); assert.equal(e.load().goal, "fix the login bug"); e.release();
    // 읽기 전용(다른 pi 가 쓰는 중)이면 건드리지 않는다
    const ro = new FileFlowEngine(dir, true);
    assert.equal(ro.bindSession("Z"), "readonly");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("oxy-flow: 보관 기록은 최근 50개만 남긴다 (flow-spec F1)", async () => {
  const { FileFlowEngine, ARCHIVE_KEEP, pruneArchive } = await import("../agent/extensions/oxy-flow/store.ts");
  const { mkdtempSync, rmSync, readdirSync, writeFileSync, utimesSync, mkdirSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "oxy-flow-arch-"));
  try {
    assert.equal(ARCHIVE_KEEP, 50);
    const arch = join(dir, ".oxy/flow/archive");
    mkdirSync(arch, { recursive: true });
    const base = Date.now() / 1000 - 10000;
    for (let i = 0; i < 55; i++) {           // 오래된 순서로 old-00 … old-54
      const f = join(arch, `old-${String(i).padStart(2, "0")}.json`);
      writeFileSync(f, JSON.stringify({ id: `old-${i}`, sessions: [`S${i}`], updatedAt: i }));
      utimesSync(f, base + i, base + i);
    }
    // 새 세션이 지금 기록을 보관하면서 정리한다: 방금 보관한 것 + 최근 49개
    const e = new FileFlowEngine(dir); e.bindSession("A"); e.ensureGoal("task A"); e.release();
    const e2 = new FileFlowEngine(dir); assert.equal(e2.bindSession("B"), "parked"); e2.release();
    const names = readdirSync(arch);
    assert.equal(names.length, 50);
    assert.ok(names.some((n) => n.startsWith("flow-")));                 // 방금 보관한 A
    assert.equal(existsSync(join(arch, "old-54.json")), true);          // 최근 것은 남고
    assert.equal(existsSync(join(arch, "old-05.json")), false);         // 오래된 것은 지운다
    assert.equal(pruneArchive(join(dir, "nope"), 50), 0);               // 폴더가 없어도 오류 없음
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("oxy-monitor 실시간 활동: 이벤트 → live 상태 (도구 · 병렬 · compaction · 대기 · 최근 이벤트)", async () => {
  const L = await import("../agent/extensions/oxy-monitor/live.ts");
  let t = 1000;
  let s = L.emptyLive(42, t);
  const step = (ev: any) => { t += 100; s = L.reduceLive(s, ev, t); };
  assert.equal(s.agent.state, "idle");
  step({ type: "user", text: "로그인 API 를\n만들어줘" });
  step({ type: "agent_start" });
  assert.deepEqual([s.agent.state, s.agent.running], ["thinking", true]);
  step({ type: "turn_start", turnIndex: 0 });
  step({ type: "tool_start", id: "a", name: "bash", input: { command: "\nnpm test\nnpm run lint" } });
  const toolSince = s.agent.since;
  step({ type: "tool_start", id: "b", name: "read", input: { path: "src/a.ts" } });   // 병렬
  assert.equal(s.agent.state, "tool");
  assert.equal(s.agent.since, toolSince);                                             // 첫 도구가 시작한 시각
  assert.deepEqual(s.tools.map((x) => `${x.name}:${x.summary}`), ["bash:npm test", "read:src/a.ts"]);
  step({ type: "tool_end", id: "b", name: "read", ok: true });
  assert.equal(s.agent.state, "tool");                                               // 아직 bash 가 실행 중
  step({ type: "compact_start" });
  assert.equal(s.agent.state, "compacting");
  step({ type: "compact_end" });
  assert.equal(s.agent.state, "tool");
  step({ type: "tool_end", id: "a", name: "bash", ok: false });
  assert.equal(s.agent.state, "thinking");
  step({ type: "event", kind: "commit", ok: true, text: "커밋 n1 feat: login" });
  step({ type: "settled" });
  assert.deepEqual([s.agent.state, s.agent.running, s.tools.length], ["idle", false, 0]);
  assert.deepEqual(s.events.map((e) => `${e.kind}:${e.ok ? "ok" : "fail"}:${e.text}`),
    ["user:ok:로그인 API 를 만들어줘", "tool:ok:read src/a.ts", "tool:fail:bash npm test", "commit:ok:커밋 n1 feat: login"]);
  for (let i = 0; i < 30; i++) step({ type: "event", kind: "job", ok: true, text: `e${i}` });
  assert.equal(s.events.length, L.LIVE_EVENTS_MAX);
  assert.equal(s.events.at(-1)?.text, "e29");
  step({ type: "context", percent: 41.6 }); assert.equal(s.context.percent, 42);
  // 요약: 120자에서 자르고, 출력 · 내용은 담지 않는다
  assert.equal(L.toolSummary("bash", { command: "x".repeat(300) }).length, 120);
  assert.equal(L.toolSummary("subagent", { agent: "scout", task: "로그 찾기" }), "scout: 로그 찾기");
  assert.equal(L.toolSummary("write", { path: "a.txt", content: "SECRET" }), "a.txt");
  assert.equal(L.toolSummary("flow_plan", { action: "update", id: "p1.2", status: "done" }), "update p1.2 done");
});

test("oxy-monitor 실시간 활동: 작업 · 할 일 · 커밋 변화 → 이벤트", async () => {
  const L = await import("../agent/extensions/oxy-monitor/live.ts");
  let r = L.jobEvents(new Map([["job-1", "done"]]), [{ id: "job-1", state: "done", label: "a" }, { id: "job-2", state: "running", label: "npm test" }]);
  assert.deepEqual(r.events.map((e) => e.text), ["job-2 시작 npm test"]);
  r = L.jobEvents(r.seen, [{ id: "job-1", state: "done", label: "a" }, { id: "job-2", state: "failed", label: "npm test", exitCode: 1 }, { id: "job-3", state: "stopped", label: "x" }]);
  assert.deepEqual(r.events.map((e) => `${e.ok}:${e.text}`), ["false:job-2 실패 (exit 1)"]);   // 처음 본 job-3 은 이미 끝나 있어 알리지 않는다
  let f = L.flowEvents(null, [{ id: "p1", status: "doing", text: "API" }], { id: "n1", title: "base" });
  assert.equal(f.events.length, 0);                                                  // 처음은 기준만
  f = L.flowEvents(f.seen, [{ id: "p1", status: "done", text: "API" }, { id: "p2", status: "todo", text: "문서" }], { id: "n2", title: "feat: api" });
  assert.deepEqual(f.events.map((e) => `${e.kind}:${e.text}`), ["plan:p1 완료 API", "commit:커밋 n2 feat: api"]);
});

test("oxy-monitor 보기 모델: flow (지금 · 계획 · 최근, 23 · 35칸 × 11 · 24줄, 진행 중 항목이 보임)", async () => {
  const M = await import("../agent/extensions/oxy-monitor/model.ts");
  const L = await import("../agent/extensions/oxy-monitor/live.ts");
  const { displayWidth: w } = await import("../installer/tui.mjs");
  const now = 100000;
  const item = (id: string, status: string, kids: any[] = [], nodes: string[] = []) => ({ id, text: `할 일 ${id}`, status, at: 0, nodes, children: kids });
  // 항목 12개, 진행 중은 아래쪽 p10 의 할 일 p10.2
  const plan = Array.from({ length: 12 }, (_, i) => {
    const id = `p${i + 1}`;
    if (i < 9) return item(id, "done", [], [`n${i + 1}`]);
    if (i === 9) return item(id, "doing", [item(`${id}.1`, "done", [], ["n10"]), item(`${id}.2`, "doing"), item(`${id}.3`, "todo")]);
    return item(id, "todo");
  });
  const flow = { goal: "앱 만들기", plan, nodes: Array.from({ length: 10 }, (_, i) => ({ id: `n${i + 1}`, commit: "abc", title: `c${i + 1}`, decisions: [], files: [] })),
    buffer: { decisions: [], files: [], failures: [] } };
  let live = L.emptyLive(1, now - 5000);
  live = L.reduceLive(live, { type: "agent_start" }, now - 4000);
  live = L.reduceLive(live, { type: "tool_start", id: "a", name: "bash", input: { command: "npm test" } }, now - 3000);
  live = L.reduceLive(live, { type: "event", kind: "commit", ok: true, text: "커밋 n10 c10" }, now - 2000);
  const ui = { sel: null, open: new Set<string>(), manualAt: 0 };
  for (const [width, height] of [[23, 11], [23, 24], [35, 11], [35, 24]]) {
    const m = M.flowModel(flow as any, live, ui, width, height, now, w);
    assert.ok(M.modelHeight(m) <= height, `${width}x${height}: ${M.modelHeight(m)} 줄`);
    assert.ok(m.sections[0].rows.some((r) => r.key === "p:p10.2" && r.marker === "spinner" && r.emphasis), `${width}x${height}: 진행 중 할 일이 보여야 함`);
    assert.deepEqual(m.now.map((r) => r.text), ["도구 실행 중", "bash npm test", "p10.2 할 일 p10.2"]);
    assert.equal(m.now[0].since, now - 3000);
    assert.equal(m.right, "할 일 10/14");
    assert.equal(m.sections.length, height >= 16 ? 2 : 1);                      // 최근 구역은 16줄 이상에서만
    for (const k of m.keys) assert.ok(w(k) <= width, `${width}: 키 안내 ${k}`);
    const child = m.sections[0].rows.find((r) => r.key === "p:p10.1")!;
    assert.equal(child.right, width < M.NARROW ? undefined : "n10");             // 좁으면 커밋 번호를 뺀다
  }
  assert.equal(M.flowModel(flow as any, live, ui, 23, 24, now, w).keys.length, 2);
  // 사용자가 위로 움직인 뒤 10초 동안은 그 위치를 둔다, 그 뒤에는 다시 진행 중 항목으로
  const held = { sel: "p:p1", open: new Set<string>(), manualAt: now - 2000 };
  assert.ok(M.flowModel(flow as any, live, held, 23, 11, now, w).sections[0].rows.some((r) => r.key === "p:p1"));
  assert.ok(M.flowModel(flow as any, live, { ...held, manualAt: now - 20000 }, 23, 11, now, w).sections[0].rows.some((r) => r.key === "p:p10.2"));
  // live.json 이 오래되면 상태를 모른다고 보이고 도구 줄은 두지 않는다
  const stale = M.flowModel(flow as any, live, ui, 35, 24, now + M.LIVE_STALE_MS + 1, w);
  assert.deepEqual(stale.now.map((r) => r.text), ["pi 상태를 알 수 없습니다", "p10.2 할 일 p10.2"]);
  // 도구가 많으면 마지막 줄을 "외 N개" 로 (지금은 4줄 이하)
  let many = live;
  for (const id of ["b", "c", "d"]) many = L.reduceLive(many, { type: "tool_start", id, name: "read", input: { path: id } }, now);
  assert.deepEqual(M.nowRows(many, plan as any, now).map((r) => r.text), ["도구 실행 중", "bash npm test", "외 3개", "p10.2 할 일 p10.2"]);
  // 기록이 없으면
  const empty = M.flowModel(null, null, ui, 23, 11, now, w);
  assert.deepEqual([empty.now[0].text, empty.sections[0].rows[0].text, empty.right], ["pi 상태를 알 수 없습니다", "작업 기록이 없습니다.", ""]);
});

test("oxy-monitor 보기 모델: jobs (경과는 exe 가, 좁으면 종류 열을 뺌, 맨 아래 지금)", async () => {
  const M = await import("../agent/extensions/oxy-monitor/model.ts");
  const L = await import("../agent/extensions/oxy-monitor/live.ts");
  const { displayWidth: w } = await import("../installer/tui.mjs");
  const now = 100000;
  const job = (id: string, state: string, kind: string, extra: any = {}) => ({ id, kind, state, label: `${id} 일`, createdAt: 1000, startedAt: 2000, ...extra });
  const state: any = { version: 1, pid: 1, cwd: ".", updatedAt: now, closed: false, slots: {}, control: null,
    jobs: [job("job-1", "done", "bash", { endedAt: 65000 }), job("job-2", "running", "agent"), job("job-3", "failed", "bash", { endedAt: 9000 })] };
  const live = L.reduceLive(L.emptyLive(1, now), { type: "agent_start" }, now - 5000);
  for (const [width, height] of [[23, 11], [35, 24]]) {
    const m = M.jobsModel(state, live, { sel: null, mode: "list" }, width, height, now, w);
    assert.ok(M.modelHeight(m) <= height, `${width}x${height}: ${M.modelHeight(m)} 줄`);
    const rows = m.sections[0].rows;
    assert.deepEqual(rows.map((r) => r.key), ["job-2", "job-1", "job-3"]);   // 실행 중이 먼저
    assert.equal(rows[0].marker, "spinner"); assert.equal(rows[0].since, 2000); assert.equal(rows[0].right, undefined);
    assert.equal(rows[1].right, "1:03"); assert.equal(rows[2].error, true);
    assert.equal(rows[0].text, width < M.NARROW ? "job-2 일" : "sub  job-2 일");
    assert.equal(rows[1].text, width < M.NARROW ? "job-1 일" : "bg   job-1 일");   // 종류 폭을 맞춘다
    assert.equal(m.right, "실행 중 1 · 완료 2");
    assert.deepEqual([m.nowAt, m.now[0].text], ["bottom", "응답 생성 중"]);
    assert.ok(m.keys.join(" ").includes("s 중지"));                           // 선택한(첫) 작업이 실행 중
  }
  const confirm = M.jobsModel(state, live, { sel: "job-2", mode: "confirm" }, 35, 24, now, w);
  assert.ok(confirm.keys.join(" ").includes("job-2 작업을 중지할까요?"));
  const log = M.jobsModel(state, live, { sel: "job-1", mode: "log" }, 23, 11, now, w, Array.from({ length: 30 }, (_, i) => `line ${i}`));
  assert.equal(log.title, "job-1 로그"); assert.ok(M.modelHeight(log) <= 11); assert.equal(log.sections[0].rows.at(-1)?.text, "line 29");
  assert.equal(M.clock(3723000), "1:02:03");
});
