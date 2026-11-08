// 사내 vLLM 을 흉내 내는 최소 OpenAI 호환 서버 (하네스 E2E 점검용, 외부 의존성 없음)
//   node tests/mock-vllm.mjs <port> <request-log.jsonl>
//
// 첫 user 메시지의 `scenario:<name>` 으로 시나리오를 고른다. 각 시나리오는 assistant 턴 순서대로의 응답 목록이며,
// 목록이 끝나면 마지막 메시지 내용을 그대로 담은 "MOCK-DONE ..." 텍스트로 종료한다.
import http from "node:http";
import fs from "node:fs";

const port = Number(process.argv[2] ?? 18000);
const logFile = process.argv[3] ?? "mock-requests.jsonl";
const MODELS = ["qwen3.6-coder-30b", "qwen3.8-27b"];

const bash = (command) => ({ tool: "bash", args: { command } });
const SCENARIOS = {
  env: [bash("echo hello-from-$(uname -o) && pwd && which fd jq sql glab")],
  "offline-install": [bash("npm install lodash")],
  "git-push": [bash("git status >/dev/null 2>&1; git push origin main")],
  "edit-unread": [{ tool: "edit", args: { path: "sample.txt", edits: [{ oldText: "hello", newText: "bye" }] } }],
  "write-existing": [{ tool: "write", args: { path: "sample.txt", content: "overwritten\n" } }],
  "read-then-edit": [
    { tool: "read", args: { path: "sample.txt" } },
    { tool: "edit", args: { path: "sample.txt", edits: [{ oldText: "hello", newText: "bye" }] } },
  ],
  "big-output": [bash("seq 1 30000")],
  "text-toolcall": [{ text: 'I will run it: <tool_call>{"name": "bash", "arguments": {"command": "ls"}}</tool_call>' }],
  repeat: [bash("echo same"), bash("echo same"), bash("echo same")],
  // 시스템 프롬프트에 노출된 skill 위치를 그대로 read 로 연다 (실제 모델의 skill 로딩 흉내)
  "read-skill": [{ tool: "read", args: (body) => ({
    path: contentText(body.messages[0].content).match(/<location>([^<]*oracle-sqlcl[^<]*SKILL\.md)<\/location>/)?.[1] ?? "missing",
  }) }],
};

const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
const contentText = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => p.text ?? "").join("") : JSON.stringify(c));

http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    if (req.method === "GET" && req.url.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ object: "list", data: MODELS.map((id) => ({ id, object: "model", max_model_len: 131072 })) }));
    }
    if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) { res.writeHead(404); return res.end(); }
    const body = JSON.parse(raw);
    fs.appendFileSync(logFile, JSON.stringify({ headers: req.headers, body }) + "\n");
    const base = { id: "mock-1", object: "chat.completion.chunk", created: 0, model: body.model };

    if (!body.stream) { // verify.sh 의 비스트리밍 tool call 점검
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ...base, object: "chat.completion", choices: [{ index: 0, finish_reason: "tool_calls",
        message: { role: "assistant", content: null, tool_calls: [{ id: "call_0", type: "function",
          function: { name: body.tools?.[0]?.function?.name ?? "ping", arguments: "{}" } }] } }] }));
    }

    // 가장 최근의 `scenario:` user 메시지 기준 (TUI 데모에서 한 세션에 여러 시나리오를 이어서 시험 가능)
    // scenario: 가 없는 일반 메시지는 그 메시지 기준으로 env 시나리오를 실행
    let anchor = -1;
    for (let i = body.messages.length - 1; i >= 0; i--) {
      const m = body.messages[i];
      if (m.role !== "user") continue;
      const t = contentText(m.content);
      if (t.startsWith("[oxy-")) continue; // extension 이 넣은 안내 메시지는 건너뜀
      anchor = i;
      break;
    }
    const anchorText = anchor >= 0 ? contentText(body.messages[anchor].content) : "";
    const name = anchorText.match(/scenario:([\w-]+)/)?.[1] ?? "env";
    const script = SCENARIOS[name] ?? SCENARIOS.env;
    const step = body.messages.slice(anchor + 1).filter((m) => m.role === "assistant").length;
    const choice = (delta, finish_reason = null) => ({ ...base, choices: [{ index: 0, delta, finish_reason }] });

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const item = script[step];
    if (item?.tool) {
      sse(res, choice({ role: "assistant", tool_calls: [{ index: 0, id: `call_${step}`, type: "function", function: { name: item.tool, arguments: "" } }] }));
      sse(res, choice({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(typeof item.args === "function" ? item.args(body) : item.args) } }] }));
      sse(res, choice({}, "tool_calls"));
    } else {
      const text = item?.text ?? `MOCK-DONE ${body.messages.at(-1).role}: ${contentText(body.messages.at(-1).content).trim()}`;
      sse(res, choice({ role: "assistant", content: text }));
      sse(res, choice({}, "stop"));
    }
    sse(res, { ...base, choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } });
    res.end("data: [DONE]\n\n");
  });
}).listen(port, "127.0.0.1", () => console.log(`mock-vllm listening on 127.0.0.1:${port}`));
