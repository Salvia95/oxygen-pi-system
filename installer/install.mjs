// oxygen-pi-system 설치 TUI. 번들에 포함된 Node 로 실행한다 (install.cmd / install.sh).
//   node installer/install.mjs [--sandbox <dir>]
//   --sandbox: 레지스트리(PATH)·바탕화면·AppData 대신 지정 폴더에만 기록 (테스트용)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BACK, UI, banner, c, stepArt } from "./tui.mjs";
import { WT_PROFILE_NAME, createSystem, toPosix } from "./system.mjs";
import { OPTIONAL, browserChoices, checkArchive, findArchives, hasComponent, installOptional, isInstalled, syncSkills } from "./components.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argSandbox = (() => { const i = process.argv.indexOf("--sandbox"); return i > 0 ? resolve(process.argv[i + 1]) : null; })();
const sys = createSystem({ root: ROOT, sandbox: argSandbox ?? process.env.OXY_INSTALLER_SANDBOX ?? null });
const VERSION = sys.version();
const ui = new UI();
const { parseEnv, mergeEnv, renderConfig, MODEL_FAMILIES, detectFamily } = await import(pathToFileURL(join(ROOT, "scripts", "render-config.mjs")).href);

const ok = (s) => `${c.green("✔")} ${s}`;
const bad = (s) => `${c.red("✖")} ${s}`;
const warnMark = (s) => `${c.yellow("!")} ${s}`;

// ------------------------------------------------------------------ 단계 표시
const STEP_NAMES = ["점검", "위치", "선택", "vLLM", "모델", "GitLab", "등록", "확인"];
function setFrame(stepIndex = null, names = STEP_NAMES) {
  ui.frame = () => banner(VERSION) + (stepIndex === null ? "" : stepArt(names, stepIndex) + "\n");
}

/** 단계 배열을 순서대로 실행. 단계가 BACK 을 돌려주면 이전 단계로 */
/** backExits: 첫 단계에서 Esc(이전)를 누르면 흐름을 빠져나간다 (설정 변경·Tweak 에서 메뉴로 돌아가기) */
async function runSteps(steps, state, names, { backExits = false } = {}) {
  let i = 0;
  while (i < steps.length) {
    setFrame(i, names);
    const r = await steps[i](state);
    if (r === BACK && i === 0 && backExits) return false;
    if (r === BACK) i = Math.max(0, i - 1);
    else if (r === "cancel") return false;
    else i++;
  }
  return true;
}

// ------------------------------------------------------------------ 단계: 점검
async function stepCheck(state) {
  const lines = [];
  let fatal = false;
  state.gitBash = sys.findGitBash();
  if (state.gitBash) lines.push(ok(`Git Bash      ${c.gray(state.gitBash)}`));
  else { lines.push(bad("Git Bash      Git for Windows 를 찾지 못함 (필수)")); fatal = true; }

  const java = sys.checkJava();
  lines.push(java.ok ? ok(`Java ${java.major}       ${c.gray(java.detail)}`)
    : warnMark(`Java          ${java.detail} ${c.gray("(SQLcl 사용 불가, 나머지는 동작)")}`));

  const missing = sys.missingBundleFiles();
  if (missing.length === 0) lines.push(ok(`번들 구성요소  ${c.gray(ROOT)}`));
  else { lines.push(bad(`번들 구성요소 누락 ${missing.length}건: ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? " …" : ""}`)); fatal = true; }

  if (process.platform !== "win32") { lines.push(bad("Windows 전용 설치 도구입니다")); fatal = true; }

  const body = `  ${c.bold("환경 점검")}\n\n${lines.map((l) => "  " + l).join("\n")}`;
  if (fatal) {
    ui.screen(body + `\n\n  ${c.red("필수 항목이 없어 설치를 계속할 수 없습니다.")}`);
    await ui.pause("Enter 를 누르면 종료합니다");
    return "cancel";
  }
  const go = await ui.select("환경 점검 결과", [{ label: "계속", value: "next" }, { label: "취소", value: "cancel" }],
    { back: false, note: "\n" + lines.map((l) => "    " + l).join("\n") });
  return go;
}

