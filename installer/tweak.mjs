// oxygen-pi-system 종합 설정 (Tweak TUI). 설치된 하네스 폴더에서 실행한다: tweak.cmd / tweak.sh / just tweak
// 이미 설치된 항목을 순서와 상관없이 하나씩 선택해 변경한다 (선택한 항목만 변경하고 바로 저장). 단계 흐름이 아니라 허브다.
//   허브 (줄 입력 모드의 번호. 제목 행은 없고 묶음 사이에 빈 줄만 둔다)
//     1 LLM 연결(하위: 서버 주소·API 키 · 모델 · 요청 설정) · 2 DB 연결(하위: 연결 목록 · SQLcl) · 3 GitLab 연결
//     4 브라우저 · 5 확장 기능 · 6 스킬 · 7 실행 제한
//     8 PATH·바로가기 · 9 상태 점검 · 10 종료 (줄 입력 모드에만. 화면에서는 Esc)
//   쓸 수 없는 항목도 목록에 두고 비활성으로 보인다 (번호가 바뀌지 않게)
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BACK, c, errorBlock, rail } from "./tui.mjs";
import {
  INTEGRATION_NAMES, ROOT, applyIntegrations, applyOptional, fetchModels, stateFromInstall, stepBrowser, stepGitlab, stepIntegrate,
  stepModel, stepSqlcl, stepVllm, sys, ui, writeSiteConfig,
} from "./install.mjs";
import { CATALOG, GROUPS, OPTIONAL, enabledSkills, hasComponent, isInstalled, parseSkillsOff, readLock } from "./components.mjs";
import { DB_TYPES, ID_RE, loadConnections, probeConnection, saveConnections, secretKey } from "./connections.mjs";
import { deleteSecret, getSecret, hasSecret, setSecret } from "./secrets.mjs";

const { parseEnv, mergeEnv, VLLM_EXTRA_PARAMS } = await import(pathToFileURL(join(ROOT, "scripts", "render-config.mjs")).href);
const AGENT = join(ROOT, "agent");
const ENV_FILE = join(AGENT, "oxy.env");
const APPLY_LATER = "pi를 다시 시작하면 적용됩니다";
const saved = (s) => `${c.green("✓")} ${s}`;
const FETCH_FIX = "인터넷 PC에서 번들을 다시 만든 뒤 install.cmd로 업데이트하세요";

/** 위치: 설정 + 항목 조각들 (오른쪽에 설치 폴더) */
const setPath = (...parts) => ui.setFrame({ path: ["설정", ...parts], right: ROOT });
const readEnv = () => { const text = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : ""; return { text, env: parseEnv(text) }; };

// ------------------------------------------------------------------ DB 연결
function describe(conn) {
  const t = DB_TYPES[conn.type];
  const where = conn.type === "sqlite" ? conn.file : `${conn.host}:${conn.port ?? t.port}/${conn.database ?? ""}`;
  return `${t.label.replace(" (파일)", "")} · ${where}`;
}

/** 연결의 나머지 정보 (관련 정보 · 요약표용): 등록한 곳 · 권한 · 비밀번호 */
function connInfo(conn) {
  return [
    ["등록", [conn.usql && "usql", conn.dbhub && "dbhub"].filter(Boolean).join(", ") || "사용 안 함"],
    ["권한", conn.readonly !== false ? "읽기 전용" : "쓰기 허용"],
    conn.type === "sqlite" ? null : ["비밀번호", hasSecret(AGENT, secretKey(conn.id)) ? "저장됨" : "저장 안 함"],
  ].filter(Boolean);
}

/** dbhub 는 연결이 하나면 execute_sql, 여러 개면 execute_sql_<id> 로 도구 이름을 만든다 */
function dbhubTool(conn, tool) {
  const many = loadConnections(AGENT).filter((x) => x.dbhub).length > 1;
  return `mcp__dbhub__${tool}${many ? "_" + conn.id.replace(/-/g, "_") : ""}`;
}

function usage(conn) {
  return rail([
    conn.usql ? ["usql", `usql ${conn.id} -w -q --csv -c "select ..."`] : null,
    conn.dbhub ? ["dbhub", `pi 도구 ${dbhubTool(conn, "execute_sql")}, ${dbhubTool(conn, "search_objects")}`] : null,
    ["적용", "실행 중인 pi에는 /reload로 적용됩니다"],
  ], { indent: 4 });
}

