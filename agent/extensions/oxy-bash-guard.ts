/**
 * oxy-bash-guard: pi 에는 권한 시스템이 없으므로 bash 명령을 실행 전에 검사한다.
 *
 * - 체인 명령(; && || | 줄바꿈 $(..))을 세그먼트로 나눠 각각 검사한다.
 * - deny: 무조건 차단 (시스템 파괴, 폐쇄망에서 불가능한 패키지 설치)
 * - ask : TUI 에서는 사용자 확인, 확인 UI 가 없는 모드(-p, json)에서는 차단
 * - 끄기: OXY_BASH_GUARD=off
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { blocked, enabled } from "./_lib/common.ts";

type Level = "deny" | "ask";
interface Rule {
  id: string;
  level: Level;
  /** 세그먼트(앞의 env 할당, sudo 등 제거 후)에 적용 */
  test: RegExp;
  title: string;
  /** 모델에게 줄 대안 안내 (영문, 짧게) */
  hint: string;
}

const RULES: Rule[] = [
  // ---- deny ----
  {
    id: "rm-root",
    level: "deny",
    test: /^rm(?=.*\s(?:-[a-z]*r|--recursive))(?=.*\s(?:-[a-z]*f|--force)).*\s(?:\/|\/\*|~\/?|~\/\*|\$HOME\/?|\/[a-z]\/?|[a-z]:[\\/]?|\.\.?\/?|\*)\s*$/i,
    title: "루트/홈/드라이브/현재 디렉터리 전체 삭제",
    hint: "Recursive force-delete of a root, home, drive or whole working directory is never allowed. Delete specific paths only.",
  },
  {
    id: "disk",
    level: "deny",
    test: /^(?:(?:mkfs\S*|format(?:\.com)?|diskpart|fdisk|Format-Volume|Clear-Disk)\b|dd\s.*\bof=)/i,
    title: "디스크 포맷/덮어쓰기",
    hint: "Disk formatting or raw disk writes are never allowed.",
  },
  {
    id: "power",
    level: "deny",
    test: /^(?:shutdown|reboot|halt|poweroff|Stop-Computer|Restart-Computer)\b/i,
    title: "시스템 종료/재시작",
    hint: "Shutting down or rebooting the machine is never allowed.",
  },
  {
    id: "offline-install",
    level: "deny",
    test: /^(?:(?:npm|pnpm|yarn|bun)\s+(?:install|i|add|ci|update|upgrade|up)\b|(?:pip3?|python[0-9.]*\s+-m\s+pip)\s+install\b|uv\s+(?:add|sync|pip\s+install)\b|poetry\s+(?:add|install|update)\b|cargo\s+(?:install|add|update)\b|go\s+(?:get|install|mod\s+download)\b|choco\s+install\b|winget\s+install\b|scoop\s+install\b)/i,
    title: "패키지 설치 (폐쇄망)",
    hint: "This machine has NO internet access, so package installation cannot work. Do not retry. Tell the user exactly which dependency is missing.",
  },
  // ---- ask ----
  {
    id: "rm-recursive",
    level: "ask",
    test: /^(?:rm\s+(?:.*\s)?(?:-[a-z]*r[a-z]*|--recursive)\b|rmdir\s+\/s\b|rd\s+\/s\b|del\s+(?:.*\s)?\/s\b|Remove-Item\b.*-Recurse)/i,
    title: "재귀 삭제",
    hint: "The user did not approve this recursive delete. Do not retry; ask the user.",
  },
  {
    id: "git-history",
    level: "ask",
    test: /^git\s+(?:push\b(?!.*\s(?:--help|-h|--dry-run|-n)(?:\s|$))|reset\s+--hard\b|clean\s+-[a-z]*f|checkout\s+(?:--\s+)?\.\s*$|restore\s+(?:--\S+\s+)*\.\s*$|branch\s+-D\b|rebase\b|filter-branch\b|stash\s+(?:drop|clear)\b|tag\s+-d\b)/i,
    title: "git 원격 반영 / 작업 내용 폐기",
    hint: "The user did not approve this git operation. Do not retry; ask the user.",
  },
  {
    id: "glab-write",
    level: "ask",
    test: /^glab\s+(?:mr\s+(?:merge|close|delete|approve|create|update|rebase)|issue\s+(?:create|close|delete|update)|release\s+(?:create|delete)|repo\s+(?:delete|archive|transfer)|variable\s+(?:set|delete|update)|ci\s+(?:run|retry|delete|cancel)|api\s+.*(?:-X|--method)\s*(?:POST|PUT|PATCH|DELETE))\b/i,
    title: "GitLab 쓰기 작업",
    hint: "The user did not approve this GitLab write operation. Do not retry; ask the user.",
  },
];

