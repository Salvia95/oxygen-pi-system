// 그림자 저장소 (docs/flow-rollback-spec.md §4 · §5): 작업 폴더 하나의 스냅숏을 사용자 git 과 따로 남기고, Task 단위로 되돌린다.
//   <프로젝트>/.oxy/flow/shadow/<폴더 이름>-<해시>/   GIT_DIR. 작업 트리는 그 작업 폴더
//   스냅숏은 부모 없는 커밋이고 refs/oxy/<flow id>/<순번> 이 잡는다 → Flow 를 정리하면 ref 를 지우고 gc 로 지운다 (D10)
// 사용자의 .git · 브랜치 · 기록은 건드리지 않는다. 사용자 git 설정(autocrlf 등)도 이 저장소에는 쓰지 않는다.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

/** 넣지 않는 것 (D7). 작업 폴더의 .gitignore 도 따른다 (git 이 작업 트리의 .gitignore 를 읽는다) */
export const DEFAULT_EXCLUDES = [".git/", ".oxy/", "node_modules/", "target/", "build/", "dist/", ".venv/", "*.log"];
/** 이보다 큰 파일은 넣지 않는다 (D7: 테스트용 SQLite 는 5MB 를 넘지 않는다는 사용자 판단) */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export type SnapKind = "base" | "task" | "end" | "pre" | "rollback" | "undo";
export interface Snapshot { sha: string; tree: string; skipped: string[] }
export interface Preview { clean: boolean; tree: string | null; conflicts: string[]; files: string[]; error?: string }

const norm = (p: string) => {
  const s = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? s.toLowerCase() : s;
};

/** 작업 폴더 → 그림자 저장소 폴더 이름 (D11: 작업 폴더마다 하나) */
export function shadowId(workRoot: string): string {
  const name = basename(workRoot).replace(/[^\w.-]/g, "_").slice(0, 40) || "root";
  return `${name}-${createHash("sha1").update(norm(workRoot)).digest("hex").slice(0, 8)}`;
}

export class ShadowRepo {
  readonly gitDir: string;
  readonly workRoot: string;
  private readonly maxBytes: number;
  constructor(flowDir: string, workRoot: string, maxBytes = MAX_FILE_BYTES) {
    this.workRoot = workRoot;
    this.maxBytes = maxBytes;
    this.gitDir = join(flowDir, "shadow", shadowId(workRoot));
  }

  private env() {
    return { ...process.env, GIT_DIR: this.gitDir, GIT_WORK_TREE: this.workRoot,
      GIT_AUTHOR_NAME: "oxy-flow", GIT_AUTHOR_EMAIL: "oxy-flow@localhost", GIT_COMMITTER_NAME: "oxy-flow", GIT_COMMITTER_EMAIL: "oxy-flow@localhost",
      GIT_TERMINAL_PROMPT: "0" };
  }