/** existing: 편집할 기존 연결 (없으면 새 연결), draft: "다시 입력" 때 이어 쓸 값 → 저장했으면 연결 */
async function editConnection(conns, existing, draft) {
  const hasUsql = hasComponent("usql", ROOT);
  const hasDbhub = hasComponent("dbhub", ROOT);
  const conn = draft ? { ...draft } : existing ? { ...existing } : {};
  setPath("DB 연결", existing ? existing.id : "새 연결");

  if (!existing && !draft) {
    const type = await ui.select("DB 종류를 선택하세요", Object.entries(DB_TYPES).map(([k, t]) => ({ label: t.label, value: k })), { initial: 0 });
    if (type === BACK) return null;
    conn.type = type;
    const id = await ui.input("연결 이름", {
      note: ["영문 소문자로 시작하고 소문자, 숫자, -, _ 만 사용할 수 있습니다 (31자 이내).", "usql에서는 usql <이름>, dbhub 도구 이름에는 execute_sql_<이름>으로 사용됩니다."],
      validate: (v) => (!ID_RE.test(v) ? "소문자로 시작하고 소문자, 숫자, -, _ 만 사용할 수 있습니다 (31자 이내)"
        : conns.some((x) => x.id === v) ? "이미 사용 중인 이름입니다. 다른 이름을 입력하세요" : null),
    });
    if (id === BACK) return null;
    conn.id = id;
  }
  const t = DB_TYPES[conn.type];

  if (conn.type === "sqlite") {
    const f = await ui.input("SQLite 파일 경로", {
      initial: conn.file ?? "", note: "예: C:\\work\\app.db",
      validate: (v) => (!v ? "값을 입력하세요" : !isAbsolute(v) ? "드라이브 문자부터 전체 경로를 입력하세요. 예: C:\\work\\app.db"
        : !existsSync(v) ? "파일을 찾을 수 없습니다. 탐색기의 \"경로로 복사\"로 복사해 붙여넣으세요" : null),
    });
    if (f === BACK) return null;
    conn.file = resolve(f).replace(/\\/g, "/");
  } else {
    const host = await ui.input("호스트", { initial: conn.host ?? "", note: `${t.label} 서버의 호스트 이름이나 IP입니다. 예: db.example.internal`,
      validate: (v) => (/^[A-Za-z0-9._-]+$/.test(v) ? null : "호스트 이름이나 IP만 입력하세요. 예: db.example.internal") });
    if (host === BACK) return null;
    const port = await ui.input("포트", { initial: String(conn.port ?? t.port),
      validate: (v) => (/^\d{1,5}$/.test(v) && Number(v) <= 65535 ? null : "숫자만 입력하세요 (1~65535)") });
    if (port === BACK) return null;
    const db = await ui.input(conn.type === "oracle" ? "서비스 이름" : "데이터베이스 이름",
      { initial: conn.database ?? "", note: conn.type === "oracle" ? "예: ORCLPDB1" : "", validate: (v) => (v ? null : "값을 입력하세요") });
    if (db === BACK) return null;
    const user = await ui.input("사용자 이름", { initial: conn.user ?? "", validate: (v) => (v ? null : "값을 입력하세요"), note: "가능하면 읽기 전용 계정을 사용하세요." });
    if (user === BACK) return null;
    Object.assign(conn, { host, port: Number(port), database: db, user });
  }

  // 비밀번호 (DPAPI 로 암호화해 agent/secrets.json 에만 저장)
  let password;      // undefined = 바꾸지 않음, "" = 삭제
  if (conn.type !== "sqlite") {
    const stored = hasSecret(AGENT, secretKey(conn.id));
    let action = "set";
    if (stored) {
      action = await ui.select("저장된 비밀번호를 유지할까요?", [
        { label: "저장된 비밀번호 유지", value: "keep", current: true },
        { label: "새 비밀번호 입력…", value: "set" },
        { label: "저장된 비밀번호 삭제", value: "delete", detail: "이 연결의 저장된 비밀번호를 삭제합니다. 다음 화면에서 한 번 더 확인합니다." },
      ], { initial: 0 });
      if (action === BACK) return null;
      if (action === "delete" && !(await ui.confirm("저장된 비밀번호를 삭제할까요?", {
        title: "비밀번호 삭제", yes: "비밀번호 삭제", no: "삭제 취소", level: "medium", warning: `${conn.id} 연결은 접속할 때마다 비밀번호를 입력해야 합니다.`,
      }))) action = "keep";
    }
    if (action === "set") {
      const pw = await ui.input("비밀번호", {
        mask: true, note: "Windows DPAPI로 암호화해 이 PC의 현재 사용자만 풀 수 있게 저장합니다. 비워 두면 저장하지 않습니다.",
      });
      if (pw === BACK) return null;
      password = pw;
    } else if (action === "delete") password = "";
  }

  const ro = await ui.select("이 연결의 권한을 선택하세요", [
    { label: "읽기 전용", value: true, recommended: true, hint: "dbhub가 SELECT, SHOW, EXPLAIN만 허용" },
    { label: "쓰기 허용", value: false, hint: "변경 SQL은 실행 전에 사용자 확인을 받음" },
  ], { initial: conn.readonly === false ? 1 : 0 });
  if (ro === BACK) return null;
  conn.readonly = ro;

  const targets = [
    ...(hasUsql ? [{ label: "usql", value: "usql", checked: conn.usql ?? true, hint: "터미널에서 SQL 조회 (sql-querying 스킬)" }] : []),
    ...(hasDbhub ? [{ label: "dbhub", value: "dbhub", checked: conn.dbhub ?? true, hint: "에이전트용 DB 도구 (execute_sql, search_objects)" }] : []),
  ];
  const picked = targets.length > 1 ? await ui.multiselect("이 연결을 어디에 등록할까요?", targets) : targets.map((x) => x.value);
  if (picked === BACK) return null;
  conn.usql = picked.includes("usql");
  conn.dbhub = picked.includes("dbhub");

  // 연결 테스트 (usql 이 있으면)
  if (hasUsql && await ui.confirm("지금 연결을 테스트할까요?", { yes: "연결 테스트", no: "테스트 없이 저장", recommended: true, note: "usql로 간단한 조회(select 1)를 실행합니다." })) {
    ui.screen(`  ${c.bold("연결을 테스트하는 중입니다")}\n`);
    let r;
    try {
      r = await probe(conn, password !== undefined ? password : undefined);
    } catch { r = null; }
    if (!r) {
      const go = await ui.select("연결하지 못했습니다. 어떻게 할까요?", [
        { label: "연결 정보 다시 입력", value: "again" },
        { label: "연결 정보만 저장", value: "save" },
        { label: "저장하지 않고 목록으로", value: "cancel" },
      ], { back: false, initial: 0 });
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
  // 연결 사용법(도구 이름)은 읽어야 쓸 수 있으므로 Enter 를 기다린다
  ui.screen([`  ${c.green("✓")} ${c.bold(`${conn.id} 연결을 저장했습니다`)}  ${c.gray(describe(conn))}`, "", ...usage(conn)].join("\n"));
  await ui.pause();
  return conn;
}

/** usql 로 select 1 → "성공" (실패하면 원인 · 해결을 보이고 던진다) */
function probe(conn, password) {
  return ui.task(`${conn.id} 접속`, async () => {
    const res = probeConnection(ROOT, AGENT, conn, password ?? getSecret(AGENT, secretKey(conn.id)));
    if (!res.ok) {
      const last = String(res.output ?? "").trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "응답 없음";
      throw Object.assign(new Error(res.output), { why: last, fix: "호스트, 포트, 사용자, 비밀번호를 확인하세요" });
    }
    return "성공";
  });
}

async function dbMenu() {
  let msg = "";
  let last = null;
  for (;;) {
    setPath("DB 연결");
    const hasUsql = hasComponent("usql", ROOT);
    const hasDbhub = hasComponent("dbhub", ROOT);
    const conns = loadConnections(AGENT);
    const opts = [
      ...conns.map((x) => ({ label: x.id, value: x.id, hint: describe(x),
        detail: "이 연결을 편집하거나 테스트하거나 삭제합니다.", info: connInfo(x) })),
      { label: "+ 새 연결 추가…", value: "__add", gap: conns.length > 0, disabled: !hasUsql && !hasDbhub ? "사용 불가" : false,
        why: "usql과 dbhub가 모두 번들에 없어 연결을 추가할 수 없습니다.", fix: `${FETCH_FIX}.`, detail: "다음 화면부터 DB 종류, 이름, 접속 정보를 입력합니다." },
      { label: "SQLcl", value: "__sqlcl", hint: `${isInstalled("sqlcl", ROOT) ? "설치됨" : "설치 안 됨"} · Oracle 전용 CLI`,
        detail: "직접 받은 zip 파일로 SQLcl을 설치하거나 교체합니다." },
      { label: "← 이전", value: "__back", lineOnly: true },
    ];
    const k = opts.findIndex((o) => o.value === last);
    const v = await ui.select("어떤 DB 연결을 변경할까요?", opts, {
      ...(k >= 0 ? { initial: k } : {}), message: msg,
      note: conns.length ? "연결은 usql과 dbhub에서 이름으로 사용합니다."
        : "등록된 연결이 없습니다. 새 연결을 추가하면 usql과 dbhub에서 이름으로 사용할 수 있습니다.",
    });
    msg = "";
    if (v === BACK || v === "__back") return "";
    last = v;
    if (v === "__add") { const r = await editConnection(conns); if (r) last = r.id; continue; }
    if (v === "__sqlcl") {
      setPath("DB 연결", "SQLcl");
      msg = await editItem("SQLcl", (state) => stepSqlcl(state));
      continue;
    }
    const conn = conns.find((x) => x.id === v);
    setPath("DB 연결", conn.id);
    const act = await ui.select(`${conn.id} 연결에서 할 작업을 선택하세요`, [
      { label: "편집…", value: "edit", detail: "접속 정보, 권한, 등록할 곳을 다시 입력합니다. 현재 값이 기본값입니다." },
      { label: "연결 테스트", value: "probe", disabled: hasUsql ? false : "사용 불가", why: "usql이 설치되지 않아 테스트할 수 없습니다.", fix: `${FETCH_FIX}.`,
        detail: "usql로 select 1을 실행합니다. 설정은 변경되지 않습니다." },
      { label: "삭제…", value: "delete", detail: "이 연결을 삭제합니다. 다음 화면에서 한 번 더 확인합니다." },
      { label: "← 이전", value: "back", lineOnly: true },
    ], { initial: 0, summary: [["연결 정보", describe(conn)], ...connInfo(conn)] });
    if (act === BACK) continue;
    if (act === "edit") await editConnection(conns, conn);
    else if (act === "probe") {
      ui.screen(`  ${c.bold("연결을 테스트하는 중입니다")}\n`);
      try { await probe(conn); } catch { /* 원인 · 해결 방법은 task 가 출력 */ }
      await ui.pause();
    } else if (act === "delete") {
      if (await ui.confirm(`${conn.id} 연결을 삭제할까요?`, {
        title: "연결 삭제", yes: `${conn.id} 연결 삭제`, no: "삭제 취소", level: "medium",
        summary: [["연결 정보", describe(conn)], ["삭제 대상", "연결 정보, 저장된 비밀번호, usql·dbhub 등록"]],
        warning: "삭제한 뒤에 다시 쓰려면 같은 값으로 새로 추가해야 합니다.",
      })) {
        deleteSecret(AGENT, secretKey(conn.id));
        saveConnections(ROOT, AGENT, conns.filter((x) => x.id !== conn.id));
        msg = saved(`${conn.id} 연결을 삭제했습니다. 실행 중인 pi에는 /reload로 적용됩니다.`);
        last = null;
      }
    }
  }
}

// ------------------------------------------------------------------ 확장 기능 (extension)
const EXTENSIONS = [
  // label: 기능 이름 · hint: 하는 일 한 줄 · off: 껐을 때의 결과 (설명 문장) · id: 내부 이름 (관련 정보 · 도움말에만 보인다)
  { key: "OXY_BASH_GUARD", id: "oxy-bash-guard", label: "위험 명령 차단", hint: "쓰기 작업은 확인 후 실행", off: "끄면 위험 명령 차단과 쓰기 작업 확인이 사라집니다." },
  { key: "OXY_READ_BEFORE_EDIT", id: "oxy-read-before-edit", label: "읽지 않은 파일 수정 차단", hint: "파일을 읽은 뒤에만 수정 허용", off: "끄면 읽지 않은 파일도 바로 수정할 수 있습니다." },
  { key: "OXY_LOOP_GUARD", id: "oxy-loop-guard", label: "반복 호출 차단", hint: "같은 호출이 반복되면 중단", off: "끄면 같은 호출이 반복되어도 중단하지 않습니다." },
  { key: "OXY_CONTEXT_BUDGET", id: "oxy-context-budget", label: "긴 출력 자동 축약", hint: "컨텍스트 사용률 표시", off: "끄면 긴 명령 출력이 그대로 컨텍스트에 들어갑니다." },
  { key: "OXY_FLOW", id: "oxy-flow", label: "작업 기록", hint: "대화 요약 대신 작업 상태 기록", off: "끄면 작업 기록과 결정 기록이 남지 않습니다." },
  { key: "OXY_FLOW_ROLLOVER", id: "oxy-flow", label: "세션 자동 전환", hint: "컨텍스트가 차면 새 세션에서 계속", off: "끄면 컨텍스트가 차도 같은 세션을 계속 사용합니다." },
  { key: "OXY_JOBS", id: "oxy-jobs", label: "백그라운드 작업", hint: "subagent와 작업 패널", off: "끄면 백그라운드 작업과 subagent를 사용할 수 없습니다." },
  { key: "OXY_VLLM_METRICS", id: "oxy-jobs", label: "LLM 서버 혼잡 감지", hint: "기본값은 꺼짐", defaultOff: true, off: "끄면 subagent를 시작하기 전에 서버 부하를 확인하지 않습니다." },
];
const isOn = (env, e) => (e.defaultOff ? /^(on|1|true)$/i.test(env[e.key] ?? "") : !/^(off|0|false)$/i.test(env[e.key] ?? ""));

async function extensionMenu() {
  setPath("확장 기능");
  const { text, env } = readEnv();
  const on = await ui.multiselect("사용할 확장 기능을 선택하세요", EXTENSIONS.map((e) => ({
    label: e.label, value: e.key, hint: e.hint, checked: isOn(env, e),
    detail: e.off, info: [["확장 이름", e.id], ["설정 변수", e.key]],
  })), { enter: "저장", note: "끄면 소형 모델의 실수를 막는 장치가 사라집니다. 특별한 이유가 없으면 켜 두세요." });
  if (on === BACK) return "";
  const updates = Object.fromEntries(EXTENSIONS.map((e) => [e.key, on.includes(e.key) ? "on" : "off"]));
  writeFileSync(ENV_FILE, mergeEnv(text, updates));
  return saved(`확장 기능을 저장했습니다 (${EXTENSIONS.length}개 중 ${on.length}개 사용). ${APPLY_LATER}.`);
}

// ------------------------------------------------------------------ 실행 제한
const LIMITS = [
  // why: 이 값이 하는 일 한 문장 (포커스했을 때의 설명 · 입력 화면의 맥락)
  { key: "OXY_TOOL_OUTPUT_MAX_CHARS", label: "명령 출력 최대 길이", def: 12000, fmt: (v) => `${v}자`, tech: "bash, grep, find", why: "명령 출력이 이 길이를 넘으면 줄여서 전달합니다." },
  { key: "OXY_READ_MAX_CHARS", label: "파일 읽기 최대 길이", def: 40000, fmt: (v) => `${v}자`, tech: "read", why: "파일을 읽을 때 한 번에 전달하는 최대 길이입니다." },
  { key: "OXY_REPEAT_LIMIT", label: "반복 호출 허용 횟수", def: 3, fmt: (v) => `${v}회`, why: "같은 호출이 이 횟수에 이르면 차단합니다." },
  { key: "OXY_FLOW_ROLLOVER_PCT", label: "세션 자동 전환 기준", def: 50, fmt: (v) => `컨텍스트 ${v}%`, why: "컨텍스트 사용률이 이 값 이상이면 새 세션에서 이어서 처리합니다." },
  { key: "OXY_LLM_MAX_CONCURRENT", label: "subagent 동시 실행 수", def: 2, fmt: (v) => `${v}개`, tech: "subagent", why: "LLM 서버(vLLM)의 KV 캐시를 고려해 정합니다." },
  { key: "OXY_JOBS_MAX_CONCURRENT", label: "백그라운드 작업 동시 실행 수", def: 4, fmt: (v) => `${v}개`, tech: "bash", why: "동시에 실행할 백그라운드 명령의 수입니다." },
];
const limitValue = (env, l) => (env[l.key] ? `${l.fmt(env[l.key])} (기본값 ${l.def})` : `${l.fmt(l.def)} (기본값)`);

/** 실행 제한: 목록에서 하나를 선택해 그 값만 변경하고 바로 저장 */
async function limitsMenu() {
  let msg = "";
  let last = 0;
  for (;;) {
    setPath("실행 제한");
    const { text, env } = readEnv();
    const k = await ui.select("변경할 값을 선택하세요", [
      ...LIMITS.map((l) => ({ label: l.label, value: l.key, hint: limitValue(env, l),
        detail: l.why ?? "", info: [l.tech ? ["적용 대상", l.tech] : null, ["설정 변수", l.key]].filter(Boolean) })),
      { label: "← 이전", value: "__back", lineOnly: true },
    ], { initial: last, message: msg });
    msg = "";
    if (k === BACK || k === "__back") return "";
    last = LIMITS.findIndex((x) => x.key === k);
    const l = LIMITS[last];
    const v = await ui.input(l.label, { initial: String(env[l.key] || l.def), enter: "저장", note: `기본값은 ${l.def}입니다.${l.why ? ` ${l.why}` : ""}`,
      validate: (s) => (/^\d+$/.test(s) && Number(s) > 0 ? null : "1 이상의 정수를 입력하세요") });
    if (v === BACK) continue;
    writeFileSync(ENV_FILE, mergeEnv(text, { [l.key]: v }));
    msg = saved(`저장했습니다: ${l.label} = ${l.fmt(v)}${Number(v) === l.def ? " (기본값)" : ""}`);
  }
}

// ------------------------------------------------------------------ 설치 항목 (설치 TUI 의 단계를 하나씩 재사용)
function registry() {
  const reg = sys.loadRegistry();
  const registered = Boolean(reg?.installDir && sys.isSameDir(reg.installDir, ROOT));
  return { registered, reg: registered ? reg : { installDir: ROOT, copied: false, gitBash: sys.findGitBash(), integrations: [] } };
}

/** 선택한 항목 하나만 변경하고 바로 저장한다 → 메시지 줄에 보일 결과 (BACK 이면 아무것도 바꾸지 않고 "") */
async function editItem(title, run) {
  const { registered, reg } = registry();
  const state = { ...stateFromInstall(reg), installDir: ROOT, tweak: true };
  const r = await run(state);
  if (r === BACK || r === "cancel") return "";
  ui.screen(`  ${c.bold(`${title} 저장 중입니다`)}\n`);
  try {
    await applyOptional(state);
    await ui.task("설정 파일 생성", async () => `${writeSiteConfig(ROOT, state)}개 파일`);
    if (r === "integrations") {
      await applyIntegrations(state, reg);
      if (registered) sys.saveRegistry({ ...reg, integrations: state.integrations, updatedAt: new Date().toISOString() });
    }
  } catch (e) {
    if (!e?.reported) errorBlock(`저장하지 못했습니다: ${title}`, e).forEach((l) => ui.print(l));
    await ui.pause();
    return "";
  }
  return saved(`${title} 설정을 저장했습니다. ${APPLY_LATER}.`);
}

/** LLM 서버에서 모델 목록을 받아 둔다 (모델 단계에서 고를 수 있게). 실패하면 직접 입력 / 서버 주소부터 */
async function withModels(state) {
  ui.screen(`  ${c.bold("LLM 서버에서 모델 목록을 가져오는 중입니다")}\n  ${c.gray(state.baseUrl ?? "")}\n`);
  try {
    state.models = await ui.task("모델 목록 가져오기 (/v1/models)", async () => fetchModels(state.baseUrl, state.apiKey));
    return "next";
  } catch (e) {
    state.models = [];
    const v = await ui.select("모델 목록을 가져오지 못했습니다. 어떻게 할까요?", [
      { label: "모델 이름 직접 입력", value: "manual" },
      { label: "서버 주소부터 다시 입력", value: "vllm" },
    ], { initial: 0, note: errorBlock("모델 목록을 가져오지 못했습니다", e).map((l) => l.slice(2)), result: true });
    return v === BACK ? BACK : v;
  }
}

const items = {
  vllm: async (state) => {
    const r = await stepVllm(state);
    if (r === BACK) return BACK;
    // 지금 쓰는 모델이 새 서버에 없으면 이어서 모델을 선택한다
    if (state.models?.length && !state.models.some((m) => m.id === state.coder)) {
      await ui.notice("warn", `현재 모델(${state.coder})이 이 서버에 없습니다`, { fix: "다음 화면에서 모델을 다시 선택하세요" });
      return stepModel(state);
    }
    return r;
  },
  model: async (state) => {
    const w = await withModels(state);
    if (w === BACK) return BACK;
    if (w === "vllm") return items.vllm(state);
    return stepModel(state);
  },
  gitlab: (state) => stepGitlab(state),
  browser: (state) => stepBrowser(state),
  integrations: async (state) => {
    const before = [...(state.integrations ?? [])];
    if ((await stepIntegrate(state)) === BACK) return BACK;
    const removed = before.filter((k) => !state.integrations.includes(k));
    if (removed.length && !(await ui.confirm(`${removed.map((k) => INTEGRATION_NAMES[k]).join(", ")} 등록을 해제할까요?`, {
      title: "등록 해제", yes: "등록 해제", no: "해제 취소", level: "medium", warning: "해제하면 그 방법으로는 oxy를 실행할 수 없습니다.",
    }))) return BACK;
    return "integrations";
  },
};

// ------------------------------------------------------------------ LLM 연결 (하위 메뉴)
function endpointHint(env) {
  const drop = String(env.OXY_VLLM_DROP_PARAMS ?? "").split(/[\s,]+/).filter(Boolean);
  if (!drop.length && !env.OXY_PROVIDER_RETRIES && !env.OXY_MAX_OUTPUT_TOKENS) return "기본값";
  return [drop.length ? `제외 파라미터 ${drop.length}개` : null, `재시도 ${env.OXY_PROVIDER_RETRIES || 0}회`].filter(Boolean).join(" · ");
}

async function llmMenu() {
  let msg = "";
  let last = 0;
  for (;;) {
    setPath("LLM 연결");
    const { env } = readEnv();
    const k = Math.round(Number(env.OXY_CONTEXT_WINDOW || 0) / 1024);
    const opts = [
      { label: "서버 주소·API 키", value: "vllm", hint: env.OXY_VLLM_BASE_URL ?? "없음",
        detail: "주소와 키를 다시 입력하고 서버 연결을 확인합니다.",
        info: [["서버 주소", env.OXY_VLLM_BASE_URL ?? "없음"], ["API 키", env.OXY_VLLM_API_KEY && env.OXY_VLLM_API_KEY !== "EMPTY" ? "입력됨" : "없음"]] },
      { label: "모델", value: "model", hint: `${env.OXY_MODEL_CODER ?? "없음"}${env.OXY_MODEL_GENERAL ? " 외 1개" : ""}`,
        detail: "코딩 모델, 범용 모델, 컨텍스트 길이, 모델 계열을 변경합니다.",
        info: [["코딩 모델", env.OXY_MODEL_CODER ?? "없음"], ["범용 모델", env.OXY_MODEL_GENERAL || "사용 안 함"], ["컨텍스트", `${k}K 토큰`]] },
      { label: "요청 설정", value: "endpoint", hint: endpointHint(env),
        detail: "제외할 요청 파라미터, 재시도 횟수, 응답 최대 길이를 변경합니다.",
        info: [["응답 최대 길이", env.OXY_MAX_OUTPUT_TOKENS ? `${env.OXY_MAX_OUTPUT_TOKENS} 토큰` : "모델 기본값"]] },
      { label: "← 이전", value: "__back", lineOnly: true },
    ];
    const v = await ui.select("LLM 연결에서 변경할 항목을 선택하세요", opts, { initial: last, message: msg,
      note: "서버 주소를 변경하면 현재 모델이 새 서버에 있는지 이어서 확인합니다." });
    msg = "";
    if (v === BACK || v === "__back") return "";
    last = opts.findIndex((o) => o.value === v);
    if (v === "vllm") { setPath("LLM 연결", "서버 주소·API 키"); msg = await editItem("서버 주소·API 키", items.vllm); }
    else if (v === "model") { setPath("LLM 연결", "모델"); msg = await editItem("모델", items.model); }
    else if (v === "endpoint") msg = await endpointMenu();
  }
}

/** 요청 설정: 값 하나씩 변경하고 바로 설정(models.json · settings.json)을 다시 만든다 */
async function endpointMenu() {
  let msg = "";
  let last = 0;
  for (;;) {
    setPath("LLM 연결", "요청 설정");
    const { text, env } = readEnv();
    const drop = String(env.OXY_VLLM_DROP_PARAMS ?? "").split(/[\s,]+/).filter(Boolean);
    const opts = [
      { label: "제외할 요청 파라미터", value: "drop", hint: drop.join(", ") || "없음",
        detail: "서버가 거부하는 파라미터(top_k 등)를 요청에서 제외합니다.", info: [["설정 변수", "OXY_VLLM_DROP_PARAMS"]] },
      { label: "재시도 횟수", value: "retries", hint: `${env.OXY_PROVIDER_RETRIES || 0}회`,
        detail: "서버가 요청을 거부하면(HTTP 429 등) 기다렸다가 다시 보냅니다.", info: [["설정 변수", "OXY_PROVIDER_RETRIES"]] },
      { label: "응답 최대 길이", value: "maxout", hint: env.OXY_MAX_OUTPUT_TOKENS ? `${env.OXY_MAX_OUTPUT_TOKENS} 토큰` : "모델 기본값",
        detail: "응답의 최대 토큰 수를 제한합니다.", info: [["설정 변수", "OXY_MAX_OUTPUT_TOKENS"]] },
      { label: "← 이전", value: "__back", lineOnly: true },
    ];
    const k = await ui.select("변경할 값을 선택하세요", opts, { initial: last, message: msg,
      note: "서버 주소·API 키 항목에서 서버를 확인해 자동으로 정하는 값입니다. 사용량 제한이 있는 서버에 직접 맞출 때 변경하세요." });
    msg = "";
    if (k === BACK || k === "__back") return "";
    last = opts.findIndex((o) => o.value === k);
    let updates = null;
    if (k === "drop") {
      const v = await ui.multiselect("요청에서 제외할 파라미터를 선택하세요", VLLM_EXTRA_PARAMS.map((p) => ({ label: p, value: p, checked: drop.includes(p),
        hint: p === "chat_template_kwargs" ? "Qwen thinking 켜고 끄기" : p === "reasoning_effort" ? "gpt-oss 추론 강도" : "vLLM 샘플링 확장" })),
      { enter: "저장", note: "서버가 거부하는 파라미터만 선택하세요. 선택한 파라미터는 요청에 넣지 않습니다." });
      if (v !== BACK) updates = { OXY_VLLM_DROP_PARAMS: v.join(",") };
    } else if (k === "retries") {
      // 0 으로 저장하면 값이 빈칸으로 남는다. 빈칸도 0 으로 보인다
      const v = await ui.input("재시도 횟수", { initial: env.OXY_PROVIDER_RETRIES || "0", enter: "저장",
        note: "HTTP 429 등에서 서버가 알려 준 시간만큼 기다렸다가 다시 보냅니다. 사내 vLLM은 보통 0입니다.",
        validate: (s) => (/^\d{1,2}$/.test(s) ? null : "0~99 사이의 숫자를 입력하세요") });
      if (v !== BACK) updates = { OXY_PROVIDER_RETRIES: v === "0" ? "" : v };
    } else if (k === "maxout") {
      const v = await ui.input("응답 최대 길이 (토큰)", { initial: env.OXY_MAX_OUTPUT_TOKENS ?? "", enter: "저장",
        note: "비워 두면 모델 기본값을 사용합니다. 분당 출력 토큰 제한보다 작게 설정하세요.",
        validate: (s) => (s === "" || (/^\d+$/.test(s) && Number(s) >= 256) ? null : "256 이상의 숫자를 입력하거나 비워 두세요") });
      if (v !== BACK) updates = { OXY_MAX_OUTPUT_TOKENS: v };
    }
    if (!updates) continue;
    writeFileSync(ENV_FILE, mergeEnv(text, updates));
    const { reg } = registry();
    try {
      writeSiteConfig(ROOT, { ...stateFromInstall(reg), installDir: ROOT });
      msg = saved(`${opts[last].label} 설정을 저장했습니다. ${APPLY_LATER}.`);
    } catch (e) {
      await ui.notice("err", `설정 파일을 만들지 못했습니다: ${e.message}`, { fix: "agent/oxy.env의 값을 확인한 뒤 다시 저장하세요" });
    }
  }
}

// ------------------------------------------------------------------ 스킬 (켜기/끄기)
/** 스킬 이름 → 하는 일 한 줄 (값 열에 보인다. 레이블은 스킬 이름 그대로) */
const SKILL_NAMES = {
  "find-code": "코드와 파일 찾기", "json-querying": "JSON 조회와 가공", "project-task-running": "프로젝트 명령 실행",
  "http-api-testing": "HTTP API 테스트", "terminal-session-control": "터미널 세션 제어", "gitlab-workflow": "GitLab 작업",
  "github-workflow": "GitHub 작업", "structural-code-search": "구문 기반 코드 검색", "code-graph-search": "코드 그래프 탐색",
  "web-page-automation": "웹 페이지 조작", "web-page-reading": "웹 페이지 읽기", "sql-querying": "SQL 조회", "oracle-db-querying": "Oracle DB 조회 (SQLcl)",
};

/** 계층별 skill 행. 제목 행에는 그 계층의 구성요소·버전 (설치된 구성요소 보기를 겸한다) */
function skillRows(env) {
  const lib = join(ROOT, "agent", "skill-library");
  const managed = new Set(existsSync(lib) ? readdirSync(lib, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : []);
  const off = parseSkillsOff(env.OXY_SKILLS_OFF);
  const lock = readLock(ROOT);
  const rows = [];
  const seen = new Set();
  for (const [group, g] of Object.entries(GROUPS)) {
    const members = [...lock.filter((x) => x.group === group && CATALOG[x.name]).map((x) => ({ name: x.name, version: x.version })),
      ...Object.entries(CATALOG).filter(([, x]) => x.external && x.group === group).map(([name]) => ({ name, version: "" }))];
    const skills = [];
    for (const m of members) {
      for (const s of CATALOG[m.name].skills ?? []) {
        if (!managed.has(s) || seen.has(s)) continue;
        seen.add(s);
        skills.push(s);
      }
    }
    if (!skills.length) continue;
    const desc = members.filter((m) => CATALOG[m.name].kind !== "engine" || hasComponent(m.name, ROOT)).map((m) => {
      const t = m.name === "sqlcl" ? "SQLcl" : m.name;
      if (hasComponent(m.name, ROOT)) return `${t} ${m.version}`.trim();
      return `${t} ${OPTIONAL[m.name] ? "설치 안 됨" : "반입 안 됨"}`;
    }).join(" · ");
    rows.push({ header: g.title, desc });
    for (const s of skills) {
      const providers = Object.entries(CATALOG).filter(([, x]) => x.skills?.includes(s)).map(([n]) => n);
      const have = providers.filter((n) => hasComponent(n, ROOT));
      const techs = providers.map((n) => (n === "sqlcl" ? "SQLcl" : n)).join(" · ");
      const row = { label: s, value: s, hint: SKILL_NAMES[s] ?? "", checked: have.length > 0 && !off.includes(s),
        detail: "이 도구를 사용하는 방법을 에이전트에게 알려 줍니다.", info: [["필요한 도구", techs.replaceAll(" · ", ", ")]] };
      if (!have.length) {
        const p = providers[0];
        Object.assign(row, {
          disabled: CATALOG[p].external || !OPTIONAL[p] ? "반입 안 됨" : "설치 안 됨",
          why: `필요한 도구(${p === "sqlcl" ? "SQLcl" : p})가 설치되지 않아 사용할 수 없습니다.`,
          fix: p === "sqlcl" ? "설정의 DB 연결에서 SQLcl을 설치하세요."
            : CATALOG[p].external ? `${p}.exe를 vendor/${p}/에 넣고 번들을 다시 만드세요.` : `${FETCH_FIX}.`,
        });
      } else if (s === "web-page-automation" && env.OXY_BROWSER === "none") {
        Object.assign(row, { disabled: "브라우저 사용 안 함", why: "브라우저가 \"사용 안 함\"으로 설정되어 있습니다.", fix: "설정의 브라우저에서 브라우저를 선택하세요." });
      }
      rows.push(row);
    }
  }
  return rows;
}

async function skillsMenu() {
  setPath("스킬");
  const { text, env } = readEnv();
  const rows = skillRows(env);
  const list = rows.filter((r) => !r.header);
  if (!list.length) { await ui.notice("warn", "사용할 수 있는 스킬이 없습니다"); return ""; }
  const on = await ui.multiselect("사용할 스킬을 선택하세요", rows, {
    enter: "저장", note: "설치된 구성요소의 스킬만 사용할 수 있습니다. 끈 스킬은 업데이트해도 꺼진 상태로 유지됩니다.",
  });
  if (on === BACK) return "";
  // 사용자가 끈 것만 적는다. 지금 고를 수 없는 skill 의 기존 설정은 그대로 둔다
  const prevOff = parseSkillsOff(env.OXY_SKILLS_OFF);
  const off = [...new Set([...prevOff.filter((s) => list.find((r) => r.value === s)?.disabled || !list.find((r) => r.value === s)),
    ...list.filter((r) => !r.disabled && !on.includes(r.value)).map((r) => r.value)])];
  writeFileSync(ENV_FILE, mergeEnv(text, { OXY_SKILLS_OFF: off.join(",") }));
  ui.screen(`  ${c.bold("스킬을 적용하는 중입니다")}\n`);
  const { reg } = registry();
  try {
    await ui.task("스킬 동기화", async () => { writeSiteConfig(ROOT, { ...stateFromInstall(reg), installDir: ROOT }); return ""; });
  } catch (e) {
    if (!e?.reported) errorBlock("스킬을 저장하지 못했습니다", e).forEach((l) => ui.print(l));
    await ui.pause();
    return "";
  }
  return saved(`스킬을 저장했습니다 (${list.length}개 중 ${on.length}개 사용). ${APPLY_LATER}.`);
}

// ------------------------------------------------------------------ 상태 점검
async function verifyNow() {
  setPath("상태 점검");
  const reg = sys.loadRegistry();
  const gitBash = reg?.gitBash && existsSync(reg.gitBash) ? reg.gitBash : sys.findGitBash();
  // 출력이 길어 본 화면에서 실행한다 (결과가 스크롤백에 남는다)
  const passed = await ui.outside(() => sys.runVerify(ROOT, gitBash), { title: "상태 점검 (verify)" });
  return passed ? saved("상태 점검을 통과했습니다.") : `${c.yellow("!")} 상태 점검에서 문제가 발견되었습니다 (FAIL 또는 WARN).`;
}

// ------------------------------------------------------------------ 허브
const BROWSER_NAMES = { "chrome-for-testing": "Chrome for Testing", chromium: "Chromium", obscura: "obscura",
  edge: "Microsoft Edge", "chrome-system": "Google Chrome", none: "사용 안 함" };
const hostOf = (u) => { try { return new URL(u).host; } catch { return u || "없음"; } };

function hubRows() {
  const { env } = readEnv();
  const { reg } = registry();
  const conns = loadConnections(AGENT);
  const skills = skillRows(env).filter((r) => !r.header);
  const skillsOn = enabledSkills(ROOT, { browser: env.OXY_BROWSER, off: env.OXY_SKILLS_OFF });
  const limit = (key) => env[key] || LIMITS.find((l) => l.key === key).def;
  const hasBrowser = hasComponent("agent-browser", ROOT);
  const k = Math.round(Number(env.OXY_CONTEXT_WINDOW || 0) / 1024);
  const extOff = EXTENSIONS.filter((e) => !isOn(env, e)).map((e) => e.label);
  const skillsOff = skills.filter((r) => !skillsOn.has(r.value)).map((r) => r.value);
  const has = (x) => (reg.integrations ?? []).includes(x);
  const registered = (reg.integrations ?? []).map((x) => ({ path: "PATH", wt: "Windows Terminal", shortcut: "바탕화면" })[x]);
  const mark = (on) => (on ? "등록됨" : "등록 안 됨");
  // 목록에는 레이블과 현재 값만. 설명(detail)과 관련 정보(info)는 포커스한 항목의 상세 패널에 보인다. gap = 묶음이 바뀌는 곳
  return [
    { label: "LLM 연결", value: "llm", hint: `${hostOf(env.OXY_VLLM_BASE_URL)} · ${env.OXY_MODEL_CODER ?? "모델 없음"}${env.OXY_MODEL_GENERAL ? " 외 1개" : ""}`,
      detail: "서버 주소, API 키, 모델을 변경합니다.",
      info: [["서버", env.OXY_VLLM_BASE_URL ?? "없음"], ["코딩 모델", env.OXY_MODEL_CODER ?? "없음"], ["범용 모델", env.OXY_MODEL_GENERAL || "사용 안 함"], ["컨텍스트", `${k}K 토큰`]] },
    { label: "DB 연결", value: "db", hint: conns.length ? `${conns.length}개 (${conns.map((x) => x.id).join(", ")})` : "없음",
      detail: "에이전트가 조회할 DB 연결을 추가하거나 수정합니다.",
      info: [...conns.map((x) => [x.id, describe(x)]), ["SQLcl", isInstalled("sqlcl", ROOT) ? "설치됨" : "설치 안 됨"]] },
    { label: "GitLab 연결", value: "gitlab", hint: env.GITLAB_HOST || "없음", detail: "GitLab 서버 주소를 변경합니다.",
      info: [["호스트", env.GITLAB_HOST || "사용 안 함"], ["토큰 등록", "glab auth login"]] },
    { label: "브라우저", value: "browser", gap: true, hint: BROWSER_NAMES[env.OXY_BROWSER] ?? env.OXY_BROWSER ?? "없음",
      disabled: hasBrowser ? false : "사용 불가", why: "agent-browser가 설치되지 않아 사용할 수 없습니다.", fix: `${FETCH_FIX}.`,
      detail: "웹 페이지 자동화(agent-browser)에 사용할 브라우저를 선택합니다.",
      info: [["브라우저", BROWSER_NAMES[env.OXY_BROWSER] ?? env.OXY_BROWSER ?? "없음"], env.OXY_BROWSER_PATH ? ["경로", env.OXY_BROWSER_PATH] : null,
        ["사용하는 스킬", "web-page-automation"]].filter(Boolean) },
    { label: "확장 기능", value: "ext", hint: `${EXTENSIONS.length}개 중 ${EXTENSIONS.length - extOff.length}개 사용`,
      detail: "위험 명령 차단 같은 확장 기능을 켜거나 끕니다.",
      info: [["사용 중", `${EXTENSIONS.length - extOff.length}개`], ["꺼짐", extOff.join(", ") || "없음"]] },
    { label: "스킬", value: "skills", hint: `${skills.length}개 중 ${skills.length - skillsOff.length}개 사용`,
      detail: "에이전트가 사용할 스킬을 켜거나 끕니다.",
      info: [["사용 중", `${skills.length - skillsOff.length}개`], ["꺼짐", skillsOff.join(", ") || "없음"]] },
    { label: "실행 제한", value: "limits", hint: `출력 ${Number(limit("OXY_TOOL_OUTPUT_MAX_CHARS")).toLocaleString("en-US")}자 · 동시 실행 ${limit("OXY_LLM_MAX_CONCURRENT")}개`,
      detail: "출력 길이, 반복 호출 횟수, 동시 실행 수의 제한 값을 변경합니다.",
      info: LIMITS.map((l) => [l.label, l.fmt(Number(limit(l.key)).toLocaleString("en-US"))]) },
    { label: "PATH·바로가기", value: "integrations", gap: true, hint: registered.join(", ") || "없음",
      detail: "PATH 등록, Windows Terminal 프로필, 바탕화면 바로가기를 관리합니다.",
      info: [["PATH", mark(has("path"))], ["Windows Terminal 프로필", mark(has("wt"))], ["바탕화면 바로가기", mark(has("shortcut"))]] },
    { label: "상태 점검", value: "verify", detail: ["도구, 설정, LLM 연결이 정상인지 확인합니다.", "설정은 변경되지 않습니다."],
      info: [["소요 시간", "약 30초"], ["결과 위치", "화면을 잠시 나가 터미널에 출력"]] },
    // 줄 입력 모드에만 있다 (화면에서는 Esc 가 종료)
    { label: "종료", value: "exit", lineOnly: true },
  ];
}

async function main() {
  ui.interruptNote = () => "중단되었습니다. 현재 항목은 저장되지 않았습니다.\n이전에 저장한 항목은 그대로 유지됩니다.";
  if (!existsSync(ENV_FILE)) {
    setPath();
    ui.screen([`  ${c.bold("설정을 열 수 없습니다")}`, "",
      ...errorBlock("아직 설치되지 않았습니다", { cause: "agent/oxy.env 파일이 없습니다", fix: "이 폴더에서 install.cmd를 먼저 실행하세요" })].join("\n"));
    await ui.pause("종료");
    return 1;
  }
  ui.intro();
  let last = 0;
  let msg = "";
  for (;;) {
    setPath();
    const rows = hubRows();
    const v = await ui.select("어떤 설정을 변경할까요?", rows, { back: true, esc: "종료", initial: last, message: msg });
    msg = "";
    if (v === BACK || v === "exit") return 0;
    last = rows.findIndex((o) => o.value === v);
    if (v === "llm") msg = await llmMenu();
    else if (v === "db") msg = await dbMenu();
    else if (v === "gitlab") { setPath("GitLab 연결"); msg = await editItem("GitLab 연결", items.gitlab); }
    else if (v === "browser") { setPath("브라우저"); msg = await editItem("브라우저", items.browser); }
    else if (v === "ext") msg = await extensionMenu();
    else if (v === "skills") msg = await skillsMenu();
    else if (v === "limits") msg = await limitsMenu();
    else if (v === "integrations") { setPath("PATH·바로가기"); msg = await editItem("PATH·바로가기", items.integrations); }
    else if (v === "verify") msg = await verifyNow();
  }
}

await ui.run(main);
