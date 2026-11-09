// fetch 할 구성요소 선택 화면 (scripts/fetch-bundle.sh 가 실행한다).
//   node installer/select-components.mjs --out <file> [--root <dir>]
// 결과 파일: 선택한 구성요소 이름을 한 줄에 하나씩, 약관에 동의한 비오픈소스 구성요소는 "accepted:<name>" 줄로 기록.
// 필수(role=required) 구성요소는 항상 선택된 상태로 고정된다. 이전 선택은 <root>/.oxy-selection 에 저장해 기본값으로 쓴다.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOG, GROUPS, OPTIONAL, readLock } from "./components.mjs";
import { UI, banner, c, padDisplay } from "./tui.mjs";

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const ROOT = resolve(arg("--root") ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const OUT = arg("--out");
if (!OUT) { console.error("usage: select-components.mjs --out <file> [--root <dir>]"); process.exit(2); }

const VERSION = (() => { try { return readFileSync(join(ROOT, "VERSION"), "utf8").trim(); } catch { return "dev"; } })();
const SAVED = join(ROOT, ".oxy-selection");
const lock = readLock(ROOT);
const previous = existsSync(SAVED) ? new Set(readFileSync(SAVED, "utf8").split(/\r?\n/).filter(Boolean)) : null;

const ui = new UI();
ui.frame = () => banner(VERSION) + "  " + c.bold("반입할 구성요소 선택") + c.gray("  (인터넷 PC 에서 공식 배포처로부터 직접 내려받습니다)") + "\n";

let code = 1;
try {
  // 계층(group)별로 묶고, 계층마다 제목 줄을 넣는다
  const KIND = { engine: "엔진", cli: "CLI", connector: "커넥터" };
  const options = [];
  for (const [g, meta] of Object.entries(GROUPS)) {
    const members = lock.filter((e) => (e.group || "core") === g);
    if (!members.length) continue;
    options.push({ header: meta.title, desc: meta.desc });
    for (const e of members) {
      const cat = CATALOG[e.name] ?? { title: e.name, purpose: "" };
      const tags = [
        e.required ? c.cyan("필수") : cat.proprietary ? c.yellow("비오픈소스") : "선택",
        ...(KIND[cat.kind] ? [KIND[cat.kind]] : []),
        ...(cat.recommended ? [c.green("추천")] : []),
      ];
      options.push({
        value: e.name,
        label: `${padDisplay(cat.title, 24)} ${padDisplay(e.version, 16)}`,
        hint: `${tags.join(" · ")} · ${e.license} · ${cat.purpose}`,
        locked: e.required,
        checked: e.required || Boolean(previous?.has(e.name)),
      });
    }
  }

  for (;;) {
    const picked = await ui.multiselect("반입할 구성요소", options, {
      back: false,
      note: c.gray("  필수 항목은 기본으로 선택되어 있고 해제할 수 없습니다. 나머지는 필요한 것만 고르세요.\n" +
        "  비오픈소스 항목은 고른 뒤 약관 동의를 묻습니다. 만든 번들은 본인 반입용입니다."),
    });

    // agent-browser 는 브라우저가 따로 필요하다 (PC 에 설치된 Edge/Chrome 으로도 가능)
    const engines = ["chrome", "chromium", "obscura"];
    if (picked.includes("agent-browser") && !engines.some((n) => picked.includes(n))) {
      const go = await ui.select("agent-browser 에 쓸 브라우저 엔진을 고르지 않았습니다", [
        { label: "다시 고르기", value: "again" },
        { label: "이대로 진행 (폐쇄망 PC 에 설치된 Edge/Chrome 사용)", value: "go" },
      ], { back: false, note: c.gray("  Chrome for Testing (추천) · Chromium · obscura 중 하나를 함께 고르면 번들만으로 브라우저 자동화를 쓸 수 있습니다.") });
      if (go === "again") continue;
    }

    // 비오픈소스 구성요소: 약관 동의
    const accepted = [];
    let declined = false;
    for (const name of picked.filter((n) => CATALOG[n]?.proprietary)) {
      const e = lock.find((x) => x.name === name);
      const o = OPTIONAL[name];
      const ok = await ui.confirm(`${CATALOG[name].title} 의 약관에 동의하고 내려받을까요?`, {
        initial: false,
        note: [
          `  ${c.yellow("라이선스")} ${o?.license ?? e.license}  (오픈소스가 아님)`,
          `  ${c.gray("약관 원문")} ${o?.licenseUrl ?? "-"}`,
          `  ${c.gray("받는 곳")}   ${e.url}`,
          "",
          "  이 PC 에서 본인이 사용하기 위해 공식 배포처에서 내려받습니다.",
          "  만든 번들을 다른 사람에게 배포하는 것은 이 약관을 따로 확인해야 합니다.",
        ].join("\n"),
      });
      if (ok) accepted.push(name);
      else declined = true;
    }
    if (declined) {
      const again = await ui.select("동의하지 않은 항목이 있습니다", [
        { label: "동의하지 않은 항목을 빼고 진행", value: "drop" },
        { label: "다시 고르기", value: "again" },
      ], { back: false });
      if (again === "again") continue;
    }

    const final = picked.filter((n) => !CATALOG[n]?.proprietary || accepted.includes(n));
    writeFileSync(OUT, [...final, ...accepted.map((n) => `accepted:${n}`)].join("\n") + "\n");
    writeFileSync(SAVED, final.join("\n") + "\n");
    ui.print(`\n  ${c.green("✔")} 선택: ${final.join(", ")}`);
    code = 0;
    break;
  }
} catch (e) {
  process.stdout.write(`\n${c.red("오류:")} ${e.message}\n`);
} finally {
  ui.close();
}
process.exit(code);
