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
    path: contentText(body.messages[0].content).match(/<location>([^<]*oracle-db-querying[^<]*SKILL\.md)<\/location>/)?.[1] ?? "missing",
  }) }],
  // pi 가 선언한 MCP 도구 중 이름이 맞는 것을 호출 (tool 이 함수면 body 로 이름을 고른다)
  "db-mcp": [{ tool: (body) => body.tools?.map((t) => t.function.name).find((n) => /^mcp__dbhub__execute_sql(_|$)/.test(n)) ?? "missing_dbhub_tool",
    args: { sql: "select count(*) as n from t" } }],
  "env-mcp": [{ tool: (body) => body.tools?.map((t) => t.function.name).find((n) => /^mcp__envcheck__check$/.test(n)) ?? "missing_envcheck_tool", args: {} }],
  // oxy-jobs: 백그라운드 작업 → 대화 종료 전 결과 알림 → 이어서 응답
  "bg-start": [{ tool: "background", args: { action: "start", command: "sleep 2; echo bg-finished-ok" } }, { text: "Waiting for the background job." }],
  "bg-guard": [{ tool: "background", args: { action: "start", command: "npm install lodash" } }],
  // 모니터 중지 요청 확인용: 오래 걸리는 작업 (모니터 쪽에서 control/ 로 중지한다)
  "bg-long": [{ tool: "background", args: { action: "start", command: "echo bg-long-started; sleep 60; echo bg-long-never" } }, { text: "Long job started." }],
  // oxy-jobs: subagent (자식 pi 의 첫 메시지 "Task: scenario:env ..." 도 env 시나리오로 응답)
  "sub-sync": [{ tool: "subagent", args: { agent: "scout", task: "scenario:env check the environment" } }],
  "sub-par": [{ tool: "subagent", args: { tasks: [
    { agent: "scout", task: "scenario:env A" }, { agent: "scout", task: "scenario:env B" }, { agent: "scout", task: "scenario:env C" },
  ] } }],
  // oxy-flow: 결정 기록 → 커밋 → 노드 / 사용량이 큰 응답으로 compaction · 세션 넘기기를 유발 (usage = prompt_tokens)
  "flow-commit": [
    { tool: "flow_note", args: { kind: "decision", text: "Store sessions in SQLite", why: "no DB server in the closed network" } },
    bash("echo hi > f.txt && git add f.txt && git -c user.name=t -c user.email=t@t commit -qm 'feat: add f'"),
    { text: "committed" },
  ],
  // oxy-flow 계획: 계획 쓰기 → 할 일 시작 → 커밋(진행 중인 할 일에 연결) → 완료
  "flow-plan": [
    { tool: "flow_plan", args: { action: "set", items: [{ text: "Add g file", children: [{ text: "write g" }, { text: "commit g" }] }, { text: "Report" }] } },
    { tool: "flow_plan", args: { action: "update", id: "p1.1", status: "doing" } },
    bash("echo g > g.txt && git add g.txt && git -c user.name=t -c user.email=t@t commit -qm 'feat: add g'"),
    { tool: "flow_plan", args: { action: "update", id: "p1", status: "done" } },
    { text: "planned" },
  ],
  "flow-big": [bash("echo step-one"), { ...bash("echo step-two"), usage: 120000 }, { text: "after-compaction" }],
  "flow-half": [{ text: "half-full", usage: 75000 }],
  // 작업 수준: 본 모델이 level 을 정해 맡긴다 (e2e 에서 deep = 범용 모델 + thinking)
  "sub-level": [{ tool: "subagent", args: { agent: "scout", task: "scenario:env deep check", level: "deep" } }],
  // 자식 pi 의 bash 에 부모가 넘긴 LLM 키(OXY_LLM_INHERIT_KEYS)가 남지 않는지
  // 실시간 활동(live.json): 본 대화의 도구가 몇 초 동안 실행되는 사이에 모니터가 상태를 읽는다
  "live-tool": [bash("sleep 8; echo live-tool-done"), { text: "live checked" }],   // 5초 넘게: 이벤트 없이도 updatedAt 이 갱신되는지
  "env-keys": [bash("echo inherit=${OXY_LLM_INHERIT_KEYS:-none}"), { text: "checked" }],
  // subagent 중지: 자식이 오래 걸리는 bash 를 실행하는 중에 부모가 그 작업을 멈춘다 (손자 프로세스가 남지 않아야 한다)
  // MOCK_SLEEP: 실행마다 다른 표식 (예 41.12345). E2E 가 이 표식의 sleep 만 세고 정리해서 다른 실행에 간섭하지 않는다
  "env-sleep": [bash(`echo child-sleep-start; sleep ${process.env.MOCK_SLEEP ?? "41"}; echo child-sleep-never`), { text: "slept" }],
  "sub-stop": [
    { tool: "subagent", args: { agent: "scout", task: "scenario:env-sleep long", level: "light", wait: false } },
    bash("sleep 6"),
    { tool: "background", args: { action: "stop", id: "job-1" } },
    { text: "stopped-subagent" },
  ],
  "sub-keys": [{ tool: "subagent", args: { agent: "scout", task: "scenario:env-keys look", level: "light" } }],
  // 여러 연결: deep 은 Claude 연결로 (E2E 가 llm.json 에 연결 claude 를 더한 뒤)
  "sub-claude": [{ tool: "subagent", args: { tasks: [{ agent: "scout", task: "claude-task review", level: "deep" }, { agent: "scout", task: "scenario:env vllm-task", level: "light" }] } }],
  "sub-async": [{ tool: "subagent", args: { agent: "scout", task: "scenario:env async check", wait: false } }, { text: "Delegated; waiting." }],
};

