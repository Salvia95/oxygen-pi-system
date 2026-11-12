// 설치 TUI 의 시스템 작업: 환경 점검, 파일 복사, PATH/Windows Terminal/바로가기 등록, 설치 기록.
// sandbox 를 주면 레지스트리·바탕화면·AppData 대신 sandbox 디렉터리 안에만 기록한다 (테스트용).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { CATALOG, readLock } from "./components.mjs";

export const MARKER = ".oxy-install";
export const WT_PROFILE_NAME = "Oxygen Pi";
const WT_GUID = "{6f1d3c2a-8b4e-4c7d-9a2f-0e5b7c3d1a90}";

/** 설치 대상으로 복사하지 않는 경로 (번들 루트 기준, 소문자, / 구분). PC별 설정·생성물은 기존 것을 유지 */
const COPY_EXCLUDE = [".cache", "dist", ".git", ".oxy-selection", "optional", "agent/oxy.env", "agent/settings.json",
  "agent/models.json", "agent/auth.json", "agent/models-store.json", "agent/sessions", "agent/skills",
  "agent/usql.yaml", "agent/dbhub.toml", "agent/connections.json", "agent/secrets.json", "agent/llm.json", "agent/mcp.json",
  "agent/mcp.log", "agent/mcp.log.1", "agent/mcp-auth.json", "agent/jobs", "agent/psmux.conf",
  // 화면 프로그램(oxy-tui)의 빌드 산출물과 캡처 도구의 상태 파일 (개발 PC 에만 있다)
  "installer/oxy-tui/target", "tests/tui-capture/.state"];

/** 하네스 자체 파일 (구성요소 바이너리 외) */
const HARNESS_FILES = [
  "installer/components.mjs", "wrappers/sql", "wrappers/jq", "config/ripgreprc", "agent/templates/models.json",
  "agent/templates/settings.json", "env.sh", "oxy", "oxy.cmd", "scripts/verify.sh", "manifest/tools.lock.tsv", "scripts/mux/psmux.sh",
];

/**
 * 터미널 셸 (oxy.env 의 OXY_TERMINAL_SHELL): Windows Terminal 프로필과 바탕화면 바로가기가 여는 셸 (docs/tui-spec.md §10).
 * pi 의 bash 도구와 psmux pane 의 셸은 이 값과 관계없이 항상 Git Bash 다.
 */
export const TERMINAL_SHELLS = ["git-bash", "cmd", "powershell"];
export const SHELL_NAMES = { "git-bash": "Git Bash", cmd: "명령 프롬프트", powershell: "PowerShell" };
export const normShell = (v) => (TERMINAL_SHELLS.includes(v) ? v : "git-bash");

