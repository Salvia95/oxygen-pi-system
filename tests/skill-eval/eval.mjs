// skill 선택 시험: pi 가 만든 첫 요청 본문(variant 별)에서 사용자 메시지만 바꿔 실제 모델에 보내고,
// 첫 응답이 어떤 skills/<name>/SKILL.md 를 read 하는지 판정한다.
//   node eval.mjs <out.json> <variantName>=<request.json> ...   (env: OXY_VLLM_BASE_URL, OXY_VLLM_API_KEY, OXY_MODEL_CODER)
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const CASES = [
  [1, "P", "src 아래에서 지난 일주일 사이에 바뀐 .java 파일 목록과, 그중 TODO가 몇 개씩 있는지 세어줘", { want: "find-code" }],
  [2, "N", "UserService 클래스가 어디에 정의돼 있는지 찾아줘", { not: "find-code" }],
  [3, "P", "주석이나 문자열은 빼고, 코드에서 userRepo.findById(...)를 호출하는 곳만 전부 찾아줘", { want: "structural-code-search" }],
  [4, "N", "OrderService.java 안의 calculateTotal 메서드 이름을 computeTotal로 바꿔줘 (그 파일 안에서만)", { not: "structural-code-search" }],
  [5, "P", "node REPL을 띄워서 .help를 입력한 결과 화면을 보여줘", { want: "terminal-session-control" }],
  [6, "N", "npm test를 실행해서 결과를 알려줘", { not: "terminal-session-control" }],
  [7, "P", "이 프로젝트 justfile에 있는 작업 중 테스트를 돌리는 걸 찾아서 실행해줘", { want: "project-task-running" }],
  [8, "N", "Gradle 프로젝트야. ./gradlew build로 빌드해줘", { not: "project-task-running" }],
  [9, "P", "api-response.json에서 status가 FAILED인 항목의 id만 뽑아서 CSV로 만들어줘", { want: "json-querying" }],
  [10, "N", "package.json 내용 좀 보여줘", { not: "json-querying" }],
  [11, "P", "내 MR 중에 파이프라인이 실패한 게 있는지 확인하고, 실패한 잡 로그를 요약해줘", { want: "gitlab-workflow" }],
  [12, "N", "지금 변경사항을 커밋하고 feature/login 브랜치를 만들어줘", { not: ["gitlab-workflow", "github-workflow"] }],
  [13, "P", "GitHub의 PR #42에 달린 리뷰 코멘트를 정리해줘", { want: "github-workflow" }],
  [14, "N", "사내 GitLab의 MR !17에 달린 코멘트를 보여줘", { not: "github-workflow", alt: "gitlab-workflow" }],
  [15, "P", "PostgreSQL 연결 pgmain에서 orders 테이블의 최근 10건을 조회해줘", { want: "sql-querying" }],
  [16, "N", "Oracle의 PKG_BILLING 패키지 PL/SQL 소스를 보여줘", { not: "sql-querying", alt: "oracle-db-querying" }],
  [17, "P", "Oracle의 EMP 테이블 DDL을 뽑아줘", { want: "oracle-db-querying" }],
  [18, "N", "SQLite 파일 app.db의 users 테이블 행 수를 알려줘", { not: "oracle-db-querying", alt: "sql-querying" }],
  [19, "P", "http://api.internal:8080/health가 200을 돌려주는지 확인하는 테스트를 만들어서 실행해줘", { want: "http-api-testing" }],
  [20, "N", "사내 위키 http://wiki.internal/onboarding에 뭐라고 써 있는지 요약해줘", { not: "http-api-testing", alt: "web-page-reading" }],
  [21, "P", "http://wiki.internal/release-notes 페이지의 링크 목록을 뽑아줘", { want: "web-page-reading" }],
  [22, "N", "http://admin.internal에 로그인해서 설정 화면 스크린샷을 찍어줘", { not: "web-page-reading", alt: "web-page-automation" }],
  [23, "P", "http://app.internal/signup에서 회원가입 폼을 채워 제출하고 결과 화면을 확인해줘", { want: "web-page-automation" }],
  [24, "N", "http://api.internal/v1/users가 돌려주는 JSON을 확인해줘", { not: "web-page-automation", alt: "http-api-testing" }],
  [25, "G", "이 함수가 하는 일을 설명해줘: function add(a,b){return a+b}", { none: true }],
  [26, "G", "sum.js를 읽고 버그가 있으면 고쳐줘", { none: true }],
  [27, "G", "git의 rebase와 merge 차이를 짧게 설명해줘", { none: true }],
  [28, "G", "README.md에 설치 방법 절을 추가해줘", { none: true }],
];

