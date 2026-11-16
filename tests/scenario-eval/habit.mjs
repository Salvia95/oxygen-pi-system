// 실제 사용 습관 시나리오 (suite "habit"). 2026-11-14 설치본 Haiku 세션 9개(Java 앱 개발 · 개발 서버 확인)에서
// skill 을 한 번도 읽지 않고 bash grep 102 · cat 80 · curl 68(그중 25번은 쿠키 · CSRF 폼 제출)을 쓴 상황을 작게 재현한다.
// 프롬프트에는 도구 · skill 이름을 쓰지 않는다. 프로젝트는 매번 같은 작은 도서 대여 앱(Java + SQLite + 개발 서버)이다.
// check 는 결과물(답 · 파일)만 본다. 어떤 도구로 했는지는 run.mjs 가 trace(도구 호출 순서의 꼬리표)로 따로 남긴다.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const put = (dir, rel, text) => {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};

// ---------------------------------------------------------------- 자료 (정답은 여기서만 정한다)
const MEMBERS = ["hong", "kim", "lee", "park", "choi", "jung", "kang", "yoon"];
const BOOKS = ["자바의 정석", "토비의 스프링", "클린 코드", "리팩터링", "이펙티브 자바", "모던 자바 인 액션", "HTTP 완벽 가이드", "SQL 첫걸음", "객체지향의 사실과 오해", "도메인 주도 설계"];
const TODAY = "2026-11-10";
/** 대여 30건. 반납 안 됨(returned_at null) + 반납 예정일 < TODAY 가 연체 */
function loans() {
  const rows = [];
  for (let i = 1; i <= 30; i++) {
    const day = ((i * 5) % 28) + 1;                   // 반납 예정일 2026-10-02 ~ 2026-11-29 사이
    const month = i % 3 === 0 ? 10 : 11;
    const due = `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const returned = i % 4 === 0 || (month === 10 && i % 2 === 0) ? `2026-${String(month).padStart(2, "0")}-${String(Math.max(1, day - 1)).padStart(2, "0")}` : null;
    if (i === 12) { rows.push({ id: i, book_id: 5, member_id: 5, loan_date: "2026-10-26", due_date: "2026-11-09", returned_at: null }); continue; }   // 날짜 경계: 페이지 결함이 빠뜨리는 대여 (choi)
    rows.push({ id: i, book_id: ((i * 3) % BOOKS.length) + 1, member_id: ((i * 7) % MEMBERS.length) + 1, loan_date: "2026-09-30", due_date: due, returned_at: returned });
  }
  return rows;
}
const overdue = () => loans().filter((l) => !l.returned_at && l.due_date < TODAY);

// ---------------------------------------------------------------- Java 프로젝트
const J = "src/main/java/com/example/library";
function project() {
  const f = {
    ".gitignore": "target/\n*.log\n",
    "README.md": "# libra\n\n도서 대여 앱 (Spring Boot + SQLite). DB 는 data/library.db, 설정은 src/main/resources/application.yml.\n",
    "pom.xml": [
      `<?xml version="1.0" encoding="UTF-8"?>`, `<project xmlns="http://maven.apache.org/POM/4.0.0">`, `  <modelVersion>4.0.0</modelVersion>`,
      `  <parent>`, `    <groupId>org.springframework.boot</groupId>`, `    <artifactId>spring-boot-starter-parent</artifactId>`, `    <version>3.3.4</version>`, `  </parent>`,
      `  <groupId>com.example</groupId>`, `  <artifactId>libra</artifactId>`, `  <version>0.1.0</version>`,
      `  <properties>`, `    <java.version>21</java.version>`, `    <sqlite-jdbc.version>3.46.1.3</sqlite-jdbc.version>`, `  </properties>`,
      `  <dependencies>`,
      `    <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency>`,
      `    <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-thymeleaf</artifactId></dependency>`,
      `    <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-security</artifactId></dependency>`,
      `    <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-jdbc</artifactId></dependency>`,
      `    <dependency><groupId>org.xerial</groupId><artifactId>sqlite-jdbc</artifactId><version>\${sqlite-jdbc.version}</version></dependency>`,
      `    <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-test</artifactId><scope>test</scope></dependency>`,
      `  </dependencies>`, `</project>`, ``].join("\n"),
    "src/main/resources/application.yml": [
      "server:", "  port: 8080", "spring:", "  application:", "    name: libra", "  datasource:", "    url: jdbc:sqlite:data/library.db", "    driver-class-name: org.sqlite.JDBC",
      "  thymeleaf:", "    cache: false", "library:", "  loan:", "    max-days: 14", "    max-books: 5", "    overdue-fee-per-day: 100", "logging:", "  level:", "    com.example.library: DEBUG", ""].join("\n"),
    "src/main/resources/templates/loan/new.html": "<form method=\"post\" th:action=\"@{/loan}\">\n  <select name=\"bookId\"></select>\n  <input name=\"memberId\">\n  <button>대여</button>\n</form>\n",
    "src/main/resources/templates/loan/detail.html": "<!-- 연체 여부는 LoanService.isOverdue() 결과(overdue)로 표시 -->\n<p th:if=\"${overdue}\">연체</p>\n",
    [`${J}/LibraryApplication.java`]: "package com.example.library;\n\nimport org.springframework.boot.SpringApplication;\nimport org.springframework.boot.autoconfigure.SpringBootApplication;\n\n@SpringBootApplication\npublic class LibraryApplication {\n    public static void main(String[] args) {\n        SpringApplication.run(LibraryApplication.class, args);\n    }\n}\n",
    [`${J}/book/Book.java`]: "package com.example.library.book;\n\npublic record Book(long id, String title) {}\n",
    [`${J}/book/BookRepository.java`]: "package com.example.library.book;\n\nimport java.util.List;\nimport org.springframework.jdbc.core.JdbcTemplate;\nimport org.springframework.stereotype.Repository;\n\n@Repository\npublic class BookRepository {\n    private final JdbcTemplate jdbc;\n\n    public BookRepository(JdbcTemplate jdbc) { this.jdbc = jdbc; }\n\n    public List<Book> findAll() {\n        return jdbc.query(\"select id, title from books order by id\", (rs, i) -> new Book(rs.getLong(1), rs.getString(2)));\n    }\n}\n",
    [`${J}/book/BookController.java`]: "package com.example.library.book;\n\nimport org.springframework.stereotype.Controller;\nimport org.springframework.ui.Model;\nimport org.springframework.web.bind.annotation.GetMapping;\n\n@Controller\npublic class BookController {\n    private final BookRepository books;\n\n    public BookController(BookRepository books) { this.books = books; }\n\n    @GetMapping(\"/book\")\n    public String list(Model model) {\n        model.addAttribute(\"books\", books.findAll());\n        return \"book/list\";\n    }\n}\n",
    [`${J}/member/Member.java`]: "package com.example.library.member;\n\npublic record Member(long id, String name) {}\n",
    [`${J}/member/MemberService.java`]: "package com.example.library.member;\n\nimport java.time.LocalDate;\nimport com.example.library.loan.LoanRepository;\nimport com.example.library.loan.LoanService;\nimport org.springframework.stereotype.Service;\n\n@Service\npublic class MemberService {\n    private final LoanRepository loans;\n    private final LoanService loanService;\n\n    public MemberService(LoanRepository loans, LoanService loanService) {\n        this.loans = loans;\n        this.loanService = loanService;\n    }\n\n    /** 연체 중인 대여가 하나라도 있으면 새 대여를 막는다 */\n    public boolean canBorrow(long memberId) {\n        LocalDate today = LocalDate.now();\n        return loans.findOpenByMember(memberId).stream()\n            .noneMatch(l -> loanService.isOverdue(l, today));\n    }\n}\n",
    [`${J}/loan/Loan.java`]: "package com.example.library.loan;\n\nimport java.time.LocalDate;\n\n// 반납 예정일 다음 날부터 연체 (isOverdue 참고)\npublic record Loan(long id, long bookId, long memberId, LocalDate loanDate, LocalDate dueDate, LocalDate returnedAt) {}\n",
    [`${J}/loan/LoanRepository.java`]: "package com.example.library.loan;\n\nimport java.util.List;\nimport org.springframework.jdbc.core.JdbcTemplate;\nimport org.springframework.stereotype.Repository;\n\n@Repository\npublic class LoanRepository {\n    private final JdbcTemplate jdbc;\n\n    public LoanRepository(JdbcTemplate jdbc) { this.jdbc = jdbc; }\n\n    public List<Loan> findOpen() { return List.of(); }\n\n    public List<Loan> findOpenByMember(long memberId) { return List.of(); }\n\n    public Loan findById(long id) { return null; }\n}\n",
    [`${J}/loan/LoanService.java`]: "package com.example.library.loan;\n\nimport java.time.LocalDate;\nimport java.util.List;\nimport org.springframework.stereotype.Service;\n\n@Service\npublic class LoanService {\n    private final LoanRepository loans;\n\n    public LoanService(LoanRepository loans) { this.loans = loans; }\n\n    public boolean isOverdue(Loan loan, LocalDate today) {\n        return loan.returnedAt() == null && loan.dueDate().isBefore(today);\n    }\n\n    public List<Loan> findOverdue(LocalDate today) {\n        return loans.findOpen().stream().filter(l -> isOverdue(l, today)).toList();\n    }\n}\n",
    [`${J}/loan/LoanController.java`]: "package com.example.library.loan;\n\nimport java.time.LocalDate;\nimport org.springframework.stereotype.Controller;\nimport org.springframework.ui.Model;\nimport org.springframework.web.bind.annotation.GetMapping;\nimport org.springframework.web.bind.annotation.PathVariable;\n\n@Controller\npublic class LoanController {\n    private final LoanRepository loans;\n    private final LoanService service;\n\n    public LoanController(LoanRepository loans, LoanService service) {\n        this.loans = loans;\n        this.service = service;\n    }\n\n    @GetMapping(\"/loan/{id}\")\n    public String detail(@PathVariable long id, Model model) {\n        Loan loan = loans.findById(id);\n        model.addAttribute(\"loan\", loan);\n        model.addAttribute(\"overdue\", service.isOverdue(loan, LocalDate.now()));\n        return \"loan/detail\";\n    }\n\n    @GetMapping(\"/loan/overdue\")\n    public String overdue(Model model) {\n        model.addAttribute(\"loans\", service.findOverdue(LocalDate.now()));\n        return \"loan/overdue\";\n    }\n}\n",
    [`${J}/loan/OverdueScheduler.java`]: "package com.example.library.loan;\n\nimport java.time.LocalDate;\nimport org.springframework.scheduling.annotation.Scheduled;\nimport org.springframework.stereotype.Component;\n\n@Component\npublic class OverdueScheduler {\n    private final LoanRepository loans;\n    private final LoanService service;\n\n    public OverdueScheduler(LoanRepository loans, LoanService service) {\n        this.loans = loans;\n        this.service = service;\n    }\n\n    @Scheduled(cron = \"0 0 9 * * *\")\n    public void notifyOverdue() {\n        LocalDate today = LocalDate.now();\n        for (Loan l : loans.findOpen()) {\n            if (service.isOverdue(l, today)) {\n                System.out.println(\"overdue: \" + l.id());\n            }\n        }\n    }\n}\n",
    [`${J}/config/SecurityConfig.java`]: "package com.example.library.config;\n\nimport org.springframework.context.annotation.Bean;\nimport org.springframework.context.annotation.Configuration;\nimport org.springframework.security.config.annotation.web.builders.HttpSecurity;\nimport org.springframework.security.web.SecurityFilterChain;\n\n@Configuration\npublic class SecurityConfig {\n    // 폼은 CSRF 토큰(_csrf)이 있어야 받는다 (기본값 유지)\n    @Bean\n    SecurityFilterChain chain(HttpSecurity http) throws Exception {\n        return http.authorizeHttpRequests(a -> a.anyRequest().permitAll()).build();\n    }\n}\n",
    "src/test/java/com/example/library/loan/LoanServiceTest.java": "package com.example.library.loan;\n\nimport static org.junit.jupiter.api.Assertions.*;\nimport java.time.LocalDate;\nimport org.junit.jupiter.api.Test;\n\nclass LoanServiceTest {\n    private final LoanService service = new LoanService(null);\n\n    @Test\n    void dueTodayIsNotOverdue() {\n        Loan l = new Loan(1, 1, 1, LocalDate.of(2026, 11, 1), LocalDate.of(2026, 11, 10), null);\n        assertFalse(service.isOverdue(l, LocalDate.of(2026, 11, 10)));\n    }\n\n    @Test\n    void dayAfterDueIsOverdue() {\n        Loan l = new Loan(1, 1, 1, LocalDate.of(2026, 11, 1), LocalDate.of(2026, 11, 10), null);\n        assertTrue(service.isOverdue(l, LocalDate.of(2026, 11, 11)));\n    }\n}\n",
  };
  // .gitignore 로 가려지는 빌드 산출물 (예전 복사본: 텍스트 검색이 이것까지 잡으면 잡음)
  for (const n of ["LoanController", "OverdueScheduler", "MemberService"]) {
    const src = Object.entries(f).find(([k]) => k.endsWith(`/${n}.java`))[1];
    f[`target/generated-sources/annotations/com/example/library/${n}.java`] = src;
  }
  f["target/classes/application.yml"] = f["src/main/resources/application.yml"].replace("port: 8080", "port: 8081");
  return f;
}

/** 프로젝트 파일 + data/library.db (번들 usql 로 만든다) */
export function makeProject(dir, root) {
  for (const [rel, text] of Object.entries(project())) put(dir, rel, text);
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  const q = (v) => (v == null ? "null" : `'${String(v).replace(/'/g, "''")}'`);
  const sql = [
    "create table members (id integer primary key, name text not null);",
    "create table books (id integer primary key, title text not null);",
    "create table loans (id integer primary key, book_id integer not null, member_id integer not null, loan_date text not null, due_date text not null, returned_at text);",
    ...MEMBERS.map((n, i) => `insert into members values (${i + 1}, ${q(n)});`),
    ...BOOKS.map((t, i) => `insert into books values (${i + 1}, ${q(t)});`),
    ...loans().map((l) => `insert into loans values (${l.id}, ${l.book_id}, ${l.member_id}, ${q(l.loan_date)}, ${q(l.due_date)}, ${q(l.returned_at)});`),
  ].join("\n");
  put(dir, "data/init.sql", sql);
  const db = path.join(dir, "data", "library.db").replace(/\\/g, "/");
  const r = spawnSync(path.join(root, "bin", "usql.exe"), [`sqlite:${db}`, "-w", "-q", "-f", path.join(dir, "data", "init.sql")], { encoding: "utf8" });
  fs.rmSync(path.join(dir, "data", "init.sql"));
  if (r.status !== 0) throw new Error(`library.db 만들기 실패: ${r.stderr || r.stdout}`);
}

