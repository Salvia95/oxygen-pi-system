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

const ok = (s) => `${c.green("✓")} ${s}`;
const warnMark = (s) => `${c.yellow("!")} ${s}`;
const num = (n) => Number(n).toLocaleString("en-US");
const INTEGRATION_NAMES = { path: "PATH", wt: "Windows Terminal 프로필", shortcut: "바탕화면 바로가기" };

// ------------------------------------------------------------------ 단계 표시
// 단계 줄에는 짧은 이름, 헤더·좁은 폭·줄 입력 모드에는 긴 이름 (§11.2)
const STEP_SHORT = ["점검", "폴더", "구성요소", "LLM", "모델", "GitLab", "바로가기", "확인"];
const STEP_LONG = ["환경 점검", "설치 폴더", "구성요소", "LLM 연결", "모델", "GitLab 연결", "PATH·바로가기", "확인"];
const RECONF_SHORT = ["구성요소", "LLM", "모델", "GitLab", "바로가기", "확인"];
const RECONF_LONG = ["구성요소", "LLM 연결", "모델", "GitLab 연결", "PATH·바로가기", "확인"];

function setFrame(stepIndex = null, names = STEP_SHORT, longNames = STEP_LONG, title = "설치") {
  ui.setFrame(stepIndex === null ? { path: [title].flat() } : { steps: names, longSteps: longNames, current: stepIndex, title });
}
/** 단계를 모두 지난 뒤의 위치 표시: 작업하는 중(`설치 중`)과 마친 뒤(`설치 완료`) */
function setStage(names, longNames, title, stage, finished = false) {
  ui.setFrame({ steps: names, longSteps: longNames, current: names.length, title, stage, finished });
}
const NOTHING_CHANGED = "중단되었습니다. 변경된 내용은 없습니다.";

/** 단계 배열을 순서대로 실행. 단계가 BACK 을 돌려주면 이전 단계로 */
/** backExits: 첫 단계에서 Esc(이전)를 누르면 흐름을 빠져나간다 (다시 설정에서 메뉴로 돌아가기) */
async function runSteps(steps, state, frame, { backExits = false } = {}) {
  let i = 0;
  ui.interruptNote = () => NOTHING_CHANGED;
  // 단계 흐름 안에서 Enter 는 "다음" (행동을 선택하는 화면은 화면마다 "선택" 으로 지정한다)
  ui.enterLabel = "다음";
  try {
    while (i < steps.length) {
      setFrame(i, ...frame);
      const r = await steps[i](state);
      if (r === BACK && i === 0 && backExits) return false;
      if (r === BACK) i = Math.max(0, i - 1);
      else if (r === "cancel") return false;
      else i++;
    }
    return true;
  } finally { ui.enterLabel = null; }
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
  if (state.gitBash) rows.push(row(c.green("✓"), "Git Bash", c.gray(state.gitBash)));
  else {
    rows.push(row(c.red("×"), "Git Bash", "찾을 수 없음 (필수)"));
    fatal = { cause: "Git for Windows를 찾을 수 없습니다. pi는 Git Bash로 명령을 실행합니다", fix: "Git for Windows를 설치한 뒤 install.cmd를 다시 실행하세요" };
  }
  rows.push(java.ok ? row(c.green("✓"), `Java ${java.major}`, c.gray(java.detail))
    : row(c.yellow("!"), "Java", `${java.detail} (SQLcl만 사용할 수 없습니다)`));
  const required = readLock(ROOT).filter((e) => e.required).length;
  if (missing.length === 0) rows.push(row(c.green("✓"), "번들 구성요소", `${c.gray(ROOT)} (필수 ${required}개 확인)`));
  else {
    rows.push(row(c.red("×"), "번들 구성요소", `${missing.length}개 없음: ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? " …" : ""}`));
    fatal ??= { cause: "번들에 필수 파일이 없습니다", fix: "인터넷 PC에서 번들을 다시 만들어 반입하세요" };
  }
  if (process.platform !== "win32") fatal ??= { cause: "Windows에서만 설치할 수 있습니다", fix: "Windows 11 PC에서 install.cmd를 실행하세요" };

  if (fatal) {
    ui.screen([`  ${c.bold("설치를 계속할 수 없습니다")}`, ...rows.map((l) => "  " + l), "", ...errorBlock("필수 항목이 없습니다", fatal)].join("\n"));
    await ui.pause("종료");
    return "cancel";
  }
  return ui.select("설치를 계속할까요?", [
    { label: "설치 계속", value: "next", detail: "다음 화면에서 설치 폴더를 선택합니다. 아직 변경된 내용은 없습니다." },
    { label: "설치 취소", value: "cancel", detail: "아무것도 변경하지 않고 종료합니다." },
  ], { back: false, initial: 0, note: rows, result: true, enter: "선택" });
}

