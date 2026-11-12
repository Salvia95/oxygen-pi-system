/**
 * Windows 에서 pi fullscreen 의 마우스 추적을 다시 켠다.
 *
 * ConPTY(Windows Terminal · psmux pane)는 stdin 이 raw(VT 입력) 모드가 되기 전에 출력한 마우스 추적 요청(?1000h 등)을 버린다.
 * pi 1.5.0 은 alt screen 에 들어가며 마우스 요청을 raw 모드보다 먼저 보내서, Windows 에서는 클릭이 pi 에 오지 않는다
 * (2026-11-12 실측: psmux pane 의 mouse_any_flag 가 0, 같은 시퀀스를 raw 모드 뒤에 보내면 1).
 * raw 모드가 켜진 뒤 pi 와 같은 시퀀스를 한 번 더 보낸다. 끌 때는 pi 가 원래대로 끈다.
 */

const BUTTON_MOTION = "\x1b[?1000h\x1b[?1002h\x1b[?1004h\x1b[?1006h";
const ALL_MOTION = "\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1004h\x1b[?1006h";

/** pi 가 쓰는 것과 같은 마우스 켜기 시퀀스 (멀티플렉서 안이면 버튼 동작만). Windows 가 아니면 null */
export function mouseReassertSequence(env: Record<string, string | undefined>, platform: string): string | null {
  if (platform !== "win32") return null;
  const term = (env.TERM ?? "").toLowerCase();
  const mux = env.TMUX !== undefined || env.ZELLIJ !== undefined || env.STY !== undefined || term.startsWith("tmux") || term.startsWith("screen");
  return mux ? BUTTON_MOTION : ALL_MOTION;
}

/** raw 모드와 pi 의 alt screen(마우스 사용)이 켜지면 시퀀스를 보낸다. 3초 안에 안 켜지면(regular 모드 등) 그만둔다 */
export function reassertMouseWhenReady(getTui: () => any, stdin: { isRaw?: boolean } = process.stdin): () => void {
  const seq = mouseReassertSequence(process.env, process.platform);
  if (!seq) return () => {};
  let tries = 0;
  const timer = setInterval(() => {
    const tui = getTui();
    if (stdin.isRaw && tui?.altScreenActive && tui?.mouseEnabled && typeof tui.terminal?.write === "function") {
      clearInterval(timer);
      tui.terminal.write(seq);
    } else if (++tries >= 30) clearInterval(timer);
  }, 100);
  timer.unref?.();
  return () => clearInterval(timer);
}
