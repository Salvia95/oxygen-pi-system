// Oxygen 시그니처 색 (.claude/rules/oxygen-design.md). 이 extension 에서 16진 색을 쓰는 곳은 이 파일 하나다.
// 시그니처 색은 브랜드 표식과 작업 중 입력창 테두리에만 쓴다 (docs/pi-tui-spec.md §2). 상태의 뜻은 테마 토큰으로.

export type BrandColor = "sage" | "mid" | "shadow" | "white" | "purple";
export type ColorMode = "truecolor" | "256color";
export type Appearance = "dark" | "light";

/** 값의 원본은 installer/oxy-tui/src/theme.rs (DARK_BG · LIGHT_BG). 256색은 [어두운 배경, 밝은 배경] */
export const BRAND: Record<BrandColor, { dark: string; light: string; ansi256: [number, number] }> = {
  sage: { dark: "#A9CBA4", light: "#3A6652", ansi256: [151, 65] },
  mid: { dark: "#7FA98A", light: "#4C7A62", ansi256: [108, 65] },
  shadow: { dark: "#3A5A4D", light: "#A9CBA4", ansi256: [59, 151] },
  white: { dark: "#F1F7EE", light: "#1E2E28", ansi256: [255, 235] },
  purple: { dark: "#A798D7", light: "#7459B4", ansi256: [140, 97] },
};

export function hexRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.replace(/^#/, ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export interface BrandEnv { mode: ColorMode; appearance: Appearance; noColor?: boolean }

/** 글자색을 여는 SGR (색을 끄면 빈 글) */
export function brandOpen(name: BrandColor, env: BrandEnv): string {
  if (env.noColor) return "";
  const c = BRAND[name];
  if (env.mode === "truecolor") {
    const [r, g, b] = hexRgb(env.appearance === "light" ? c.light : c.dark);
    return `\x1b[38;2;${r};${g};${b}m`;
  }
  return `\x1b[38;5;${c.ansi256[env.appearance === "light" ? 1 : 0]}m`;
}

/** 시그니처 색으로 칠한 글. 글자색만 되돌린다 (굵기 등 바깥 스타일은 둔다) */
export function brandFg(name: BrandColor, text: string, env: BrandEnv): string {
  const open = brandOpen(name, env);
  return open ? `${open}${text}\x1b[39m` : text;
}

/** pi 테마(Theme)에서 색 환경을 읽는다. NO_COLOR 가 있으면 색을 끈다 */
export function brandEnv(theme: { getColorMode?: () => string; appearance?: string } | undefined, env: NodeJS.ProcessEnv = process.env): BrandEnv {
  const mode = theme?.getColorMode?.() === "truecolor" ? "truecolor" : "256color";
  const appearance = theme?.appearance === "light" ? "light" : "dark";
  return { mode, appearance, noColor: Boolean(env.NO_COLOR) };
}

/**
 * 배너 `O²xyGEN PI` 의 색 (installer/oxy-tui/src/theme.rs 의 DARK_BG · LIGHT_BG 와 같은 값. 다르면 theme.rs 가 맞다).
 * rows6: 큰 글자의 줄별 색 (마지막은 그림자 선), pi6: `PI` 의 줄별 색, white: `2`, mid: `xy`
 */
export const BANNER = {
  dark: {
    white: "#F1F7EE", mid: "#7FA98A",
    rows6: ["#C6DDBF", "#B3D0AE", "#9FC19E", "#8CB28F", "#79A281", "#3A5A4D"],
    pi6: ["#D3CBEF", "#C4B9E7", "#B5A8DF", "#A798D7", "#9383C8", "#51467D"],
  },
  light: {
    white: "#1E2E28", mid: "#4C7A62",
    rows6: ["#2F4A3F", "#365547", "#3D604F", "#456C58", "#4C7A62", "#A9CBA4"],
    pi6: ["#564092", "#60489E", "#6A51A9", "#7459B4", "#8269BE", "#C9BFE6"],
  },
} as const;

/** 24비트 색을 xterm 256색 번호로 (6×6×6 큐브 · 회색 단계 중 가까운 것) */
export function ansi256(hex: string): number {
  const [r, g, b] = hexRgb(hex);
  const cube = [0, 95, 135, 175, 215, 255];
  const near = (v: number) => cube.reduce((bi, c, i) => (Math.abs(c - v) < Math.abs(cube[bi] - v) ? i : bi), 0);
  const [ri, gi, bi] = [near(r), near(g), near(b)];
  const cubeD = (cube[ri] - r) ** 2 + (cube[gi] - g) ** 2 + (cube[bi] - b) ** 2;
  const grayLevel = Math.max(0, Math.min(23, Math.round(((r + g + b) / 3 - 8) / 10)));
  const gv = 8 + grayLevel * 10;
  const grayD = (gv - r) ** 2 + (gv - g) ** 2 + (gv - b) ** 2;
  return grayD < cubeD ? 232 + grayLevel : 16 + 36 * ri + 6 * gi + bi;
}

/** 임의 색의 글자색(fg) · 바탕색(bg) SGR 여는 글 (색을 끄면 빈 글) */
export function hexOpen(hex: string, env: BrandEnv, bg = false): string {
  if (env.noColor) return "";
  if (env.mode === "truecolor") { const [r, g, b] = hexRgb(hex); return `\x1b[${bg ? 48 : 38};2;${r};${g};${b}m`; }
  return `\x1b[${bg ? 48 : 38};5;${ansi256(hex)}m`;
}
