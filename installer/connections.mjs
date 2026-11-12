// DB 연결 관리 (Tweak TUI 와 wrappers/usql 이 사용).
// 연결 정보는 agent/connections.json (비밀번호 제외), 비밀번호는 agent/secrets.json (DPAPI) 에 둔다.
// 여기서 다음 파일을 생성한다 (모두 PC 로컬, git·번들 제외):
//   agent/usql.yaml   usql 이름 붙은 연결 (비밀번호 없음)
//   agent/dbhub.toml  dbhub 소스·도구 (비밀번호는 ${OXY_DB_<ID>_PASSWORD} 참조)
//   agent/mcp.json    pi MCP 서버 "dbhub" 등록 (환경변수 값은 "!command" 로 실행 시점에 복호화)
//
//   CLI: node installer/connections.mjs usql-config <출력 파일> --agent <dir>
//        → 비밀번호를 넣은 usql 설정을 임시로 만든다 (wrappers/usql 이 실행 직후 지운다)
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getSecret, hasSecret } from "./secrets.mjs";

export const DB_TYPES = {
  postgres: { label: "PostgreSQL", port: 5432, usql: "postgres", dbhub: "postgres", probe: "select 1" },
  mysql: { label: "MySQL", port: 3306, usql: "mysql", dbhub: "mysql", probe: "select 1" },
  mariadb: { label: "MariaDB", port: 3306, usql: "mysql", dbhub: "mariadb", probe: "select 1" },
  sqlserver: { label: "SQL Server", port: 1433, usql: "sqlserver", dbhub: "sqlserver", probe: "select 1" },
  oracle: { label: "Oracle", port: 1521, usql: "oracle", dbhub: "oracle", probe: "select 1 from dual" },
  sqlite: { label: "SQLite (파일)", usql: "sqlite", dbhub: "sqlite", probe: "select 1" },
};

export const ID_RE = /^[a-z][a-z0-9_-]{0,30}$/;
export const secretKey = (id) => `db/${id}`;
export const passwordVar = (id) => `OXY_DB_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_PASSWORD`;

const enc = encodeURIComponent;
const fwd = (p) => p.replace(/\\/g, "/");

/** usql 용 DSN. password 를 주면 넣는다 (임시 설정 파일에만 사용) */
export function usqlDsn(c, password) {
  const t = DB_TYPES[c.type];
  if (c.type === "sqlite") return `sqlite:${fwd(c.file)}`;
  const cred = c.user ? `${enc(c.user)}${password ? ":" + enc(password) : ""}@` : "";
  return `${t.usql}://${cred}${c.host}:${c.port ?? t.port}/${enc(c.database ?? "")}`;
}

const yamlStr = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const tomlStr = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export function usqlYaml(conns, passwords = {}) {
  const list = conns.filter((c) => c.usql);
  if (!list.length) return "";
  return "# oxygen-pi-system Tweak TUI 가 생성 (직접 고치지 말 것: agent/connections.json 이 원본)\nconnections:\n" +
    list.map((c) => `  ${c.id}: ${yamlStr(usqlDsn(c, passwords[c.id]))}`).join("\n") + "\n";
}