// ------------------------------------------------------------------ 단계: 설치 위치
async function stepLocation(state) {
  const inPlace = sys.isSameDir(ROOT, sys.defaultInstallDir);
  const options = [
    { label: `기본 위치에 설치`, value: "default", hint: sys.defaultInstallDir },
    ...(inPlace ? [] : [{ label: "지금 폴더에서 그대로 사용 (복사 안 함)", value: "inplace", hint: ROOT }]),
    { label: "직접 입력", value: "custom" },
  ];
  const initial = Math.max(0, options.findIndex((o) => o.value === state.locationChoice));
  const choice = await ui.select("설치 위치", options, {
    initial,
    note: c.gray("  번들(약 1GB)을 지정한 위치로 복사합니다. 기존 설치가 있으면 설정을 유지한 채 업데이트합니다."),
  });
  if (choice === BACK) return BACK;
  state.locationChoice = choice;

  let dir = choice === "default" ? sys.defaultInstallDir : choice === "inplace" ? ROOT : null;
  for (;;) {
    if (choice === "custom") {
      const v = await ui.input("설치할 폴더 경로", {
        initial: state.installDir ?? "C:\\oxygen-pi",
        validate: (p) => (!p ? "경로를 입력하세요" : !isAbsolute(p) ? "절대 경로(C:\\...)를 입력하세요" : null),
      });
      if (v === BACK) return stepLocation(state);
      dir = resolve(v);
    }
    const inside = (resolve(dir) + sep).toLowerCase().startsWith((ROOT + sep).toLowerCase()) && !sys.isSameDir(dir, ROOT);
    const kind = sys.isSameDir(dir, ROOT) ? "inplace" : sys.inspectTarget(dir);
    if (inside) { await notice(`설치 위치가 번들 폴더 안에 있습니다:\n  ${dir}`); if (choice === "custom") continue; return stepLocation(state); }
    if (kind === "file" || kind === "foreign") {
      await notice(`${dir}\n  ${kind === "file" ? "파일이 이미 있습니다." : "oxygen-pi 가 아닌 파일이 들어 있는 폴더입니다."} 다른 위치를 고르세요.`);
      if (choice === "custom") continue;
      return stepLocation(state);
    }
    state.installDir = dir;
    state.copy = kind !== "inplace";
    state.update = kind === "ours";
    if (dir.length > 100) {
      const go = await ui.confirm(`경로가 깁니다 (${dir.length}자). 일부 Windows 도구는 긴 경로에서 문제가 생길 수 있습니다. 계속할까요?`, { initial: false });
      if (!go) { if (choice === "custom") continue; return stepLocation(state); }
    }
    return "next";
  }
}

// ------------------------------------------------------------------ 단계: 선택 구성요소 · 런타임 선택
// 재배포하지 않는 바이너리(manifest dist=optional)는 사용자가 공식 배포처에서 직접 받은 압축 파일로만 설치한다.
const downloadsDir = process.env.USERPROFILE ? join(process.env.USERPROFILE, "Downloads") : null;

/** 선택 구성요소의 압축 파일 고르기 → 경로 | "skip" | BACK */
async function pickArchive(name, { skipLabel = "설치하지 않음" } = {}) {
  const comp = OPTIONAL[name];
  const found = [...new Set([...findArchives(join(ROOT, "optional"), name), ...findArchives(downloadsDir, name)])];
  const note = [
    `  ${comp.purpose}`,
    `  ${c.yellow("라이선스")} ${comp.license} — 이 번들에는 없습니다. 직접 받은 파일을 지정하거나 건너뛸 수 있습니다.`,
    `  ${c.gray("받는 곳")}   ${comp.downloadPage}`,
    `  ${c.gray("약관 원문")} ${comp.licenseUrl}`,
  ].join("\n");
  for (;;) {
    const v = await ui.select(`${comp.title} 설치 파일`, [
      ...found.map((f) => ({ label: "이 파일로 설치", value: f, hint: f })),
      { label: "다른 위치의 파일 지정", value: "custom" },
      { label: skipLabel, value: "skip" },
    ], { note });
    if (v === BACK || v === "skip") return v;
    let file = v;
    if (v === "custom") {
      const p = await ui.input(`${comp.title} 압축 파일 경로`, {
        initial: downloadsDir ? join(downloadsDir, comp.zipRoot === "sqlcl" ? "sqlcl-latest.zip" : "chrome-win64.zip") : "",
        validate: (s) => (!s ? "경로를 입력하세요" : !existsSync(s) ? "파일이 없습니다" : null),
      });
      if (p === BACK) continue;
      file = resolve(p);
    }
    const r = await ui.task(`파일 확인 (sha256) ${file}`, async () => checkArchive(ROOT, name, file));
    if (r.match) return file;
    const go = await ui.confirm(`manifest 에 고정된 ${comp.title} ${r.version} 파일과 다릅니다 (다른 버전일 수 있음). 이 파일로 설치할까요?`,
      { initial: false, note: c.gray(`  기대 ${r.expected}\n  실제 ${r.actual}`) });
    if (go) return file;
  }
}

