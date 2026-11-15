/**
 * 도구 호출 → "하는 일 · 대상" 한 줄 (docs/flow-view-spec.md "Current Task 하는 일 · 대상", 2026-11-15).
 * 명령 전체는 보이지 않는다. 대상은 파일 이름 · 도구 이름 · 연결 이름 같은 짧은 이름 하나만 쓰고, 비밀처럼 보이는 것은 뺀다.
 * pi 에 의존하지 않는 순수 함수. 규칙에 없는 명령은 `셸 명령 · <프로그램 이름>`.
 */
import { splitSegments, tokenize } from "../oxy-bash-guard.ts";

export interface ToolWork { work: string; target: string }

const TARGET_MAX = 40;

/** 경로의 마지막 이름 (`src/a.ts` → `a.ts`, `.` 은 빈 값) */
const base = (p: string): string => {
  const s = p.replace(/^@/, "").replace(/[\\/]+$/, "");
  const b = s.split(/[\\/]/).pop() ?? s;
  return b === "." || b === ".." || b === "~" ? "" : b;
};
const progName = (t: string): string => base(t).replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
const isFlag = (t: string): boolean => /^-/.test(t) || /^\/[a-z?]$/i.test(t);
const pathLike = (t: string): boolean => !isFlag(t) && /[\\/.]/.test(t) && !/^https?:/i.test(t);

