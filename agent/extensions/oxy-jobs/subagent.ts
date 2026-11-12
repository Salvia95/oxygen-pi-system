// subagent 실행: 별도 pi 프로세스(--mode json -p --no-session)로 독립된 컨텍스트에서 작업을 수행한다.
// pi 공식 예제(examples/extensions/subagent, MIT)의 방식을 따르되, 작업 관리자·동시 실행 제한·로그에 맞게 줄였다.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Job, JobManager, Semaphore } from "./manager.ts";
import { parseVllmMetrics } from "./manager.ts";

/**
 * agent/agents/*.md 하나. provider · model · thinking 은 선택: frontmatter 에 적으면 그 값, 없으면 부모 pi 의 현재 값을 물려받는다
 *   (model 만 적으면 부모와 같은 provider 의 그 모델)
 */
export interface AgentDef {
  name: string; description: string; tools: string[]; prompt: string;
  level?: string;                                   // 기본 작업 수준 (agent/llm.json 의 levels id)
  provider?: string; model?: string; thinking?: string;
}

/** 작업 수준에서 정해진 대상 (scripts/llm-connections.mjs 의 resolveLevel) */
export interface LevelTarget { level: string; connection: string; provider: string; id: string; thinking: string }

/** 부모 pi 가 지금 쓰는 모델 · thinking 수준 (자식이 그대로 따른다) */
export interface ParentModel { provider?: string; id?: string; thinking?: string }

/**
 * 자식 pi 의 인자. 모델은 --provider · --model 로 나눠 넘긴다 (id 에 / 가 들어간 모델: qwen/qwen3.8-27b).
 * 모델을 넘기지 않으면 자식은 settings.json 의 기본 모델을 써서, 사용자가 대화 중에 바꾼 모델과 달라진다.
 */
export function childArgs(cli: string, agent: AgentDef, task: string, parent: ParentModel, promptFile?: string): string[] {
  const args = [cli, "--mode", "json", "-p", "--no-session"];
  const provider = agent.provider || parent.provider;
  const id = agent.model || (agent.provider && agent.provider !== parent.provider ? undefined : parent.id);
  if (id) { if (provider) args.push("--provider", provider); args.push("--model", id); }
  const thinking = agent.thinking || parent.thinking;
  if (thinking) args.push("--thinking", thinking);
  if (agent.tools.length) args.push("--tools", agent.tools.join(","));
  if (promptFile) args.push("--append-system-prompt", promptFile);
  args.push(`Task: ${task}`);
  return args;
}

