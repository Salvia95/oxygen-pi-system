// 기록(results.jsonl)은 저장소에 올라가므로 PC 계정 이름, 임시 폴더 경로, 조직 id 를 지운다.
//   node scrub.mjs <file>   이미 쌓인 기록 파일을 같은 규칙으로 고친다
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const SEP = String.raw`(?:\\\\|\\|/)`; // JSON 안의 \\ , 원문의 \ , 또는 /
const TEMP_RE = new RegExp(`[A-Za-z]:${SEP}Users${SEP}[^\\\\/"]+${SEP}AppData${SEP}Local${SEP}Temp`, "gi");
const USER_RE = new RegExp(`\\b${os.userInfo().username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");

export const scrub = (s) => s.replace(TEMP_RE, "%TEMP%").replace(USER_RE, "user").replace(/org_[A-Za-z0-9]+/g, "org_***");

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  const before = fs.readFileSync(file, "utf8");
  const after = scrub(before);
  after.split("\n").filter(Boolean).forEach((l) => JSON.parse(l));
  fs.writeFileSync(file, after);
  console.log(`${file}: ${before === after ? "바뀐 것 없음" : "고침"}`);
}
