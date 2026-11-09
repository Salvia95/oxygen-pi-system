// oxygen-pi-system 종합 설정 (Tweak TUI). 설치된 하네스 폴더에서 실행한다: tweak.cmd / tweak.sh / just tweak
//   - 모델 · vLLM · 브라우저 · SQLcl · 시스템 등록  (설치 TUI 의 "설정 변경"과 같은 흐름)
//   - DB 연결: usql 이름 붙은 연결 + dbhub MCP 소스 (비밀번호는 DPAPI 로 암호화해 저장)
//   - extension: 안전장치 켜기/끄기, 출력 한도
//   - 자가진단
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BACK, banner, c } from "./tui.mjs";
import { ROOT, VERSION, reconfigure, sys, ui } from "./install.mjs";
import { hasComponent } from "./components.mjs";
import { DB_TYPES, ID_RE, loadConnections, probeConnection, saveConnections, secretKey } from "./connections.mjs";
import { deleteSecret, getSecret, hasSecret, setSecret } from "./secrets.mjs";

const { parseEnv, mergeEnv } = await import(pathToFileURL(join(ROOT, "scripts", "render-config.mjs")).href);
const AGENT = join(ROOT, "agent");
const ENV_FILE = join(AGENT, "oxy.env");

const frame = (sub) => () => banner(VERSION) + `  ${c.bold("종합 설정 (Tweak)")}${sub ? c.gray("  ›  " + sub) : ""}  ${c.gray(ROOT)}\n` +
  c.gray("  " + "─".repeat(64)) + "\n";

async function notice(msg) { ui.screen(`  ${msg}`); await ui.pause(); }

// ------------------------------------------------------------------ DB 연결
function describe(conn) {
  const t = DB_TYPES[conn.type];
  const where = conn.type === "sqlite" ? conn.file : `${conn.host}:${conn.port ?? t.port}/${conn.database ?? ""}`;
  const via = [conn.usql && "usql", conn.dbhub && "dbhub"].filter(Boolean).join("+") || "사용 안 함";
  return `${t.label} · ${where} · ${via} · ${conn.readonly !== false ? "읽기 전용" : c.yellow("쓰기 허용")}` +
    (hasSecret(AGENT, secretKey(conn.id)) ? " · 비밀번호 저장됨" : "");
}

/** dbhub 는 연결이 하나면 execute_sql, 여러 개면 execute_sql_<id> 로 도구 이름을 만든다 */
function dbhubTool(conn, tool) {
  const many = loadConnections(AGENT).filter((x) => x.dbhub).length > 1;
  return `mcp__dbhub__${tool}${many ? "_" + conn.id.replace(/-/g, "_") : ""}`;
}

function usage(conn) {
  return [
    conn.usql ? `    • usql:  ${c.cyan(`usql ${conn.id} -w -q --csv -c "select ..."`)}  (sql-querying skill)` : "",
    conn.dbhub ? `    • dbhub: pi 도구 ${c.cyan(dbhubTool(conn, "execute_sql"))}, ${c.cyan(dbhubTool(conn, "search_objects"))}` : "",
    "    • 실행 중인 pi 에는 /reload 로 반영됩니다",
  ].filter(Boolean).join("\n");
}

