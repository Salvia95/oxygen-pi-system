// 시나리오 평가용 작은 프로젝트를 만든다. 정답(FACTS)은 여기서만 정한다.
//   - .gitignore 로 가려지는 node_modules/ 와 build/ 가 있어, .gitignore 를 무시하는 검색은 잡음이 섞인다
//   - web/static/vendor.min.js 는 한 줄이 약 30KB 라, 줄 길이를 자르지 않는 검색은 출력이 커진다
//   - "/api/users" 처럼 / 로 시작하는 문자열을 찾는 과제가 있다 (Git Bash 인자 경로 변환 함정)
import fs from "node:fs";
import path from "node:path";

const CONTROLLER = (pkg, name, route, svc) => [
  `package com.acme.${pkg};`,
  ``,
  `import java.util.List;`,
  `import org.springframework.web.bind.annotation.GetMapping;`,
  `import org.springframework.web.bind.annotation.RestController;`,
  ``,
  `@RestController`,
  `public class ${name}Controller {`,
  `    private final ${svc} service;`,
  ``,
  `    public ${name}Controller(${svc} service) {`,
  `        this.service = service;`,
  `    }`,
  ``,
  `    @GetMapping("${route}")`,
  `    public List<String> list() {`,
  `        return service.findAll();`,
  `    }`,
  `}`,
  ``,
];

const FILES = {
  ".gitignore": "node_modules/\nbuild/\n*.log\n",
  "README.md": "# acme-shop\n\nSmall demo service. Build with Gradle. DB migrations are in `db/migration`.\n",
  "config/application.properties": "spring.application.name=acme-shop\nserver.port=8080\nspring.datasource.url=jdbc:h2:mem:shop\nlogging.level.root=INFO\n",
  "config/logback.xml": "<configuration>\n  <root level=\"INFO\"/>\n</configuration>\n",
  "config/.env.local": "PROFILE=local\n",
  "db/migration/V1__init.sql": "create table users (id bigint primary key, name varchar(100));\n",
  "db/migration/V2__add_orders.sql": "create table orders (id bigint primary key, user_id bigint, total decimal(12,2));\n",
  "db/migration/V3__add_index.sql": "create index ix_orders_user on orders (user_id);\n",
  "src/main/java/com/acme/user/UserController.java": CONTROLLER("user", "User", "/api/users", "UserService").join("\n"),
  "src/main/java/com/acme/user/UserService.java":
    "package com.acme.user;\n\nimport java.util.List;\n\npublic class UserService {\n    public List<String> findAll() {\n        return List.of(\"kim\", \"lee\");\n    }\n}\n",
  "src/main/java/com/acme/order/OrderController.java": CONTROLLER("order", "Order", "/api/orders", "OrderService").join("\n"),
  "src/main/java/com/acme/order/OrderService.java":
    "package com.acme.order;\n\nimport java.util.List;\nimport com.acme.user.UserService;\n\npublic class OrderService {\n    private final UserService users = new UserService();\n\n    public List<String> findAll() {\n        return users.findAll();\n    }\n}\n",
  // .gitignore 로 가려지는 복사본
  "build/generated-src/com/acme/user/UserController.java": CONTROLLER("user", "User", "/api/users", "UserService").join("\n"),
  "build/generated-src/com/acme/order/OrderController.java": CONTROLLER("order", "Order", "/api/orders", "OrderService").join("\n"),
  "node_modules/sql-fmt/fixtures/a.sql": "select 1;\n",
  "node_modules/sql-fmt/fixtures/b.sql": "select 2;\n",
  "node_modules/api-mock/routes.js": "module.exports = { '/api/users': [], '/api/orders': [] };\n",
};

export const FACTS = {
  userRouteFile: "UserController.java",
  userRouteLine: CONTROLLER("user", "User", "/api/users", "UserService").findIndex((l) => l.includes('"/api/users"')) + 1,
  migrations: ["V1__init.sql", "V2__add_orders.sql", "V3__add_index.sql"],
  configFiles: ["application.properties", "logback.xml", ".env.local"],
  topLevel: ["src", "db", "config", "web", "README.md"],
  controllers: 2,
  userServiceRefs: ["UserController.java", "OrderService.java"],
};

export function makeFixture(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  const put = (rel, text) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  };
  for (const [rel, text] of Object.entries(FILES)) put(rel, text);
  // 한 줄짜리 minified 파일 (약 30KB). UserService 와 /api/users 가 한 번씩 들어 있다
  const filler = "function a(b,c){return b+c}var d=a(1,2);".repeat(380);
  put("web/static/vendor.min.js", `!function(){${filler}var UserService={url:"/api/users"};${filler}}();\n`);
  put("web/index.html", "<!doctype html>\n<script src=\"static/vendor.min.js\"></script>\n");
  for (let i = 0; i < 150; i++) {
    put(`node_modules/pkg-${i}/index.js`, `module.exports = ${i};\n`);
    put(`node_modules/pkg-${i}/package.json`, `{"name":"pkg-${i}","version":"1.0.0"}\n`);
  }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1])) && process.argv[2]) {
  makeFixture(process.argv[2]);
  console.log(JSON.stringify(FACTS));
}