// ------------------------------------------------------------------ 단계: 설치 폴더
async function stepLocation(state) {
  const inPlace = sys.isSameDir(ROOT, sys.defaultInstallDir);
  const options = [
    { label: "기본 위치에 설치", value: "default", recommended: true, hint: sys.defaultInstallDir,
      detail: ["이 폴더에 번들 파일(약 1GB)을 복사합니다.", "나중에 install.cmd의 제거로 삭제할 수 있습니다."] },
    { label: "현재 폴더 그대로 사용", value: "inplace", hint: ROOT, disabled: inPlace ? "이미 기본 위치" : false,
      why: "이 번들이 이미 기본 위치에 있습니다.", fix: "기본 위치에 설치를 선택하세요. 복사 없이 그대로 사용합니다.",
      detail: ["복사하지 않고 이 번들 폴더를 설치 폴더로 사용합니다.", "제거하면 폴더는 남고 등록만 해제됩니다."] },
    { label: "다른 폴더 직접 입력…", value: "custom", detail: "다음 화면에서 폴더 경로를 입력합니다." },
  ];
  const k = options.findIndex((o) => o.value === state.locationChoice);
  const choice = await ui.select("어디에 설치할까요?", options, {
    ...(k >= 0 ? { initial: k } : {}),
    note: "번들(약 1GB)을 설치 폴더로 복사합니다. 이미 설치된 폴더를 선택하면 설정을 유지한 채 업데이트합니다.",
  });
  if (choice === BACK) return BACK;
  state.locationChoice = choice;

  let dir = choice === "default" ? sys.defaultInstallDir : choice === "inplace" ? ROOT : null;
  for (;;) {
    if (choice === "custom") {
      const v = await ui.input("설치 폴더", {
        initial: state.installDir ?? "C:\\oxygen-pi", note: "폴더가 없으면 새로 만듭니다. 예: C:\\oxygen-pi",
        validate: (p) => (!p ? "값을 입력하세요" : !isAbsolute(p) ? "드라이브 문자부터 전체 경로를 입력하세요. 예: C:\\oxygen-pi" : null),
      });
      if (v === BACK) return stepLocation(state);
      dir = resolve(v);
    }
    const inside = (resolve(dir) + sep).toLowerCase().startsWith((ROOT + sep).toLowerCase()) && !sys.isSameDir(dir, ROOT);
    const kind = sys.isSameDir(dir, ROOT) ? "inplace" : sys.inspectTarget(dir);
    let problem = null;
    if (inside) problem = ["설치 폴더가 번들 폴더 안에 있습니다", "번들 폴더 밖의 폴더를 선택하세요 (예: 기본 위치)"];
    else if (kind === "file") problem = ["같은 이름의 파일이 이미 있습니다", "다른 폴더 이름을 입력하세요"];
    else if (kind === "foreign") problem = ["다른 파일이 들어 있는 폴더입니다", "빈 폴더나 새 폴더를 지정하세요. 기존 파일은 변경되지 않습니다"];
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
        yes: "이 경로에 설치", no: "다른 폴더 선택", level: "medium", danger: false,
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
const ARCHIVE_SUBJECT = { sqlcl: "SQLcl을", chrome: "Chrome for Testing을" };
const ARCHIVE_UNDO = { sqlcl: "나중에 tweak.cmd의 DB 연결에서 교체할 수 있습니다.", chrome: "나중에 tweak.cmd의 브라우저에서 변경할 수 있습니다." };

/** 선택 구성요소의 압축 파일 선택 → 경로 | "skip" | BACK */
async function pickArchive(name, { skipLabel = "설치하지 않음", later = true } = {}) {
  const comp = OPTIONAL[name];
  const found = [...new Set([...findArchives(join(ROOT, "optional"), name), ...findArchives(downloadsDir, name)])];
  const note = [
    ...rail([["라이선스", `${comp.license} (오픈소스가 아니라 번들에 없습니다)`], ["다운로드 주소", comp.downloadPage]]),
    ...(found.length ? [] : [`Downloads와 번들의 optional 폴더에서 ${comp.zipRoot}*.zip을 찾을 수 없습니다.`]),
  ];
  for (;;) {
    const v = await ui.select(`${ARCHIVE_SUBJECT[name]} 어느 파일로 설치할까요?`, [
      ...found.map((f) => ({ label: "이 파일로 설치", value: f, hint: f,
        detail: [`sha256을 확인한 뒤 ${comp.installDir}에 압축을 풉니다.`, later ? ARCHIVE_UNDO[name] : ""] })),
      { label: "다른 파일 직접 입력…", value: "custom", detail: "다음 화면에서 압축 파일 경로를 입력합니다." },
      { label: skipLabel, value: "skip" },
    ], { note, result: true, enter: "선택" });
    if (v === BACK || v === "skip") return v;
    let file = v;
    if (v === "custom") {
      const p = await ui.input(`${comp.title} 압축 파일 경로`, {
        initial: downloadsDir ? join(downloadsDir, comp.zipRoot === "sqlcl" ? "sqlcl-latest.zip" : "chrome-win64.zip") : "",
        note: `공식 배포처에서 받은 ${comp.zipRoot}*.zip의 전체 경로를 입력하세요.`,
        validate: (s) => (!s ? "값을 입력하세요" : !existsSync(s) ? "파일을 찾을 수 없습니다. 탐색기의 \"경로로 복사\"로 복사해 붙여넣으세요" : null),
      });
      if (p === BACK) continue;
      file = resolve(p);
    }
    const r = await ui.task("파일 확인 (sha256)", async () => checkArchive(ROOT, name, file), { target: file });
    if (r.match) return file;
    const go = await ui.confirm("고정된 버전과 다른 파일로 설치할까요?", {
      yes: "이 파일로 설치 (버전이 다를 수 있음)", no: "다른 파일 선택", level: "medium", danger: false,
      note: `manifest에 고정된 ${comp.title} ${r.version} 파일과 sha256이 다릅니다.`, summary: [["예상 sha256", r.expected ?? "-"], ["파일 sha256", r.actual]],
    });
    if (go) return file;
  }
}

const FETCH_FIX = "인터넷 PC에서 fetch로 받아 번들을 다시 만드세요";
const techName = (n) => (n === "sqlcl" ? "SQLcl" : n);

/**
 * 구성요소 다중 선택 행 (설치 TUI 3단계). 필수(core)는 잠금 행 하나로 묶고, 브라우저(engine)는 다음 화면에서 선택한다.
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
      rows.push({ label: `기본 도구 ${required.length}개`, value: "__core", locked: true, hint: required.join(", "),
        detail: "실행에 필요한 도구라서 항상 설치됩니다." });
    }
    for (const n of names.filter((x) => !required.includes(x))) {
      const cat = CATALOG[n];
      const inBundle = hasComponent(n, ROOT);
      const installed = Boolean(target && hasComponent(n, target));
      const row = {
        // 레이블은 도구 이름, 값 열은 하는 일 한 줄, 설명은 포커스했을 때의 문장
        label: techName(n), value: n, hint: cat.brief ?? cat.purpose, recommended: Boolean(cat.recommended), checked: inBundle || installed,
        detail: [...[cat.about ?? []].flat(), cat.skills ? `함께 켜지는 스킬: ${cat.skills.join(", ")}` : ""].filter(Boolean),
      };
      if (installed) Object.assign(row, { locked: true, status: "설치됨" });
      else if (!inBundle && !OPTIONAL[n]) {
        Object.assign(row, { checked: false, disabled: "반입 안 됨",
          why: "번들에 포함되지 않아 선택할 수 없습니다.",
          fix: cat.external ? `${n}.exe를 vendor/${n}/에 넣고 번들을 다시 만드세요.` : `${FETCH_FIX}.` });
      } else if (!inBundle) Object.assign(row, { checked: false, status: "zip 파일 필요" });
      if (n === "sqlcl" && state.javaOk === false) row.status = [row.status, "Java 17 없음"].filter(Boolean).join(" · ");
      rows.push(row);
    }
  }
  return rows;
}

/** 구성요소 단계 = 다중 선택 → (agent-browser 를 선택했으면) 브라우저 → (SQLcl 을 선택했고 번들에 없으면) 압축 파일 */
async function stepComponents(state) {
  for (;;) {
    const rows = componentRows(state);
    const items = rows.filter((r) => !r.header);
    const picked = await ui.multiselect("어떤 구성요소를 설치할까요?", rows, {
      initial: Math.max(0, items.findIndex((o) => !o.locked && !o.disabled)),
      note: "번들에 포함된 구성요소만 선택할 수 있습니다. 선택한 구성요소의 스킬이 함께 켜집니다.",
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

/** 다시 설정의 선택 단계 = SQLcl → 브라우저 (파일을 복사하지 않으므로 구성요소 화면은 쓰지 않는다) */
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
    const v = await ui.select("설치된 SQLcl을 교체할까요?", [
      { label: "설치된 SQLcl 유지", value: "keep", current: true, detail: "변경되는 내용이 없습니다." },
      { label: "다른 파일로 교체…", value: "replace", detail: "다음 화면에서 압축 파일을 선택하면 설치된 SQLcl을 교체합니다." },
    ], { note, initial: 0, enter: "선택" });
    if (v === BACK) return BACK;
    if (v === "keep") state.sqlcl = { action: "keep" };
    else {
      const a = await pickArchive("sqlcl", { skipLabel: "교체하지 않음 (유지)", later: !state.tweak });
      if (a === BACK) return stepSqlcl(state);
      state.sqlcl = a === "skip" ? { action: "keep" } : { action: "install", archive: a };
    }
  } else if (hasComponent("sqlcl", ROOT)) {
    // 사용자가 fetch 로 받아 번들에 넣어 온 SQLcl
    const v = await ui.select("SQLcl을 설치할까요?", [
      { label: "번들의 SQLcl 설치", value: "bundle", detail: "번들에 포함된 SQLcl을 설치 폴더로 복사합니다." },
      { label: "다른 zip 파일로 설치…", value: "zip", detail: "다음 화면에서 직접 받은 압축 파일을 선택합니다." },
      { label: "설치하지 않음", value: "skip", detail: state.tweak ? "변경되는 내용이 없습니다." : "나중에 tweak.cmd의 DB 연결에서 설치할 수 있습니다." },
    ], { note, initial: 0, enter: "선택" });
    if (v === BACK) return BACK;
    if (v === "zip") {
      const a = await pickArchive("sqlcl", { later: !state.tweak });
      if (a === BACK) return stepSqlcl(state);
      state.sqlcl = a === "skip" ? { action: "skip" } : { action: "install", archive: a };
    } else state.sqlcl = { action: v };
  } else {
    const a = await pickArchive("sqlcl", { later: !state.tweak });
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
      ui.screen(`  ${c.bold("PC에 설치된 브라우저를 찾는 중입니다")}\n`);
      browserList = await ui.task("PC에 설치된 브라우저 찾기", async () => browserChoices(ROOT));
    }
    const choices = browserList;
    const cftReady = Boolean(target && isInstalled("chrome", target));
    const opts = choices.map((b) => ({
      label: b.label, value: b.id, recommended: b.recommended, current: Boolean(state.tweak && state.browser?.id === b.id),
      hint: b.id === "chrome-for-testing" && cftReady ? "설치됨" : b.hint,
      detail: [...[b.why ?? []].flat(), !state.tweak && "나중에 tweak.cmd의 브라우저에서 변경할 수 있습니다."].filter(Boolean),
    }));
    const k = opts.findIndex((o) => o.value === state.browser?.id);
    const id = await ui.select("agent-browser가 사용할 브라우저를 선택하세요", opts, {
      ...(k >= 0 ? { initial: k } : {}), enter: state.tweak ? "저장" : undefined,
      note: "web-page-automation 스킬이 이 브라우저로 사내 웹 페이지를 엽니다.",
    });
    if (id === BACK) return BACK;
    const pick = choices.find((b) => b.id === id);
    state.browser = { id, path: pick.path ?? "", label: pick.label };
    if (pick.needs && !cftReady) {
      const a = await pickArchive(pick.needs, { skipLabel: "다른 브라우저 선택", later: !state.tweak });
      if (a === BACK || a === "skip") continue;
      state.browser.archive = a;
    }
    return "next";
  }
}

/** 번들에 들어 있지만 사용자가 선택하지 않은 구성요소는 설치 폴더로 복사하지 않는다 */
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
    await ui.task("SQLcl 설치", async () => { installOptional("sqlcl", state.sqlcl.archive, state.installDir); });
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
      why: "서버에 등록된 모델이 없습니다", fix: "vLLM의 --served-model-name을 확인하세요. 연결 확인 없이 계속하면 모델 이름을 직접 입력합니다",
    });
  }
  return models;
}

