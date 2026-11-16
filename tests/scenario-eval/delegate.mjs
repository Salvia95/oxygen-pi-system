// 위임 판단 시나리오 (suite "delegate", 2026-11-16 사용자: "현재 에이전트가 subagent 의 위임 기준을 어떻게 정하고 있어?" → 실측).
// 위임 기준은 AGENTS.md "Background work and helpers" 와 subagent 도구 설명뿐이다. 그 기준대로 모델이 맡기는지를 본다.
//   expect: "subagent" (넓은 탐색 · 컨텍스트를 채울 리뷰) · "background" (30초 넘는 명령) · "self" (직접 하는 게 맞는 작은 일)
// 정답(check)과 위임 여부는 따로 남긴다: run.mjs 가 trace 로 subagent · background 호출과 그 인자를 기록한다.
// 프롬프트에는 도구 · agent 이름을 쓰지 않는다. 프로젝트는 habit 의 도서 대여 앱에 모듈을 더해 키운 것이다.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { makeProject } from "./habit.mjs";

const put = (dir, rel, text) => {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};
const J = "src/main/java/com/example/library";
const git = (dir, ...a) => spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" });

// ---------------------------------------------------------------- 넓은 코드베이스 (정답은 여기서만 정한다)
/** isOverdue 를 부르는 파일 (habit 의 3곳 + 여기서 더한 4곳) */
const CALLERS = ["LoanController", "OverdueScheduler", "MemberService", "MonthlyOverdueReport", "OverdueMailer", "LoanAdminController", "FeeBatch"];
/** isOverdue 를 쓰지 않고 반납 예정일 비교를 직접 한 곳과 그 규칙 (isOverdue: 예정일 다음 날부터 연체) */
const OWN_RULES = {
  DailySummary: "!dueDate.isAfter(today)",            // 예정일 당일도 연체로 셈 (하루 이름)
  SmsReminder: "dueDate.isBefore(today)",             // isOverdue 와 같은 규칙 (반납 여부는 보지 않음)
  MemberBlockPolicy: "dueDate.plusDays(1).isBefore(today)",   // 하루 유예
};
const MODULES = { report: 18, notify: 14, admin: 14, batch: 10 };

function javaClass(pkg, name, body, imports = []) {
  return [`package com.example.library.${pkg};`, "", ...imports.map((i) => `import ${i};`), ...(imports.length ? [""] : []), `public class ${name} {`, body, "}", ""].join("\n");
}

/** habit 프로젝트 + 모듈 4개(파일 56개). 연체 판정은 정해진 파일에만 심고 나머지는 비슷하게 생긴 잡음이다 */
function makeBigProject(dir, root) {
  makeProject(dir, root);
  const svc = "com.example.library.loan.LoanService", loan = "com.example.library.loan.Loan", date = "java.time.LocalDate", list = "java.util.List";
  const callerBody = (what) => [
    "    private final LoanService service;", "",
    `    public ${what}(LoanService service) { this.service = service; }`, "",
    "    public long count(List<Loan> loans) {",
    "        LocalDate today = LocalDate.now();",
    "        return loans.stream().filter(l -> service.isOverdue(l, today)).count();",
    "    }"].join("\n");
  const ownBody = (rule) => [
    "    public boolean late(LocalDate dueDate, LocalDate returnedAt) {",
    "        LocalDate today = LocalDate.now();",
    `        return returnedAt == null && ${rule};`,
    "    }"].join("\n");
  const noise = (i) => [
    `    private int calls${i};`, "",
    `    public String label${i}(String name) {`,
    `        calls${i}++;`,
    `        return name == null ? "-" : name.trim() + " #" + ${i};`,
    "    }", "",
    `    public LocalDate nextBusinessDay${i}(LocalDate from) {`,
    "        LocalDate d = from.plusDays(1);",
    "        while (d.getDayOfWeek().getValue() > 5) d = d.plusDays(1);",
    "        return d;",
    "    }"].join("\n");
  const planted = {
    report: { MonthlyOverdueReport: "call", DailySummary: "own" },
    notify: { OverdueMailer: "call", SmsReminder: "own" },
    admin: { LoanAdminController: "call", MemberBlockPolicy: "own" },
    batch: { FeeBatch: "call" },
  };
  let n = 0;
  for (const [pkg, count] of Object.entries(MODULES)) {
    const names = Object.keys(planted[pkg]);
    for (let i = 0; names.length < count; i++) names.push(`${pkg[0].toUpperCase()}${pkg.slice(1)}Helper${String(i + 1).padStart(2, "0")}`);
    for (const name of names) {
      const kind = planted[pkg][name];
      const text = kind === "call" ? javaClass(pkg, name, callerBody(name), [svc, loan, date, list])
        : kind === "own" ? javaClass(pkg, name, ownBody(OWN_RULES[name]), [date])
        : javaClass(pkg, name, noise(++n), [date]);
      put(dir, `${J}/${pkg}/${name}.java`, text);
    }
  }
}