/** existing: 편집할 기존 연결 (없으면 새 연결), draft: "다시 입력" 때 이어 쓸 값 */
async function editConnection(conns, existing, draft) {
  const hasUsql = hasComponent("usql", ROOT);
  const hasDbhub = hasComponent("dbhub", ROOT);
  const conn = draft ? { ...draft } : existing ? { ...existing } : {};
  ui.frame = frame(existing ? `DB 연결 › ${existing.id}` : "DB 연결 › 추가");

  if (!existing && !draft) {
    const type = await ui.select("DB 종류", Object.entries(DB_TYPES).map(([k, t]) => ({ label: t.label, value: k })));
    if (type === BACK) return null;
    conn.type = type;
    const id = await ui.input("연결 이름 (영문 소문자·숫자·-·_)", {
      hint: "usql 에서는 `usql <이름>`, dbhub 도구 이름에는 `execute_sql_<이름>` 으로 쓰입니다",
      validate: (v) => (!ID_RE.test(v) ? "영문 소문자로 시작, 소문자·숫자·-·_ 만 (31자 이내)" : conns.some((x) => x.id === v) ? "이미 있는 이름입니다" : null),
    });
    if (id === BACK) return null;
    conn.id = id;
  }
  const t = DB_TYPES[conn.type];

  if (conn.type === "sqlite") {
    const f = await ui.input("SQLite 파일 경로", {
      initial: conn.file ?? "", validate: (v) => (!v ? "경로를 입력하세요" : !isAbsolute(v) ? "절대 경로를 입력하세요" : !existsSync(v) ? "파일이 없습니다" : null),
    });
    if (f === BACK) return null;
    conn.file = resolve(f).replace(/\\/g, "/");
  } else {
    const host = await ui.input(`${t.label} 호스트`, { initial: conn.host ?? "", validate: (v) => (/^[A-Za-z0-9._-]+$/.test(v) ? null : "호스트 이름 또는 IP") });
    if (host === BACK) return null;
    const port = await ui.input("포트", { initial: String(conn.port ?? t.port), validate: (v) => (/^\d{1,5}$/.test(v) ? null : "숫자") });
    if (port === BACK) return null;
    const db = await ui.input(conn.type === "oracle" ? "서비스 이름 (예: ORCLPDB1)" : "데이터베이스 이름", { initial: conn.database ?? "", validate: (v) => (v ? null : "필수 입력") });
    if (db === BACK) return null;
    const user = await ui.input("사용자", { initial: conn.user ?? "", validate: (v) => (v ? null : "필수 입력"), hint: "가능하면 읽기 전용 계정을 쓰세요" });
    if (user === BACK) return null;
    Object.assign(conn, { host, port: Number(port), database: db, user });
  }

  // 비밀번호 (DPAPI 로 암호화해 agent/secrets.json 에만 저장)
  let password;      // undefined = 바꾸지 않음, "" = 삭제
  if (conn.type !== "sqlite") {
    const stored = hasSecret(AGENT, secretKey(conn.id));
    let action = "set";
    if (stored) {
      action = await ui.select("비밀번호", [
        { label: "저장된 비밀번호 유지", value: "keep" },
        { label: "바꾸기", value: "set" },
        { label: "삭제", value: "delete" },
      ]);
      if (action === BACK) return null;
    }
    if (action === "set") {
      const pw = await ui.input("비밀번호", {
        mask: true, hint: "Windows DPAPI 로 암호화해 이 PC 의 현재 사용자만 복호화할 수 있게 저장합니다. 비워 두면 저장하지 않습니다",
      });
      if (pw === BACK) return null;
      password = pw;
    } else if (action === "delete") password = "";
  }

  const ro = await ui.select("권한", [
    { label: "읽기 전용 (권장)", value: true, hint: "dbhub 가 SELECT·SHOW·EXPLAIN 만 허용" },
    { label: "쓰기 허용", value: false, hint: "변경 SQL 은 여전히 bash-guard 가 사용자 확인을 받음" },
  ], { initial: conn.readonly === false ? 1 : 0 });
  if (ro === BACK) return null;
  conn.readonly = ro;

  const targets = [
    ...(hasUsql ? [{ label: "usql (CLI)", value: "usql", checked: conn.usql ?? true, hint: "sql-querying skill" }] : []),
    ...(hasDbhub ? [{ label: "dbhub (pi MCP 도구)", value: "dbhub", checked: conn.dbhub ?? true, hint: "execute_sql / search_objects 도구" }] : []),
  ];
  const picked = targets.length > 1 ? await ui.multiselect("이 연결을 쓸 도구", targets) : targets.map((x) => x.value);
  if (picked === BACK) return null;
  conn.usql = picked.includes("usql");
  conn.dbhub = picked.includes("dbhub");

  // 연결 시험 (usql 이 있으면)
  if (hasUsql && await ui.confirm("지금 연결을 시험할까요?", { note: c.gray("  usql 로 간단한 조회(select 1)를 실행합니다") })) {
    ui.screen(`  ${c.bold("연결 시험")}\n`);
    const pwForProbe = password !== undefined ? password : undefined;
    let r;
    try {
      r = await ui.task(`${conn.id} 접속`, async () => {
        const res = probeConnection(ROOT, AGENT, conn, pwForProbe ?? getSecret(AGENT, secretKey(conn.id)));
        if (!res.ok) throw new Error(res.output);
        return "성공";
      });
    } catch { r = null; }
    if (!r) {
      const go = await ui.select("연결하지 못했습니다", [
        { label: "그래도 저장", value: "save" },
        { label: "다시 입력", value: "again" },
        { label: "취소", value: "cancel" },
      ], { back: false });
      if (go === "again") return editConnection(conns, existing, conn);
      if (go === "cancel") return null;
    }
  }

  if (password !== undefined) {
    if (password) setSecret(AGENT, secretKey(conn.id), password);
    else deleteSecret(AGENT, secretKey(conn.id));
  }
  const next = existing ? conns.map((x) => (x.id === conn.id ? conn : x)) : [...conns, conn];
  saveConnections(ROOT, AGENT, next);
  await notice(`${c.green("✔")} 저장했습니다: ${c.bold(conn.id)}  ${c.gray(describe(conn))}\n\n${usage(conn)}`);
  return conn;
}