/** SQL 변경문 (sql 호출이 있는 명령 전체 + 참조한 @script.sql 내용에 적용) */
const SQL_WRITE = /\b(?:insert\s+into|update\s+\w[\w."$#]*\s+set|delete\s+from|merge\s+into|drop\s+(?:table|view|index|sequence|procedure|function|package|trigger|user|synonym)|truncate\s+table|alter\s+(?:table|index|user|session\s+set\s+current_schema)|create\s+(?:or\s+replace\s+)?(?:table|view|index|sequence|procedure|function|package|trigger|user|synonym)|grant\s|revoke\s|commit\b|execute\s+immediate|exec\s+\w|begin\b[\s\S]*\bend\s*;)/i;

/** 따옴표를 고려해 ; && || | & 줄바꿈 $( ` 로 명령을 세그먼트로 나눈다. */
export function splitSegments(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    const two = command.slice(i, i + 2);
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"') { cur += c + (command[i + 1] ?? ""); i++; continue; }
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    if (c === "\\") { cur += c + (command[i + 1] ?? ""); i++; continue; }
    if (two === "&&" || two === "||" || two === "$(") { out.push(cur); cur = ""; i++; continue; }
    if (c === ";" || c === "|" || c === "&" || c === "\n" || c === "`" || c === "(" || c === ")") { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map(normalizeSegment).filter((s) => s.length > 0);
}

/** 세그먼트 앞의 `VAR=x`, sudo, command, exec, time, nohup, xargs [-opts], env 를 제거한다. */
function normalizeSegment(seg: string): string {
  let s = seg.trim().replace(/^[{!]\s*/, "");
  for (;;) {
    const next = s
      .replace(/^[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S*)\s+/, "")
      .replace(/^(?:sudo|command|builtin|exec|time|nohup|env|nice)\s+(?:-\S+\s+)*/, "")
      .replace(/^xargs\s+(?:-\S+\s+)*/, "")
      .replace(/^(?:\S*[\\/])?(rm|git|glab|sql|npm|pnpm|yarn|pip3?|dd)(?:\.exe)?(?=\s|$)/i, "$1");
    if (next === s) return s;
    s = next;
  }
}

function sqlScriptsText(command: string, cwd: string): string {
  let text = "";
  for (const m of command.matchAll(/@{1,2}("?)([^\s"]+\.sql)\1/gi)) {
    try { text += "\n" + readFileSync(resolve(cwd, m[2]), "utf8"); } catch { /* 없는 파일은 무시 */ }
  }
  return text;
}

interface Finding { rule: Pick<Rule, "id" | "level" | "title" | "hint">; segment: string }

export function inspect(command: string, cwd: string): Finding[] {
  const segments = splitSegments(command);
  const findings: Finding[] = [];
  for (const segment of segments) {
    for (const rule of RULES) {
      if (rule.test.test(segment)) { findings.push({ rule, segment }); break; }
    }
  }
  if (segments.some((s) => /^sql(?:\s|$)/i.test(s)) && SQL_WRITE.test(command + sqlScriptsText(command, cwd))) {
    findings.push({
      segment: command.length > 300 ? command.slice(0, 300) + " …" : command,
      rule: {
        id: "sql-write", level: "ask", title: "DB 변경 SQL (DML/DDL/COMMIT/PLSQL)",
        hint: "The user did not approve this database change. Do not retry; show the SQL to the user and ask.",
      },
    });
  }
  return findings;
}

export default function (pi: ExtensionAPI) {
  if (!enabled("BASH_GUARD")) return;
  /** "이 세션에서 항상 허용" 을 고른 규칙 id */
  const sessionAllowed = new Set<string>();
  pi.on("session_start", () => sessionAllowed.clear());

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;
    const command = String((event.input as { command?: unknown }).command ?? "");
    const findings = inspect(command, ctx.cwd);

    const deny = findings.find((f) => f.rule.level === "deny");
    if (deny) {
      if (ctx.hasUI) ctx.ui.notify(`[oxy-guard] 차단: ${deny.rule.title}\n  ${deny.segment}`, "warning");
      return { block: true, reason: blocked(`guard/${deny.rule.id}`, deny.rule.hint) };
    }

    for (const f of findings) {
      if (sessionAllowed.has(f.rule.id)) continue;
      if (!ctx.hasUI) {
        return { block: true, reason: blocked(`guard/${f.rule.id}`, `${f.rule.hint} (no confirmation UI in this mode)`) };
      }
      const choice = await ctx.ui.select(
        `[oxy-guard] ${f.rule.title}\n\n  ${f.segment}\n\n실행을 허용할까요?`,
        ["허용 (이번만)", "이 세션에서 이 유형은 항상 허용", "거부"],
      );
      if (choice === "이 세션에서 이 유형은 항상 허용") sessionAllowed.add(f.rule.id);
      else if (choice !== "허용 (이번만)") {
        return { block: true, reason: blocked(`guard/${f.rule.id}`, f.rule.hint) };
      }
    }
    return undefined;
  });
}
