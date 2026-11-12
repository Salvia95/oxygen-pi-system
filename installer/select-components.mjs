// fetch 할 구성요소 선택 화면 (scripts/fetch-bundle.sh 가 실행한다).
//   node installer/select-components.mjs --out <file> [--root <dir>]
// 결과 파일: 선택한 구성요소 이름을 한 줄에 하나씩, 약관에 동의한 비오픈소스 구성요소는 "accepted:<name>" 줄로 기록.
// 필수(role=required) 구성요소는 항상 선택된 상태로 고정된다. 이전 선택은 <root>/.oxy-selection 에 저장해 기본값으로 쓴다.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOG, GROUPS, OPTIONAL, readLock } from "./components.mjs";
import { SYM, UI, c } from "./tui.mjs";

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const ROOT = resolve(arg("--root") ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const OUT = arg("--out");
if (!OUT) { console.error("usage: select-components.mjs --out <file> [--root <dir>]"); process.exit(2); }

const VERSION = (() => { try { return readFileSync(join(ROOT, "VERSION"), "utf8").trim(); } catch { return "dev"; } })();
const SAVED = join(ROOT, ".oxy-selection");
// 하네스 자체의 프로그램(role=harness: 화면 프로그램)은 선택 대상이 아니다. fetch 가 늘 함께 받는다
const lock = readLock(ROOT).filter((e) => e.role !== "harness");
const previous = existsSync(SAVED) ? new Set(readFileSync(SAVED, "utf8").split(/\r?\n/).filter(Boolean)) : null;

const ui = new UI();
ui.version = VERSION;
ui.setFrame({ path: ["구성요소 선택"] });

let code = 1;
try {
  // 계층(group)별로 묶는다. 레이블은 도구 이름, 값 열은 하는 일 한 줄, 버전·라이선스는 관련 정보
  const KIND = { engine: "브라우저", cli: "CLI", connector: "MCP 서버" };
  const options = [];
  for (const [g, meta] of Object.entries(GROUPS)) {
    const members = lock.filter((e) => (e.group || "core") === g);
    if (!members.length) continue;
    options.push({ header: meta.title, desc: meta.desc });
    for (const e of members) {
      const cat = CATALOG[e.name] ?? { title: e.name };
      options.push({
        value: e.name, label: cat.title, hint: cat.brief ?? "",
        locked: e.required, recommended: Boolean(cat.recommended) && !e.required,
        ...(cat.proprietary && !e.required ? { status: "약관 동의 필요" } : {}),
        detail: [...[cat.about ?? []].flat(), cat.proprietary ? "오픈소스가 아닙니다. 선택하면 다음 화면에서 약관 동의를 확인합니다." : ""].filter(Boolean),
        info: [["버전", e.version], ["라이선스", e.license], KIND[cat.kind] ? ["종류", KIND[cat.kind]] : null].filter(Boolean),
        checked: e.required || Boolean(previous?.has(e.name)),
      });
    }
  }

  for (;;) {
    const picked = await ui.multiselect("번들에 넣을 구성요소를 선택하세요", options, {
      back: false, initial: Math.max(0, options.filter((o) => !o.header).findIndex((o) => !o.locked)),
      note: "필수 구성요소는 항상 포함됩니다. 공식 배포처에서 직접 다운로드하며, 만든 번들은 본인이 사용할 용도입니다.",
    });

    // agent-browser 는 브라우저가 따로 필요하다 (PC 에 설치된 Edge/Chrome 으로도 가능)
    const engines = ["chrome", "chromium", "obscura"];
    if (picked.includes("agent-browser") && !engines.some((n) => picked.includes(n))) {
      const go = await ui.select("agent-browser용 브라우저를 선택하지 않았습니다. 어떻게 할까요?", [
        { label: "구성요소 다시 선택", value: "again", detail: "구성요소 목록으로 돌아갑니다." },
        { label: "이대로 계속", value: "go", detail: "폐쇄망 PC에 설치된 Edge나 Chrome을 사용합니다." },
      ], { back: false, result: true,
        note: "Chrome for Testing, Chromium, obscura 중 하나를 함께 선택하면 번들만으로 웹 페이지 자동화를 사용할 수 있습니다." });
      if (go === "again") continue;
    }

    // 비오픈소스 구성요소: 약관 동의
    const accepted = [];
    let declined = false;
    for (const name of picked.filter((n) => CATALOG[n]?.proprietary)) {
      const e = lock.find((x) => x.name === name);
      const o = OPTIONAL[name];
      const ok = await ui.confirm(`${CATALOG[name].title} 약관에 동의하고 다운로드할까요?`, {
        yes: "약관에 동의하고 다운로드", no: "다운로드하지 않음", level: "medium", danger: false,
        note: ["오픈소스가 아닌 구성요소입니다. 이 PC에서 본인이 사용할 용도로 공식 배포처에서 다운로드합니다.",
          "번들을 다른 사람에게 배포하려면 약관을 따로 확인하세요."],
        summary: [["라이선스", o?.license ?? e.license], ["약관", o?.licenseUrl ?? "-"], ["다운로드 주소", e.url]],
      });
      if (ok) accepted.push(name);
      else declined = true;
    }
    if (declined) {
      const again = await ui.select("약관에 동의하지 않은 구성요소가 있습니다. 어떻게 할까요?", [
        { label: "동의하지 않은 구성요소를 제외하고 계속", value: "drop" },
        { label: "구성요소 다시 선택", value: "again" },
      ], { back: false });
      if (again === "again") continue;
    }

    const final = picked.filter((n) => !CATALOG[n]?.proprietary || accepted.includes(n));
    writeFileSync(OUT, [...final, ...accepted.map((n) => `accepted:${n}`)].join("\n") + "\n");
    writeFileSync(SAVED, final.join("\n") + "\n");
    // 원격 모드에서는 화면을 닫은 뒤 본 화면에 남길 줄 (ui.end 가 찍는다)
    ui.summary = [`  ${SYM.ok} 선택한 구성요소: ${final.join(", ")}`];
    if (ui.mode === "line") ui.print(`\n${ui.summary[0]}`);
    code = 0;
    break;
  }
} catch (e) {
  ui.summary = ["", `  ${SYM.err} 구성요소를 선택하지 못했습니다: ${e.message}`];
  if (ui.mode === "line") process.stdout.write(`\n  ${c.red(SYM.err)} 구성요소를 선택하지 못했습니다: ${e.message}\n`);
}
await ui.end(code);
process.exit(code);
