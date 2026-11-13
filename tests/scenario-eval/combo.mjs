// 여러 skill 을 함께 쓰는 상황 시나리오 (suite "combo"). docs/skill-combo-spec.md
// 프롬프트에는 도구 · skill 이름을 쓰지 않고 상황만 쓴다. 한 작업에 skill 2~3개가 쓰여야 제대로 끝나도록 자료를 만든다
// (예: JSON 이 커서 read 로는 잘리고, 호출 지점이 많아 하나씩 고치기 어렵다).
// 시나리오마다 setup(dir) 이 자료를 만들고(필요하면 로컬 HTTP 서버를 띄우고) ctx 를 돌려준다. check 는 결과물(답 · 파일)을 본다.
// skill 사용 판정(run.mjs): 읽은 SKILL.md(read 도구) + 실제로 실행한 명령(bash 의 첫 낱말들).
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawnSync } from "node:child_process";

const put = (dir, rel, text) => {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};
const num = (text) => text.replace(/(\d),(?=\d{3})/g, "$1");   // 1,234 → 1234

// ---------------------------------------------------------------- sales: DB + 큰 JSON
const CUSTOMERS = ["kim", "lee", "park", "choi", "jung", "kang", "cho", "yoon", "jang", "lim", "han", "oh", "seo", "shin", "kwon",
  "hwang", "ahn", "song", "ryu", "hong"];
const GOLD = new Set(["lee", "choi", "yoon", "seo", "ryu"]);
function salesData() {
  const orders = [];
  for (let i = 1; i <= 240; i++) {
    const c = (i * 7 + Math.floor(i / 4)) % CUSTOMERS.length;   // 고객마다 여러 상태의 주문이 섞이게
    orders.push({ id: i, customer_id: c + 1, status: ["paid", "paid", "refunded", "pending"][i % 4], total: ((i * 53) % 900) + 100 });
  }
  const goldTotals = {};
  for (const o of orders) {
    const name = CUSTOMERS[o.customer_id - 1];
    if (o.status === "paid" && GOLD.has(name)) goldTotals[name] = (goldTotals[name] ?? 0) + o.total;
  }
  return { orders, goldTotals };
}

// ---------------------------------------------------------------- api: 로컬 HTTP 서버 (status 필터에 결함: shipped 에 cancelled 가 섞인다)
function apiOrders() {
  const all = [];
  for (let i = 1; i <= 90; i++) all.push({ id: 1000 + i, status: ["shipped", "pending", "cancelled"][i % 3], amount: ((i * 37) % 900) + 50, items: [{ sku: `S-${i}`, qty: (i % 4) + 1 }] });
  const shipped = all.filter((o) => o.status === "shipped");
  const leaked = all.filter((o) => o.status === "cancelled" && o.id % 10 === 0);   // 결함
  return { all, served: [...shipped, ...leaked].sort((a, b) => a.id - b.id), bigShipped: shipped.filter((o) => o.amount > 500).map((o) => o.id), leaked: leaked.map((o) => o.id) };
}