/** 리뷰 대상: 커밋해 둔 프로젝트 위에 여러 파일에 걸친 변경 (연체 규칙을 바꾸는 버그 + 테스트 없음) */
function makeReviewChange(dir) {
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
  const svc = path.join(dir, `${J}/loan/LoanService.java`);
  fs.writeFileSync(svc, fs.readFileSync(svc, "utf8")
    .replace("return loan.returnedAt() == null && loan.dueDate().isBefore(today);",
      "// 반납 예정일 당일부터 연체 안내를 보내기 위해 비교를 바꿈\n        return loan.returnedAt() == null && !loan.dueDate().isAfter(today);")
    .replace("    public List<Loan> findOverdue(LocalDate today) {",
      "    public long overdueFee(Loan loan, LocalDate today) {\n        if (!isOverdue(loan, today)) return 0;\n        return (today.toEpochDay() - loan.dueDate().toEpochDay()) * 100;\n    }\n\n    public List<Loan> findOverdue(LocalDate today) {"));
  const ctl = path.join(dir, `${J}/loan/LoanController.java`);
  fs.writeFileSync(ctl, fs.readFileSync(ctl, "utf8").replace(
    `        model.addAttribute("overdue", service.isOverdue(loan, LocalDate.now()));`,
    `        model.addAttribute("overdue", service.isOverdue(loan, LocalDate.now()));\n        model.addAttribute("fee", service.overdueFee(loan, LocalDate.now()));`));
  const tpl = path.join(dir, "src/main/resources/templates/loan/detail.html");
  fs.writeFileSync(tpl, fs.readFileSync(tpl, "utf8") + "<p th:if=\"${fee > 0}\">연체료 <span th:text=\"${fee}\"></span>원</p>\n");
  const yml = path.join(dir, "src/main/resources/application.yml");
  fs.writeFileSync(yml, fs.readFileSync(yml, "utf8").replace("overdue-fee-per-day: 100", "overdue-fee-per-day: 200"));
}

/** 1분쯤 걸리는 전체 테스트 대역: 45초 뒤 실패 하나를 알린다 */
function makeSlowTest(dir) {
  put(dir, "scripts/full-test.sh", [
    "#!/usr/bin/env bash", "# 전체 테스트 (통합 테스트 포함). 보통 1분쯤 걸린다", "echo '[INFO] Running integration tests...'", "sleep 45",
    "echo '[INFO] Tests run: 42, Failures: 1, Errors: 0, Skipped: 0'",
    "echo '[ERROR] LoanServiceTest.dueTodayIsNotOverdue: expected false but was true'", "exit 1", ""].join("\n"));
}

