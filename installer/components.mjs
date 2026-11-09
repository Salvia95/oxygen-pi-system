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

/** manifest/tools.lock.tsv → [{name, version, url, sha256, license, role, required}] */
export function readLock(root) {
  return readFileSync(join(root, "manifest", "tools.lock.tsv"), "utf8").split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const [name, version, url, sha256, license, role, group] = l.split("\t");
      return { name, version, url, sha256, license, role, group, required: role === "required" };
    });
}

/** 상위 계층 (선택 화면·설치 TUI 표시 순서) */
export const GROUPS = {
  core: { title: "core", desc: "하네스 동작에 필요 (필수)" },
  "dev-tools": { title: "dev-tools", desc: "작업 실행 · API 테스트" },
  repository: { title: "repository", desc: "저장소·코드 리뷰 (사내 환경에 열린 것 선택, 여러 개 가능)" },
  "code-intel": { title: "code-intel", desc: "코드 탐색 보조 (기본 탐색은 rg/fd · 문법 단위 검색 · 코드 그래프)" },
  "internet-browsing": { title: "internet-browsing", desc: "사내 웹 페이지 읽기·조작 (도구 + 브라우저 엔진)" },
  database: { title: "database", desc: "DB 조회 (CLI 클라이언트 · MCP 커넥터)" },
};

/**
 * 모든 구성요소의 표시 정보와 설치 확인 파일 (하네스 루트 기준).
 * 필수 여부·버전·라이선스·계층은 manifest 가 기준이고, 여기에는 화면에 보여 줄 설명만 둔다.
 *   kind        : tool | engine(agent-browser 용 브라우저) | cli | connector
 *   skills      : 이 구성요소가 있으면 켜는 skill (agent/skill-library/<name>)
 *   proprietary : 오픈소스가 아닌 라이선스 → fetch 할 때 약관 동의, 번들링할 때 재배포 주의 안내
 *   recommended : 같은 계층의 대안 중 호환성이 가장 검증된 것
 */