// ---------------------------------------------------------------- deprecate: Java 호출 지점 + 주석 · 문자열 속 이름
const CALLERS = ["Checkout", "Invoice", "Refund", "Report", "Cart", "Subscription", "Coupon", "Shipping"];
function javaFiles() {
  const files = {
    "src/main/java/com/acme/order/OrderService.java": [
      "package com.acme.order;", "", "public class OrderService {",
      "    /** @deprecated legacyTotal() 은 곧 지운다. newTotal() 을 쓴다 */",
      "    @Deprecated", "    public long legacyTotal(long price, int qty) {", "        return price * qty;", "    }", "",
      "    public long newTotal(long price, int qty) {", "        return Math.multiplyExact(price, qty);", "    }", "}", "",
    ].join("\n"),
  };
  CALLERS.forEach((name, i) => {
    files[`src/main/java/com/acme/${name.toLowerCase()}/${name}Handler.java`] = [
      `package com.acme.${name.toLowerCase()};`, "", "import com.acme.order.OrderService;", "",
      `public class ${name}Handler {`, "    private final OrderService orders = new OrderService();", "",
      "    // TODO: legacyTotal() 호출을 정리한다",
      `    public long handle(long price, int qty) {`,
      `        log("${name}: legacyTotal() fallback path");`,
      `        long a = orders.legacyTotal(price, qty);`,
      ...(i % 2 === 0 ? [`        long b = orders.legacyTotal(price + ${i}, 1);`, "        return a + b;"] : ["        return a;"]),
      "    }", "", "    private void log(String s) { System.out.println(s); }", "}", "",
    ].join("\n");
  });
  return files;
}
/** 주석 · 문자열을 지운 코드에서 legacyTotal( 호출 수 (정의 줄 제외) */
function javaCalls(dir) {
  let calls = 0, mentions = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith(".java")) {
        const src = fs.readFileSync(p, "utf8");
        mentions += (src.match(/\/\/[^\n]*legacyTotal|\/\*\*[^\n]*legacyTotal|"[^"\n]*legacyTotal[^"\n]*"/g) ?? []).length;
        const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "").replace(/"(\\.|[^"\\])*"/g, '""');
        calls += (code.match(/\blegacyTotal\s*\(/g) ?? []).length - (code.match(/long\s+legacyTotal\s*\(/g) ?? []).length;
      }
    }
  };
  walk(path.join(dir, "src"));
  return { calls, mentions };
}
const JAVA_CHECK = `// 정리 검사: 주석 · 문자열을 뺀 코드에 legacyTotal( 호출이 남아 있으면 실패
const fs = require("fs"), path = require("path");
let left = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name);
  if (e.isDirectory()) walk(p); else if (p.endsWith(".java")) {
    const code = fs.readFileSync(p, "utf8").replace(/\\/\\*[\\s\\S]*?\\*\\//g, "").replace(/\\/\\/[^\\n]*/g, "").replace(/"(\\\\.|[^"\\\\])*"/g, '""');
    code.split("\\n").forEach((l, i) => { if (/\\blegacyTotal\\s*\\(/.test(l) && !/long\\s+legacyTotal/.test(l)) left.push(p + ":" + (i + 1)); });
  } } })("src");
if (left.length) { console.error("legacyTotal 호출이 남아 있음:\\n" + left.join("\\n")); process.exit(1); }
console.log("check ok");
`;

// ---------------------------------------------------------------- failtest: 설정 JSON 값 오류
function appConfig(bad) {
  const cfg = { service: { name: "acme-notifier", region: "kr-1" }, features: {}, retry: { maxAttempts: 4, baseDelayMs: bad ? "100ms" : 100, maxDelayMs: 2000 }, channels: [] };
  for (let i = 0; i < 120; i++) cfg.features[`flag_${i}`] = { enabled: i % 3 === 0, rollout: (i * 7) % 100, owner: `team-${i % 9}`, note: "feature flag for gradual rollout ".repeat(2) };
  for (let i = 0; i < 40; i++) cfg.channels.push({ id: `ch-${i}`, kind: ["email", "sms", "push"][i % 3], weight: (i % 5) + 1 });
  return JSON.stringify(cfg, null, 2) + "\n";
}

