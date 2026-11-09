// 테스트용 최소 MCP 서버 (stdio). 도구 check: 환경변수 OXY_ENVCHECK 가 기대값과 같은지 알려 준다.
// pi 가 mcp.json 의 env "!command" (secrets.mjs get) 를 실제로 실행해 값을 넘기는지 E2E 로 확인하는 데 쓴다.
//   node tests/mcp-envcheck.mjs <기대값>
import readline from "node:readline";

const expected = process.argv[2] ?? "";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.method === "initialize") {
    send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "envcheck", version: "1.0.0" } } });
  } else if (m.method === "tools/list") {
    send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "check", description: "Report whether the injected secret env var matches", inputSchema: { type: "object", properties: {} } }] } });
  } else if (m.method === "tools/call") {
    const v = process.env.OXY_ENVCHECK;
    const text = (v === undefined ? "ENVCHECK: unset" : v === expected ? "ENVCHECK: match" : `ENVCHECK: mismatch (len ${v.length})`) +
      ` CWD: ${process.cwd().replace(/\\/g, "/")}`;
    send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text }] } });
  } else if (m.id !== undefined) {
    send({ jsonrpc: "2.0", id: m.id, result: {} });
  }
});
