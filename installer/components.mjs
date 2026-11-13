// 구성요소 목록(CATALOG), 압축 파일로 추가 설치할 수 있는 구성요소(OPTIONAL), 런타임 선택지(브라우저)의 정의·설치 로직.
// fetch 선택 화면(select-components.mjs), 번들링 검사, 설치 TUI 가 공통으로 사용한다.
//
// 원칙: 저장소에는 바이너리를 넣지 않는다. 각 사용자가 fetch 로 공식 배포처에서 직접 받고,
//       직접 번들링해서 반입한다. 번들에 없는 SQLcl·Chrome for Testing 은 설치 TUI 에서 zip 으로 추가할 수도 있다.
//
//   CLI: node installer/components.mjs install <name> <archive> [--root <dir>]
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * manifest/tools.lock.tsv → [{name, version, url, sha256, license, role, required}]
 * role: required(필수) · optional(선택) · harness(하네스 자체의 프로그램. 선택 화면에 나오지 않는다. HARNESS_FILES 참고)
 */
export function readLock(root) {
  return readFileSync(join(root, "manifest", "tools.lock.tsv"), "utf8").split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const [name, version, url, sha256, license, role, group] = l.split("\t");
      return { name, version, url, sha256, license, role, group, required: role === "required" };
    });
}

/** 상위 계층 (선택 화면·설치 TUI 표시 순서) */
// 키(core 등)는 manifest·설정과 맞아야 하므로 그대로 두고, 화면에 보이는 제목만 일반어로 쓴다
export const GROUPS = {
  core: { title: "기본", desc: "실행에 필요한 도구" },
  "dev-tools": { title: "작업 실행", desc: "명령 실행, API 테스트" },
  repository: { title: "코드 저장소", desc: "사내에서 사용하는 저장소 (여러 개 선택 가능)" },
  "code-intel": { title: "코드 탐색", desc: "구문 기반 검색, 코드 그래프" },
  "internet-browsing": { title: "웹 페이지", desc: "사내 웹 페이지 읽기와 조작" },
  database: { title: "데이터베이스", desc: "DB 조회" },
};

/**
 * 모든 구성요소의 표시 정보와 설치 확인 파일 (하네스 루트 기준).
 * 필수 여부·버전·라이선스·계층은 manifest 가 기준이고, 여기에는 화면에 보여 줄 설명만 둔다.
 *   title       : 도구 이름 (목록의 레이블)
 *   brief       : 하는 일 한 줄 (목록의 값 열)
 *   about       : 포커스했을 때 보이는 설명 문장 (문장이 둘이면 배열. 한 줄에 한 문장씩 보인다)
 *   kind        : tool | engine(agent-browser 용 브라우저) | cli | connector
 *   skills      : 이 구성요소가 있으면 켜는 skill (agent/skill-library/<name>)
 *   proprietary : 오픈소스가 아닌 라이선스 (fetch 할 때 약관 동의, 번들링할 때 재배포 주의 안내)
 *   recommended : 같은 계층의 대안 중 호환성이 가장 검증된 것
 *   paths       : 설치 폴더로 복사하는 경로 (구성요소를 선택하지 않으면 복사하지 않는다. fetch-bundle.sh 의 배치와 맞출 것)
 */
