// Anthropic Messages API mock (SSE). 여러 LLM 연결 · 작업 수준 · DPAPI 키 전달을 E2E 로 확인할 때 쓴다.
//   node tests/mock-anthropic.mjs <port> <요청 로그.jsonl>     (MOCK_ANTHROPIC_KEY: 기대하는 x-api-key, 로그에는 일치 여부만 남긴다)
//   POST /v1/messages : 첫 user 글을 되돌려 주는 글 응답 "MOCK-ANTHROPIC <글 앞부분>"
//   GET  /v1/models   : claude-haiku-5-5 하나 (상태 점검용)
//   MOCK_ANTHROPIC_WORKSPACE=wrkspc_x 이면 워크스페이스가 지정되지 않은 조직 키처럼 동작한다 (공식 문서의 오류 문구):
//     anthropic-workspace-id 헤더 없음 → 400, 형식 오류 → 400, 다른 ID → 404. GET /v1/organizations/workspaces 는 Default + 그 ID
//   MOCK_ANTHROPIC_WORKSPACE_LIST=deny 이면 워크스페이스 목록을 403 으로 거부한다 (권한이 없는 키. 화면은 바로 ID 입력으로)
import fs from "node:fs";
import http from "node:http";

const [port, logFile] = process.argv.slice(2);
const want = process.env.MOCK_ANTHROPIC_KEY ?? "";
const ws = process.env.MOCK_ANTHROPIC_WORKSPACE ?? "";
const fail = (res, status, type, message) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify({ type: "error", error: { type, message } })); };
/** 워크스페이스 규칙에 걸리면 응답하고 true */
function workspaceRule(req, res) {
  if (!ws) return false;
  const h = req.headers["anthropic-workspace-id"];
  if (!h) { fail(res, 400, "invalid_request_error", "This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use. Add the header, or use an API key that is scoped to a workspace."); return true; }
  if (!/^wrkspc_[A-Za-z0-9]+$/.test(h)) { fail(res, 400, "invalid_request_error", "anthropic-workspace-id header must be a valid workspace ID."); return true; }
  if (h !== ws) { fail(res, 404, "not_found_error", `Workspace ${h} not found.`); return true; }
  return false;
}
let n = 0;
const sse = (res, events) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
};
const textOf = (c) => (typeof c === "string" ? c : (c ?? []).filter((b) => b?.type === "text").map((b) => b.text).join(""));

http.createServer((req, res) => {
  let b = "";
  req.on("data", (d) => (b += d));
  req.on("end", () => {
    if (req.method === "GET" && req.url.startsWith("/v1/organizations/workspaces")) {
      if (process.env.MOCK_ANTHROPIC_WORKSPACE_LIST === "deny") return fail(res, 403, "permission_error", "This API key does not have permission to list workspaces.");
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ data: ws ? [{ id: "wrkspc_default0", name: "Default", archived_at: null }, { id: ws, name: "oxy-test", archived_at: null },
        { id: "wrkspc_old0", name: "old", archived_at: "2026-01-01T00:00:00Z" }] : [], has_more: false }));
    }
    if (workspaceRule(req, res)) return;
    if (req.method === "GET" && req.url.startsWith("/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ data: [{ id: "claude-haiku-5-5", type: "model", display_name: "Claude Haiku 5.5", max_input_tokens: 1000000, max_tokens: 128000 }] }));
    }
    const body = JSON.parse(b || "{}");
    n++;
    const firstUser = textOf((body.messages ?? []).find((m) => m.role === "user")?.content);
    const effort = [...(body.messages ?? [])].reverse().find((m) => m.role === "system" && m.output_config)?.output_config?.effort ?? body.output_config?.effort ?? null;
    fs.appendFileSync(logFile, JSON.stringify({ n, keyMatches: Boolean(want) && req.headers["x-api-key"] === want, model: body.model, max_tokens: body.max_tokens,
      thinking: body.thinking?.type ?? null, effort, workspace: req.headers["anthropic-workspace-id"] ?? null, firstUser: firstUser.slice(0, 80) }) + "\n");
    const text = `MOCK-ANTHROPIC ${firstUser.slice(0, 60)}`;
    sse(res, [
      { type: "message_start", message: { id: `msg_${n}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
      { type: "message_stop" },
    ]);
  });
}).listen(Number(port));