  /** git 실행 (실패하면 예외) */
  private run(args: string[]): string {
    return execFileSync("git", ["-c", "core.autocrlf=false", "-c", "core.safecrlf=false", "-c", "core.quotepath=false", "-c", "core.longpaths=true", ...args],
      { cwd: this.workRoot, env: this.env(), encoding: "utf8", maxBuffer: 256 * 1024 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).replace(/\n$/, "");
  }

  /** git 실행 (종료 코드와 출력) */
  private exec(args: string[]): { code: number; out: string; err: string } {
    const r = spawnSync("git", ["-c", "core.autocrlf=false", "-c", "core.quotepath=false", "-c", "core.longpaths=true", ...args],
      { cwd: this.workRoot, env: this.env(), encoding: "utf8", maxBuffer: 256 * 1024 * 1024, windowsHide: true });
    return { code: r.status ?? 1, out: (r.stdout ?? "").replace(/\n$/, ""), err: r.stderr ?? "" };
  }

  exists(): boolean { return existsSync(join(this.gitDir, "HEAD")); }

  ensure(): void {
    if (this.exists()) return;
    mkdirSync(this.gitDir, { recursive: true });
    this.run(["init", "-q"]);
    for (const [k, v] of [["gc.auto", "0"], ["core.autocrlf", "false"], ["core.quotepath", "false"], ["core.longpaths", "true"]]) this.run(["config", k, v]);
    mkdirSync(join(this.gitDir, "info"), { recursive: true });
    writeFileSync(join(this.gitDir, "info", "exclude"), `# oxy-flow 그림자 저장소 (docs/flow-rollback-spec.md D7)\n${DEFAULT_EXCLUDES.join("\n")}\n`);
  }

  /** 크기 상한을 넘는 파일을 넣지 않게 exclude 에 더한다. 바뀐 · 새 파일만 본다 → 넣지 않은 파일 목록 */
  private excludeOversize(): string[] {
    const r = this.exec(["ls-files", "-z", "-o", "-m", "--exclude-standard"]);
    if (r.code !== 0) return [];
    const big: string[] = [];
    for (const rel of r.out.split("\0").filter(Boolean)) {
      try { if (statSync(join(this.workRoot, rel)).size > this.maxBytes) big.push(rel); } catch { /* 지워진 파일 */ }
    }
    if (!big.length) return [];
    const file = join(this.gitDir, "info", "exclude");
    const cur = readFileSync(file, "utf8");
    const add = big.map((b) => `/${b.replace(/([*?[\]!#])/g, "\\$1")}`).filter((l) => !cur.split("\n").includes(l));
    if (add.length) writeFileSync(file, `${cur.replace(/\n?$/, "\n")}${add.join("\n")}\n`);
    // 전에 넣었던 파일이 커졌으면 스냅숏에서 뺀다 (그 Task 는 불완전)
    this.exec(["rm", "-q", "--cached", "--ignore-unmatch", "--", ...big]);
    return big;
  }

  /** 지금 작업 폴더를 스냅숏으로 남긴다 */
  snapshot(flow: string, kind: SnapKind, title: string): Snapshot {
    this.ensure();
    const skipped = this.excludeOversize();
    this.run(["add", "-A", "--", "."]);
    const tree = this.run(["write-tree"]);
    const sha = this.run(["commit-tree", tree, "-m", `${kind}: ${title}`.slice(0, 500), "-m", `Oxy-Flow: ${flow}\nOxy-Kind: ${kind}`]);
    const seq = `${Date.now().toString(36)}-${kind}`;
    this.run(["update-ref", `refs/oxy/${flow}/${seq}`, sha]);
    return { sha, tree, skipped };
  }

  treeOf(commit: string): string { return this.run(["rev-parse", `${commit}^{tree}`]); }

  /** 두 스냅숏 사이에 바뀐 파일 */
  changed(a: string, b: string): string[] {
    const r = this.exec(["diff", "--name-only", "-z", a, b]);
    return r.code === 0 ? r.out.split("\0").filter(Boolean) : [];
  }

  /**
   * base → theirs 로 가는 변경을 ours 위에 얹는 결과를 미리 본다 (작업 폴더를 건드리지 않음, git merge-tree).
   * 되돌리기: base = Flow 끝(또는 지금), ours = 지금, theirs = 되돌릴 Task 의 스냅숏. 충돌이 있으면 clean=false (D4 의 X)
   */
  preview(base: string, ours: string, theirs: string): Preview {
    const r = this.exec(["merge-tree", "--write-tree", "--name-only", "--no-messages", `--merge-base=${base}`, ours, theirs]);
    if (r.code !== 0 && r.code !== 1) return { clean: false, tree: null, conflicts: [], files: [], error: r.err.trim().split("\n")[0] || `merge-tree exit ${r.code}` };
    const lines = r.out.split("\n").filter(Boolean);
    const tree = lines[0] ?? null;
    const conflicts = r.code === 1 ? lines.slice(1) : [];
    const files = r.code === 0 && tree ? this.changed(this.treeOf(ours), tree) : [];
    return { clean: r.code === 0, tree, conflicts, files };
  }

  /**
   * 작업 폴더를 tree 의 상태로 맞추고 그 상태를 스냅숏으로 남긴다. index 는 from 스냅숏(방금 남긴 것)과 같아야 한다.
   * 바뀐 파일만 쓰고, 넣지 않는 파일(exclude · 큰 파일)은 건드리지 않는다
   */
  apply(fromCommit: string, tree: string, flow: string, kind: SnapKind, title: string): Snapshot {
    this.run(["read-tree", "-m", "-u", this.treeOf(fromCommit), tree]);
    const sha = this.run(["commit-tree", tree, "-m", `${kind}: ${title}`.slice(0, 500), "-m", `Oxy-Flow: ${flow}\nOxy-Kind: ${kind}`]);
    this.run(["update-ref", `refs/oxy/${flow}/${Date.now().toString(36)}-${kind}`, sha]);
    return { sha, tree, skipped: [] };
  }

  /** 보관하지 않는 Flow 의 스냅숏을 지운다 (D10). keep 에 없는 Flow 의 ref 를 지우고 gc */
  prune(keep: Set<string>): number {
    return this.exists() ? pruneGitDir(this.gitDir, keep) : 0;
  }
}

function pruneGitDir(gitDir: string, keep: Set<string>): number {
  const g = (args: string[]) => spawnSync("git", [`--git-dir=${gitDir}`, ...args], { encoding: "utf8", windowsHide: true });
  const r = g(["for-each-ref", "--format=%(refname)", "refs/oxy/"]);
  if (r.status !== 0) return 0;
  const drop = (r.stdout ?? "").split("\n").filter(Boolean).filter((ref) => !keep.has(ref.split("/")[2] ?? ""));
  for (const ref of drop) g(["update-ref", "-d", ref]);
  if (drop.length) g(["gc", "--prune=now", "-q"]);
  return drop.length;
}

/** 모든 작업 폴더의 그림자 저장소에서 keep 에 없는 Flow 의 스냅숏을 지운다 */
export function pruneShadows(flowDir: string, keep: Set<string>): number {
  let n = 0;
  let dirs: string[] = [];
  try { dirs = readdirSync(join(flowDir, "shadow")); } catch { return 0; }
  for (const d of dirs) {
    const gitDir = join(flowDir, "shadow", d);
    if (existsSync(join(gitDir, "HEAD"))) n += pruneGitDir(gitDir, keep);
  }
  return n;
}
