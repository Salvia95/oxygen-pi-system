// oxy extension 순수 로직 단위 테스트 (외부 의존성 없음)
//   node --experimental-strip-types --test tests/unit-extensions.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect, splitSegments } from "../agent/extensions/oxy-bash-guard.ts";
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
});

test("허용: 일반 개발 명령", () => {
  for (const c of [
    "ls -la", "rm file.txt", "rm -f a.log", "git status", "git push --help | head", "git commit -m 'update x set'",
    "glab mr list", "glab mr view 3", "glab api projects/1/merge_requests --paginate", "glab mr list -F json", "npm test", "npm run build", "pip list", "fd -e ts | xargs rg foo",
    `sql -S u/p@db <<'EOF'\nselect * from emp where name like 'update%';\nEOF`,
    "echo 'npm install'", "rg 'rm -rf /' src",
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
