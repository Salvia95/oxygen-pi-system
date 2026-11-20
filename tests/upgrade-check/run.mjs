// 구성요소 업데이트 검증 실행 (docs/upgrade-check-spec.md §4): 바뀐 구성요소를 찾아 영향 표(map.tsv)의 자동 검사를 모두 돌리고 기록한다.
//   just upgrade-check [이름 …]      # 이름이 없으면 마지막 통과 기록과 lock 을 비교해 바뀐 것. 기록이 없으면 전부
//   node tests/upgrade-check/run.mjs --gate   # 번들링 막기: 지금 lock 으로 통과한 기록이 없으면 이유를 출력하고 종료코드 1
// 기록: tests/upgrade-check/results.jsonl (한 줄 = 한 번 실행). 검사별 로그: .cache/upgrade-check/<검사>.log
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { plan, readMap } from "./map.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const RESULTS = join(ROOT, "tests", "upgrade-check", "results.jsonl");

const sha = (s) => createHash("sha256").update(s).digest("hex");
const readText = (f) => (existsSync(f) ? readFileSync(f, "utf8").replace(/\r\n/g, "\n") : "");

/** 구성요소마다의 지문: lock 행(버전 · 주소 · sha256) + npm 이면 그 lockfile. 번들에 들어가는 manifest 만 (dev-* 는 빼고) */
export function fingerprints(root = ROOT) {
  const out = {};
  for (const l of readText(join(root, "manifest", "tools.lock.tsv")).split("\n")) {
    if (!l || l.startsWith("#")) continue;
    const [name, version, url, s] = l.split("\t");
    const npm = s === "npm-lock" ? sha(readText(join(root, "manifest", `${name}-package-lock.json`))).slice(0, 16) : "";
    out[name] = `${version} ${sha(`${url}\t${s}\t${npm}`).slice(0, 16)}`;
  }
  return out;
}

/** 지문 전체를 하나로 (기록과 지금 lock 이 같은지) */
export const lockId = (fp) => sha(Object.keys(fp).sort().map((k) => `${k}=${fp[k]}`).join("\n")).slice(0, 16);

