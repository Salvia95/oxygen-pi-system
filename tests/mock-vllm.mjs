// 사내 vLLM 을 흉내 내는 최소 OpenAI 호환 서버 (하네스 E2E 점검용, 외부 의존성 없음)
//   node tests/mock-vllm.mjs <port> <request-log.jsonl>
// 1턴: bash tool call 을 반환 → 2턴(tool 결과 수신): tool 결과를 그대로 담은 텍스트로 종료
import http from "node:http";
import fs from "node:fs";

const port = Number(process.argv[2] ?? 18000);
const logFile = process.argv[3] ?? "mock-requests.jsonl";
const MODELS = ["qwen3.6-coder-30b", "qwen3.8-27b"];

const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    if (req.method === "GET" && req.url.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ object: "list", data: MODELS.map((id) => ({ id, object: "model" })) }));
    }
    if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) {
      res.writeHead(404); return res.end();
    }
    const body = JSON.parse(raw);
    fs.appendFileSync(logFile, JSON.stringify({ headers: req.headers, body }) + "\n");

    const last = body.messages.at(-1);
    const base = { id: "mock-1", object: "chat.completion.chunk", created: 0, model: body.model };
    const choice = (delta, finish_reason = null) => ({ ...base, choices: [{ index: 0, delta, finish_reason }] });

    if (!body.stream) { // verify.sh 의 비스트리밍 tool call 점검
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ...base, object: "chat.completion", choices: [{ index: 0, finish_reason: "tool_calls",
        message: { role: "assistant", content: null, tool_calls: [{ id: "call_0", type: "function",
          function: { name: body.tools?.[0]?.function?.name ?? "ping", arguments: "{}" } }] } }] }));
    }

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    if (last.role === "tool") {
      const text = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
      sse(res, choice({ role: "assistant", content: `MOCK-DONE tool output: ${text.trim()}` }));
      sse(res, choice({}, "stop"));
    } else {
      const args = JSON.stringify({ command: "echo hello-from-$(uname -o) && pwd && which fd jq sql glab" });
      sse(res, choice({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function",
        function: { name: "bash", arguments: "" } }] }));
      sse(res, choice({ tool_calls: [{ index: 0, function: { arguments: args } }] }));
      sse(res, choice({}, "tool_calls"));
    }
    sse(res, { ...base, choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } });
    res.end("data: [DONE]\n\n");
  });
}).listen(port, "127.0.0.1", () => console.log(`mock-vllm listening on 127.0.0.1:${port}`));