/** 확장 파라미터마다 확인에 쓸 값 */
const PROBE_VALUES = { top_k: 20, repetition_penalty: 1.05, min_p: 0, chat_template_kwargs: { enable_thinking: false }, reasoning_effort: "low" };

/** 사용량 제한(분당 토큰)이 이 값 이하인 엔드포인트에는 맞춤 설정을 제안한다 (사내 vLLM 은 보통 헤더가 없다) */
const RATE_LIMITED_TPM = 30000;
/** 분당 토큰 한도에 맞춘 설정: 서버가 알려 준 대기 후 재시도 · 응답 상한 · subagent 동시 실행 1 */
export function endpointPreset(tpm) {
  return { retries: 4, maxOut: Math.max(512, Math.min(4096, Math.floor(tpm / 8))), concurrency: 1 };
}

/**
 * 서버(또는 앞단 게이트웨이)가 vLLM 확장 파라미터를 받는지 1토큰 요청으로 하나씩 확인한다.
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
    const url = await ui.input("LLM 서버 주소", {
      initial: state.baseUrl ?? "http://",
      note: ["vLLM 같은 OpenAI 호환 서버의 주소입니다. /v1이 없으면 자동으로 붙입니다.", "예: http://vllm.example.internal:8000/v1"],
      validate: (v) => {
        const msg = "http:// 또는 https://로 시작하는 주소를 입력하세요.";
        try { const u = new URL(v.trim()); return /^https?:$/.test(u.protocol) && u.hostname ? null : msg; } catch { return msg; }
      },
    });
    if (url === BACK) return BACK;
    state.baseUrl = normalizeBaseUrl(url);

    const key = await ui.input("API 키", {
      initial: state.apiKey && state.apiKey !== "EMPTY" ? state.apiKey : "", mask: true,
      note: "vLLM을 --api-key 없이 실행했다면 비워 두세요. 키는 agent/oxy.env에만 저장되고 화면과 로그에 다시 표시되지 않습니다.",
    });
    if (key === BACK) continue;
    state.apiKey = key || "EMPTY";

    ui.screen(`  ${c.bold("LLM 서버에 연결하는 중입니다")}\n  ${c.gray(state.baseUrl)}\n`);
    let models;
    try {
      models = await ui.task("모델 목록 가져오기 (/v1/models)", async () => fetchModels(state.baseUrl, state.apiKey));
    } catch (e) {
      const choice = await ui.select("LLM 서버에 연결하지 못했습니다. 어떻게 할까요?", [
        { label: "주소와 키 다시 입력", value: "retry" },
        { label: "연결 확인 없이 계속 (모델 이름 직접 입력)", value: "skip", detail: "모델 목록 없이 다음 화면에서 모델 이름을 직접 입력합니다." },
      ], { back: false, initial: 0, result: true, enter: "선택", note: [c.gray(state.baseUrl), ...errorBlock("모델 목록을 가져오지 못했습니다", e).map((l) => l.slice(2))] });
      if (choice === "skip") { state.models = []; return "next"; }
      continue;
    }
    state.models = models;
    const probeModel = models.some((m) => m.id === state.coder) ? state.coder : models[0].id;
    const p = await ui.task(`확장 파라미터 확인 (${probeModel})`, async () => probeParams(state.baseUrl, state.apiKey, probeModel));
    const lines = [ok(`모델 ${models.length}개  ${models.map((m) => m.id).join(", ")}`)];
    if (p.results) {
      const yes = Object.keys(p.results).filter((k) => p.results[k]);
      // 이름을 늘어놓으면 80칸에서 잘린다. 지원하지 않는 것만 이름을 보인다
      if (yes.length) lines.push(ok(p.drop.length ? `확장 파라미터 ${yes.length}개 지원` : `확장 파라미터 ${yes.length}개 모두 지원`));
      for (const k of p.drop) lines.push(warnMark(`${k}: 서버에서 지원하지 않아 요청에서 제외합니다`));
      if (p.detail) lines.push(c.gray(`    ${p.detail}`));
    } else lines.push(warnMark(`확장 파라미터를 확인하지 못했습니다 (기존 설정 유지) ${c.gray(p.detail)}`));
    const go = await ui.select("이 결과대로 계속할까요?", [
      { label: state.tweak ? "이 결과로 저장" : "모델 선택으로 계속", value: "next",
        detail: p.results && p.drop.length
          ? [`서버가 지원하지 않는 파라미터 ${p.drop.length}개를 요청에서 제외합니다.`,
            state.tweak ? "LLM 연결의 요청 설정에서 변경할 수 있습니다." : "나중에 tweak.cmd의 LLM 연결에서 변경할 수 있습니다."]
          : p.results ? "확장 파라미터를 모두 보냅니다." : "확장 파라미터 설정은 그대로 유지합니다." },
      { label: "주소와 키 다시 입력", value: "retry" },
    ], { initial: 0, note: lines.map((l) => "  " + l), result: true, enter: "선택" });
    if (go !== "next") continue;
    // 판단할 수 없으면 이전 값 유지
    if (p.results) state.dropParams = p.drop;
    // 사용량 제한이 있는 엔드포인트 (응답 헤더 x-ratelimit-limit-tokens) → 맞춤 설정 제안
    if (p.tpm && p.tpm <= RATE_LIMITED_TPM) {
      const preset = endpointPreset(p.tpm);
      const v = await ui.select("사용량 제한에 맞춰 설정을 변경할까요?", [
        { label: "제한에 맞춘 설정 적용", value: "apply", recommended: true,
          detail: [`재시도 ${preset.retries}회, 응답 최대 ${preset.maxOut} 토큰, subagent 동시 실행 ${preset.concurrency}개로 설정합니다.`,
            state.tweak ? "LLM 연결의 요청 설정에서 값을 변경할 수 있습니다." : "나중에 tweak.cmd의 LLM 연결에서 값을 변경할 수 있습니다."] },
        { label: "현재 설정 유지", value: "keep", detail: "변경되는 내용이 없습니다. 제한을 넘으면 요청이 거부됩니다." },
      ], { back: false, initial: 0, enter: "선택", note: `이 엔드포인트는 분당 ${p.tpm.toLocaleString()} 토큰으로 제한됩니다. 넘으면 요청이 거부됩니다.` });
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
    const coder = await ui.select("코딩용 기본 모델을 선택하세요", opts, { initial: Math.max(0, k), note: "pi가 기본으로 사용하는 모델입니다." });
    if (coder === BACK) return BACK;
    state.coder = coder;
    const rest = [...opts.filter((o) => o.value !== coder).map((o) => ({ ...o, current: Boolean(state.tweak && o.value === state.general) })),
      { label: "사용 안 함", value: "", current: Boolean(state.tweak && !state.general) }];
    const general = await ui.select("범용 모델을 선택하세요", rest,
      { initial: Math.max(0, rest.findIndex((o) => o.value === (state.general ?? ""))), note: "선택 사항입니다. /model 명령으로 전환해서 사용하는 보조(thinking) 모델입니다." });
    if (general === BACK) return stepModel(state);
    state.general = general;
  } else {
    const coder = await ui.input("코딩용 모델 이름", { initial: state.coder ?? "", note: "vLLM --served-model-name 값과 같아야 합니다.", validate: (v) => (v ? null : "값을 입력하세요") });
    if (coder === BACK) return BACK;
    state.coder = coder;
    const general = await ui.input("범용 모델 이름", { initial: state.general ?? "", note: "선택 사항입니다. 없으면 비워 두세요." });
    if (general === BACK) return stepModel(state);
    state.general = general === state.coder ? "" : general;
  }
  state.defaultModel = state.coder;

  const lens = list.filter((m) => [state.coder, state.general].includes(m.id) && m.maxLen).map((m) => m.maxLen);
  const detected = lens.length ? Math.min(...lens) : null;
  const ctx = await ui.input("컨텍스트 길이 (토큰)", {
    initial: String(detected ?? state.contextWindow ?? 131072),
    note: detected ? `vLLM이 알려 준 max_model_len은 ${detected}입니다.` : "vLLM --max-model-len 값과 맞추세요.",
    validate: (v) => (/^\d+$/.test(v) && Number(v) >= 8192 ? null : "8192 이상의 숫자를 입력하세요. vLLM --max-model-len 값과 맞춥니다"),
  });
  if (ctx === BACK) return stepModel(state);
  state.contextWindow = Number(ctx);

  // 모델 계열: thinking 제어 방식과 권장 샘플링 값이 정해진다 (id 로 추정한 값이 (추천))
  const roles = [["coder", state.coder], ["general", state.general]].filter(([, id]) => id);
  for (const [role, id] of roles) {
    const key = role === "coder" ? "coderFamily" : "generalFamily";
    const guess = detectFamily(id);
    const opts = Object.entries(MODEL_FAMILIES).map(([k, f]) => ({
      label: f.label, value: k, recommended: k === guess, current: Boolean(state.tweak && state[key] === k),
      detail: k === guess ? `모델 이름(${id})으로 추정한 값입니다.` : "",
    }));
    const fam = await ui.select(`${id}의 모델 계열을 선택하세요`, opts, {
      initial: Math.max(0, opts.findIndex((o) => o.value === (state[key] ?? guess))),
      // 설정(Tweak)에서는 마지막 화면의 Enter 가 곧 저장이다
      enter: state.tweak && role === roles.at(-1)[0] ? "저장" : undefined,
      note: "thinking(추론)을 켜고 끄는 방식과 권장 샘플링 값이 계열마다 다릅니다.",
    });
    if (fam === BACK) return stepModel(state);
    state[key] = fam;
  }
  return "next";
}

// ------------------------------------------------------------------ 단계: GitLab 연결
async function stepGitlab(state) {
  const host = await ui.input("GitLab 호스트", {
    initial: state.gitlabHost ?? "", enter: state.tweak ? "저장" : undefined,
    note: ["선택 사항입니다. 비워 두면 사용하지 않습니다. 토큰은 설치 후 glab auth login으로 등록합니다.", "예: gitlab.example.internal"],
    validate: (v) => (v === "" || /^[a-z0-9.-]+(:\d+)?$/i.test(v.replace(/^https?:\/\//, "").replace(/\/+$/, ""))
      ? null : "호스트 이름만 입력하세요 (경로 제외). 예: gitlab.example.internal"),
  });
  if (host === BACK) return BACK;
  state.gitlabHost = host.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return "next";
}

// ------------------------------------------------------------------ 단계: PATH·바로가기
const INTEGRATION_UNDO = "나중에 tweak.cmd의 PATH·바로가기에서 해제할 수 있습니다.";
const INTEGRATIONS = [
  { label: "PATH에 추가", value: "path", hint: "cmd, PowerShell, Git Bash에서 oxy 실행",
    detail: ["사용자 환경 변수 PATH에 설치 폴더를 추가합니다.", INTEGRATION_UNDO] },
  { label: "Windows Terminal 프로필", value: "wt", hint: `새 탭 목록에 ${WT_PROFILE_NAME} 추가`,
    detail: ["Windows Terminal 설정 파일은 수정하지 않고 별도 파일을 만듭니다.", INTEGRATION_UNDO] },
  { label: "바탕화면 바로가기", value: "shortcut", hint: "Oxygen Pi.lnk",
    detail: ["바탕화면에 Oxygen Pi.lnk를 만듭니다.", INTEGRATION_UNDO] },
];
async function stepIntegrate(state) {
  const prev = state.integrations;
  const has = (k) => (prev ? prev.includes(k) : true);
  // 설정(Tweak) 안에서는 "나중에 tweak.cmd 에서" 안내를 보이지 않는다
  const rows = INTEGRATIONS.map((x) => ({ ...x, checked: has(x.value), detail: state.tweak ? x.detail.slice(0, 1) : x.detail }));
  const v = await ui.multiselect("oxy를 어디에서 실행할 수 있게 할까요?", rows, { enter: state.tweak ? "저장" : undefined });
  if (v === BACK) return BACK;
  state.integrations = v;
  return "next";
}

// ------------------------------------------------------------------ 단계: 확인
function summary(state) {
  const o = state.orig;
  const changed = (k, v) => (o && o[k] !== undefined && JSON.stringify(o[k]) !== JSON.stringify(v) ? " " + c.gray("(변경됨)") : "");
  const family = (id, f) => `${id} · ${f ?? detectFamily(id)}`;
  const required = new Set(readLock(ROOT).filter((e) => e.required).map((e) => e.name));
  const comps = state.components ? `기본 도구 ${required.size}개 + 선택 ${state.components.filter((n) => !required.has(n)).length}개` : "";
  const sqlcl = state.sqlcl ? { keep: "SQLcl 유지", bundle: "SQLcl 번들에서 설치", skip: c.gray("SQLcl 설치 안 함"), install: `SQLcl 설치 (${state.sqlcl.archive ?? ""})` }[state.sqlcl.action] : "";
  const removed = o?.integrations ? o.integrations.filter((k) => !(state.integrations ?? []).includes(k)) : [];
  const where = state.copy ? (state.resume ? c.yellow(" (중단된 설치를 이어서 진행)") : state.update ? c.yellow(" (기존 설치 업데이트, 설정 유지)") : "") : c.gray(" (복사 안 함)");
  // 이름–값 쌍으로 돌려준다 (값의 줄바꿈은 화면 폭을 아는 쪽이 한다)
  return [
    ["설치 폴더", `${state.installDir}${where}`],
    ["LLM 서버", `${state.baseUrl} · API 키 ${state.apiKey === "EMPTY" ? "없음" : "입력됨"}${changed("baseUrl", state.baseUrl)}`],
    ["코딩 모델", family(state.coder, state.coderFamily) + changed("coder", state.coder)],
    ["범용 모델", (state.general ? family(state.general, state.generalFamily) : c.gray("사용 안 함")) + changed("general", state.general ?? "")],
    state.endpoint ? ["요청 설정", `재시도 ${state.endpoint.retries}회 · 응답 최대 ${state.endpoint.maxOut ?? "모델 기본"} 토큰`] : null,
    ["컨텍스트 길이", `${num(state.contextWindow)} 토큰${changed("contextWindow", state.contextWindow)}`],
    ["GitLab", (state.gitlabHost || c.gray("사용 안 함")) + changed("gitlabHost", state.gitlabHost ?? "")],
    comps || sqlcl ? ["구성요소", [comps, sqlcl].filter(Boolean).join(" · ")] : null,
    state.browser ? ["브라우저", `${state.browser.label ?? state.browser.id}${state.browser.archive ? c.gray(" " + state.browser.archive) : ""}${changed("browserId", state.browser.id)}`] : null,
    state.integrations ? ["PATH·바로가기", (state.integrations.length ? state.integrations.map((k) => INTEGRATION_NAMES[k]).join(", ") : c.gray("없음")) +
      (removed.length ? " " + c.gray(`(해제: ${removed.map((k) => INTEGRATION_NAMES[k]).join(", ")})`) : "")] : null,
  ].filter(Boolean);
}

async function stepReview(state) {
  const reconf = Boolean(state.orig);
  return ui.select(reconf ? "이대로 설정을 적용할까요?" : "이대로 설치할까요?", [
    { label: reconf ? "설정 적용" : "설치 시작", value: "next", hint: !reconf && state.copy ? "약 1GB 복사" : "" },
    { label: "← 이전 단계", value: BACK, lineOnly: true },
    { label: reconf ? "변경 취소" : "설치 취소", value: "cancel" },
  ], { back: true, initial: 0, summary: summary(state), enter: "선택" });
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
  // 설치된 구성요소에 해당하는 skill 만 켠다 (사용자가 끈 OXY_SKILLS_OFF 는 제외)
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
    if (!t) return "중단되었습니다. install.cmd를 다시 실행하면 이어서 설치합니다.";
    if (t.label === "파일 복사") return `중단되었습니다 (파일 복사 ${t.extra.replace(/ \(.*$/, "") || "도중"}). install.cmd를 다시 실행하면 이어서 설치합니다.`;
    return `중단되었습니다. 완료하지 못한 작업: ${t.label}. install.cmd를 다시 실행하세요.`;
  };
}

/** 번들 → 설치 폴더 복사 (진행률 숫자). 복사 전에 설치 표시(partial)를 쓴다 */
async function copyFiles(state) {
  await ui.task("설치 정보 기록", async () => { mkdirSync(state.installDir, { recursive: true }); sys.writeMarker(state.installDir, { partial: true }); });
  await ui.task("파일 복사", async (update) => {
    let at = "";
    try {
      const n = await sys.copyBundle(state.installDir, (d, t) => {
        const pct = Math.floor((d / t) * 100);
        at = `${num(d)}/${num(t)}`;
        update(`${at} (${pct}%)`, pct);
      }, copyExcludes(state));
      return `${num(n)}개`;
    } catch (e) { e.stoppedAt = at ? `${at}에서 중단` : ""; throw e; }
  });
}