const [outFile, ...variantArgs] = process.argv.slice(2);
const variants = variantArgs.map((a) => { const i = a.indexOf("="); return [a.slice(0, i), JSON.parse(readFileSync(a.slice(i + 1), "utf8"))]; });
const base = process.env.OXY_VLLM_BASE_URL, key = process.env.OXY_VLLM_API_KEY, model = process.env.OXY_MODEL_CODER;
const results = existsSync(outFile) ? JSON.parse(readFileSync(outFile, "utf8")) : [];
const done = new Set(results.map((r) => `${r.variant}#${r.id}`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function ask(body) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const r = await fetch(`${base}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const text = await r.text();
    if (r.ok) return JSON.parse(text);
    if (r.status === 429 || r.status >= 500) {
      const ra = Number(r.headers.get("retry-after")) || Number(text.match(/try again in ([\d.]+)s/)?.[1]) || 30;
      log(`  ${r.status} → ${Math.ceil(ra)}s 대기`);
      await sleep((ra + 2) * 1000);
      continue;
    }
    return { error: `${r.status} ${text.slice(0, 200)}` };
  }
  return { error: "retries exhausted" };
}

for (const [name, tpl] of variants) {
  for (const [id, kind, prompt, exp] of CASES) {
    if (done.has(`${name}#${id}`)) continue;
    const body = structuredClone(tpl);
    delete body.stream; delete body.stream_options;
    body.model = model;
    const last = body.messages.findLastIndex((m) => m.role === "user");
    body.messages = [...body.messages.slice(0, last), { role: "user", content: prompt }];
    const res = await ask(body);
    const msg = res.choices?.[0]?.message ?? {};
    const calls = (msg.tool_calls ?? []).map((c) => { let a = {}; try { a = JSON.parse(c.function.arguments || "{}"); } catch { /* 무시 */ } return { name: c.function.name, args: a }; });
    const read = calls.flatMap((c) => [String(c.args.path ?? ""), String(c.args.command ?? "")])
      .flatMap((s) => [...s.matchAll(/skills[\\/]+([\w-]+)[\\/]+SKILL\.md/gi)].map((m) => m[1]));
    const nots = [exp.not ?? []].flat();
    const pass = exp.want ? read.includes(exp.want) : exp.none ? read.length === 0 : !nots.some((n) => read.includes(n));
    const r = { variant: name, id, kind, prompt, expect: exp, read, first: calls.map((c) => c.name), text: String(msg.content ?? "").slice(0, 160), error: res.error ?? null, pass, altOk: exp.alt ? read.includes(exp.alt) : null };
    results.push(r);
    writeFileSync(outFile, JSON.stringify(results, null, 1));
    log(`${name} #${id} ${kind} ${pass ? "PASS" : "FAIL"} read=[${read}] first=[${r.first}]${r.error ? " ERR " + r.error : ""}`);
  }
}

// 요약
const lines = ["| # | 종류 | 기대 | " + variants.map(([n]) => n).join(" | ") + " |", "|---|---|---|" + variants.map(() => "---|").join("")];
for (const [id, kind, , exp] of CASES) {
  const cell = (n) => { const r = results.find((x) => x.variant === n && x.id === id); if (!r) return "-"; return `${r.pass ? "✓" : "✗"} ${r.read.join(",") || (r.first.length ? r.first.join(",") : "답변")}${r.altOk === false ? " (대체 skill 안 읽음)" : ""}`; };
  lines.push(`| ${id} | ${kind} | ${exp.want ?? (exp.none ? "skill 없음" : "not " + [exp.not].flat().join("/"))} | ${variants.map(([n]) => cell(n)).join(" | ")} |`);
}
for (const [n] of variants) {
  const rs = results.filter((r) => r.variant === n);
  const by = (k) => rs.filter((r) => r.kind === k);
  lines.push("", `${n}: 전체 ${rs.filter((r) => r.pass).length}/${rs.length} · P ${by("P").filter((r) => r.pass).length}/${by("P").length} · N ${by("N").filter((r) => r.pass).length}/${by("N").length} · G ${by("G").filter((r) => r.pass).length}/${by("G").length} · N 의 대체 skill 적중 ${rs.filter((r) => r.altOk).length}/${rs.filter((r) => r.altOk !== null).length}`);
}
writeFileSync(outFile.replace(/\.json$/, ".md"), lines.join("\n") + "\n");
log("완료"); console.log(lines.join("\n"));
