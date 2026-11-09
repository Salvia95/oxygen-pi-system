// oxygen-pi-system 종합 설정 (Tweak TUI). 설치된 하네스 폴더에서 실행한다: tweak.cmd / tweak.sh / just tweak
// 이미 설치된 항목을 순서와 상관없이 하나씩 골라 바꾼다 (고른 항목만 바꾸고 바로 저장).
//   - vLLM · 모델 · GitLab · 브라우저 · SQLcl · 시스템 등록  (설치 TUI 의 단계를 하나씩 재사용)
//   - DB 연결: usql 이름 붙은 연결 + dbhub MCP 소스 (비밀번호는 DPAPI 로 암호화해 저장)
//   - extension 켜기/끄기 · 한도 값 · 설치된 구성요소 보기 · 자가진단
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BACK, banner, c } from "./tui.mjs";
import {
  ROOT, VERSION, applyIntegrations, applyOptional, fetchModels, stateFromInstall, stepBrowser, stepGitlab, stepIntegrate,
  stepModel, stepSqlcl, stepVllm, sys, ui, writeSiteConfig,
} from "./install.mjs";
import { CATALOG, GROUPS, OPTIONAL, enabledSkills, hasComponent, isInstalled, readLock } from "./components.mjs";
import { DB_TYPES, ID_RE, loadConnections, probeConnection, saveConnections, secretKey } from "./connections.mjs";
import { deleteSecret, getSecret, hasSecret, setSecret } from "./secrets.mjs";

const { parseEnv, mergeEnv, VLLM_EXTRA_PARAMS, detectFamily } = await import(pathToFileURL(join(ROOT, "scripts", "render-config.mjs")).href);
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
  { key: "OXY_FLOW", label: "oxy-flow", hint: "작업 기록 (커밋 단위 결정) · compaction 을 작업 상태로 교체" },
  { key: "OXY_FLOW_ROLLOVER", label: "세션 넘기기 (oxy-flow)", hint: "컨텍스트가 찬 뒤 새 메시지는 새 세션에서 이어감" },
  { key: "OXY_JOBS", label: "oxy-jobs", hint: "백그라운드 작업 · subagent · 작업 패널" },
  { key: "OXY_VLLM_METRICS", label: "vLLM 혼잡 감지 (oxy-jobs)", hint: "subagent 시작 전 vLLM /metrics 확인 · 기본 꺼짐", defaultOff: true },
];
const LIMITS = [
  { key: "OXY_TOOL_OUTPUT_MAX_CHARS", label: "bash·grep·find 출력 상한 (자)", def: 12000 },
  { key: "OXY_READ_MAX_CHARS", label: "read 출력 상한 (자)", def: 40000 },
  { key: "OXY_REPEAT_LIMIT", label: "같은 호출 반복 차단 횟수", def: 3 },
  { key: "OXY_FLOW_ROLLOVER_PCT", label: "세션 넘기기 기준 컨텍스트 사용률 (%)", def: 50 },
  { key: "OXY_LLM_MAX_CONCURRENT", label: "subagent 동시 실행 수 (vLLM KV 캐시 고려)", def: 2 },
  { key: "OXY_JOBS_MAX_CONCURRENT", label: "백그라운드 bash 동시 실행 수", def: 4 },
];

const readEnv = () => { const text = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : ""; return { text, env: parseEnv(text) }; };
const isOn = (env, e) => (e.defaultOff ? /^(on|1|true)$/i.test(env[e.key] ?? "") : !/^(off|0|false)$/i.test(env[e.key] ?? ""));
const SAVED = `${c.green("✔")} 저장했습니다 (agent/oxy.env). 실행 중인 pi 는 다시 시작하면 적용됩니다.`;

async function extensionMenu() {
  ui.frame = frame("extension 켜기/끄기");
  const { text, env } = readEnv();
  const on = await ui.multiselect("켤 extension", EXTENSIONS.map((e) => ({ label: e.label, value: e.key, hint: e.hint, checked: isOn(env, e) })),
    { note: c.gray("  끄면 소형 모델의 실수를 막는 장치가 사라집니다. 특별한 이유가 없으면 모두 켜 두세요.") });
  if (on === BACK) return;
  const updates = Object.fromEntries(EXTENSIONS.map((e) => [e.key, on.includes(e.key) ? "on" : "off"]));
  writeFileSync(ENV_FILE, mergeEnv(text, updates));
  await notice(`${SAVED}\n\n` + EXTENSIONS.map((e) => `    ${updates[e.key] === "on" ? c.green("●") : c.gray("○")} ${e.label}`).join("\n"));
}