export function dbhubToml(conns, withPassword) {
  const list = conns.filter((c) => c.dbhub);
  const out = ["# oxygen-pi-system Tweak TUI 가 생성 (직접 고치지 말 것: agent/connections.json 이 원본)"];
  for (const c of list) {
    const t = DB_TYPES[c.type];
    out.push("", "[[sources]]", `id = ${tomlStr(c.id)}`);
    if (c.description) out.push(`description = ${tomlStr(c.description)}`);
    if (c.type === "sqlite") out.push(`dsn = ${tomlStr(`sqlite:///${fwd(c.file)}`)}`);
    else {
      out.push(`type = ${tomlStr(t.dbhub)}`, `host = ${tomlStr(c.host)}`, `port = ${c.port ?? t.port}`,
        `database = ${tomlStr(c.database ?? "")}`, `user = ${tomlStr(c.user ?? "")}`);
      if (withPassword(c)) out.push(`password = ${tomlStr("${" + passwordVar(c.id) + "}")}`);
      // lazy: 접속할 수 없는 DB 가 하나 있어도 dbhub 서버 전체가 시작 실패하지 않도록, 처음 쓸 때 접속
      out.push("lazy = true", "connection_timeout = 10");
    }
    for (const tool of ["execute_sql", "search_objects"]) {
      out.push("", "[[tools]]", `name = "${tool}"`, `source = ${tomlStr(c.id)}`);
      if (tool === "execute_sql") out.push(`readonly = ${c.readonly !== false}`, "max_rows = 200");
    }
  }
  return out.join("\n") + "\n";
}

// ------------------------------------------------------------------ 파일 입출력
const connFile = (agentDir) => join(agentDir, "connections.json");
export const loadConnections = (agentDir) => { try { return JSON.parse(readFileSync(connFile(agentDir), "utf8")); } catch { return []; } };

/**
 * connections.json 저장 + usql.yaml / dbhub.toml / mcp.json 재생성.
 * root: 하네스 루트 (node.exe, dbhub, secrets.mjs 경로 계산용)
 */
export function saveConnections(root, agentDir, conns) {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(connFile(agentDir), JSON.stringify(conns, null, 2) + "\n");

  const yaml = usqlYaml(conns);
  const yamlFile = join(agentDir, "usql.yaml");
  if (yaml) writeFileSync(yamlFile, yaml); else rmSync(yamlFile, { force: true });

  const dbhubConns = conns.filter((c) => c.dbhub);
  const tomlFile = join(agentDir, "dbhub.toml");
  const withPw = (c) => c.type !== "sqlite" && hasSecret(agentDir, secretKey(c.id));
  if (dbhubConns.length) writeFileSync(tomlFile, dbhubToml(conns, withPw)); else rmSync(tomlFile, { force: true });

  // pi MCP 등록: 기존 mcp.json 의 다른 서버는 유지
  const mcpFile = join(agentDir, "mcp.json");
  let mcp = {};
  try { mcp = JSON.parse(readFileSync(mcpFile, "utf8")); } catch { /* 새로 만든다 */ }
  mcp.mcpServers ??= {};
  const node = fwd(join(root, "runtime", "node", "node.exe"));
  const entry = fwd(join(root, "vendor", "dbhub", "node_modules", "@bytebase", "dbhub", "dist", "index.js"));
  if (dbhubConns.length && existsSync(entry)) {
    const env = {};
    for (const c of dbhubConns.filter(withPw)) {
      // pi 가 서버를 시작할 때 Git Bash 로 실행해 복호화한다 (전역 환경변수에 비밀번호를 두지 않음)
      env[passwordVar(c.id)] = `!"${node}" "${fwd(join(root, "installer", "secrets.mjs"))}" get ${secretKey(c.id)} --agent "${fwd(agentDir)}"`;
    }
    mcp.mcpServers.dbhub = {
      command: node,
      args: [entry, "--transport", "stdio", "--config", fwd(tomlFile)],
      ...(Object.keys(env).length ? { env } : {}),
      exposure: "direct",
      description: `사내 DB 조회 (execute_sql, search_objects): ${dbhubConns.map((c) => `${c.id}=${DB_TYPES[c.type].label}${c.readonly !== false ? " 읽기전용" : ""}`).join(", ")}`,
    };
  } else delete mcp.mcpServers.dbhub;
  if (Object.keys(mcp.mcpServers).length) writeFileSync(mcpFile, JSON.stringify(mcp, null, 2) + "\n");
  else rmSync(mcpFile, { force: true });
}

/** 비밀번호를 넣은 usql 설정을 만든다 (호출한 쪽이 사용 후 지운다) */
export function writeUsqlConfigWithSecrets(agentDir, outFile) {
  const conns = loadConnections(agentDir).filter((c) => c.usql);
  const passwords = {};
  for (const c of conns) if (c.type !== "sqlite" && hasSecret(agentDir, secretKey(c.id))) passwords[c.id] = getSecret(agentDir, secretKey(c.id));
  writeFileSync(outFile, usqlYaml(conns, passwords) || "connections: {}\n");
}

/** usql 로 연결 테스트: {ok, output} */
export function probeConnection(root, agentDir, c, password) {
  const tmp = join(tmpdir(), `oxy-usql-${process.pid}-${Date.now()}.yaml`);
  try {
    writeFileSync(tmp, usqlYaml([{ ...c, usql: true }], password ? { [c.id]: password } : {}));
    const r = spawnSync(join(root, "bin", "usql.exe"), ["--config", tmp, c.id, "-w", "-q", "--csv", "-c", DB_TYPES[c.type].probe],
      { encoding: "utf8", timeout: 20000, windowsHide: true });
    const output = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
    return { ok: r.status === 0 && !/error/i.test(output), output: output.split(/\r?\n/).slice(-3).join(" ") || (r.error?.message ?? "") };
  } finally { rmSync(tmp, { force: true }); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [cmd, out] = process.argv.slice(2);
  const ai = process.argv.indexOf("--agent");
  const agentDir = ai > 0 ? resolve(process.argv[ai + 1]) : join(dirname(fileURLToPath(import.meta.url)), "..", "agent");
  if (cmd !== "usql-config" || !out) { console.error("usage: connections.mjs usql-config <out> --agent <dir>"); process.exit(2); }
  writeUsqlConfigWithSecrets(agentDir, resolve(out));
}