export const toPosix = (p) => p.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
const fwd = (p) => p.replace(/\\/g, "/");
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`; // PowerShell 작은따옴표 문자열

function powershell(script) {
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8" });
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || "powershell 실패").trim().split("\n")[0]);
  return r.stdout.trim();
}

export function createSystem({ root, sandbox = null }) {
  const LOCAL = sandbox ? join(sandbox, "LocalAppData") : process.env.LOCALAPPDATA;
  const ROAMING = sandbox ? join(sandbox, "AppData") : process.env.APPDATA;
  const registryFile = join(ROAMING, "oxygen-pi", "install.json");
  const sys = {
    root,
    sandbox,
    defaultInstallDir: join(LOCAL, "Programs", "oxygen-pi"),
    registryFile,

    // ---------------------------------------------------------- 점검
    findGitBash() {
      const cands = [
        process.env.ProgramFiles && join(process.env.ProgramFiles, "Git", "bin", "bash.exe"),
        process.env["ProgramFiles(x86)"] && join(process.env["ProgramFiles(x86)"], "Git", "bin", "bash.exe"),
        process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"),
      ].filter(Boolean);
      const where = spawnSync("where.exe", ["git"], { encoding: "utf8" });
      for (const g of (where.stdout || "").split(/\r?\n/).filter(Boolean)) {
        cands.push(join(dirname(dirname(g)), "bin", "bash.exe")); // <git>\cmd\git.exe → <git>\bin\bash.exe
      }
      return cands.find((p) => existsSync(p)) ?? null;
    },
    checkJava() {
      const r = spawnSync("java", ["-version"], { encoding: "utf8" });
      const text = `${r.stderr ?? ""}${r.stdout ?? ""}`;
      const m = text.match(/version "(\d+)(?:\.(\d+))?/);
      if (!m) return { ok: false, detail: "찾을 수 없음" };
      const major = m[1] === "1" ? Number(m[2]) : Number(m[1]);
      return { ok: major >= 17, major, detail: text.split(/\r?\n/)[0] };
    },
    /** 번들에 없는 필수 파일: 하네스 파일 + manifest 의 필수(role=required) 구성요소 */
    missingBundleFiles() {
      const required = readLock(root).filter((e) => e.required).map((e) => CATALOG[e.name]?.check).filter(Boolean);
      return [...HARNESS_FILES, ...required].filter((f) => !existsSync(join(root, f)));
    },
    version() {
      try { return readFileSync(join(root, "VERSION"), "utf8").trim(); } catch { return "dev"; }
    },

    // ---------------------------------------------------------- 설치 위치
    /** 대상 경로 상태: empty | ours(기존 oxygen-pi 설치) | foreign(다른 파일 있음) | file */
    inspectTarget(dir) {
      if (!existsSync(dir)) return "empty";
      if (!statSync(dir).isDirectory()) return "file";
      if (existsSync(join(dir, MARKER))) return "ours";
      return readdirSync(dir).length === 0 ? "empty" : "foreign";
    },
    isSameDir(a, b) { return resolve(a).toLowerCase() === resolve(b).toLowerCase(); },

    /** extraExclude: 사용자가 선택하지 않은 번들 구성요소 (예: runtime/sqlcl, vendor/browsers/chromium) */
    async copyBundle(dest, onProgress, extraExclude = []) {
      const skip = [...COPY_EXCLUDE, ...extraExclude.map((e) => e.toLowerCase())];
      const excluded = (src) => {
        const rel = fwd(relative(root, src)).toLowerCase();
        return rel !== "" && skip.some((e) => rel === e || rel.startsWith(e + "/"));
      };
      let total = 0;
      const walk = (d) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const p = join(d, e.name);
          if (excluded(p)) continue;
          if (e.isDirectory()) walk(p); else total++;
        }
      };
      walk(root);
      // 복사 전에 설치 표시(partial)를 쓴다: 복사 중에 끊겨도 다음 실행이 이 폴더를 우리 설치(ours)로 보고 이어서 복사한다
      mkdirSync(dest, { recursive: true });
      sys.writeMarker(dest, { partial: true });
      let done = 0;
      let lastTick = 0;
      await cp(root, dest, {
        recursive: true, force: true, errorOnExist: false,
        filter: async (src) => {
          if (excluded(src)) return false;
          if (!statSync(src).isDirectory()) {
            done++;
            const now = Date.now();
            if (now - lastTick > 100) { lastTick = now; onProgress?.(done, total); }
          }
          return true;
        },
      });
      onProgress?.(total, total);
      sys.writeMarker(dest);
      return total;
    },
    writeMarker(dir, extra = {}) {
      writeFileSync(join(dir, MARKER), JSON.stringify({ version: sys.version(), installedAt: new Date().toISOString(), ...extra }) + "\n");
    },
    /** 설치 표시 내용 (없으면 null). partial: 복사가 끝나지 않은 폴더 */
    readMarker(dir) {
      try { return JSON.parse(readFileSync(join(dir, MARKER), "utf8")); } catch { return existsSync(join(dir, MARKER)) ? {} : null; }
    },
    /** 폴더 안 파일 수와 크기 (제거 확인 화면용) */
    dirStats(dir) {
      let files = 0;
      let bytes = 0;
      const walk = (d) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const p = join(d, e.name);
          if (e.isDirectory()) walk(p);
          else { files++; try { bytes += statSync(p).size; } catch { /* 사라진 파일 */ } }
        }
      };
      try { walk(dir); } catch { /* 읽을 수 없는 폴더 */ }
      return { files, bytes };
    },

    // ---------------------------------------------------------- PATH (사용자 환경변수)
    addUserPath(dir) {
      if (sandbox) { writeFileSync(join(sandbox, "user-path.txt"), dir + "\n"); return; }
      powershell(`
        $dir = ${psq(dir)}
        $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
        $cur = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        $parts = @($cur -split ';' | Where-Object { $_ -ne '' })
        if (-not ($parts | Where-Object { $_.TrimEnd('\\') -ieq $dir.TrimEnd('\\') })) { $parts += $dir }
        $key.SetValue('Path', ($parts -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
        $key.Close()
        [Environment]::SetEnvironmentVariable('OXY_HOME', $dir, 'User')`);
    },
    removeUserPath(dir) {
      if (sandbox) { rmSync(join(sandbox, "user-path.txt"), { force: true }); return; }
      powershell(`
        $dir = ${psq(dir)}
        $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
        $cur = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        $parts = @($cur -split ';' | Where-Object { $_ -ne '' -and $_.TrimEnd('\\') -ine $dir.TrimEnd('\\') })
        $key.SetValue('Path', ($parts -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
        $key.Close()
        [Environment]::SetEnvironmentVariable('OXY_HOME', $null, 'User')`);
    },

    // ---------------------------------------------------------- Windows Terminal 프로필 (fragment)
    /** wt.exe 는 앱 실행 별칭(reparse point)이라 fs 로는 보이지 않으므로 where.exe 로 찾는다 */
    findWindowsTerminal() {
      const r = spawnSync("where.exe", ["wt"], { encoding: "utf8" });
      return r.status === 0 ? (r.stdout.split(/\r?\n/).find(Boolean) ?? null) : null;
    },
    /** Git for Windows 아이콘 (배포판에 따라 ucrt64 / mingw64 / clangarm64) */
    gitIcon(gitBash) {
      const root = dirname(dirname(gitBash));
      return ["ucrt64", "mingw64", "clangarm64", "clang64"]
        .map((d) => join(root, d, "share", "git", "git-for-windows.ico")).find((p) => existsSync(p)) ?? null;
    },
    shellArgs(installDir) {
      return `--login -i -c "source '${toPosix(installDir)}/env.sh' && cd ~ && exec bash -i"`;
    },
    /** PowerShell: pwsh.exe(PowerShell 7)가 있으면 그것, 없으면 Windows PowerShell. 둘 다 없으면 null */
    findPowerShell() {
      if (sys._pwsh !== undefined) return sys._pwsh;
      const r = spawnSync("where.exe", ["pwsh"], { encoding: "utf8" });
      const pwsh = r.status === 0 ? (r.stdout.split(/\r?\n/).find(Boolean) ?? null) : null;
      const win = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      sys._pwsh = pwsh ?? (existsSync(win) ? win : null);
      return sys._pwsh;
    },
    cmdExe() { return join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"); },
    /** 셸을 하네스 환경으로 여는 실행 파일과 인수. cmd · PowerShell 은 설치 폴더만 PATH 앞에 둔다 (oxy → oxy.cmd → Git Bash 로 env.sh) */
    launchSpec(shell, installDir, gitBash) {
      const dir = String(installDir).replace(/\//g, "\\");
      if (shell === "cmd") return { exe: sys.cmdExe(), args: `/k "set "OXY_HOME=${dir}" & set "PATH=${dir};%PATH%""` };
      if (shell === "powershell") {
        const exe = sys.findPowerShell() ?? "powershell.exe";
        // -Command 문자열은 실행 정책(ps1 차단)의 영향을 받지 않는다
        return { exe, args: `-NoLogo -NoExit -Command "$env:OXY_HOME=${psq(dir)}; $env:Path=${psq(dir + ";")}+$env:Path"` };
      }
      return { exe: gitBash, args: sys.shellArgs(installDir) };
    },
    addTerminalProfile(installDir, gitBash, shell = "git-bash") {
      const dir = join(LOCAL, "Microsoft", "Windows Terminal", "Fragments", "oxygen-pi");
      mkdirSync(dir, { recursive: true });
      // cmd · PowerShell 프로필은 아이콘을 지정하지 않는다 (Windows Terminal 기본 아이콘)
      const icon = shell === "git-bash" ? sys.gitIcon(gitBash) : null;
      const run = sys.launchSpec(shell, installDir, gitBash);
      const profile = {
        guid: WT_GUID, name: WT_PROFILE_NAME, startingDirectory: "%USERPROFILE%",
        commandline: `"${run.exe}" ${run.args}`,
        ...(icon ? { icon } : {}),
      };
      const file = join(dir, "oxygen-pi.json");
      writeFileSync(file, JSON.stringify({ profiles: [profile] }, null, 2) + "\n");
      return file;
    },
    removeTerminalProfile(file) { if (file) rmSync(dirname(file), { recursive: true, force: true }); },

    // ---------------------------------------------------------- 바탕화면 바로가기
    addShortcut(installDir, gitBash, useTerminalProfile, shell = "git-bash") {
      const wt = sys.findWindowsTerminal();
      const viaWt = useTerminalProfile && Boolean(wt);
      const run = sys.launchSpec(shell, installDir, gitBash);
      const target = viaWt ? wt : run.exe;
      const args = viaWt ? `-p "${WT_PROFILE_NAME}"` : run.args;
      const icon = (shell === "git-bash" ? sys.gitIcon(gitBash) : run.exe) ?? "";
      if (sandbox) {
        const file = join(sandbox, "Desktop", "Oxygen Pi.lnk.json");
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify({ target, args }, null, 2));
        return file;
      }
      return powershell(`
        $desk = [Environment]::GetFolderPath('Desktop')
        $file = Join-Path $desk 'Oxygen Pi.lnk'
        $s = (New-Object -ComObject WScript.Shell).CreateShortcut($file)
        $s.TargetPath = ${psq(target)}
        $s.Arguments = ${psq(args)}
        $s.WorkingDirectory = $env:USERPROFILE
        $s.Description = 'oxygen-pi-system (pi coding agent)'
        if (Test-Path ${psq(icon)}) { $s.IconLocation = ${psq(icon)} }
        $s.Save()
        Write-Output $file`);
    },
    removeShortcut(file) { if (file) rmSync(file, { force: true }); },

    // ---------------------------------------------------------- psmux 서버 (업데이트 · 제거 전)
    /**
     * 설치 폴더의 bin/psmux.exe 로 실행 중인 프로세스와 하네스 서버(-L oxy)의 세션 이름.
     * 실행 중인 psmux.exe 는 덮어쓰거나 지울 수 없다 (EBUSY). 다른 폴더의 psmux 는 보지 않는다
     */
    psmuxRunning(installDir) {
      const exe = join(installDir, "bin", "psmux.exe");
      if (!existsSync(exe)) return null;
      let pids = [];
      try {
        const out = powershell(`Get-Process psmux -ErrorAction SilentlyContinue | Where-Object { $_.Path -and ($_.Path -ieq ${psq(exe)}) } | ForEach-Object { $_.Id }`);
        pids = out.split(/\s+/).filter(Boolean).map(Number);
      } catch { return null; }
      if (!pids.length) return null;
      const r = spawnSync(exe, ["-L", "oxy", "list-sessions", "-F", "#{session_name}"], { encoding: "utf8", timeout: 5000 });
      const sessions = r.status === 0 ? r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [];
      return { pids, sessions };
    },
    /** 하네스 서버를 끝내고, 그래도 남은 이 폴더의 psmux.exe 만 종료한다 */
    stopPsmux(installDir, pids) {
      spawnSync(join(installDir, "bin", "psmux.exe"), ["-L", "oxy", "kill-server"], { timeout: 10000 });
      const left = sys.psmuxRunning(installDir);
      const kill = (left?.pids ?? []).filter((p) => pids.includes(p));
      if (kill.length) powershell(`Stop-Process -Id ${kill.join(",")} -Force -ErrorAction SilentlyContinue`);
    },

    // ---------------------------------------------------------- 설치 기록
    loadRegistry() {
      try { return JSON.parse(readFileSync(registryFile, "utf8")); } catch { return null; }
    },
    saveRegistry(data) {
      mkdirSync(dirname(registryFile), { recursive: true });
      writeFileSync(registryFile, JSON.stringify(data, null, 2) + "\n");
    },
    removeRegistry() { rmSync(dirname(registryFile), { recursive: true, force: true }); },

    /** 설치 폴더 삭제. 지금 실행 중인 node.exe 가 그 안에 있으면 종료 후 지우도록 예약한다. */
    removeInstallDir(dir) {
      if (!existsSync(join(dir, MARKER))) throw new Error(`설치 정보 파일이 없는 폴더라서 삭제하지 않았습니다: ${dir}`);
      const running = resolve(process.execPath).toLowerCase().startsWith(resolve(dir).toLowerCase() + sep);
      if (!running) { rmSync(dir, { recursive: true, force: true }); return "deleted"; }
      process.chdir(tmpdir());
      spawn("cmd.exe", ["/d", "/c", `ping -n 3 127.0.0.1 >nul & rmdir /s /q "${dir}"`],
        // windowsVerbatimArguments: 없으면 Node 가 따옴표를 \" 로 바꿔 cmd 가 경로를 해석하지 못함
        { cwd: tmpdir(), detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true }).unref();
      return "scheduled";
    },

    /** 설치된 하네스의 verify.sh 실행 (출력은 터미널로 바로) */
    runVerify(installDir, gitBash, args = []) {
      const r = spawnSync(gitBash, [`${toPosix(installDir)}/scripts/verify.sh`, ...args], { cwd: installDir, stdio: "inherit" });
      return r.status === 0;
    },
  };
  return sys;
}