export const CATALOG = {
  node: { title: "Node.js", kind: "tool", brief: "pi 실행 런타임", about: "pi와 설치 프로그램을 실행합니다.", check: "runtime/node/node.exe" },
  pi: { title: "pi coding agent", kind: "tool", brief: "에이전트 본체", about: "코딩 에이전트 본체입니다.", check: "vendor/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" },
  fd: { title: "fd", kind: "tool", brief: "파일 찾기", about: "pi의 find 도구가 사용합니다.", check: "bin/fd.exe", skills: ["find-code"] },
  rg: { title: "ripgrep", kind: "tool", brief: "파일 내용 검색", about: "pi의 grep 도구가 사용합니다.", check: "bin/rg.exe", skills: ["find-code"] },
  jq: { title: "jq", kind: "tool", brief: "JSON 조회와 가공", about: "JSON을 다루고 상태 점검(verify)에도 사용합니다.", check: "bin/jq.exe", skills: ["json-querying"] },
  just: { title: "just", kind: "tool", brief: "프로젝트 명령 실행 (build, test)", about: "justfile에 정의된 프로젝트 명령을 에이전트가 실행합니다.", check: "bin/just.exe", paths: ["bin/just.exe"], skills: ["project-task-running"] },
  hurl: { title: "hurl", kind: "tool", brief: "HTTP API 호출과 응답 확인", about: "HTTP 요청을 보내고 응답을 검증합니다.", check: "bin/hurl.exe", paths: ["bin/hurl.exe", "bin/hurlfmt.exe"], skills: ["http-api-testing"] },
  glab: { title: "glab", kind: "tool", brief: "GitLab MR, 이슈, CI", about: "GitLab의 MR, 이슈, CI 파이프라인을 조회하고 처리합니다.", check: "bin/glab.exe", paths: ["bin/glab.exe"], skills: ["gitlab-workflow"] },
  gh: { title: "gh", kind: "tool", brief: "GitHub PR, 이슈, Actions", about: "GitHub와 GitHub Enterprise의 PR, 이슈, Actions를 조회하고 처리합니다.", check: "bin/gh.exe", paths: ["bin/gh.exe"], skills: ["github-workflow"] },
  psmux: { title: "psmux", kind: "tool", brief: "터미널 세션 제어 (tmux 호환)", about: "대화형 프로그램을 별도 터미널 세션에서 실행하고 제어합니다.", check: "bin/psmux.exe", paths: ["bin/psmux.exe"], skills: ["terminal-session-control"] },
  "ast-grep": { title: "ast-grep", kind: "tool", brief: "구문 기반 코드 검색과 일괄 치환", about: "코드 구조(AST)로 검색하므로 주석과 문자열은 결과에서 제외됩니다.", check: "bin/ast-grep.exe", paths: ["bin/ast-grep.exe"], skills: ["structural-code-search"] },
  // graphin: Windows 빌드가 아직 배포되지 않아 manifest(fetch) 에는 없다. 직접 빌드한 graphin.exe 를 vendor/graphin/ 에 넣으면
  // pi MCP 서버로 등록되고 skill 이 켜진다 (external: fetch 대상 아님)
  graphin: { title: "graphin", kind: "connector", brief: "코드 그래프 탐색 (MCP)", about: "코드베이스를 색인해 하이브리드 검색과 코드 그래프 탐색을 제공합니다.", check: "vendor/graphin/graphin.exe", paths: ["vendor/graphin"], skills: ["code-graph-search"], external: true, group: "code-intel" },
  "agent-browser": { title: "agent-browser", kind: "tool", brief: "웹 페이지 조작 (클릭, 입력, 스크린샷)", about: ["브라우저를 조작해 사내 웹 페이지를 다룹니다.", "사용할 브라우저는 다음 화면에서 선택합니다."], check: "bin/agent-browser.exe", paths: ["bin/agent-browser.exe", "vendor/agent-browser-skill-data"], skills: ["web-page-automation"], recommended: true },
  obscura: { title: "obscura", kind: "tool", brief: "웹 페이지 읽기 (JS 렌더링)", about: "JavaScript를 실행한 뒤의 페이지 내용을 텍스트로 가져옵니다.", check: "bin/obscura.exe", paths: ["bin/obscura.exe", "bin/obscura-worker.exe"], skills: ["web-page-reading"] },
  chromium: { title: "Chromium", kind: "engine", brief: "agent-browser용 브라우저 (오픈소스)", about: "오픈소스 Chromium 빌드입니다.", check: "vendor/browsers/chromium/chrome.exe" },
  chrome: { title: "Chrome for Testing", kind: "engine", brief: "agent-browser용 브라우저", about: "agent-browser의 기본 브라우저이며 가장 많이 검증되었습니다.", check: "vendor/browsers/chrome-win64/chrome.exe", proprietary: true, recommended: true },
  usql: { title: "usql", kind: "cli", brief: "SQL 조회 (PostgreSQL, MySQL, SQLite 등)", about: ["여러 종류의 DB를 하나의 명령으로 조회합니다.", "연결은 tweak.cmd에서 등록합니다."], check: "bin/usql.exe", paths: ["bin/usql.exe"], skills: ["sql-querying"], recommended: true },
  sqlcl: { title: "Oracle SQLcl", kind: "cli", brief: "Oracle 전용 CLI (Java 17 필요)", about: ["Oracle DB의 info, ddl 같은 전용 명령을 사용합니다.", "Java 17 이상이 필요합니다."], check: "runtime/sqlcl/bin/sql", paths: ["runtime/sqlcl"], proprietary: true, skills: ["oracle-db-querying"] },
  dbhub: { title: "dbhub", kind: "connector", brief: "에이전트용 DB 도구 (MCP)", about: ["에이전트가 pi 도구로 SQL을 실행합니다.", "연결은 tweak.cmd에서 등록합니다."], check: "vendor/dbhub/node_modules/@bytebase/dbhub/dist/index.js", paths: ["vendor/dbhub"] },
};