/** agent/agents/*.md (frontmatter: name, description, tools) */
export function loadAgents(agentDir: string): AgentDef[] {
  const dir = join(agentDir, "agents");
  if (!existsSync(dir)) return [];
  const out: AgentDef[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".md"))) {
    const text = readFileSync(join(dir, f), "utf8");
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!m) continue;
    const meta: Record<string, string> = {};
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([a-zA-Z_-]+):\s*(.*)$/);
      if (kv) meta[kv[1]] = kv[2].trim();
    }
    if (!meta.name) continue;
    out.push({
      name: meta.name, description: meta.description ?? "",
      tools: (meta.tools ?? "").split(",").map((s) => s.trim()).filter(Boolean), prompt: m[2].trim(),
      ...(meta.provider ? { provider: meta.provider } : {}), ...(meta.model ? { model: meta.model } : {}),
      ...(meta.thinking ? { thinking: meta.thinking } : {}), ...(meta.level ? { level: meta.level } : {}),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** vLLM 이 이미 밀려 있으면(대기 요청 존재) 잠시 기다린다. OXY_VLLM_METRICS=on 일 때만, 실패하면 그냥 진행 */
async function waitForVllm(baseUrl: string | undefined, log: (s: string) => void, signal?: AbortSignal) {
  if (!/^(on|1|true)$/i.test(process.env.OXY_VLLM_METRICS ?? "")) return;
  const base = (baseUrl ?? "").replace(/\/v1\/?$/, "");
  if (!base) return;
  const deadline = Date.now() + Number(process.env.OXY_VLLM_METRICS_MAX_WAIT_MS ?? 120000);
  for (let first = true; Date.now() < deadline && !signal?.aborted; first = false) {
    try {
      const r = await fetch(`${base}/metrics`, { signal: AbortSignal.timeout(3000) });
      if (!r.ok) return;
      const m = parseVllmMetrics(await r.text());
      const kvHigh = m.kvCache !== null && m.kvCache >= Number(process.env.OXY_VLLM_KV_LIMIT ?? 0.9);
      if (m.waiting === 0 && !kvHigh) return;
      if (first) log(`[oxy-jobs] vLLM 혼잡 (대기 ${m.waiting}, KV ${m.kvCache ?? "?"}) → 시작 대기`);
    } catch { return; }
    await new Promise((ok) => setTimeout(ok, 2000));
  }
}

const textOf = (msg: any): string =>
  (Array.isArray(msg?.content) ? msg.content : []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join("");

export interface RunOptions {
  signal?: AbortSignal;
  onProgress?: (line: string) => void;
  parent?: ParentModel;      // 부모 pi 의 지금 모델 · thinking
  target?: LevelTarget | null; // 작업 수준에서 정해진 대상 (있으면 agent 정의의 provider/model/thinking 보다 우선)
  slots?: Semaphore;         // 동시 실행 제한 (연결마다). 없으면 mgr.agentSlots
  metricsBaseUrl?: string;   // 혼잡 감지할 vLLM 주소 (vLLM 연결일 때만)
  childEnv?: Record<string, string>; // 자식에게만 넘기는 환경변수 (LLM 키 · oxy-llm 이 받자마자 지운다)
}

/** 자식 pi 의 인자: 작업 수준 대상이 있으면 그것, 없으면 agent 정의 → 부모 */
export function argsFor(cli: string, agent: AgentDef, task: string, opts: Pick<RunOptions, "parent" | "target">, promptFile?: string): string[] {
  if (opts.target) {
    const plain = { ...agent, provider: undefined, model: undefined, thinking: undefined };
    return childArgs(cli, plain, task, { provider: opts.target.provider, id: opts.target.id, thinking: opts.target.thinking }, promptFile);
  }
  return childArgs(cli, agent, task, opts.parent ?? {}, promptFile);
}

/** subagent 하나 실행. 연결마다의 슬롯(opts.slots)으로 동시 실행 수를 제한한다 */
export async function runSubagent(mgr: JobManager, job: Job, agent: AgentDef, task: string, cwd: string, opts: RunOptions): Promise<void> {
  const w = mgr.writer(job);
  const release = await (opts.slots ?? mgr.agentSlots).acquire();
  let tmp: string | undefined;
  try {
    if (job.state === "stopped") return;
    await waitForVllm(opts.metricsBaseUrl, w.line, opts.signal);
    if (job.state === "stopped") return;
    job.state = "running";
    job.startedAt = Date.now();
    w.line(`[oxy-jobs] ${job.id} agent=${agent.name} cwd=${cwd}`);
    w.line(`[task] ${task}`);
    mgr.changed();

    let promptFile: string | undefined;
    if (agent.prompt) {
      tmp = mkdtempSync(join(tmpdir(), "oxy-agent-"));
      promptFile = join(tmp, "prompt.md");
      writeFileSync(promptFile, agent.prompt);
    }
    const args = argsFor(process.argv[1], agent, task, opts, promptFile);
    const flag = (f: string) => { const i = args.indexOf(f); return i > 0 ? args[i + 1] : ""; };
    w.line(`[model] ${opts.target ? `level=${opts.target.level} ` : ""}${[flag("--provider"), flag("--model")].filter(Boolean).join("/") || "(settings 기본값)"} thinking=${flag("--thinking") || "(기본값)"}`);

    const depth = Number(process.env.OXY_SUBAGENT_DEPTH ?? 0) + 1;
    const proc = spawn(process.execPath, args, {
      cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...opts.childEnv, OXY_SUBAGENT_DEPTH: String(depth) },
    });
    job.proc = proc;
    job.usage = { turns: 0, input: 0, output: 0 };
    let buf = "";
    let lastText = "";
    let errText = "";
    const onEvent = (ev: any) => {
      if (ev.type === "message_end" && ev.message?.role === "assistant") {
        const m = ev.message;
        job.usage!.turns++;
        job.usage!.input += m.usage?.input ?? 0;
        job.usage!.output += m.usage?.output ?? 0;
        const t = textOf(m).trim();
        if (t) { lastText = t; w.line(`[assistant] ${t.split("\n")[0].slice(0, 200)}`); }
        for (const b of m.content ?? []) {
          if (b?.type === "toolCall") {
            const a = b.arguments ?? {};
            const brief = a.command ?? a.path ?? a.pattern ?? JSON.stringify(a).slice(0, 120);
            const line = `[tool] ${b.name}: ${String(brief).split("\n")[0].slice(0, 160)}`;
            w.line(line);
            opts.onProgress?.(line);
          }
        }
        if (m.errorMessage) errText = m.errorMessage;
      }
    };
    proc.stdout.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines) { try { onEvent(JSON.parse(l)); } catch { /* json 아닌 줄 무시 */ } }
    });
    proc.stderr.on("data", (d) => { errText += d.toString(); });
    const kill = () => { mgr.stop(job.id); };
    opts.signal?.addEventListener("abort", kill, { once: true });
    const code: number = await new Promise((ok) => {
      proc.on("close", (c) => ok(c ?? 1));
      proc.on("error", () => ok(1));
    });
    opts.signal?.removeEventListener("abort", kill);
    if (buf.trim()) { try { onEvent(JSON.parse(buf)); } catch { /* ignore */ } }

    job.exitCode = code;
    job.result = lastText || (errText ? `(no answer) ${errText.trim().split("\n").slice(-3).join(" ")}` : "(no answer)");
    if (job.state !== "stopped") job.state = code === 0 && lastText ? "done" : "failed";
    w.line(`[result] ${job.result}`);
  } catch (e: any) {
    job.state = "failed";
    job.result = `(error) ${e?.message ?? e}`;
    w.line(job.result);
  } finally {
    job.endedAt = Date.now();
    w.close();
    release();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    mgr.changed();
  }
}
