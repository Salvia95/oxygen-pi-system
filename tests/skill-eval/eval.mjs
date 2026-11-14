// skill 선택 시험: pi 가 만든 첫 요청 본문(variant 별)에서 사용자 메시지만 바꿔 실제 모델에 보내고,
// 첫 응답이 어떤 skills/<name>/SKILL.md 를 read 하는지 판정한다.
//   node eval.mjs <out.json> <variantName>=<request.json> ...   (env: OXY_VLLM_BASE_URL, OXY_VLLM_API_KEY, OXY_MODEL_CODER)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
  // 2026-11-14 설치본 Haiku 세션(Java 앱 · 개발 서버 · SQLite)에서 skill 을 읽지 않고 curl · bash grep · cat 을 쓴 상황.
  // avoid: 첫 응답의 bash 명령에 이 습관(oxy-tool-hints 판정: bash-grep 파일 검색 · bash-cat 소스 읽기 · curl)이 있으면 실패
  [29, "P", "개발 서버(http://127.0.0.1:8080)에서 /loan/new 폼으로 대여를 신청하면 서버가 어떤 상태 코드와 이동 위치를 돌려주는지 확인해줘", { want: "http-api-testing" }],
  [30, "P", "개발 서버를 띄워 뒀어. http://localhost:8080/api/books 가 200과 책 목록 JSON을 주는지 확인해줘", { want: "http-api-testing" }],
  [31, "P", "작업 폴더의 data/library.db에서 아직 반납 안 된 대여 행들을 보여줘", { want: "sql-querying" }],
  [32, "N", "LoanService의 isOverdue가 어디서 호출되는지 찾아줘", { not: "structural-code-search", avoid: "bash-grep" }],
  [33, "G", "src/main/resources/application.yml의 server.port를 9090으로 바꿔줘", { none: true, avoid: "bash-cat" }],
  [34, "G", "pom.xml에 적힌 sqlite-jdbc 버전이 뭐야?", { none: true, avoid: "bash-cat" }],
  [35, "N", "http://127.0.0.1:8080/loan/overdue 화면이 어떻게 보이는지 스크린샷으로 확인해줘", { not: "http-api-testing", alt: "web-page-automation" }],
  [36, "N", "mvn spring-boot:run으로 개발 서버를 띄워 두고, 뜨면 알려줘", { not: ["http-api-testing", "terminal-session-control"] }],
];

