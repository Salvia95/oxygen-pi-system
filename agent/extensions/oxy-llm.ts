/**
 * oxy-llm: agent/llm.json 의 LLM 연결을 pi provider("oxy-<연결 id>")로 등록한다 (docs/tui-spec.md §11).
 *
 * - API 키는 agent/secrets.json(DPAPI)에서 시작할 때 한 번 복호화해 pi 프로세스 메모리에만 둔다.
 *   환경변수 · models.json · 명령줄에 남지 않으므로 bash 도구로 실행한 명령이 키를 읽을 수 없다.
 *   (models.json 의 "!command" 는 요청마다 실행되고 캐시되지 않아 쓰지 않는다)
 * - subagent(자식 pi)에는 부모가 띄울 때만 OXY_LLM_INHERIT_KEYS 로 넘기고, 자식은 읽자마자 process.env 에서 지운다.
 *   새 프로세스의 첫 DPAPI 복호화가 이 PC 에서 약 2초 걸려서다 (같은 프로세스의 두 번째부터는 0.4초, 2026-11-12 실측).
 * - 다른 extension(oxy-jobs)은 globalThis[Symbol.for("oxy.llm")] 로 연결 정보와 키를 얻는다.
 * LLM 연결을 등록하는 필수 extension 이라 끄는 스위치는 없다.
 */
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { harnessHome } from "./_lib/common.ts";

export const INHERIT_ENV = "OXY_LLM_INHERIT_KEYS";
const SHARED = Symbol.for("oxy.llm");

export interface SharedLlm {
  llm: any;                        // llm.json
  keys: Record<string, string>;    // secrets 키 이름 → 평문
  lib: any;                        // scripts/llm-connections.mjs
  problems: string[];
}

export const sharedLlm = (): SharedLlm | undefined => (globalThis as any)[SHARED];

/** 하네스 루트: OXY_HOME, 없으면 agent 폴더의 상위 (설치 배치: <루트>/agent) */
export const harnessRoot = (agentDir: string) => harnessHome() || resolve(agentDir, "..");

export default async function (pi: ExtensionAPI) {
  // 부모가 넘긴 키는 무엇보다 먼저 지운다 (이 프로세스가 띄우는 bash · MCP 서버에 남지 않게)
  const inherited = process.env[INHERIT_ENV];
  delete process.env[INHERIT_ENV];

  const agentDir = process.env.PI_CODING_AGENT_DIR || getAgentDir();
  const root = harnessRoot(agentDir);
  let lib: any;
  try { lib = await import(pathToFileURL(join(root, "scripts", "llm-connections.mjs")).href); } catch { return; }
  const llm = lib.loadLlm(agentDir);
  if (!llm) return;

  const problems: string[] = [];
  let keys: Record<string, string> = {};
  const wanted = llm.connections.map((c: any) => lib.secretKey(c.id));
  if (inherited) {
    try { keys = JSON.parse(Buffer.from(inherited, "base64").toString("utf8")); } catch { keys = {}; }
  }
  if (wanted.some((k: string) => !(k in keys))) {
    try {
      const secrets = await import(pathToFileURL(join(root, "installer", "secrets.mjs")).href);
      keys = { ...secrets.getSecrets(agentDir, wanted.filter((k: string) => !(k in keys))), ...keys };
    } catch (e: any) {
      problems.push(`API 키를 복호화하지 못했습니다: ${e?.message ?? e}`);
    }
  }

  for (const conn of llm.connections) {
    const kind = lib.LLM_KINDS[conn.kind];
    const key = keys[lib.secretKey(conn.id)];
    if (kind?.keyRequired && !key) {
      problems.push(`${conn.id} 연결의 API 키가 없어 등록하지 않았습니다. tweak.cmd의 LLM 연결에서 키를 다시 입력하세요.`);
      continue;
    }
    try {
      const { config, missing } = lib.providerConfig(root, conn, key);
      for (const m of missing) problems.push(`${conn.id} 연결의 모델 ${m}이 pi 내장 모델 목록에 없어 제외했습니다.`);
      pi.registerProvider(lib.providerId(conn.id), config);
    } catch (e: any) {
      problems.push(`${conn.id} 연결을 등록하지 못했습니다: ${e?.message ?? e}`);
    }
  }
  (globalThis as any)[SHARED] = { llm, keys, lib, problems } satisfies SharedLlm;

  pi.on("session_start", async (_e: any, ctx: any) => {
    if (!problems.length) return;
    if (ctx.hasUI) ctx.ui.notify(`[oxy-llm] ${problems.join("\n")}`, "warning");
    else for (const p of problems) process.stderr.write(`[oxy-llm] ${p}\n`);
  });
}
