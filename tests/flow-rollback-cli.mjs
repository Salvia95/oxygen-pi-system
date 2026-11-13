// E2E 보조: pi 가 만든 작업 기록(.oxy/flow)에 엔진으로 되돌리기 · 되돌리기 취소를 한다 (docs/flow-rollback-spec.md §5).
// pi 의 1회 실행(-p)은 /flow 같은 확장 명령을 실행하지 않아, 대화형 확인은 tuicap 실측이 맡고 여기서는 같은 엔진을 직접 부른다.
//   node --experimental-strip-types --no-warnings tests/flow-rollback-cli.mjs <작업 폴더> rollback <task> | undo
import { FileFlowEngine } from "../agent/extensions/oxy-flow/store.ts";

const [dir, op, task] = process.argv.slice(2);
const e = new FileFlowEngine(dir);
try {
  const r = op === "undo" ? e.undoLast() : e.rollbackTo(e.load().id, task);
  console.log(JSON.stringify({ ok: r.ok, reason: r.reason ?? null, files: r.files }));
  process.exitCode = r.ok ? 0 : 1;
} finally { e.release(); }