/** 하네스 자체의 프로그램 (manifest 의 role=harness) 과 그 파일. 없어도 설치는 된다: 화면 프로그램이 없으면 TUI 가 줄 입력 모드로 동작한다 */
export const HARNESS_FILES = { "oxy-tui": "bin/oxy-tui.exe", "pi-tokyo-night": "vendor/pi-themes/tokyo-night.json" };

export const hasComponent = (name, root) => (HARNESS_FILES[name] ? existsSync(join(root, HARNESS_FILES[name]))
  : Boolean(CATALOG[name]) && existsSync(join(root, CATALOG[name].check)));

/**
 * 터미널 멀티플렉서 (oxy.env 의 OXY_MUX). 화면 선택지는 `사용 안 함` + 이 표의 순서 (docs/tui-spec.md §10)
 *   id        : OXY_MUX 값. 실행은 scripts/mux/<id>.sh 어댑터가 맡는다 (oxy 가 source)
 *   component : CATALOG 의 구성요소. 설치되지 않았으면 선택할 수 없다
 * 멀티플렉서를 더할 때: tools.lock 행 + CATALOG 행 + 이 표 한 행 + 어댑터 파일 하나
 */
export const MULTIPLEXERS = [
  { id: "psmux", component: "psmux", label: "psmux", hint: "oxy가 폴더별 psmux 세션에서 pi를 실행",
    detail: ["oxy가 폴더마다 psmux 세션을 만들어 그 안에서 pi를 실행합니다.", "창을 닫아도 세션이 남고, 같은 폴더에서 oxy를 실행하면 다시 연결됩니다."],
    info: [["세션 이름", "oxy-<폴더 이름>-<경로 해시>"], ["바로 실행", "oxy --no-mux (한 번만)"], ["알려진 제한", "Shift+Enter가 Enter와 같게 입력될 수 있음"]] },
];

// ------------------------------------------------------------------ skill 자동 활성화
// skill 원본은 agent/skill-library/<name> 에 두고, 설치된 구성요소에 해당하는 것만 agent/skills/ 로 복사한다.
// (pi 는 agent/skills 만 읽는다. skill-library 에 없는 사용자 skill 은 건드리지 않는다)

/** OXY_SKILLS_OFF 값(쉼표·공백 구분) → skill 이름 배열 */
export const parseSkillsOff = (v) => (Array.isArray(v) ? v : String(v ?? "").split(/[\s,]+/)).filter(Boolean);

/**
 * root(하네스 루트)에 설치된 구성요소 기준으로 켤 skill 이름.
 * off: 사용자가 끈 skill (oxy.env 의 OXY_SKILLS_OFF). 구성요소가 나중에 설치되어도 꺼진 채 남는다
 */