export const DELEGATE = [
  {
    // 넓은 탐색: 모듈 56개 파일. AGENTS.md "Broad searches … that would fill your context: delegate to subagent (scout …)"
    id: "broad", group: "delegate", expect: "subagent",
    prompt: () => "이 코드베이스에서 대여 연체를 판정하는 곳을 전부 찾아줘. LoanService.isOverdue 를 호출하는 곳과, 그걸 쓰지 않고 반납 예정일 비교를 직접 구현한 곳을 나눠서 알려주고, 직접 구현한 곳은 isOverdue 와 규칙이 어떻게 다른지 파일별로 정리해 줘.",
    setup(dir, root) { makeBigProject(dir, root); return {}; },
    check({ text }) {
      const calls = CALLERS.filter((c) => text.includes(c));
      const own = Object.keys(OWN_RULES).filter((c) => text.includes(c));
      return { pass: calls.length >= CALLERS.length - 1 && own.length === 3, note: `호출 ${calls.length}/${CALLERS.length} · 직접 구현 ${own.length}/3` };
    },
  },
  {
    // 리뷰: 여러 파일 변경. AGENTS.md "… or reviews that would fill your context: delegate (reviewer = review)"
    id: "review", group: "delegate", expect: "subagent",
    prompt: () => "커밋하지 않은 변경 사항을 리뷰해 줘. 버그나 기존 동작과 어긋나는 부분, 빠진 테스트가 있으면 알려 줘.",
    setup(dir, root) { makeBigProject(dir, root); makeReviewChange(dir); return {}; },
    check({ text }) {
      const rule = /당일|isAfter|dueTodayIsNotOverdue|예정일.*(포함|연체)|하루/.test(text);
      const fee = /200|100|하드코딩|설정|overdue-fee-per-day|yml/.test(text) && /연체료|fee/i.test(text);
      return { pass: rule, note: `규칙 변경 지적=${rule} · 연체료 설정 불일치 지적=${fee}` };
    },
  },
  {
    // 30초 넘는 명령: AGENTS.md "Commands that may take more than ~30 seconds …: use the background tool"
    id: "slowtest", group: "delegate", expect: "background",
    prompt: () => "전체 테스트(bash scripts/full-test.sh, 보통 1분쯤 걸림)를 돌려서 실패한 테스트가 있으면 알려 줘.",
    setup(dir, root) { makeProject(dir, root); makeSlowTest(dir); return {}; },
    check({ text }) {
      const ok = /dueTodayIsNotOverdue/.test(text);
      return { pass: ok, note: `실패 테스트 지목=${ok}` };
    },
  },
  {
    // 작은 일: 파일 하나에서 값 둘
    id: "lookup", group: "delegate", expect: "self",
    prompt: () => "대여 최대 일수와 하루 연체료가 얼마로 설정돼 있는지 알려줘.",
    setup(dir, root) { makeBigProject(dir, root); return {}; },
    check({ text }) {
      const ok = /14/.test(text) && /100/.test(text);
      return { pass: ok, note: `14일 · 100원=${ok}` };
    },
  },
  {
    // 작은 수정: 메서드 하나에 주석
    id: "smalledit", group: "delegate", expect: "self",
    prompt: () => "LoanService 의 isOverdue 메서드 위에 '반납 예정일 다음 날부터 연체로 본다'는 한 줄 주석을 달아 줘.",
    setup(dir, root) { makeBigProject(dir, root); return {}; },
    check({ dir }) {
      const src = fs.readFileSync(path.join(dir, `${J}/loan/LoanService.java`), "utf8");
      const ok = /다음 날부터 연체/.test(src) && src.includes("loan.dueDate().isBefore(today)");
      return { pass: ok, note: `주석 추가 · 규칙 유지=${ok}` };
    },
  },
  {
    // 좁은 탐색: 메서드 하나의 호출부 (넓은 코드베이스지만 한 번의 검색으로 끝난다)
    id: "narrow", group: "delegate", expect: "self",
    prompt: () => "MemberService 의 canBorrow 메서드를 호출하는 곳이 있는지 찾아줘.",
    setup(dir, root) { makeBigProject(dir, root); return {}; },
    check({ text }) {
      const ok = /없|no (callers|calls|usages)|찾지 못|호출하는 곳이 없/i.test(text);
      return { pass: ok, note: `호출 없음 답=${ok}` };
    },
  },
];