/** 한도 값: 목록에서 하나 골라 그 값만 바꾼다 */
async function limitsMenu() {
  for (;;) {
    ui.frame = frame("한도 · 동시 실행");
    const { text, env } = readEnv();
    const k = await ui.select("바꿀 값", [
      ...LIMITS.map((l) => ({ label: l.label, value: l.key, hint: `${env[l.key] ?? l.def}${env[l.key] ? "" : " (기본)"}` })),
      { label: "← 뒤로", value: "__back" },
    ]);
    if (k === BACK || k === "__back") return;
    const l = LIMITS.find((x) => x.key === k);
    const v = await ui.input(l.label, { initial: String(env[l.key] ?? l.def), hint: `기본값 ${l.def}`, validate: (s) => (/^\d+$/.test(s) && Number(s) > 0 ? null : "양의 정수") });
    if (v === BACK) continue;
    writeFileSync(ENV_FILE, mergeEnv(text, { [l.key]: v }));
  }
}

// ------------------------------------------------------------------ 설치 항목 (설치 TUI 의 단계를 하나씩 재사용)
function registry() {
  const reg = sys.loadRegistry();
  const registered = Boolean(reg?.installDir && sys.isSameDir(reg.installDir, ROOT));
  return { registered, reg: registered ? reg : { installDir: ROOT, copied: false, gitBash: sys.findGitBash(), integrations: [] } };
}

/** 고른 항목 하나만 바꾸고 바로 저장한다. step 이 BACK 이면 아무것도 바꾸지 않는다 */
async function editItem(title, run) {
  const { registered, reg } = registry();
  const state = { ...stateFromInstall(reg), installDir: ROOT };
  ui.frame = frame(title);
  const r = await run(state);
  if (r === BACK || r === "cancel") return;
  ui.screen(`  ${c.bold(`${title} 적용 중`)}\n`);
  try {
    await applyOptional(state);
    await ui.task("설정 생성 (oxy.env, settings.json, models.json, skill)", async () => `${writeSiteConfig(ROOT, state)}개 파일`);
    if (r === "integrations") {
      await applyIntegrations(state, reg);
      if (registered) sys.saveRegistry({ ...reg, integrations: state.integrations, updatedAt: new Date().toISOString() });
    }
  } catch { await ui.pause(); return; }
  ui.print(`\n  ${SAVED}`);
  await ui.pause();
}

/** vLLM 에서 모델 목록을 받아 둔다 (모델 단계에서 고를 수 있게). 실패하면 직접 입력 */
async function withModels(state) {
  ui.screen(`  ${c.bold("vLLM 모델 목록")}\n`);
  try { state.models = await ui.task(`${state.baseUrl}/models`, async () => fetchModels(state.baseUrl, state.apiKey)); }
  catch { state.models = []; await ui.pause("모델 이름을 직접 입력합니다. Enter"); }
}

const items = {
  vllm: { title: "vLLM 주소 · API 키", run: async (state) => {
    const r = await stepVllm(state);
    if (r === BACK) return BACK;
    // 지금 쓰는 모델이 새 서버에 없으면 이어서 모델을 고른다
    if (state.models?.length && !state.models.some((m) => m.id === state.coder)) {
      await notice(`${c.yellow("!")} 지금 모델 ${state.coder} 이(가) 이 서버에 없습니다. 모델을 다시 고르세요.`);
      return stepModel(state);
    }
    return r;
  } },
  model: { title: "모델 · 계열 · 컨텍스트", run: async (state) => { await withModels(state); return stepModel(state); } },
  gitlab: { title: "GitLab 호스트", run: (state) => stepGitlab(state) },
  browser: { title: "브라우저 (agent-browser)", run: (state) => stepBrowser(state) },
  sqlcl: { title: "Oracle SQLcl", run: (state) => stepSqlcl(state) },
  integrations: { title: "시스템 등록", run: async (state) => ((await stepIntegrate(state)) === BACK ? BACK : "integrations") },
};

