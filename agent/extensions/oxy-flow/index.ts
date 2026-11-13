/**
 * oxy-flow: 작업 흐름 기록과 세션 넘기기 (LLM 요약 없이 컨텍스트를 관리한다).
 *
 * 기록 (<프로젝트>/.oxy/flow/, 엔진은 store.ts — 이후 flowout 으로 교체 가능)
 *   - 커밋 단위 노드: git commit 이 성공하면(또는 pi 밖 커밋을 나중에 발견하면) 노드를 만들고 그 사이의 결정 사항·파일을 붙인다
 *   - 사실은 자동 기록: 수정 파일 · 명령 성공/실패(마지막 출력) · 백그라운드 작업/subagent
 *   - 모델은 결정과 이유만 기록: flow_note / 필요할 때 조회: flow_show
 *   - 앞으로 할 일: flow_plan 으로 항목 → 할 일(2단) 계획을 쓰고 상태를 바꾼다. 커밋은 doing 인 할 일에 붙는다 (plan.ts)
 * 컨텍스트
 *   - 작업 기록은 세션 단위다: 새로 시작한 세션은 빈 기록으로 시작하고(이전 작업은 archive 로 보관),
 *     그 세션을 다시 열면(/resume · -c) 기록을 되살린다. 세션 넘기기로 이어진 세션은 같은 작업을 이어 간다
 *   - 기록이 있는 세션의 첫 요청에 작업 상태를 넣는다 (다시 연 세션 · 세션 넘기기)
 *   - 컨텍스트가 OXY_FLOW_ROLLOVER_PCT(기본 50%) 이상일 때 사용자가 새 메시지를 보내면, 그 메시지를 새 세션에서 이어서 처리한다
 *   - 작업 도중 한도에 가까워지면(pi compaction) LLM 요약 대신 작업 상태로 교체한다 (OXY_FLOW_COMPACT=llm 이면 pi 기본 요약)
 * 명령: /flow (보기 · show nN · trace 키워드 · new 목표 · rollback nN) · /oxy-rollover [메시지]
 * 끄기: OXY_FLOW=off · subagent(자식 pi) 안에서는 동작하지 않는다 (기록은 본 세션만)
 */
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { enabled, envInt, textOf, writeAtomic } from "../_lib/common.ts";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { FileFlowEngine, type FlowNode, commandDirs, git, renderContext, renderMarkdown, renderNode, traceDecisions, workFolderOf } from "./store.ts";
import { tasksAfter } from "./rollback.ts";
import { partialRollbackPrompt, rollbackConfirmLines, rollbackNotice, taskLabel, undoConfirmLines } from "./rollback-ui.ts";
import { PLAN_STATUSES, type PlanItem, nextStep, progress, renderPlanLines } from "./plan.ts";
import { brandEnv, brandFg } from "../oxygen-pi-tui/brand.ts";
import { ROLLOVER_KEY, ROLLOVER_WAIT_SEC, type RolloverCarry, rolloverLines } from "./rollover.ts";

/** 커밋 노드가 붙은 계획 항목 (할 일 우선) */
const findLinked = (plan: PlanItem[], nodeId: string): PlanItem | null => {
  for (const p of plan) {
    for (const c of p.children) if (c.nodes.includes(nodeId)) return c;
    if (p.nodes.includes(nodeId)) return p;
  }
  return null;
};

const CUSTOM = "oxy-flow";
/** 스냅숏(작업 폴더)에 들어가지 않는 바깥 상태를 바꾸는 명령: 패키지 설치 · 외부 DB (docs/flow-rollback-spec.md §3 의 !) */
const OUTSIDE_RE = /\b(?:npm|pnpm|yarn)\s+(?:i|install|add|ci|remove|uninstall|rm)\b|\bpip3?\s+(?:install|uninstall)\b|\bmvn\b[^|;&\n]*\binstall\b|\b(?:psql|mysql|sqlplus|usql|sql)\s/;
/** 모니터 → pi 되돌리기 요청 폴더 (모니터 팝업에서 이미 확인함, §3.1) */
const REQUEST_DIR = "requests";
/** 계획이 모두 끝났거나 빠진 상태에서 새 요청 · 메모가 오면 덧붙이는 안내 (2026-11-14, Flow Monitor 가 새 일을 못 보던 문제) */
export const PLAN_DONE_HINT = "All plan items are finished or dropped. If this is new work, add it with flow_plan(action=\"add\", text=...) and mark it doing before you start, so the task log and Flow Monitor follow the work.";
/** 계획에 항목이 있고, 할 일 · 진행 중인 것이 하나도 없는가 */
const planFinished = (plan: PlanItem[]): boolean =>
  plan.length > 0 && !plan.flatMap((p) => [p, ...p.children]).some((i) => i.status === "todo" || i.status === "doing");
