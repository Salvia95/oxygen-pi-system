// 화면 기호는 이 파일 하나에 둔다 (docs/pi-tui-spec.md §2, .claude/rules/oxygen-design.md).
// unicode 는 D2Coding 에서 1칸인 글자만 (글꼴의 hmtx 폭으로 확인, 2026-11-13). 점자 · ⎿ · ⏺ · Nerd Font 는 쓰지 않는다.
// 2칸으로 그리는 터미널이 있으면 설정 glyphs: "ascii" 로 바꾼다.

export type GlyphMode = "unicode" | "ascii";

export interface Glyphs {
  running: string; ok: string; fail: string;
  elbow: string; vbar: string; hline: string;
  tl: string; tr: string; bl: string; br: string; teeDown: string; teeUp: string;
  brand: string; prompt: string; sep: string; more: string;
  system: string;   // 시스템 작업 줄 (flow_plan · flow_note · flow_show, docs/pi-tui-spec.md §7.5)
  spinner: readonly string[];
}

export const GLYPHS: Record<GlyphMode, Glyphs> = {
  unicode: {
    running: "○", ok: "✓", fail: "×",   // 끝남은 모든 화면에서 ✓ (docs/ui-unify-spec.md D1)
    elbow: "└", vbar: "│", hline: "─",
    tl: "╭", tr: "╮", bl: "╰", br: "╯", teeDown: "┬", teeUp: "┴",
    brand: "◆", prompt: "›", sep: "·", more: "…", system: "◇",
    spinner: ["◐", "◓", "◑", "◒"],
  },
  ascii: {
    running: "o", ok: "v", fail: "x",
    elbow: "\\", vbar: "|", hline: "-",
    tl: "+", tr: "+", bl: "+", br: "+", teeDown: "+", teeUp: "+",
    brand: "*", prompt: ">", sep: ".", more: "...", system: "+",
    spinner: ["|", "/", "-", "\\"],
  },
};

export function glyphs(mode: GlyphMode = "unicode"): Glyphs {
  return GLYPHS[mode] ?? GLYPHS.unicode;
}

/** 스피너 한 프레임. 시작 시각부터 지난 시간으로 고른다 (프레임 간격 ms) */
export function spinnerFrame(g: Glyphs, elapsedMs: number, intervalMs = 150): string {
  const i = Math.floor(Math.max(0, elapsedMs) / intervalMs) % g.spinner.length;
  return g.spinner[i];
}
