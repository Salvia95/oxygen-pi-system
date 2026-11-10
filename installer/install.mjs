// oxygen-pi-system 설치 TUI. 번들에 포함된 Node 로 실행한다 (install.cmd / install.sh).
//   node installer/install.mjs [--sandbox <dir>]
//   --sandbox: 레지스트리(PATH)·바탕화면·AppData 대신 지정 폴더에만 기록 (테스트용)
// 화면 문구·배치 규칙: docs/tui-spec.md
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BACK, UI, c, errorBlock, padDisplay, rail } from "./tui.mjs";
import { WT_PROFILE_NAME, createSystem } from "./system.mjs";
import { loadConnections } from "./connections.mjs";
import {
  CATALOG, GROUPS, OPTIONAL, browserChoices, checkArchive, findArchives, hasComponent, installOptional, isInstalled, readLock, syncSkills,
} from "./components.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argSandbox = (() => { const i = process.argv.indexOf("--sandbox"); return i > 0 ? resolve(process.argv[i + 1]) : null; })();
const sys = createSystem({ root: ROOT, sandbox: argSandbox ?? process.env.OXY_INSTALLER_SANDBOX ?? null });
const VERSION = sys.version();
const ui = new UI();
ui.version = VERSION;
ui.setFrame({ right: sys.sandbox ? "[sandbox]" : "" });
const { parseEnv, mergeEnv, renderConfig, MODEL_FAMILIES, detectFamily } = await import(pathToFileURL(join(ROOT, "scripts", "render-config.mjs")).href);

const ok = (s) => `${c.green("✔")} ${s}`;
const warnMark = (s) => `${c.yellow("!")} ${s}`;
const num = (n) => Number(n).toLocaleString("en-US");
const INTEGRATION_NAMES = { path: "PATH", wt: "Windows Terminal 프로필", shortcut: "바탕화면 바로가기" };

// ------------------------------------------------------------------ 단계 표시
// 단계 줄에는 짧은 이름, 헤더·좁은 폭·줄 입력 모드에는 긴 이름 (§11.2)
const STEP_SHORT = ["점검", "폴더", "구성요소", "LLM", "모델", "GitLab", "등록", "확인"];
const STEP_LONG = ["환경 점검", "설치 폴더", "구성요소", "LLM 연결", "모델", "GitLab 연결", "실행 등록", "확인"];
const RECONF_SHORT = ["구성요소", "LLM", "모델", "GitLab", "등록", "확인"];
const RECONF_LONG = ["구성요소", "LLM 연결", "모델", "GitLab 연결", "실행 등록", "확인"];

function setFrame(stepIndex = null, names = STEP_SHORT, longNames = STEP_LONG, title = "설치") {
  ui.setFrame(stepIndex === null ? { path: title } : { steps: names, longSteps: longNames, current: stepIndex, title });
}
const NOTHING_CHANGED = "중단했습니다. 아무것도 바꾸지 않았습니다.";

/** 단계 배열을 순서대로 실행. 단계가 BACK 을 돌려주면 이전 단계로 */
/** backExits: 첫 단계에서 Esc(이전)를 누르면 흐름을 빠져나간다 (설정 다시 하기에서 메뉴로 돌아가기) */
async function runSteps(steps, state, frame, { backExits = false } = {}) {
  let i = 0;
  ui.interruptNote = () => NOTHING_CHANGED;
  while (i < steps.length) {
    setFrame(i, ...frame);
    const r = await steps[i](state);
    if (r === BACK && i === 0 && backExits) return false;
    if (r === BACK) i = Math.max(0, i - 1);
    else if (r === "cancel") return false;
    else i++;
  }
  return true;
}

// ------------------------------------------------------------------ 단계: 환경 점검
async function stepCheck(state) {
  ui.screen(`  ${c.bold("환경을 점검하는 중입니다")}\n`);
  let java;
  let missing;
  await ui.task("환경 점검", async () => {
    state.gitBash = sys.findGitBash();
    java = sys.checkJava();
    missing = sys.missingBundleFiles();
  });
  state.javaOk = java.ok;
  const row = (mark, name, value) => `  ${mark} ${padDisplay(name, 13)}  ${value}`;
  const rows = [];
  let fatal = null;
  if (state.gitBash) rows.push(row(c.green("✔"), "Git Bash", c.gray(state.gitBash)));
  else {
    rows.push(row(c.red("✖"), "Git Bash", "찾지 못함 (필수)"));
    fatal = { cause: "pi 는 Git Bash 로 명령을 실행합니다. Git for Windows 를 찾지 못했습니다", fix: "Git for Windows 를 설치한 뒤 install.cmd 를 다시 실행하세요" };
  }
  rows.push(java.ok ? row(c.green("✔"), `Java ${java.major}`, c.gray(java.detail))
    : row(c.yellow("!"), "Java", `${java.detail === "java 를 찾지 못함" ? "찾지 못함" : java.detail} — SQLcl 만 쓸 수 없고 나머지는 동작합니다`));
  const required = readLock(ROOT).filter((e) => e.required).length;
  if (missing.length === 0) rows.push(row(c.green("✔"), "번들 구성요소", `${c.gray(ROOT)} (필수 ${required}개 확인)`));
  else {
    rows.push(row(c.red("✖"), "번들 구성요소", `${missing.length}개 없음: ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? " …" : ""}`));
    fatal ??= { cause: "번들에 필수 파일이 없습니다", fix: "인터넷 PC 에서 fetch 와 번들링을 다시 하고 반입하세요" };
  }
  if (process.platform !== "win32") fatal ??= { cause: "Windows 전용 설치 도구입니다", fix: "Windows 11 PC 에서 install.cmd 를 실행하세요" };

  if (fatal) {
    ui.screen([`  ${c.bold("설치를 계속할 수 없습니다")}`, ...rows.map((l) => "  " + l), "", ...errorBlock("필수 항목이 없습니다", fatal)].join("\n"));
    await ui.pause("종료");
    return "cancel";
  }
  return ui.select("점검 결과대로 설치를 계속할까요?", [
    { label: "설치 계속", value: "next", detail: [["바뀌는 것", "다음 화면에서 설치 폴더를 고릅니다 (아직 바꾼 것 없음)"]] },
    { label: "설치 취소", value: "cancel", detail: [["바뀌는 것", "아무것도 바꾸지 않고 끝냅니다"]] },
  ], { back: false, initial: 0, note: rows, result: true });
}

