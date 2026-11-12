// 모니터 프로그램 (모니터 pane 안에서 실행, docs/monitor-spec.md §5).
//   node monitor.ts <jobs|flow> --pi-pid <pid> --cwd <폴더>
// 지금은 골격이다: 제목을 그리고, pi 가 끝나면 (또는 q) 스스로 종료한다. jobs · flow 화면은 4단계에서 채운다.
// pi 의 extension 으로 로드되지 않는다 (pi 는 폴더의 index.ts 만 로드한다).

const args = process.argv.slice(2);
const kind = args[0] ?? "jobs";
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const piPid = Number(opt("--pi-pid"));

/** pi 가 살아 있는지 (pid 가 없으면 살아 있는 것으로 본다) */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; }
}

const TITLES: Record<string, string> = { jobs: "jobs", flow: "flow" };
const out = process.stdout;
const draw = () => {
  const w = out.columns || 30;
  out.write("\x1b[2J\x1b[H");
  out.write(`\x1b[1m${(TITLES[kind] ?? kind).slice(0, w)}\x1b[0m\r\n`);
  out.write(`\x1b[2m${"준비 중".slice(0, w)}\x1b[0m\r\n`);
  out.write(`\x1b[${(out.rows || 10)};1H\x1b[2m${"q 닫기".slice(0, w)}\x1b[0m`);
};

const quit = () => { out.write("\x1b[?25h\x1b[?1049l"); process.exit(0); };

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on("data", (d) => { const s = d.toString(); if (s === "q" || s === "\x03") quit(); });
out.write("\x1b[?1049h\x1b[?25l");
draw();
out.on("resize", draw);
// pi 가 끝나면 스스로 종료한다 (pi pane 이 닫힐 때 이 pane 때문에 세션이 남지 않게)
setInterval(() => { if (!pidAlive(piPid)) quit(); }, 1000);
