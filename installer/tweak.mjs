// oxygen-pi-system 종합 설정 (Tweak TUI). 설치된 하네스 폴더에서 실행한다: tweak.cmd / tweak.sh / just tweak
// 이미 설치된 항목을 순서와 상관없이 하나씩 골라 바꾼다 (고른 항목만 바꾸고 바로 저장). 단계 흐름이 아니라 허브다.
//   허브 10개 (docs/tui-spec.md §11.3)
//     연결         1 LLM 연결(하위: 서버 주소·API 키 · 모델 · 요청 조정) · 2 DB 연결(하위: 연결 목록 · Oracle 전용 조회)
//                  3 GitLab 연결 · 4 웹 페이지 자동화
//     에이전트 동작 5 보조 기능(extension) · 6 도구 사용법(skill) · 7 작업 한도
//     이 PC        8 실행 등록 · 9 동작 시험 · 10 종료
//   쓸 수 없는 항목은 목록에서 빼지 않고 비활성으로 보인다 (번호가 바뀌지 않게)
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
const APPLY_LATER = "실행 중인 pi 는 다시 시작하면 적용됩니다";
const saved = (s) => `${c.green("✔")} ${s}`;
const FETCH_FIX = "인터넷 PC 에서 fetch 로 받아 다시 번들링한 뒤 install.cmd 로 업데이트하세요";

/** 프레임 2행: 종합 설정 (Tweak) › 항목 (1행 오른쪽에 설치 폴더) */
const setPath = (sub) => ui.setFrame({ path: sub ? `종합 설정 (Tweak) › ${sub}` : "종합 설정 (Tweak) · 항목마다 바로 저장", right: ROOT });
const readEnv = () => { const text = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : ""; return { text, env: parseEnv(text) }; };

// ------------------------------------------------------------------ DB 연결
function describe(conn) {
  const t = DB_TYPES[conn.type];
  const where = conn.type === "sqlite" ? conn.file : `${conn.host}:${conn.port ?? t.port}/${conn.database ?? ""}`;
  const via = [conn.usql && "usql", conn.dbhub && "dbhub"].filter(Boolean).join(" + ") || "사용 안 함";
  return `${t.label.replace(" (파일)", "")} · ${where} · ${via} · ${conn.readonly !== false ? "읽기 전용" : "쓰기 허용"}` +
    (hasSecret(AGENT, secretKey(conn.id)) ? " · 비밀번호 저장됨" : "");
}

/** dbhub 는 연결이 하나면 execute_sql, 여러 개면 execute_sql_<id> 로 도구 이름을 만든다 */
function dbhubTool(conn, tool) {
  const many = loadConnections(AGENT).filter((x) => x.dbhub).length > 1;
  return `mcp__dbhub__${tool}${many ? "_" + conn.id.replace(/-/g, "_") : ""}`;
}

function usage(conn) {
  return rail([
    conn.usql ? ["usql", `usql ${conn.id} -w -q --csv -c "select ..."  (sql-querying skill)`] : null,
    conn.dbhub ? ["dbhub", `pi 도구 ${dbhubTool(conn, "execute_sql")}, ${dbhubTool(conn, "search_objects")}`] : null,
    ["반영", "실행 중인 pi 에는 /reload 로 반영됩니다"],
  ], { indent: 4 });
}