const [outFile, ...variantArgs] = process.argv.slice(2);
const variants = variantArgs.map((a) => { const i = a.indexOf("="); return [a.slice(0, i), JSON.parse(readFileSync(a.slice(i + 1), "utf8"))]; });
// 판정 모델: 환경변수가 있으면 그것, 없으면 agent/llm.json 의 기본 모델과 그 연결 (키는 secrets.json 에서 이 프로세스 안에서만 복호화)
// SKILL_EVAL_LLM_FROM=<agent 폴더> + SKILL_EVAL_TARGET=<연결/모델[:thinking]>: 그 폴더의 llm.json · secrets.json(DPAPI) 연결로. Anthropic 연결이면 /v1/messages 로
//   (요청 본문은 capture-claude.mjs 가 잡은 pi 의 첫 /v1/messages 본문. thinking 은 그 본문에 이미 들어 있다)
async function judge() {
  if (process.env.OXY_VLLM_BASE_URL) return { base: process.env.OXY_VLLM_BASE_URL, key: process.env.OXY_VLLM_API_KEY, model: process.env.OXY_MODEL_CODER };
  const root = new URL("../../", import.meta.url);
  const L = await import(new URL("scripts/llm-connections.mjs", root).href);
  const S = await import(new URL("installer/secrets.mjs", root).href);
  if (process.env.SKILL_EVAL_LLM_FROM) {
    const from = process.env.SKILL_EVAL_LLM_FROM, t = process.env.SKILL_EVAL_TARGET ?? "";
    const llm = L.loadLlm(from);
    const conn = L.findConnection(llm, t.slice(0, t.indexOf("/")));
    const m = t.slice(t.indexOf("/") + 1).split(":")[0];
    if (!conn || !L.findModel(conn, m)) throw new Error(`SKILL_EVAL_TARGET ${t} 이 ${from}/llm.json 에 없음`);
    const api = L.LLM_KINDS[conn.kind]?.api;
    return { base: (conn.baseUrl || L.LLM_KINDS[conn.kind].baseUrl).replace(/\/+$/, ""), key: S.getSecrets(from, [L.secretKey(conn.id)])[L.secretKey(conn.id)] ?? "",
      model: m, label: t, anthropic: api === "anthropic-messages", headers: L.workspaceHeaders(conn) };
  }
  const agent = fileURLToPath(new URL("agent/", root));
  const llm = L.loadLlm(agent);
  const conn = L.findConnection(llm, llm?.main?.connection);
  if (!conn || L.LLM_KINDS[conn.kind]?.api !== "openai-completions") throw new Error("기본 모델이 OpenAI 호환 연결이 아님 (이 판정은 /chat/completions 를 쓴다)");
  return { base: conn.baseUrl, key: S.getSecrets(agent, [L.secretKey(conn.id)])[L.secretKey(conn.id)] ?? "EMPTY", model: llm.main.model };
}
const J = await judge();
const { base, key, model } = J;
const { scrub } = await import(new URL("../scenario-eval/scrub.mjs", import.meta.url).href);   // 기록은 저장소에 올라가므로 계정 이름 · 임시 경로를 지운다
const { detectHints } = await import(new URL("../../agent/extensions/oxy-tool-hints.ts", import.meta.url).href);
const results = existsSync(outFile) ? JSON.parse(readFileSync(outFile, "utf8")) : [];
const done = new Set(results.map((r) => `${r.variant}#${r.id}`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function ask(body, extra = {}) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const r = J.anthropic
      ? await fetch(`${base}/v1/messages`, { method: "POST", headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json", ...J.headers, ...extra }, body: JSON.stringify(body) })
      : await fetch(`${base}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const text = await r.text();
    if (r.ok) return JSON.parse(text);
    if (r.status === 429 || r.status === 529 || r.status >= 500) {
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
    const extra = Object.fromEntries(Object.entries(body.__headers ?? {}).filter(([, v]) => v));   // capture-claude.mjs 가 잡은 anthropic-beta 등
    delete body.__headers; delete body.stream; delete body.stream_options;
    body.model = model;
    const last = body.messages.findLastIndex((m) => m.role === "user");
    // Anthropic: 마지막 user 를 바꾸고 그 뒤의 pi 메시지(effort 를 담은 system 항목)는 그대로 둔다
    body.messages = J.anthropic ? body.messages.map((m, i) => (i === last ? { role: "user", content: [{ type: "text", text: prompt }] } : m))
      : [...body.messages.slice(0, last), { role: "user", content: prompt }];
    const res = await ask(body, extra);
    const msg = J.anthropic ? {} : res.choices?.[0]?.message ?? {};
    const calls = J.anthropic ? (res.content ?? []).filter((b) => b.type === "tool_use").map((b) => ({ name: b.name, args: b.input ?? {} }))
      : (msg.tool_calls ?? []).map((c) => { let a = {}; try { a = JSON.parse(c.function.arguments || "{}"); } catch { /* 무시 */ } return { name: c.function.name, args: a }; });
    const said = J.anthropic ? (res.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("") : String(msg.content ?? "");
    const read = calls.flatMap((c) => [String(c.args.path ?? ""), String(c.args.command ?? "")])
      .flatMap((s) => [...s.matchAll(/skills[\\/]+([\w-]+)[\\/]+SKILL\.md/gi)].map((m) => m[1]));
    const habits = [...new Set(calls.filter((c) => c.name === "bash").flatMap((c) => detectHints(String(c.args.command ?? ""))).map((k) => (k === "curl" ? "curl" : `bash-${k}`)))];
    const nots = [exp.not ?? []].flat();
    const avoided = [exp.avoid ?? []].flat().filter((a) => habits.includes(a));
    const pass = (exp.want ? read.includes(exp.want) : exp.none ? read.length === 0 : !nots.some((n) => read.includes(n))) && avoided.length === 0;
    const r = { variant: name, id, kind, ...(J.label ? { model: J.label } : {}), prompt, expect: exp, read, first: calls.map((c) => c.name), habits,
      bash: calls.filter((c) => c.name === "bash").map((c) => String(c.args.command ?? "").slice(0, 160)), text: said.slice(0, 160),
      error: res.error ?? null, pass, altOk: exp.alt ? read.includes(exp.alt) : null, ...(res.usage ? { usage: { in: res.usage.input_tokens, cacheRead: res.usage.cache_read_input_tokens, cacheWrite: res.usage.cache_creation_input_tokens, out: res.usage.output_tokens } } : {}) };
    results.push(r);
    writeFileSync(outFile, scrub(JSON.stringify(results, null, 1)));
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