// ------------------------------------------------------------------ 단계: 설치 폴더
async function stepLocation(state) {
  const inPlace = sys.isSameDir(ROOT, sys.defaultInstallDir);
  const options = [
    { label: "기본 위치에 설치", value: "default", recommended: true, hint: sys.defaultInstallDir,
      detail: [["바뀌는 것", "위 폴더에 번들 파일(약 1GB)을 복사합니다"], ["되돌리기", "install.cmd › 제거 로 지울 수 있습니다"]] },
    { label: "지금 폴더 그대로 사용", value: "inplace", hint: ROOT, disabled: inPlace ? "이미 기본 위치" : false,
      why: "이 번들이 이미 기본 위치에 있습니다", fix: "1 기본 위치에 설치를 고르세요 (복사 없이 그대로 씁니다)",
      detail: [["바뀌는 것", "복사하지 않고 이 번들 폴더를 그대로 설치 폴더로 씁니다"], ["되돌리기", "install.cmd › 제거 (폴더는 남기고 등록만 해제)"]] },
    { label: "다른 폴더 직접 입력…", value: "custom", detail: [["바뀌는 것", "다음 화면에서 폴더 경로를 입력합니다"]] },
  ];
  const k = options.findIndex((o) => o.value === state.locationChoice);
  const choice = await ui.select("어디에 설치할까요?", options, {
    ...(k >= 0 ? { initial: k } : {}),
    note: "번들(약 1GB)을 설치 폴더로 복사합니다. 이미 설치된 폴더를 고르면 설정을 유지한 채 업데이트합니다.",
  });
  if (choice === BACK) return BACK;
  state.locationChoice = choice;

  let dir = choice === "default" ? sys.defaultInstallDir : choice === "inplace" ? ROOT : null;
  for (;;) {
    if (choice === "custom") {
      const v = await ui.input("어느 폴더에 설치할까요?", {
        initial: state.installDir ?? "C:\\oxygen-pi", note: "폴더가 없으면 새로 만듭니다. 예: C:\\oxygen-pi",
        validate: (p) => (!p ? "값이 필요합니다" : !isAbsolute(p) ? "절대 경로가 아닙니다. C:\\ 처럼 드라이브부터 입력하세요" : null),
      });
      if (v === BACK) return stepLocation(state);
      dir = resolve(v);
    }
    const inside = (resolve(dir) + sep).toLowerCase().startsWith((ROOT + sep).toLowerCase()) && !sys.isSameDir(dir, ROOT);
    const kind = sys.isSameDir(dir, ROOT) ? "inplace" : sys.inspectTarget(dir);
    let problem = null;
    if (inside) problem = ["설치 폴더가 번들 폴더 안에 있습니다", "번들 폴더 밖의 폴더를 고르세요 (예: 기본 위치)"];
    else if (kind === "file") problem = ["같은 이름의 파일이 이미 있습니다", "다른 폴더 이름을 입력하세요"];
    else if (kind === "foreign") problem = ["oxygen-pi 가 아닌 파일이 들어 있는 폴더입니다", "빈 폴더나 새 폴더 이름을 고르세요. 이 폴더의 파일은 건드리지 않습니다"];
    if (problem) {
      await ui.notice("warn", `${problem[0]}\n${dir}`, { fix: problem[1] });
      if (choice === "custom") continue;
      return stepLocation(state);
    }
    state.installDir = dir;
    state.copy = kind !== "inplace";
    state.resume = kind === "ours" && Boolean(sys.readMarker(dir)?.partial);
    state.update = kind === "ours" && !state.resume;
    if (dir.length > 100) {
      const go = await ui.confirm(`긴 경로(${dir.length}자)에 그대로 설치할까요?`, {
        yes: "이 경로에 설치", no: "다른 폴더 고르기", level: "medium", danger: false,
        note: ["일부 Windows 도구는 긴 경로에서 문제가 생길 수 있습니다.", c.gray(dir)],
      });
      if (!go) { if (choice === "custom") continue; return stepLocation(state); }
    }
    return "next";
  }
}

// ------------------------------------------------------------------ 단계: 구성요소 · 런타임 선택
// 재배포하지 않는 바이너리(manifest dist=optional)는 사용자가 공식 배포처에서 직접 받은 압축 파일로만 설치한다.
const downloadsDir = process.env.USERPROFILE ? join(process.env.USERPROFILE, "Downloads") : null;
const ARCHIVE_SUBJECT = { sqlcl: "Oracle 전용 조회(SQLcl)를", chrome: "Chrome for Testing 을" };
const ARCHIVE_UNDO = { sqlcl: "tweak.cmd › DB 연결 › Oracle 전용 조회에서 교체", chrome: "tweak.cmd › 웹 페이지 자동화에서 바꿀 수 있습니다" };

/** 선택 구성요소의 압축 파일 고르기 → 경로 | "skip" | BACK */
async function pickArchive(name, { skipLabel = "설치하지 않음" } = {}) {
  const comp = OPTIONAL[name];
  const found = [...new Set([...findArchives(join(ROOT, "optional"), name), ...findArchives(downloadsDir, name)])];
  const note = [
    ...rail([["라이선스", `${comp.license} (비오픈소스, 반입 안 됨)`], ["받는 곳", ""]]),
    "  " + comp.downloadPage,
    ...(found.length ? [] : [c.gray(`Downloads 와 번들 optional/ 폴더에서 ${comp.zipRoot}*.zip 을 찾지 못했습니다.`)]),
  ];
  for (;;) {
    const v = await ui.select(`${ARCHIVE_SUBJECT[name]} 어느 파일로 설치할까요?`, [
      ...found.map((f) => ({ label: "이 파일로 설치", value: f, hint: f,
        detail: [["바뀌는 것", `sha256 을 확인한 뒤 ${comp.installDir} 에 풉니다`], ["되돌리기", ARCHIVE_UNDO[name]]] })),
      { label: "다른 파일 직접 입력…", value: "custom", detail: [["바뀌는 것", "다음 화면에서 압축 파일 경로를 입력합니다"]] },
      { label: skipLabel, value: "skip" },
    ], { note, result: true });
    if (v === BACK || v === "skip") return v;
    let file = v;
    if (v === "custom") {
      const p = await ui.input(`${comp.title} 압축 파일은 어디에 있습니까?`, {
        initial: downloadsDir ? join(downloadsDir, comp.zipRoot === "sqlcl" ? "sqlcl-latest.zip" : "chrome-win64.zip") : "",
        note: `공식 배포처에서 받은 ${comp.zipRoot}*.zip 의 전체 경로를 입력하세요.`,
        validate: (s) => (!s ? "값이 필요합니다" : !existsSync(s) ? "파일이 없습니다. 경로를 확인하거나 탐색기에서 경로 복사 후 붙여넣으세요" : null),
      });
      if (p === BACK) continue;
      file = resolve(p);
    }
    const r = await ui.task("파일 확인 (sha256)", async () => checkArchive(ROOT, name, file), { target: file });
    if (r.match) return file;
    const go = await ui.confirm("고정된 버전과 다른 파일로 설치할까요?", {
      yes: "이 파일로 설치 (버전이 다를 수 있음)", no: "다른 파일 고르기", level: "medium",
      note: [`manifest 에 고정된 ${comp.title} ${r.version} 파일과 sha256 이 다릅니다.`, ...rail([["기대", r.expected ?? "-"], ["실제", r.actual]])],
    });
    if (go) return file;
  }
}

const FETCH_FIX = "인터넷 PC 에서 fetch 로 받아 다시 번들링하세요";
const techName = (n) => (n === "sqlcl" ? "SQLcl" : n);

/**
 * 구성요소 다중 선택 행 (설치 TUI 3단계). 필수(core)는 잠금 행 하나로 묶고, 브라우저(engine)는 다음 화면에서 고른다.
 * 번들에 없고 zip 으로도 설치할 수 없는 것은 비활성(반입 안 됨). 업데이트면 이미 설치된 것은 잠금(설치됨).
 */
function componentRows(state) {
  const lock = readLock(ROOT);
  const target = state.update || state.resume ? state.installDir : null;
  const rows = [];
  for (const [group, g] of Object.entries(GROUPS)) {
    const names = [...lock.filter((e) => e.group === group).map((e) => e.name),
      ...Object.entries(CATALOG).filter(([, x]) => x.external && x.group === group).map(([n]) => n)]
      .filter((n) => CATALOG[n] && CATALOG[n].kind !== "engine");
    if (!names.length) continue;
    rows.push({ header: g.title, desc: g.desc });
    const required = names.filter((n) => lock.find((e) => e.name === n)?.required);
    if (required.length) {
      rows.push({ label: `기본 도구 ${required.length}개`, value: "__core", locked: true, hint: required.join(" · "),
        detail: [["바뀌는 것", "하네스 동작에 필요해 항상 설치합니다"]] });
    }
    for (const n of names.filter((x) => !required.includes(x))) {
      const cat = CATALOG[n];
      const inBundle = hasComponent(n, ROOT);
      const installed = Boolean(target && hasComponent(n, target));
      const row = {
        label: cat.name ?? cat.title, value: n, hint: `${techName(n)} · ${cat.brief ?? cat.purpose}`, recommended: Boolean(cat.recommended), checked: inBundle || installed,
        detail: [["바뀌는 것", `${(cat.paths ?? [cat.check]).join(" · ")} 복사${cat.skills ? ` · 도구 사용법 '${cat.name}' 켜짐` : ""}`],
          ["되돌리기", "설치 후 사용법만 끄기: tweak.cmd › 도구 사용법"]],
      };
      if (installed) Object.assign(row, { locked: true, status: "설치됨" });
      else if (!inBundle && !OPTIONAL[n]) {
        Object.assign(row, { checked: false, disabled: "반입 안 됨",
          why: cat.external ? `${n} 은 fetch 대상이 아니라 직접 반입해야 합니다` : `${n} 이 번들에 없습니다`,
          fix: cat.external ? `Windows 빌드 ${n}.exe 를 vendor/${n}/ 에 넣고 다시 번들링` : FETCH_FIX,
          blocked: `${cat.name}(${techName(n)})은(는) 반입되지 않아 고를 수 없습니다` });
      } else if (!inBundle) Object.assign(row, { checked: false, status: "반입 안 됨 · zip 으로 설치" });
      if (n === "sqlcl" && state.javaOk === false) row.status = [row.status, "! Java 17 없음"].filter(Boolean).join(" · ");
      rows.push(row);
    }
  }
  return rows;
}