export const COMBO = [
  {
    id: "sales", group: "combo", skills: ["sql-querying", "json-querying"],
    prompt: () => "data/shop.db 에 쌓인 주문 기록과 reports/customer-tiers.json 의 고객 등급을 맞춰 보고, gold 등급 고객들이 결제 완료(paid)한 주문 금액 합계를 고객별로 알려줘.",
    setup(dir, root) {
      const { orders, goldTotals } = salesData();
      const tiers = CUSTOMERS.map((n, i) => ({ customer: n, tier: GOLD.has(n) ? "gold" : ["silver", "bronze"][i % 2],
        history: Array.from({ length: 30 }, (_, k) => ({ month: `2026-${String((k % 12) + 1).padStart(2, "0")}`, visits: (i * k) % 17, note: "monthly visit summary for loyalty program" })) }));
      put(dir, "reports/customer-tiers.json", JSON.stringify({ generatedAt: "2026-11-01", customers: tiers }, null, 2) + "\n");
      put(dir, "README.md", "# shop-analytics\n\n주문 DB 는 data/shop.db (SQLite), 고객 등급 보고서는 reports/ 에 있다.\n");
      fs.mkdirSync(path.join(dir, "data"), { recursive: true });
      const sql = ["create table customers (id integer primary key, name text not null);", "create table orders (id integer primary key, customer_id integer, status text, total integer);",
        ...CUSTOMERS.map((n, i) => `insert into customers values (${i + 1}, '${n}');`),
        ...orders.map((o) => `insert into orders values (${o.id}, ${o.customer_id}, '${o.status}', ${o.total});`)].join("\n");
      put(dir, "data/init.sql", sql);
      const r = spawnSync(path.join(root, "bin", "usql.exe"), [`sqlite:${path.join(dir, "data", "shop.db").replace(/\\/g, "/")}`, "-w", "-q", "-f", path.join(dir, "data", "init.sql")], { encoding: "utf8" });
      fs.rmSync(path.join(dir, "data", "init.sql"));
      if (r.status !== 0) throw new Error(`sales 자료 만들기 실패: ${r.stderr || r.stdout}`);
      return { goldTotals };
    },
    check({ text, ctx }) {
      const t = num(text);
      const miss = Object.entries(ctx.goldTotals).filter(([n, v]) => !(t.includes(n) && t.includes(String(v))));
      const n = Object.keys(ctx.goldTotals).length;
      return { pass: miss.length === 0, note: miss.length ? `틀림/빠짐 ${miss.length}/${n}: ${miss.map(([k, v]) => `${k}=${v}`).join(", ")}` : `gold ${n}명 합계 모두 맞음` };
    },
  },
  {
    id: "api", group: "combo", skills: ["http-api-testing", "json-querying"],
    prompt: (ctx) => `로컬에서 http://127.0.0.1:${ctx.port} 로 돌고 있는 주문 API 가 status 필터를 제대로 적용하는지 확인해 줘. /api/orders?status=shipped 로 요청했을 때 다른 상태가 섞여 나오지 않아야 해. 나중에 다시 돌릴 수 있게 확인 내용을 파일로 남기고, shipped 주문 중 금액(amount)이 500 넘는 주문 번호도 알려줘.`,
    async setup() {
      const d = apiOrders();
      const server = http.createServer((req, res) => {
        const u = new URL(req.url, "http://x");
        if (u.pathname === "/api/health") { res.writeHead(200, { "content-type": "application/json" }); return res.end('{"ok":true}'); }
        if (u.pathname !== "/api/orders") { res.writeHead(404); return res.end(); }
        const st = u.searchParams.get("status");
        const body = st === "shipped" ? d.served : st ? d.all.filter((o) => o.status === st) : d.all;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ count: body.length, orders: body }));
      });
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      return { port: server.address().port, bigShipped: d.bigShipped, leaked: d.leaked, close: () => server.close() };
    },
    check({ text, dir, ctx }) {
      // 결과물은 "다시 돌릴 수 있는 확인 파일" 이면 된다 (.hurl 이든 스크립트든). 어떤 skill 로 했는지는 skills 기록이 따로 본다
      const hurl = fs.readdirSync(dir, { recursive: true }).some((f) => /.(hurl|sh|http|js|mjs|py|ps1)$/.test(String(f)) && !String(f).startsWith(".git"));
      const t = num(text);
      const found = /cancel|취소|섞|leak|다른 상태/i.test(t);
      const missIds = ctx.bigShipped.filter((id) => !t.includes(String(id)));
      const wrong = ctx.leaked.filter((id) => new RegExp(`\\b${id}\\b`).test(t) && /500/.test(t)).length;   // 참고용
      const pass = hurl && found && missIds.length === 0;
      return { pass, note: `확인 파일=${hurl} 결함 보고=${found} 큰 주문 ${ctx.bigShipped.length - missIds.length}/${ctx.bigShipped.length}${wrong ? ` (섞인 id 언급 ${wrong})` : ""}` };
    },
  },
  {
    id: "deprecate", group: "combo", skills: ["structural-code-search", "project-task-running"],
    prompt: () => "OrderService 의 legacyTotal() 은 곧 지울 예정이야. 이 메서드를 실제로 호출하는 코드를 전부 newTotal() 로 바꿔 줘. 주석이나 로그 문자열에 적힌 이름은 그대로 두고, 바꾼 뒤에는 이 프로젝트에 정해진 검사 명령으로 확인해 줘.",
    setup(dir) {
      for (const [rel, text] of Object.entries(javaFiles())) put(dir, rel, text);
      put(dir, "tools/check-legacy.js", JAVA_CHECK);
      put(dir, "justfile", "set shell := [\"bash\", \"-uc\"]\nset windows-shell := [\"bash\", \"-uc\"]\n\n# 코드 정리 검사 (지울 예정인 API 호출이 남았는지)\ncheck:\n    node tools/check-legacy.js\n\n# 빌드 (이 예제에서는 생략)\nbuild:\n    @echo \"build skipped in this sample\"\n");
      put(dir, "README.md", "# acme-orders\n\n작업 명령은 justfile 에 있다.\n");
      return { before: javaCalls(dir) };
    },
    check({ dir, ctx }) {
      const after = javaCalls(dir);
      const r = spawnSync("node", ["tools/check-legacy.js"], { cwd: dir, encoding: "utf8" });
      const pass = after.calls === 0 && after.mentions === ctx.before.mentions && r.status === 0;
      return { pass, note: `남은 호출 ${after.calls}/${ctx.before.calls}, 주석·문자열 ${after.mentions}/${ctx.before.mentions}${r.status === 0 ? "" : " (검사 실패)"}` };
    },
  },
  {
    id: "failtest", group: "combo", skills: ["project-task-running", "find-code", "json-querying"],
    prompt: () => "테스트가 깨졌다는 연락을 받았어. 원인을 찾아서 고쳐 줘. 테스트는 이 프로젝트에서 정해 둔 방법으로 돌리고, 고친 뒤에도 다시 돌려서 통과하는지 확인해 줘.",
    setup(dir) {
      put(dir, "config/app.json", appConfig(true));
      put(dir, "config/app.staging.json", appConfig(false));
      put(dir, "src/retry.js", "const cfg = require(\"./load-config\")();\n\n/** i 번째 재시도 전 대기 시간(ms): base * 2^i, 상한 maxDelayMs */\nfunction delayFor(i) {\n  const { baseDelayMs, maxDelayMs } = cfg.retry;\n  return Math.min(baseDelayMs * 2 ** i, maxDelayMs);\n}\n\nmodule.exports = { delayFor, maxAttempts: () => cfg.retry.maxAttempts };\n");
      put(dir, "src/load-config.js", "const fs = require(\"fs\");\nconst path = require(\"path\");\n\n// NODE_ENV 가 staging 이면 app.staging.json, 그 밖에는 app.json\nmodule.exports = () => JSON.parse(fs.readFileSync(path.join(__dirname, \"..\", \"config\", process.env.NODE_ENV === \"staging\" ? \"app.staging.json\" : \"app.json\"), \"utf8\"));\n");
      put(dir, "tests/retry.test.js", "const assert = require(\"assert\");\nconst { delayFor, maxAttempts } = require(\"../src/retry\");\n\nassert.strictEqual(maxAttempts(), 4);\nassert.deepStrictEqual([0, 1, 2, 3, 4, 5].map(delayFor), [100, 200, 400, 800, 1600, 2000]);\nconsole.log(\"retry tests passed\");\n");
      put(dir, "justfile", "set shell := [\"bash\", \"-uc\"]\nset windows-shell := [\"bash\", \"-uc\"]\n\n# 단위 테스트\ntest:\n    node tests/retry.test.js\n\n# 개발 서버 (이 예제에서는 생략)\ndev:\n    @echo \"dev server skipped in this sample\"\n");
      put(dir, "README.md", "# acme-notifier\n\n작업 명령은 justfile 에 있다.\n");
      return {};
    },
    check({ dir }) {
      const r = spawnSync("node", ["tests/retry.test.js"], { cwd: dir, encoding: "utf8" });
      let cfg = null;
      try { cfg = JSON.parse(fs.readFileSync(path.join(dir, "config/app.json"), "utf8")); } catch { /* 깨진 JSON */ }
      const kept = cfg && Object.keys(cfg.features ?? {}).length === 120 && cfg.channels?.length === 40;
      const fixed = cfg?.retry?.baseDelayMs === 100;
      return { pass: r.status === 0 && fixed && Boolean(kept), note: `테스트=${r.status === 0 ? "통과" : "실패"} baseDelayMs=${JSON.stringify(cfg?.retry?.baseDelayMs)} 나머지 설정 유지=${Boolean(kept)}` };
    },
  },
];