/** existing: 편집할 기존 연결 (없으면 새 연결), draft: "다시 입력" 때 이어 쓸 값 → 저장했으면 연결 */
async function editConnection(conns, existing, draft) {
  const hasUsql = hasComponent("usql", ROOT);
  const hasDbhub = hasComponent("dbhub", ROOT);
  const conn = draft ? { ...draft } : existing ? { ...existing } : {};
  setPath(existing ? `DB 연결 › ${existing.id}` : "DB 연결 › 새 연결");

  if (!existing && !draft) {
    const type = await ui.select("어떤 종류의 DB 에 연결할까요?", Object.entries(DB_TYPES).map(([k, t]) => ({ label: t.label, value: k })), { initial: 0 });
    if (type === BACK) return null;
    conn.type = type;
    const id = await ui.input("이 연결을 무슨 이름으로 부를까요?", {
      note: ["영문 소문자로 시작하고 소문자·숫자·-·_ 만 씁니다 (31자 이내).", "usql 에서는 usql <이름>, dbhub 도구 이름에는 execute_sql_<이름> 으로 쓰입니다."],
      validate: (v) => (!ID_RE.test(v) ? "영문 소문자로 시작하고 소문자·숫자·-·_ 만 쓸 수 있습니다 (31자 이내)"
        : conns.some((x) => x.id === v) ? `이미 있는 연결 이름입니다. 다른 이름을 쓰거나 목록에서 ${v} 를 편집하세요` : null),
    });
    if (id === BACK) return null;
    conn.id = id;
  }
  const t = DB_TYPES[conn.type];

  if (conn.type === "sqlite") {
    const f = await ui.input("SQLite 파일은 어디에 있습니까?", {
      initial: conn.file ?? "", note: "예: C:\\work\\app.db",
      validate: (v) => (!v ? "값이 필요합니다" : !isAbsolute(v) ? "절대 경로가 아닙니다. C:\\ 처럼 드라이브부터 입력하세요"
        : !existsSync(v) ? "파일이 없습니다. 경로를 확인하거나 탐색기에서 경로 복사 후 붙여넣으세요" : null),
    });
    if (f === BACK) return null;
    conn.file = resolve(f).replace(/\\/g, "/");
  } else {
    const host = await ui.input(`${t.label} 서버의 호스트는 무엇입니까?`, { initial: conn.host ?? "", note: "예: db.example.internal",
      validate: (v) => (/^[A-Za-z0-9._-]+$/.test(v) ? null : "호스트 이름 또는 IP 만 입력하세요. 예: db.example.internal") });
    if (host === BACK) return null;
    const port = await ui.input("포트는 몇 번입니까?", { initial: String(conn.port ?? t.port),
      validate: (v) => (/^\d{1,5}$/.test(v) && Number(v) <= 65535 ? null : "숫자만 입력하세요 (1~65535)") });
    if (port === BACK) return null;
    const db = await ui.input(conn.type === "oracle" ? "서비스 이름은 무엇입니까?" : "데이터베이스 이름은 무엇입니까?",
      { initial: conn.database ?? "", note: conn.type === "oracle" ? "예: ORCLPDB1" : "", validate: (v) => (v ? null : "값이 필요합니다") });
    if (db === BACK) return null;
    const user = await ui.input("어느 사용자로 접속할까요?", { initial: conn.user ?? "", validate: (v) => (v ? null : "값이 필요합니다"), note: "가능하면 읽기 전용 계정을 쓰세요." });
    if (user === BACK) return null;
    Object.assign(conn, { host, port: Number(port), database: db, user });
  }

  // 비밀번호 (DPAPI 로 암호화해 agent/secrets.json 에만 저장)
  let password;      // undefined = 바꾸지 않음, "" = 삭제
  if (conn.type !== "sqlite") {
    const stored = hasSecret(AGENT, secretKey(conn.id));
    let action = "set";
    if (stored) {
      action = await ui.select("저장된 비밀번호는 어떻게 할까요?", [
        { label: "저장된 비밀번호 유지", value: "keep", current: true },
        { label: "새 비밀번호 입력…", value: "set" },
        { label: "저장된 비밀번호 삭제", value: "delete", danger: true, detail: [["바뀌는 것", "agent/secrets.json 에서 이 연결의 비밀번호를 지웁니다"]] },
      ], { initial: 0 });
      if (action === BACK) return null;
      if (action === "delete" && !(await ui.confirm("저장된 비밀번호를 삭제할까요?", {
        yes: "비밀번호 삭제", no: "삭제 취소", level: "medium", note: `${conn.id} 연결은 접속할 때마다 비밀번호가 필요해집니다.`,
      }))) action = "keep";
    }
    if (action === "set") {
      const pw = await ui.input("이 연결의 비밀번호는 무엇입니까?", {
        mask: true, note: "Windows DPAPI 로 암호화해 이 PC 의 현재 사용자만 풀 수 있게 저장합니다. 비워 두면 저장하지 않습니다.",
      });
      if (pw === BACK) return null;
      password = pw;
    } else if (action === "delete") password = "";
  }

  const ro = await ui.select("이 연결의 권한은 무엇으로 할까요?", [
    { label: "읽기 전용", value: true, recommended: true, hint: "dbhub 가 SELECT·SHOW·EXPLAIN 만 허용" },
    { label: "쓰기 허용", value: false, hint: "변경 SQL 은 여전히 bash-guard 가 사용자 확인을 받음" },
  ], { initial: conn.readonly === false ? 1 : 0 });
  if (ro === BACK) return null;
  conn.readonly = ro;

  const targets = [
    ...(hasUsql ? [{ label: "CLI 조회", value: "usql", checked: conn.usql ?? true, hint: "usql · sql-querying 사용법" }] : []),
    ...(hasDbhub ? [{ label: "에이전트 DB 도구", value: "dbhub", checked: conn.dbhub ?? true, hint: "dbhub (MCP) · execute_sql · search_objects" }] : []),
  ];
  const picked = targets.length > 1 ? await ui.multiselect("이 연결을 어디에 등록할까요?", targets) : targets.map((x) => x.value);
  if (picked === BACK) return null;
  conn.usql = picked.includes("usql");
  conn.dbhub = picked.includes("dbhub");

  // 연결 시험 (usql 이 있으면)
  if (hasUsql && await ui.confirm("지금 연결을 시험할까요?", { yes: "연결 시험", no: "시험 없이 저장", recommended: true, note: "usql 로 간단한 조회(select 1)를 실행합니다." })) {
    ui.screen(`  ${c.bold("연결을 시험하는 중입니다")}\n`);
    let r;
    try {
      r = await probe(conn, password !== undefined ? password : undefined);
    } catch { r = null; }
    if (!r) {
      const go = await ui.select("연결 실패를 어떻게 처리할까요?", [
        { label: "연결 정보 다시 입력", value: "again" },
        { label: "그래도 저장 (연결 정보만)", value: "save" },
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
  ui.screen([`  ${c.green("✔")} ${c.bold(`${conn.id} 연결 저장`)}  ${c.gray(describe(conn))}`, "", ...usage(conn)].join("\n"));
  await ui.pause();
  return conn;
}

/** usql 로 select 1 → "성공" (실패하면 원인 · 해결을 보이고 던진다) */
function probe(conn, password) {
  return ui.task(`${conn.id} 접속`, async () => {
    const res = probeConnection(ROOT, AGENT, conn, password ?? getSecret(AGENT, secretKey(conn.id)));
    if (!res.ok) {
      const last = String(res.output ?? "").trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "응답 없음";
      throw Object.assign(new Error(res.output), { why: last, fix: "호스트·포트·사용자·비밀번호를 확인하세요" });
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
        detail: [["바뀌는 것", "편집 · 연결 시험 · 삭제 중에서 고릅니다"], x.usql ? ["쓰는 법", `usql ${x.id} -w -q --csv -c "select ..."`] : null].filter(Boolean) })),
      { label: "+ 새 연결 추가…", value: "__add", disabled: !hasUsql && !hasDbhub ? "사용 불가 · usql·dbhub 반입 안 됨" : false,
        why: "usql 과 dbhub 가 모두 반입되지 않았습니다", fix: FETCH_FIX, detail: [["바뀌는 것", "다음 화면부터 DB 종류·이름·접속 정보를 입력합니다"]] },
      { label: "Oracle 전용 조회", value: "__sqlcl", hint: `${isInstalled("sqlcl", ROOT) ? "설치됨" : "설치 안 됨"} · SQLcl · 교체·설치`,
        detail: [["바뀌는 것", "직접 받은 zip 으로 Oracle SQLcl 을 설치하거나 교체합니다 (runtime/sqlcl)"]] },
      { label: "← 이전", value: "__back" },
    ];
    const k = opts.findIndex((o) => o.value === last);
    const v = await ui.select("어느 DB 연결을 바꿀까요?", opts, {
      ...(k >= 0 ? { initial: k } : {}), message: msg,
      note: conns.length ? "연결은 CLI 조회(usql)와 에이전트 DB 도구(dbhub)에서 이름으로 씁니다."
        : "등록된 연결이 없습니다. 새 연결을 추가하면 usql 과 dbhub 에서 이름으로 쓸 수 있습니다.",
    });
    msg = "";
    if (v === BACK || v === "__back") return "";
    last = v;
    if (v === "__add") { const r = await editConnection(conns); if (r) last = r.id; continue; }
    if (v === "__sqlcl") {
      setPath("DB 연결 › Oracle 전용 조회");
      msg = await editItem("Oracle 전용 조회", (state) => stepSqlcl(state));
      continue;
    }
    const conn = conns.find((x) => x.id === v);
    setPath(`DB 연결 › ${conn.id}`);
    const act = await ui.select(`${conn.id} 연결을 어떻게 할까요?`, [
      { label: "편집…", value: "edit", detail: [["바뀌는 것", "접속 정보·권한·등록할 곳을 다시 입력합니다 (지금 값이 기본값)"]] },
      { label: "연결 시험", value: "probe", disabled: hasUsql ? false : "사용 불가 · usql 없음", why: "usql 이 설치되지 않았습니다", fix: FETCH_FIX,
        detail: [["바뀌는 것", "아무것도 바꾸지 않습니다. usql 로 select 1 을 실행합니다"]] },
      { label: "삭제…", value: "delete", danger: true, detail: [["바뀌는 것", "다음 화면에서 한 번 더 확인합니다"]] },
      { label: "← 이전", value: "back" },
    ], { initial: 0, note: [c.gray(describe(conn)), ...usage(conn).map((l) => l.slice(2))] });
    if (act === "edit") await editConnection(conns, conn);
    else if (act === "probe") {
      ui.screen(`  ${c.bold("연결을 시험하는 중입니다")}\n`);
      try { await probe(conn); } catch { /* 원인 · 해결은 task 가 출력 */ }
      await ui.pause();
    } else if (act === "delete") {
      const tool = conn.dbhub ? `pi 도구 ${dbhubTool(conn, "execute_sql")} 이 없어집니다` : `usql ${conn.id} 로 접속할 수 없게 됩니다`;
      if (await ui.confirm(`${conn.id} 연결을 삭제할까요?`, {
        yes: `${conn.id} 연결 삭제`, no: "삭제 취소", level: "medium",
        note: rail([["지금", describe(conn)], ["사라짐", `connections.json 의 ${conn.id} · 저장된 비밀번호 · usql/dbhub 등록`]], { wrap: ui.cols() - 4 }),
        detail: { yes: [["바뀌는 것", tool], ["되돌리기", "같은 값으로 다시 추가하면 됩니다 (비밀번호는 다시 입력)"]], no: [["바뀌는 것", "아무것도 바꾸지 않습니다"]] },
      })) {
        deleteSecret(AGENT, secretKey(conn.id));
        saveConnections(ROOT, AGENT, conns.filter((x) => x.id !== conn.id));
        msg = saved(`${conn.id} 연결 삭제 · 실행 중인 pi 에는 /reload 로 반영됩니다`);
        last = null;
      }
    }
  }
}

// ------------------------------------------------------------------ 보조 기능 (extension)
const EXTENSIONS = [
  { key: "OXY_BASH_GUARD", label: "위험 명령 차단", hint: "oxy-bash-guard · 쓰기 작업은 확인 후 실행", off: "위험 명령 차단과 쓰기 작업 확인이 없어집니다" },
  { key: "OXY_READ_BEFORE_EDIT", label: "읽기 전 수정 차단", hint: "oxy-read-before-edit", off: "읽지 않은 파일도 바로 고칠 수 있게 됩니다" },
  { key: "OXY_LOOP_GUARD", label: "반복 호출 차단", hint: "oxy-loop-guard · 텍스트 tool call 재호출 안내", off: "같은 호출을 되풀이해도 막지 않습니다" },
  { key: "OXY_CONTEXT_BUDGET", label: "긴 출력 줄이기", hint: "oxy-context-budget · 컨텍스트 사용률 표시", off: "긴 명령 출력이 그대로 컨텍스트에 들어갑니다" },
  { key: "OXY_FLOW", label: "작업 기록", hint: "oxy-flow · compaction 을 작업 상태로 교체", off: "작업 기록과 결정 기록이 남지 않습니다" },
  { key: "OXY_FLOW_ROLLOVER", label: "세션 넘기기", hint: "oxy-flow · 컨텍스트가 차면 새 세션에서 이어감", off: "컨텍스트가 차도 같은 세션을 이어 씁니다" },
  { key: "OXY_JOBS", label: "백그라운드 작업", hint: "oxy-jobs · subagent · 작업 패널", off: "백그라운드 작업과 subagent 를 쓸 수 없습니다" },
  { key: "OXY_VLLM_METRICS", label: "LLM 서버 혼잡 감지", hint: "oxy-jobs · /metrics 확인 · 기본 꺼짐", defaultOff: true, off: "subagent 시작 전에 서버 부하를 보지 않습니다" },
];
const isOn = (env, e) => (e.defaultOff ? /^(on|1|true)$/i.test(env[e.key] ?? "") : !/^(off|0|false)$/i.test(env[e.key] ?? ""));

async function extensionMenu() {
  setPath("보조 기능");
  const { text, env } = readEnv();
  const on = await ui.multiselect("어떤 보조 기능을 켤까요?", EXTENSIONS.map((e) => ({
    label: e.label, value: e.key, hint: e.hint, checked: isOn(env, e),
    detail: [["바뀌는 것", `agent/oxy.env 의 ${e.key}`], ["끄면", e.off]],
  })), { note: "끄면 소형 모델의 실수를 막는 장치가 사라집니다. 이유가 없으면 켜 두세요." });
  if (on === BACK) return "";
  const updates = Object.fromEntries(EXTENSIONS.map((e) => [e.key, on.includes(e.key) ? "on" : "off"]));
  writeFileSync(ENV_FILE, mergeEnv(text, updates));
  const offNames = EXTENSIONS.filter((e) => !on.includes(e.key)).map((e) => e.label);
  return saved(`보조 기능 저장 · ${on.length}/${EXTENSIONS.length} 켜짐${offNames.length ? ` (꺼짐: ${offNames.join(", ")})` : ""} · 다시 시작하면 적용`);
}

// ------------------------------------------------------------------ 작업 한도
const LIMITS = [
  { key: "OXY_TOOL_OUTPUT_MAX_CHARS", label: "명령 출력 상한", def: 12000, fmt: (v) => `${v}자`, tech: "bash·grep·find" },
  { key: "OXY_READ_MAX_CHARS", label: "파일 읽기 상한", def: 40000, fmt: (v) => `${v}자`, tech: "read" },
  { key: "OXY_REPEAT_LIMIT", label: "같은 호출 반복 차단", def: 3, fmt: (v) => `${v}회` },
  { key: "OXY_FLOW_ROLLOVER_PCT", label: "세션 넘기기 기준", def: 50, fmt: (v) => `컨텍스트 ${v}%` },
  { key: "OXY_LLM_MAX_CONCURRENT", label: "보조 에이전트 동시 실행", def: 2, fmt: (v) => `${v}개`, tech: "subagent", why: "LLM 서버(vLLM)의 KV 캐시를 고려해 정합니다" },
  { key: "OXY_JOBS_MAX_CONCURRENT", label: "백그라운드 동시 실행", def: 4, fmt: (v) => `${v}개`, tech: "bash" },
];
const limitValue = (env, l) => (env[l.key] ? `${l.fmt(env[l.key])} (기본 ${l.def})` : `${l.fmt(l.def)} (기본)`);

/** 작업 한도: 목록에서 하나 골라 그 값만 바꾸고 바로 저장 */
async function limitsMenu() {
  let msg = "";
  let last = 0;
  for (;;) {
    setPath("작업 한도");
    const { text, env } = readEnv();
    const k = await ui.select("어느 값을 바꿀까요?", [
      ...LIMITS.map((l) => ({ label: l.label, value: l.key, hint: [limitValue(env, l), l.tech].filter(Boolean).join(" · "),
        detail: [l.why ? ["근거", l.why] : null, ["바뀌는 것", `agent/oxy.env 의 ${l.key}`]].filter(Boolean) })),
      { label: "← 이전", value: "__back" },
    ], { initial: last, message: msg });
    msg = "";
    if (k === BACK || k === "__back") return "";
    last = LIMITS.findIndex((x) => x.key === k);
    const l = LIMITS[last];
    const v = await ui.input(`${l.label}은 얼마로 할까요?`, { initial: String(env[l.key] ?? l.def), note: `기본값 ${l.def}${l.why ? `. ${l.why}` : ""}`,
      validate: (s) => (/^\d+$/.test(s) && Number(s) > 0 ? null : "1 이상의 정수여야 합니다") });
    if (v === BACK) continue;
    writeFileSync(ENV_FILE, mergeEnv(text, { [l.key]: v }));
    msg = saved(`${l.label} = ${l.fmt(v)} 저장${Number(v) === l.def ? " (기본값)" : ` (기본 ${l.def})`}`);
  }
}

// ------------------------------------------------------------------ 설치 항목 (설치 TUI 의 단계를 하나씩 재사용)
function registry() {
  const reg = sys.loadRegistry();
  const registered = Boolean(reg?.installDir && sys.isSameDir(reg.installDir, ROOT));
  return { registered, reg: registered ? reg : { installDir: ROOT, copied: false, gitBash: sys.findGitBash(), integrations: [] } };
}

/** 고른 항목 하나만 바꾸고 바로 저장한다 → 메시지 줄에 보일 결과 (BACK 이면 아무것도 바꾸지 않고 "") */
async function editItem(title, run) {
  const { registered, reg } = registry();
  const state = { ...stateFromInstall(reg), installDir: ROOT, tweak: true };
  const r = await run(state);
  if (r === BACK || r === "cancel") return "";
  ui.screen(`  ${c.bold(`${title} 적용 중`)}\n`);
  try {
    await applyOptional(state);
    await ui.task("설정 생성 (oxy.env, settings.json, models.json, skill)", async () => `${writeSiteConfig(ROOT, state)}개 파일`);
    if (r === "integrations") {
      await applyIntegrations(state, reg);
      if (registered) sys.saveRegistry({ ...reg, integrations: state.integrations, updatedAt: new Date().toISOString() });
    }
  } catch (e) {
    if (!e?.reported) errorBlock(`${title} 저장 실패`, e).forEach((l) => ui.print(l));
    await ui.pause();
    return "";
  }
  return saved(`${title} 저장 · ${APPLY_LATER}`);
}

/** LLM 서버에서 모델 목록을 받아 둔다 (모델 단계에서 고를 수 있게). 실패하면 직접 입력 / 서버 주소부터 */
async function withModels(state) {
  ui.screen(`  ${c.bold("LLM 서버에서 모델 목록을 받는 중입니다")}\n  ${c.gray(state.baseUrl ?? "")}\n`);
  try {
    state.models = await ui.task("모델 목록 (/v1/models)", async () => fetchModels(state.baseUrl, state.apiKey));
    return "next";
  } catch (e) {
    state.models = [];
    const v = await ui.select("모델 목록 없이 어떻게 할까요?", [
      { label: "모델 이름 직접 입력", value: "manual" },
      { label: "서버 주소부터 다시", value: "vllm" },
    ], { initial: 0, note: errorBlock("모델 목록을 받지 못했습니다", e).map((l) => l.slice(2)), result: true });
    return v === BACK ? BACK : v;
  }
}

const items = {
  vllm: async (state) => {
    const r = await stepVllm(state);
    if (r === BACK) return BACK;
    // 지금 쓰는 모델이 새 서버에 없으면 이어서 모델을 고른다
    if (state.models?.length && !state.models.some((m) => m.id === state.coder)) {
      await ui.notice("warn", `지금 모델 ${state.coder} 이(가) 이 서버에 없습니다`, { fix: "이어지는 화면에서 모델을 다시 고르세요" });
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
    if (removed.length && !(await ui.confirm(`${removed.map((k) => INTEGRATION_NAMES[k]).join(" · ")} 등록을 해제할까요?`, {
      yes: "등록 해제", no: "해제 취소", level: "medium", note: "해제하면 그 방법으로는 oxy 를 실행할 수 없습니다. 같은 항목에서 다시 등록할 수 있습니다.",
    }))) return BACK;
    return "integrations";
  },
};

// ------------------------------------------------------------------ LLM 연결 (하위 메뉴)
function endpointHint(env) {
  const drop = String(env.OXY_VLLM_DROP_PARAMS ?? "").split(/[\s,]+/).filter(Boolean);
  if (!drop.length && !env.OXY_PROVIDER_RETRIES && !env.OXY_MAX_OUTPUT_TOKENS) return "기본값 (뺀 파라미터 없음 · 재시도 0회)";
  return [drop.length ? `뺀 파라미터 ${drop.length}개` : "뺀 파라미터 없음", `재시도 ${env.OXY_PROVIDER_RETRIES || 0}회`,
    env.OXY_MAX_OUTPUT_TOKENS && `응답 최대 ${env.OXY_MAX_OUTPUT_TOKENS}`].filter(Boolean).join(" · ");
}

async function llmMenu() {
  let msg = "";
  let last = 0;
  for (;;) {
    setPath("LLM 연결");
    const { env } = readEnv();
    const k = Math.round(Number(env.OXY_CONTEXT_WINDOW || 0) / 1024);
    const opts = [
      { label: "서버 주소·API 키", value: "vllm", hint: `${env.OXY_VLLM_BASE_URL ?? "없음"} · 키 ${env.OXY_VLLM_API_KEY && env.OXY_VLLM_API_KEY !== "EMPTY" ? "입력됨" : "없음"}`,
        detail: [["바뀌는 것", "주소·키를 다시 입력하고 서버에 시험합니다 (vLLM /v1/models)"], ["되돌리기", "같은 항목에서 다시 바꿀 수 있습니다"]] },
      { label: "모델", value: "model", hint: `코딩 ${env.OXY_MODEL_CODER ?? "?"} · 범용 ${env.OXY_MODEL_GENERAL || "없음"} · ${k}K`,
        detail: [["바뀌는 것", "코딩·범용 모델 · 컨텍스트 길이 · 모델 계열"], ["되돌리기", "같은 항목에서 다시 바꿀 수 있습니다"]] },
      { label: "요청 조정", value: "endpoint", hint: endpointHint(env),
        detail: [["바뀌는 것", "뺄 요청 파라미터 · 거부 시 재시도 · 응답 최대 길이"], ["되돌리기", "같은 항목에서 다시 바꿀 수 있습니다"]] },
      { label: "← 이전", value: "__back" },
    ];
    const v = await ui.select("LLM 연결에서 무엇을 바꿀까요?", opts, { initial: last, message: msg,
      note: "서버 주소를 바꾸면 모델이 새 서버에 있는지 이어서 확인합니다." });
    msg = "";
    if (v === BACK || v === "__back") return "";
    last = opts.findIndex((o) => o.value === v);
    if (v === "vllm") { setPath("LLM 연결 › 서버 주소·API 키"); msg = await editItem("서버 주소·API 키", items.vllm); }
    else if (v === "model") { setPath("LLM 연결 › 모델"); msg = await editItem("모델", items.model); }
    else if (v === "endpoint") msg = await endpointMenu();
  }
}

/** 요청 조정: 값 하나씩 바꾸고 바로 설정(models.json · settings.json)을 다시 만든다 */
async function endpointMenu() {
  let msg = "";
  let last = 0;
  for (;;) {
    setPath("LLM 연결 › 요청 조정");
    const { text, env } = readEnv();
    const drop = String(env.OXY_VLLM_DROP_PARAMS ?? "").split(/[\s,]+/).filter(Boolean);
    const opts = [
      { label: "뺄 요청 파라미터", value: "drop", hint: `${drop.join(", ") || "없음 (모두 보냄)"} · top_k 등 서버가 거부하는 것`,
        detail: [["바뀌는 것", "agent/oxy.env 의 OXY_VLLM_DROP_PARAMS"]] },
      { label: "거부 시 재시도", value: "retries", hint: `${env.OXY_PROVIDER_RETRIES ? `${env.OXY_PROVIDER_RETRIES}회` : "0회 (재시도 안 함)"} · HTTP 429 등`,
        detail: [["바뀌는 것", "agent/oxy.env 의 OXY_PROVIDER_RETRIES"]] },
      { label: "응답 최대 길이", value: "maxout", hint: `${env.OXY_MAX_OUTPUT_TOKENS || "모델 기본값"} · 토큰`,
        detail: [["바뀌는 것", "agent/oxy.env 의 OXY_MAX_OUTPUT_TOKENS"]] },
      { label: "← 이전", value: "__back" },
    ];
    const k = await ui.select("요청 조정에서 어느 값을 바꿀까요?", opts, { initial: last, message: msg,
      note: "서버 주소·API 키 항목이 서버에 시험해서 자동으로 정하는 값입니다. 사용량 제한이 있는 서버에 직접 맞출 때 씁니다." });
    msg = "";
    if (k === BACK || k === "__back") return "";
    last = opts.findIndex((o) => o.value === k);
    let updates = null;
    if (k === "drop") {
      const v = await ui.multiselect("어떤 파라미터를 요청에서 뺄까요?", VLLM_EXTRA_PARAMS.map((p) => ({ label: p, value: p, checked: drop.includes(p),
        hint: p === "chat_template_kwargs" ? "Qwen thinking 켜고 끄기" : p === "reasoning_effort" ? "gpt-oss 추론 강도" : "vLLM 샘플링 확장" })),
      { note: "서버가 거부하는 것만 고르세요. 뺀 파라미터는 요청에 넣지 않습니다." });
      if (v !== BACK) updates = { OXY_VLLM_DROP_PARAMS: v.join(",") };
    } else if (k === "retries") {
      const v = await ui.input("거부됐을 때 몇 번 재시도할까요?", { initial: env.OXY_PROVIDER_RETRIES ?? "0",
        note: "HTTP 429 등에서 서버가 알려 준 시간만큼 기다렸다 다시 보냅니다. 사내 vLLM 은 보통 0 입니다.",
        validate: (s) => (/^\d{1,2}$/.test(s) ? null : "0~99 사이의 숫자여야 합니다") });
      if (v !== BACK) updates = { OXY_PROVIDER_RETRIES: v === "0" ? "" : v };
    } else if (k === "maxout") {
      const v = await ui.input("응답 최대 길이는 몇 토큰으로 할까요?", { initial: env.OXY_MAX_OUTPUT_TOKENS ?? "",
        note: "비우면 모델 기본값입니다. 분당 출력 토큰 제한보다 작게 둡니다.",
        validate: (s) => (s === "" || (/^\d+$/.test(s) && Number(s) >= 256) ? null : "256 이상의 숫자이거나 빈칸이어야 합니다") });
      if (v !== BACK) updates = { OXY_MAX_OUTPUT_TOKENS: v };
    }
    if (!updates) continue;
    writeFileSync(ENV_FILE, mergeEnv(text, updates));
    const { reg } = registry();
    try {
      writeSiteConfig(ROOT, { ...stateFromInstall(reg), installDir: ROOT });
      msg = saved(`${opts[last].label} 저장 · ${APPLY_LATER}`);
    } catch (e) {
      await ui.notice("err", `설정을 다시 만들지 못했습니다: ${e.message}`, { fix: "agent/oxy.env 의 값을 확인한 뒤 다시 저장하세요" });
    }
  }
}

// ------------------------------------------------------------------ 도구 사용법 (skill 켜기/끄기)
/** skill id → 항목명 (하는 일). skill 이름은 그 skill 을 켜는 구성요소의 항목명과 같다 */
const SKILL_NAMES = {
  "find-code": "코드·파일 찾기", "json-querying": "JSON 다루기", "project-task-running": "프로젝트 명령 실행",
  "http-api-testing": "HTTP API 시험", "terminal-session-control": "터미널 세션 조작", "gitlab-workflow": "GitLab 작업",
  "github-workflow": "GitHub 작업", "structural-code-search": "구조 단위 코드 검색", "code-graph-search": "코드 그래프 탐색",
  "web-page-automation": "웹 페이지 조작", "web-page-reading": "웹 페이지 읽기", "sql-querying": "SQL 조회", "oracle-db-querying": "Oracle 전용 조회",
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
      const row = { label: SKILL_NAMES[s] ?? s, value: s, hint: `${s} · ${techs}`, checked: have.length > 0 && !off.includes(s),
        detail: [["바뀌는 것", `agent/skills/${s} 를 지우거나 skill-library 에서 다시 복사`], ["되돌리기", "이 화면에서 다시 켜면 됩니다"]] };
      if (!have.length) {
        const p = providers[0];
        Object.assign(row, {
          disabled: CATALOG[p].external || !OPTIONAL[p] ? "반입 안 됨" : "설치 안 됨",
          why: `${CATALOG[p].name ?? CATALOG[p].title} 도구(${p === "sqlcl" ? "SQLcl" : p})가 설치되지 않았습니다`,
          fix: p === "sqlcl" ? "메인 메뉴 2 DB 연결 › Oracle 전용 조회에서 zip 으로 설치하세요"
            : CATALOG[p].external ? `Windows 빌드 ${p}.exe 를 vendor/${p}/ 에 넣고 다시 번들링하세요` : FETCH_FIX,
        });
      } else if (s === "web-page-automation" && env.OXY_BROWSER === "none") {
        Object.assign(row, { disabled: "브라우저 사용 안 함", why: "웹 페이지 자동화의 브라우저가 '사용 안 함'입니다", fix: "메인 메뉴 4 웹 페이지 자동화에서 브라우저를 고르세요" });
      }
      rows.push(row);
    }
  }
  return rows;
}

async function skillsMenu() {
  setPath("도구 사용법");
  const { text, env } = readEnv();
  const rows = skillRows(env);
  const list = rows.filter((r) => !r.header);
  if (!list.length) { await ui.notice("warn", "설치된 구성요소에 해당하는 skill 이 없습니다"); return ""; }
  const on = await ui.multiselect("어떤 도구 사용법을 켤까요?", rows, {
    note: "설치된 구성요소의 사용법(skill)만 켤 수 있습니다. 끈 것은 업데이트해도 꺼진 채 남습니다. 구성요소를 더하려면 인터넷 PC 에서 fetch → 번들링 → 반입 후 install.cmd 로 업데이트하세요.",
  });
  if (on === BACK) return "";
  // 사용자가 끈 것만 적는다. 지금 고를 수 없는 skill 의 기존 설정은 그대로 둔다
  const prevOff = parseSkillsOff(env.OXY_SKILLS_OFF);
  const off = [...new Set([...prevOff.filter((s) => list.find((r) => r.value === s)?.disabled || !list.find((r) => r.value === s)),
    ...list.filter((r) => !r.disabled && !on.includes(r.value)).map((r) => r.value)])];
  writeFileSync(ENV_FILE, mergeEnv(text, { OXY_SKILLS_OFF: off.join(",") }));
  ui.screen(`  ${c.bold("도구 사용법 적용 중")}\n`);
  const { reg } = registry();
  try {
    await ui.task("skill 동기화 (agent/skills)", async () => { writeSiteConfig(ROOT, { ...stateFromInstall(reg), installDir: ROOT }); return ""; });
  } catch (e) {
    if (!e?.reported) errorBlock("도구 사용법 저장 실패", e).forEach((l) => ui.print(l));
    await ui.pause();
    return "";
  }
  const offNames = list.filter((r) => !r.disabled && !on.includes(r.value)).map((r) => r.label);
  return saved(`도구 사용법 저장 · ${on.length}/${list.length} 켜짐${offNames.length ? ` (꺼짐: ${offNames.join(", ")})` : ""} · 다시 시작하면 적용`);
}

// ------------------------------------------------------------------ 동작 시험
async function verifyNow() {
  setPath("동작 시험");
  ui.screen(`  ${c.bold("동작 시험 (verify)")}\n`);
  const reg = sys.loadRegistry();
  const gitBash = reg?.gitBash && existsSync(reg.gitBash) ? reg.gitBash : sys.findGitBash();
  const passed = sys.runVerify(ROOT, gitBash);
  await ui.pause();
  return passed ? saved("동작 시험 통과") : `${c.yellow("!")} 동작 시험에 FAIL/WARN 이 있습니다. 위로 스크롤해 결과를 보세요`;
}

// ------------------------------------------------------------------ 허브
const BROWSER_NAMES = { "chrome-for-testing": "Chrome for Testing", chromium: "Chromium 오픈소스 빌드", obscura: "가벼운 엔진 (obscura)",
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
  return [
    { header: "연결" },
    { label: "LLM 연결", value: "llm", hint: `${hostOf(env.OXY_VLLM_BASE_URL)} · ${env.OXY_MODEL_CODER ?? "모델 없음"}${env.OXY_MODEL_GENERAL ? " 외 1" : ""}`,
      detail: [["바뀌는 것", "서버 주소·API 키 · 모델 · 요청 조정 중에서 고릅니다"]] },
    { label: "DB 연결", value: "db", hint: `${conns.length}개${conns.length ? ` (${conns.map((x) => x.id).join(", ")})` : ""} · Oracle 전용 조회 ${isInstalled("sqlcl", ROOT) ? "설치됨" : "설치 안 됨"}`,
      detail: [["바뀌는 것", "연결 추가·편집·삭제 · Oracle 전용 조회(SQLcl) 설치"]] },
    { label: "GitLab 연결", value: "gitlab", hint: env.GITLAB_HOST || "없음", detail: [["바뀌는 것", "GitLab 호스트 (agent/oxy.env 의 GITLAB_HOST)"]] },
    { label: "웹 페이지 자동화", value: "browser", hint: `브라우저 ${BROWSER_NAMES[env.OXY_BROWSER] ?? env.OXY_BROWSER ?? "없음"}`,
      disabled: hasBrowser ? false : "사용 불가 · agent-browser 설치 안 됨", why: "agent-browser 가 설치되지 않았습니다", fix: FETCH_FIX,
      detail: [["바뀌는 것", "agent-browser 가 쓸 브라우저 (agent/oxy.env 의 OXY_BROWSER)"]] },
    { header: "에이전트 동작" },
    { label: "보조 기능", value: "ext", hint: `${EXTENSIONS.filter((e) => isOn(env, e)).length}/${EXTENSIONS.length} 켜짐 (extension)`,
      detail: [["바뀌는 것", "위험 명령 차단 등 extension 켜기/끄기 (agent/oxy.env)"]] },
    { label: "도구 사용법", value: "skills", hint: `${skills.filter((r) => skillsOn.has(r.value)).length}/${skills.length} 켜짐 (skill)`,
      detail: [["바뀌는 것", "구성요소별 사용 안내(skill) 켜기/끄기 (agent/skills)"]] },
    { label: "작업 한도", value: "limits", hint: `명령 출력 ${limit("OXY_TOOL_OUTPUT_MAX_CHARS")}자 · 보조 에이전트 ${limit("OXY_LLM_MAX_CONCURRENT")}개 동시`,
      detail: [["바뀌는 것", "출력 상한 · 반복 차단 · 동시 실행 수 (agent/oxy.env)"]] },
    { header: "이 PC" },
    { label: "실행 등록", value: "integrations", hint: (reg.integrations ?? []).map((k) => INTEGRATION_NAMES[k]).join(" · ") || "없음",
      detail: [["바뀌는 것", "PATH · Windows Terminal 프로필 · 바탕화면 바로가기 등록/해제"]] },
    { label: "동작 시험", value: "verify", hint: "도구·설정·LLM 연결 실제 시험 (verify)", detail: [["바뀌는 것", "아무것도 바꾸지 않습니다. 결과만 보여 줍니다"]] },
    { label: "종료", value: "exit" },
  ];
}

async function main() {
  ui.interruptNote = () => "중단했습니다. 이 항목은 저장하지 않았습니다 (앞에서 저장한 항목은 그대로입니다).";
  if (!existsSync(ENV_FILE)) {
    setPath();
    ui.screen([`  ${c.bold("종합 설정을 열 수 없습니다")}`, "",
      ...errorBlock("아직 설치되지 않은 하네스입니다", { cause: "agent/oxy.env 가 없습니다", fix: "이 폴더에서 install.cmd 를 먼저 실행하세요" })].join("\n"));
    await ui.pause("종료");
    return 1;
  }
  ui.intro();
  let last = 0;
  let msg = "";
  for (;;) {
    setPath();
    const rows = hubRows();
    const list = rows.filter((r) => !r.header);
    const v = await ui.select("무엇을 바꿀까요?", rows, { back: true, esc: "종료", initial: last, message: msg });
    msg = "";
    if (v === BACK || v === "exit") return 0;
    last = list.findIndex((o) => o.value === v);
    if (v === "llm") msg = await llmMenu();
    else if (v === "db") msg = await dbMenu();
    else if (v === "gitlab") { setPath("GitLab 연결"); msg = await editItem("GitLab 연결", items.gitlab); }
    else if (v === "browser") { setPath("웹 페이지 자동화"); msg = await editItem("웹 페이지 자동화", items.browser); }
    else if (v === "ext") msg = await extensionMenu();
    else if (v === "skills") msg = await skillsMenu();
    else if (v === "limits") msg = await limitsMenu();
    else if (v === "integrations") { setPath("실행 등록"); msg = await editItem("실행 등록", items.integrations); }
    else if (v === "verify") msg = await verifyNow();
  }
}

await ui.run(main);
