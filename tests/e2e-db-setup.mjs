// E2E 준비: 임시 agent 디렉터리에 SQLite 연결(dbhub)과 envcheck MCP 서버(비밀값 "!command" 주입)를 등록한다.
//   node tests/e2e-db-setup.mjs <하네스 루트> <agent 디렉터리> <sqlite 파일> <비밀값>
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { saveConnections } from "../installer/connections.mjs";
import { setSecret } from "../installer/secrets.mjs";

const [root, agent, db, secret] = process.argv.slice(2);
const fwd = (p) => p.replace(/\\/g, "/");
saveConnections(root, agent, [{ id: "e2edb", type: "sqlite", file: db, readonly: true, usql: true, dbhub: true }]);

// connections.mjs 와 같은 방식으로 비밀값을 "!command" 로 주입하는 테스트 서버
setSecret(agent, "test/envcheck", secret);
const mcpFile = join(agent, "mcp.json");
const mcp = JSON.parse(readFileSync(mcpFile, "utf8"));
const node = fwd(join(root, "runtime", "node", "node.exe"));
mcp.mcpServers.envcheck = {
  command: node,
  args: [fwd(join(root, "tests", "mcp-envcheck.mjs")), secret],
  env: { OXY_ENVCHECK: `!"${node}" "${fwd(join(root, "installer", "secrets.mjs"))}" get test/envcheck --agent "${fwd(agent)}"` },
  exposure: "direct",
  description: "E2E test server",
};
writeFileSync(mcpFile, JSON.stringify(mcp, null, 2) + "\n");
console.log("ok");