/** 구성요소 단계 = 다중 선택 → (agent-browser 를 골랐으면) 브라우저 → (SQLcl 을 골랐고 번들에 없으면) 압축 파일 */
async function stepComponents(state) {
  for (;;) {
    const rows = componentRows(state);
    const items = rows.filter((r) => !r.header);
    const picked = await ui.multiselect("어떤 구성요소를 설치할까요?", rows, {
      initial: Math.max(0, items.findIndex((o) => !o.locked && !o.disabled)),
      note: "반입된 구성요소만 고를 수 있습니다. 고른 구성요소의 도구 사용법이 켜집니다.",
    });
    if (picked === BACK) return BACK;
    const required = readLock(ROOT).filter((e) => e.required).map((e) => e.name);
    state.components = [...required, ...picked.filter((n) => n !== "__core")];
    if ((await stepBrowser(state)) === BACK) continue;
    if (state.components.includes("sqlcl")) {
      if (state.installDir && isInstalled("sqlcl", state.installDir)) state.sqlcl = { action: "keep" };
      else if (hasComponent("sqlcl", ROOT)) state.sqlcl = { action: "bundle" };
      else {
        const a = await pickArchive("sqlcl");
        if (a === BACK) continue;
        state.sqlcl = a === "skip" ? { action: "skip" } : { action: "install", archive: a };
        if (a === "skip") state.components = state.components.filter((n) => n !== "sqlcl");
      }
    } else state.sqlcl = { action: "skip" };
    return "next";
  }
}

/** 설정 다시 하기의 선택 단계 = SQLcl → 브라우저 (파일을 복사하지 않으므로 구성요소 화면은 쓰지 않는다) */
async function stepOptional(state) {
  for (;;) {
    if ((await stepSqlcl(state)) === BACK) return BACK;
    if ((await stepBrowser(state)) === BACK) continue;
    return "next";
  }
}

async function stepSqlcl(state) {
  const target = state.installDir;
  const note = [OPTIONAL.sqlcl.purpose, c.gray(`라이선스 ${OPTIONAL.sqlcl.license}`)];
  if (target && isInstalled("sqlcl", target)) {
    const v = await ui.select("Oracle 전용 조회(SQLcl)는 어떻게 할까요?", [
      { label: "설치된 SQLcl 유지", value: "keep", current: true, detail: [["바뀌는 것", "아무것도 바꾸지 않습니다"]] },
      { label: "다른 파일로 교체…", value: "replace", detail: [["바뀌는 것", "다음 화면에서 압축 파일을 고르면 runtime/sqlcl 을 교체합니다"]] },
    ], { note, initial: 0 });
    if (v === BACK) return BACK;
    if (v === "keep") state.sqlcl = { action: "keep" };
    else {
      const a = await pickArchive("sqlcl", { skipLabel: "교체하지 않음 (유지)" });
      if (a === BACK) return stepSqlcl(state);
      state.sqlcl = a === "skip" ? { action: "keep" } : { action: "install", archive: a };
    }
  } else if (hasComponent("sqlcl", ROOT)) {
    // 사용자가 fetch 로 받아 번들에 넣어 온 SQLcl
    const v = await ui.select("Oracle 전용 조회(SQLcl)를 설치할까요?", [
      { label: "번들의 SQLcl 설치", value: "bundle", detail: [["바뀌는 것", "runtime/sqlcl 을 설치 폴더로 복사합니다"]] },
      { label: "다른 zip 으로 설치…", value: "zip", detail: [["바뀌는 것", "다음 화면에서 직접 받은 압축 파일을 고릅니다"]] },
      { label: "설치하지 않음", value: "skip", detail: [["나중에", "tweak.cmd › DB 연결 › Oracle 전용 조회"]] },
    ], { note, initial: 0 });
    if (v === BACK) return BACK;
    if (v === "zip") {
      const a = await pickArchive("sqlcl");
      if (a === BACK) return stepSqlcl(state);
      state.sqlcl = a === "skip" ? { action: "skip" } : { action: "install", archive: a };
    } else state.sqlcl = { action: v };
  } else {
    const a = await pickArchive("sqlcl");
    if (a === BACK) return BACK;
    state.sqlcl = a === "skip" ? { action: "skip" } : { action: "install", archive: a };
  }
  return "next";
}

let browserList = null;
async function stepBrowser(state) {
  const target = state.installDir;
  // agent-browser 를 반입(또는 선택)하지 않았으면 브라우저 선택은 의미가 없다
  const wanted = state.components ? state.components.includes("agent-browser") : true;
  if (!wanted || (!hasComponent("agent-browser", ROOT) && !(target && hasComponent("agent-browser", target)))) {
    state.browser = { id: "none", label: "사용 안 함 (agent-browser 없음)" };
    return "next";
  }

  for (;;) {
    // PC 에 설치된 Edge·Chrome 의 버전을 읽느라 느릴 수 있어 먼저 알린다 (한 실행에서 한 번)
    if (!browserList) {
      ui.screen(`  ${c.bold("PC 에 설치된 브라우저를 찾는 중입니다")}\n`);
      browserList = await ui.task("PC 에 설치된 브라우저 찾기", async () => browserChoices(ROOT));
    }
    const choices = browserList;
    const cftReady = Boolean(target && isInstalled("chrome", target));
    const opts = choices.map((b) => ({
      label: b.label, value: b.id, recommended: b.recommended, current: Boolean(state.tweak && state.browser?.id === b.id),
      hint: b.id === "chrome-for-testing" && cftReady ? "설치됨 · 버전 고정" : b.hint,
      detail: [b.why && [b.recommended ? "추천 근거" : "참고", b.why], ["바뀌는 것", `agent/oxy.env 의 OXY_BROWSER=${b.id}`],
        !state.tweak && ["되돌리기", "tweak.cmd › 웹 페이지 자동화에서 바꿀 수 있습니다"]].filter(Boolean),
    }));
    const k = opts.findIndex((o) => o.value === state.browser?.id);
    const id = await ui.select("agent-browser 가 쓸 브라우저는 무엇으로 할까요?", opts, {
      ...(k >= 0 ? { initial: k } : {}),
      note: "web-page-automation skill 이 이 브라우저로 사내 웹 페이지를 엽니다.",
    });
    if (id === BACK) return BACK;
    const pick = choices.find((b) => b.id === id);
    state.browser = { id, path: pick.path ?? "", label: pick.label };
    if (pick.needs && !cftReady) {
      const a = await pickArchive(pick.needs, { skipLabel: "다른 브라우저 고르기" });
      if (a === BACK || a === "skip") continue;
      state.browser.archive = a;
    }
    return "next";
  }
}

/** 번들에 들어 있지만 사용자가 고르지 않은 구성요소는 설치 폴더로 복사하지 않는다 */
function copyExcludes(state) {
  const ex = [];
  if (state.components) {
    for (const [name, cat] of Object.entries(CATALOG)) {
      if (cat.paths && cat.kind !== "engine" && !state.components.includes(name)) ex.push(...cat.paths);
    }
  }
  if (state.sqlcl?.action !== "bundle" && !ex.includes("runtime/sqlcl")) ex.push("runtime/sqlcl");
  if (state.browser?.id !== "chrome-for-testing" || state.browser?.archive) ex.push("vendor/browsers/chrome-win64");
  if (state.browser?.id !== "chromium") ex.push("vendor/browsers/chromium");
  return ex;
}

async function applyOptional(state) {
  if (state.sqlcl?.action === "install") {
    await ui.task("Oracle 전용 조회(SQLcl) 설치", async () => { installOptional("sqlcl", state.sqlcl.archive, state.installDir); });
  }
  if (state.browser?.archive) {
    await ui.task("Chrome for Testing 설치", async () => { installOptional("chrome", state.browser.archive, state.installDir); });
  }
}

// ------------------------------------------------------------------ 단계: LLM 연결
function normalizeBaseUrl(u) {
  let s = u.trim().replace(/\/+$/, "");
  try { const url = new URL(s); if (url.pathname === "" || url.pathname === "/") s += "/v1"; } catch { /* validate 에서 처리 */ }
  return s;
}

