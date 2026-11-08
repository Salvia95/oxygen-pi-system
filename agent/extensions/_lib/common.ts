// oxy extension 공통 유틸. `_lib/` 에는 index.ts 가 없으므로 pi 가 extension 으로 로드하지 않는다.
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
