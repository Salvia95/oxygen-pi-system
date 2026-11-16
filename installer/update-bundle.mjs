// 설치 폴더에서 업데이트 · 패치 노트 (docs/tui-spec.md §13). 화면 없이 쓰는 함수만 둔다 (화면은 install.mjs).
//   새 번들 위치(폴더 또는 zip) 판정 → zip 무결성 확인 · 압축 풀기 → 넘김 스크립트 → 새 번들의 install.cmd --update
//   설치 폴더의 node.exe · oxy-tui.exe 는 설치 화면이 실행되는 동안 잠겨 있어, 지금 프로세스를 끝낸 뒤 새 번들로 넘긴다.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { sha256File } from "./components.mjs";

export const PATCH_NOTES = "PATCH_NOTES.md";
/** %TEMP% 아래 압축 풀기 폴더와 넘김 스크립트의 이름 앞부분 (D3 정리 대상) */
export const UPDATE_PREFIX = "oxygen-pi-update-";
const BUNDLE_FILES = ["install.cmd", "VERSION", join("installer", "install.mjs")];
const ZIP_NAME = /^oxygen-pi-\d{8}\.zip$/i;
const DAY_MS = 24 * 60 * 60 * 1000;

const same = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase();

/** 새 번들 폴더로 쓸 수 없으면 그 이유, 쓸 수 있으면 null */
export function bundleProblem(dir, installDir) {
  if (!dir || !existsSync(dir)) return "폴더를 찾을 수 없습니다";
  if (!statSync(dir).isDirectory()) return "폴더가 아닙니다";
  if (installDir && same(dir, installDir)) return "설치 폴더 자신은 새 번들로 쓸 수 없습니다";
  const missing = BUNDLE_FILES.find((f) => !existsSync(join(dir, f)));
  return missing ? `번들 폴더가 아닙니다: ${missing.replace(/\\/g, "/")} 가 없습니다` : null;
}

/** 입력한 위치의 종류: zip | dir | null(없음) */
export function bundleKind(path) {
  if (!path || !existsSync(path)) return null;
  if (statSync(path).isDirectory()) return "dir";
  return /\.zip$/i.test(path) ? "zip" : null;
}

/** 입력 화면의 처음 값: Downloads 의 oxygen-pi-YYYYMMDD.zip 가운데 가장 최근 것 */
export function latestBundleZip(downloadsDir) {
  if (!downloadsDir || !existsSync(downloadsDir)) return null;
  const zips = readdirSync(downloadsDir, { withFileTypes: true })
    .filter((e) => e.isFile() && ZIP_NAME.test(e.name))
    .map((e) => join(downloadsDir, e.name));
  if (!zips.length) return null;
  return zips.map((p) => ({ p, t: statSync(p).mtimeMs })).sort((a, b) => b.t - a.t || (a.p < b.p ? 1 : -1))[0].p;
}

/**
 * zip 옆의 <zip>.sha256 과 비교한다 (package-bundle.sh 가 sha256sum 형식으로 만든다).
 * {status: "ok" | "mismatch" | "missing", expected, actual}
 */
export async function checkZipSha(zip) {
  const shaFile = `${zip}.sha256`;
  if (!existsSync(shaFile)) return { status: "missing", expected: null, actual: null };
  const expected = (readFileSync(shaFile, "utf8").trim().split(/\s+/)[0] ?? "").toLowerCase();
  const actual = await sha256File(zip);
  return { status: expected === actual ? "ok" : "mismatch", expected, actual };
}

/**
 * zip 을 tmpRoot\oxygen-pi-update-<stamp>\ 에 풀고, 그 안의 번들 폴더(최상위 폴더 하나)를 돌려준다.
 * Windows 내장 bsdtar 로 푼다 (Git Bash 의 GNU tar 는 zip 을 풀지 못한다).
 * 비동기로 실행해 압축을 푸는 동안에도 설치 화면이 Ctrl+C 와 진행 표시에 반응한다.
 */