export const CATALOG = {
  node: { title: "Node.js", kind: "tool", purpose: "pi 실행 런타임", check: "runtime/node/node.exe" },
  pi: { title: "pi coding agent", kind: "tool", purpose: "에이전트 본체", check: "vendor/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" },
  fd: { title: "fd", kind: "tool", purpose: "pi 의 find 도구 (없으면 pi 가 인터넷에서 받으려 함)", check: "bin/fd.exe", skills: ["find-code"] },
  rg: { title: "ripgrep", kind: "tool", purpose: "pi 의 grep 도구 (없으면 pi 가 인터넷에서 받으려 함)", check: "bin/rg.exe", skills: ["find-code"] },
  jq: { title: "jq", kind: "tool", purpose: "JSON 처리 · 하네스 자가진단(verify)", check: "bin/jq.exe", skills: ["json-querying"] },
  just: { title: "just", kind: "tool", purpose: "프로젝트 작업 실행기", check: "bin/just.exe", skills: ["project-task-running"] },
  hurl: { title: "hurl", kind: "tool", purpose: "HTTP API 호출·테스트", check: "bin/hurl.exe", skills: ["http-api-testing"] },
  glab: { title: "glab", kind: "tool", purpose: "GitLab MR·이슈·CI", check: "bin/glab.exe", skills: ["gitlab-workflow"] },
  gh: { title: "gh", kind: "tool", purpose: "GitHub / GitHub Enterprise PR·이슈·Actions", check: "bin/gh.exe", skills: ["github-workflow"] },
  psmux: { title: "psmux", kind: "tool", purpose: "터미널 멀티플렉서 (tmux 호환) · 대화형 프로그램 조작 · oxy mux · /jobs 로그 pane", check: "bin/psmux.exe", skills: ["terminal-session-control"] },
  "ast-grep": { title: "ast-grep", kind: "tool", purpose: "문법(AST) 단위 코드 검색·일괄 치환 (주석·문자열 제외, 구조로 매칭)", check: "bin/ast-grep.exe", skills: ["structural-code-search"] },
  // graphin: Windows 빌드가 아직 배포되지 않아 manifest(fetch) 에는 없다. 직접 빌드한 graphin.exe 를 vendor/graphin/ 에 넣으면
  // pi MCP 서버로 등록되고 skill 이 켜진다 (external: fetch 대상 아님)
  graphin: { title: "graphin", kind: "connector", purpose: "코드베이스 탐색 MCP (하이브리드 검색 · 코드 그래프 · 정확한 소스 조각) · Windows 빌드 직접 반입", check: "vendor/graphin/graphin.exe", skills: ["code-graph-search"], external: true, group: "code-intel" },
  "agent-browser": { title: "agent-browser", kind: "tool", purpose: "페이지 조작 (클릭·입력·스크린샷) · 브라우저 엔진 필요", check: "bin/agent-browser.exe", skills: ["web-page-automation"], recommended: true },
  obscura: { title: "obscura", kind: "tool", purpose: "가벼운 페이지 읽기·수집 (JS 렌더링) · agent-browser 엔진으로도 사용", check: "bin/obscura.exe", skills: ["web-page-reading"] },
  chromium: { title: "Chromium 오픈소스 빌드", kind: "engine", purpose: "agent-browser 용 브라우저 엔진 (오픈소스)", check: "vendor/browsers/chromium/chrome.exe" },
  chrome: { title: "Chrome for Testing", kind: "engine", purpose: "agent-browser 용 브라우저 엔진 (agent-browser 기본)", check: "vendor/browsers/chrome-win64/chrome.exe", proprietary: true, recommended: true },
  usql: { title: "usql", kind: "cli", purpose: "범용 SQL CLI (PostgreSQL·MySQL·SQLite·SQL Server·Oracle 등)", check: "bin/usql.exe", skills: ["sql-querying"], recommended: true },
  sqlcl: { title: "Oracle SQLcl", kind: "cli", purpose: "Oracle 전용 CLI (info·ddl 등) · Java 17 필요", check: "runtime/sqlcl/bin/sql", proprietary: true, skills: ["oracle-db-querying"] },
  dbhub: { title: "dbhub", kind: "connector", purpose: "DB MCP 커넥터 (pi 도구로 SQL 실행) · 연결은 tweak.cmd 에서 등록", check: "vendor/dbhub/node_modules/@bytebase/dbhub/dist/index.js" },
};

export const hasComponent = (name, root) => Boolean(CATALOG[name]) && existsSync(join(root, CATALOG[name].check));

// ------------------------------------------------------------------ skill 자동 활성화
// skill 원본은 agent/skill-library/<name> 에 두고, 설치된 구성요소에 해당하는 것만 agent/skills/ 로 복사한다.
// (pi 는 agent/skills 만 읽는다. skill-library 에 없는 사용자 skill 은 건드리지 않는다)