let busySince = null;
const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
const contentText = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => p.text ?? "").join("") : JSON.stringify(c));

http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    // vLLM /metrics 흉내: 첫 요청 후 MOCK_BUSY_MS 동안은 대기 요청 1건으로 응답 (oxy-jobs 혼잡 감지 점검)
    if (req.method === "GET" && req.url === "/metrics") {
      busySince ??= Date.now();
      const busy = Date.now() - busySince < Number(process.env.MOCK_BUSY_MS ?? 0);
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end(`# HELP vllm:num_requests_waiting x\nvllm:num_requests_waiting{model_name="m"} ${busy ? 1 : 0}\n` +
        `vllm:num_requests_running{model_name="m"} 1\nvllm:kv_cache_usage_perc{model_name="m"} 0.3\n`);
    }
    if (req.method === "GET" && req.url.endsWith("/models")) {
      // MOCK_TPM: 분당 토큰 한도 헤더 (OpenAI 호환 서비스 흉내. 설치 TUI · Tweak 의 사용량 제한 맞춤 설정)
      res.writeHead(200, { "content-type": "application/json", ...(process.env.MOCK_TPM ? { "x-ratelimit-limit-tokens": process.env.MOCK_TPM } : {}) });
      return res.end(JSON.stringify({ object: "list", data: MODELS.map((id) => ({ id, object: "model", max_model_len: 131072 })) }));
    }
    if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) { res.writeHead(404); return res.end(); }
    const body = JSON.parse(raw);
    fs.appendFileSync(logFile, JSON.stringify({ t: Date.now(), headers: req.headers, body }) + "\n");
    // OpenAI 표준이 아닌 파라미터를 거부하는 앞단 게이트웨이 흉내 (사내에서 실제로 받은 오류 형식)
    //   MOCK_STRICT=1: 확장 파라미터 전부 거부 · MOCK_STRICT_PARAMS=a,b: 지정한 것만 거부
    const strictList = process.env.MOCK_STRICT === "1" ? ["top_k", "repetition_penalty", "min_p", "chat_template_kwargs"]
      : (process.env.MOCK_STRICT_PARAMS ?? "").split(",").filter(Boolean);
    const strictBad = strictList.find((k) => k in body);
    if (strictBad) {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ message: `property '${strictBad}' is unsupported`, type: "invalid_request_error" }));
    }
    const base = { id: "mock-1", object: "chat.completion.chunk", created: 0, model: body.model };

    if (!body.stream) { // verify.sh 의 비스트리밍 tool call 점검 · 설치 TUI 의 파라미터 시험
      res.writeHead(200, { "content-type": "application/json", ...(process.env.MOCK_TPM ? { "x-ratelimit-limit-tokens": process.env.MOCK_TPM } : {}) });
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
    // compaction 뒤에는 요약(oxy-flow) 안의 "Latest user request" 가 원래 요청이다
    const name = anchorText.match(/Latest user request: scenario:([\w-]+)/)?.[1] ?? anchorText.match(/scenario:([\w-]+)/)?.[1] ?? "env";
    const script = SCENARIOS[name] ?? SCENARIOS.env;
    const step = body.messages.slice(anchor + 1).filter((m) => m.role === "assistant").length;
    const choice = (delta, finish_reason = null) => ({ ...base, choices: [{ index: 0, delta, finish_reason }] });

    // subagent(자식 pi) 요청을 늦춰 동시 실행 여부를 관찰할 수 있게 한다 (MOCK_CHILD_DELAY_MS)
    const firstUser = contentText(body.messages.find((m) => m.role === "user")?.content ?? "");
    if (/^Task:/.test(firstUser) && Number(process.env.MOCK_CHILD_DELAY_MS)) {
      await new Promise((r) => setTimeout(r, Number(process.env.MOCK_CHILD_DELAY_MS)));
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const item = script[step];
    if (item?.tool) {
      const toolName = typeof item.tool === "function" ? item.tool(body) : item.tool;
      sse(res, choice({ role: "assistant", tool_calls: [{ index: 0, id: `call_${step}`, type: "function", function: { name: toolName, arguments: "" } }] }));
      sse(res, choice({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(typeof item.args === "function" ? item.args(body) : item.args) } }] }));
      sse(res, choice({}, "tool_calls"));
    } else {
      const text = item?.text ?? `MOCK-DONE ${body.messages.at(-1).role}: ${contentText(body.messages.at(-1).content).trim()}`;
      sse(res, choice({ role: "assistant", content: text }));
      sse(res, choice({}, "stop"));
    }
    const pt = item?.usage ?? 100;
    sse(res, { ...base, choices: [], usage: { prompt_tokens: pt, completion_tokens: 10, total_tokens: pt + 10 } });
    res.end("data: [DONE]\n\n");
  });
}).listen(port, "127.0.0.1", () => console.log(`mock-vllm listening on 127.0.0.1:${port}`));