// ---------------------------------------------------------------- 개발 서버 (Spring Security 처럼 세션 쿠키 + _csrf 가 맞아야 폼을 받는다)
function devServer() {
  const sessions = new Map();          // SESSION → csrf
  const created = [];                  // { code, id, bookId, member, due }
  const page = (title, body) => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;
  const send = (res, status, html, headers = {}) => { res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers }); res.end(html); };
  const cookieOf = (req) => /(?:^|;\s*)SESSION=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
  const session = (req, res) => {
    let s = cookieOf(req);
    if (!s || !sessions.has(s)) {
      s = crypto.randomBytes(8).toString("hex");
      sessions.set(s, crypto.randomBytes(12).toString("hex"));
      res.setHeader("set-cookie", `SESSION=${s}; Path=/; HttpOnly`);
    }
    return s;
  };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      if (req.method === "GET" && u.pathname === "/") return send(res, 200, page("libra", `<a href="/book">도서</a> <a href="/loan/new">대여 등록</a> <a href="/loan/overdue">연체자 조회</a>`));
      if (req.method === "GET" && u.pathname === "/book") return send(res, 200, page("도서 목록", `<ul>${BOOKS.map((t, i) => `<li><a href="/book/${i + 1}">${t}</a></li>`).join("")}</ul>`));
      if (req.method === "GET" && u.pathname === "/loan/new") {
        const s = session(req, res);
        return send(res, 200, page("대여 등록", `<form method="post" action="/loan"><input type="hidden" name="_csrf" value="${sessions.get(s)}"/>`
          + `<label>도서 <select name="bookId">${BOOKS.map((t, i) => `<option value="${i + 1}">${t}</option>`).join("")}</select></label>`
          + `<label>회원 ID <input name="memberName" required></label><button type="submit">대여</button></form>`));
      }
      if (req.method === "POST" && u.pathname === "/loan") {
        const s = cookieOf(req);
        const f = new URLSearchParams(body);
        if (!s || !sessions.has(s) || f.get("_csrf") !== sessions.get(s)) return send(res, 403, page("403 Forbidden", "<p>Invalid CSRF token. 세션이 만료되었거나 잘못된 요청입니다.</p>"));
        const bookId = Number(f.get("bookId")), member = (f.get("memberName") ?? "").trim();
        if (!bookId || !BOOKS[bookId - 1] || !MEMBERS.includes(member)) return send(res, 400, page("대여 실패", `<p>도서 또는 회원을 찾을 수 없습니다.</p>`));
        const id = 31 + created.length;
        const code = `L-${crypto.randomInt(1000, 9999)}`;
        created.push({ id, code, bookId, member, due: "2026-11-24" });
        res.writeHead(302, { location: `/loan/${id}?created=1` });
        return res.end();
      }
      const m = /^\/loan\/(\d+)$/.exec(u.pathname);
      if (req.method === "GET" && m) {
        const s = cookieOf(req);
        const c = created.find((x) => x.id === Number(m[1]));
        if (!c) return send(res, 404, page("404", "<p>대여 기록이 없습니다.</p>"));
        if (!s || !sessions.has(s)) { res.writeHead(302, { location: "/loan/new" }); return res.end(); }   // 세션 없이 보면 등록 화면으로
        return send(res, 200, page("대여 상세", `${u.searchParams.get("created") ? `<div class="alert">대여가 등록되었습니다.</div>` : ""}<dl><dt>대여 번호</dt><dd>${c.code}</dd><dt>도서</dt><dd>${BOOKS[c.bookId - 1]}</dd>`
          + `<dt>회원</dt><dd>${c.member}</dd><dt>반납 예정일</dt><dd>${c.due}</dd></dl>`));
      }
      if (req.method === "GET" && u.pathname === "/loan/overdue") {
        // 결함: 반납 예정일이 TODAY 하루 전인 대여를 빠뜨린다 (날짜 경계 오류)
        const rows = overdue().filter((l) => l.due_date !== "2026-11-09");
        return send(res, 200, page("연체자 조회", `<p>기준일 ${TODAY}</p><table><tr><th>대여</th><th>회원</th><th>도서</th><th>반납 예정일</th></tr>`
          + rows.map((l) => `<tr><td>${l.id}</td><td>${MEMBERS[l.member_id - 1]}</td><td>${BOOKS[l.book_id - 1]}</td><td>${l.due_date}</td></tr>`).join("") + `</table><p>총 ${rows.length}건</p>`));
      }
      send(res, 404, page("404", "<p>Not Found</p>"));
    });
  });
  return { server, created };
}
async function startServer() {
  const d = devServer();
  await new Promise((r) => d.server.listen(0, "127.0.0.1", r));
  return { port: d.server.address().port, created: d.created, close: () => d.server.close() };
}