async function dbMenu() {
  for (;;) {
    ui.frame = frame("DB 연결");
    const hasUsql = hasComponent("usql", ROOT);
    const hasDbhub = hasComponent("dbhub", ROOT);
    if (!hasUsql && !hasDbhub) {
      await notice(`${c.yellow("!")} usql 과 dbhub 가 모두 반입되지 않았습니다.\n  인터넷 PC 에서 fetch 로 받아 다시 번들링하세요 (database 계층).`);
      return;
    }
    const conns = loadConnections(AGENT);
    const v = await ui.select(`DB 연결 (${conns.length}개)`, [
      ...conns.map((x) => ({ label: x.id, value: x.id, hint: describe(x) })),
      { label: "+ 새 연결 추가", value: "__add" },
      { label: "← 뒤로", value: "__back" },
    ], { note: c.gray(`  사용 가능한 도구: ${[hasUsql && "usql", hasDbhub && "dbhub (MCP)"].filter(Boolean).join(", ")}`) });
    if (v === BACK || v === "__back") return;
    if (v === "__add") { await editConnection(conns); continue; }
    const conn = conns.find((x) => x.id === v);
    const act = await ui.select(conn.id, [
      { label: "편집", value: "edit" },
      ...(hasUsql ? [{ label: "연결 시험", value: "probe" }] : []),
      { label: "삭제", value: "delete" },
      { label: "← 뒤로", value: "back" },
    ], { note: `  ${c.gray(describe(conn))}\n\n${usage(conn)}` });
    if (act === "edit") await editConnection(conns, conn);
    else if (act === "probe") {
      ui.screen(`  ${c.bold("연결 시험")}\n`);
      try {
        await ui.task(`${conn.id} 접속`, async () => {
          const res = probeConnection(ROOT, AGENT, conn, getSecret(AGENT, secretKey(conn.id)));
          if (!res.ok) throw new Error(res.output);
          return "성공";
        });
      } catch { /* 메시지는 task 가 출력 */ }
      await ui.pause();
    } else if (act === "delete") {
      if (await ui.confirm(`${conn.id} 연결을 삭제할까요? (저장된 비밀번호도 삭제)`, { initial: false })) {
        deleteSecret(AGENT, secretKey(conn.id));
        saveConnections(ROOT, AGENT, conns.filter((x) => x.id !== conn.id));
      }
    }
  }
}

// ------------------------------------------------------------------ extension
const EXTENSIONS = [
  { key: "OXY_BASH_GUARD", label: "oxy-bash-guard", hint: "위험 명령 차단 · 쓰기 작업 확인" },
  { key: "OXY_READ_BEFORE_EDIT", label: "oxy-read-before-edit", hint: "읽지 않은 파일 수정 차단" },
  { key: "OXY_LOOP_GUARD", label: "oxy-loop-guard", hint: "텍스트 tool call 재호출 안내 · 반복 호출 차단" },
  { key: "OXY_CONTEXT_BUDGET", label: "oxy-context-budget", hint: "긴 출력 축약 · 컨텍스트 사용률 표시" },
  { key: "OXY_JOBS", label: "oxy-jobs", hint: "백그라운드 작업 · subagent · 작업 패널" },
  { key: "OXY_VLLM_METRICS", label: "vLLM 혼잡 감지 (oxy-jobs)", hint: "subagent 시작 전 vLLM /metrics 확인 · 기본 꺼짐", defaultOff: true },
];
const LIMITS = [
  { key: "OXY_TOOL_OUTPUT_MAX_CHARS", label: "bash·grep·find 출력 상한 (자)", def: 12000 },
  { key: "OXY_READ_MAX_CHARS", label: "read 출력 상한 (자)", def: 40000 },
  { key: "OXY_REPEAT_LIMIT", label: "같은 호출 반복 차단 횟수", def: 3 },
  { key: "OXY_LLM_MAX_CONCURRENT", label: "subagent 동시 실행 수 (vLLM KV 캐시 고려)", def: 2 },
  { key: "OXY_JOBS_MAX_CONCURRENT", label: "백그라운드 bash 동시 실행 수", def: 4 },
];

