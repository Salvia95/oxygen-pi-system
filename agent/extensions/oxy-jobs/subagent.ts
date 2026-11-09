// subagent 실행: 별도 pi 프로세스(--mode json -p --no-session)로 독립된 컨텍스트에서 작업을 수행한다.
// pi 공식 예제(examples/extensions/subagent, MIT)의 방식을 따르되, 작업 관리자·동시 실행 제한·로그에 맞게 줄였다.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Job, JobManager } from "./manager.ts";
import { parseVllmMetrics } from "./manager.ts";

export interface AgentDef { name: string; description: string; tools: string[]; prompt: string }

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
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** vLLM 이 이미 밀려 있으면(대기 요청 존재) 잠시 기다린다. OXY_VLLM_METRICS=on 일 때만, 실패하면 그냥 진행 */
async function waitForVllm(log: (s: string) => void, signal?: AbortSignal) {
  if (!/^(on|1|true)$/i.test(process.env.OXY_VLLM_METRICS ?? "")) return;
  const base = (process.env.OXY_VLLM_BASE_URL ?? "").replace(/\/v1\/?$/, "");
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

/** subagent 하나 실행. manager 의 agentSlots 로 동시 실행 수를 제한한다 */
export async function runSubagent(
  mgr: JobManager, job: Job, agent: AgentDef, task: string, cwd: string,
  opts: { signal?: AbortSignal; onProgress?: (line: string) => void },
): Promise<void> {
  const w = mgr.writer(job);
  const release = await mgr.agentSlots.acquire();
  let tmp: string | undefined;
  try {
    if (job.state === "stopped") return;
    await waitForVllm(w.line, opts.signal);
    if (job.state === "stopped") return;
    job.state = "running";
    job.startedAt = Date.now();
    w.line(`[oxy-jobs] ${job.id} agent=${agent.name} cwd=${cwd}`);
    w.line(`[task] ${task}`);
    mgr.changed();

    const args = [process.argv[1], "--mode", "json", "-p", "--no-session"];
    if (agent.tools.length) args.push("--tools", agent.tools.join(","));
    if (agent.prompt) {
      tmp = mkdtempSync(join(tmpdir(), "oxy-agent-"));
      writeFileSync(join(tmp, "prompt.md"), agent.prompt);
      args.push("--append-system-prompt", join(tmp, "prompt.md"));
    }
    args.push(`Task: ${task}`);

    const depth = Number(process.env.OXY_SUBAGENT_DEPTH ?? 0) + 1;
    const proc = spawn(process.execPath, args, {
      cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, OXY_SUBAGENT_DEPTH: String(depth) },
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