export function enabledSkills(root, { browser, off } = {}) {
  const set = new Set();
  for (const [name, cat] of Object.entries(CATALOG)) {
    if (cat.skills && hasComponent(name, root)) cat.skills.forEach((s) => set.add(s));
  }
  if (browser === "none") set.delete("web-page-automation");
  for (const s of parseSkillsOff(off)) set.delete(s);
  return set;
}

/** agentDir/skills 를 enabledSkills 에 맞춘다 → 켠 skill 이름 배열 */
export function syncSkills(root, agentDir, opts = {}) {
  const lib = join(root, "agent", "skill-library");
  const dst = join(agentDir, "skills");
  if (!existsSync(lib)) return [];
  const managed = readdirSync(lib, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  const enabled = enabledSkills(root, opts);
  mkdirSync(dst, { recursive: true });
  for (const s of managed) {
    rmSync(join(dst, s), { recursive: true, force: true });
    if (enabled.has(s)) cpSync(join(lib, s), join(dst, s), { recursive: true });
  }
  syncMcp(root, agentDir); // MCP 로 붙는 구성요소(graphin)도 함께 맞춘다
  return managed.filter((s) => enabled.has(s)).sort();
}

const fwd = (p) => p.replace(/\\/g, "/");

/**
 * graphin MCP 등록: vendor/graphin/graphin.exe 가 있으면 agent/mcp.json 에 넣고, 없으면 지운다 (다른 서버는 유지).
 * MCP 서버는 pi 를 실행한 폴더(프로젝트)를 cwd 로 받으므로 --workspace . 로 프로젝트마다 색인한다.
 * 의미 검색용 모델·onnxruntime 을 함께 반입했으면 (vendor/graphin/models, onnxruntime.dll) 오프라인 경로로 넘긴다.
 */
export function syncMcp(root, agentDir) {
  const file = join(agentDir, "mcp.json");
  let mcp = {};
  try { mcp = JSON.parse(readFileSync(file, "utf8")); } catch { /* 새로 만든다 */ }
  mcp.mcpServers ??= {};
  const before = JSON.stringify(mcp.mcpServers.graphin ?? null);
  if (hasComponent("graphin", root)) {
    const dir = join(root, "vendor", "graphin");
    const args = ["--workspace", ".", "--offline"];
    if (existsSync(join(dir, "models"))) args.push("--model-dir", fwd(join(dir, "models")));
    if (existsSync(join(dir, "onnxruntime.dll"))) args.push("--ort-lib", fwd(join(dir, "onnxruntime.dll")));
    mcp.mcpServers.graphin = {
      command: fwd(join(dir, "graphin.exe")), args, exposure: "direct",
      description: "코드베이스 탐색 (search_hybrid → explore_graph → read_code)",
    };
  } else delete mcp.mcpServers.graphin;
  if (JSON.stringify(mcp.mcpServers.graphin ?? null) === before) return;
  if (Object.keys(mcp.mcpServers).length) writeFileSync(file, JSON.stringify(mcp, null, 2) + "\n");
  else rmSync(file, { force: true });
}

/**
 * 선택 구성요소. 키는 lock 의 name.
 * zipRoot: 압축 파일 안의 최상위 폴더, installDir: 하네스 루트 기준 설치 위치, check: 설치 확인 파일
 */
export const OPTIONAL = {
  sqlcl: {
    title: "Oracle SQLcl",
    purpose: "Oracle DB를 조회하고 스크립트를 실행하는 Oracle 전용 CLI입니다. Java 17 이상이 필요합니다.",
    license: "Oracle Free Use Terms and Conditions",
    licenseUrl: "https://www.oracle.com/downloads/licenses/oracle-free-license.html",
    downloadPage: "https://www.oracle.com/database/sqldeveloper/technologies/sqlcl/download/",
    archivePattern: /^sqlcl.*\.zip$/i,
    zipRoot: "sqlcl",
    installDir: "runtime/sqlcl",
    check: "runtime/sqlcl/bin/sql",
  },
  chrome: {
    title: "Chrome for Testing",
    purpose: "agent-browser용 브라우저입니다 (Google의 자동화 전용 Chrome 빌드).",
    license: "Google Chrome 이용약관",
    licenseUrl: "https://www.google.com/chrome/terms/",
    downloadPage: "https://googlechromelabs.github.io/chrome-for-testing/  (win64 / chrome-win64.zip)",
    archivePattern: /^chrome-win64.*\.zip$/i,
    zipRoot: "chrome-win64",
    installDir: "vendor/browsers/chrome-win64",
    check: "vendor/browsers/chrome-win64/chrome.exe",
  },
};

export const isInstalled = (name, root) => existsSync(join(root, OPTIONAL[name].check));

/** fetch-bundle 이 optional/ 에 저장할 파일 이름 (OPTIONAL.archivePattern 과 맞아야 함) */
export const archiveFileName = (name, version) => `${OPTIONAL[name].zipRoot}-${version}.zip`;

export function sha256File(path) {
  return new Promise((ok, fail) => {
    const h = createHash("sha256");
    createReadStream(path).on("data", (d) => h.update(d)).on("error", fail).on("end", () => ok(h.digest("hex")));
  });
}

/** dir 안에서 구성요소의 압축 파일 후보를 찾는다 (최신 수정 순) */
export function findArchives(dir, name) {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && OPTIONAL[name].archivePattern.test(e.name))
    .map((e) => join(dir, e.name));
}