/** root(하네스 루트)에 설치된 구성요소 기준으로 켤 skill 이름 */
export function enabledSkills(root, { browser } = {}) {
  const set = new Set();
  for (const [name, cat] of Object.entries(CATALOG)) {
    if (cat.skills && hasComponent(name, root)) cat.skills.forEach((s) => set.add(s));
  }
  if (browser === "none") set.delete("web-page-automation");
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
 * graphin MCP 등록: vendor/graphin/graphin.exe 가 있으면 agent/mcp.json 에 넣고, 없으면 뺀다 (다른 서버는 유지).
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
    purpose: "Oracle DB 조회·스크립트 실행 (sql 명령, oracle-db-querying skill). Java 17 이상 필요",
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
    purpose: "agent-browser 용 브라우저 (Google 의 자동화 전용 Chrome 빌드)",
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
  if (!existsSync(archive)) throw new Error(`파일 없음: ${archive}`);
  const tmp = join(destRoot, `.oxy-tmp-${name}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    // Windows 내장 bsdtar 는 zip 을 풀 수 있다 (추가 도구 불필요)
    const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
    const r = spawnSync(tar, ["-xf", resolve(archive), "-C", tmp], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`압축 해제 실패: ${(r.stderr || "").trim().split("\n")[0]}`);
    const src = join(tmp, c.zipRoot);
    if (!existsSync(src)) throw new Error(`압축 파일 안에 ${c.zipRoot}/ 폴더가 없습니다 (올바른 ${c.title} 파일인지 확인)`);
    const dest = join(destRoot, c.installDir);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dirname(dest), { recursive: true });
    renameSync(src, dest);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  if (!isInstalled(name, destRoot)) throw new Error(`설치 후 ${c.check} 를 찾지 못함`);
}

// ------------------------------------------------------------------ 브라우저 선택지 (agent-browser 런타임)
const EDGE = ["ProgramFiles(x86)", "ProgramFiles"].map((v) => process.env[v] && join(process.env[v], "Microsoft", "Edge", "Application", "msedge.exe"));
const CHROME = [
  process.env.ProgramFiles && join(process.env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"),
  process.env["ProgramFiles(x86)"] && join(process.env["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe"),
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
];
const firstExisting = (list) => list.filter(Boolean).find((p) => existsSync(p)) ?? null;

function fileVersion(path) {
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `(Get-Item -LiteralPath '${path.replace(/'/g, "''")}').VersionInfo.ProductVersion`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
}

/**
 * agent-browser 가 쓸 브라우저 선택지. 호환성이 가장 검증된 것에 recommended 를 붙인다.
 * root: 번들(설치 원본) 루트. 반환값의 id 는 oxy.env 의 OXY_BROWSER 값이 된다.
 */
export function browserChoices(root) {
  const cft = hasComponent("chrome", root);
  const out = [{
    id: "chrome-for-testing", label: "Chrome for Testing", recommended: true, ...(cft ? {} : { needs: "chrome" }),
    hint: `agent-browser 의 기본 브라우저로 가장 많이 검증됨 · ${cft ? "번들에 포함됨" : "번들에 없음 → 직접 받은 chrome-win64.zip 지정"}`,
  }];
  if (hasComponent("chromium", root)) {
    out.push({ id: "chromium", label: "Chromium 오픈소스 빌드", hint: "번들에 포함됨 · BSD 라이선스" });
  }
  if (hasComponent("obscura", root)) {
    out.push({ id: "obscura", label: "obscura (경량 엔진)", hint: "번들에 포함됨 · Apache-2.0 · Chrome 대비 약 1/3 용량 · 일부 CDP 기능 미지원" });
  }
  const edge = firstExisting(EDGE);
  if (edge) out.push({ id: "edge", label: "Microsoft Edge (PC 설치본)", path: edge, hint: `${fileVersion(edge)} · 회사 업데이트 정책에 따라 버전이 바뀜` });
  const chrome = firstExisting(CHROME);
  if (chrome) out.push({ id: "chrome-system", label: "Google Chrome (PC 설치본)", path: chrome, hint: `${fileVersion(chrome)} · 회사 업데이트 정책에 따라 버전이 바뀜` });
  out.push({ id: "none", label: "사용 안 함", hint: "브라우저 자동화(web-page-automation)를 쓰지 않음" });
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
      // sync-skills --root <하네스> --agent <agent 디렉터리> [--browser <OXY_BROWSER>]
      const ai = process.argv.indexOf("--agent");
      const bi = process.argv.indexOf("--browser");
      const agentDir = ai > 0 ? resolve(process.argv[ai + 1]) : join(root, "agent");
      console.log(syncSkills(root, agentDir, { browser: bi > 0 ? process.argv[bi + 1] : undefined }).join(" "));
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