const COMMIT_RE = /(^|[;&|(]\s*|\s)git\s+(?:-[cC]\s+\S+\s+)*commit\b/;
// Git Bash 경로(/c/x)·상대 경로 → 절대 경로 (표시용이므로 대소문자는 유지)
function toAbs(p: string, cwd: string): string {
  let q = p.trim().replace(/^@/, "");
  const m = process.platform === "win32" ? q.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i) : null;
  if (m) q = `${m[1].toUpperCase()}:/${m[2] ?? ""}`;
  return isAbsolute(q) ? q : resolve(cwd, q);
}
const ok = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

export default function (pi: ExtensionAPI) {
  if (!enabled("FLOW")) return;
  if (Number(process.env.OXY_SUBAGENT_DEPTH ?? 0) > 0) return;
  const rolloverPct = envInt("OXY_FLOW_ROLLOVER_PCT", 50);
  const rollover = enabled("FLOW_ROLLOVER");
  const ctxMax = envInt("OXY_FLOW_CONTEXT_MAX_CHARS", 6000);
  const compactMax = envInt("OXY_FLOW_COMPACT_MAX_CHARS", 12000);
  const fileCompaction = (process.env.OXY_FLOW_COMPACT ?? "file").toLowerCase() !== "llm";

  let engine: FileFlowEngine | null = null;
  let lastPrompt = "";
  const eng = (ctx: any): FileFlowEngine => (engine ??= new FileFlowEngine(ctx.cwd));

  // 하단 바(oxy-monitor)가 쓰는 요약과 변경 알림 (기록이 바뀔 때마다 status 가 불린다)
  const listeners = new Set<() => void>();
  (globalThis as any)[Symbol.for("oxy.flow")] = {
    summary: () => {
      if (!engine) return null;
      const f = engine.load();
      const pg = progress(f.plan);
      const last = f.nodes.at(-1);
      return { hasContent: engine.hasContent(), done: pg.done, total: pg.total, node: last?.id ?? "",
        // oxy-monitor 의 실시간 활동: 할 일 상태 변화 · 새 커밋을 알린다
        items: f.plan.flatMap((p) => [p, ...p.children]).map((i) => ({ id: i.id, status: i.status, text: i.text })),
        lastNode: last ? { id: last.id, title: last.title } : null };
    },
    onChange: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); },
  };
  const status = (ctx: any) => {
    for (const fn of listeners) { try { fn(); } catch { /* 화면 오류는 무시 */ } }
    if (!ctx.hasUI || !engine) return;
    const f = engine.load();
    if (!engine.writable) { ctx.ui.setStatus(CUSTOM, `flow 읽기 전용 (pid ${engine.lockOwner} 사용 중)`); return; }
    if (!engine.hasContent()) { ctx.ui.setStatus(CUSTOM, undefined); return; }
    const pend = f.buffer.decisions.length;
    const pg = progress(f.plan);
    ctx.ui.setStatus(CUSTOM, `flow ${f.nodes.at(-1)?.id ?? "n0"}${pg.total ? ` · 할 일 ${pg.done}/${pg.total}` : ""}${pend ? ` +${pend}결정` : ""}${f.buffer.failures.length ? ` ✗${f.buffer.failures.length}` : ""}`);
  };

  const injected = (ctx: any): boolean =>
    ctx.sessionManager.getEntries().some((e: any) => e.type === "custom_message" && e.customType === CUSTOM);

  pi.on("session_start", async (_e: any, ctx: any) => {
    engine = new FileFlowEngine(ctx.cwd);
    if (!engine.writable && ctx.hasUI) ctx.ui.notify(`[oxy-flow] 다른 pi(pid ${engine.lockOwner})가 이 프로젝트의 작업 기록을 쓰고 있어 읽기 전용으로 엽니다.`, "warning");
    // 작업 기록은 세션 단위: 새 세션이면 이전 작업을 보관하고, 보관된 세션을 다시 열면(/resume) 그 기록을 되살린다 (store.bindSession)
    let sid = "";
    try { sid = String(ctx.sessionManager?.getSessionId?.() ?? ""); } catch { /* 세션 정보 없음 */ }
    engine.bindSession(sid);
    status(ctx);
    if (ctx.hasUI && engine.writable) {
      reqCtx = ctx;
      try { mkdirSync(join(engine.dir, REQUEST_DIR), { recursive: true }); } catch { /* */ }
      if (!reqTimer) { reqTimer = setInterval(() => void pollRequests(), 1000); reqTimer.unref?.(); }
    }
    refreshMarks();
    // 세션 넘기기로 시작한 세션이면 넘기기 전의 모델 · thinking 으로 맞춘다 (1분 넘게 지난 값은 버린다)
    const carry = (globalThis as any)[ROLLOVER_KEY] as RolloverCarry | undefined;
    if (carry && _e?.reason === "new") {
      delete (globalThis as any)[ROLLOVER_KEY];
      if (Date.now() - carry.at < 60000) {
        try {
          const model = ctx.modelRegistry?.find?.(carry.provider, carry.modelId);
          if (model && (ctx.model?.provider !== model.provider || ctx.model?.id !== model.id)) await pi.setModel(model);
          if (carry.thinking) pi.setThinkingLevel(carry.thinking as any);
        } catch { /* 모델을 못 맞추면 기본 모델로 이어 간다 */ }
      }
    }
  });
  pi.on("session_shutdown", async () => { if (reqTimer) { clearInterval(reqTimer); reqTimer = null; } reqCtx = null; engine?.release(); engine = null; });

  // ---------------------------------------------------------------- 요청 시작: pi 밖 커밋 반영 · 목표 · 상태 주입
  pi.on("before_agent_start", async (event: any, ctx: any) => {
    if (event.messageType !== "user") return undefined;
    const e = eng(ctx);
    const prompt = String(event.prompt ?? "");
    if (!prompt.startsWith("[oxy-")) lastPrompt = prompt;
    if (e.writable) e.syncCommits(true);
    // 목표만 있고 진행 기록이 없으면 넣지 않는다 (이전 요청 하나가 남긴 목표로 새 요청을 오해하지 않도록)
    const work = e.hasWork();
    const continuing = e.takeContinue();
    if (e.writable) e.ensureGoal(prompt);
    status(ctx);
    const finished = planFinished(e.load().plan);
    // 세션 넘기기로 넘어온 마지막 답이 있으면 진행 기록이 없어도 넣는다 (그 답에 대한 대답일 수 있다, docs/flow-spec.md §1-5)
    const handoff = continuing && Boolean(e.load().handoff);
    if ((!work && !handoff) || injected(ctx)) {
      return finished && !prompt.startsWith("[oxy-") ? { message: { customType: `${CUSTOM}-hint`, content: PLAN_DONE_HINT, display: false } } : undefined;
    }
    const context = renderContext(e.load(), ctxMax, continuing ? "continue" : "reference");
    if (continuing && e.writable) e.clearHandoff();   // 넘긴 마지막 답은 한 번만 넣는다
    return { message: { customType: CUSTOM, content: finished ? `${context}\n\n${PLAN_DONE_HINT}` : context, display: false } };
  });

  // ---------------------------------------------------------------- 실행 중인 도구 (Task 끝 스냅숏의 순서를 지키려고)
  // 모델이 한 응답에 "파일 쓰기 · Task done" 을 같이 부르면 pi 가 병렬로 실행해, 스냅숏이 쓰기보다 먼저 찍혔다
  // (실제 Haiku, 2026-11-14: p1 까지 되돌리니 p1 에서 쓴 a.txt 가 사라짐). done · dropped 는 같은 응답에서 먼저 부른 도구가 끝난 뒤 찍는다
  let callSeq = 0;
  const inflight = new Map<string, { seq: number; done: Promise<void>; resolve: () => void }>();
  const track = (id: unknown) => {
    if (typeof id !== "string" || inflight.has(id)) return;
    let resolve!: () => void;
    const done = new Promise<void>((r) => { resolve = r; });
    inflight.set(id, { seq: ++callSeq, done, resolve });
  };
  const finish = (id: unknown) => {
    if (typeof id !== "string") return;
    inflight.get(id)?.resolve();
    inflight.delete(id);
  };
  /** 이 호출보다 먼저 시작한 도구가 끝날 때까지 (최대 maxMs). 끝나지 않은 것이 있으면 false */
  const settleBefore = async (id: string, maxMs = 120000): Promise<boolean> => {
    const me = inflight.get(id)?.seq ?? Number.MAX_SAFE_INTEGER;
    const earlier = [...inflight.entries()].filter(([k, v]) => k !== id && v.seq < me).map(([, v]) => v.done);
    if (!earlier.length) return true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<boolean>((r) => { timer = setTimeout(() => r(false), maxMs); });
    const ok = await Promise.race([Promise.all(earlier).then(() => true), timeout]);
    if (timer) clearTimeout(timer);
    return ok;
  };

  // ---------------------------------------------------------------- 그림자 저장소: 고치기 전에 작업 폴더를 따라간다 (docs/flow-rollback-spec.md §4)
  const folderCache = new Map<string, string | null>();
  const folderOf = (abs: string): string | null => {
    const key = abs.replace(/\\/g, "/").replace(/\/[^/]*\.[^/]*$/, "");
    if (!folderCache.has(key)) folderCache.set(key, workFolderOf(abs));
    return folderCache.get(key)!;
  };
  pi.on("tool_call", async (event: any, ctx: any) => {
    track(event.toolCallId);
    const e = engine;
    if (!e?.writable) return undefined;
    try {
      const name = event.toolName;
      if (name === "edit" || name === "write") {
        const p = String(event.input?.path ?? "");
        if (!p) return undefined;
        const abs = toAbs(p, ctx.cwd);
        const folder = folderOf(abs);
        if (folder) e.trackFolder(folder);
        else if (!e.insideTracked(abs)) e.noteIncomplete(`작업 폴더 밖 파일 ${abs.replace(/\\/g, "/")}`);
      } else if (name === "bash") {
        const command = String(event.input?.command ?? "");
        let dir = ctx.cwd as string;
        const dirs = [dir];
        for (const d of commandDirs(command)) { dir = toAbs(d, dir); dirs.push(dir); }
        for (const d of dirs) { const folder = folderOf(d); if (folder) e.trackFolder(folder); }
        if (OUTSIDE_RE.test(command)) e.noteIncomplete(`명령: ${command.replace(/\s+/g, " ").slice(0, 120)}`);
      }
    } catch { /* 따라가기 실패는 작업을 막지 않는다 */ }
    return undefined;
  });

  // 기호(✓ ! X) 다시 계산: 스냅숏이 생긴 뒤 (작업을 막지 않게 다음 틱에)
  let marksTimer: ReturnType<typeof setTimeout> | null = null;
  const refreshMarks = () => {
    if (marksTimer) return;
    marksTimer = setTimeout(() => { marksTimer = null; try { engine?.writable && engine.writeMarks(); } catch { /* 표시만 빠진다 */ } for (const fn of listeners) { try { fn(); } catch { /* */ } } }, 50);
    marksTimer.unref?.();
  };

  // ---------------------------------------------------------------- 되돌리기 실행 (/flow rollback · 모니터 요청)
  const lastResult = (e: FileFlowEngine, ok: boolean, text: string) => {
    try { writeAtomic(join(e.dir, "rollback-result.json"), JSON.stringify({ at: Date.now(), ok, text })); } catch { /* 모니터 알림만 빠진다 */ }
  };
  const runRollback = async (ctx: any, flowId: string, taskId: string): Promise<boolean> => {
    const e = eng(ctx);
    const r = e.rollbackTo(flowId, taskId);
    const label = r.flow && r.task ? taskLabel(r.flow.plan, r.task.id) : taskId;
    if (!r.ok) {
      const why = r.conflicts.length ? `${r.reason}: ${r.conflicts.slice(0, 3).join(", ")}` : r.reason ?? "실패";
      lastResult(e, false, `되돌리지 못했습니다: ${why}`);
      if (ctx.hasUI) ctx.ui.notify(`[oxy-flow] 되돌리지 못했습니다: ${why}`, "error");
      return false;
    }
    lastResult(e, true, `"${label}" 까지 되돌렸습니다 (파일 ${r.files.length}개)`);
    if (ctx.hasUI) ctx.ui.notify(`[oxy-flow] "${label}" 까지 되돌렸습니다 (파일 ${r.files.length}개)`, "info");
    status(ctx);
    refreshMarks();
    const fl = r.flow!, t = r.task!;
    if (r.incomplete.length) {
      const decisions = [...fl.buffer.decisions, ...fl.nodes.flatMap((n) => n.decisions)];
      const content = partialRollbackPrompt(fl.goal, t, tasksAfter(fl, t), decisions, r.incomplete, r.files.length);
      pi.sendMessage({ customType: `${CUSTOM}-rollback`, content, display: true }, { triggerTurn: true, deliverAs: "followUp" });
    } else {
      pi.sendMessage({ customType: `${CUSTOM}-rollback`, content: rollbackNotice(fl.goal, t, r.files.length), display: false }, { deliverAs: "nextTurn" });
    }
    return true;
  };
  const runUndo = async (ctx: any): Promise<boolean> => {
    const e = eng(ctx);
    const r = e.undoLast();
    if (!r.ok) {
      const why = r.conflicts.length ? `${r.reason}: ${r.conflicts.slice(0, 3).join(", ")}` : r.reason ?? "실패";
      lastResult(e, false, `되돌리기를 취소하지 못했습니다: ${why}`);
      if (ctx.hasUI) ctx.ui.notify(`[oxy-flow] 되돌리기를 취소하지 못했습니다: ${why}`, "error");
      return false;
    }
    const rec = r.record!;
    lastResult(e, true, `되돌리기를 취소했습니다 (파일 ${r.files.length}개)`);
    if (ctx.hasUI) ctx.ui.notify(`[oxy-flow] 되돌리기를 취소했습니다 (파일 ${r.files.length}개)`, "info");
    status(ctx);
    refreshMarks();
    pi.sendMessage({ customType: `${CUSTOM}-rollback`, content: rollbackNotice(rec.goal, { id: rec.task, text: rec.text } as any, r.files.length, true), display: false }, { deliverAs: "nextTurn" });
    return true;
  };

  // 모니터 pane 의 r · u (팝업에서 확인한 뒤 .oxy/flow/requests/*.json 을 쓴다) → 여기서 실행
  let reqTimer: ReturnType<typeof setInterval> | null = null;
  let reqCtx: any = null;
  const pollRequests = async () => {
    const e = engine;
    if (!e?.writable || !reqCtx) return;
    const dir = join(e.dir, REQUEST_DIR);
    let names: string[] = [];
    try { names = readdirSync(dir).filter((n) => n.endsWith(".json")).sort(); } catch { return; }
    for (const n of names) {
      let req: any = null;
      try { req = JSON.parse(readFileSync(join(dir, n), "utf8")); } catch { /* 쓰는 중이면 다음에 */ continue; }
      rmSync(join(dir, n), { force: true });
      if (Date.now() - Number(req?.at ?? 0) > 60000) continue;    // 오래된 요청은 버린다
      if (req?.op === "rollback") await runRollback(reqCtx, String(req.flow ?? ""), String(req.task ?? ""));
      else if (req?.op === "undo") await runUndo(reqCtx);
    }
  };

  // ---------------------------------------------------------------- 사실 자동 기록 · 커밋 → 노드
  // 끝남: 막혀서 실행되지 않은 도구도 tool_execution_end 가 온다. 응답이 끝나면 남은 것을 모두 푼다
  pi.on("tool_execution_end", async (event: any) => { finish(event.toolCallId); });
  pi.on("turn_end", async () => { for (const id of [...inflight.keys()]) finish(id); });

  pi.on("tool_result", async (event: any, ctx: any) => {
    finish(event.toolCallId);
    const e = eng(ctx);
    if (!e.writable) return undefined;
    const name = event.toolName;
    if ((name === "edit" || name === "write") && !event.isError) {
      const p = String(event.input?.path ?? "");
      if (p) {
        // 실제 작업 저장소를 따라간다 (pi 를 다른 폴더에서 시작했어도, docs/flow-spec.md "작업 저장소")
        const abs = toAbs(p, ctx.cwd);
        e.noteWorkPath(abs);
        e.recordFile(relative(e.workRoot(), abs).replace(/\\/g, "/") || p);
      }
      status(ctx);
      return undefined;
    }
    if (name === "background" || name === "subagent") {
      const first = textOf(event.content).split("\n").find((l) => l.trim()) ?? "";
      if (first) e.recordJob(`${name}: ${first.trim()}`);
      return undefined;
    }
    if (name !== "bash") return undefined;
    const command = String(event.input?.command ?? "");
    // cd · git -C 로 들어간 폴더가 다른 git 저장소면 작업 저장소를 옮긴다 (cd 는 앞 cd 기준으로 이어서 푼다)
    let dir = ctx.cwd as string;
    for (const d of commandDirs(command)) dir = toAbs(d, dir);
    if (dir !== ctx.cwd) e.noteWorkPath(dir);
    e.recordCommand(command, !event.isError, textOf(event.content));
    if (event.isError || !COMMIT_RE.test(command)) { status(ctx); return undefined; }
    const made: FlowNode[] = e.syncCommits(false);
    status(ctx);
    if (!made.length) return undefined;
    const last = made.at(-1)!;
    let hint = last.decisions.length
      ? `[oxy-flow] Recorded step ${last.id} for commit ${last.commit.slice(0, 8)} with ${last.decisions.length} decision(s).`
      : `[oxy-flow] Recorded step ${last.id} for commit ${last.commit.slice(0, 8)}. No decision was recorded for it: if you chose between options, call flow_note(kind="decision", text, why).`;
    // 소형 모델은 커밋 뒤 계획 항목을 done 으로 바꾸는 것을 잊기 쉽다 (실제 모델 확인)
    const linked = findLinked(e.load().plan, last.id);
    if (linked) hint += ` Linked to plan item ${linked.id} "${linked.text.slice(0, 60)}". If this commit finishes it, call flow_plan(action="update", id="${linked.id}", status="done").`;
    return { content: [...event.content, { type: "text", text: hint }] };
  });

  // ---------------------------------------------------------------- compaction 교체 (작업 도중 한도에 가까워졌을 때)
  pi.on("session_before_compact", async (event: any, ctx: any) => {
    if (!fileCompaction || (event.reason === "manual" && event.customInstructions)) return undefined;
    const e = eng(ctx);
    if (e.writable) e.syncCommits(true);
    const p = event.preparation;
    const summary = [
      renderContext(e.load(), compactMax),
      ...(lastPrompt ? ["", `Latest user request: ${lastPrompt.length > 1500 ? `${lastPrompt.slice(0, 1500)} …` : lastPrompt}`] : []),
      "", "(Earlier conversation was replaced by the task state above. The most recent messages follow. Re-read files before editing them.)",
    ].join("\n");
    return { compaction: { summary, firstKeptEntryId: p.firstKeptEntryId, tokensBefore: p.tokensBefore, details: { engine: "oxy-flow" } } };
  });

  // ---------------------------------------------------------------- 세션 넘기기: 컨텍스트가 찬 상태에서 새 메시지를 보내면 새 세션에서 처리
  pi.on("input", async (event: any, ctx: any) => {
    if (!rollover || event.source === "extension" || event.images?.length) return { action: "continue" as const };
    // 1회 실행(-p · json)에서는 하지 않는다: 실행이 먼저 끝나 /oxy-rollover 가 끝난 세션을 건드리고 메시지가 사라졌다.
    // 그 메시지는 이 세션에서 처리하고, 컨텍스트가 차면 compaction(작업 상태로 교체)이 맡는다
    if (!ctx.hasUI) return { action: "continue" as const };
    const text = String(event.text ?? "");
    if (!text.trim() || text.startsWith("/") || text.startsWith("!") || event.streamingBehavior) return { action: "continue" as const };
    const u = ctx.getContextUsage?.();
    if (u?.percent == null || u.percent < rolloverPct) return { action: "continue" as const };
    if (!engine?.hasContent()) return { action: "continue" as const };
    setTimeout(() => void pi.sendUserMessage(`/oxy-rollover ${text}`, { expandPromptTemplates: true }), 0);
    return { action: "handled" as const };
  });

  pi.registerCommand("oxy-rollover", {
    description: "작업 기록을 가지고 새 세션으로 넘어가기 (뒤에 메시지를 붙이면 새 세션에서 그 메시지로 이어감)",
    handler: async (args: string, ctx: any) => {
      await ctx.waitForIdle();
      const e = eng(ctx);
      if (e.writable) e.syncCommits(true);
      const kickoff = args.trim() || "Continue the task from the recorded state. Start with the Next step.";
      e.markContinue(); // 새 세션의 첫 요청은 같은 작업의 연속으로 표시한다
      // 마지막 요청 · 답을 새 세션에 넘긴다 (답의 선택지에 사용자가 대답하며 넘어가는 경우, docs/flow-spec.md §1-5)
      try {
        const msgs = (ctx.sessionManager.getEntries?.() ?? []).filter((x: any) => x?.type === "message");
        const textOfMsg = (m: any) => (typeof m?.content === "string" ? m.content : textOf(m?.content)).trim();
        const lastReply = [...msgs].reverse().find((x: any) => x.message?.role === "assistant" && textOfMsg(x.message));
        const lastUser = [...msgs].reverse().find((x: any) => x.message?.role === "user" && !textOfMsg(x.message).startsWith("[oxy-") && !textOfMsg(x.message).startsWith("/"));
        e.setHandoff(lastUser ? textOfMsg(lastUser.message) : "", lastReply ? textOfMsg(lastReply.message) : "");
      } catch { /* 넘기지 못하면 작업 기록만으로 이어 간다 */ }
      const parentSession = ctx.sessionManager.getSessionFile();
      // 넘어가기 전 5초 동안 입력창 위에 안내를 세며 보인다 (사용자가 새 세션으로 넘어간다는 것을 알 수 있게)
      if (ctx.hasUI) {
        const th = ctx.ui.theme;
        const be = brandEnv(th);
        const paint = { warn: (x: string) => th?.fg ? th.fg("warning", x) : x, oxygen: (x: string) => brandFg("sage", x, be), pi: (x: string) => brandFg("purple", x, be) };
        for (let sec = ROLLOVER_WAIT_SEC; sec > 0; sec--) {
          ctx.ui.setWidget("oxy-rollover", rolloverLines(sec, paint));
          await new Promise((r) => setTimeout(r, 1000));
        }
        ctx.ui.setWidget("oxy-rollover", undefined);
      }
      // 지금 모델 · thinking 을 새 세션에 넘긴다 (새 세션은 settings.json 의 기본 모델로 시작한다)
      if (ctx.model) {
        let thinking: string | undefined;
        try { thinking = pi.getThinkingLevel(); } catch { /* 없음 */ }
        (globalThis as any)[ROLLOVER_KEY] = { provider: ctx.model.provider, modelId: ctx.model.id, thinking, at: Date.now() } satisfies RolloverCarry;
      }
      await ctx.newSession({
        parentSession,
        withSession: async (next: any) => { await next.sendUserMessage(kickoff); },
      });
    },
  });

  // ---------------------------------------------------------------- 모델용 도구
  pi.registerTool({
    name: "flow_note",
    label: "Record task state",
    description:
      "Record task state that must survive context resets. kind=decision: a choice you made and why (e.g. chose library X over Y). " +
      "kind=goal: the task goal. kind=next: the next concrete step. kind=blocked: what blocks you. kind=done: task finished. " +
      "Changed files, commands, failures and commits are recorded automatically; do not record those.",
    parameters: Type.Object({
      kind: Type.Union([Type.Literal("decision"), Type.Literal("goal"), Type.Literal("next"), Type.Literal("blocked"), Type.Literal("done")]),
      text: Type.String({ description: "One or two sentences" }),
      why: Type.Optional(Type.String({ description: "Reason, for kind=decision" })),
    }),
    async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      const e = eng(ctx);
      if (!e.writable) throw new Error(`task log is read-only: another pi session (pid ${e.lockOwner}) is using .oxy/flow in this project`);
      const text = String(params.text ?? "").trim();
      if (!text && params.kind !== "done") throw new Error("text is required");
      e.note(params.kind, text, params.why);
      status(ctx);
      const hint = (params.kind === "next" || params.kind === "decision") && planFinished(e.load().plan) ? ` ${PLAN_DONE_HINT}` : "";
      return ok(`Recorded ${params.kind}.${hint}`);
    },
  });

  pi.registerTool({
    name: "flow_plan",
    label: "Task plan",
    description:
      "Plan the current task as steps with optional sub-tasks (2 levels). set: items=[{text, children:[{text}]}] replaces the plan. " +
      "add: text, with parent=\"p2\" for a sub-task. update: id plus status or text. Mark an item doing when you start it and done when finished.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("set"), Type.Literal("add"), Type.Literal("update")]),
      items: Type.Optional(Type.Array(Type.Object({
        text: Type.String(),
        children: Type.Optional(Type.Array(Type.Object({ text: Type.String() }))),
      }))),
      text: Type.Optional(Type.String()),
      parent: Type.Optional(Type.String()),
      id: Type.Optional(Type.String()),
      status: Type.Optional(Type.Union(PLAN_STATUSES.map((s) => Type.Literal(s)))),
    }),
    async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      const e = eng(ctx);
      if (!e.writable) throw new Error(`task log is read-only: another pi session (pid ${e.lockOwner}) is using .oxy/flow in this project`);
      let head: string;
      if (params.action === "set") { e.setPlan(params.items ?? []); head = "Plan saved."; }
      else if (params.action === "add") { const it = e.addPlan(String(params.text ?? ""), params.parent || undefined); head = `Added ${it.id}.`; }
      else {
        if (!params.id) throw new Error("id is required for action=update");
        // Task 끝 스냅숏은 같은 응답에서 먼저 부른 도구(파일 쓰기 등)가 끝난 뒤에 (병렬 실행)
        if ((params.status === "done" || params.status === "dropped") && !(await settleBefore(_id))) e.noteIncomplete("스냅숏 때 끝나지 않은 도구가 있었습니다");
        const it = e.updatePlan(String(params.id), { status: params.status, text: params.text });
        if (params.status === "done" || params.status === "dropped") refreshMarks();
        head = `Updated ${it.id} [${it.status}].`;
      }
      status(ctx);
      const plan = e.load().plan;
      const next = nextStep(plan);
      return ok([head, ...renderPlanLines(plan, { maxChars: 3000 }), next ? `Next: ${next}` : "All items are done or dropped."].join("\n"));
    },
  });

  pi.registerTool({
    name: "flow_show",
    label: "Show task log",
    description:
      "Show the recorded task state. No arguments: current goal, steps and uncommitted work. " +
      "node=\"n3\" (or a commit hash): decisions and files of that step. query=\"word\": find past decisions mentioning it.",
    parameters: Type.Object({
      node: Type.Optional(Type.String()),
      query: Type.Optional(Type.String()),
    }),
    async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      const e = eng(ctx);
      if (params.node) {
        const n = e.findNode(String(params.node));
        if (!n) throw new Error(`unknown step "${params.node}". Steps: ${e.load().nodes.map((x) => x.id).join(", ") || "none"}`);
        return ok(renderNode(n));
      }
      if (params.query) {
        const hits = traceDecisions(e.load(), String(params.query));
        return ok(hits.length ? hits.join("\n") : `No recorded decision mentions "${params.query}".`);
      }
      return ok(renderContext(e.load(), ctxMax));
    },
  });

  // ---------------------------------------------------------------- 사용자 명령
  pi.registerCommand("flow", {
    description: "작업 기록: (없음) 보기 · show nN · trace 키워드 · new 목표 · rollback p2 | <Flow id>:p2 (Task 까지 되돌리기) · undo (되돌리기 취소) · rollback nN (커밋 revert)",
    handler: async (args: string, ctx: any) => {
      const e = eng(ctx);
      const [sub, ...rest] = args.trim().split(/\s+/);
      const arg = rest.join(" ");
      const view = (title: string, text: string) => (ctx.hasUI ? ctx.ui.editor(title, text) : console.log(text));
      if (!sub) return void (await view("작업 기록 (.oxy/flow/FLOW.md)", renderMarkdown(e.load())));
      if (sub === "show") {
        const n = e.findNode(arg);
        return void (n ? await view(n.id, renderNode(n)) : ctx.ui.notify(`단계 "${arg}" 없음`, "warning"));
      }
      if (sub === "trace") {
        const hits = traceDecisions(e.load(), arg);
        return void (await view(`결정 추적: ${arg}`, hits.join("\n") || "(없음)"));
      }
      if (!e.writable) return void ctx.ui.notify(`읽기 전용 (pid ${e.lockOwner} 사용 중)`, "warning");
      if (sub === "new") {
        if (e.hasContent() && !(await ctx.ui.confirm("새 작업 시작", "현재 작업 기록을 보관(archive)하고 새로 시작할까요?"))) return;
        e.startNew(arg);
        status(ctx);
        refreshMarks();
        return void ctx.ui.notify("새 작업을 시작했습니다", "info");
      }
      if (sub === "rollback" && !/^n\d+$/i.test(arg) && !/^[0-9a-f]{7,40}$/i.test(arg)) {
        // Task 까지 되돌리기 (docs/flow-rollback-spec.md): /flow rollback p2 · /flow rollback <flow id>:p2
        const m = arg.match(/^(?:(.+):)?(p\d+(?:\.\d+)?)$/i);
        if (!m) return void ctx.ui.notify("사용법: /flow rollback p2 (지금 Flow) · /flow rollback <Flow id>:p2 (끝난 Flow)", "warning");
        const flowId = m[1] ?? e.load().id, taskId = m[2].toLowerCase();
        const dry = e.rollbackTo(flowId, taskId, true);
        if (!dry.ok) {
          const why = dry.conflicts.length ? `${dry.reason}: ${dry.conflicts.slice(0, 3).join(", ")}` : dry.reason;
          return void ctx.ui.notify(`되돌릴 수 없습니다: ${why}`, "warning");
        }
        const label = taskLabel(dry.flow!.plan, dry.task!.id);
        // 처음 포커스는 취소 (§3.1): pi 의 confirm 은 Yes 가 먼저라 선택 창으로 묻는다
        if (ctx.hasUI && (await ctx.ui.select(["되돌리기", ...rollbackConfirmLines(label, dry.files.length, dry.incomplete.length > 0)].join("\n"), ["취소", "되돌리기"])) !== "되돌리기") return;
        await runRollback(ctx, flowId, taskId);
        return;
      }
      if (sub === "undo") {
        const dry = e.undoLast(true);
        if (!dry.ok) return void ctx.ui.notify(dry.reason ?? "취소할 되돌리기가 없습니다", "warning");
        const label = dry.record!.flow === e.load().id ? taskLabel(e.load().plan, dry.record!.task) : `${dry.record!.task} ${dry.record!.text}`;
        if (ctx.hasUI && (await ctx.ui.select(["되돌리기 취소", ...undoConfirmLines(label, dry.files.length)].join("\n"), ["닫기", "되돌리기 취소"])) !== "되돌리기 취소") return;
        await runUndo(ctx);
        return;
      }
      if (sub === "rollback") {
        const n = e.findNode(arg);
        if (!n) return void ctx.ui.notify(`단계 "${arg}" 없음`, "warning");
        const dirty = git(e.workRoot(), ["status", "--porcelain"]);
        if (dirty) return void ctx.ui.notify("커밋하지 않은 변경이 있어 되돌릴 수 없습니다. 먼저 커밋하거나 정리하세요.", "warning");
        const after = (git(n.repo ?? e.root, ["rev-list", `${n.commit}..HEAD`]) ?? "").split("\n").filter(Boolean);
        if (!after.length) return void ctx.ui.notify(`${n.id} 이후 커밋이 없습니다`, "info");
        const yes = await ctx.ui.confirm(`${n.id} 로 되돌리기`,
          `${n.id} 이후의 커밋 ${after.length}개를 git revert 로 되돌립니다 (이력은 지우지 않고 되돌리는 커밋을 추가).\n계속할까요?`);
        if (!yes) return;
        const r = git(n.repo ?? e.root, ["revert", "--no-edit", `${n.commit}..HEAD`]);
        if (r == null) { git(n.repo ?? e.root, ["revert", "--abort"]); return void ctx.ui.notify("git revert 실패 (충돌 등) — 되돌리기를 취소했습니다", "error"); }
        e.note("decision", `Rolled back to ${n.id} (${n.commit.slice(0, 8)}) by reverting ${after.length} commit(s)`, "user request via /flow rollback");
        e.syncCommits(false);
        status(ctx);
        return void ctx.ui.notify(`${n.id} 로 되돌렸습니다 (revert 커밋 ${after.length}개)`, "info");
      }
      ctx.ui.notify("사용법: /flow · /flow show nN · /flow trace 키워드 · /flow new 목표 · /flow rollback p2 | <Flow id>:p2 · /flow undo · /flow rollback nN", "info");
    },
  });
}