async function finishWithVerify(state, lead = "설치를 마쳤습니다.") {
  const run = await ui.confirm("상태 점검(verify)을 실행할까요?", {
    yes: "상태 점검 실행", no: "건너뛰기", recommended: true,
    note: `${lead} 번들 도구, pi 설정, LLM 서버 연결과 tool calling을 실제로 확인합니다 (약 30초).`,
    detail: { yes: "설정은 변경되지 않습니다.", no: "나중에 install.cmd나 tweak.cmd의 상태 점검에서 실행할 수 있습니다." },
  });
  // verify 는 출력이 길어 본 화면에서 실행한다 (원격 모드에서는 화면을 잠시 나갔다 돌아온다. 줄 입력 모드에서는 기다리지 않는다)
  return run ? ui.outside(() => sys.runVerify(state.installDir, state.gitBash), { title: "상태 점검 (verify)", lineWait: false }) : null;
}

async function install(state) {
  if (!(await runSteps([stepCheck, stepLocation, stepComponents, stepVllm, stepModel, stepGitlab, stepIntegrate, stepReview], state, [STEP_SHORT, STEP_LONG]))) {
    ui.print("\n  설치를 취소했습니다. 변경된 내용은 없습니다.");
    return 1;
  }
  state.stage = (finished) => setStage(STEP_SHORT, STEP_LONG, "설치", finished ? "설치 완료" : "설치 중", finished);
  state.stage(false);
  setInstallInterrupt();
  ui.screen(`  ${c.bold("설치하는 중입니다")}\n  ${c.gray(state.installDir)}\n`);
  const reg = sys.loadRegistry() ?? {};
  try {
    if (state.copy) await copyFiles(state);
    else await ui.task("설치 정보 기록", async () => sys.writeMarker(state.installDir));
    await applyOptional(state);
    await ui.task("설정 파일 생성", async () => `${writeSiteConfig(state.installDir, state)}개 파일`);
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
  state.stage?.(true);
  const lines = [
    `  ${c.green("✓")} ${c.bold(state.doneTitle ?? "설치를 마쳤습니다")}`,
    `  ${c.gray(state.installDir)}`,
    ...(passed === false ? ["", `  ${c.yellow("!")} 상태 점검에서 문제가 발견되었습니다 (FAIL 또는 WARN).`, "    종료한 뒤 터미널에 남은 점검 결과를 확인하세요."] : []),
    "", `  ${c.bold("시작하기")}`,
    ...rail([
      state.integrations?.includes("path") ? ["새 터미널에서", "cd <프로젝트 폴더> 후 oxy 실행"] : ["실행", `${state.installDir}\\oxy.cmd`],
      state.integrations?.includes("wt") ? ["Windows Terminal", `새 탭 목록의 ${WT_PROFILE_NAME} 프로필`] : null,
      state.gitlabHost ? ["GitLab 토큰", `glab auth login --hostname ${state.gitlabHost}`] : null,
    ], { indent: 4, width: 16 }),
    "", `  ${c.bold("다음에 할 일")}`,
    ...rail([
      ["설정 변경", "설치 폴더의 tweak.cmd"],
      state.sqlcl?.action === "skip" ? ["SQLcl 설치", "tweak.cmd의 DB 연결에서 zip 파일로 설치"] : null,
      ["업데이트, 제거", "install.cmd"],
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
    [RECONF_SHORT, RECONF_LONG, "다시 설정"], { backExits: true });
  if (!ok2) return 1;
  state.stage = (finished) => setStage(RECONF_SHORT, RECONF_LONG, "다시 설정", finished ? "설정 적용 완료" : "설정 적용 중", finished);
  state.stage(false);
  setInstallInterrupt();
  ui.screen(`  ${c.bold("설정을 적용하는 중입니다")}\n`);
  await applyOptional(state);
  await ui.task("설정 파일 생성", async () => `${writeSiteConfig(state.installDir, state)}개 파일`);
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
  setFrame(null, undefined, undefined, "설치 관리");
  const backup = sys.registryFile.replace(/install\.json$/, "oxy.env.bak");
  const agent = join(reg.installDir, "agent");
  let stats = null;
  if (reg.copied) {
    // 설치 관리 메뉴를 그대로 둔 채 알린다 (확인 팝업 아래에 메뉴가 깔리게)
    await ui.busy("삭제할 파일을 세는 중입니다");
    stats = sys.dirStats(reg.installDir);
  }
  const conns = loadConnections(agent).length;
  const secrets = existsSync(join(agent, "secrets.json"));
  const registered = [reg.path && "PATH", reg.terminalProfile && "Windows Terminal 프로필", reg.shortcut && "바탕화면 바로가기"].filter(Boolean);
  // 위험 확인 (원격 모드에서는 팝업). 1 = 제거 · 2 = 취소, 처음 포커스는 취소
  const go = await ui.confirm("oxygen-pi-system을 이 PC에서 제거할까요?", {
    title: "제거", level: "heavy",
    yes: reg.copied ? "설치 폴더 삭제" : "등록 해제", no: "제거 취소",
    summary: [
      reg.copied ? ["삭제", reg.installDir] : ["유지", `${reg.installDir} (번들 폴더를 그대로 사용 중이라 삭제하지 않습니다)`],
      reg.copied ? ["", `${num(stats.files)}개 파일 · ${bytesText(stats.bytes)}`] : null,
      reg.copied && (conns || secrets) ? ["함께 삭제", `DB 연결 ${conns}개${secrets ? "와 저장된 비밀번호" : ""} (백업하지 않음)`] : null,
      ["등록 해제", registered.join(", ") || "없음"],
      ["설정 백업", backup],
    ].filter(Boolean),
    warning: reg.copied ? "삭제하면 복구할 수 없습니다." : "",
  });
  if (go !== true) return 1;
  if (reg.copied) {
    const name = basename(reg.installDir);
    const word = /^[A-Za-z0-9._-]+$/.test(name) ? name : "delete";
    const yes = await ui.confirmTyped("삭제할 폴더 이름 확인", {
      word, note: [`삭제하려면 ${word === name ? "폴더 이름 " : ""}${word} 입력 후 Enter를 누르세요. 삭제하면 복구할 수 없습니다.`, c.gray(reg.installDir)],
    });
    if (!yes) return 1;
  }
  return removeNow(reg, backup);
}

async function removeNow(reg, backup) {
  setFrame(null, undefined, undefined, ["설치 관리", "제거 중"]);
  ui.screen(`  ${c.bold("제거하는 중입니다")}\n`);
  ui.interruptNote = () => `중단되었습니다. 완료하지 못한 작업: ${ui.current?.label ?? "제거"}. install.cmd의 제거를 다시 실행하세요.`;
  const envFile = join(reg.installDir, "agent", "oxy.env");
  const backupText = existsSync(envFile) ? readFileSync(envFile, "utf8") : null;
  if (reg.path) await ui.task("PATH 등록 해제", async () => sys.removeUserPath(reg.installDir));
  if (reg.terminalProfile) await ui.task("Windows Terminal 프로필 해제", async () => sys.removeTerminalProfile(reg.terminalProfile));
  if (reg.shortcut) await ui.task("바탕화면 바로가기 해제", async () => sys.removeShortcut(reg.shortcut));
  await ui.task("설치 기록 삭제", async () => sys.removeRegistry());
  if (backupText) {
    mkdirSync(dirname(backup), { recursive: true });
    writeFileSync(backup, backupText);
    ui.print(`  ${c.green("✓")} 설정 백업  ${c.gray(backup)}`);
  }
  if (reg.copied) {
    await ui.task("설치 폴더 삭제", async () => {
      const r = sys.removeInstallDir(reg.installDir);
      return r === "scheduled" ? "이 창을 닫으면 삭제됩니다" : "";
    }, { target: reg.installDir });
  }
  setFrame(null, undefined, undefined, ["설치 관리", "제거 완료"]);
  ui.print(`\n  ${c.green("✓")} ${c.bold("제거를 마쳤습니다")}  다시 사용하려면 번들의 install.cmd로 설치하세요`);
  await ui.pause("종료");
  return 0;
}

async function manage(reg) {
  for (;;) {
    setFrame(null, undefined, undefined, "설치 관리");
    const sameBundle = sys.isSameDir(ROOT, reg.installDir);
    // 줄 입력 모드의 번호는 항상 1~5 (업데이트를 쓸 수 없어도 목록에 두고 이유를 보인다). `종료` 는 줄 입력 모드에만 있다 (화면에서는 Esc)
    const choice = await ui.select("어떤 작업을 할까요?", [
      { label: "다시 설정", value: "reconfigure",
        detail: ["LLM 연결, 모델, GitLab, PATH·바로가기를 순서대로 다시 설정합니다.", "한 항목만 변경하려면 tweak.cmd를 사용하세요."] },
      { label: "상태 점검", value: "verify", detail: ["도구, 설정, LLM 연결이 정상인지 확인합니다.", "설정은 변경되지 않습니다."] },
      { label: "업데이트", value: "update", hint: sameBundle ? "" : `v${reg.version ?? "?"}에서 v${VERSION}으로`,
        disabled: sameBundle ? "사용 불가" : false,
        why: "설치된 폴더에서 실행했기 때문에 업데이트할 수 없습니다.", fix: "새로 반입한 번들 폴더의 install.cmd를 실행하세요.",
        detail: ["프로그램 파일만 교체합니다. 설정과 DB 연결은 유지됩니다."] },
      { label: "제거", value: "uninstall",
        detail: reg.copied
          ? ["! 설치 폴더와 PATH·바로가기 등록을 삭제합니다.", "삭제하면 복구할 수 없습니다. 다음 화면에서 삭제 대상을 확인합니다."]
          : ["PATH·바로가기 등록과 설치 기록을 삭제합니다. 폴더는 그대로 둡니다.", "다음 화면에서 삭제 대상을 확인합니다."] },
      { label: "종료", value: "exit", lineOnly: true },
    ], { back: true, esc: "종료", initial: 0, summary: [
      ["설치 폴더", reg.installDir],
      ["설치 버전", `v${reg.version ?? "?"} (${(reg.updatedAt ?? reg.installedAt ?? "").slice(0, 10)})`],
    ] });
    if (choice === "exit" || choice === BACK) return 0;
    if (choice === "reconfigure") return reconfigure(reg);
    if (choice === "uninstall") { const r = await uninstall(reg); if (r === 0) return 0; continue; }
    if (choice === "verify") {
      const gitBash = reg.gitBash && existsSync(reg.gitBash) ? reg.gitBash : sys.findGitBash();
      await ui.outside(() => sys.runVerify(reg.installDir, gitBash), { title: "상태 점검 (verify)" });
      continue;
    }
    if (choice === "update") {
      const state = { ...stateFromInstall(reg), copy: true, update: true, doneTitle: "업데이트를 마쳤습니다" };
      setFrame(null, undefined, undefined, ["설치 관리", "업데이트"]);
      // 중간 위험(덮어쓰기). 방금 메뉴에서 선택했고 설정이 유지되며 이전 번들로 되돌릴 수 있어 초기 포커스는 '업데이트 시작' (§7.8)
      const go = await ui.confirm(`이 번들(v${VERSION})로 설치 폴더를 업데이트할까요?`, {
        yes: "업데이트 시작", no: "업데이트 취소", level: "medium", danger: false, initial: true,
        summary: [["설치 폴더", state.installDir], ["교체", "프로그램 파일"], ["유지", "oxy.env, 모델 설정, DB 연결, 비밀번호, 스킬 설정, 세션"],
          ["버전", `v${reg.version ?? "?"}에서 v${VERSION}으로`]],
        detail: { yes: "이전 버전으로 돌아가려면 이전 번들의 install.cmd로 업데이트하세요.",
          no: "변경 없이 설치 관리 메뉴로 돌아갑니다." },
      });
      if (!go) continue;
      // 번들에 새로 들어온 선택 구성요소가 있을 때만 선택 화면을 보인다 (설치된 것은 잠금 '설치됨', 새것은 해제 상태)
      const rows = componentRows(state);
      const fresh = rows.filter((r) => !r.header && !r.locked && !r.disabled && hasComponent(r.value, ROOT));
      if (fresh.length) {
        const picked = await ui.multiselect("새로 추가된 구성요소 중 설치할 것을 선택하세요",
          rows.map((r) => (r.header || r.locked ? r : { ...r, checked: false })),
          { note: "이미 설치된 구성요소는 그대로 업데이트됩니다. 새 구성요소만 선택하세요." });
        if (picked === BACK) continue;
        state.components = [...readLock(ROOT).filter((e) => e.required).map((e) => e.name), ...picked.filter((n) => n !== "__core")];
        if (picked.includes("sqlcl") && !isInstalled("sqlcl", state.installDir)) state.sqlcl = { action: "bundle" };
      }
      state.stage = (finished) => setFrame(null, undefined, undefined, ["설치 관리", finished ? "업데이트 완료" : "업데이트 중"]);
      state.stage(false);
      setInstallInterrupt();
      ui.screen(`  ${c.bold("업데이트하는 중입니다")}\n  ${c.gray(state.installDir)}\n`);
      try {
        await copyFiles(state);
        await ui.task("설정 파일 다시 생성", async () => `${writeSiteConfig(state.installDir, state)}개 파일`);
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
  // 원격 모드에서는 위치 줄 오른쪽의 [sandbox] 표시가 같은 일을 한다
  if (sys.sandbox && ui.mode === "line") ui.print(c.yellow(`[sandbox] 시스템을 변경하지 않고 다음 폴더에만 기록합니다: ${sys.sandbox}`));
  await ui.run(main);
}