export async function extractBundle(zip, tmpRoot, stamp = Date.now()) {
  const dest = join(tmpRoot, `${UPDATE_PREFIX}${stamp}`);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  const { code, stderr } = await new Promise((ok) => {
    let err = "";
    const p = spawn(tar, ["-xf", resolve(zip), "-C", dest], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    p.stderr.on("data", (d) => { err += d; });
    p.on("error", (e) => ok({ code: -1, stderr: e.message }));
    p.on("close", (c) => ok({ code: c, stderr: err }));
  });
  if (code !== 0) throw new Error(`압축을 풀지 못했습니다: ${String(stderr).trim().split("\n")[0]}`);
  const tops = readdirSync(dest, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(dest, e.name));
  const bundle = tops.find((d) => !bundleProblem(d)) ?? (!bundleProblem(dest) ? dest : null);
  if (!bundle) throw new Error("압축 파일 안에 번들 폴더가 없습니다. oxygen-pi 번들 zip인지 확인하세요");
  return bundle;
}

/** 버전 비교 (0.10.0 > 0.9.1). 숫자가 아닌 조각은 0 으로 본다. a<b 면 음수 */
export function compareVersions(a, b) {
  const pa = String(a ?? "").replace(/^v/i, "").split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = String(b ?? "").replace(/^v/i, "").split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** D2: 확인 팝업 요약에 붙일 말. 새 버전이 높으면 null */
export function versionNote(current, next) {
  const d = compareVersions(next, current);
  return d > 0 ? null : d === 0 ? "같은 버전으로 다시 설치합니다" : "이전 버전으로 되돌립니다";
}

/** PATCH_NOTES.md 첫 줄 `# v<버전> (<날짜>)` 의 버전 (없으면 null) */
export function patchNoteVersion(text) {
  const m = /^#\s+v?(\d+(?:\.\d+)*(?:-[\w.]+)?)\b/m.exec(String(text ?? "").split(/\r?\n/).find((l) => l.trim()) ?? "");
  return m ? m[1] : null;
}

/** 번들의 패치 노트: {version, title, lines(마크다운 기호를 뺀 글), items(목록 수)} · 없으면 null */
export function readPatchNotes(dir) {
  const f = join(dir, PATCH_NOTES);
  if (!existsSync(f)) return null;
  const text = readFileSync(f, "utf8");
  const version = patchNoteVersion(text);
  const raw = text.split(/\r?\n/);
  const first = raw.findIndex((l) => l.trim());
  const lines = [];
  let items = 0;
  for (const l of raw.slice(first + 1)) {
    const h = /^#{2,6}\s+(.*)$/.exec(l);
    const li = /^\s*[-*]\s+(.*)$/.exec(l);
    if (h) lines.push(h[1].trim());
    else if (li) { lines.push(`  ${li[1].replace(/`/g, "").trim()}`); items++; }
    else lines.push(l.replace(/`/g, "").trimEnd());
  }
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  return { version, title: version ? `v${version} 패치 노트` : "패치 노트", lines, items };
}

/** 번들 검사 (package-bundle.sh): PATCH_NOTES.md 가 있고 첫 줄 버전이 VERSION 과 같으면 null, 아니면 이유 */
export function patchNotesProblem(root) {
  const f = join(root, PATCH_NOTES);
  if (!existsSync(f)) return `${PATCH_NOTES} 가 없습니다`;
  const version = readFileSync(join(root, "VERSION"), "utf8").trim();
  const noted = patchNoteVersion(readFileSync(f, "utf8"));
  if (!noted) return `${PATCH_NOTES} 첫 줄이 '# v<버전> (<날짜>)' 형식이 아닙니다`;
  return noted === version ? null : `${PATCH_NOTES} 의 버전(v${noted})이 VERSION(${version})과 다릅니다`;
}

/**
 * 넘김 스크립트를 쓴다. install.cmd · install.sh 가 설치 화면이 끝난 뒤 이 파일로 제어를 넘긴다 (돌아오지 않는다).
 * path 는 런처가 OXY_UPDATE_HANDOFF 로 정해 준 경로. 확장자로 cmd / sh 를 고른다.
 */
export function writeHandoff(path, bundleDir) {
  mkdirSync(dirname(path), { recursive: true });
  if (/\.sh$/i.test(path)) {
    const posix = bundleDir.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_m, d) => `/${d.toLowerCase()}`);
    writeFileSync(path, `#!/usr/bin/env bash\n# oxygen-pi 업데이트 넘김 (docs/tui-spec.md §13)\ncd '${posix.replace(/'/g, "'\\''")}' && exec ./install.sh --update\n`);
  } else {
    writeFileSync(path, `@echo off\r\nrem oxygen-pi update handoff (docs/tui-spec.md section 13)\r\ncd /d "${bundleDir}"\r\n"${join(bundleDir, "install.cmd")}" --update\r\n`);
  }
  return path;
}

/** D3: tmpRoot 의 하루 넘은 oxygen-pi-update-* (폴더 · 넘김 스크립트)를 지운다. 지운 수 */
export function cleanupOldUpdates(tmpRoot, now = Date.now(), maxAgeMs = DAY_MS) {
  if (!tmpRoot || !existsSync(tmpRoot)) return 0;
  let n = 0;
  for (const e of readdirSync(tmpRoot, { withFileTypes: true })) {
    if (!e.name.startsWith(UPDATE_PREFIX)) continue;
    const p = join(tmpRoot, e.name);
    try {
      if (now - statSync(p).mtimeMs < maxAgeMs) continue;
      rmSync(p, { recursive: true, force: true });
      n++;
    } catch { /* 쓰는 중이거나 권한이 없으면 다음에 */ }
  }
  return n;
}
