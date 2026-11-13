// 모니터 pane 관리 (docs/monitor-spec.md §1). pi 에 의존하지 않는다 (psmux 를 부르는 함수만 받는다).
//   - 오른쪽 30% 열: 창 옵션 main-pane-width 70% + select-layout main-vertical (main pane = index 0 = pi)
//   - 호출 순서대로 위→아래: 첫 모니터는 pi pane 을 -h, 그다음은 마지막 모니터 pane 을 -v 로 나눈다 (index 순서 = 호출 순서)
//   - 같은 높이: main-vertical 이 오른쪽 열을 똑같이 나눈다. 모니터가 스스로 끝나도 pane-exited hook 이 다시 맞춘다
//   - 모니터 종류마다 pane 하나: pane 옵션 @oxy_monitor=<종류>
// psmux 의 resize-pane -x/-y 는 크기를 절대값으로 맞추지 않으므로 쓰지 않는다.
import { spawnSync } from "node:child_process";
import { type MuxTarget, pinArgs } from "../_lib/psmux.ts";

export type Run = (args: string[]) => { status: number; stdout: string; stderr: string };

/**
 * psmux.exe 를 부른다 (extra: 시험용 -L 서버 등). pin 을 주면 서버(-L)와 세션을 못 박는다:
 * $TMUX 의 서버에 닿지 못하면 psmux 가 기본 서버로 조용히 넘어가 다른 세션에 pane 을 만들기 때문이다 (_lib/psmux.ts).
 */
export function psmuxRunner(exe: string, extra: string[] = [], pin?: MuxTarget): Run {
  return (args) => {
    const r = spawnSync(exe, [...extra, ...(pin ? pinArgs(args, pin) : args)], { encoding: "utf8", windowsHide: true, timeout: 10000 });
    return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
}

export interface MonitorPane { id: string; index: number; kind: string }

export const MAIN_WIDTH = "70%";
export const HOOK = "select-layout main-vertical";

export class PaneManager {
  private run: Run;
  readonly piPane: string;
  constructor(run: Run, piPane: string) {
    this.run = run;
    this.piPane = piPane;
  }

  private ok(args: string[], what: string): string {
    const r = this.run(args);
    if (r.status !== 0) throw new Error(`psmux ${what} 실패: ${(r.stderr || r.stdout).trim().split("\n")[0] || `exit ${r.status}`}`);
    return r.stdout;
  }

  /** pi 가 있는 창의 모니터 pane (index 순서) */
  list(): MonitorPane[] {
    const out = this.ok(["list-panes", "-t", this.piPane, "-F", "#{pane_id}\t#{pane_index}\t#{@oxy_monitor}"], "list-panes");
    return out.split(/\r?\n/).map((l) => l.split("\t")).filter((p) => p.length >= 3 && p[2].trim())
      .map(([id, index, kind]) => ({ id, index: Number(index), kind: kind.trim() })).sort((a, b) => a.index - b.index);
  }

  find(kind: string): MonitorPane | undefined { return this.list().find((p) => p.kind === kind); }

  /** 오른쪽 열 배치와 hook 을 건다 (여러 번 불러도 같다). 이 창 · 이 세션에만 건다 (psmux.conf 에는 넣지 않는다) */
  ensureLayout(): void {
    this.ok(["set-option", "-w", "-t", this.piPane, "main-pane-width", MAIN_WIDTH], "set-option main-pane-width");
    this.ok(["set-hook", "-t", this.piPane, "pane-exited", HOOK], "set-hook pane-exited");
  }

  relayout(): void { this.run(["select-layout", "-t", this.piPane, "main-vertical"]); }

  /** 모니터를 연다 (이미 있으면 그 pane). command 는 pane 의 셸(Git Bash)이 해석한다 → 새 pane id */
  open(kind: string, command: string, cwd?: string): string {
    const have = this.find(kind);
    if (have) return have.id;
    this.ensureLayout();
    const monitors = this.list();
    const last = monitors.at(-1);
    const split = last ? ["-t", last.id, "-v"] : ["-t", this.piPane, "-h", "-l", "30%"];
    const id = this.ok(["split-window", ...split, "-d", "-P", "-F", "#{pane_id}", ...(cwd ? ["-c", cwd] : []), command], "split-window").trim();
    if (!/^%\d+$/.test(id)) throw new Error(`psmux split-window 이 pane id 를 돌려주지 않음: ${id}`);
    this.run(["set-option", "-p", "-t", id, "@oxy_monitor", kind]);
    this.relayout();
    return id;
  }

  /** 모니터를 닫는다 → 닫았으면 true */
  close(kind: string): boolean {
    const p = this.find(kind);
    if (!p) return false;
    this.run(["kill-pane", "-t", p.id]);
    this.relayout();
    return true;
  }

  closeAll(): number {
    const all = this.list();
    for (const p of all) this.run(["kill-pane", "-t", p.id]);
    if (all.length) this.relayout();
    return all.length;
  }

  /** 켜고 끄기 (하단 바의 Enter · 클릭, /monitor) */
  toggle(kind: string, command: string, cwd?: string): "opened" | "closed" {
    if (this.close(kind)) return "closed";
    this.open(kind, command, cwd);
    return "opened";
  }
}

/** bash 의 작은따옴표 문자열 */
export const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * 모니터 pane 에서 실행할 명령. 앞의 exec: psmux 는 첫 낱말이 파일 경로면 셸 없이 직접 실행하므로 셸 내장 명령으로 시작한다.
 * 경로의 역슬래시는 / 로 바꾼다 (Git Bash 에서 그대로 실행된다).
 */
export function monitorCommand(node: string, script: string, kind: string, piPid: number, cwd: string, dirs: { agent: string; root: string }): string {
  // agent 폴더 · 하네스 루트는 인자로 넘긴다: 새 pane 은 pi 프로세스가 아니라 psmux 서버의 환경을 물려받아
  // PI_CODING_AGENT_DIR · OXY_HOME 이 pi 와 다를 수 있다 (실측: 다른 agent 폴더의 jobs 를 보고 있었다)
  const p = (s: string) => shQuote(s.replace(/\\/g, "/"));
  return `exec ${p(node)} --disable-warning=ExperimentalWarning ${p(script)} ${kind} --pi-pid ${piPid} --cwd ${p(cwd)} --agent ${p(dirs.agent)} --root ${p(dirs.root)}`;
}

/** pi 를 끝낼 때 모니터 pane 을 닫는가: 화면을 그린 본 대화가 끝날 때만 (/new · 세션 넘기기 · subagent 의 끝은 아니다) */
export const closesMonitorsOnShutdown = (reason: string | undefined, ownsScreen: boolean): boolean => reason === "quit" && ownsScreen;
