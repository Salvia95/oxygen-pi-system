// oxy extension 공통 유틸. `_lib/` 에는 index.ts 가 없으므로 pi 가 extension 으로 로드하지 않는다.
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve, win32 } from "node:path";

/** 환경변수 on/off 스위치. 기본값은 on. `OXY_<NAME>=off|0|false` 로 끈다. */
export function enabled(name: string): boolean {
  const v = process.env[`OXY_${name}`]?.trim().toLowerCase();
  return !(v === "off" || v === "0" || v === "false");
}

export function envInt(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * 도구 인자로 들어온 경로를 비교용 키로 정규화한다. pi 의 경로 해석 규칙과 맞춘다.
 * - 앞의 `@` 제거, `~` 확장
 * - Git Bash 경로 `/c/foo`, `/cygdrive/c/foo`, `/mnt/c/foo` → `C:/foo`
 * - cwd 기준 절대경로화, Windows 에서는 대소문자 무시
 */
export function pathKey(input: string, cwd: string): string {
  let p = input.trim();
  if (p.startsWith("@")) p = p.slice(1);
  if (process.platform === "win32") {
    const m = p.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
    if (m) p = `${m[1].toUpperCase()}:/${m[2] ?? ""}`;
  }
  if (p === "~") p = homedir();
  else if (p.startsWith("~/") || p.startsWith("~\\")) p = `${homedir()}/${p.slice(2)}`;
  const abs = isAbsolute(p) ? resolve(p) : resolve(cwd, p);
  return process.platform === "win32" ? win32.normalize(abs).toLowerCase() : abs;
}

/**
 * 하네스 루트(OXY_HOME)를 Node 가 쓸 수 있는 경로로. env.sh 는 Git Bash 경로(/c/Users/…)로 내보내고, 보통은 Git Bash 가
 * node 를 실행할 때 C:/Users/… 로 바꿔 준다. 그런데 MSYS_NO_PATHCONV=1 (docker 등을 위해 켜 둔 사용자)이면 바꾸지 않아
 * LLM 연결 · psmux 를 찾지 못한다 (2026-11-12 실측). 없으면 fallback.
 */
export function harnessHome(fallback?: string): string | undefined {
  const h = process.env.OXY_HOME?.trim();
  if (!h) return fallback;
  if (process.platform === "win32") {
    const m = h.match(/^\/(?:cygdrive\/)?([a-zA-Z])(\/.*)?$/);
    if (m) return `${m[1].toUpperCase()}:${m[2] ?? "/"}`;
  }
  return h;
}

/** 모델에게 돌려주는 차단 사유. 소형 모델이 다음 행동을 바로 알 수 있도록 짧고 지시적으로. */
export function blocked(rule: string, message: string): string {
  return `BLOCKED by oxy-${rule}: ${message}`;
}

/** tool result content 배열에서 텍스트만 이어 붙인다. */
export function textOf(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content
    .filter((c: any) => c?.type === "text" && typeof c.text === "string")
    .map((c: any) => c.text as string)
    .join("\n");
}

const pause = new Int32Array(new SharedArrayBuffer(4));
/**
 * 임시 파일에 쓰고 이름을 바꿔 파일을 한 번에 교체한다 (읽는 쪽이 반쯤 쓴 내용을 보지 않게).
 * Windows 에서는 다른 프로세스(모니터 pane)가 그 파일을 읽는 순간 이름 바꾸기가 EPERM · EACCES · EBUSY 로 실패한다
 * (모니터가 1초마다 읽는 동안 실측 3번에 1번꼴). 잠깐 쉬며 다시 시도한다: 최대 tries 번, 모두 합쳐 약 1초.
 */
export function writeAtomic(file: string, text: string, tries = 20): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  for (let i = 1; ; i++) {
    try { renameSync(tmp, file); return; } catch (e: any) {
      if (i >= tries || !["EPERM", "EACCES", "EBUSY"].includes(e?.code)) { rmSync(tmp, { force: true }); throw e; }
      Atomics.wait(pause, 0, 0, Math.min(5 * i, 100));
    }
  }
}
