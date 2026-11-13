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
    assert.match(p[1], /⠿.*scout: 결제|⠿.*결제/);                     // 실행 중인 작업이 위로
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
  assert.match(p, /⠿ PaymentService 분리 1\/2\n\s+✓ 인터페이스 정의\n\s+n2 bbbbbbbb refactor/);
  assert.match(p, /계획 밖 커밋\nn3 cccccccc chore: 사람이 한 커밋/);
  assert.match(p, /커밋 전 작업\n· 캐시는 나중에\n변경 파일 2개\n× npm test/);
  // Enter 로 펼치기: 끝난 항목은 펼치고, 커밋은 결정 · 파일을 보인다
  const keys = flowKeys(flow, new Set());
  assert.deepEqual(keys.slice(0, 4), ["p:p1", "p:p2", "p:p2.1", "n:n2"]);
  const opened = plain(flowView(fit, flow, { sel: 0, open: new Set(["p:p1", "n:n2"]) }, 60, 30)).join("\n");
  assert.match(opened, /결제 흐름 읽기/);
  assert.match(opened, /· 인터페이스를 분리 \(테스트 쉬움\)/);
  check(flowView(fit, null, { sel: 0, open: new Set() }, 23, 8), 23, 8);
});

test("oxy-monitor 하단 바: 보일 항목 · 상태 기호 · 한 줄 · 클릭 범위 (monitor-spec §2, ui-unify-spec §2.2)", async () => {
  const { barItems, barLine, itemAt } = await import("../agent/extensions/oxy-monitor/bar.ts");
  const none = new Set<string>();
  assert.deepEqual(barItems({ active: 0, recent: 0 }, { hasContent: false, done: 0, total: 0, node: "" }, none), []);   // 보일 것이 없으면 바도 없다
  const items = barItems({ active: 2, recent: 1 }, { hasContent: true, done: 3, total: 7, node: "n4" }, new Set(["flow"]));
  assert.deepEqual(items.map((i) => [i.label, i.open, i.state]), [["Jobs 2 실행 중 · 1 완료", false, "running"], ["Flow 3/7", true, "running"]]);
  assert.deepEqual(barItems(null, { hasContent: true, done: 0, total: 0, node: "n4" }, none).map((i) => [i.label, i.state]), [["Flow n4", "idle"]]);   // 계획이 없으면 마지막 단계
  assert.equal(barItems(null, { hasContent: true, done: 5, total: 5, node: "n9" }, none)[0].state, "ok");
  assert.deepEqual(barItems({ active: 0, recent: 0 }, null, new Set(["jobs"])).map((i) => [i.label, i.state]), [["Jobs", "idle"]]);   // 열린 모니터는 닫을 수 있게 보인다
  assert.equal(barItems({ active: 0, recent: 2, failed: 1 }, null, none)[0].state, "fail");
  assert.equal(barItems({ active: 0, recent: 2 }, null, none)[0].state, "ok");
  const w = (s: string) => [...s].reduce((n, ch) => n + (/[가-힣]/.test(ch) ? 2 : 1), 0);
  const G = { running: "◐", ok: "✓", fail: "×", idle: "·" } as const;
  const st = { width: w, glyph: (s: keyof typeof G) => G[s], item: (s: string, o: boolean) => (o ? `<${s}>` : s), focus: (s: string) => `[${s}]`, hint: (s: string) => `{${s}}` };
  const r = barLine(items, -1, 80, st);
  assert.equal(r.line, " ◐ Jobs 2 실행 중 · 1 완료   ◐ <Flow 3/7>");
  assert.deepEqual(r.ranges, [{ kind: "jobs", start: 1, end: 26 }, { kind: "flow", start: 29, end: 39 }]);   // 왼쪽 여백 1칸
  assert.equal(itemAt(r.ranges, 0), undefined);
  assert.equal(itemAt(r.ranges, 5), "jobs");
  assert.equal(itemAt(r.ranges, 27), undefined);                        // 항목 사이
  assert.equal(itemAt(r.ranges, 30), "flow");
  const f = barLine(items, 1, 80, st);
  assert.match(f.line, /\[◐ Flow 3\/7\]    \{←→ 이동  Enter 열기·닫기  ↑ 입력창\}$/);   // 바에 들어오면 키 안내
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
    assert.match(md, /## 계획\n\n- ⏳ p1 Login API — n2\n  - ✓ p1\.1 route \(\d+:\d{2}\) — n1\n  - · p1\.2 tests/);
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

test("oxy-monitor 보기 모델: flow (Current · Next · Overall, [i/n] 트리, 걸린 시간, 기본 포커스, 23 · 35칸 × 11 · 15 · 24줄, flow-view-spec §2)", async () => {
  const M = await import("../agent/extensions/oxy-monitor/model.ts");
  const L = await import("../agent/extensions/oxy-monitor/live.ts");
  const { displayWidth: w } = await import("../installer/tui.mjs");
  const now = 1000000;
  const item = (id: string, text: string, status: string, kids: any[] = [], extra: any = {}) => ({ id, text, status, at: 0, nodes: [], children: kids, ...extra });
  // 항목 12개. 앞 9개는 끝남(걸린 시간 있음), p10 의 할 일 p10.2 가 진행 중, p10.3 · p11 · p12 는 예정
  const plan = Array.from({ length: 12 }, (_, i) => {
    const id = "p" + (i + 1);
    if (i < 9) return item(id, "항목 " + (i + 1), "done", [], { startedAt: 0, endedAt: 190000, nodes: ["n" + (i + 1)] });
    if (i === 9) return item(id, "로그인 API", "doing", [
      item("p10.1", "라우트", "done", [], { startedAt: 1000, endedAt: 191000 }),
      item("p10.2", "테스트 작성", "doing", [], { startedAt: now - 42000 }),
      item("p10.3", "오류 처리", "todo")], { startedAt: 1000 });
    return item(id, "항목 " + (i + 1), "todo");
  });
  const flow = { goal: "앱 만들기", plan, nodes: Array.from({ length: 9 }, (_, i) => ({ id: "n" + (i + 1), commit: "abc", title: "c" + (i + 1), decisions: [], files: [] })),
    buffer: { decisions: [], files: [], failures: [] } };
  let live = L.emptyLive(1, now - 5000);
  live = L.reduceLive(live, { type: "agent_start" }, now - 4000);
  live = L.reduceLive(live, { type: "tool_start", id: "a", name: "bash", input: { command: "npm test" } }, now - 3000);
  const ui = { sel: null, open: new Set<string>(), manualAt: 0 };
  for (const [width, height] of [[23, 11], [23, 24], [35, 11], [35, 15], [35, 24]]) {
    const m = M.flowModel(flow as any, live, ui, width, height, now, w);
    const tag = width + "x" + height;
    assert.ok(M.modelHeight(m) <= height, tag + ": " + M.modelHeight(m) + " 줄");
    assert.deepEqual([m.title, m.right, m.now.length], [width < 30 ? "Flow" : "Flow Monitor", "Total 10/14", 0], tag);   // 23칸에서 "Total 10/14" 와 함께 넘치면 Flow
    assert.deepEqual(m.sections.map((x) => x.title), ["Current Task", "Overall Task"]);                       // 최근 구역 없음 (R2)
    const top = m.sections[0].rows;
    assert.deepEqual([top[0].text, top[0].since, top[0].marker], ["테스트 작성", now - 42000, "spinner"], tag);   // 위치 표시 없이 이름 · 경과
    assert.equal(top.at(-1)!.text, "Next Task: 오류 처리", tag);
    assert.equal(top.length, height >= M.STATE_ROW_MIN_HEIGHT ? 3 : 2, tag);                                  // 14줄 미만이면 상태 줄을 뺀다 (R1)
    if (height >= M.STATE_ROW_MIN_HEIGHT) assert.equal(top[1].text, "도구 실행 중 · bash npm test");
    const tree = m.sections[1].rows;
    const cur = tree.find((r) => r.key === "p:p10.2")!;
    assert.ok(cur, tag + ": 지금 할 일이 보여야 함");
    assert.deepEqual([cur.text, cur.prefix, cur.right, cur.emphasis], ["[2/3] 테스트 작성", "├ ", width < M.NARROW ? "◀" : "◀ Current Task", true], tag);
    assert.equal(m.selected, "p:p10.2", tag);                                                                // 기본 포커스 = 지금 할 일
    for (const k of m.keys) assert.ok(w(k) <= width, width + ": 키 안내 " + k);
  }
  const big = M.flowModel(flow as any, live, ui, 35, 40, now, w).sections[1].rows;
  assert.deepEqual(big.slice(0, 1).map((r) => [r.text, r.right, r.prefix]), [["[1/12] 항목 1", "3:10", undefined]]);   // 끝난 것: 걸린 시간
  assert.deepEqual(big.filter((r) => r.key?.startsWith("p:p10")).map((r) => [r.text, r.prefix ?? "", r.right ?? ""]), [
    ["[10/12] 로그인 API", "", ""], ["[1/3] 라우트", "├ ", "3:10"], ["[2/3] 테스트 작성", "├ ", "◀ Current Task"], ["[3/3] 오류 처리", "└ ", ""]]);
  // 사용자가 움직인 뒤 10초 동안은 그 위치를 둔다, 그 뒤에는 다시 지금 할 일로
  const held = { sel: "p:p1", open: new Set<string>(), manualAt: now - 2000 };
  const hm = M.flowModel(flow as any, live, held, 23, 11, now, w);
  assert.equal(hm.selected, "p:p1"); assert.ok(hm.sections[1].rows.some((r) => r.key === "p:p1"));
  assert.equal(M.flowModel(flow as any, live, { ...held, manualAt: now - 20000 }, 23, 11, now, w).selected, "p:p10.2");
  // 펼친 할 일의 커밋은 "│ " 로 이어 들여 쓴다 (마지막 할 일 아래는 "  ")
  const f2: any = { ...flow, nodes: [flow.nodes[0]], plan: [item("p1", "A", "doing", [item("p1.1", "a1", "done", [], { nodes: ["n1"] }), item("p1.2", "a2", "doing")])] };
  const opened = M.planRows(f2, new Set(["p:p1.1"]), 35);
  assert.deepEqual(opened.map((r) => [r.prefix ?? "", r.text]), [["", "[1/1] A"], ["├ ", "[1/2] a1"], ["│ ", "n1 c1"], ["└ ", "[2/2] a2"]]);
  // live.json 이 오래되면 상태를 모른다고 보인다
  const stale = M.flowModel(flow as any, live, ui, 35, 24, now + M.LIVE_STALE_MS + 1, w);
  assert.equal(stale.sections[0].rows[1].text, "pi 상태를 알 수 없습니다");
  // 도구가 여럿이면 "외 N개"
  let many = live;
  for (const id of ["b", "c"]) many = L.reduceLive(many, { type: "tool_start", id, name: "read", input: { path: id } }, now);
  assert.equal(M.flowModel(flow as any, many, ui, 35, 24, now, w).sections[0].rows[1].text, "도구 실행 중 · bash npm test 외 2개");
  // 진행 중인 할 일이 없으면 · 다음이 없으면 · 기록이 없으면
  const idle: any = { ...flow, plan: [item("p1", "끝", "done", [], { startedAt: 0, endedAt: 5000 })] };
  const im = M.flowModel(idle, live, ui, 35, 24, now, w);
  assert.deepEqual([im.sections[0].rows[0].text, im.sections[0].rows.at(-1)!.text, im.right], ["진행 중인 할 일이 없습니다", "Next Task: 없음", "Total 1/1"]);
  const empty = M.flowModel(null, null, ui, 23, 11, now, w);
  assert.deepEqual([empty.sections[1].rows[0].text, empty.right, empty.title], ["작업 기록이 없습니다.", "", "Flow Monitor"]);
  // 다음 할 일: 같은 항목의 다음 할 일, 없으면 다음 항목의 첫 할 일 (할 일 없는 항목은 그 항목)
  const nx: any = [item("p1", "A", "doing", [item("p1.1", "a1", "doing")]), item("p2", "B", "todo"), item("p3", "C", "todo", [item("p3.1", "c1", "todo")])];
  assert.equal(M.nextItem(nx)!.text, "B");
  assert.equal(M.nextItem([nx[2]])!.text, "c1");
});

test("oxy-monitor 보기 모델: Job Monitor (Main · Sub Context, 진행 중만, 빈 영역의 - 는 가운데, subagent 화면, 팝업, jobs-view-spec §2)", async () => {
  const M = await import("../agent/extensions/oxy-monitor/model.ts");
  const L = await import("../agent/extensions/oxy-monitor/live.ts");
  const { displayWidth: w } = await import("../installer/tui.mjs");
  const now = 100000;
  const job = (id: string, state: string, kind: string, extra: any = {}) => ({ id, kind, state, label: kind === "agent" ? "worker: " + id + " 일" : id + " 명령", createdAt: 1000, startedAt: 2000, ...extra });
  const st = (jobs: any[]): any => ({ version: 1, pid: 1, cwd: ".", updatedAt: now, closed: false, slots: {}, control: null, jobs });
  const state = st([job("job-1", "done", "bash", { endedAt: 65000 }), job("job-2", "running", "agent"), job("job-3", "failed", "bash", { endedAt: 9000 }),
    job("job-4", "running", "bash"), job("job-5", "stopped", "agent", { endedAt: 9000 })]);
  const subs = new Map<string, any>([["job-2", st([job("job-1", "running", "bash", { label: "npm test" }), job("job-2", "done", "bash", { label: "npm run build", endedAt: 50000 })])]]);
  const live = L.reduceLive(L.emptyLive(1, now), { type: "agent_start" }, now - 5000);
  const ui = M.jobsUiInit();
  for (const [width, height] of [[23, 11], [23, 12], [35, 15], [35, 24]]) {
    const tag = width + "x" + height;
    const m = M.jobsModel(state, subs, live, ui, width, height, now, w);
    assert.ok(M.modelHeight(m) <= height, tag + ": " + M.modelHeight(m) + " 줄");
    assert.deepEqual([m.title, m.right], [width < 30 ? "Jobs" : "Job Monitor", "Processing 2"], tag);
    assert.deepEqual(m.sections.map((x) => x.title), ["Main Context", "Sub Context"]);
    const keyed = m.sections.map((x) => x.rows.filter((r) => r.key).map((r) => r.key));
    assert.deepEqual(keyed, [["m:job-4"], ["s:job-2"]], tag);                                   // 끝난 작업은 없다 (J4)
    const sub = m.sections[1].rows.find((r) => r.key === "s:job-2")!;
    assert.equal(sub.badge, width < M.NARROW ? undefined : "셸 1", tag);
    assert.equal(sub.since, 2000);
    assert.deepEqual([m.nowAt, m.now[0].text, m.selected], ["bottom", "응답 생성 중", "m:job-4"], tag);
  }
  // 빈 영역: "-" 는 영역의 가로 · 세로 가운데 (35칸 × 15줄: 영역 9줄 → Main 5 · Sub 4)
  const empty = M.jobsModel(st([job("job-1", "done", "bash", { endedAt: 3000 })]), new Map(), live, ui, 35, 15, now, w);
  assert.equal(empty.right, "Processing 0");
  assert.deepEqual(empty.sections.map((x) => x.rows.length), [5, 4]);
  assert.deepEqual(empty.sections.map((x) => x.rows.findIndex((r) => r.text === "-")), [2, 1]);
  assert.equal(empty.sections[0].rows[2].indent, 17);
  assert.deepEqual([empty.selected, empty.keys.at(-1)], [null, "q 닫기"]);
  assert.equal(M.modelHeight(empty), 15);
  // 높이 나누기: 짧은 영역의 남는 줄은 넘치는 영역에, 빈 영역은 몫을 그대로
  assert.deepEqual(M.splitAreas(9, 1, 8), [1, 8]);
  assert.deepEqual(M.splitAreas(9, 0, 8), [5, 4]);
  assert.deepEqual(M.splitAreas(9, 8, 1), [8, 1]);
  assert.deepEqual(M.splitAreas(9, 2, 2), [5, 4]);
  // subagent 화면: 대화 로그 + 진행 중인 셸 (끝난 셸은 없다), 진행 중인 셸이 없으면 가운데 "-"
  const sv = M.jobsModel(state, subs, live, { ...ui, mode: "sub", sub: "job-2", sel: null }, 35, 15, now, w);
  assert.deepEqual([sv.title, sv.right, sv.sections[0].title], ["worker", "Processing 1", "worker: job-2 일"]);
  assert.deepEqual(sv.sections[0].rows.filter((r) => r.key).map((r) => [r.key, r.text]), [["sublog", "대화 로그"], ["c:job-1", "npm test"]]);
  assert.deepEqual([sv.now[0].text, sv.selected, sv.keys.at(-1)], ["worker 실행 중", "sublog", "▲▼ 이동  Enter 로그  Esc 목록"]);
  assert.ok(M.modelHeight(sv) <= 15);
  const sv0 = M.jobsModel(state, new Map(), live, { ...ui, mode: "sub", sub: "job-2", sel: null }, 35, 15, now, w);
  const area = sv0.sections[0].rows.slice(1);
  assert.equal(area.findIndex((r) => r.text === "-"), Math.floor((area.length - 1) / 2));
  // 끝난 subagent 를 보고 있었으면 목록으로
  assert.deepEqual(M.jobsModel(state, subs, live, { ...ui, mode: "sub", sub: "job-5" }, 35, 15, now, w).sections.map((x) => x.title), ["Main Context", "Sub Context"]);
  // 로그 화면
  const log = M.jobsModel(state, subs, live, { ...ui, mode: "log", log: { scope: "child", id: "job-1", sub: "job-2" }, back: "sub" }, 23, 11, now, w, Array.from({ length: 30 }, (_, i) => "line " + i));
  assert.equal(log.title, "npm test 로그"); assert.ok(M.modelHeight(log) <= 11); assert.equal(log.sections[0].rows.at(-1)?.text, "line 29");
  // 중지 확인 팝업 (처음 포커스 = 취소)
  const pop = M.jobsModel(state, subs, live, { ...ui, confirm: { scope: "main", id: "job-2", label: "worker: job-2 일", agent: true, focus: "no" } }, 35, 15, now, w);
  assert.deepEqual(pop.popup, { title: "작업 중지", lines: ["worker: job-2 일 작업을 중지할까요?", "그 subagent 와 그것이 띄운 셸이 모두 끝납니다."], buttons: ["중지", "취소"], focus: 1, danger: 0 });
  assert.equal(pop.keys.at(-1), "←→ 이동  Enter 선택  Esc 취소");
  assert.equal(M.clock(3723000), "1:02:03");
});

test("oxy-monitor 키 처리: exe 판별 · flow 선택 이동과 펼치기 · jobs 로그 · 중지 확인", async () => {
  const C = await import("../agent/extensions/oxy-monitor/controller.ts");
  assert.equal(C.supportsMonitor("oxy-tui 0.2.0 monitor\n"), true);
  assert.equal(C.supportsMonitor("oxy-tui 0.1.0\n"), false);                         // 예전 exe: pi-tui 대체 화면으로
  assert.equal(C.supportsMonitor(""), false);
  const item = (id: string, status: string, kids: any[] = []) => ({ id, text: id, status, at: 0, nodes: [], children: kids });
  const flow: any = { goal: "g", plan: [item("p1", "doing", [item("p1.1", "doing"), item("p1.2", "todo")]), item("p2", "todo")], nodes: [], buffer: { decisions: [], files: [], failures: [] } };
  let ui: any = { sel: null, open: new Set<string>(), manualAt: 0 };
  ui = C.flowKey(ui, flow, 35, "down", 500);
  assert.deepEqual([ui.sel, ui.manualAt], ["p:p1.2", 500]);                         // 지금 할 일(p1.1)에서 움직이기 시작
  ui = C.flowKey(ui, flow, 35, "down", 600); assert.equal(ui.sel, "p:p2");
  for (const t of [700, 701, 702, 703]) ui = C.flowKey(ui, flow, 35, "up", t);
  assert.equal(ui.sel, "p:p1");                                                      // 맨 위에서 멈춤
  ui = { ...ui, manualAt: 0 };                                                       // 10초가 지나면 다시 지금 할 일에서
  ui = C.flowKey(ui, flow, 35, "up", 20000); assert.equal(ui.sel, "p:p1");
  ui = C.flowKey(ui, flow, 35, "down", 20001); assert.equal(ui.sel, "p:p1.1");
  ui = C.flowKey(ui, flow, 35, "enter", 20100); assert.ok(ui.open.has("p:p1.1"));   // 고른 줄(p1.1)을 펼침
  ui = C.flowKey(ui, flow, 35, "enter", 20200); assert.ok(!ui.open.has("p:p1.1"));
  const M = await import("../agent/extensions/oxy-monitor/model.ts");
  const job = (id: string, state: string, kind = "bash") => ({ id, kind, state, label: id, createdAt: 1 });
  const st = (jobs: any[]): any => ({ jobs, control: null });
  const state = st([job("job-1", "done"), job("job-2", "running"), job("job-3", "running", "agent")]);
  const subs = new Map<string, any>([["job-3", st([job("job-1", "running"), job("job-2", "done")])]]);
  const K = (ui: any, key: any, scroll = 0) => C.jobsKey(ui, scroll, state, subs, key);
  let r = K(M.jobsUiInit(), "down");
  assert.equal(r.ui.sel, "s:job-3");                                                // 고른 줄이 없으면 첫 줄(m:job-2)에서 움직인다 (끝난 job-1 은 목록에 없다)
  r = K(r.ui, "up"); assert.equal(r.ui.sel, "m:job-2");
  r = K(r.ui, "down"); assert.equal(r.ui.sel, "s:job-3");
  // s → 팝업 (처음 포커스 취소) → Enter = 취소
  r = K(r.ui, "s"); assert.deepEqual([r.ui.confirm?.id, r.ui.confirm?.agent, r.ui.confirm?.focus], ["job-3", true, "no"]);
  r = K(r.ui, "enter"); assert.deepEqual([r.ui.confirm, r.stop], [null, undefined]);
  // s → ← (중지) → Enter = 중지 요청
  r = K(r.ui, "s"); r = K(r.ui, "left"); assert.equal(r.ui.confirm?.focus, "yes");
  r = K(r.ui, "enter"); assert.deepEqual([r.stop?.scope, r.stop?.id, r.ui.notice], ["main", "job-3", "job-3 중지를 요청했습니다."]);
  r = K({ ...r.ui, confirm: { scope: "main", id: "job-2", label: "job-2", focus: "yes" } }, "esc"); assert.equal(r.ui.confirm, null);   // Esc 취소
  // Enter on subagent → subagent 화면 → ▼ 셸 → s 팝업(child) → Enter 로그 → Esc 돌아가기 → Esc 목록
  r = K({ ...M.jobsUiInit(), sel: "s:job-3" }, "enter"); assert.deepEqual([r.ui.mode, r.ui.sub, r.ui.sel], ["sub", "job-3", "sublog"]);
  r = K(r.ui, "down"); assert.equal(r.ui.sel, "c:job-1");                           // 끝난 job-2 셸은 없다
  const ask = K(r.ui, "s"); assert.deepEqual([ask.ui.confirm?.scope, ask.ui.confirm?.sub, ask.ui.confirm?.id], ["child", "job-3", "job-1"]);
  r = K(r.ui, "enter"); assert.deepEqual([r.ui.mode, r.ui.log, r.ui.back], ["log", { scope: "child", id: "job-1", sub: "job-3" }, "sub"]);
  r = K(r.ui, "up"); r = K(r.ui, "up", r.scroll); assert.equal(r.scroll, 2);
  r = K(r.ui, "esc", r.scroll); assert.deepEqual([r.ui.mode, r.scroll], ["sub", 0]);
  r = K({ ...r.ui, sel: "sublog" }, "enter"); assert.deepEqual(r.ui.log, { scope: "main", id: "job-3" });   // 대화 로그 = subagent 자신의 로그
  r = K(r.ui, "esc"); r = K(r.ui, "esc"); assert.deepEqual([r.ui.mode, r.ui.sel], ["list", "s:job-3"]);
  // Enter on main shell → 로그 → Esc 목록
  r = K({ ...M.jobsUiInit(), sel: "m:job-2" }, "enter"); assert.deepEqual([r.ui.mode, r.ui.back], ["log", "list"]);
  // subagent 가 끝나면 subagent 화면에서 목록으로
  r = C.jobsKey({ ...M.jobsUiInit(), mode: "sub", sub: "job-3" }, 0, st([job("job-3", "done", "agent")]), subs, "down");
  assert.deepEqual([r.ui.mode, r.ui.sel], ["list", "s:job-3"]);
});

test("writeAtomic: 다른 프로세스(모니터)가 파일을 계속 읽는 동안에도 쓰기가 실패하지 않는다 (Windows 이름 바꾸기 EPERM)", { skip: process.platform !== "win32" }, async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { spawn } = await import("node:child_process");
  const { writeAtomic } = await import("../agent/extensions/_lib/common.ts");
  const dir = mkdtempSync(join(tmpdir(), "oxy-wa-"));
  const file = join(dir, "state.json");
  writeAtomic(file, "0");
  // 모니터처럼 쉬지 않고 읽는 프로세스 (실측: 고치기 전에는 이름 바꾸기 3번에 1번꼴로 EPERM)
  const reader = spawn(process.execPath, ["-e", `const fs=require("fs");setTimeout(()=>process.exit(),5000);for(;;){try{fs.readFileSync(${JSON.stringify(file)})}catch{}}`], { stdio: "ignore" });
  try {
    await new Promise((r) => setTimeout(r, 300));
    for (let i = 1; i <= 300; i++) writeAtomic(file, String(i));
    assert.equal(readFileSync(file, "utf8"), "300");
  } finally {
    reader.kill();
    await new Promise((r) => setTimeout(r, 200));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("oxy-flow 걸린 시간: 시작 · 끝 시각 · 되돌림 · todo 에서 바로 done · 항목 · 다시 쓰기 · FLOW.md (flow-view-spec §3)", async () => {
  const { setPlan, updateItem, findItem, itemDuration, renderPlanMarkdown } = await import("../agent/extensions/oxy-flow/plan.ts");
  const S = 1000;
  let plan = setPlan([], [{ text: "로그인 API", children: [{ text: "라우트" }, { text: "테스트" }] }, { text: "문서" }], 0);
  updateItem(plan, "p1.1", { status: "doing" }, 10 * S);
  const p1 = () => findItem(plan, "p1")!.item, c = (id: string) => findItem(plan, id)!.item;
  assert.equal(c("p1.1").startedAt, 10 * S);
  assert.equal(p1().startedAt, 10 * S);                                    // 항목도 할 일을 따라 시작
  updateItem(plan, "p1.1", { status: "done" }, 200 * S);
  assert.equal(itemDuration(c("p1.1")), 190 * S);
  // 다시 doing 으로: 끝 시각은 지우고 시작 시각은 둔다
  updateItem(plan, "p1.1", { status: "doing" }, 210 * S);
  assert.equal(c("p1.1").endedAt, undefined);
  assert.equal(c("p1.1").startedAt, 10 * S);
  assert.equal(itemDuration(c("p1.1")), null);                             // 끝나지 않은 것은 시간 없음
  updateItem(plan, "p1.1", { status: "done" }, 250 * S);
  // todo 에서 바로 done: 시작 시각이 없으니 비운다 (지어내지 않는다)
  updateItem(plan, "p1.2", { status: "done" }, 300 * S);
  assert.equal(c("p1.2").startedAt, undefined);
  assert.equal(itemDuration(c("p1.2")), null);
  // 항목: 가장 이른 할 일 시작 ~ 가장 늦은 할 일 끝
  assert.equal(p1().status, "done");
  assert.equal(itemDuration(p1()), 290 * S);
  // 할 일 없는 항목은 자신의 시각
  updateItem(plan, "p2", { status: "doing" }, 400 * S);
  updateItem(plan, "p2", { status: "done" }, 4000 * S);
  assert.equal(itemDuration(c("p2")), 3600 * S);
  // 다시 쓰기: 같은 글은 시각을 이어받는다
  plan = setPlan(plan, [{ text: "로그인 API", children: [{ text: "라우트" }] }, { text: "문서" }], 5000 * S);
  assert.equal(itemDuration(c("p1.1")), 240 * S);
  // FLOW.md: 끝난 것 옆에 걸린 시간 (한 시간 넘으면 h:mm:ss)
  assert.deepEqual(renderPlanMarkdown(plan), ["- ✓ p1 로그인 API (4:00)", "  - ✓ p1.1 라우트 (4:00)", "- ✓ p2 문서 (1:00:00)"]);
  // 예전 파일(시각 없음)
  assert.equal(itemDuration({ id: "p1", text: "x", status: "done", at: 1, nodes: [], children: [] }), null);
});

test("pi 테마: Oxygen 테마 파일을 agent/themes 로 · 기본값 oxygen · 예전 tokyo-night 는 oxygen 으로 · 사용자가 고른 값은 둔다 · 모니터 팔레트 (ui-unify-spec §2.0)", async () => {
  const { applyTheme } = await import("../scripts/render-config.mjs");
  const { monitorTheme } = await import("../agent/extensions/oxy-monitor/controller.ts");
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "oxy-theme-"));
  try {
    const root = join(dir, "root"), agent = join(dir, "agent");
    mkdirSync(join(root, "config", "pi-themes"), { recursive: true }); mkdirSync(join(agent, "themes"), { recursive: true });
    // 테마 파일이 없는 번들: theme 을 넣지 않는다
    assert.equal(applyTheme({ a: 1 }, agent, root).theme, undefined);
    writeFileSync(join(root, "config", "pi-themes", "oxygen.json"), "{\"name\":\"oxygen\"}");
    assert.deepEqual(applyTheme({ a: 1 }, agent, root), { a: 1, theme: "oxygen" });
    assert.ok(existsSync(join(agent, "themes", "oxygen.json")));
    // 예전 기본값 tokyo-night 가 남은 설치본: oxygen 으로 바꾸고 테마 파일을 지운다
    writeFileSync(join(agent, "settings.json"), JSON.stringify({ theme: "tokyo-night" }));
    writeFileSync(join(agent, "themes", "tokyo-night.json"), "{}");
    assert.equal(applyTheme({ a: 1 }, agent, root).theme, "oxygen");
    assert.ok(!existsSync(join(agent, "themes", "tokyo-night.json")));
    // 사용자가 pi /settings 에서 고른 값은 다시 만들어도 둔다
    writeFileSync(join(agent, "settings.json"), JSON.stringify({ theme: "light/dark" }));
    assert.equal(applyTheme({ a: 1 }, agent, root).theme, "light/dark");
  } finally { rmSync(dir, { recursive: true, force: true }); }
  // 저장소의 Oxygen 테마는 pi 의 테마 검증을 통과한다
  const { pathToFileURL } = await import("node:url");
  const td = join(import.meta.dirname, "..", "vendor", "pi", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "modes", "interactive", "theme");
  const S: any = await import(pathToFileURL(join(td, "theme-schema.js")).href);
  const T: any = await import(pathToFileURL(join(td, "theme.js")).href);
  T.setThemeJsonValidator(S.validateThemeJson);
  const th = T.loadThemeFromPath(join(import.meta.dirname, "..", "config", "pi-themes", "oxygen.json"), "truecolor");
  assert.equal(th.fg("accent", "x"), "\x1b[38;2;127;184;214mx\x1b[39m", "accent 는 하늘색 (세이지가 아님)");
  // 모니터 팔레트: 사용자가 정한 OXY_TUI_THEME 만, 그 밖에는 기본(세이지)
  assert.equal(monitorTheme(JSON.stringify({ theme: "tokyo-night" }), undefined), undefined);
  assert.equal(monitorTheme(JSON.stringify({ theme: "oxygen" }), undefined), undefined);
  assert.equal(monitorTheme(JSON.stringify({ theme: "tokyo-night" }), "light"), "light");       // 사용자가 정한 OXY_TUI_THEME 이 먼저
  assert.equal(monitorTheme(null, undefined), undefined);
});

test("oxy-jobs subagent 의 실행 폴더: 환경변수 → sub/<작업 id> · 잘못된 id 거부 · 모니터가 읽기 (jobs-view-spec §3)", async () => {
  const S = await import("../agent/extensions/oxy-jobs/state.ts");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  assert.equal(S.subRunFromEnv({}), null);
  assert.equal(S.subRunFromEnv({ OXY_JOBS_PARENT: "C:/x/run-1-2", OXY_JOBS_PARENT_JOB: "../evil" }), null);
  assert.equal(S.subRunFromEnv({ OXY_JOBS_PARENT: "C:/x/run-1-2", OXY_JOBS_PARENT_JOB: "job-3" }), join("C:/x/run-1-2", "sub", "job-3"));
  const dir = mkdtempSync(join(tmpdir(), "oxy-sub-"));
  try {
    const w = new S.StateWriter(S.subRunDir(dir, "job-3"), () => ({ version: 1, pid: 7, startedAt: 1, updatedAt: 2, closed: false, cwd: ".", slots: {}, jobs: [], control: null }), { heartbeatMs: 0 });
    w.close();
    const subs = S.readSubStates(dir);
    assert.deepEqual([...subs.keys()], ["job-3"]);
    assert.equal(subs.get("job-3")!.closed, true);
    assert.equal(S.readSubStates(join(dir, "없음")).size, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("oxy-monitor: 모니터 pane 은 화면을 그린 본 대화가 끝날 때만 닫는다 (subagent 가 끝날 때 부모의 모니터를 닫지 않는다)", async () => {
  const { closesMonitorsOnShutdown } = await import("../agent/extensions/oxy-monitor/pane.ts");
  assert.equal(closesMonitorsOnShutdown("quit", true), true);
  assert.equal(closesMonitorsOnShutdown("quit", false), false);   // subagent (-p, 화면 없음): 부모 pane 의 TMUX 를 물려받아도 닫지 않는다
  assert.equal(closesMonitorsOnShutdown("new", true), false);     // /new · 세션 넘기기
});

test("skill 상황 시험 CI 판정: 반복 중 1번 합격이면 통과 · 기준선보다 나빠지면 실패 · 합격 = 결과 PASS + skill 2개 이상 (skill-combo-spec §4 C3)", async () => {
  const { gate, accepted } = await import("./scenario-eval/gate.mjs");
  const r = (scenario: string, pass: boolean, used: number) => ({ scenario, pass, skillsUsed: used, skillsExpected: 2 });
  assert.equal(accepted(r("a", true, 1)), false);                     // 결과는 맞아도 skill 1개면 불합격
  assert.equal(accepted(r("a", false, 2)), false);
  assert.equal(accepted(r("a", true, 2)), true);
  const rows = [r("a", true, 2), r("a", false, 0), r("b", true, 1), r("b", true, 1), r("c", true, 3)];
  let g = gate(rows, { accepted: ["a"] });
  assert.deepEqual([g.ok, g.regressed, g.improved], [true, [], ["c"]]);
  assert.deepEqual(g.scenarios.map((s) => [s.id, s.passCount, s.runs]), [["a", 1, 2], ["b", 0, 2], ["c", 1, 1]]);
  g = gate(rows, { accepted: ["a", "b"] });
  assert.deepEqual([g.ok, g.regressed], [false, ["b"]]);              // 기준선에서 합격이던 b 가 이번에 불합격
  assert.deepEqual(gate(rows, { accepted: ["d"] }).regressed, ["d"]);  // 기준선 시나리오가 돌지 않음도 실패
  assert.equal(gate(rows, null).ok, true);
});

test("skill-library: 모든 SKILL.md 의 frontmatter 가 pi 의 파서로 읽히고 name = 폴더 이름 · description 있음 (1024자 이하)", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const { pathToFileURL } = await import("node:url");
  const fm: any = await import(pathToFileURL(join(import.meta.dirname, "..", "vendor", "pi", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "utils", "frontmatter.js")).href);
  const lib = join(import.meta.dirname, "..", "agent", "skill-library");
  const dirs = readdirSync(lib, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  assert.ok(dirs.length > 0);
  for (const d of dirs) {
    const text = readFileSync(join(lib, d, "SKILL.md"), "utf8");
    assert.ok(text.startsWith("---\n"), `${d}: frontmatter 로 시작`);
    const { frontmatter } = fm.parseFrontmatter(text);   // YAML 이 깨지면 여기서 예외
    assert.equal(frontmatter.name, d, `${d}: name 이 폴더 이름과 같음`);
    assert.equal(typeof frontmatter.description, "string", `${d}: description 있음`);
    assert.ok(frontmatter.description.trim().length > 0 && frontmatter.description.length <= 1024, `${d}: description 길이 ${frontmatter.description.length}`);
  }
});

test("oxygen-pi-tui 골격: 폭 단계 · 좌우 배치 · 가운데 말줄임 · 경로 (pi-tui-spec §2)", async () => {
  const { pathToFileURL } = await import("node:url");
  const t: any = await import(pathToFileURL(join(import.meta.dirname, "..", "vendor", "pi", "node_modules", "@earendil-works", "pi-tui", "dist", "index.js")).href);
  const L = await import("../agent/extensions/oxygen-pi-tui/layout.ts");
  const m = { width: (s: string) => t.visibleWidth(s), trunc: (s: string, w: number, e = "…") => (t.visibleWidth(s) <= w ? s : t.truncateToWidth(s, w, e)) };
  assert.deepEqual([56, 63, 64, 80, 99, 100, 120].map(L.widthClass), ["narrow", "narrow", "normal", "normal", "normal", "wide", "wide"]);
  for (const w of [10, 56, 80, 120]) {
    const line = L.spread(m, " ◆ Oxygen Pi 0.1.0", "pi 1.5.0 · tokyo-night", w);
    assert.equal(t.visibleWidth(line), w, `spread 폭 ${w}`);
  }
  assert.equal(L.spread(m, "왼쪽", "오른쪽", 20), "왼쪽" + " ".repeat(10) + "오른쪽");
  const plain = (x: string) => x.replace(/\x1b\[[0-9;]*m/g, "");
  assert.equal(plain(L.spread(m, "abcdefghij", "0123456789", 15)), "abcdefghij 012…");     // 오른쪽부터 줄인다
  assert.equal(plain(L.spread(m, "abcdefghijklmnop", "xy", 12)), "abcdefghijk…");          // 오른쪽이 들어갈 자리가 없으면 빼고 왼쪽을 자른다
  assert.equal(L.spread(m, "a", "b", 5, "─"), "a───b");
  const p = "C:/Users/kim/workspace/한글폴더/src/db/schema.sql";
  for (const w of [12, 20, 30]) {
    const s = plain(L.middle(m, p, w));
    assert.ok(t.visibleWidth(s) <= w && s.includes("…"), `middle ${w}: ${s}`);
    assert.ok(s.startsWith("C:/") && s.endsWith(".sql"), s);
  }
  assert.equal(L.middle(m, "short", 10), "short");
  assert.equal(L.homePath(String.raw`C:\Users\kim\OneDrive\x`, "C:/Users/kim"), "~/OneDrive/x");
  assert.equal(L.homePath("c:/users/kim", String.raw`C:\Users\Kim`), "~");
  assert.equal(L.homePath("D:/w", "C:/Users/kim"), "D:/w");
  assert.equal(L.lastSegment("~/workspace/oxygen-pi-system"), "…/oxygen-pi-system");
  assert.equal(L.lastSegment("~"), "~");
});

test("oxygen-pi-tui 골격: 기호 1칸 · ASCII 대체 · 시그니처 색 · 설정 (pi-tui-spec §2, oxygen-design)", async () => {
  const { pathToFileURL } = await import("node:url");
  const t: any = await import(pathToFileURL(join(import.meta.dirname, "..", "vendor", "pi", "node_modules", "@earendil-works", "pi-tui", "dist", "index.js")).href);
  const G = await import("../agent/extensions/oxygen-pi-tui/glyphs.ts");
  const B = await import("../agent/extensions/oxygen-pi-tui/brand.ts");
  const C = await import("../agent/extensions/oxygen-pi-tui/config.ts");
  for (const mode of ["unicode", "ascii"] as const) {
    const g = G.glyphs(mode) as any;
    for (const [k, v] of Object.entries(g)) {
      if (k === "more") continue;
      for (const ch of Array.isArray(v) ? v : [v]) assert.equal(t.visibleWidth(ch), 1, `${mode}.${k} '${ch}' 는 1칸`);
      if (mode === "ascii") for (const ch of Array.isArray(v) ? v : [v]) assert.match(ch, /^[\x20-\x7e]+$/, `ascii.${k}`);
    }
  }
  const u = G.glyphs("unicode");
  assert.ok(!u.spinner.some((f) => /[\u2800-\u28ff]/.test(f)), "점자 스피너는 D2Coding 에 없어 쓰지 않는다");
  assert.deepEqual([0, 149, 150, 450, 600].map((ms) => G.spinnerFrame(u, ms)), ["◐", "◐", "◓", "◒", "◐"]);
  // 시그니처 색: 규칙 파일의 값 그대로
  assert.equal(B.brandFg("sage", "Oxygen", { mode: "truecolor", appearance: "dark" }), "\x1b[38;2;169;203;164mOxygen\x1b[39m");
  assert.equal(B.brandFg("sage", "Oxygen", { mode: "truecolor", appearance: "light" }), "\x1b[38;2;58;102;82mOxygen\x1b[39m");
  assert.equal(B.brandFg("purple", "Pi", { mode: "256color", appearance: "dark" }), "\x1b[38;5;140mPi\x1b[39m");
  assert.equal(B.brandFg("sage", "x", { mode: "truecolor", appearance: "dark", noColor: true }), "x");
  assert.deepEqual(B.brandEnv({ getColorMode: () => "truecolor", appearance: "light" }, {}), { mode: "truecolor", appearance: "light", noColor: false });
  assert.deepEqual(B.brandEnv(undefined, { NO_COLOR: "1" }), { mode: "256color", appearance: "dark", noColor: true });
  const rule = (await import("node:fs")).readFileSync(join(import.meta.dirname, "..", ".claude", "rules", "oxygen-design.md"), "utf8");
  for (const [name, c] of Object.entries(B.BRAND)) {
    assert.ok(rule.includes(`\`${c.dark}\``) && rule.includes(`\`${c.light}\``) && rule.includes(`${c.ansi256[0]} / ${c.ansi256[1]}`), `규칙 파일과 같은 값: ${name}`);
  }
  // 설정: 기본 켜짐, 깨진 파일은 기본값
  assert.deepEqual(C.parseConfig(null), { enabled: true, glyphs: "unicode" });
  assert.deepEqual(C.parseConfig("{broken"), { enabled: true, glyphs: "unicode" });
  assert.deepEqual(C.parseConfig('{"enabled":false,"glyphs":"ascii"}'), { enabled: false, glyphs: "ascii" });
  assert.deepEqual(C.parseConfig('{"enabled":"no","glyphs":"emoji"}'), { enabled: true, glyphs: "unicode" });
});

test("oxygen-pi-tui 입력창 · 푸터: 테두리 폭 · 글 줄이는 순서 · 컨텍스트 기준 · 상태 순서 (pi-tui-spec §5 §6)", async () => {
  const { pathToFileURL } = await import("node:url");
  const t: any = await import(pathToFileURL(join(import.meta.dirname, "..", "vendor", "pi", "node_modules", "@earendil-works", "pi-tui", "dist", "index.js")).href);
  const E = await import("../agent/extensions/oxygen-pi-tui/editor.ts");
  const F = await import("../agent/extensions/oxygen-pi-tui/footer.ts");
  const { glyphs } = await import("../agent/extensions/oxygen-pi-tui/glyphs.ts");
  const m = { width: (s: string) => t.visibleWidth(s), trunc: (s: string, w: number, e = "…") => (t.visibleWidth(s) <= w ? s : t.truncateToWidth(s, w, e)) };
  const plain = (x: string) => x.replace(/\x1b\[[0-9;]*m/g, "");
  const g = glyphs("unicode");
  const id = (s: string) => s;
  for (const w of [3, 10, 30, 56, 80, 120]) {
    const top = E.borderLine(m, g, w, [g.tl, g.tr], "◓ 작업 중 12초", "vllm · qwen3.6-coder-30b · low", id);
    assert.equal(t.visibleWidth(top), w, `윗줄 폭 ${w}: ${top}`);
    const bot = E.borderLine(m, g, w, [g.bl, g.br], "", "ctx 23% · 29K/131K", id);
    assert.equal(t.visibleWidth(bot), w, `아랫줄 폭 ${w}`);
  }
  assert.equal(E.borderLine(m, g, 30, [g.tl, g.tr], "입력", "a · b", id), "╭─ 입력 " + "─".repeat(13) + " a · b ─╮");
  assert.equal(E.borderLine(m, g, 20, [g.bl, g.br], "", "", id), "╰" + "─".repeat(18) + "╯");
  assert.equal(E.borderLine(m, g, 20, [g.bl, g.br], "\x1b[2m\x1b[22m", "", id), "╰" + "─".repeat(18) + "╯", "색 코드만 있는 글은 빈 글");
  const narrow = plain(E.borderLine(m, g, 24, [g.tl, g.tr], "입력", "qwen3.6-coder-30b · low", id));
  assert.match(narrow, /^╭─ 입력 ─* ?.*…/);                            // 오른쪽 글부터 줄인다, 왼쪽은 그대로
  // 모델 · 사용량 글
  assert.equal(E.modelLabel({ provider: "oxy-vllm", id: "qwen3-30b", thinking: "low" }, "normal"), "vllm · qwen3-30b · low");
  assert.equal(E.modelLabel({ provider: "oxy-vllm", id: "qwen3-30b", thinking: "low" }, "narrow"), "qwen3-30b · low");
  assert.equal(E.modelLabel({ provider: "oxy-anthropic-claude", id: "claude-haiku-5-5", thinking: "high", reasoning: false }, "wide"), "anthropic-claude · claude-haiku-5-5");
  assert.deepEqual([0, 49.9, 50, 84.9, 85, 100, null].map(E.usageLevel), ["normal", "normal", "warning", "warning", "error", "error", "normal"]);
  assert.equal(E.usageLabel({ tokens: 29_400, contextWindow: 131_072, percent: 22.6 }, "normal"), "ctx 23% · 29K/131K");
  assert.equal(E.usageLabel({ tokens: 29_400, contextWindow: 131_072, percent: 22.6, cost: 0.0123 }, "wide"), "ctx 23% · 29K/131K · $0.012");
  assert.equal(E.usageLabel({ tokens: 29_400, contextWindow: 131_072, percent: 22.6, cost: 0.5 }, "narrow"), "ctx 23%");
  assert.equal(E.usageLabel({ tokens: 850, contextWindow: 8000, percent: 10 }, "normal"), "ctx 10% · 850/8K");
  assert.equal(E.usageLabel({ percent: null }, "normal"), "ctx ?");
  assert.equal(E.topLeftLabel(null, 0), "입력");
  assert.equal(E.topLeftLabel({ frame: "◑", seconds: 12 }, 0), "◑ 작업 중 12초");
  assert.equal(E.topLeftLabel(null, 3), "입력 · ▲ 3줄 더");
  assert.equal(E.bottomLeftLabel(0), "");
  assert.equal(E.bottomLeftLabel(2), "▼ 2줄 더");
  assert.equal(E.withPrompt("   다음 할 일   ", "›"), " › 다음 할 일   ");
  assert.equal(E.withPrompt("x", "›"), "x");
  assert.equal(t.visibleWidth("▲") + t.visibleWidth("▼"), 2, "스크롤 표시는 1칸 기호 (↑↓ 는 mintty 에서 2칸)");
  // 푸터 상태: oxy-ctx 는 빼고 flow → jobs → 나머지 이름순, psmux 하단 바가 있으면 flow · jobs 도 뺀다
  const st = new Map([["zeta", "z 상태"], ["oxy-jobs", "작업 1개 실행 중"], ["oxy-ctx", "ctx 23%"], ["oxy-flow", "flow n4 · 할 일 2/5"], ["alpha", "a"], ["empty", " "]]);
  assert.deepEqual(F.footerStatuses(st, false), ["flow n4 · 할 일 2/5", "작업 1개 실행 중", "a", "z 상태"]);
  assert.deepEqual(F.footerStatuses(st, true), ["a", "z 상태"]);
  const p = { muted: id, accent: id, sep: "·" };
  const cwd = "~/workspace/oxygen-pi-system";
  const s2 = ["flow n4 · 할 일 2/5", "작업 1개 실행 중"];
  for (const w of [12, 30, 56, 80, 120]) assert.ok(t.visibleWidth(F.footerLine(m, w, cwd, "main", s2, p)) <= w, `푸터 폭 ${w}`);
  const f80 = F.footerLine(m, 80, cwd, "main", s2, p);
  assert.ok(f80.startsWith(` ${cwd}  main`) && f80.endsWith("작업 1개 실행 중") && t.visibleWidth(f80) === 80, f80);
  const f56 = plain(F.footerLine(m, 56, cwd, "main", s2, p));
  assert.equal(f56, " …/oxygen-pi-system  main  flow n4 · 할 일 2/5  ·  작업…", "56칸: 폴더를 먼저 줄인 뒤 상태를 뒤에서부터 자른다");
  const f40 = plain(F.footerLine(m, 40, cwd, "main", s2, p));
  assert.ok(f40.startsWith(" …/oxygen-pi-system  main") && f40.endsWith("…") && t.visibleWidth(f40) <= 40, `40칸: 그다음 상태를 자른다: ${f40}`);
  const longCwd = "C:/Users/Public/Documents/SomeVendor/CreatorTemp/tmp.BCZef74wW5/work";
  assert.ok(plain(F.footerLine(m, 80, longCwd, "main", ["jobs 1 · agents 0/2"], p)).endsWith("jobs 1 · agents 0/2"), "긴 폴더 때문에 상태가 사라지지 않는다 (2026-11-13 실측)");
  const f30 = plain(F.footerLine(m, 30, cwd, "main", s2, p));
  assert.equal(f30, " …/oxygen-pi-system  main", "좁으면 상태를 빼고 폴더를 마지막 단계로, 브랜치는 남긴다");
  assert.equal(F.footerLine(m, 80, cwd, undefined, [], p), ` ${cwd}`);
});

test("oxygen-pi-tui 도구 줄: 첫 줄 · 요약 · 접힘 · bash 결과 읽기 (pi-tui-spec §4 §7.4)", async () => {
  const { pathToFileURL } = await import("node:url");
  const t: any = await import(pathToFileURL(join(import.meta.dirname, "..", "vendor", "pi", "node_modules", "@earendil-works", "pi-tui", "dist", "index.js")).href);
  const Fr = await import("../agent/extensions/oxygen-pi-tui/tools/frame.ts");
  const B = await import("../agent/extensions/oxygen-pi-tui/tools/basic.ts");
  const { glyphs } = await import("../agent/extensions/oxygen-pi-tui/glyphs.ts");
  const m = { width: (s: string) => t.visibleWidth(s), trunc: (s: string, w: number, e = "…") => (t.visibleWidth(s) <= w ? s : t.truncateToWidth(s, w, e)) };
  const plain = (x: string) => x.replace(/\x1b\[[0-9;]*m/g, "");
  const p = { fg: (_k: string, s: string) => s, bold: (s: string) => s };
  const g = glyphs("unicode");
  assert.deepEqual([undefined, 400, 12_430, 63_000].map(Fr.fmtDuration), ["", "0.4s", "12.4s", "1m 3s"]);
  const c80 = Fr.callLine(m, g, 80, { status: "ok", title: "grep", args: "/registerTool/ in agent/extensions", durationMs: 200 }, p);
  assert.equal(t.visibleWidth(c80), 80);
  assert.match(c80, /^ ✓ grep \/registerTool\/ in agent\/extensions +0\.2s $/);
  assert.match(Fr.callLine(m, g, 80, { status: "running", title: "$", args: "sleep 12", durationMs: 5 }, p), /^ ○ \$ sleep 12 *$/, "실행 중에는 시간을 보이지 않는다");
  assert.match(Fr.callLine(m, g, 80, { status: "fail", title: "$", args: "false", durationMs: 30 }, p), /^ × \$ false/);
  for (const w of [20, 56]) {
    const cl = Fr.callLine(m, g, w, { status: "ok", title: "$", args: "echo 아주 긴 한글 명령 ".repeat(5), durationMs: 1234 }, p);
    assert.ok(t.visibleWidth(cl) <= w && cl.replace(/\x1b\[[0-9;]*m/g, "").endsWith("1.2s "), `넘쳐도 시간은 남긴다: ${cl}`);
  }
  const body = Array.from({ length: 20 }, (_, i) => `줄 ${i + 1}`);
  // 처음엔 3줄, 넘치면 "...N more lines (Ctrl + O for opening, Ctrl + K to fold)" (사용자, 2026-11-13)
  const head = Fr.resultLines(m, g, 80, { summary: "요약", body, keep: "head", max: 15, unit: "line" }, false, { open: "ctrl+o", fold: "ctrl+k" }, p);
  assert.deepEqual(head.map(plain), [" └ 요약", ...body.slice(0, 3).map((l) => `   ${l}`), "   ...17 more lines (Ctrl + O for opening, Ctrl + K to fold)"]);
  const tail = Fr.resultLines(m, g, 80, { summary: "요약", body, keep: "tail", max: 15, unit: "line" }, true, { open: "ctrl+o", fold: "ctrl+k" }, p);
  assert.deepEqual(tail.map(plain), [" └ 요약", "   ...5 more lines", ...body.slice(-15).map((l) => `   ${l}`)], "로그는 뒤를 보이고, 펼쳐도 상한을 넘으면 앞을 줄인다");
  assert.deepEqual(Fr.resultLines(m, g, 80, { summary: "s", body: ["a"], keep: "head", max: 5, unit: "line" }, false, { open: "ctrl+o", fold: "ctrl+k" }, p).map(plain), [" └ s", "   a"]);
  assert.deepEqual(Fr.resultLines(m, g, 80, { summary: "요약", body, keep: "tail", max: 15, unit: "line" }, false, { open: "ctrl+o", fold: "ctrl+k" }, p, true).map(plain), [" └ 요약"], "접음: 요약 줄만");
  assert.equal(plain(Fr.resultLines(m, g, 80, { summary: "s", body: ["a", "b", "c", "d"], keep: "head", max: 9, unit: "file" }, false, { open: "ctrl+o", fold: "ctrl+k" }, p).at(-1)!), "   ...1 more file (Ctrl + O for opening, Ctrl + K to fold)", "1 이면 단수");
  assert.deepEqual([Fr.keyLabel("ctrl+o"), Fr.keyLabel("ctrl+shift+e"), Fr.keyLabel("alt+enter")], ["Ctrl + O", "Ctrl + Shift + E", "Alt + Enter"]);
  // bash 결과 글 (pi 1.5.0 bash.js 형식)
  assert.deepEqual(B.parseBash("hello\nworld\n", false), { exit: 0, reason: undefined, lines: ["hello", "world"], truncated: undefined });
  assert.deepEqual(B.parseBash("(no output)", false).lines, []);
  const e1 = B.parseBash("oops\n\nCommand exited with code 2", true);
  assert.deepEqual([e1.exit, e1.lines], [2, ["oops"]]);
  assert.deepEqual(B.bashSummary(e1, false), { text: "Jobs failed.., print 1 line", level: "error" });
  assert.equal(B.parseBash("Command aborted", true).reason, "Jobs aborted..");
  assert.equal(B.parseBash("partial\n\nCommand timed out after 30 seconds", true).reason, "Jobs timed out after 30s..");
  assert.equal(B.parseBash("BLOCKED by oxy-bash-guard: npm install is not available offline\nmore", true).reason, "BLOCKED by oxy-bash-guard: npm install is not available offline");
  const tr = B.parseBash("29999\n30000\n\n[Showing lines 28001-30000 of 30000. Full output: C:/tmp/pi-bash-1.log]", false);
  assert.deepEqual([tr.lines, tr.truncated], [["29999", "30000"], { shown: "28001-30000", total: 30000, fullPath: "C:/tmp/pi-bash-1.log" }]);
  assert.deepEqual(B.bashSummary(B.parseBash("", false), false), { text: "Jobs done!, print 0 lines", level: "success" });
  assert.deepEqual(B.bashSummary(B.parseBash(Array.from({ length: 25 }, (_, i) => `l${i}`).join("\n"), false), false), { text: "Jobs done!, print 25 lines", level: "success" });
  assert.deepEqual(B.bashSummary(B.parseBash("a\nb", false), true), { text: "Jobs running.., print 2 lines", level: "text" });
  assert.equal(B.commandHead("echo a\necho b"), "echo a …");
  assert.equal(B.commandHead("  ls -la  "), "ls -la");
  assert.equal(B.commandHead(`cd "C:/Users/kim/workspace/proj/agent/extensions" && fd -e ts`), "cd …/extensions && fd -e ts");
  assert.equal(B.commandHead("cd src && rg -n x"), "cd src && rg -n x", "짧은 경로는 그대로");
  // read · edit · write
  assert.equal(B.readRange(undefined, undefined), "");
  assert.equal(B.readRange(10, 5), ":10-14");
  assert.equal(B.readRange(10, undefined), ":10-");
  assert.equal(B.readRange(undefined, 20), ":1-20");
  assert.equal(B.relPath(String.raw`C:\w\proj\src\a.ts`, "C:/w/proj"), "src/a.ts");
  assert.equal(B.relPath("@src/a.ts", "C:/w/proj"), "src/a.ts");
  assert.equal(B.relPath("D:/other/a.ts", "C:/w/proj", "C:/Users/kim"), "D:/other/a.ts");
  assert.equal(B.relPath("C:/Users/kim/ws/agent", "C:/w/proj", "C:/Users/kim"), "~/ws/agent", "작업 폴더 밖은 홈을 ~ 로");
  assert.deepEqual([B.lineCount(""), B.lineCount("a\nb\n"), B.lineCount("a\r\nb")], [0, 2, 2]);
  assert.deepEqual(B.diffStats("--- a\n+++ b\n@@\n-x\n+y\n+z\n ctx"), { added: 2, removed: 1 });
  assert.deepEqual(B.errorLines("Could not edit file: a.ts. not found.\n\ndetail"), { first: "Could not edit file: a.ts. not found.", rest: ["", "detail"] });
  assert.equal(B.textOf([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }]), "a\nb");
});

test("oxygen-pi-tui grep: 결과 글 읽기 · 파일별 묶음 · 강조 · 접힘/펼침 (pi-tui-spec §7.1)", async () => {
  const { pathToFileURL } = await import("node:url");
  const t: any = await import(pathToFileURL(join(import.meta.dirname, "..", "vendor", "pi", "node_modules", "@earendil-works", "pi-tui", "dist", "index.js")).href);
  const G = await import("../agent/extensions/oxygen-pi-tui/tools/grep.ts");
  const Fr = await import("../agent/extensions/oxygen-pi-tui/tools/frame.ts");
  const { glyphs } = await import("../agent/extensions/oxygen-pi-tui/glyphs.ts");
  const m = { width: (s: string) => t.visibleWidth(s), trunc: (s: string, w: number, e = "…") => (t.visibleWidth(s) <= w ? s : t.truncateToWidth(s, w, e)) };
  const p = { fg: (_k: string, s: string) => s, bold: (s: string) => s };
  const g = glyphs("unicode");
  assert.deepEqual(G.parseGrep("No matches found"), { files: [], matches: 0 });
  const out = [
    "oxy-flow/index.ts:195:   pi.registerTool({",
    "oxy-flow/index.ts:218:   pi.registerTool({",
    "oxy-jobs/index.ts:189:   pi.registerTool({ // 한글 주석",
    "oxy-monitor/v2-1/a.ts:7: registerTool",
  ].join("\n") + "\n\n[100 matches limit reached. Use limit=200 for more, or refine pattern]";
  const r = G.parseGrep(out)!;
  assert.deepEqual(r.files.map((f) => [f.path, f.matches]), [["oxy-flow/index.ts", 2], ["oxy-jobs/index.ts", 1], ["oxy-monitor/v2-1/a.ts", 1]]);
  assert.equal(r.matches, 4);
  assert.equal(r.files[2].lines[0].text, "registerTool", "경로 안의 -숫자- 를 줄 번호로 오해하지 않는다");
  assert.deepEqual(G.grepSummary(r, { matchLimitReached: 100 }), { text: "3개 파일에서 4개 결과", warn: "결과 100개에서 멈춤" });
  assert.deepEqual(G.grepSummary({ files: [], matches: 0 }, undefined), { text: "결과 없음", warn: "" });
  assert.equal(G.grepSummary(r, { linesTruncated: true, truncation: { truncated: true } }).warn, "크기 제한으로 잘림 · 일부 줄 잘림");
  // 문맥 줄: 겹친 블록의 같은 줄은 한 번, 일치가 이긴다
  const ctx = G.parseGrep(["a.ts-9- x", "a.ts:10: hit", "a.ts-11- y", "a.ts-10- hit", "a.ts:11: y", "a.ts-12- z"].join("\n"))!;
  assert.deepEqual(ctx.files[0].lines.map((l) => [l.n, l.match]), [[9, false], [10, true], [11, true], [12, false]]);
  assert.equal(ctx.matches, 2);
  assert.equal(G.parseGrep("이상한 모양의 글"), null, "모르는 모양이면 pi 기본 그리기로");
  // 강조
  const mark = (s: string) => `[${s}]`;
  assert.equal(G.highlight("a registerTool b registerTool", G.matcher("registerTool", {}), mark), "a [registerTool] b [registerTool]");
  assert.equal(G.highlight("A.B", G.matcher("a.b", { literal: true, ignoreCase: true }), mark), "[A.B]");
  assert.equal(G.matcher("(unclosed", {}), null);
  assert.equal(G.highlight("x", G.matcher("y*", {}), mark), "x", "빈 일치는 건너뛴다");
  // 첫 줄 인자
  assert.equal(G.grepArgs({ pattern: "registerTool" }, ""), "/registerTool/ in .");
  assert.equal(G.grepArgs({ pattern: "a.b", literal: true, glob: "*.ts", context: 2, limit: 50 }, "src"), '"a.b" in src (*.ts) ±2 limit 50');
  assert.equal(G.grepArgs({ pattern: "x", ignoreCase: true }, "src"), "/x/i in src");
  // 접힘: 파일마다 한 줄, 오른쪽 끝에 결과 수 / 펼침: 줄 번호 │ 내용
  const col = Fr.resultLines(m, g, 60, { summary: "s", body: G.grepCollapsed(m, r, p), keep: "head", max: 200, unit: "file" }, false, { open: "ctrl+o", fold: "ctrl+k" }, p);
  assert.equal(col[1], "   oxy-flow/index.ts" + " ".repeat(60 - 3 - 17 - 1) + "2");
  for (const l of col) assert.ok(t.visibleWidth(l) <= 60);
  const exp = G.grepExpanded(m, r, null, g.vbar, p).map((l) => (typeof l === "function" ? l(77) : l));
  assert.deepEqual(exp.slice(0, 3), ["oxy-flow/index.ts", "  195 │   pi.registerTool({", "  218 │   pi.registerTool({"]);
  const many = { files: Array.from({ length: 11 }, (_, i) => ({ path: `f${i}.ts`, matches: 1, lines: [{ n: 1, text: "x", match: true }] })), matches: 11 };
  const c11 = Fr.resultLines(m, g, 60, { summary: "s", body: G.grepCollapsed(m, many, p), keep: "head", max: 200, unit: "file" }, false, { open: "ctrl+o", fold: "ctrl+k" }, p);
  assert.equal(c11.at(-1), "   ...8 more files (Ctrl + O for opening, Ctrl + K to fold)");
  const narrow = G.grepCollapsed(m, { files: [{ path: "agent/extensions/oxygen-pi-tui/tools/아주긴폴더이름/grep.ts", matches: 12, lines: [] }], matches: 12 }, p);
  const nl = (narrow[0] as (w: number) => string)(30);
  assert.ok(t.visibleWidth(nl) <= 30 && nl.includes("…") && nl.endsWith("12"), `좁으면 경로 가운데를 줄인다: ${nl}`);
});

test("oxygen-pi-tui bash 안의 fd · rg: 명령 알아보기 · 폴더별 묶음 · rg 출력 읽기 (pi-tui-spec §7.2 §7.3)", async () => {
  const { pathToFileURL } = await import("node:url");
  const t: any = await import(pathToFileURL(join(import.meta.dirname, "..", "vendor", "pi", "node_modules", "@earendil-works", "pi-tui", "dist", "index.js")).href);
  const S = await import("../agent/extensions/oxygen-pi-tui/tools/search.ts");
  const B = await import("../agent/extensions/oxygen-pi-tui/tools/basic.ts");
  const m = { width: (s: string) => t.visibleWidth(s), trunc: (s: string, w: number, e = "…") => (t.visibleWidth(s) <= w ? s : t.truncateToWidth(s, w, e)) };
  const p = { fg: (_k: string, s: string) => s, bold: (s: string) => s };
  const kinds: [string, any][] = [
    ["fd -e sql", { tool: "fd" }],
    ["cd src && fd Controller", { tool: "fd" }],
    ['cd "my dir" && cd x && fd -t f . 2>/dev/null', { tool: "fd" }],
    ["rg -n registerTool agent", { tool: "rg", mode: "lines" }],
    ["rg -il todo", { tool: "rg", mode: "paths" }],
    ["rg --files src", { tool: "rg", mode: "paths" }],
    ["rg -c foo", { tool: "rg", mode: "count" }],
    ["rg --count-matches foo", { tool: "rg", mode: "count" }],
    ["rg --json foo", null],
    ["fd -e ts | wc -l", null],
    ["fd x; echo done", null],
    ["fd x > out.txt", null],
    ["ls && fd x", null],
    ["echo $(fd x)", null],
    ["fd a\nfd b", null],
    ["grep -rn x .", null],
    ["fdisk -l", null],
  ];
  for (const [cmd, want] of kinds) assert.deepEqual(S.searchCommand(cmd), want, cmd);
  // fd: 바로 위 폴더별, 처음 나온 순서
  const fd = S.groupPaths(["src/db/001_init.sql", "src/report/r.sql", "src/db/002_users.sql", "top.sql", "./src/db/003.sql", "src/db/sub/", ""]);
  assert.deepEqual(fd.groups.map((g) => [g.dir, g.names.length]), [["src/db/", 4], ["src/report/", 1], ["./", 1]]);
  assert.deepEqual([fd.files, fd.dirs], [5, 1]);
  assert.equal(S.pathsSummary(fd), "폴더 3개에 파일 5개");
  assert.equal(S.pathsSummary(S.groupPaths([])), "찾은 파일 없음");
  assert.equal(S.pathsSummary(S.groupPaths(["a/", "b/"])), "폴더 2개");
  const col = S.pathsCollapsed(m, fd, p).map((f) => (f as (w: number) => string)(40));
  assert.equal(col[0], "src/db/" + " ".repeat(40 - 7 - 1) + "4");
  const exp = S.pathsExpanded(m, fd, p)(40);
  assert.equal(exp[0], "src/db/");
  assert.ok(exp[1].startsWith("  001_init.sql") && exp.every((l) => t.visibleWidth(l) <= 40), JSON.stringify(exp));
  assert.ok(S.pathsExpanded(m, fd, p)(20).length > exp.length, "좁으면 이름 줄이 늘어난다");
  // rg 출력
  const rl = S.parseRgLines(["a/oxy-flow/index.ts:195:  pi.registerTool({", "a/oxy-flow/index.ts-196-  name: x", "--", "b.ts:3:x"])!;
  assert.deepEqual(rl.files.map((f) => [f.path, f.matches, f.lines.map((l) => [l.n, l.match])]), [["a/oxy-flow/index.ts", 1, [[195, true], [196, false]]], ["b.ts", 1, [[3, true]]]]);
  const rn = S.parseRgLines(["a.ts:const x = {a:1}", "C:/w/b.ts:y"])!;
  assert.deepEqual(rn.files.map((f) => [f.path, f.lines[0].n, f.lines[0].text]), [["a.ts", 0, "const x = {a:1}"], ["C:/w/b.ts", 0, "y"]]);
  assert.deepEqual(S.parseRgCount(["a.ts:2", "b/c.ts:10"])!.matches, 12);
  assert.equal(S.parseRgCount(["a.ts"]), null);
  // bash 결과 → 보기. rg 가 결과 없이 1로 끝나면 실패가 아니다
  const none = S.searchView(m, { tool: "rg", mode: "lines" }, B.parseBash("Command exited with code 1", true), false, p)!;
  assert.deepEqual([none.view.summary, none.ok], ["결과 없음", true]);
  assert.equal(S.searchView(m, { tool: "rg", mode: "lines" }, B.parseBash("regex parse error\n\nCommand exited with code 2", true), false, p), null, "rg 오류(2)는 일반 bash 그리기");
  assert.equal(S.searchView(m, { tool: "fd" }, B.parseBash("Command aborted", true), false, p), null);
  const fv = S.searchView(m, { tool: "fd" }, B.parseBash("src/a.ts\nsrc/b.ts\nlib/c.ts\n", false), false, p)!;
  assert.equal(fv.view.summary, "폴더 2개에 파일 3개");
  const cv = S.searchView(m, { tool: "rg", mode: "count" }, B.parseBash("a.ts:2\nb.ts:5", false), false, p)!;
  assert.equal(cv.view.summary, "2개 파일에서 7개 결과");
  assert.equal(S.searchView(m, { tool: "rg", mode: "lines" }, B.parseBash("이상한 줄", false), false, p), null, "읽을 수 없는 출력은 일반 bash 그리기");
});

test("oxygen-pi-tui 헤더 = 웰컴 카드: 폭 · 배너 · 부제 글자 두 줄 · 저장소 주소 · 푸터와 겹치는 것 없음 (pi-tui-spec §3)", async () => {
  const { pathToFileURL } = await import("node:url");
  const t: any = await import(pathToFileURL(join(import.meta.dirname, "..", "vendor", "pi", "node_modules", "@earendil-works", "pi-tui", "dist", "index.js")).href);
  const H = await import("../agent/extensions/oxygen-pi-tui/header.ts");
  const { glyphs } = await import("../agent/extensions/oxygen-pi-tui/glyphs.ts");
  const { widthClass } = await import("../agent/extensions/oxygen-pi-tui/layout.ts");
  const m = { width: (s: string) => t.visibleWidth(s), trunc: (s: string, w: number, e = "…") => (t.visibleWidth(s) <= w ? s : t.truncateToWidth(s, w, e)) };
  const plain = (x: string) => x.replace(/\x1b\[[0-9;]*m/g, "");
  const id = (s: string) => s;
  const env = { mode: "truecolor" as const, appearance: "dark" as const };
  const p = { brand: id, pi: id, frame: id, text: id, muted: id, accent: id, sub: (s: string) => `<${s}>`, env };
  const h = { version: "0.1.0" };
  const g = glyphs("unicode");
  // 배너: banner.rs 의 큰 배너와 같은 글자 (앞 여백 2칸 뺀 57칸, 6줄)
  const banner = H.bannerLines({ ...env, noColor: true });
  assert.equal(banner.length, 6);
  for (const l of banner) assert.equal(t.visibleWidth(l), H.BANNER_WIDTH);
  assert.ok(banner[0].startsWith(" ██████╗ ▀▀▄    ") && banner[0].endsWith("██████╗ ██╗") && banner[5].endsWith("╚═╝     ╚═╝"), `배너 글자: ${banner.join(" / ")}`);
  assert.deepEqual(H.SUBTITLE, ["Lite Weight Coding Agent", "For Closed Network"]);
  assert.equal(H.REPO_URL, "https://github.com/Salvia95/oxygen-pi-system");
  for (const w of [30, 40, 56, 63, 64, 80, 99, 100, 120, 160]) {
    const ls = H.headerLines(m, g, w, widthClass(w), h, p);
    for (const l of ls) assert.equal(t.visibleWidth(l), w, `카드 폭 ${w}: ${plain(l)}`);
    const all = ls.map(plain).join("\n");
    assert.ok(plain(ls[0]).startsWith("╭─ ◆ Oxygen Pi 0.1.0 ") && plain(ls.at(-1)!).startsWith("╰"), `테두리 ${w}`);
    assert.equal(all.includes("██████"), w >= 64, `배너는 64칸부터 ${w}`);
    assert.ok(all.includes("<Lite Weight Coding Agent>") && all.includes("<For Closed Network>"), `부제 두 줄은 같은 색 ${w}`);
    if (w >= 48) assert.ok(all.includes(H.REPO_URL), `저장소 주소 ${w}`);
    assert.ok(!/[┬┴]/.test(all), `오른쪽 열은 두지 않는다 ${w}`);
    assert.ok(!all.includes("무엇을 도와드릴까요") && !all.includes("/jobs"), `안내 · 명령은 넣지 않는다 ${w}`);
  }
  // 80×24: 13줄 (테두리 2 + 배너 6 + 빈 줄 + 부제 2 + 빈 줄 + 저장소)
  assert.equal(H.headerLines(m, g, 80, "normal", h, p).length, 13);
  assert.equal(H.headerLines(m, g, 56, "narrow", h, p).length, 6, "좁으면 배너 없이 부제 · 저장소");
  assert.deepEqual(Object.keys(h), ["version"], "모델 · 폴더 · 브랜치는 받지 않는다 (푸터 · 입력창 테두리와 겹침)");
  assert.deepEqual(H.headerLines(m, g, 29, "narrow", h, p), [], "너무 좁으면 그리지 않는다");
  for (const l of H.headerLines(m, glyphs("ascii"), 120, "wide", h, p)) assert.equal(t.visibleWidth(l), 120);
});

test("oxygen-pi-tui background 도구 줄: 첫 줄 인자 · 결과 요약 (ui-unify-spec §2.5)", async () => {
  const J = await import("../agent/extensions/oxygen-pi-tui/tools/jobs.ts");
  assert.equal(J.backgroundArgs({ action: "start", command: "npm run build\nnpm test" }), "start npm run build …");
  assert.equal(J.backgroundArgs({ action: "status" }), "status");
  assert.equal(J.backgroundArgs({ action: "output", id: "job-2" }), "output job-2");
  assert.equal(J.backgroundArgs({ action: "stop", id: "job-2" }), "stop job-2");
  const v = (a: string, t: string) => { const x = J.backgroundView(a, t); return [x.summary, x.level, x.body, x.keep]; };
  assert.deepEqual(v("start", "Started job-1: sleep 60\nYou will get a message when it finishes. Do not poll; continue with other work or end your turn."),
    ["job-1 시작 · 끝나면 알림", "success", [], "head"]);
  assert.deepEqual(v("status", "No jobs."), ["작업 없음", "text", [], "head"]);
  assert.deepEqual(v("status", "job-1 bash running 0:41 npm run build\njob-2 agent done exit=0 2:12 scout: 찾기"),
    ["작업 2개 · 1개 실행 중", "text", ["job-1 bash 실행 중 0:41 npm run build", "job-2 agent 끝남 exit=0 2:12 scout: 찾기"], "head"]);
  assert.deepEqual(v("output", "job-1 failed\nline a\nline b\n"), ["job-1 실패 · 출력 2줄", "error", ["line a", "line b"], "tail"]);
  assert.deepEqual(v("stop", "Stopped job-1."), ["job-1 중지함", "success", [], "head"]);
  assert.deepEqual(v("stop", "job-1 is not running (done)."), ["job-1: 실행 중이 아님 (끝남)", "warning", [], "head"]);
});

test("psmux 서버 · 세션 못 박기: $TMUX 의 서버 이름 · -t %N 에 세션 붙이기 · 기본 서버로 넘어간 대답은 버림 (_lib/psmux.ts)", async () => {
  const M = await import("../agent/extensions/_lib/psmux.ts");
  assert.equal(M.serverFromTmux("/tmp/psmux-12976/oxy,56571,0"), "oxy");
  assert.equal(M.serverFromTmux("/tmp/psmux-1/default,1,0"), "default");
  assert.equal(M.serverFromTmux(undefined), null);
  assert.equal(M.serverFromTmux("garbage"), null);
  const t = { server: "oxy", session: "oxy-app-1a2b" };
  assert.deepEqual(M.pinArgs(["split-window", "-t", "%1", "-h", "-d", "-P", "-F", "#{pane_id}", "cmd"], t),
    ["-L", "oxy", "split-window", "-t", "oxy-app-1a2b:.%1", "-h", "-d", "-P", "-F", "#{pane_id}", "cmd"]);
  assert.deepEqual(M.pinArgs(["kill-pane", "-t", "%48"], t), ["-L", "oxy", "kill-pane", "-t", "oxy-app-1a2b:.%48"]);
  assert.deepEqual(M.pinArgs(["-L", "x", "list-panes", "-t", "%1"], t), ["-L", "x", "list-panes", "-t", "oxy-app-1a2b:.%1"], "이미 -L 이 있으면 서버는 그대로");
  assert.deepEqual(M.pinArgs(["set-option", "-p", "-t", "%3", "@oxy_monitor", "jobs"], t)[5], "oxy-app-1a2b:.%3");
  // 세션 찾기: 런처가 넘긴 OXY_MUX_SESSION 이 먼저
  const env = { TMUX: "/tmp/psmux-12976/oxy,56571,0", TMUX_PANE: "%1" };
  const never = () => { throw new Error("psmux 를 부르지 않아야 함"); };
  M.resetMuxCache();
  assert.deepEqual(M.resolveMuxTarget("psmux.exe", { ...env, OXY_MUX_SESSION: "oxy-app-1a2b" }, never), t);
  // 없으면 $TMUX 로 묻되, 기본 서버가 대답하면(넘어감) 버리고 다시 묻는다
  M.resetMuxCache();
  const answers = ["C:\\Users\\kim\\.psmux/default\tdecoy", "C:\\Users\\kim\\.psmux/oxy\toxy-app-1a2b"];
  let calls = 0;
  const spawn = (_exe: string, args: string[]) => { assert.ok(!args.includes("-L"), "세션은 $TMUX 로 묻는다"); return { status: 0, stdout: answers[calls++] + "\n" }; };
  assert.deepEqual(M.resolveMuxTarget("psmux.exe", env, spawn), t);
  assert.equal(calls, 2, "기본 서버의 대답(decoy)은 버렸다");
  // 세 번 모두 기본 서버면 null (엉뚱한 세션에 열지 않는다)
  M.resetMuxCache();
  assert.equal(M.resolveMuxTarget("psmux.exe", env, () => ({ status: 0, stdout: "C:/x/.psmux/default\tdecoy" })), null);
  assert.equal(M.resolveMuxTarget("psmux.exe", { TMUX_PANE: "%1" }, never), null, "psmux 밖");
  M.resetMuxCache();
});

test("oxy-flow 작업 저장소: pi 를 다른 폴더(git 아님)에서 시작해도 실제로 고치는 저장소의 커밋을 노드로 (flow-spec 작업 저장소)", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { execFileSync } = await import("node:child_process");
  const S = await import("../agent/extensions/oxy-flow/store.ts");
  const box = mkdtempSync(join(tmpdir(), "oxy-flow-work-"));
  const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    const start = join(box, "cozy-example"), app = join(box, "library-rental");
    mkdirSync(start); mkdirSync(app);
    g(app, "init", "-q"); g(app, "config", "user.email", "t@t"); g(app, "config", "user.name", "t");
    writeFileSync(join(app, "pom.xml"), "<a/>\n"); g(app, "add", "."); g(app, "commit", "-qm", "init");
    const e = new S.FileFlowEngine(start);
    try {
      assert.equal(e.load().baseCommit, null, "시작한 폴더는 git 저장소가 아니다");
      assert.equal(S.repoOf(join(start, "x.txt")), null);
      assert.ok(S.repoOf(join(app, "src", "new", "File.java"))?.toLowerCase().endsWith("library-rental"), "아직 없는 파일도 저장소를 찾는다");
      // 다른 저장소의 파일을 고치면 작업 저장소가 그리로 옮겨 가고, 그때의 HEAD 부터 커밋을 찾는다
      assert.equal(e.noteWorkPath(join(app, "pom.xml")), true);
      assert.equal(e.noteWorkPath(join(app, "src", "A.java")), false, "같은 저장소면 그대로");
      assert.ok(e.workRoot().toLowerCase().endsWith("library-rental"));
      assert.equal(e.load().work?.baseCommit, g(app, "rev-parse", "HEAD"));
      assert.deepEqual(e.syncCommits(false), [], "아직 새 커밋 없음");
      writeFileSync(join(app, "pom.xml"), "<b/>\n"); g(app, "commit", "-qam", "feat: events");
      const made = e.syncCommits(false);
      assert.deepEqual(made.map((n) => [n.id, n.title, n.files]), [["n1", "feat: events", ["pom.xml"]]]);
      assert.ok(made[0].repo?.toLowerCase().endsWith("library-rental"), "노드에 저장소를 남긴다");
      assert.match(S.renderContext(e.load()), /Work repository: .*library-rental/);
      // 기록은 pi 를 시작한 폴더에 남는다 (모니터는 그 폴더로 찾는다)
      assert.ok(e.dir.replace(/\\/g, "/").includes("cozy-example/.oxy/flow"));
    } finally { e.release(); }
    // bash 의 cd · git -C 에서 폴더 찾기
    assert.deepEqual(S.commandDirs("cd C:/w/library-rental && mvn -q verify"), ["C:/w/library-rental"]);
    assert.deepEqual(S.commandDirs(`cd "/c/my dir/app" && git status; cd sub && ls`), ["/c/my dir/app", "sub"]);
    assert.deepEqual(S.commandDirs("git -C ../lib commit -m x"), ["../lib"]);
    assert.deepEqual(S.commandDirs("echo cd nope; abcd x; cd $HOME"), []);
  } finally { rmSync(box, { recursive: true, force: true }); }
});
