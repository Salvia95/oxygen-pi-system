/**
 * oxy-jobs: 백그라운드 작업과 subagent 를 관리한다 (작은 컨텍스트를 아끼고, 진행 상황을 화면에 보여 준다).
 *
 * 도구
 *   background  긴 명령을 백그라운드로 실행 → 끝나면 모델을 깨워 결과를 알린다 (polling 불필요)
 *   subagent    독립된 컨텍스트의 도우미 agent 에게 작업을 맡긴다 (병렬 가능, wait:false 면 백그라운드)
 * 화면: 입력창 위 작업 패널 · 상태줄 · /jobs (로그 보기 · Windows Terminal 옆 창에 로그 · 중지)
 * 모니터: 대화형 모드에서는 agent/jobs/run-<pid>-<시작 시각>/state.json 에 상태를 쓰고 control/ 의 중지 요청을 받는다 (state.ts, docs/monitor-spec.md §3)
 * 비대화형(-p, json) 모드: 대화가 끝나기 전에 남은 작업을 기다렸다가 결과를 모아 이어서 진행한다.
 *
 * 환경변수: OXY_LLM_MAX_CONCURRENT (subagent 동시 실행, 기본 2), OXY_JOBS_MAX_CONCURRENT (bash 작업, 기본 4),
 *           OXY_SUBAGENT_MAX_DEPTH (기본 1: subagent 안에서는 subagent 를 쓰지 않음), OXY_VLLM_METRICS=on (혼잡 시 시작 대기),
 *           OXY_JOBS_WAIT_MS (비대화형에서 작업을 기다리는 최대 시간, 기본 30분), 끄기 OXY_JOBS=off
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { blocked, enabled, envInt } from "../_lib/common.ts";
import { inspect } from "../oxy-bash-guard.ts";
import { clip } from "../oxy-context-budget.ts";
import { type Job, JobManager, bashJobScript, bashKiller, fmtDuration } from "./manager.ts";
import { type ControlResult, ControlInbox, StateWriter, pruneRuns } from "./state.ts";
import { type AgentDef, type LevelTarget, loadAgents, runSubagent } from "./subagent.ts";
import { harnessRoot, INHERIT_ENV, sharedLlm } from "../oxy-llm.ts";

const ICON: Record<string, string> = { queued: "·", running: "⏳", done: "✓", failed: "✗", stopped: "■" };

function shellPath(agentDir: string): string {
  try {
    const s = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
    if (s.shellPath && existsSync(s.shellPath)) return s.shellPath;
  } catch { /* 기본값 사용 */ }
  return process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
}

/** 하네스에 반입된 psmux.exe (없으면 null). pane 안에서는 $TMUX 로 같은 서버를 찾는다 */
function psmuxExe(): string | null {
  const home = process.env.OXY_HOME;
  const p = home ? join(home, "bin", "psmux.exe") : "";
  return p && existsSync(p) ? p : null;
}

const ok = (text: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text }], details });