/** 선택 단계 = SQLcl → 브라우저. 브라우저에서 이전을 누르면 SQLcl 로 돌아간다 */
async function stepOptional(state) {
  for (;;) {
    if ((await stepSqlcl(state)) === BACK) return BACK;
    if ((await stepBrowser(state)) === BACK) continue;
    return "next";
  }
}

async function stepSqlcl(state) {
  const target = state.installDir;
  if (target && isInstalled("sqlcl", target)) {
    const v = await ui.select("Oracle SQLcl", [
      { label: "설치된 SQLcl 유지", value: "keep" },
      { label: "다른 파일로 교체", value: "replace" },
    ], { note: `  ${OPTIONAL.sqlcl.purpose}` });
    if (v === BACK) return BACK;
    if (v === "keep") state.sqlcl = { action: "keep" };
    else {
      const a = await pickArchive("sqlcl", { skipLabel: "교체하지 않음 (유지)" });
      if (a === BACK) return stepSqlcl(state);
      state.sqlcl = a === "skip" ? { action: "keep" } : { action: "install", archive: a };
    }
  } else if (hasComponent("sqlcl", ROOT)) {
    // 사용자가 fetch 로 받아 번들에 넣어 온 SQLcl
    const v = await ui.select("Oracle SQLcl", [
      { label: "번들에 포함된 SQLcl 설치", value: "bundle" },
      { label: "다른 zip 으로 설치", value: "zip" },
      { label: "설치하지 않음", value: "skip" },
    ], { note: `  ${OPTIONAL.sqlcl.purpose}
  ${c.gray("라이선스")} ${OPTIONAL.sqlcl.license}` });
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

async function stepBrowser(state) {
  const target = state.installDir;
  // agent-browser 를 반입하지 않았으면 브라우저 선택은 의미가 없다
  if (!hasComponent("agent-browser", ROOT) && !(target && hasComponent("agent-browser", target))) {
    state.browser = { id: "none", label: "사용 안 함 (agent-browser 미포함)" };
    return "next";
  }

  // 2) agent-browser 가 쓸 브라우저 (다른 런타임에 의존하는 도구: 선택지 + 추천 표시)
  for (;;) {
    const choices = browserChoices(ROOT);
    const cftReady = Boolean(target && isInstalled("chrome", target));
    const opts = choices.map((b) => ({
      label: b.recommended ? `${b.label}  ${c.green("(추천)")}` : b.label,
      value: b.id,
      hint: b.id === "chrome-for-testing" && cftReady ? "이미 설치됨" : b.hint,
    }));
    const initial = Math.max(0, opts.findIndex((o) => o.value === (state.browser?.id ?? "chrome-for-testing")));
    const id = await ui.select("agent-browser 가 사용할 브라우저", opts, {
      initial, note: c.gray("  web-page-automation skill 이 이 브라우저로 사내 웹 페이지를 엽니다. 나중에 '설정 변경'에서 바꿀 수 있습니다."),
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

/** 번들에 들어 있지만 사용자가 고르지 않은 구성요소는 설치 위치로 복사하지 않는다 */
function copyExcludes(state) {
  const ex = [];
  if (state.sqlcl?.action !== "bundle") ex.push("runtime/sqlcl");
  if (state.browser?.id !== "chrome-for-testing" || state.browser?.archive) ex.push("vendor/browsers/chrome-win64");
  if (state.browser?.id !== "chromium") ex.push("vendor/browsers/chromium");
  return ex;
}

async function applyOptional(state) {
  if (state.sqlcl?.action === "install") {
    await ui.task("Oracle SQLcl 설치", async () => { installOptional("sqlcl", state.sqlcl.archive, state.installDir); });
  }
  if (state.browser?.archive) {
    await ui.task("Chrome for Testing 설치", async () => { installOptional("chrome", state.browser.archive, state.installDir); });
  }
}

async function notice(msg) {
  ui.screen(`  ${c.yellow("!")} ${msg}`);
  await ui.pause();
}

// ------------------------------------------------------------------ 단계: vLLM
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
  if (models.length === 0) throw new Error("모델 목록이 비어 있음");
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
    const url = await ui.input("사내 vLLM 주소 (OpenAI 호환 엔드포인트)", {
      initial: state.baseUrl ?? "http://",
      hint: "예: http://vllm.example.internal:8000/v1   (/v1 이 없으면 자동으로 붙입니다)",
      validate: (v) => { try { const u = new URL(v.trim()); return /^https?:$/.test(u.protocol) && u.hostname ? null : "http:// 또는 https:// 주소를 입력하세요"; } catch { return "올바른 URL 이 아닙니다"; } },
    });
    if (url === BACK) return BACK;
    state.baseUrl = normalizeBaseUrl(url);

    const key = await ui.input("vLLM API 키", {
      initial: state.apiKey && state.apiKey !== "EMPTY" ? state.apiKey : "", mask: true,
      hint: "vLLM 을 --api-key 없이 띄웠다면 비워 두세요",
    });
    if (key === BACK) continue;
    state.apiKey = key || "EMPTY";

    ui.screen(`  ${c.bold("vLLM 연결 확인")}\n`);
    try {
      state.models = await ui.task(`${state.baseUrl}/models`, async () => fetchModels(state.baseUrl, state.apiKey));
      const probeModel = state.models.some((m) => m.id === state.coder) ? state.coder : state.models[0].id;
      const p = await ui.task(`확장 파라미터 지원 확인 (${probeModel})`, async () => probeParams(state.baseUrl, state.apiKey, probeModel));
      // 판단할 수 없으면 이전 값 유지
      if (p.results) state.dropParams = p.drop;
      const lines = p.results
        ? Object.entries(p.results).map(([k, v]) => "  " + (v ? ok(`${k}: 지원`) : warnMark(`${k}: 서버가 거부 → 요청에서 뺌`)))
        : ["  " + warnMark(`확장 파라미터: 확인 못 함 (기존 설정 유지) ${c.gray(p.detail)}`)];
      ui.print([
        "", "  " + ok(`모델 ${state.models.length}개: ${state.models.map((m) => m.id).join(", ")}`),
        ...lines,
        ...(p.results && p.detail ? ["  " + c.gray(`  ${p.detail}`)] : []),
      ].join("\n"));
      await ui.pause();
      // 사용량 제한이 있는 엔드포인트 (응답 헤더 x-ratelimit-limit-tokens) → 맞춤 설정 제안
      if (p.tpm && p.tpm <= RATE_LIMITED_TPM) {
        const preset = endpointPreset(p.tpm);
        const v = await ui.select(`사용량 제한이 있는 엔드포인트입니다 (분당 ${p.tpm.toLocaleString()} 토큰)`, [
          { label: "제한에 맞춘 설정 적용 (권장)", value: "apply" },
          { label: "설정 바꾸지 않음", value: "keep" },
        ], { back: false, note: [
          c.gray("  제한을 넘으면 요청이 거부됩니다. 적용하면 다음과 같이 맞춥니다 (Tweak 의 '엔드포인트 세부 설정'에서 바꿀 수 있음)."),
          c.gray(`    · 거부되면 서버가 알려 준 시간만큼 기다렸다 재시도 ${preset.retries}회`),
          c.gray(`    · 응답 최대 ${preset.maxOut} 토큰   · subagent 동시 실행 ${preset.concurrency}개`),
        ].join("\n") });
        if (v === "apply") state.endpoint = preset;
      }
      return "next";
    } catch (e) {
      const choice = await ui.select("vLLM 에 연결하지 못했습니다", [
        { label: "주소/키 다시 입력", value: "retry" },
        { label: "연결 확인 없이 계속 (모델명을 직접 입력)", value: "skip" },
      ], { back: false, note: `  ${c.red(e.cause?.code ?? e.message)}  ${c.gray(state.baseUrl)}` });
      if (choice === "skip") { state.models = []; return "next"; }
    }
  }
}

// ------------------------------------------------------------------ 단계: 모델
async function stepModel(state) {
  const list = state.models ?? [];
  if (list.length > 0) {
    const opts = list.map((m) => ({ label: m.id, value: m.id, hint: m.maxLen ? `${Math.round(m.maxLen / 1024)}K` : "" }));
    const coder = await ui.select("코딩용 모델 (기본 모델)", opts, { initial: Math.max(0, opts.findIndex((o) => o.value === state.coder)) });
    if (coder === BACK) return BACK;
    state.coder = coder;
    const rest = [...opts.filter((o) => o.value !== coder), { label: "사용 안 함", value: "" }];
    const general = await ui.select("범용(thinking) 모델 — 선택 사항", rest,
      { initial: Math.max(0, rest.findIndex((o) => o.value === (state.general ?? ""))), note: c.gray("  /model 명령으로 전환해서 쓰는 보조 모델입니다") });
    if (general === BACK) return stepModel(state);
    state.general = general;
  } else {
    const coder = await ui.input("코딩용 모델 이름 (vLLM --served-model-name)", { initial: state.coder ?? "", validate: (v) => (v ? null : "필수 입력") });
    if (coder === BACK) return BACK;
    state.coder = coder;
    const general = await ui.input("범용(thinking) 모델 이름 — 없으면 비워 두세요", { initial: state.general ?? "" });
    if (general === BACK) return stepModel(state);
    state.general = general === state.coder ? "" : general;
  }
  state.defaultModel = state.coder;

  const lens = list.filter((m) => [state.coder, state.general].includes(m.id) && m.maxLen).map((m) => m.maxLen);
  const detected = lens.length ? Math.min(...lens) : null;
  const ctx = await ui.input("컨텍스트 길이 (토큰)", {
    initial: String(detected ?? state.contextWindow ?? 131072),
    hint: detected ? `vLLM 이 알려준 max_model_len: ${detected}` : "vLLM --max-model-len 값과 맞추세요",
    validate: (v) => (/^\d+$/.test(v) && Number(v) >= 8192 ? null : "8192 이상의 숫자를 입력하세요"),
  });
  if (ctx === BACK) return stepModel(state);
  state.contextWindow = Number(ctx);

  // 모델 계열: thinking 제어 방식과 권장 샘플링 값이 정해진다 (id 로 추정한 값이 기본 선택)
  for (const [role, id] of [["coder", state.coder], ["general", state.general]]) {
    if (!id) continue;
    const key = role === "coder" ? "coderFamily" : "generalFamily";
    const detected = detectFamily(id);
    const opts = Object.entries(MODEL_FAMILIES).map(([k, f]) => ({ label: f.label, value: k, hint: k === detected ? "id 로 추정" : "" }));
    const fam = await ui.select(`${id} 의 모델 계열`, opts, {
      initial: Math.max(0, opts.findIndex((o) => o.value === (state[key] ?? detected))),
      note: c.gray("  thinking(추론) 을 켜고 끄는 방식과 권장 샘플링 값이 계열마다 다릅니다."),
    });
    if (fam === BACK) return stepModel(state);
    state[key] = fam;
  }
  return "next";
}

// ------------------------------------------------------------------ 단계: GitLab
async function stepGitlab(state) {
  const host = await ui.input("사내 GitLab 호스트 (glab) — 선택 사항", {
    initial: state.gitlabHost ?? "", hint: "예: gitlab.example.internal   (비워 두면 건너뜀. 토큰은 설치 후 glab auth login)",
    validate: (v) => (v === "" || /^[a-z0-9.-]+(:\d+)?$/i.test(v.replace(/^https?:\/\//, "").replace(/\/+$/, "")) ? null : "호스트 이름만 입력하세요"),
  });
  if (host === BACK) return BACK;
  state.gitlabHost = host.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return "next";
}

// ------------------------------------------------------------------ 단계: 등록
async function stepIntegrate(state) {
  const prev = state.integrations;
  const has = (k) => (prev ? prev.includes(k) : true);
  const v = await ui.multiselect("시스템 등록", [
    { label: "PATH 등록", value: "path", checked: has("path"), hint: "cmd / PowerShell / Git Bash 어디서든 oxy 실행" },
    { label: `Windows Terminal 프로필 '${WT_PROFILE_NAME}'`, value: "wt", checked: has("wt"), hint: "번들 환경이 적용된 Git Bash 탭" },
    { label: "바탕화면 바로가기", value: "shortcut", checked: has("shortcut"), hint: "Oxygen Pi.lnk" },
  ]);
  if (v === BACK) return BACK;
  state.integrations = v;
  return "next";
}

// ------------------------------------------------------------------ 단계: 확인
function summary(state) {
  const row = (k, v) => `    ${c.gray(k.padEnd(12))} ${v}`;
  return [
    row("설치 위치", `${state.installDir}${state.copy ? (state.update ? c.yellow("  (기존 설치 업데이트, 설정 유지)") : "") : c.gray("  (복사 안 함)")}`),
    row("vLLM", state.baseUrl),
    row("API 키", state.apiKey === "EMPTY" ? c.gray("없음") : "•".repeat(8)),
    row("코딩 모델", state.coder),
    row("코딩 모델 계열", state.coderFamily ?? detectFamily(state.coder)),
    row("범용 모델", state.general || c.gray("사용 안 함")),
    ...(state.general ? [row("범용 모델 계열", state.generalFamily ?? detectFamily(state.general))] : []),
    ...(state.endpoint ? [row("사용량 제한", `재시도 ${state.endpoint.retries}회 · 응답 최대 ${state.endpoint.maxOut ?? "모델 기본"} 토큰`)] : []),
    row("컨텍스트", `${state.contextWindow} 토큰`),
    row("GitLab", state.gitlabHost || c.gray("건너뜀")),
    ...(state.sqlcl ? [row("SQLcl", { keep: "설치된 것 유지", bundle: "번들에 포함된 것 설치", skip: c.gray("설치 안 함"), install: `설치  ${c.gray(state.sqlcl.archive ?? "")}` }[state.sqlcl.action])] : []),
    ...(state.browser ? [row("브라우저", `${state.browser.label ?? state.browser.id}${state.browser.archive ? c.gray("  " + state.browser.archive) : state.browser.path ? c.gray("  " + state.browser.path) : ""}`)] : []),
    ...(state.integrations ? [row("시스템 등록", state.integrations.length ? state.integrations.map((k) => ({ path: "PATH", wt: "Windows Terminal", shortcut: "바로가기" })[k]).join(", ") : c.gray("없음"))] : []),
  ].join("\n");
}

async function stepReview(state) {
  const v = await ui.select("설치 내용 확인", [
    { label: state.action ?? "설치 시작", value: "next" },
    { label: "이전 단계로", value: BACK },
    { label: "취소", value: "cancel" },
  ], { back: true, note: "\n" + summary(state) });
  return v;
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
  };
  writeFileSync(envFile, mergeEnv(base, updates));
  const vars = { ...parseEnv(readFileSync(envFile, "utf8")), OXY_SHELL_PATH: state.gitBash.replace(/\\/g, "/") };
  const n = renderConfig(agent, vars).length;
  // 설치된 구성요소에 해당하는 skill 만 켠다
  state.skills = syncSkills(installDir, agent, { browser: vars.OXY_BROWSER });
  return n;
}

async function applyIntegrations(state, reg) {
  const want = new Set(state.integrations ?? []);
  const dir = state.installDir;
  if (want.has("path")) await ui.task("PATH 등록", async () => { sys.addUserPath(dir); reg.path = true; });
  else if (reg.path) await ui.task("PATH 등록 해제", async () => { sys.removeUserPath(dir); reg.path = false; });
  if (want.has("wt")) await ui.task("Windows Terminal 프로필", async () => { reg.terminalProfile = sys.addTerminalProfile(dir, state.gitBash); });
  else if (reg.terminalProfile) await ui.task("Windows Terminal 프로필 제거", async () => { sys.removeTerminalProfile(reg.terminalProfile); reg.terminalProfile = null; });
  if (want.has("shortcut")) await ui.task("바탕화면 바로가기", async () => { reg.shortcut = sys.addShortcut(dir, state.gitBash, want.has("wt")); });
  else if (reg.shortcut) await ui.task("바탕화면 바로가기 제거", async () => { sys.removeShortcut(reg.shortcut); reg.shortcut = null; });
}

async function finishWithVerify(state) {
  const run = await ui.confirm("자가진단(verify)을 실행할까요?", { note: c.gray("  번들 도구, pi 설정, vLLM 연결과 tool calling 을 실제로 확인합니다 (약 30초)") });
  let passed = null;
  if (run) {
    ui.clear();
    ui.print(banner(VERSION));
    passed = sys.runVerify(state.installDir, state.gitBash);
  }
  return passed;
}

async function install(state) {
  if (!(await runSteps([stepCheck, stepLocation, stepOptional, stepVllm, stepModel, stepGitlab, stepIntegrate, stepReview], state, STEP_NAMES))) {
    ui.print("\n  설치를 취소했습니다.");
    return 1;
  }
  setFrame(STEP_NAMES.length, STEP_NAMES);
  ui.screen(`  ${c.bold("설치 중")}\n`);
  const reg = sys.loadRegistry() ?? {};
  try {
    if (state.copy) {
      await ui.task(`파일 복사 → ${state.installDir}`, async (update) => {
        const n = await sys.copyBundle(state.installDir, (d, t) => update(`${d}/${t} (${Math.floor((d / t) * 100)}%)`), copyExcludes(state));
        return `${n}개 파일`;
      });
    } else {
      await ui.task("설치 표시 기록", async () => sys.writeMarker(state.installDir));
    }
    await applyOptional(state);
    await ui.task("설정 생성 (oxy.env, settings.json, models.json)", async () => `${writeSiteConfig(state.installDir, state)}개 파일`);
    await applyIntegrations(state, reg);
    sys.saveRegistry({ ...reg, version: VERSION, installDir: state.installDir, copied: state.copy, gitBash: state.gitBash,
      integrations: state.integrations, installedAt: new Date().toISOString() });
  } catch {
    ui.print(`\n  ${c.red("설치 중 오류가 발생했습니다.")} 위 메시지를 확인하세요.`);
    await ui.pause("Enter 를 누르면 종료합니다");
    return 1;
  }
  const passed = await finishWithVerify(state);
  done(state, passed);
  await ui.pause("Enter 를 누르면 종료합니다");
  return 0;
}

function done(state, passed) {
  const lines = [
    "",
    `  ${c.green(c.bold(state.doneTitle ?? "설치 완료"))}  ${c.gray(state.installDir)}`,
    passed === false ? `  ${c.yellow("! 자가진단에 FAIL/WARN 이 있습니다. 위 결과를 확인하세요.")}` : "",
    "",
    `  ${c.bold("시작하기")}`,
    state.integrations?.includes("wt") ? `    • Windows Terminal 에서 새 탭 → '${WT_PROFILE_NAME}' 프로필` : "",
    state.integrations?.includes("path") ? "    • 새로 연 터미널에서 프로젝트 폴더로 이동한 뒤  oxy" : `    • ${state.installDir}\\oxy.cmd`,
    state.gitlabHost ? `    • GitLab 토큰 등록:  glab auth login --hostname ${state.gitlabHost}` : "",
    state.sqlcl?.action === "skip" ? "    • SQLcl 은 나중에 직접 받은 zip 으로 추가할 수 있습니다 (install.cmd → 설정 변경)" : "",
    "    • DB 연결·extension 등 종합 설정:  설치 폴더의 tweak.cmd",
    "    • 업데이트·제거:  install.cmd 를 다시 실행",
  ];
  ui.print(lines.filter((l) => l !== "").join("\n"));
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
  const state = { ...stateFromInstall(reg), action: "설정 적용", doneTitle: "설정 변경 완료" };
  const names = ["선택", "vLLM", "모델", "GitLab", "등록", "확인"];
  const ok2 = await runSteps([stepOptional, stepVllm, stepModel, stepGitlab, stepIntegrate, stepReview], state, names, { backExits: true });
  if (!ok2) return 1;
  setFrame(names.length, names);
  ui.screen(`  ${c.bold("설정 적용 중")}\n`);
  await applyOptional(state);
  await ui.task("설정 생성", async () => `${writeSiteConfig(state.installDir, state)}개 파일`);
  await applyIntegrations(state, reg);
  if (saveRegistry) sys.saveRegistry({ ...reg, integrations: state.integrations, updatedAt: new Date().toISOString() });
  const passed = await finishWithVerify(state);
  done(state, passed);
  await ui.pause();
  return 0;
}

async function uninstall(reg) {
  const keep = await ui.select("제거", [
    { label: "제거 (설정 파일은 백업)", value: "backup", hint: sys.registryFile.replace(/install\.json$/, "oxy.env.bak") },
    { label: "취소", value: "cancel" },
  ], {
    back: false,
    note: c.gray(`  PATH·Windows Terminal 프로필·바로가기 등록을 해제하고${reg.copied ? ` ${reg.installDir} 를 삭제합니다` : " 설치 기록을 지웁니다 (폴더는 남김)"}.`),
  });
  if (keep !== "backup") return 1;
  setFrame();
  ui.screen(`  ${c.bold("제거 중")}\n`);
  const envFile = join(reg.installDir, "agent", "oxy.env");
  const backup = sys.registryFile.replace(/install\.json$/, "oxy.env.bak");
  const backupText = existsSync(envFile) ? readFileSync(envFile, "utf8") : null;
  if (reg.path) await ui.task("PATH 등록 해제", async () => sys.removeUserPath(reg.installDir));
  if (reg.terminalProfile) await ui.task("Windows Terminal 프로필 제거", async () => sys.removeTerminalProfile(reg.terminalProfile));
  if (reg.shortcut) await ui.task("바탕화면 바로가기 제거", async () => sys.removeShortcut(reg.shortcut));
  await ui.task("설치 기록 삭제", async () => sys.removeRegistry());
  if (backupText) {
    mkdirSync(dirname(backup), { recursive: true });
    writeFileSync(backup, backupText);
    ui.print(`  ${c.gray("설정 백업: " + backup)}`);
  }
  let scheduled = false;
  if (reg.copied) {
    await ui.task(`설치 폴더 삭제 ${reg.installDir}`, async () => {
      const r = sys.removeInstallDir(reg.installDir);
      scheduled = r === "scheduled";
      return scheduled ? "이 창을 닫으면 삭제됩니다" : "";
    });
  }
  ui.print(`\n  ${c.green("제거 완료")}`);
  await ui.pause("Enter 를 누르면 종료합니다");
  return 0;
}

async function manage(reg) {
  for (;;) {
    setFrame();
    const sameBundle = sys.isSameDir(ROOT, reg.installDir);
    const choice = await ui.select("oxygen-pi-system 이 이미 설치되어 있습니다", [
      { label: "설정 변경", value: "reconfigure", hint: "vLLM 주소·모델·GitLab·시스템 등록" },
      { label: "자가진단", value: "verify" },
      ...(sameBundle ? [] : [{ label: `이 번들로 업데이트 (v${reg.version ?? "?"} → v${VERSION})`, value: "update", hint: "설정 유지" }]),
      { label: "제거", value: "uninstall" },
      { label: "종료", value: "exit" },
    ], { back: false, note: `    ${c.gray("위치")} ${reg.installDir}   ${c.gray("버전")} v${reg.version ?? "?"}   ${c.gray("설치")} ${(reg.updatedAt ?? reg.installedAt ?? "").slice(0, 10)}` });
    if (choice === "exit") return 0;
    if (choice === "reconfigure") return reconfigure(reg);
    if (choice === "uninstall") { const r = await uninstall(reg); if (r === 0) return 0; continue; }
    if (choice === "verify") {
      ui.clear(); ui.print(banner(VERSION));
      const gitBash = reg.gitBash && existsSync(reg.gitBash) ? reg.gitBash : sys.findGitBash();
      sys.runVerify(reg.installDir, gitBash);
      await ui.pause();
      continue;
    }
    if (choice === "update") {
      const state = { ...stateFromInstall(reg), copy: true, update: true, doneTitle: "업데이트 완료" };
      setFrame();
      ui.screen(`  ${c.bold("업데이트 중")}\n`);
      try {
        await ui.task(`파일 복사 → ${state.installDir}`, async (update) => {
          const n = await sys.copyBundle(state.installDir, (d, t) => update(`${d}/${t} (${Math.floor((d / t) * 100)}%)`), copyExcludes(state));
          return `${n}개 파일`;
        });
        await ui.task("설정 다시 생성", async () => `${writeSiteConfig(state.installDir, state)}개 파일`);
        reg.version = VERSION;
        sys.saveRegistry({ ...reg, updatedAt: new Date().toISOString() });
      } catch { await ui.pause(); continue; }
      const passed = await finishWithVerify(state);
      done(state, passed);
      await ui.pause();
      return 0;
    }
  }
}

// ------------------------------------------------------------------ main
async function main() {
  const reg = sys.loadRegistry();
  if (reg?.installDir && existsSync(reg.installDir)) return manage(reg);
  return install({});
}

// Tweak TUI(installer/tweak.mjs) 가 import 해서 쓸 수 있도록, 직접 실행할 때만 main 을 돈다
export {
  ui, sys, ROOT, VERSION, setFrame, finishWithVerify, reconfigure, stateFromInstall, writeSiteConfig,
  stepSqlcl, stepBrowser, stepVllm, stepModel, stepGitlab, stepIntegrate, applyOptional, applyIntegrations, fetchModels,
};

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  let code = 1;
  try {
    if (sys.sandbox) process.stdout.write(c.yellow(`[sandbox] 시스템 대신 ${sys.sandbox} 에만 기록합니다\n`));
    code = await main();
  } catch (e) {
    process.stdout.write(`\n${c.red("오류:")} ${e.stack ?? e}\n`);
  } finally {
    ui.close();
    process.stdout.write("\x1b[?25h");
  }
  process.exit(code);
}
