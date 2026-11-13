// psmux 를 부를 때 "어느 서버의 어느 세션" 인지 못 박는다 (`_lib/` 에는 index.ts 가 없어 pi 가 extension 으로 읽지 않는다).
//
// 왜 (2026-11-13 실측): psmux 는 세션마다 서버 프로세스를 두고, pane 의 $TMUX 는 그 세션 서버의 pid · port 를 담는다
// (`/tmp/psmux-<pid>/<서버 이름>,<port>,<n>`). $TMUX 의 서버에 닿지 못하면 psmux 는 오류 없이 **기본 서버로** 넘어가,
// `split-window -t %1` 이 기본 서버의 다른 세션(같은 %1)에 pane 을 만든다. 하단 바에서 연 모니터가 사용자 화면에 안 보이고
// 다른 세션에 쌓인 원인이다. `-L <이름>` 만 주면 그 이름의 세션이 여럿일 때 가장 최근 세션을 고르므로, pane 대상도
// `<세션>:.%N` 으로 세션을 붙인다 (`-t sb:.%1` · `-t sb:0.%1` 은 되고 `-t sb:%1` 은 안 됨, psmux 3.4.0 실측).
import { spawnSync } from "node:child_process";

export interface MuxTarget { server: string; session: string }

/** $TMUX → 서버 이름 (`-L` 에 줄 값). 모양이 다르면 null */
export function serverFromTmux(tmux: string | undefined): string | null {
  const m = tmux?.match(/\/([^/,]+),\d+,\d+$/);
  return m ? m[1] : null;
}

/** psmux 인수에 서버를 붙이고 `-t %N` 을 `-t <세션>:.%N` 으로 바꾼다. 이미 `-L`/`-S` 가 있으면 서버는 붙이지 않는다 */
export function pinArgs(args: string[], t: MuxTarget): string[] {
  const out = args.map((a, i) => (args[i - 1] === "-t" && /^%\d+$/.test(a) ? `${t.session}:.${a}` : a));
  return args.includes("-L") || args.includes("-S") ? out : ["-L", t.server, ...out];
}

type Spawn = (exe: string, args: string[]) => { status: number | null; stdout: string };
const defaultSpawn: Spawn = (exe, args) => {
  const r = spawnSync(exe, args, { encoding: "utf8", windowsHide: true, timeout: 10000 });
  return { status: r.status, stdout: r.stdout ?? "" };
};

let cached: { key: string; target: MuxTarget } | null = null;

/**
 * 지금 pi 가 있는 psmux 세션. 순서: (1) 런처가 넘긴 OXY_MUX_SESSION (2) $TMUX 로 물어본 세션 이름 —
 * 대답한 서버의 socket_path 가 $TMUX 의 서버 이름으로 끝날 때만 믿는다 (기본 서버로 넘어간 대답은 버리고 두 번 더 묻는다).
 * 찾지 못하면 null (호출하는 쪽은 엉뚱한 세션에 여는 대신 오류를 알린다)
 */
export function resolveMuxTarget(exe: string, env: NodeJS.ProcessEnv = process.env, spawn: Spawn = defaultSpawn): MuxTarget | null {
  const server = serverFromTmux(env.TMUX);
  if (!server || !env.TMUX_PANE) return null;
  const key = `${env.TMUX}|${env.TMUX_PANE}|${env.OXY_MUX_SESSION ?? ""}`;
  if (cached?.key === key) return cached.target;
  let session = env.OXY_MUX_SESSION?.trim() || "";
  if (!session) {
    for (let i = 0; i < 3 && !session; i++) {
      const r = spawn(exe, ["display", "-p", "-t", env.TMUX_PANE, "#{socket_path}\t#{session_name}"]);
      const [sock, name] = (r.stdout ?? "").trim().split("\t");
      if (r.status === 0 && name && sock?.replace(/\\/g, "/").endsWith(`/${server}`)) session = name;
    }
  }
  if (!session) return null;
  const target = { server, session };
  cached = { key, target };
  return target;
}

/** 시험용: 기억해 둔 세션을 지운다 */
export function resetMuxCache(): void { cached = null; }
