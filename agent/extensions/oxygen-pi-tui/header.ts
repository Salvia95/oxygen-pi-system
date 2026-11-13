// 헤더 = 웰컴 카드 (docs/pi-tui-spec.md §3) 순수 함수. pi 를 띄울 때 대화 맨 위에 한 번 나오고 위로 밀려 올라간다.
// 로고는 설치 TUI 의 확정 배너 `O²xyGEN PI` 를 그대로 옮긴다 (installer/oxy-tui/src/banner.rs · theme.rs).
// 그 아래 부제 두 줄과 저장소 주소. 모델 · 폴더처럼 푸터 · 입력창 테두리와 겹치는 것은 넣지 않는다. 오른쪽 열은 두지 않는다.
import { BANNER, type BrandEnv, hexOpen } from "./brand.ts";
import type { Glyphs } from "./glyphs.ts";
import { type Measure, type WidthClass } from "./layout.ts";

export interface HeaderInfo {
  version: string;          // Oxygen Pi (VERSION 파일)
}

export interface HeaderPaint {
  brand(s: string): string;   // o2.sage + bold
  pi(s: string): string;      // pi.purple + bold
  frame(s: string): string;   // 카드 테두리 (o2.mid)
  text(s: string): string;
  muted(s: string): string;
  accent(s: string): string;
  sub(s: string): string;     // 부제 (o2.mid)
  /** 배너 색 환경 (색을 끄면 같은 글자를 색 없이) */
  env: BrandEnv;
}


// ---- 배너 (banner.rs 의 lines() 큰 배너와 같은 글자 · 색) ----

const SHADOW: Record<string, string[]> = {
  O: [" ██████╗ ", "██╔═══██╗", "██║   ██║", "██║   ██║", "╚██████╔╝", " ╚═════╝ "],
  G: [" ██████╗ ", "██╔════╝ ", "██║  ███╗", "██║   ██║", "╚██████╔╝", " ╚═════╝ "],
  E: ["███████╗", "██╔════╝", "█████╗  ", "██╔══╝  ", "███████╗", "╚══════╝"],
  N: ["███╗   ██╗", "████╗  ██║", "██╔██╗ ██║", "██║╚██╗██║", "██║ ╚████║", "╚═╝  ╚═══╝"],
  P: ["██████╗ ", "██╔══██╗", "██████╔╝", "██╔═══╝ ", "██║     ", "╚═╝     "],
  I: ["██╗", "██║", "██║", "██║", "██║", "╚═╝"],
};

export const BANNER_WIDTH = 57;   // banner.rs 의 59칸에서 앞 여백 2칸을 뺀 것

function shadowWord(word: string, ramp: readonly string[], env: BrandEnv): string[] {
  return Array.from({ length: 6 }, (_, r) =>
    [...word].flatMap((ch) => [...SHADOW[ch][r]]).map((c) => (c === " " ? " " : `${hexOpen(c === "█" ? ramp[r] : ramp[5], env)}${c}`)).join("") + (env.noColor ? "" : "\x1b[39m"));
}

/** 작은 글자 기둥 (7칸 × 6줄): 위에 `2`, 그 아래 `xy`. 3×5 픽셀 글자꼴을 반 칸 블록으로 */
function smallColumn(env: BrandEnv, pal: { white: string; mid: string }): string[] {
  const grid: (string | null)[][] = Array.from({ length: 12 }, () => Array(7).fill(null));
  const put = (glyph: string[], x0: number, y0: number, color: string) =>
    glyph.forEach((row, dy) => [...row].forEach((c, dx) => { if (c === "█") grid[y0 + dy][x0 + dx] = color; }));
  put(["██ ", "  █", " █ ", "█  ", "███"], 0, 0, pal.white);
  put(["█ █", " █ ", "█ █"], 0, 7, pal.mid);
  put(["█ █", "█ █", " ██", "  █", " █ "], 4, 7, pal.mid);
  const cell = (t: string | null, b: string | null) => {
    if (env.noColor) return t && b ? "█" : t ? "▀" : b ? "▄" : " ";
    if (t && b) return `${hexOpen(t, env)}${hexOpen(b, env, true)}▀\x1b[39;49m`;
    if (t) return `${hexOpen(t, env)}▀\x1b[39m`;
    if (b) return `${hexOpen(b, env)}▄\x1b[39m`;
    return " ";
  };
  return Array.from({ length: 6 }, (_, r) => grid[2 * r].map((t, x) => cell(t, grid[2 * r + 1][x])).join(""));
}

/** 큰 배너 6줄 (각 57칸) */
export function bannerLines(env: BrandEnv): string[] {
  const pal = env.appearance === "light" ? BANNER.light : BANNER.dark;
  const o = shadowWord("O", pal.rows6, env), col = smallColumn(env, pal), gen = shadowWord("GEN", pal.rows6, env), pi = shadowWord("PI", pal.pi6, env);
  return Array.from({ length: 6 }, (_, i) => `${o[i]}${col[i]} ${gen[i]}  ${pi[i]}`);
}

// ---- 부제 · 저장소 ----

/** 부제 두 줄 (사용자, 2026-11-13). 글자로 쓴다 (작은 아스키 아트는 카드에 너무 빽빽해 버렸다) */
export const SUBTITLE = ["Lite Weight Coding Agent", "For Closed Network"];
/** 저장소 주소 (git remote origin) */
export const REPO_URL = "https://github.com/Salvia95/oxygen-pi-system";

/** 칸 수에 맞춰 가운데 정렬 (넘치면 자름) */
function center(m: Measure, s: string, w: number): string {
  const t = m.width(s) > w ? m.trunc(s, w, "…") : s;
  const free = Math.max(0, w - m.width(t));
  return " ".repeat(Math.floor(free / 2)) + t + " ".repeat(free - Math.floor(free / 2));
}

/**
 * 카드 한 칸짜리 세로 배치 (오른쪽 열 없음):
 *   ╭─ ◆ Oxygen Pi 0.1.0 ───────╮
 *   │        <배너 6줄>          │   ← 64칸부터
 *   │                            │
 *   │  Lite Weight Coding Agent  │   ← 부제 (o2.mid)
 *   │     For Closed Network     │
 *   │                            │
 *   │ https://github.com/…       │   ← 저장소 (muted)
 *   ╰────────────────────────────╯
 */
export function headerLines(m: Measure, g: Glyphs, width: number, _wc: WidthClass, h: HeaderInfo, p: HeaderPaint): string[] {
  if (width < 30) return [];   // 제목이 들어가지 않는다
  const inner = width - 2;
  const title = ` ${p.brand(g.brand)} ${p.brand("Oxygen")} ${p.pi("Pi")} ${p.muted(h.version)} `;
  const body: string[] = [];
  if (width >= 64) body.push(...bannerLines(p.env).map((l) => center(m, l, inner)), center(m, "", inner));
  body.push(...SUBTITLE.map((s) => center(m, p.sub(s), inner)), center(m, "", inner), center(m, p.muted(REPO_URL), inner));
  const v = p.frame(g.vbar);
  const top = `${p.frame(`${g.tl}${g.hline}`)}${title}${p.frame(`${g.hline.repeat(Math.max(0, inner - 1 - m.width(title)))}${g.tr}`)}`;
  return [
    m.width(top) > width ? m.trunc(top, width, "") : top,
    ...body.map((l) => `${v}${l}${v}`),
    p.frame(`${g.bl}${g.hline.repeat(inner)}${g.br}`),
  ];
}