export function readResults(file = RESULTS) {
  return readText(file).split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** 지난 통과 기록과 비교해 바뀐 구성요소 (기록이 없으면 전부). 버전이 바뀐 것은 "이름 이전 → 지금" 설명을 함께 */
export function changedSince(fp, results) {
  const last = [...results].reverse().find((r) => r.pass);
  if (!last) return { names: Object.keys(fp), notes: ["지난 통과 기록 없음 → 전부"] };
  const names = [], notes = [];
  for (const [n, v] of Object.entries(fp)) {
    const was = last.lock?.[n];
    if (was === v) continue;
    names.push(n);
    notes.push(was ? `${n} ${was.split(" ")[0]} → ${v.split(" ")[0]}${was.split(" ")[0] === v.split(" ")[0] ? " (lock 내용)" : ""}` : `${n} 새 구성요소`);
  }
  return { names, notes };
}

/** 번들링 막기 (D2): 지금 lock 으로 자동 검사를 통과한 기록이 있는가. 없으면 이유 문장 */
export function gateProblem(fp, results) {
  const id = lockId(fp);
  if (results.some((r) => r.pass && r.lockId === id)) return null;
  const { notes } = changedSince(fp, results);
  return `지금 lock 으로 업데이트 검증을 통과한 기록이 없습니다 (${notes.join(", ") || "기록과 lock 이 다름"}) → just upgrade-check`;
}

/** 검사 이름 → 실행할 bash 명령 · 통과 표시로 남길 줄을 고르는 정규식 */
export function commandOf(check, tools) {
  const node = "./runtime/node/node.exe";
  switch (check) {
    case "hygiene": return { cmd: `bash tests/repo-hygiene.sh && ${node} tests/board-check.mjs`, line: /진행판 검사 통과.*|저장소 위생 검사 통과|FAIL .*/ };
    case "unit": return { cmd: `${node} --experimental-strip-types --no-warnings --test tests/unit-extensions.test.ts tests/unit-tui.test.mjs tests/unit-upgrade.test.mjs`, line: /^# (pass|fail) \d+/ };
    case "contract": return { cmd: `${node} --experimental-strip-types --no-warnings tests/upgrade-check/pi-contract.mjs`, line: /pi 계약 검사 .*|FAIL .*/ };
    case "typecheck": return { cmd: `test -f .cache/dev/node_modules/typescript/bin/tsc || { echo "typescript 없음 → just fetch --dev"; exit 1; }; ${node} .cache/dev/node_modules/typescript/bin/tsc -p tests/upgrade-check/tsconfig.json && echo "타입 검사 통과"`, line: /타입 검사 통과|error TS\d+.*|typescript 없음.*/ };
    case "tools": return { cmd: `bash tests/upgrade-check/tools.sh ${tools.join(" ")}`, line: /도구 확인 .*|FAIL .*/ };
    case "rust": return { cmd: `cd installer/oxy-tui && PATH="$HOME/.cargo/bin:$PATH" cargo test --release --locked`, line: /test result: .*|error.*/ };
    case "e2e": return { cmd: "bash tests/e2e-mock.sh", line: /E2E (통과|실패).*|FAIL .*/ };
    case "installer": return { cmd: "bash tests/installer-sandbox.sh", line: /설치 TUI 테스트 .*|FAIL .*|\[fail\].*/ };
    default: throw new Error(`모르는 검사: ${check}`);
  }
}

const LABEL = { hygiene: "위생 · 진행판", unit: "단위", contract: "pi 계약", typecheck: "타입 검사", tools: "도구 확인", rust: "oxy-tui (Rust)", e2e: "E2E (mock)", installer: "설치 흐름 (sandbox)" };
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\r/g, "");

/** 결과 줄: 실패면 첫 실패 줄, 아니면 마지막으로 맞는 줄 (단위는 pass · fail 두 줄) */
export function resultLine(out, re, ok) {
  const lines = strip(out).split("\n").map((l) => l.trim().match(re)?.[0]).filter(Boolean);
  if (!ok) return lines.find((l) => /FAIL|fail \d|error|실패|없음/.test(l) && !/# fail 0/.test(l)) ?? lines.at(-1) ?? "(결과 줄 없음 — 로그 확인)";
  const unit = lines.filter((l) => /^# (pass|fail) /.test(l));
  return unit.length ? unit.slice(-2).join(" · ") : lines.at(-1) ?? "(결과 줄 없음)";
}

function git(args) { const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" }); return r.status === 0 ? r.stdout.trim() : ""; }

async function main(argv) {
  const fp = fingerprints();
  const results = readResults();
  if (argv.includes("--gate")) {
    const p = gateProblem(fp, results);
    if (p) { console.log(p); process.exit(1); }
    console.log("업데이트 검증 기록 확인 (지금 lock 으로 통과)");
    return;
  }
  const map = readMap(ROOT);
  const asked = argv.filter((a) => !a.startsWith("-"));
  for (const n of asked) if (!(n in fp)) { console.error(`모르는 구성요소: ${n} (manifest/tools.lock.tsv)`); process.exit(2); }
  const { names, notes } = asked.length ? { names: asked, notes: asked.map((n) => `${n} (지정)`) } : changedSince(fp, results);
  const p = plan(map, names);
  const rev = git(["rev-parse", "--short", "HEAD"]);
  const dirty = git(["status", "--porcelain"]) !== "";
  console.log(`구성요소 업데이트 검증 — ${names.length ? `바뀐 것: ${notes.join(", ")}` : "바뀐 구성요소 없음"}  (기준: HEAD ${rev}${dirty ? " + 미커밋" : ""})`);
  const logDir = join(ROOT, ".cache", "upgrade-check");
  mkdirSync(logDir, { recursive: true });
  const checks = {};
  for (const c of p.checks) {
    const { cmd, line } = commandOf(c, p.tools);
    process.stdout.write(`  …    ${LABEL[c]}\r`);
    const t0 = Date.now();
    const r = spawnSync("bash", ["-c", cmd], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    // 프로세스가 뜨지 못했거나(메모리 부족 등) 신호로 끝나면 출력이 비므로 그 이유를 결과 줄로 남긴다
    const why = r.error ? `FAIL 실행 못 함: ${r.error.message}` : r.signal ? `FAIL 신호로 끝남: ${r.signal}` : "";
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}${why ? `\n${why}\n` : ""}`;
    writeFileSync(join(logDir, `${c}.log`), strip(out));
    const ok = r.status === 0;
    checks[c] = { ok, line: resultLine(out, line, ok), sec: Math.round((Date.now() - t0) / 1000) };
    console.log(`  ${ok ? "PASS" : "FAIL"} ${LABEL[c].padEnd(16)} ${checks[c].line}  (${checks[c].sec}초)`);
  }
  const pass = Object.values(checks).every((x) => x.ok);
  if (p.manual.length) { console.log("남은 실측 (사람):"); for (const m of p.manual) console.log(`  - ${m}`); }
  appendFileSync(RESULTS, JSON.stringify({
    at: new Date().toISOString(), rev, dirty, changed: names, lockId: lockId(fp), lock: fp, pass, checks, manual: p.manual,
  }) + "\n");
  console.log(pass ? `업데이트 검증 통과 — 기록: tests/upgrade-check/results.jsonl (lock ${lockId(fp)})` : `업데이트 검증 실패 — 로그: .cache/upgrade-check/<검사>.log`);
  process.exit(pass ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main(process.argv.slice(2));