async function fetchModels(baseUrl, apiKey) {
  const r = await fetch(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${apiKey || "EMPTY"}` }, signal: AbortSignal.timeout(6000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
  const j = await r.json();
  const models = (j.data ?? []).map((m) => ({ id: m.id, maxLen: Number(m.max_model_len) || null }));
  if (models.length === 0) {
    throw Object.assign(new Error("모델 목록이 비어 있음"), {
      why: "서버에 띄운 모델이 없습니다", fix: "vLLM --served-model-name 을 확인하세요. 연결 확인 없이 계속하면 이름을 직접 입력합니다",
    });
  }
  return models;
}

/** 확장 파라미터마다 시험할 값 */
const PROBE_VALUES = { top_k: 20, repetition_penalty: 1.05, min_p: 0, chat_template_kwargs: { enable_thinking: false }, reasoning_effort: "low" };

/** 사용량 제한(분당 토큰)이 이 값 이하인 엔드포인트에는 맞춤 설정을 제안한다 (사내 vLLM 은 보통 헤더가 없다) */
const RATE_LIMITED_TPM = 30000;
/** 분당 토큰 한도에 맞춘 설정: 서버가 알려 준 대기 후 재시도 · 응답 상한 · subagent 동시 실행 1 */
export function endpointPreset(tpm) {
  return { retries: 4, maxOut: Math.max(512, Math.min(4096, Math.floor(tpm / 8))), concurrency: 1 };
}

/**
 * 서버(또는 앞단 게이트웨이)가 vLLM 확장 파라미터를 받는지 1토큰 요청으로 하나씩 시험한다.
 * → { results: {param: true|false}, drop: [거부된 것], detail } · 기본 요청부터 실패하면 results 가 null (판단 못 함)
 */
async function probeParams(baseUrl, apiKey, model) {
  const call = async (extra) => {
    const r = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST", signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${apiKey || "EMPTY"}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 1, ...extra }),
    });
    const tpm = Number(r.headers.get("x-ratelimit-limit-tokens")) || null;
    return { status: r.status, text: r.ok ? "" : (await r.text()).slice(0, 200), tpm };
  };
  try {
    const base = await call({});
    if (base.status >= 300) return { results: null, drop: [], detail: `기본 요청 HTTP ${base.status} ${base.text}`, tpm: base.tpm };
    const results = {};
    const errors = [];
    for (const [k, v] of Object.entries(PROBE_VALUES)) {
      const r = await call({ [k]: v });
      results[k] = r.status < 300;
      if (!results[k]) errors.push(r.text);
    }
    return { results, drop: Object.keys(results).filter((k) => !results[k]), detail: errors[0] ?? "", tpm: base.tpm };
  } catch (e) {
    return { results: null, drop: [], detail: e.cause?.code ?? e.message };
  }
}

async function stepVllm(state) {
  for (;;) {
    const url = await ui.input("어느 LLM 서버에 연결할까요?", {
      initial: state.baseUrl ?? "http://",
      note: ["vLLM 등 OpenAI 호환 주소입니다. /v1 이 없으면 자동으로 붙입니다.", "예: http://vllm.example.internal:8000/v1"],
      validate: (v) => {
        const msg = "http:// 또는 https:// 로 시작해야 합니다. 예: http://vllm.example.internal:8000";
        try { const u = new URL(v.trim()); return /^https?:$/.test(u.protocol) && u.hostname ? null : msg; } catch { return msg; }
      },
    });
    if (url === BACK) return BACK;
    state.baseUrl = normalizeBaseUrl(url);

    const key = await ui.input("LLM 서버에 어떤 API 키로 접속할까요?", {
      initial: state.apiKey && state.apiKey !== "EMPTY" ? state.apiKey : "", mask: true,
      note: "vLLM 을 --api-key 없이 띄웠다면 비워 두세요. 키는 agent/oxy.env 에만 저장되고 화면·로그에 다시 보이지 않습니다.",
    });
    if (key === BACK) continue;
    state.apiKey = key || "EMPTY";

    ui.screen(`  ${c.bold("LLM 서버를 시험하는 중입니다")}\n  ${c.gray(state.baseUrl)}\n`);
    let models;
    try {
      models = await ui.task("모델 목록 (/v1/models)", async () => fetchModels(state.baseUrl, state.apiKey));
    } catch (e) {
      const choice = await ui.select("LLM 서버 연결 실패를 어떻게 처리할까요?", [
        { label: "주소·키 다시 입력", value: "retry" },
        { label: "연결 확인 없이 계속 (모델 이름 직접 입력)", value: "skip", detail: [["바뀌는 것", "모델 목록 없이 다음 화면에서 모델 이름을 입력합니다"]] },
      ], { back: false, initial: 0, result: true, note: [c.gray(state.baseUrl), ...errorBlock("모델 목록을 받지 못했습니다", e).map((l) => l.slice(2))] });
      if (choice === "skip") { state.models = []; return "next"; }
      continue;
    }
    state.models = models;
    const probeModel = models.some((m) => m.id === state.coder) ? state.coder : models[0].id;
    const p = await ui.task(`확장 파라미터 시험 (${probeModel})`, async () => probeParams(state.baseUrl, state.apiKey, probeModel));
    const lines = [ok(`모델 ${models.length}개  ${models.map((m) => m.id).join(", ")}`)];
    if (p.results) {
      const yes = Object.keys(p.results).filter((k) => p.results[k]);
      if (yes.length) lines.push(ok(`지원      ${yes.join(", ")}`));
      for (const k of p.drop) lines.push(warnMark(`${k}: 서버가 거부 → 요청에서 뺌`));
      if (p.detail) lines.push(c.gray(`    ${p.detail}`));
    } else lines.push(warnMark(`확장 파라미터: 확인 못 함 (기존 설정 유지) ${c.gray(p.detail)}`));
    const go = await ui.select("LLM 서버 시험 결과대로 계속할까요?", [
      { label: state.tweak ? "이 결과로 저장" : "모델 고르기로 넘어가기", value: "next",
        detail: p.results && p.drop.length
          ? [["바뀌는 것", `거부된 파라미터 ${p.drop.length}개를 요청에서 뺍니다 (OXY_VLLM_DROP_PARAMS)`], ["되돌리기", "tweak.cmd › LLM 연결 › 요청 조정"]]
          : [["바뀌는 것", p.results ? "확장 파라미터를 모두 보냅니다" : "확장 파라미터 설정은 그대로 둡니다"]] },
      { label: "주소·키 다시 입력", value: "retry" },
    ], { initial: 0, note: lines.map((l) => "  " + l), result: true });
    if (go !== "next") continue;
    // 판단할 수 없으면 이전 값 유지
    if (p.results) state.dropParams = p.drop;
    // 사용량 제한이 있는 엔드포인트 (응답 헤더 x-ratelimit-limit-tokens) → 맞춤 설정 제안
    if (p.tpm && p.tpm <= RATE_LIMITED_TPM) {
      const preset = endpointPreset(p.tpm);
      const v = await ui.select("사용량 제한에 맞춰 설정을 바꿀까요?", [
        { label: "제한에 맞춘 설정 적용", value: "apply", recommended: true,
          detail: [["바뀌는 것", `거부되면 기다렸다 재시도 ${preset.retries}회 · 응답 최대 ${preset.maxOut} 토큰 · subagent ${preset.concurrency}개`],
            ["되돌리기", "tweak.cmd › LLM 연결 › 요청 조정에서 값마다 바꿀 수 있습니다"]] },
        { label: "설정 그대로 두기", value: "keep", detail: [["바뀌는 것", "아무것도 바꾸지 않습니다. 제한을 넘으면 요청이 거부됩니다"]] },
      ], { back: false, initial: 0, note: `이 엔드포인트는 분당 ${p.tpm.toLocaleString()} 토큰으로 제한됩니다. 넘으면 요청이 거부됩니다.` });
      if (v === "apply") state.endpoint = preset;
    }
    return "next";
  }
}

// ------------------------------------------------------------------ 단계: 모델
async function stepModel(state) {
  const list = state.models ?? [];
  if (list.length > 0) {
    const opts = list.map((m) => ({ label: m.id, value: m.id, hint: m.maxLen ? `${Math.round(m.maxLen / 1024)}K` : "", current: Boolean(state.tweak && m.id === state.coder) }));
    const k = opts.findIndex((o) => o.value === state.coder);
    const coder = await ui.select("코딩용 기본 모델은 무엇으로 할까요?", opts, { initial: Math.max(0, k), note: "pi 가 기본으로 쓰는 모델입니다." });
    if (coder === BACK) return BACK;
    state.coder = coder;
    const rest = [...opts.filter((o) => o.value !== coder).map((o) => ({ ...o, current: Boolean(state.tweak && o.value === state.general) })),
      { label: "사용 안 함", value: "", current: Boolean(state.tweak && !state.general) }];
    const general = await ui.select("범용 모델은 무엇으로 할까요?", rest,
      { initial: Math.max(0, rest.findIndex((o) => o.value === (state.general ?? ""))), note: "선택 사항입니다. /model 명령으로 전환해서 쓰는 보조(thinking) 모델입니다." });
    if (general === BACK) return stepModel(state);
    state.general = general;
  } else {
    const coder = await ui.input("코딩용 모델 이름은 무엇입니까?", { initial: state.coder ?? "", note: "vLLM --served-model-name 값과 같아야 합니다.", validate: (v) => (v ? null : "값이 필요합니다") });
    if (coder === BACK) return BACK;
    state.coder = coder;
    const general = await ui.input("범용 모델 이름은 무엇입니까?", { initial: state.general ?? "", note: "선택 사항입니다. 없으면 비워 두세요." });
    if (general === BACK) return stepModel(state);
    state.general = general === state.coder ? "" : general;
  }
  state.defaultModel = state.coder;

  const lens = list.filter((m) => [state.coder, state.general].includes(m.id) && m.maxLen).map((m) => m.maxLen);
  const detected = lens.length ? Math.min(...lens) : null;
  const ctx = await ui.input("컨텍스트 길이는 몇 토큰으로 할까요?", {
    initial: String(detected ?? state.contextWindow ?? 131072),
    note: detected ? `vLLM 이 알려 준 max_model_len 은 ${detected} 입니다.` : "vLLM --max-model-len 값과 맞추세요.",
    validate: (v) => (/^\d+$/.test(v) && Number(v) >= 8192 ? null : "8192 이상의 숫자여야 합니다. vLLM --max-model-len 값과 맞추세요"),
  });
  if (ctx === BACK) return stepModel(state);
  state.contextWindow = Number(ctx);

  // 모델 계열: thinking 제어 방식과 권장 샘플링 값이 정해진다 (id 로 추정한 값이 (추천))
  for (const [role, id] of [["coder", state.coder], ["general", state.general]]) {
    if (!id) continue;
    const key = role === "coder" ? "coderFamily" : "generalFamily";
    const guess = detectFamily(id);
    const opts = Object.entries(MODEL_FAMILIES).map(([k, f]) => ({
      label: f.label, value: k, recommended: k === guess, current: Boolean(state.tweak && state[key] === k),
      detail: k === guess ? [["추천 근거", `모델 이름 ${id} 으로 추정했습니다`]] : [],
    }));
    const fam = await ui.select(`${id} 의 모델 계열은 무엇으로 할까요?`, opts, {
      initial: Math.max(0, opts.findIndex((o) => o.value === (state[key] ?? guess))),
      note: "thinking(추론)을 켜고 끄는 방식과 권장 샘플링 값이 계열마다 다릅니다.",
    });
    if (fam === BACK) return stepModel(state);
    state[key] = fam;
  }
  return "next";
}

// ------------------------------------------------------------------ 단계: GitLab 연결
async function stepGitlab(state) {
  const host = await ui.input("어느 GitLab 호스트를 쓸까요?", {
    initial: state.gitlabHost ?? "",
    note: ["선택 사항입니다. 비워 두면 건너뜁니다. 토큰은 설치 후 glab auth login 으로 등록합니다.", "예: gitlab.example.internal"],
    validate: (v) => (v === "" || /^[a-z0-9.-]+(:\d+)?$/i.test(v.replace(/^https?:\/\//, "").replace(/\/+$/, ""))
      ? null : "호스트 이름만 입력하세요. 예: gitlab.example.internal (경로는 빼고)"),
  });
  if (host === BACK) return BACK;
  state.gitlabHost = host.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return "next";
}

// ------------------------------------------------------------------ 단계: 실행 등록
const INTEGRATIONS = [
  { label: "어디서나 oxy 실행", value: "path", hint: "PATH 등록 · cmd·PowerShell·Git Bash",
    detail: [["바뀌는 것", "사용자 환경변수 PATH 에 설치 폴더를 더하고 OXY_HOME 을 둡니다"], ["되돌리기", "tweak.cmd › 실행 등록에서 해제할 수 있습니다"]] },
  { label: "터미널 탭", value: "wt", hint: `Windows Terminal '${WT_PROFILE_NAME}' 프로필`,
    detail: [["바뀌는 것", "Windows Terminal 설정 파일은 고치지 않고 fragment 파일을 새로 만듭니다"], ["되돌리기", "tweak.cmd › 실행 등록에서 해제할 수 있습니다"]] },
  { label: "바탕화면 바로가기", value: "shortcut", hint: "Oxygen Pi.lnk",
    detail: [["바뀌는 것", "바탕화면에 Oxygen Pi.lnk 를 만듭니다"], ["되돌리기", "tweak.cmd › 실행 등록에서 해제할 수 있습니다"]] },
];
async function stepIntegrate(state) {
  const prev = state.integrations;
  const has = (k) => (prev ? prev.includes(k) : true);
  const v = await ui.multiselect("어디에서 oxy 를 실행할 수 있게 할까요?", INTEGRATIONS.map((x) => ({ ...x, checked: has(x.value) })));
  if (v === BACK) return BACK;
  state.integrations = v;
  return "next";
}

// ------------------------------------------------------------------ 단계: 확인
function summary(state) {
  const o = state.orig;
  const changed = (k, v) => (o && o[k] !== undefined && JSON.stringify(o[k]) !== JSON.stringify(v) ? " " + c.gray("(바뀜)") : "");
  const family = (id, f) => `${id} · ${f ?? detectFamily(id)}`;
  const required = new Set(readLock(ROOT).filter((e) => e.required).map((e) => e.name));
  const comps = state.components ? `기본 도구 ${required.size}개 + 선택 ${state.components.filter((n) => !required.has(n)).length}개` : "";
  const sqlcl = state.sqlcl ? { keep: "SQLcl 설치된 것 유지", bundle: "SQLcl 번들에서 설치", skip: c.gray("SQLcl 설치 안 함"), install: `SQLcl ${state.sqlcl.archive ?? ""} 에서 설치` }[state.sqlcl.action] : "";
  const removed = o?.integrations ? o.integrations.filter((k) => !(state.integrations ?? []).includes(k)) : [];
  const where = state.copy ? (state.resume ? c.yellow(" (끊긴 설치를 이어서 복사)") : state.update ? c.yellow(" (기존 설치 업데이트, 설정 유지)") : "") : c.gray(" (복사 안 함)");
  return rail([
    ["설치 폴더", `${state.installDir}${where}`],
    ["LLM 서버", `${state.baseUrl} · API 키 ${state.apiKey === "EMPTY" ? "없음" : "입력됨"}${changed("baseUrl", state.baseUrl)}`],
    ["코딩 모델", family(state.coder, state.coderFamily) + changed("coder", state.coder)],
    ["범용 모델", (state.general ? family(state.general, state.generalFamily) : c.gray("사용 안 함")) + changed("general", state.general ?? "")],
    state.endpoint ? ["요청 조정", `재시도 ${state.endpoint.retries}회 · 응답 최대 ${state.endpoint.maxOut ?? "모델 기본"} 토큰`] : null,
    ["컨텍스트 길이", `${num(state.contextWindow)} 토큰${changed("contextWindow", state.contextWindow)}`],
    ["GitLab", (state.gitlabHost || c.gray("건너뜀")) + changed("gitlabHost", state.gitlabHost ?? "")],
    comps || sqlcl ? ["구성요소", [comps, sqlcl].filter(Boolean).join(" · ")] : null,
    state.browser ? ["브라우저", `${state.browser.label ?? state.browser.id}${state.browser.archive ? c.gray(" " + state.browser.archive) : ""}${changed("browserId", state.browser.id)}`] : null,
    state.integrations ? ["실행 등록", (state.integrations.length ? state.integrations.map((k) => INTEGRATION_NAMES[k]).join(" · ") : c.gray("없음")) +
      (removed.length ? " " + c.gray(`(해제: ${removed.map((k) => INTEGRATION_NAMES[k]).join(" · ")})`) : "")] : null,
  ], { wrap: ui.cols() - 2 });
}

async function stepReview(state) {
  const reconf = Boolean(state.orig);
  return ui.select(reconf ? "이대로 설정을 적용할까요?" : "이대로 설치할까요?", [
    { label: reconf ? "설정 적용" : "설치 시작", value: "next", hint: !reconf && state.copy ? "약 1GB 복사" : "" },
    { label: "← 이전 단계", value: BACK },
    { label: reconf ? "변경 취소" : "설치 취소", value: "cancel", hint: "아무것도 바꾸지 않고 끝냅니다" },
  ], { back: true, initial: 0, note: summary(state), result: true });
}

// ------------------------------------------------------------------ 실행
function writeSiteConfig(installDir, state) {
  const agent = join(installDir, "agent");
  const envFile = join(agent, "oxy.env");
  const base = existsSync(envFile) ? readFileSync(envFile, "utf8") : readFileSync(join(agent, "oxy.env.example"), "utf8");
  const updates = {
    OXY_VLLM_BASE_URL: state.baseUrl, OXY_VLLM_API_KEY: state.apiKey,
    OXY_MODEL_CODER: state.coder, OXY_MODEL_GENERAL: state.general ?? "", OXY_DEFAULT_MODEL: state.defaultModel,
    OXY_CONTEXT_WINDOW: String(state.contextWindow),
    ...(state.dropParams ? { OXY_VLLM_DROP_PARAMS: state.dropParams.join(",") } : {}),
    ...(state.coderFamily ? { OXY_MODEL_CODER_FAMILY: state.coderFamily } : {}),
    ...(state.generalFamily && state.general ? { OXY_MODEL_GENERAL_FAMILY: state.generalFamily } : {}),
    ...(state.endpoint ? {
      OXY_PROVIDER_RETRIES: String(state.endpoint.retries ?? 0),
      OXY_MAX_OUTPUT_TOKENS: state.endpoint.maxOut ? String(state.endpoint.maxOut) : "",
      ...(state.endpoint.concurrency ? { OXY_LLM_MAX_CONCURRENT: String(state.endpoint.concurrency) } : {}),
    } : {}),
    ...(state.gitlabHost ? { GITLAB_HOST: state.gitlabHost } : {}),
    // 번들 안의 브라우저(chrome-for-testing, chromium)는 env.sh 가 OXY_HOME 기준으로 경로를 계산한다
    ...(state.browser ? { OXY_BROWSER: state.browser.id, OXY_BROWSER_PATH: (state.browser.path ?? "").replace(/\\/g, "/") } : {}),
    ...(state.skillsOff ? { OXY_SKILLS_OFF: state.skillsOff.join(",") } : {}),
  };
  writeFileSync(envFile, mergeEnv(base, updates));
  const vars = { ...parseEnv(readFileSync(envFile, "utf8")), OXY_SHELL_PATH: state.gitBash.replace(/\\/g, "/") };
  const n = renderConfig(agent, vars).length;
  // 설치된 구성요소에 해당하는 skill 만 켠다 (사용자가 끈 OXY_SKILLS_OFF 는 빼고)
  state.skills = syncSkills(installDir, agent, { browser: vars.OXY_BROWSER, off: vars.OXY_SKILLS_OFF });
  return n;
}

async function applyIntegrations(state, reg) {
  const want = new Set(state.integrations ?? []);
  const dir = state.installDir;
  if (want.has("path")) await ui.task("PATH 등록", async () => { sys.addUserPath(dir); reg.path = true; });
  else if (reg.path) await ui.task("PATH 등록 해제", async () => { sys.removeUserPath(dir); reg.path = false; });
  if (want.has("wt")) await ui.task("Windows Terminal 프로필 등록", async () => { reg.terminalProfile = sys.addTerminalProfile(dir, state.gitBash); });
  else if (reg.terminalProfile) await ui.task("Windows Terminal 프로필 해제", async () => { sys.removeTerminalProfile(reg.terminalProfile); reg.terminalProfile = null; });
  if (want.has("shortcut")) await ui.task("바탕화면 바로가기 등록", async () => { reg.shortcut = sys.addShortcut(dir, state.gitBash, want.has("wt")); });
  else if (reg.shortcut) await ui.task("바탕화면 바로가기 해제", async () => { sys.removeShortcut(reg.shortcut); reg.shortcut = null; });
}

/** 설치·업데이트 중 Ctrl+C: 반쯤 된 상태를 한 줄로 */
function setInstallInterrupt() {
  ui.interruptNote = () => {
    const t = ui.current;
    if (!t) return "중단했습니다. install.cmd 를 다시 실행하면 이어서 설치합니다.";
    if (t.label === "파일 복사") return `중단했습니다. 파일 복사 ${t.extra.replace(/ \(.*$/, "") || "도중"} 에서 멈췄습니다 — install.cmd 를 다시 실행하면 이어서 설치합니다.`;
    return `중단했습니다. ${t.label} 을(를) 마치지 못했습니다 — install.cmd 를 다시 실행하세요.`;
  };
}

/** 번들 → 설치 폴더 복사 (진행률 숫자). 복사 전에 설치 표시(partial)를 쓴다 */
async function copyFiles(state) {
  await ui.task("설치 표시 기록", async () => { mkdirSync(state.installDir, { recursive: true }); sys.writeMarker(state.installDir, { partial: true }); });
  await ui.task("파일 복사", async (update) => {
    let at = "";
    try {
      const n = await sys.copyBundle(state.installDir, (d, t) => {
        const pct = Math.floor((d / t) * 100);
        at = `${num(d)}/${num(t)}`;
        update(`${at} (${pct}%)`, pct);
      }, copyExcludes(state));
      return `${num(n)}개`;
    } catch (e) { e.stoppedAt = at ? `${at} 에서 멈춤` : ""; throw e; }
  });
}

async function finishWithVerify(state, lead = "설치를 마쳤습니다.") {
  const run = await ui.confirm("동작 시험(verify)을 실행할까요?", {
    yes: "동작 시험 실행", no: "건너뛰기", recommended: true,
    note: `${lead} 번들 도구, pi 설정, LLM 서버 연결과 tool calling 을 실제로 확인합니다 (약 30초).`,
    detail: { yes: [["바뀌는 것", "아무것도 바꾸지 않습니다. 결과만 보여 줍니다"]], no: [["나중에", "install.cmd › 동작 시험 또는 tweak.cmd › 동작 시험"]] },
  });
  let passed = null;
  if (run) {
    ui.screen(`  ${c.bold("동작 시험 (verify)")}\n`);
    passed = sys.runVerify(state.installDir, state.gitBash);
  }
  return passed;
}

async function install(state) {
  if (!(await runSteps([stepCheck, stepLocation, stepComponents, stepVllm, stepModel, stepGitlab, stepIntegrate, stepReview], state, [STEP_SHORT, STEP_LONG]))) {
    ui.print("\n  설치를 취소했습니다. 아무것도 바꾸지 않았습니다.");
    return 1;
  }
  setFrame(STEP_SHORT.length);
  setInstallInterrupt();
  ui.screen(`  ${c.bold("설치하는 중입니다")}\n  ${c.gray(state.installDir)}\n`);
  const reg = sys.loadRegistry() ?? {};
  try {
    if (state.copy) await copyFiles(state);
    else await ui.task("설치 표시 기록", async () => sys.writeMarker(state.installDir));
    await applyOptional(state);
    await ui.task("설정 생성 (oxy.env, settings.json, models.json)", async () => `${writeSiteConfig(state.installDir, state)}개 파일`);
    await applyIntegrations(state, reg);
    sys.saveRegistry({ ...reg, version: VERSION, installDir: state.installDir, copied: state.copy, gitBash: state.gitBash,
      integrations: state.integrations, installedAt: new Date().toISOString() });
  } catch (e) {
    if (!e?.reported) errorBlock("설치하지 못했습니다", e).forEach((l) => ui.print(l));
    await ui.pause("종료");
    return 1;
  }
  const passed = await finishWithVerify(state);
  await done(state, passed);
  return 0;
}

async function done(state, passed) {
  const lines = [
    `  ${c.green("✔")} ${c.bold(state.doneTitle ?? "설치를 마쳤습니다")}  ${c.gray(state.installDir)}`,
    ...(passed === false ? [`  ${c.yellow("!")} 동작 시험에 FAIL/WARN 이 있습니다. 위로 스크롤해 결과를 보세요`] : []),
    "", `  ${c.bold("시작하기")}`,
    ...rail([
      state.integrations?.includes("path") ? ["새 터미널에서", "cd <프로젝트 폴더>  다음  oxy"] : ["실행", `${state.installDir}\\oxy.cmd`],
      state.integrations?.includes("wt") ? ["Windows Terminal", `새 탭 › ${WT_PROFILE_NAME} 프로필`] : null,
      state.gitlabHost ? ["GitLab 토큰", `glab auth login --hostname ${state.gitlabHost}`] : null,
    ], { indent: 4, width: 16 }),
    "", `  ${c.bold("나중에")}`,
    ...rail([
      ["설정 바꾸기", "tweak.cmd (설치 폴더) — LLM 연결 · DB 연결 · 도구 사용법"],
      state.sqlcl?.action === "skip" ? ["Oracle 전용 조회", "tweak.cmd › DB 연결 › Oracle 전용 조회에서 zip 으로 설치"] : null,
      ["업데이트 · 제거", "install.cmd"],
    ], { indent: 4, width: 16 }),
  ];
  ui.screen(lines.join("\n"));
  await ui.pause("종료");
}

// ------------------------------------------------------------------ 설치 후 관리 메뉴
function stateFromInstall(reg) {
  const envFile = join(reg.installDir, "agent", "oxy.env");
  const env = existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf8")) : {};
  return {
    installDir: reg.installDir, copy: reg.copied, gitBash: reg.gitBash && existsSync(reg.gitBash) ? reg.gitBash : sys.findGitBash(),
    baseUrl: env.OXY_VLLM_BASE_URL, apiKey: env.OXY_VLLM_API_KEY, coder: env.OXY_MODEL_CODER,
    general: env.OXY_MODEL_GENERAL ?? "", defaultModel: env.OXY_DEFAULT_MODEL,
    contextWindow: Number(env.OXY_CONTEXT_WINDOW) || 131072, gitlabHost: env.GITLAB_HOST,
    ...(env.OXY_VLLM_DROP_PARAMS != null ? { dropParams: env.OXY_VLLM_DROP_PARAMS.split(/[\s,]+/).filter(Boolean) } : {}),
    ...(env.OXY_MODEL_CODER_FAMILY ? { coderFamily: env.OXY_MODEL_CODER_FAMILY } : {}),
    ...(env.OXY_MODEL_GENERAL_FAMILY ? { generalFamily: env.OXY_MODEL_GENERAL_FAMILY } : {}),
    ...(env.OXY_PROVIDER_RETRIES || env.OXY_MAX_OUTPUT_TOKENS ? { endpoint: {
      retries: Number(env.OXY_PROVIDER_RETRIES) || 0, maxOut: Number(env.OXY_MAX_OUTPUT_TOKENS) || null,
      concurrency: Number(env.OXY_LLM_MAX_CONCURRENT) || null } } : {}),
    integrations: reg.integrations ?? [],
    ...(env.OXY_BROWSER ? { browser: { id: env.OXY_BROWSER, path: env.OXY_BROWSER_PATH ?? "" } } : {}),
  };
}

async function reconfigure(reg, { saveRegistry = true } = {}) {
  const state = { ...stateFromInstall(reg), doneTitle: "설정을 적용했습니다" };
  state.orig = { baseUrl: state.baseUrl, coder: state.coder, general: state.general ?? "", contextWindow: state.contextWindow,
    gitlabHost: state.gitlabHost ?? "", browserId: state.browser?.id, integrations: [...(state.integrations ?? [])] };
  const ok2 = await runSteps([stepOptional, stepVllm, stepModel, stepGitlab, stepIntegrate, stepReview], state,
    [RECONF_SHORT, RECONF_LONG, "설정 다시 하기"], { backExits: true });
  if (!ok2) return 1;
  setFrame(RECONF_SHORT.length, RECONF_SHORT, RECONF_LONG, "설정 다시 하기");
  setInstallInterrupt();
  ui.screen(`  ${c.bold("설정 적용 중")}\n`);
  await applyOptional(state);
  await ui.task("설정 생성", async () => `${writeSiteConfig(state.installDir, state)}개 파일`);
  await applyIntegrations(state, reg);
  if (saveRegistry) sys.saveRegistry({ ...reg, integrations: state.integrations, updatedAt: new Date().toISOString() });
  const passed = await finishWithVerify(state, "설정을 적용했습니다.");
  await done(state, passed);
  return 0;
}

const bytesText = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)}GB` : `${Math.max(1, Math.round(b / 1e6))}MB`);

/**
 * 제거 (무거움, §4.6). ① 대상·수량·함께 사라지는 것·백업을 보이고 초기 포커스는 '제거 취소'
 * ② 복사 설치(폴더 삭제)일 때만 폴더 이름을 입력해야 진행. 복사 설치가 아니면 ① 의 중간 확인으로 끝난다
 */
async function uninstall(reg) {
  setFrame(null, undefined, undefined, "설치 관리 › 제거");
  const backup = sys.registryFile.replace(/install\.json$/, "oxy.env.bak");
  const agent = join(reg.installDir, "agent");
  let stats = null;
  if (reg.copied) {
    ui.screen(`  ${c.bold("삭제할 파일을 세는 중입니다")}\n  ${c.gray(reg.installDir)}\n`);
    stats = await ui.task("삭제할 파일 세기", async () => sys.dirStats(reg.installDir));
  }
  const conns = loadConnections(agent).length;
  const secrets = existsSync(join(agent, "secrets.json"));
  const registered = [reg.path && "PATH", reg.terminalProfile && "Windows Terminal 프로필", reg.shortcut && "바탕화면 바로가기"].filter(Boolean);
  const keep = await ui.select("oxygen-pi-system 을 이 PC 에서 제거할까요?", [
    reg.copied
      ? { label: "설치 폴더 삭제하고 등록 해제", value: "remove", danger: true, hint: "되돌릴 수 없음 · 다음에 폴더 이름 입력",
        detail: [["바뀌는 것", "다음 화면에서 폴더 이름을 입력하면 삭제합니다"], ["되돌리기", "되돌릴 수 없습니다. 다시 쓰려면 번들에서 새로 설치"]] }
      : { label: "등록 해제하고 설치 기록 삭제", value: "remove", danger: true,
        detail: [["바뀌는 것", "폴더와 파일은 그대로 두고 실행 등록과 설치 기록만 지웁니다"], ["되돌리기", "install.cmd 로 다시 설치하면 됩니다"]] },
    { label: "제거 취소", value: "cancel", detail: [["바뀌는 것", "아무것도 바꾸지 않고 설치 관리 메뉴로 돌아갑니다"]] },
  ], { back: false, initial: 1, result: true, note: rail([
    reg.copied ? ["삭제", `${reg.installDir}\n${num(stats.files)}개 파일 · ${bytesText(stats.bytes)}`] : ["남김", `${reg.installDir} (복사 설치가 아니라 폴더는 지우지 않습니다)`],
    reg.copied ? ["함께 삭제", `DB 연결 ${conns}개${secrets ? "와 저장된 비밀번호" : ""} (백업하지 않음)`] : null,
    ["등록 해제", registered.join(" · ") || "없음"],
    ["백업", `agent/oxy.env → ${backup}`],
  ], { wrap: ui.cols() - 2 }) });
  if (keep !== "remove") return 1;
  if (reg.copied) {
    const name = basename(reg.installDir);
    const word = /^[A-Za-z0-9._-]+$/.test(name) ? name : "delete";
    const yes = await ui.confirmTyped("설치 폴더를 정말 삭제할까요?", {
      word, note: [`확인하려면 ${word === name ? `폴더 이름 ${word} 를` : `${word} 를`} 입력하세요. 되돌릴 수 없습니다.`, c.gray(reg.installDir)],
    });
    if (!yes) return 1;
  }
  return removeNow(reg, backup);
}

async function removeNow(reg, backup) {
  ui.screen(`  ${c.bold("제거하는 중입니다")}\n`);
  ui.interruptNote = () => `중단했습니다. ${ui.current?.label ?? "제거"} 을(를) 마치지 못했습니다 — install.cmd › 제거를 다시 실행하세요.`;
  const envFile = join(reg.installDir, "agent", "oxy.env");
  const backupText = existsSync(envFile) ? readFileSync(envFile, "utf8") : null;
  if (reg.path) await ui.task("PATH 등록 해제", async () => sys.removeUserPath(reg.installDir));
  if (reg.terminalProfile) await ui.task("Windows Terminal 프로필 해제", async () => sys.removeTerminalProfile(reg.terminalProfile));
  if (reg.shortcut) await ui.task("바탕화면 바로가기 해제", async () => sys.removeShortcut(reg.shortcut));
  await ui.task("설치 기록 삭제", async () => sys.removeRegistry());
  if (backupText) {
    mkdirSync(dirname(backup), { recursive: true });
    writeFileSync(backup, backupText);
    ui.print(`  ${c.green("✔")} 설정 백업  ${c.gray(backup)}`);
  }
  if (reg.copied) {
    await ui.task("설치 폴더 삭제", async () => {
      const r = sys.removeInstallDir(reg.installDir);
      return r === "scheduled" ? "이 창을 닫으면 삭제됩니다" : "";
    }, { target: reg.installDir });
  }
  ui.print(`\n  ${c.green("✔")} ${c.bold("제거를 마쳤습니다")}  다시 쓰려면 번들의 install.cmd 로 새로 설치하세요`);
  await ui.pause("종료");
  return 0;
}

async function manage(reg) {
  for (;;) {
    setFrame(null, undefined, undefined, "설치 관리");
    const sameBundle = sys.isSameDir(ROOT, reg.installDir);
    const choice = await ui.select("설치된 oxygen-pi-system 을 어떻게 할까요?", [
      { label: "설정 다시 하기", value: "reconfigure", hint: "설치 단계(구성요소~확인)를 다시 밟음",
        detail: [["바뀌는 것", "LLM 연결 · 모델 · GitLab 연결 · 실행 등록을 차례로 다시 묻습니다"], ["빠른 길", "항목 하나만 바꾸려면 tweak.cmd 가 빠릅니다"]] },
      { label: "동작 시험", value: "verify", hint: "도구·설정·LLM 연결 시험 (verify)", detail: [["바뀌는 것", "아무것도 바꾸지 않습니다. 결과만 보여 줍니다"]] },
      // 항목은 항상 5개 (번호 고정). 업데이트를 쓸 수 없으면 빼지 않고 비활성으로 이유를 보인다
      { label: "이 번들로 업데이트", value: "update", hint: sameBundle ? "" : `v${reg.version ?? "?"} → v${VERSION} · 설정 유지`,
        disabled: sameBundle ? "사용 불가 · 이 번들이 설치된 그 폴더입니다" : false,
        why: "지금 실행한 install.cmd 가 설치 폴더 안의 것입니다", fix: "새로 반입한 번들 폴더의 install.cmd 를 실행하세요",
        detail: [["바뀌는 것", "하네스 파일을 덮어쓰고 설정(oxy.env · DB 연결 · skill 설정)은 유지합니다"]] },
      { label: "제거", value: "uninstall", danger: true, hint: reg.copied ? "설치 폴더 삭제 · 실행 등록 해제" : "실행 등록 해제",
        detail: [["바뀌는 것", "다음 화면에서 지울 대상과 개수를 보여 주고 한 번 더 묻습니다"]] },
      { label: "종료", value: "exit" },
    ], { back: true, esc: "종료", initial: 0, result: true, note: rail([
      ["설치 폴더", reg.installDir],
      ["버전", `v${reg.version ?? "?"} (${(reg.updatedAt ?? reg.installedAt ?? "").slice(0, 10)} 설치) · 이 번들 v${VERSION}`],
    ]) });
    if (choice === "exit" || choice === BACK) return 0;
    if (choice === "reconfigure") return reconfigure(reg);
    if (choice === "uninstall") { const r = await uninstall(reg); if (r === 0) return 0; continue; }
    if (choice === "verify") {
      ui.screen(`  ${c.bold("동작 시험 (verify)")}\n`);
      const gitBash = reg.gitBash && existsSync(reg.gitBash) ? reg.gitBash : sys.findGitBash();
      sys.runVerify(reg.installDir, gitBash);
      await ui.pause();
      continue;
    }
    if (choice === "update") {
      const state = { ...stateFromInstall(reg), copy: true, update: true, doneTitle: "업데이트를 마쳤습니다" };
      setFrame(null, undefined, undefined, "설치 관리 › 업데이트");
      // 중간 위험(덮어쓰기). 방금 메뉴에서 골랐고 설정이 유지되며 이전 번들로 되돌릴 수 있어 초기 포커스는 '업데이트 시작' (§7.8)
      const go = await ui.confirm(`이 번들(v${VERSION})로 설치 폴더를 업데이트할까요?`, {
        yes: "업데이트 시작", no: "업데이트 취소", level: "medium", danger: false, initial: true,
        note: rail([["덮어씀", `${state.installDir} 의 하네스 파일`], ["유지", "oxy.env · 모델 설정 · DB 연결 · 비밀번호 · skill 설정 · 세션"],
          ["버전", `v${reg.version ?? "?"} → v${VERSION}`]], { wrap: ui.cols() - 2 }),
        detail: { yes: [["되돌리기", `이전 번들(v${reg.version ?? "?"})에서 install.cmd › 업데이트로 되돌릴 수 있습니다`]],
          no: [["바뀌는 것", "아무것도 바꾸지 않고 설치 관리 메뉴로 돌아갑니다"]] },
      });
      if (!go) continue;
      // 번들에 새로 들어온 선택 구성요소가 있을 때만 고른다 (설치된 것은 잠금 '설치됨', 새것은 해제 상태)
      const rows = componentRows(state);
      const fresh = rows.filter((r) => !r.header && !r.locked && !r.disabled && hasComponent(r.value, ROOT));
      if (fresh.length) {
        const picked = await ui.multiselect("새로 반입된 구성요소 중 무엇을 설치할까요?",
          rows.map((r) => (r.header || r.locked ? r : { ...r, checked: false })),
          { note: "이미 설치된 구성요소(설치됨)는 그대로 업데이트합니다. 새 구성요소만 고르세요." });
        if (picked === BACK) continue;
        state.components = [...readLock(ROOT).filter((e) => e.required).map((e) => e.name), ...picked.filter((n) => n !== "__core")];
        if (picked.includes("sqlcl") && !isInstalled("sqlcl", state.installDir)) state.sqlcl = { action: "bundle" };
      }
      setInstallInterrupt();
      ui.screen(`  ${c.bold("업데이트하는 중입니다")}\n  ${c.gray(state.installDir)}\n`);
      try {
        await copyFiles(state);
        await ui.task("설정 다시 생성", async () => `${writeSiteConfig(state.installDir, state)}개 파일`);
        reg.version = VERSION;
        sys.saveRegistry({ ...reg, updatedAt: new Date().toISOString() });
      } catch (e) {
        if (!e?.reported) errorBlock("업데이트하지 못했습니다", e).forEach((l) => ui.print(l));
        await ui.pause();
        continue;
      }
      const passed = await finishWithVerify(state, "업데이트를 마쳤습니다.");
      await done(state, passed);
      return 0;
    }
  }
}

// ------------------------------------------------------------------ main
async function main() {
  ui.intro();
  const reg = sys.loadRegistry();
  if (reg?.installDir && existsSync(reg.installDir)) return manage(reg);
  return install({});
}

// Tweak TUI(installer/tweak.mjs) 가 import 해서 쓸 수 있도록, 직접 실행할 때만 main 을 돈다
export {
  ui, sys, ROOT, VERSION, setFrame, finishWithVerify, reconfigure, stateFromInstall, writeSiteConfig, INTEGRATIONS, INTEGRATION_NAMES,
  stepSqlcl, stepBrowser, stepVllm, stepModel, stepGitlab, stepIntegrate, applyOptional, applyIntegrations, fetchModels,
};

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (sys.sandbox) ui.print(c.yellow(`[sandbox] 시스템 대신 ${sys.sandbox} 에만 기록합니다`));
  await ui.run(main);
}