const CALLERS = ["LoanController", "OverdueScheduler", "MemberService"];

export const HABIT = [
  {
    // 실제 세션: curl -c/-b 쿠키 파일 + grep 으로 _csrf 를 긁어 폼 제출 (25번)
    id: "form", group: "habit", skills: ["http-api-testing", "web-page-automation"],
    prompt: (ctx) => `개발 서버가 http://127.0.0.1:${ctx.port} 에 떠 있어. 대여 등록 화면(/loan/new)의 폼으로 3번 책을 회원 hong 이름으로 대여 신청하면 서버가 어떤 상태 코드와 이동 위치를 돌려주는지, 이동한 페이지에 나오는 대여 번호와 반납 예정일을 확인해 줘.`,
    async setup(dir, root) { makeProject(dir, root); return startServer(); },
    check({ text, ctx }) {
      const mine = ctx.created.filter((c) => c.bookId === 3 && c.member === "hong");
      const code = mine.some((c) => text.includes(c.code));
      const status = /302/.test(text);
      const due = text.includes("2026-11-24");
      return { pass: code && status && due, note: `등록 ${mine.length}건 · 대여 번호=${code} 302=${status} 반납 예정일=${due}` };
    },
  },
  {
    // 실제 세션: bash grep -rn 102번 (grep 도구 1번, rg 0번)
    id: "usage", group: "habit", skills: ["find-code"],
    prompt: () => "LoanService 의 isOverdue 메서드가 어디어디서 호출되는지 찾아서 파일과 줄 번호로 알려줘.",
    setup(dir, root) { makeProject(dir, root); return {}; },
    check({ text }) {
      const miss = CALLERS.filter((c) => !text.includes(c));
      const noise = /target\/generated/.test(text);
      return { pass: miss.length === 0, note: `${miss.length ? `빠짐: ${miss.join(",")}` : "호출 3곳 모두"}${noise ? " · target/ 복사본 언급" : ""}` };
    },
  },
  {
    // 실제 세션: cat pom.xml · .java · .yml 80번
    id: "config", group: "habit", skills: [],
    prompt: () => "서버 포트를 9090 으로 바꿔 줘. 그리고 대여 기간이 며칠로 설정돼 있는지, pom.xml 에 적힌 sqlite-jdbc 버전이 뭔지도 알려줘.",
    setup(dir, root) { makeProject(dir, root); return {}; },
    check({ text, dir }) {
      const yml = fs.readFileSync(path.join(dir, "src/main/resources/application.yml"), "utf8");
      const port = /^ {2}port: 9090$/m.test(yml) && yml.includes("max-days: 14") && yml.includes("jdbc:sqlite:data/library.db");
      const days = /14\s*일|14 days|max-days:\s*14|\b14\b/.test(text);
      const ver = text.includes("3.46.1.3");
      return { pass: port && days && ver, note: `포트 변경=${port} 대여 기간=${days} 버전=${ver}` };
    },
  },
  {
    // 실제 세션: sqlite 도서 대여 앱. DB 확인을 어떻게 하는지
    id: "sqlite", group: "habit", skills: ["sql-querying"],
    prompt: () => `data/library.db 에서 아직 반납되지 않았고 반납 예정일이 ${TODAY} 보다 앞선 대여가 몇 건인지, 어느 회원들인지 확인해 줘.`,
    setup(dir, root) { makeProject(dir, root); return {}; },
    check({ text }) {
      const rows = overdue();
      const names = [...new Set(rows.map((l) => MEMBERS[l.member_id - 1]))];
      const miss = names.filter((n) => !new RegExp(`\\b${n}\\b`).test(text));
      const count = new RegExp(`(^|[^0-9])${rows.length}\\s*건`).test(text);
      return { pass: count && miss.length === 0, note: `${rows.length}건=${count} 회원 ${names.length - miss.length}/${names.length}${miss.length ? ` 빠짐 ${miss.join(",")}` : ""}` };
    },
  },
  {
    // 실제 세션: 개발 서버 화면 확인 + DB 대조 ("대여 생성 오류 원인 확인부터 하자" 같은 확인 작업)
    id: "overdue", group: "habit", skills: ["sql-querying", "http-api-testing", "web-page-reading"],
    prompt: (ctx) => `개발 서버(http://127.0.0.1:${ctx.port})의 연체자 조회 페이지 /loan/overdue 에 나오는 목록이 data/library.db 의 실제 연체 대여(반납 안 됐고 반납 예정일이 ${TODAY} 보다 이전)와 맞는지 확인하고, 다르면 무엇이 빠졌거나 더 있는지 알려줘.`,
    async setup(dir, root) { makeProject(dir, root); return startServer(); },
    check({ text }) {
      const missing = overdue().filter((l) => l.due_date === "2026-11-09");
      const named = missing.every((l) => text.includes(MEMBERS[l.member_id - 1]) || new RegExp(`(대여|id|ID|#)\\s*${l.id}\\b`).test(text));
      const said = /빠|누락|없|missing/i.test(text);
      return { pass: missing.length > 0 && named && said, note: `빠진 대여 ${missing.map((l) => `${l.id}(${MEMBERS[l.member_id - 1]})`).join(",")} 지목=${named && said}` };
    },
  },
];

// 정답 확인용: node habit.mjs → 연체 대여와 빠지는 대여
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const o = overdue();
  console.log(JSON.stringify({ overdue: o.map((l) => ({ id: l.id, member: MEMBERS[l.member_id - 1], due: l.due_date })), missingOnPage: o.filter((l) => l.due_date === "2026-11-09").map((l) => l.id) }));
}
