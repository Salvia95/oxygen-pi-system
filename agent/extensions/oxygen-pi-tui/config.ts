// 설정 파일 <agent>/oxygen-pi-tui.json (docs/pi-tui-spec.md §2). 기본으로 켜진다 (D4).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { GlyphMode } from "./glyphs.ts";

export interface TuiConfig { enabled: boolean; glyphs: GlyphMode }

export const DEFAULT_CONFIG: TuiConfig = { enabled: true, glyphs: "unicode" };

/** 파일 내용 → 설정. 깨졌거나 모르는 값은 기본값 */
export function parseConfig(text: string | null): TuiConfig {
  let raw: any = {};
  try { raw = text ? JSON.parse(text) : {}; } catch { raw = {}; }
  return {
    enabled: typeof raw?.enabled === "boolean" ? raw.enabled : DEFAULT_CONFIG.enabled,
    glyphs: raw?.glyphs === "ascii" ? "ascii" : "unicode",
  };
}

export function loadConfig(file: string): TuiConfig {
  return parseConfig(existsSync(file) ? readFileSync(file, "utf8") : null);
}

export function saveConfig(file: string, cfg: TuiConfig): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`);
  renameSync(tmp, file);
}
