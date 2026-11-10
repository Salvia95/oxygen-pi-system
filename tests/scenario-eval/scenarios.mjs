// 시나리오: 실제 pi + 실제 모델로 돌려 "정답 여부 · 요청 수 · 입력 토큰 · 도구 출력량" 을 잰다.
// group 은 어떤 교체를 검증하는지 나타낸다 (docs / ls / find / grep / edit).
import fs from "node:fs";
import path from "node:path";
import { FACTS } from "./fixture.mjs";

const has = (text, words) => words.filter((w) => !text.includes(w));

export const SCENARIOS = [
  {
    id: "doc1", group: "docs",
    prompt: "pi 의 prompt template 에서 인자가 없을 때 기본값을 쓰는 치환 문법이 뭐야? 기억으로 답하지 말고 pi 문서를 읽어서 확인한 뒤 알려줘.",
    check: ({ text, calls }) => {
      const readDoc = calls.some((c) => /prompt-templates\.md/.test(c.args));
      const ok = /\$\{(1|@):-/.test(text);
      return { pass: ok && readDoc, note: `문서 읽음=${readDoc} 문법=${ok}` };
    },
  },
  {
    id: "ls1", group: "ls",
    prompt: "config 폴더에 어떤 파일이 있는지 숨김 파일까지 포함해서 전부 알려줘.",
    check: ({ text }) => {
      const miss = has(text, FACTS.configFiles);
      return { pass: miss.length === 0, note: miss.length ? `빠짐: ${miss.join(",")}` : "3개 모두" };
    },
  },
  {
    id: "ls2", group: "ls",
    prompt: "이 프로젝트의 최상위 폴더와 파일을 알려줘.",
    check: ({ text }) => {
      const miss = has(text, FACTS.topLevel);
      return { pass: miss.length === 0, note: miss.length ? `빠짐: ${miss.join(",")}` : "모두 언급" };
    },
  },
  {
    id: "find1", group: "find",
    prompt: "이 프로젝트의 SQL 마이그레이션 파일을 모두 찾아서 경로를 알려줘.",
    check: ({ text }) => {
      const miss = has(text, FACTS.migrations);
      const noise = /a\.sql|b\.sql/.test(text);
      return { pass: miss.length === 0 && !noise, note: `${miss.length ? `빠짐: ${miss.join(",")} ` : ""}${noise ? "node_modules 의 sql 을 섞음" : "잡음 없음"}` };
    },
  },
  {
    id: "find2", group: "find",
    prompt: "이 프로젝트에서 이름이 Controller.java 로 끝나는 파일이 몇 개야? 개수와 경로를 알려줘.",
    check: ({ text }) => {
      const noise = /generated-src|build\//.test(text);
      const two = /\b2\s*개|두\s*개|2 files|\b2\b/.test(text) && text.includes("UserController.java") && text.includes("OrderController.java");
      return { pass: two && !noise, note: `${two ? "2개" : "개수 틀림"}${noise ? ", build/ 복사본을 셈" : ""}` };
    },
  },
  {
    id: "grep1", group: "grep",
    prompt: "`/api/users` 경로를 처리하는 컨트롤러 코드가 어느 파일의 몇 번째 줄에 있는지 알려줘.",
    check: ({ text }) => {
      const file = text.includes(FACTS.userRouteFile);
      const line = new RegExp(`(^|[^0-9])${FACTS.userRouteLine}([^0-9]|$)`).test(text);
      return { pass: file && line, note: `파일=${file} 줄(${FACTS.userRouteLine})=${line}` };
    },
  },
  {
    id: "grep2", group: "grep",
    prompt: "UserService 클래스를 참조하는 Java 파일을 모두 알려줘.",
    check: ({ text }) => {
      const miss = has(text, FACTS.userServiceRefs);
      return { pass: miss.length === 0, note: miss.length ? `빠짐: ${miss.join(",")}` : "모두 찾음" };
    },
  },
  {
    id: "edit1", group: "edit",
    prompt: "config/application.properties 의 server.port 를 9090 으로 바꿔줘.",
    check: ({ dir }) => {
      const t = fs.readFileSync(path.join(dir, "config/application.properties"), "utf8");
      const ok = /^server\.port=9090$/m.test(t) && t.includes("spring.application.name=acme-shop") && t.includes("logging.level.root=INFO");
      return { pass: ok, note: ok ? "파일 변경 확인" : "파일이 기대와 다름" };
    },
  },
];