/** 대상에 쓸 수 있는 값인지: 비밀처럼 보이는 것(key=value, 긴 토큰, 자격 증명이 든 주소)은 뺀다 */
function clean(t: string | undefined): string {
  let s = String(t ?? "").trim().replace(/^['"]|['"]$/g, "");
  if (!s || s.includes("=") || /^[A-Za-z0-9_\-+/]{32,}={0,2}$/.test(s)) return "";
  s = s.replace(/\s+/g, " ");
  return s.length > TARGET_MAX ? s.slice(0, TARGET_MAX - 1) + "…" : s;
}

/** 주소 → 호스트[:포트] (경로 · 질의 · 자격 증명은 뺀다) */
function host(t: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/?#]+)/i.exec(t);
  if (m) return m[1];
  const n = /^(localhost|[\w-]+(?:\.[\w-]+)+|\d+(?:\.\d+){3})(:\d+)?(?:[/?#]|$)/i.exec(t);
  return n ? n[1] + (n[2] ?? "") : "";
}

/** 연결 문자열 → 보여도 되는 이름: 주소면 호스트, `user/pass@db` 면 `@` 뒤, 자격 증명만 있으면 빈 값 */
function connName(t: string): string {
  if (/:\/\//.test(t)) return host(t);
  if (t.includes("@")) return t.slice(t.lastIndexOf("@") + 1);
  if (t.includes("/") && !/^[./\\]/.test(t)) return "";   // user/pass
  return t;
}

/** 인자 목록에서 값을 받는 옵션을 건너뛴 위치 인자 */
function positional(args: string[], valueFlags: RegExp = /^$/): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") { out.push(...args.slice(i + 1)); break; }
    if (isFlag(a)) { if (valueFlags.test(a) && !a.includes("=")) i++; continue; }
    out.push(a);
  }
  return out;
}
const optValue = (args: string[], names: RegExp): string => {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = /^(-[^=]+)=(.*)$/.exec(a);
    if (eq && names.test(eq[1])) return eq[2];
    if (names.test(a)) return args[i + 1] ?? "";
  }
  return "";
};
const firstPath = (args: string[]): string => base(positional(args).find(pathLike) ?? "");

/** 스크립트 · 레시피 이름 → 하는 일 */
function scriptWork(name: string): string {
  const n = name.toLowerCase();
  if (/(^|[:_-])(test|tests|spec|e2e)([:_-]|$)|^test/.test(n)) return "테스트 실행";
  if (/^(build|compile|bundle|dist|package)/.test(n)) return "빌드";
  if (/lint/.test(n)) return "린트 검사";
  if (/(format|fmt|prettier)/.test(n)) return "코드 포맷";
  if (/(typecheck|type-check|check-types|tsc)/.test(n)) return "타입 검사";
  return "스크립트 실행";
}

const GIT: Record<string, string> = {
  status: "git 상태 확인", diff: "변경 내용 확인", show: "커밋 내용 확인", log: "커밋 기록 확인", add: "스테이징", commit: "커밋",
  push: "푸시", pull: "끌어오기", fetch: "가져오기", checkout: "브랜치 전환", switch: "브랜치 전환", branch: "브랜치 확인", merge: "병합",
  rebase: "리베이스", stash: "스태시", restore: "변경 되돌리기", reset: "변경 되돌리기", clone: "저장소 복제", blame: "변경 이력 확인",
  grep: "검색", tag: "태그", "rev-parse": "git 정보 확인", remote: "원격 저장소 확인", worktree: "작업 트리",
};
const PM_INFO = /^(ls|list|view|info|show|outdated|why|explain|freeze)$/;
const PM_INSTALL = /^(install|i|ci|add|sync)$/;
const PM_REMOVE = /^(uninstall|remove|rm|un)$/;
const DB = /^(usql|psql|mysql|mariadb|sqlite3|sqlcmd|sqlplus|sql|mongosh|mongo|redis-cli|duckdb|clickhouse-client)$/;
const DB_VALUE = /^(-c|-f|-U|-u|-p|-P|-h|-H|-d|-D|-S|-W|-e|-w|-o|-v|-name|--command|--file|--user|--username|--host|--port|--dbname|--database|--output|--set|--variable)$/;
const VERSION = /^(--version|-v|-V|version)$/;
const NOISE = /^(cd|pushd|popd|export|set|unset|source|\.|alias|true|false|:|sleep|wait|pwd|clear|cls|exit|trap|shopt|setlocal|chcp|echo|printf)$/;
const PS: Record<string, string> = {
  "get-childitem": "폴더 살펴보기", gci: "폴더 살펴보기", "get-content": "파일 보기", gc: "파일 보기", "select-string": "검색", sls: "검색",
  "set-content": "파일 쓰기", "out-file": "파일 쓰기", "add-content": "파일 쓰기", "remove-item": "파일 삭제", "copy-item": "파일 복사",
  "move-item": "파일 옮기기", "new-item": "파일 만들기", "invoke-webrequest": "HTTP 요청", iwr: "HTTP 요청", "invoke-restmethod": "HTTP 요청",
  irm: "HTTP 요청", "get-process": "프로세스 확인", "stop-process": "프로세스 종료", "test-path": "파일 확인", "get-command": "도구 확인",
};

const tw = (work: string, target = ""): ToolWork => ({ work, target: clean(target) });

/** 세그먼트 하나 → 하는 일. 하는 일이 없는 것(cd · export · echo …)은 null */
function classify(tokens0: string[], depth: number): ToolWork | null {
  // 다른 파일로 내보내기(> · >>)를 떼어 둔다 (`cat > a.txt` 는 파일 쓰기)
  let out = "";
  const toks: string[] = [];
  for (let i = 0; i < tokens0.length; i++) {
    const t = tokens0[i];
    const r = /^(\d*)(>>?|<)(.*)$/.exec(t);
    if (r && !/^<</.test(t)) {
      const file = r[3] || (/^\d*>>?$|^<$/.test(t) ? tokens0[++i] ?? "" : "");
      if (r[2] !== "<" && r[1] !== "2" && file && !/^(\/dev\/null|nul|&\d)$/i.test(file)) out = file;
      continue;
    }
    if (/^<</.test(t)) { if (t === "<<" || t === "<<-") i++; continue; }   // heredoc 표시
    toks.push(t);
  }
  let t = toks;
  // 앞에 붙는 실행기 (npx vitest → vitest, python -m pytest → pytest, timeout 60 npm test → npm test)
  for (let guard = 0; guard < 6 && t.length; guard++) {
    const p = progName(t[0]);
    if (/^(npx|bunx|pnpx|winpty)$/.test(p)) t = t.slice(1).filter((x, i) => !(i === 0 && isFlag(x)));
    else if (/^(pnpm|yarn|npm|bun)$/.test(p) && /^(exec|dlx|x)$/.test(t[1] ?? "")) t = t.slice(2);
    else if (/^(uv|poetry|pipenv|pdm|rye)$/.test(p) && t[1] === "run") t = t.slice(2);
    else if (p === "timeout" && /^\d/.test(t[1] ?? "")) t = t.slice(2);
    else if (/^(python|python3|py)$/.test(p) && t[1] === "-m" && t[2]) t = t.slice(2);
    else break;
    while (t.length && isFlag(t[0])) t = t.slice(1);
  }
  if (!t.length) return null;
  const p = progName(t[0]);
  const a = t.slice(1);
  const pos = positional(a);
  if (out && /^(cat|echo|printf|tee)$/.test(p)) return tw("파일 쓰기", base(out));
  if (p === "tee" && pos[0]) return tw("파일 쓰기", base(pos[0]));
  if (NOISE.test(p)) return null;
  // 셸 안의 셸: bash -c "…" · cmd /c … · powershell -Command …
  if (/^(bash|sh|zsh|cmd|powershell|pwsh)$/.test(p) && depth < 2) {
    const i = a.findIndex((x) => /^(-[a-z]*c|\/c|-command|-c)$/i.test(x));
    if (i >= 0 && a[i + 1]) return describeCommand(a.slice(i + 1).join(" "), depth + 1);
    if (pos[0] && pathLike(pos[0])) return tw("스크립트 실행", base(pos[0]));
  }
  if (VERSION.test(a[0] ?? "") && a.length === 1) return tw("버전 확인", p);
  if (PS[p]) {
    if (PS[p] === "HTTP 요청") return tw(PS[p], pos.map(host).find(Boolean) ?? "");
    if (PS[p] === "검색") return tw(PS[p], optValue(a, /^-pattern$/i) || pos[0] || "");
    return tw(PS[p], base(optValue(a, /^-(path|literalpath)$/i) || pos[0] || ""));
  }

  if (p === "git") {
    const g = positional(a, /^(-C|-c|--git-dir|--work-tree)$/);
    const sub = g[0] ?? "";
    const rest = g.slice(1);
    const work = GIT[sub] ?? (sub ? `git ${sub}` : "git");
    if (sub === "checkout" || sub === "switch") return tw(work, rest.filter((x) => x !== "--").pop() ?? "");
    if (sub === "clone") return tw(work, base(rest[0] ?? "").replace(/\.git$/, ""));
    if (/^(add|diff|restore|blame|log|show)$/.test(sub)) return tw(work, base(rest.find(pathLike) ?? ""));
    return tw(work);
  }
  if (/^(npm|pnpm|yarn|bun)$/.test(p)) {
    const sub = pos[0] ?? "";
    if (sub === "run" || sub === "run-script") {
      const s = pos[1] ?? "";
      const w = scriptWork(s);
      return tw(w, w === "스크립트 실행" ? s : base(pos.slice(2).find(pathLike) ?? "") || `${p} ${s}`);
    }
    if (sub === "test" || sub === "t") return tw("테스트 실행", base(pos.slice(1).find(pathLike) ?? "") || p);
    if (PM_INSTALL.test(sub)) return tw("패키지 설치", pos[1] ?? p);
    if (PM_REMOVE.test(sub)) return tw("패키지 제거", pos[1] ?? p);
    if (PM_INFO.test(sub)) return tw("패키지 정보 확인", pos[1] ?? p);
    if (sub === "audit") return tw("패키지 점검", p);
    if (sub === "init" || sub === "create") return tw("프로젝트 만들기", pos[1] ?? p);
    if (sub && p !== "npm") return tw(scriptWork(sub), scriptWork(sub) === "스크립트 실행" ? sub : p);   // yarn build · pnpm lint
    return tw("셸 명령", p);
  }
  if (/^(node|deno|tsx|ts-node)$/.test(p)) {
    if (a.includes("--test")) return tw("테스트 실행", firstPath(a.filter((x) => x !== "--test")) || p);
    const f = positional(a, /^(-r|--require|--import|--loader|--env-file)$/)[0];
    if (f && !/^(-e|-p|--eval|--print)$/.test(a[0] ?? "") && pathLike(f)) return tw("스크립트 실행", base(f));
    if (p === "deno" && /^(test|lint|fmt|check)$/.test(pos[0] ?? "")) return tw(scriptWork(pos[0] === "check" ? "typecheck" : pos[0]), firstPath(a.slice(1)) || p);
    return tw("스크립트 실행", p);
  }
  if (/^(python|python3|py)$/.test(p)) {
    const f = positional(a, /^(-W|-X)$/)[0];
    if (f && f !== "-" && !/^-c$/.test(a[0] ?? "")) return tw("스크립트 실행", base(f));
    return tw("스크립트 실행", p);
  }
  if (/^(vitest|jest|mocha|pytest|ava|tap|karma|cypress)$/.test(p) || (p === "playwright" && pos[0] === "test")) {
    const files = positional(a).filter((x) => x !== "run" && x !== "test" && x !== "watch");
    return tw("테스트 실행", base(files.find(pathLike) ?? files[0] ?? "") || p);
  }
  if (p === "playwright" && pos[0] === "install") return tw("패키지 설치", "playwright");
  if (p === "cargo") {
    const sub = pos[0] ?? "";
    const pk = optValue(a, /^(-p|--package|--bin)$/) || "cargo";
    if (sub === "test" || sub === "nextest") return tw("테스트 실행", pk);
    if (sub === "build" || sub === "b") return tw("빌드", pk);
    if (sub === "check" || sub === "c") return tw("타입 검사", pk);
    if (sub === "clippy") return tw("린트 검사", pk);
    if (sub === "fmt") return tw("코드 포맷", pk);
    if (sub === "run" || sub === "r") return tw("프로그램 실행", pk);
    if (sub === "add" || sub === "install" || sub === "fetch") return tw("패키지 설치", pos[1] ?? "cargo");
    return tw(sub ? `cargo ${sub}` : "셸 명령", sub ? "" : "cargo");
  }
  if (p === "go") {
    const sub = pos[0] ?? "";
    const m: Record<string, string> = { test: "테스트 실행", build: "빌드", run: "프로그램 실행", vet: "린트 검사", fmt: "코드 포맷", get: "패키지 설치", install: "패키지 설치", mod: "의존성 정리" };
    return tw(m[sub] ?? (sub ? `go ${sub}` : "셸 명령"), "go");
  }
  if (/^(mvn|mvnw|gradle|gradlew)$/.test(p)) {
    const tool = p.startsWith("mvn") ? "maven" : "gradle";
    const goals = positional(a, /^(-pl|-f|-D|-P|-s|-p)$/).map((x) => x.toLowerCase());
    const mod = optValue(a, /^(-pl|--projects)$/);
    const target = base(mod) || tool;
    if (goals.some((g) => /(^|:)(spring-boot:run|bootrun|run|exec:java)$/.test(g))) return tw("프로그램 실행", target);
    if (goals.some((g) => /^(test|verify|integration-test|check)$|test$/.test(g))) return tw("테스트 실행", target);
    if (goals.some((g) => /^(package|install|compile|build|assemble|jar|war|deploy)$/.test(g))) return tw("빌드", target);
    if (goals.some((g) => g.startsWith("dependency"))) return tw("의존성 확인", target);
    if (goals.length && goals.every((g) => g === "clean")) return tw("빌드 정리", target);
    return tw("빌드", target);
  }
  if (p === "dotnet") {
    const m: Record<string, string> = { test: "테스트 실행", build: "빌드", run: "프로그램 실행", restore: "패키지 설치", format: "코드 포맷", publish: "빌드" };
    return tw(m[pos[0] ?? ""] ?? "셸 명령", "dotnet");
  }
  if (/^(make|just|task|invoke|rake)$/.test(p)) {
    const r = positional(a, /^(-f|-C|--justfile|--working-directory)$/)[0] ?? "";
    const w = r ? scriptWork(r) : "스크립트 실행";
    return tw(w, r || p);
  }
  if (p === "tsc" || p === "vue-tsc") return tw(a.includes("--noEmit") ? "타입 검사" : "빌드", p);
  if (/^(mypy|pyright)$/.test(p)) return tw("타입 검사", firstPath(a) || p);
  if (/^(eslint|flake8|pylint|shellcheck|markdownlint|stylelint|golangci-lint|ktlint|checkstyle)$/.test(p) || (p === "ruff" && pos[0] !== "format") || (p === "biome" && pos[0] === "lint"))
    return tw("린트 검사", firstPath(a) || p);
  if (/^(prettier|black|rustfmt|gofmt|isort)$/.test(p) || (p === "ruff" && pos[0] === "format") || (p === "biome" && pos[0] === "format"))
    return tw("코드 포맷", firstPath(a) || p);
  if (/^(pip|pip3)$/.test(p) || (p === "uv" && pos[0] === "pip")) {
    const q = p === "uv" ? pos.slice(1) : pos;
    if (PM_INSTALL.test(q[0] ?? "")) return tw("패키지 설치", q[1] ?? p);
    if (PM_REMOVE.test(q[0] ?? "")) return tw("패키지 제거", q[1] ?? p);
    return tw("패키지 정보 확인", p);
  }
  if (/^(uv|poetry|pipenv|pdm|conda|apt|apt-get|brew|choco|winget|scoop|gem|composer)$/.test(p)) {
    if (PM_INSTALL.test(pos[0] ?? "") || pos[0] === "lock") return tw("패키지 설치", pos[1] ?? p);
    if (PM_REMOVE.test(pos[0] ?? "")) return tw("패키지 제거", pos[1] ?? p);
    return tw("패키지 정보 확인", p);
  }
  if (p === "hurl") return tw("HTTP 요청", base(positional(a, /^(--variable|--variables-file|-o|--output|-H|--header|-u|--user)$/).find(pathLike) ?? "") || "hurl");
  if (/^(curl|wget|http|https|xh)$/.test(p)) {
    const args = positional(a, /^(-H|--header|-d|--data|--data-raw|--data-binary|-u|--user|-o|--output|-X|--request|-F|--form|-A|--user-agent|-e|-b|--cookie|-c|-w|--write-out|-m|--max-time|--connect-timeout|-T|--upload-file)$/);
    return tw("HTTP 요청", args.map(host).find(Boolean) ?? p);
  }
  if (DB.test(p)) {
    const named = p === "sql" ? optValue(a, /^-name$/) : "";
    const first = positional(a, DB_VALUE).filter((x) => !/^@/.test(x) && !/^\/nolog$/i.test(x))[0] ?? "";
    const db = named || connName(first) || connName(optValue(a, /^(-d|--dbname|--database|-D|-S)$/)) || host(optValue(a, /^(-h|--host|-H)$/)) || "";
    return tw("DB 질의", p === "sqlite3" || p === "duckdb" ? base(db) : db);
  }
  if (/^(docker|podman)$/.test(p)) {
    const sub = pos[0] === "compose" ? pos[1] ?? "" : pos[0] ?? "";
    if (sub === "build") return tw("이미지 빌드", base(optValue(a, /^(-t|--tag)$/)));
    if (/^(run|up|start)$/.test(sub)) return tw("컨테이너 실행");
    if (/^(ps|logs|inspect|images|top|stats)$/.test(sub)) return tw("컨테이너 확인");
    if (sub === "exec") return tw("컨테이너 명령");
    if (/^(stop|rm|down|kill)$/.test(sub)) return tw("컨테이너 중지");
    return tw(sub ? `${p} ${sub}` : "셸 명령", sub ? "" : p);
  }
  if (/^(ls|dir|tree|du|exa|eza)$/.test(p)) return tw("폴더 살펴보기", base(positional(a)[0] ?? ""));
  if (/^(find|fd|fdfind|locate)$/.test(p)) return tw("파일 찾기", base(positional(a, /^(-name|-iname|-path|-type|-maxdepth|-mindepth|-e|--extension|-t|--type|-d|--max-depth)$/)[0] ?? "") || optValue(a, /^(-name|-iname)$/));
  if (/^(grep|rg|ag|ack|findstr|ast-grep|sg)$/.test(p)) {
    const pat = optValue(a, /^(-e|--regexp|-p|--pattern)$/) || positional(a, /^(-m|--max-count|-A|-B|-C|--context|-g|--glob|-t|--type|--include|--exclude|-f|-l|--lang)$/)[0];
    return tw("검색", pat ?? "");
  }
  if (/^(sed|awk|gawk|perl)$/.test(p)) {
    const files = positional(a, /^(-e|-f|-F|-v)$/).slice(a.some((x) => /^-(e|f)$/.test(x)) ? 0 : 1);
    const inPlace = a.some((x) => /^-i|^--in-place/.test(x) || /^-[a-z]*i$/.test(x) && p !== "awk");
    return tw(inPlace ? "파일 고치기" : "파일 보기", base(files.find(pathLike) ?? files[0] ?? ""));
  }
  if (/^(cat|head|tail|less|more|bat|wc|nl|xxd|od|file|stat|type|hexdump|strings|jq|yq)$/.test(p)) {
    const files = p === "jq" || p === "yq" ? positional(a, /^(--arg|--argjson)$/).slice(1) : positional(a, /^(-n|-c|--lines|--bytes)$/);
    return tw("파일 보기", base(files.filter(pathLike).pop() ?? files.pop() ?? ""));
  }
  if (/^(diff|cmp|comm|fc)$/.test(p)) return tw("파일 비교", firstPath(a));
  const FILE_OPS: Record<string, string> = { mkdir: "폴더 만들기", md: "폴더 만들기", cp: "파일 복사", copy: "파일 복사", rsync: "파일 복사", xcopy: "파일 복사", robocopy: "파일 복사",
    mv: "파일 옮기기", move: "파일 옮기기", ren: "파일 옮기기", rm: "파일 삭제", del: "파일 삭제", rmdir: "파일 삭제", rd: "파일 삭제", touch: "파일 만들기",
    chmod: "권한 바꾸기", chown: "권한 바꾸기", icacls: "권한 바꾸기", ln: "링크 만들기" };
  if (FILE_OPS[p]) { const ps = positional(a).filter(pathLike); return tw(FILE_OPS[p], base(ps.pop() ?? positional(a).pop() ?? "")); }
  if (/^(tar|zip|unzip|7z|gzip|gunzip|bsdtar)$/.test(p)) {
    const ex = p === "unzip" || p === "gunzip" || (p === "7z" && pos[0] === "x") || (/tar$/.test(p) && a.some((x) => /^-?[a-z]*x/.test(x)));
    return tw(ex ? "압축 풀기" : "압축하기", firstPath(a));
  }
  if (/^(ps|tasklist|top|htop|pgrep)$/.test(p)) return tw("프로세스 확인");
  if (/^(kill|pkill|taskkill|killall)$/.test(p)) return tw("프로세스 종료");
  if (/^(netstat|ss|lsof)$/.test(p)) return tw("포트 확인");
  if (/^(ping|nslookup|dig|traceroute|tracert)$/.test(p)) return tw("네트워크 확인", host(pos[0] ?? "") || pos[0] || "");
  if (/^(which|whereis|where)$/.test(p) || (p === "command" && a[0] === "-v")) return tw("도구 확인", pos[pos.length - 1] ?? "");
  if (/^(env|printenv)$/.test(p)) return tw("환경 확인");
  if (/^(psmux|pmux|tmux)$/.test(p)) return tw("터미널 세션 작업");
  if (/^(gh|glab)$/.test(p)) {
    const sub = pos[0] ?? "";
    const m: Record<string, string> = { pr: "PR 작업", mr: "MR 작업", issue: "이슈 작업", run: "CI 확인", ci: "CI 확인", api: "API 요청", release: "릴리스 작업", repo: "저장소 작업" };
    return tw(m[sub] ?? (sub ? `${p} ${sub}` : "셸 명령"), p);
  }
  if (/^(java|javac|kotlin|kotlinc)$/.test(p)) {
    if (p.endsWith("c")) return tw("빌드", firstPath(a) || p);
    const jar = optValue(a, /^-jar$/);
    return tw("프로그램 실행", base(jar) || positional(a, /^(-cp|-classpath|--class-path|-jar)$/)[0] || p);
  }
  if (pathLike(t[0])) return tw("프로그램 실행", base(t[0]));
  return tw("셸 명령", p);
}

/** 셸 명령 → 하는 일. 첫 번째로 하는 일이 있는 세그먼트를 쓴다 (`cd x && npm test 2>&1 | tail` → npm test) */
export function describeCommand(command: string, depth = 0): ToolWork {
  const segs = splitSegments(String(command ?? ""));
  let first: ToolWork | null = null;
  for (const s of segs) {
    const w = classify(tokenize(s), depth);
    if (w) return w;
    if (!first) { const t = tokenize(s); const p = t[0] ? progName(t[0]) : ""; if (p) first = tw("셸 명령", p); }
  }
  return first ?? tw("셸 명령");
}

/** 도구 호출 → 하는 일 · 대상. input 이 없으면 도구 종류만 (`bash` → `셸 명령`) */
export function describeTool(name: string, input: unknown): ToolWork {
  const a: any = input && typeof input === "object" ? input : {};
  const path = String(a.path ?? a.file_path ?? "");
  switch (name) {
    case "bash": return a.command ? describeCommand(String(a.command)) : tw("셸 명령");
    case "powershell": return a.command ? describeCommand(String(a.command)) : tw("PowerShell 명령");
    case "read": return tw("파일 읽기", base(path));
    case "write": return tw("파일 쓰기", base(path));
    case "edit": return tw("파일 고치기", base(path));
    case "grep": return tw("검색", String(a.pattern ?? ""));
    case "find": return tw("파일 찾기", String(a.pattern ?? ""));
    case "ls": return tw("폴더 살펴보기", base(path));
    case "flow_plan": case "flow_note": return tw("작업 기록");
    case "flow_show": return tw("작업 기록 보기");
    case "background": return tw("백그라운드 작업 시작");
    case "subagent": return tw("subagent 맡기기");
    default: return tw(name);
  }
}