async function extensionMenu() {
  ui.frame = frame("extension");
  const text = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : "";
  const env = parseEnv(text);
  const isOn = (e) => (e.defaultOff ? /^(on|1|true)$/i.test(env[e.key] ?? "") : !/^(off|0|false)$/i.test(env[e.key] ?? ""));
  const on = await ui.multiselect("켤 extension", EXTENSIONS.map((e) => ({ label: e.label, value: e.key, hint: e.hint, checked: isOn(e) })),
    { note: c.gray("  끄면 소형 모델의 실수를 막는 장치가 사라집니다. 특별한 이유가 없으면 모두 켜 두세요.") });
  if (on === BACK) return;
  const updates = Object.fromEntries(EXTENSIONS.map((e) => [e.key, on.includes(e.key) ? "on" : "off"]));
  if (await ui.confirm("출력 한도 값을 바꿀까요?", { initial: false })) {
    for (const l of LIMITS) {
      const v = await ui.input(l.label, { initial: String(env[l.key] ?? l.def), validate: (s) => (/^\d+$/.test(s) && Number(s) > 0 ? null : "양의 정수") });
      if (v === BACK) return;
      updates[l.key] = v;
    }
  }
  writeFileSync(ENV_FILE, mergeEnv(text, updates));
  await notice(`${c.green("✔")} 저장했습니다 (agent/oxy.env). 다음에 pi 를 시작할 때 적용됩니다.\n\n` +
    EXTENSIONS.map((e) => `    ${updates[e.key] === "on" ? c.green("●") : c.gray("○")} ${e.label}`).join("\n"));
}

// ------------------------------------------------------------------ 모델 · vLLM 등 (설치 TUI 재사용)
async function generalSettings() {
  let reg = sys.loadRegistry();
  const registered = reg?.installDir && sys.isSameDir(reg.installDir, ROOT);
  if (!registered) reg = { installDir: ROOT, copied: false, gitBash: sys.findGitBash(), integrations: [] };
  await reconfigure(reg, { saveRegistry: Boolean(registered) });
}

async function verifyNow() {
  ui.clear();
  ui.print(banner(VERSION));
  const reg = sys.loadRegistry();
  const gitBash = reg?.gitBash && existsSync(reg.gitBash) ? reg.gitBash : sys.findGitBash();
  sys.runVerify(ROOT, gitBash);
  await ui.pause();
}

// ------------------------------------------------------------------ main
async function main() {
  if (!existsSync(join(AGENT, "oxy.env"))) {
    ui.frame = frame();
    await notice(`${c.yellow("!")} 아직 설치(설정)되지 않은 하네스입니다. 먼저 install.cmd 를 실행하세요.`);
    return 1;
  }
  for (;;) {
    ui.frame = frame();
    const nconn = loadConnections(AGENT).length;
    const v = await ui.select("무엇을 설정할까요?", [
      { label: "모델 · vLLM · 브라우저 · SQLcl · 시스템 등록", value: "general", hint: "설치 TUI 의 설정 변경과 같은 흐름" },
      { label: `DB 연결 (${nconn}개)`, value: "db", hint: "usql 이름 붙은 연결 · dbhub MCP" },
      { label: "extension", value: "ext", hint: "안전장치 켜기/끄기 · 출력 한도" },
      { label: "자가진단", value: "verify" },
      { label: "종료", value: "exit" },
    ], { back: false });
    if (v === "exit") return 0;
    if (v === "general") await generalSettings();
    else if (v === "db") await dbMenu();
    else if (v === "ext") await extensionMenu();
    else if (v === "verify") await verifyNow();
  }
}

let code = 1;
try {
  code = await main();
} catch (e) {
  process.stdout.write(`\n${c.red("오류:")} ${e.stack ?? e}\n`);
} finally {
  ui.close();
  process.stdout.write("\x1b[?25h");
}
process.exit(code);