/** 압축 파일이 lock 에 고정된 파일과 같은지: {match, actual, expected, version} */
export async function checkArchive(root, name, archive) {
  const entry = readLock(root).find((e) => e.name === name);
  const actual = await sha256File(archive);
  return { match: Boolean(entry && entry.sha256 === actual), actual, expected: entry?.sha256, version: entry?.version };
}

/** 압축 파일을 destRoot 아래 설치 위치로 푼다 (기존 설치는 교체) */
export function installOptional(name, archive, destRoot) {
  const c = OPTIONAL[name];
  if (!c) throw new Error(`알 수 없는 선택 구성요소: ${name}`);
  if (!existsSync(archive)) throw new Error(`파일을 찾을 수 없습니다: ${archive}`);
  const tmp = join(destRoot, `.oxy-tmp-${name}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    // Windows 내장 bsdtar 는 zip 을 풀 수 있다 (추가 도구 불필요)
    const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
    const r = spawnSync(tar, ["-xf", resolve(archive), "-C", tmp], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`압축을 풀지 못했습니다: ${(r.stderr || "").trim().split("\n")[0]}`);
    const src = join(tmp, c.zipRoot);
    if (!existsSync(src)) throw new Error(`압축 파일 안에 ${c.zipRoot} 폴더가 없습니다. 올바른 ${c.title} 파일인지 확인하세요`);
    const dest = join(destRoot, c.installDir);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dirname(dest), { recursive: true });
    renameSync(src, dest);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  if (!isInstalled(name, destRoot)) throw new Error(`설치한 뒤에도 ${c.check} 파일을 찾을 수 없습니다`);
}

// ------------------------------------------------------------------ 브라우저 선택지 (agent-browser 런타임)
const EDGE = ["ProgramFiles(x86)", "ProgramFiles"].map((v) => process.env[v] && join(process.env[v], "Microsoft", "Edge", "Application", "msedge.exe"));
const CHROME = [
  process.env.ProgramFiles && join(process.env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"),
  process.env["ProgramFiles(x86)"] && join(process.env["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe"),
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
];
const firstExisting = (list) => list.filter(Boolean).find((p) => existsSync(p)) ?? null;

/** PC 에 설치된 브라우저 버전. powershell 을 동기로 실행해 느리므로 한 실행 안에서는 한 번만 구한다 */
const versionCache = new Map();
function fileVersion(path) {
  if (versionCache.has(path)) return versionCache.get(path);
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `(Get-Item -LiteralPath '${path.replace(/'/g, "''")}').VersionInfo.ProductVersion`], { encoding: "utf8" });
  const v = r.status === 0 ? r.stdout.trim() : "";
  versionCache.set(path, v);
  return v;
}