export default async function (pi: ExtensionAPI) {
  if (!enabled("JOBS")) return;
  const agentDir = process.env.PI_CODING_AGENT_DIR || getAgentDir();
  // LLM 연결 · 작업 수준 (agent/llm.json, docs/tui-spec.md §11). 없으면 작업 수준 없이 부모 모델을 따른다
  let llmLib: any = null;
  let llm: any = null;
  try {
    llmLib = await import(pathToFileURL(join(harnessRoot(agentDir), "scripts", "llm-connections.mjs")).href);
    llm = llmLib.loadLlm(agentDir);
  } catch { /* 예전 배치 */ }
  const levels: Array<{ id: string; use?: string }> = llm?.levels ?? [];
  const mgr = new JobManager(join(agentDir, "jobs"), {
    maxBash: envInt("OXY_JOBS_MAX_CONCURRENT", 4),
    maxAgents: envInt("OXY_LLM_MAX_CONCURRENT", 2),
  });
  const depth = Number(process.env.OXY_SUBAGENT_DEPTH ?? 0);
  const allowSubagent = depth < envInt("OXY_SUBAGENT_MAX_DEPTH", 1);
  const outMax = envInt("OXY_TOOL_OUTPUT_MAX_CHARS", 12000);
  let uiCtx: any = null;
  let interactive = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  // ---------------------------------------------------------------- 화면 (패널·상태줄)
  const render = () => {
    if (!uiCtx?.hasUI) return;
    const now = Date.now();
    const shown = mgr.list().filter((j) => j.state === "queued" || j.state === "running" || (j.endedAt && now - j.endedAt < 120000)).slice(-6);
    const lines = shown.map((j) => {
      const dur = fmtDuration((j.endedAt ?? now) - (j.startedAt ?? j.createdAt));
      const last = (j.tail.filter((l) => l.trim()).at(-1) ?? "").replace(/\s+/g, " ").slice(0, 50);
      return `${ICON[j.state]} ${j.id} ${j.kind === "agent" ? "agent" : "bash "} ${j.label.slice(0, 40).padEnd(40)} ${dur.padStart(6)}  ${last}`;
    });
    uiCtx.ui.setWidget("oxy-jobs", lines.length ? lines : undefined);
    const act = mgr.active();
    uiCtx.ui.setStatus("oxy-jobs", act.length
      ? (() => { const t = mgr.agentSlotTotals(); return `jobs ${act.length} · agents ${t.running}/${t.limit}${t.waiting ? ` (+${t.waiting} 대기)` : ""}`; })()
      : undefined);
    if (act.length && !timer) timer = setInterval(render, 1000);
    if (!act.length && timer) { clearInterval(timer); timer = null; }
  };
  mgr.onChange(render);
  const remember = (ctx: any) => { if (ctx?.hasUI) { uiCtx = ctx; interactive = true; } };
  const defaultAgents = envInt("OXY_LLM_MAX_CONCURRENT", 2);
  /** provider id(oxy-<연결 id>) → llm.json 의 연결 */
  const connectionOf = (provider?: string) => (provider?.startsWith("oxy-") ? llmLib?.findConnection(llm, provider.slice(4)) : undefined);
  const safeThinking = (): string | undefined => { try { return pi.getThinkingLevel?.() || undefined; } catch { return undefined; } };

  // ---------------------------------------------------------------- 모니터용 상태 파일 · 중지 요청 (대화형만)
  let writer: StateWriter | null = null;
  let inbox: ControlInbox | null = null;
  let lastControl: ControlResult | null = null;
  let stateCwd = process.cwd();
  mgr.onChange(() => writer?.changed());
  const startMonitorState = (ctx: any) => {
    if (writer || !ctx?.hasUI) return;
    stateCwd = ctx.cwd ?? stateCwd;
    writer = new StateWriter(mgr.runDir, () => mgr.snapshot(stateCwd, lastControl));
    inbox = new ControlInbox(mgr.runDir, (req) => {
      const job = mgr.get(req.id);
      if (!job) return { ok: false, message: `unknown job id: ${req.id}` };
      if (!mgr.stop(job.id)) return { ok: false, message: `${job.id} is not running (${job.state}).` };
      uiCtx?.ui?.notify?.(`${job.id} 중지 (모니터)`, "warning");
      return { ok: true, message: `Stopped ${job.id}.` };
    }, (r) => { lastControl = r; writer?.changed(); });
  };

  // ---------------------------------------------------------------- 완료 알림
  const summary = (j: Job, max = 4000) => {
    const dur = fmtDuration((j.endedAt ?? Date.now()) - (j.startedAt ?? j.createdAt));
    if (j.kind === "agent") {
      return `[oxy-jobs] ${j.id} (${j.label}) ${j.state} in ${dur}, ${j.usage?.turns ?? 0} turns:\n${clip(j.result ?? "", max, "See the job log for the full answer.")}`;
    }
    const tail = j.tail.filter((l) => l.trim()).slice(-15).join("\n");
    return `[oxy-jobs] ${j.id} ${j.state} (exit ${j.exitCode ?? "-"}) after ${dur}: ${j.label}\nlast output:\n${clip(tail, max, "Use background action=output for more.")}`;
  };
  const report = (j: Job) => {
    if (j.reported || !interactive) return;   // 비대화형은 agent_before_settle 에서 모아서 알린다
    j.reported = true;
    pi.sendMessage({ customType: "oxy-jobs", content: summary(j), display: true }, { triggerTurn: true, deliverAs: "followUp" });
  };

  // ---------------------------------------------------------------- bash 작업
  async function runBash(job: Job, command: string, cwd: string) {
    const w = mgr.writer(job);
    const release = await mgr.bashSlots.acquire();
    try {
      if (job.state === "stopped") return;
      job.state = "running";
      job.startedAt = Date.now();
      w.line(`$ ${command}`);
      mgr.changed();
      const sh = shellPath(agentDir);
      const pidFile = job.logFile.replace(/\.log$/, ".pid");
      const proc = spawn(sh, ["-c", bashJobScript(command, pidFile)], { cwd, env: process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      job.proc = proc;
      job.kill = bashKiller(sh, proc, pidFile);
      proc.stdout.on("data", (d) => w.chunk(d.toString()));
      proc.stderr.on("data", (d) => w.chunk(d.toString()));
      const code: number = await new Promise((r) => { proc.on("close", (c) => r(c ?? 1)); proc.on("error", () => r(1)); });
      job.exitCode = code;
      if (job.state !== "stopped") job.state = code === 0 ? "done" : "failed";
      w.line(`[exit ${code}]`);
    } finally {
      job.endedAt = Date.now();
      w.close();
      release();
      mgr.changed();
    }
  }

  async function guard(command: string, ctx: any): Promise<string | null> {
    if (!enabled("BASH_GUARD")) return null;
    for (const f of inspect(command, ctx.cwd)) {
      if (f.rule.level === "deny") return blocked(`guard/${f.rule.id}`, f.rule.hint);
      if (!ctx.hasUI) return blocked(`guard/${f.rule.id}`, `${f.rule.hint} (no confirmation UI in this mode)`);
      const yes = await ctx.ui.confirm(`[oxy-guard] ${f.rule.title} (백그라운드)`, `${f.segment}\n\n실행을 허용할까요?`);
      if (!yes) return blocked(`guard/${f.rule.id}`, f.rule.hint);
    }
    return null;
  }

  pi.registerTool({
    name: "background",
    label: "Background job",
    description:
      "Run a long shell command (build, full test suite, server, data load) in the background. " +
      "action=start returns a job id at once; you are notified with the result when it finishes, so do NOT poll or sleep — continue other work or end your turn. " +
      "action=status lists jobs, action=output shows the last lines of a job, action=stop kills it. Use the normal bash tool for quick commands.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("start"), Type.Literal("status"), Type.Literal("output"), Type.Literal("stop")]),
      command: Type.Optional(Type.String({ description: "Shell command for action=start (Git Bash syntax)" })),
      id: Type.Optional(Type.String({ description: "Job id for output/stop, e.g. job-3" })),
      lines: Type.Optional(Type.Number({ description: "Lines for action=output (default 40)" })),
    }),
    async execute(_id, params: any, _signal, _onUpdate, ctx) {
      remember(ctx);
      if (params.action === "start") {
        const command = String(params.command ?? "").trim();
        if (!command) throw new Error("command is required for action=start");
        const deny = await guard(command, ctx);
        if (deny) throw new Error(deny);
        const job = mgr.create("bash", command, true, { task: command });
        void runBash(job, command, ctx.cwd).then(() => report(job));
        return ok(`Started ${job.id}: ${command}\nYou will get a message when it finishes. Do not poll; continue with other work or end your turn.`, { id: job.id });
      }
      if (params.action === "status") {
        const jobs = mgr.list();
        if (!jobs.length) return ok("No jobs.");
        return ok(jobs.map((j) => `${j.id} ${j.kind} ${j.state}${j.exitCode != null ? ` exit=${j.exitCode}` : ""} ` +
          `${fmtDuration((j.endedAt ?? Date.now()) - (j.startedAt ?? j.createdAt))} ${j.label.slice(0, 80)}`).join("\n"));
      }
      const job = mgr.get(String(params.id ?? ""));
      if (!job) throw new Error(`unknown job id: ${params.id ?? "(none)"} — use action=status`);
      if (params.action === "output") {
        const n = Math.min(Math.max(Number(params.lines) || 40, 1), 200);
        const text = job.kind === "agent" && job.result ? job.result : job.tail.slice(-n).join("\n");
        return ok(clip(`${job.id} ${job.state}\n${text}`, outMax, "Ask for fewer lines."));
      }
      return ok(mgr.stop(job.id) ? `Stopped ${job.id}.` : `${job.id} is not running (${job.state}).`);
    },
  });

  // ---------------------------------------------------------------- subagent
  if (allowSubagent) {
    const agents = loadAgents(agentDir);
    const names = agents.map((a) => a.name);
    const list = agents.map((a) => `${a.name} (${a.description})`).join("; ");
    const find = (n: string): AgentDef => {
      const a = agents.find((x) => x.name === n);
      if (!a) throw new Error(`unknown agent "${n}". Available: ${names.join(", ") || "none"}`);
      return a;
    };
    if (agents.length) {
      pi.registerTool({
        name: "subagent",
        label: "Subagent",
        description:
          `Delegate a self-contained task to a helper agent that has its own fresh context, so your context stays small. Agents: ${list}. ` +
          "The agent cannot see this conversation: write a complete task (goal, paths, what to return). " +
          "Use tasks=[...] for independent tasks in parallel. wait=false runs them in the background and notifies you when done." +
          (levels.length ? ` level sets the model and reasoning effort: ${levels.map((l) => `${l.id} = ${l.use ?? l.id}`).join("; ")}. Pick the lowest level that can do the task.` : ""),
        parameters: Type.Object({
          agent: Type.Optional(Type.String({ description: `Agent name: ${names.join(" | ")}` })),
          task: Type.Optional(Type.String({ description: "Complete task description for a single agent" })),
          ...(levels.length ? { level: Type.Optional(Type.Union(levels.map((l) => Type.Literal(l.id)))) } : {}),
          tasks: Type.Optional(Type.Array(Type.Object({
            agent: Type.String(), task: Type.String(),
            ...(levels.length ? { level: Type.Optional(Type.Union(levels.map((l) => Type.Literal(l.id)))) } : {}),
          }), { description: "Independent tasks to run in parallel (max 8)" })),
          wait: Type.Optional(Type.Boolean({ description: "true (default): wait and return results. false: run in background" })),
        }),
        async execute(_id, params: any, signal, onUpdate, ctx) {
          remember(ctx);
          const items: Array<{ agent: string; task: string; level?: string }> = params.tasks?.length ? params.tasks
            : params.agent && params.task ? [{ agent: params.agent, task: params.task, level: params.level }] : [];
          if (!items.length) throw new Error("give agent+task, or tasks=[{agent, task}, ...]");
          if (items.length > 8) throw new Error("at most 8 tasks at once");
          const defs = items.map((t) => find(t.agent));
          // 대상: 도구의 level → agent 정의의 level → agent 정의의 provider/model/thinking → 부모의 지금 모델 · thinking
          const targets = items.map((t, i) => {
            const asked = t.level ?? (params.tasks?.length ? params.level : undefined);
            if (asked) {
              const r = llmLib?.resolveLevel(llm, asked) as LevelTarget | null;
              if (!r) throw new Error(`unknown level "${asked}". Levels: ${levels.map((l) => l.id).join(", ") || "none"}`);
              return r;
            }
            return defs[i].level ? (llmLib?.resolveLevel(llm, defs[i].level) as LevelTarget | null) : null;
          });
          const wait = params.wait !== false;
          const parent = { provider: ctx.model?.provider, id: ctx.model?.id, thinking: safeThinking() };
          const jobs = items.map((t, i) => mgr.create("agent", `${defs[i].name}: ${t.task.replace(/\s+/g, " ").slice(0, 60)}`, !wait, {
            agent: defs[i].name, task: t.task,
            target: targets[i] ? { level: targets[i]!.level, connection: targets[i]!.connection, provider: targets[i]!.provider, model: targets[i]!.id, thinking: targets[i]!.thinking }
              : { provider: defs[i].provider ?? parent.provider, model: defs[i].model ?? (defs[i].provider ? undefined : parent.id), thinking: defs[i].thinking ?? parent.thinking },
          }));
          const keys = sharedLlm()?.keys ?? {};
          const childEnv = Object.keys(keys).length ? { [INHERIT_ENV]: Buffer.from(JSON.stringify(keys)).toString("base64") } : undefined;
          const runs = jobs.map((j, i) => {
            const conn = connectionOf(j.target?.provider);
            return runSubagent(mgr, j, defs[i], items[i].task, ctx.cwd, {
              parent, target: targets[i], childEnv,
              slots: mgr.slotsFor(conn?.id, conn ? (conn.maxConcurrent || llmLib.LLM_KINDS[conn.kind]?.maxConcurrent || defaultAgents) : defaultAgents),
              metricsBaseUrl: conn?.kind === "vllm" ? conn.baseUrl : undefined,
              signal: wait ? signal : undefined,
              onProgress: wait ? () => onUpdate?.(ok(jobs.map((x) => `${ICON[x.state]} ${x.id} ${x.label} ${x.tail.at(-1) ?? ""}`).join("\n"))) : undefined,
            }).then(() => { if (!wait) report(j); });
          });
          if (!wait) {
            return ok(`Started ${jobs.map((j) => `${j.id} (${j.label})`).join(", ")}.\nYou will get a message with each result. Do not poll; continue or end your turn.`,
              { ids: jobs.map((j) => j.id) });
          }
          await Promise.all(runs);
          const per = Math.floor(outMax / jobs.length);
          return ok(jobs.map((j) => summary(j, per)).join("\n\n---\n\n"), { ids: jobs.map((j) => j.id) });
        },
      });
    }
  }

  // ---------------------------------------------------------------- 비대화형: 끝나기 전에 남은 작업을 기다려 결과를 넘긴다
  pi.on("agent_before_settle", async (event: any, ctx: any) => {
    if (ctx?.hasUI) return undefined;
    const pending = mgr.active().filter((j) => j.notify);
    if (pending.length) await mgr.waitAll(pending, envInt("OXY_JOBS_WAIT_MS", 30 * 60 * 1000));
    const done = mgr.unreported();
    if (!done.length) return undefined;
    for (const j of done) j.reported = true;
    return {
      entries: [...event.entries, { type: "custom_message", customType: "oxy-jobs", content: done.map((j) => summary(j)).join("\n\n"), display: true }],
      continue: true,
    };
  });

  // ---------------------------------------------------------------- /jobs
  pi.registerCommand("jobs", {
    description: "백그라운드 작업·subagent 목록, 로그 보기, 중지",
    handler: async (_args: string, ctx: any) => {
      remember(ctx);
      const jobs = mgr.list().reverse();
      if (!jobs.length) { ctx.ui.notify("작업이 없습니다", "info"); return; }
      const pick = await ctx.ui.select("작업", jobs.map((j) => `${ICON[j.state]} ${j.id}  ${j.kind}  ${j.label.slice(0, 50)}`));
      const job = jobs.find((j) => pick?.includes(` ${j.id} `));
      if (!job) return;
      // psmux 안($TMUX)이면 같은 세션에 pane 을 나누고, 아니면 Windows Terminal 창을 나눈다
      const psmux = process.env.TMUX ? psmuxExe() : null;
      const actions = ["로그 보기",
        ...(psmux ? ["옆 pane 에 로그 열기 (psmux)"] : process.env.WT_SESSION ? ["옆 창에 로그 열기 (Windows Terminal)"] : []),
        ...(job.state === "running" || job.state === "queued" ? ["중지"] : []), "닫기"];
      const act = await ctx.ui.select(`${job.id} · ${job.state}`, actions);
      const posix = job.logFile.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_m: string, d: string) => `/${d.toLowerCase()}`);
      if (act === "로그 보기") {
        const text = existsSync(job.logFile) ? readFileSync(job.logFile, "utf8").split(/\r?\n/).slice(-300).join("\n") : job.tail.join("\n");
        await ctx.ui.editor(`${job.id} 로그 (마지막 300줄 · 편집 내용은 저장되지 않음)`, text);
      } else if (act?.startsWith("옆 pane") && psmux) {
        // pane 셸(Git Bash)이 명령을 해석한다. -d: 포커스는 pi 에 둔다
        spawn(psmux, ["split-window", "-h", "-d", "-l", "40%", `tail -n 100 -f '${posix}'`],
          { detached: true, stdio: "ignore", windowsHide: true }).unref();
      } else if (act?.startsWith("옆 창")) {
        spawn("wt.exe", ["-w", "0", "split-pane", "--title", job.id, shellPath(agentDir), "-c", `tail -n 100 -f '${posix}'`],
          { detached: true, stdio: "ignore", windowsHide: true }).unref();
      } else if (act === "중지") {
        mgr.stop(job.id);
        ctx.ui.notify(`${job.id} 중지`, "warning");
      }
    },
  });

  pi.on("session_start", async (_e: any, ctx: any) => {
    remember(ctx);
    try { pruneRuns(mgr.jobsDir, 20, [mgr.runDir]); mgr.pruneLogs(); } catch { /* 정리 실패는 무시 */ }
    startMonitorState(ctx);
    render();
  });
  pi.on("turn_start", async (_e: any, ctx: any) => { remember(ctx); startMonitorState(ctx); });
  pi.on("session_shutdown", async () => {
    mgr.stopAll();
    if (timer) clearInterval(timer);
    inbox?.close(); inbox = null;
    writer?.close(); writer = null;
  });
}
