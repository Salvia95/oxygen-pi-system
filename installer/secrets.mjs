// 비밀값 저장소: agent/secrets.json  { "<key>": "<DPAPI 암호문>" }
// Windows DPAPI(CurrentUser)로 암호화하므로 같은 Windows 사용자만 복호화할 수 있다. 평문은 디스크·명령줄에 남기지 않는다
// (PowerShell 에는 stdin 으로 전달). git·번들에서 제외된다.
//
//   CLI: node installer/secrets.mjs get <key> --agent <agent 디렉터리>      (pi mcp.json 의 "!command" 에서 사용)
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const file = (agentDir) => join(agentDir, "secrets.json");
const load = (agentDir) => { try { return JSON.parse(readFileSync(file(agentDir), "utf8")); } catch { return {}; } };
const save = (agentDir, data) => { mkdirSync(agentDir, { recursive: true }); writeFileSync(file(agentDir), JSON.stringify(data, null, 2) + "\n"); };

function powershell(script, input) {
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64")], { input, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error((r.stderr || "powershell 실패").trim().split("\n")[0]);
  return r.stdout;
}

const UTF8 = "[Console]::InputEncoding = [Text.Encoding]::UTF8; [Console]::OutputEncoding = [Text.Encoding]::UTF8;";

export function protect(plain) {
  return powershell(`${UTF8}
    $p = [Console]::In.ReadToEnd()
    ConvertFrom-SecureString (ConvertTo-SecureString $p -AsPlainText -Force)`, plain).trim();
}

export function unprotect(blob) {
  return powershell(`${UTF8}
    $s = ConvertTo-SecureString ([Console]::In.ReadToEnd().Trim())
    $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
    try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }`, blob);
}

export const hasSecret = (agentDir, key) => Boolean(load(agentDir)[key]);
export function setSecret(agentDir, key, value) { const d = load(agentDir); d[key] = protect(value); save(agentDir, d); }
export function getSecret(agentDir, key) { const b = load(agentDir)[key]; return b ? unprotect(b) : undefined; }
export function deleteSecret(agentDir, key) { const d = load(agentDir); delete d[key]; save(agentDir, d); }

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [cmd, key] = process.argv.slice(2);
  const ai = process.argv.indexOf("--agent");
  const agentDir = ai > 0 ? resolve(process.argv[ai + 1]) : join(dirname(fileURLToPath(import.meta.url)), "..", "agent");
  if (cmd !== "get" || !key) { console.error("usage: secrets.mjs get <key> --agent <dir>"); process.exit(2); }
  if (!existsSync(file(agentDir))) process.exit(1);
  const v = getSecret(agentDir, key);
  if (v === undefined) process.exit(1);
  process.stdout.write(v);
}
