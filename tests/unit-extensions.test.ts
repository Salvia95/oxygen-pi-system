// oxy extension 순수 로직 단위 테스트 (외부 의존성 없음)
//   node --experimental-strip-types --test tests/unit-extensions.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect, muxPayloads, splitSegments } from "../agent/extensions/oxy-bash-guard.ts";
import { clip } from "../agent/extensions/oxy-context-budget.ts";
import { pathKey } from "../agent/extensions/_lib/common.ts";

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

test("clip: 앞/뒤 보존 + 안내", () => {
  const s = "H".repeat(100) + "M".repeat(1000) + "T".repeat(100);
  const out = clip(s, 200, "narrow it");
  assert.ok(out.startsWith("H".repeat(100)) && out.endsWith("T".repeat(80)));
  assert.match(out, /1000 characters omitted.*narrow it/);
  assert.equal(clip("short", 200, "x"), "short");
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

test("models.json: 서버가 거부한 vLLM 확장 파라미터만 뺀다 (OXY_VLLM_DROP_PARAMS)", async () => {
  const { renderConfig } = await import("../scripts/render-config.mjs");
  const { mkdtempSync, cpSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "oxyrc-"));
  const vars = { OXY_VLLM_BASE_URL: "http://x/v1", OXY_MODEL_CODER: "c", OXY_MODEL_GENERAL: "g", OXY_DEFAULT_MODEL: "c", OXY_CONTEXT_WINDOW: "131072", OXY_SHELL_PATH: "C:/bash.exe" };
  const models = (extra: Record<string, string>) => {
    renderConfig(dir, { ...vars, ...extra });
    return Object.fromEntries(JSON.parse(readFileSync(join(dir, "models.json"), "utf8")).providers["oxy-vllm"].models.map((m: any) => [m.id, m]));
  };
  try {
    cpSync(join(import.meta.dirname, "..", "agent", "templates"), join(dir, "templates"), { recursive: true });
    let m = models({});
    assert.equal(m.c.samplingParams.repetition_penalty, 1.05);
    assert.equal(m.g.compat.thinkingFormat, "qwen-chat-template");
    m = models({ OXY_VLLM_DROP_PARAMS: "repetition_penalty" });       // 사내 게이트웨이에서 실제로 거부된 값
    assert.equal(m.c.samplingParams.repetition_penalty, undefined);
    assert.equal(m.c.samplingParams.top_k, 20);                          // 받아 주는 것은 남긴다
    assert.equal(m.g.reasoning, true);
    m = models({ OXY_VLLM_DROP_PARAMS: "top_k, repetition_penalty,chat_template_kwargs,bogus" });
    assert.deepEqual(m.c.samplingParams, { temperature: 0.7, top_p: 0.8 });
    assert.equal(m.g.reasoning, false);
    assert.equal(m.g.compat, undefined);
    assert.deepEqual(m.g.samplingParams, { temperature: 0.7, top_p: 0.8 });   // thinking 끈 상태의 샘플링
    m = models({ OXY_MAX_OUTPUT_TOKENS: "1000" });                     // 분당 출력 토큰 제한이 있는 엔드포인트
    assert.equal(m.c.maxTokens, 1000);
    assert.equal(m.g.maxTokens, 1000);
    const st = () => JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
    assert.equal(st().enabledModels[0], "oxy-vllm/**");                  // 모델 id 에 / 가 있어도 일치 (qwen/qwen3.8-27b)
    assert.equal(st().retry.provider.maxRetries ?? 0, 0);
    models({ OXY_PROVIDER_RETRIES: "4" });
    assert.equal(st().retry.provider.maxRetries, 4);
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