/**
 * agent-browser 가 쓸 브라우저 선택지. 호환성이 가장 검증된 것에 recommended 를 붙인다.
 * root: 번들(설치 원본) 루트. 반환값의 id 는 oxy.env 의 OXY_BROWSER 값이 된다.
 * 선택지 순서·개수는 회귀 테스트(tests/installer-sandbox.sh 의 NONE_IDX)가 기대는 값이다.
 */
export function browserChoices(root) {
  const cft = hasComponent("chrome", root);
  const out = [{
    id: "chrome-for-testing", label: "Chrome for Testing", recommended: true, ...(cft ? {} : { needs: "chrome" }),
    hint: cft ? "번들에 포함" : "chrome-win64.zip 파일 필요",
    why: "agent-browser의 기본 브라우저이며 가장 많이 검증되었습니다.",
  }];
  if (hasComponent("chromium", root)) {
    out.push({ id: "chromium", label: "Chromium", hint: "번들에 포함", why: "오픈소스 Chromium 빌드입니다 (BSD-3-Clause)." });
  }
  if (hasComponent("obscura", root)) {
    out.push({ id: "obscura", label: "obscura", hint: "번들에 포함", why: ["용량이 Chrome의 약 1/3인 가벼운 엔진입니다.", "일부 CDP 기능은 지원하지 않습니다."] });
  }
  const PC_NOTE = ["PC에 설치된 브라우저를 사용합니다.", "회사 정책으로 버전이 바뀌면 동작이 달라질 수 있습니다."];
  const edge = firstExisting(EDGE);
  if (edge) out.push({ id: "edge", label: "Microsoft Edge", path: edge, hint: `PC에 설치됨 · ${fileVersion(edge)}`, why: PC_NOTE });
  const chrome = firstExisting(CHROME);
  if (chrome) out.push({ id: "chrome-system", label: "Google Chrome", path: chrome, hint: `PC에 설치됨 · ${fileVersion(chrome)}`, why: PC_NOTE });
  out.push({ id: "none", label: "사용 안 함", hint: "web-page-automation 스킬 꺼짐", why: "web-page-automation 스킬을 사용하지 않습니다." });
  return out;
}

// ------------------------------------------------------------------ CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [cmd, name, arg] = process.argv.slice(2);
  const ri = process.argv.indexOf("--root");
  const root = ri > 0 ? resolve(process.argv[ri + 1]) : resolve(dirname(fileURLToPath(import.meta.url)), "..");
  try {
    if (cmd === "status") {
      // name role installed(1/0) proprietary(1/0) version — 번들링 전 필수 구성요소 검사에 사용
      for (const e of readLock(root)) {
        console.log([e.name, e.role, hasComponent(e.name, root) ? 1 : 0, CATALOG[e.name]?.proprietary ? 1 : 0, e.version].join("\t"));
      }
      process.exit(0);
    }
    if (cmd === "sync-skills") {
      // sync-skills --root <하네스> --agent <agent 디렉터리> [--browser <OXY_BROWSER>] [--off <OXY_SKILLS_OFF>]
      const opt = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
      const agentDir = opt("--agent") ? resolve(opt("--agent")) : join(root, "agent");
      console.log(syncSkills(root, agentDir, { browser: opt("--browser"), off: opt("--off") }).join(" "));
      process.exit(0);
    }
    if (!OPTIONAL[name]) throw new Error(`알 수 없는 선택 구성요소: ${name}`);
    if (cmd === "install" && arg) {
      installOptional(name, arg, root);
      console.log(`installed ${name} → ${join(root, OPTIONAL[name].installDir)}`);
    } else if (cmd === "license-url") console.log(OPTIONAL[name].licenseUrl);
    else if (cmd === "archive-name" && arg) console.log(archiveFileName(name, arg));
    else throw new Error("usage: components.mjs install <name> <archive> | license-url <name> | archive-name <name> <version> [--root <dir>]");
  } catch (e) {
    console.error(`[fail] ${e.message}`);
    process.exit(1);
  }
}