/** 엔드포인트 세부 설정: 값 하나씩 바꾸고 바로 설정(models.json · settings.json)을 다시 만든다 */
async function endpointMenu() {
  for (;;) {
    ui.frame = frame("엔드포인트 세부 설정");
    const { text, env } = readEnv();
    const drop = String(env.OXY_VLLM_DROP_PARAMS ?? "").split(/[\s,]+/).filter(Boolean);
    const k = await ui.select("바꿀 값", [
      { label: "요청에서 뺄 파라미터", value: "drop", hint: drop.join(", ") || "없음 (모두 보냄)" },
      { label: "거부됐을 때 재시도 횟수", value: "retries", hint: env.OXY_PROVIDER_RETRIES ? `${env.OXY_PROVIDER_RETRIES}회` : "0 (재시도 안 함)" },
      { label: "응답 최대 토큰", value: "maxout", hint: env.OXY_MAX_OUTPUT_TOKENS || "모델 기본값" },
      { label: "← 뒤로", value: "__back" },
    ], { note: c.gray("  'vLLM 주소 · API 키' 항목이 서버에 시험해서 자동으로 정하는 값입니다. 사용량 제한이 있는 엔드포인트에서 직접 맞출 때 씁니다.") });
    if (k === BACK || k === "__back") return;
    let updates = null;
    if (k === "drop") {
      const v = await ui.multiselect("요청에서 뺄 파라미터 (서버가 거부하는 것)", VLLM_EXTRA_PARAMS.map((p) => ({ label: p, value: p, checked: drop.includes(p),
        hint: p === "chat_template_kwargs" ? "Qwen thinking 켜고 끄기" : p === "reasoning_effort" ? "gpt-oss 추론 강도" : "vLLM 샘플링 확장" })));
      if (v !== BACK) updates = { OXY_VLLM_DROP_PARAMS: v.join(",") };
    } else if (k === "retries") {
      const v = await ui.input("거부됐을 때 재시도 횟수", { initial: env.OXY_PROVIDER_RETRIES ?? "0",
        hint: "429 등에서 서버가 알려 준 시간만큼 기다렸다 다시 보냅니다. 사내 vLLM 은 보통 0", validate: (s) => (/^\d{1,2}$/.test(s) ? null : "0~99") });
      if (v !== BACK) updates = { OXY_PROVIDER_RETRIES: v === "0" ? "" : v };
    } else if (k === "maxout") {
      const v = await ui.input("응답 최대 토큰 (비우면 모델 기본값)", { initial: env.OXY_MAX_OUTPUT_TOKENS ?? "",
        hint: "분당 출력 토큰 제한보다 작게 둡니다", validate: (s) => (s === "" || (/^\d+$/.test(s) && Number(s) >= 256) ? null : "256 이상의 숫자 또는 빈칸") });
      if (v !== BACK) updates = { OXY_MAX_OUTPUT_TOKENS: v };
    }
    if (!updates) continue;
    writeFileSync(ENV_FILE, mergeEnv(text, updates));
    const { reg } = registry();
    try { writeSiteConfig(ROOT, { ...stateFromInstall(reg), installDir: ROOT }); } catch (e) { await notice(`${c.red("✖")} 설정 생성 실패: ${e.message}`); }
  }
}

/** 설치된 구성요소와 켜진 skill (읽기 전용) */
async function componentsView() {
  ui.frame = frame("설치된 구성요소");
  const lines = [];
  const lock = readLock(ROOT);
  for (const [group, g] of Object.entries(GROUPS)) {
    // manifest(fetch) 대상 + 직접 반입하는 구성요소(external, 예: graphin)
    const rows = [...lock.filter((x) => x.group === group && CATALOG[x.name]),
      ...Object.entries(CATALOG).filter(([, x]) => x.external && x.group === group).map(([name]) => ({ name, version: "직접 반입" }))];
    if (!rows.length) continue;
    lines.push(`  ${c.bold(c.cyan(g.title))}  ${c.gray(g.desc)}`);
    for (const x of rows) {
      const on = hasComponent(x.name, ROOT);
      lines.push(`    ${on ? c.green("●") : c.gray("○")} ${on ? x.name : c.gray(x.name)}  ${c.gray(`${x.version} · ${CATALOG[x.name].purpose}`)}`);
    }
  }
  const skills = [...enabledSkills(ROOT, { browser: readEnv().env.OXY_BROWSER })].sort();
  lines.push("", `  ${c.bold("켜진 skill")}  ${skills.join(", ") || c.gray("없음")}`,
    "", c.gray("  구성요소 추가·제거: 인터넷 PC 에서 fetch → 번들링 → 반입 후 install.cmd 로 업데이트"));
  await notice(lines.join("\n"));
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
  let last = 0;
  for (;;) {
    ui.frame = frame();
    const { env } = readEnv();
    const { reg } = registry();
    const gray = (s) => s || c.gray("없음");
    const onCount = EXTENSIONS.filter((e) => isOn(env, e)).length;
    const menu = [
      { label: "vLLM 주소 · API 키", value: "vllm", hint: gray(env.OXY_VLLM_BASE_URL) },
      { label: "모델 · 계열 · 컨텍스트", value: "model", hint: `${env.OXY_MODEL_CODER ?? "?"} (${env.OXY_MODEL_CODER_FAMILY || detectFamily(env.OXY_MODEL_CODER)})${env.OXY_MODEL_GENERAL ? ` + ${env.OXY_MODEL_GENERAL} (${env.OXY_MODEL_GENERAL_FAMILY || detectFamily(env.OXY_MODEL_GENERAL)})` : ""} · ${Math.round(Number(env.OXY_CONTEXT_WINDOW || 0) / 1024)}K` },
      { label: "엔드포인트 세부 설정", value: "endpoint", hint: [env.OXY_VLLM_DROP_PARAMS && `뺀 파라미터 ${env.OXY_VLLM_DROP_PARAMS.split(",").length}개`, env.OXY_PROVIDER_RETRIES && `재시도 ${env.OXY_PROVIDER_RETRIES}회`, env.OXY_MAX_OUTPUT_TOKENS && `응답 최대 ${env.OXY_MAX_OUTPUT_TOKENS}`].filter(Boolean).join(" · ") || "기본값" },
      { label: "GitLab 호스트", value: "gitlab", hint: gray(env.GITLAB_HOST) },
      ...(hasComponent("agent-browser", ROOT) ? [{ label: "브라우저 (agent-browser)", value: "browser", hint: gray(env.OXY_BROWSER) }] : []),
      ...(hasComponent("sqlcl", ROOT) || OPTIONAL.sqlcl ? [{ label: "Oracle SQLcl", value: "sqlcl", hint: isInstalled("sqlcl", ROOT) ? "설치됨" : c.gray("설치 안 됨") }] : []),
      { label: "시스템 등록", value: "integrations", hint: gray((reg.integrations ?? []).map((k) => ({ path: "PATH", wt: "Windows Terminal", shortcut: "바로가기" })[k]).join(", ")) },
      { label: "DB 연결", value: "db", hint: `${loadConnections(AGENT).length}개` },
      { label: "extension 켜기/끄기", value: "ext", hint: `${onCount}/${EXTENSIONS.length} 켜짐` },
      { label: "한도 · 동시 실행", value: "limits", hint: "출력 상한 · 세션 넘기기 · subagent 동시 실행" },
      { label: "설치된 구성요소 보기", value: "components" },
      { label: "자가진단", value: "verify" },
      { label: "종료", value: "exit" },
    ];
    const v = await ui.select("바꿀 항목을 고르세요", menu, { back: false, initial: Math.min(last, menu.length - 1),
      note: c.gray("  항목마다 따로 바꾸고 바로 저장합니다. 순서는 상관없습니다.") });
    last = menu.findIndex((m) => m.value === v);
    if (v === "exit") return 0;
    if (items[v]) await editItem(items[v].title, items[v].run);
    else if (v === "db") await dbMenu();
    else if (v === "ext") await extensionMenu();
    else if (v === "limits") await limitsMenu();
    else if (v === "endpoint") await endpointMenu();
    else if (v === "components") await componentsView();
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
