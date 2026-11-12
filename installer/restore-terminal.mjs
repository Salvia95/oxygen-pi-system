// 화면 프로그램(bin/oxy-tui.exe)이 터미널을 되돌리지 못하고 끝났을 때의 안전망. 래퍼(install.cmd · tweak.cmd · install.sh · tweak.sh)가 부른다.
//   node installer/restore-terminal.mjs <표식 파일>
// 표식 파일은 화면 프로그램이 대체 화면에 들어가 있는 동안에만 있다 (환경변수 OXY_TUI_MARK 로 경로를 준다. oxy-tui/src/main.rs 의 mark).
// Node 가 강제 종료되면 화면 프로그램도 함께 죽어 터미널이 대체 화면 · raw mode 에 남고 표식 파일도 남는다.
// 표식이 있을 때만 되돌린다: 대체 화면이 아닌데 나가는 시퀀스를 보내면 커서가 저장된 자리로 돌아가 이전 출력을 덮는다.
import { existsSync, rmSync } from "node:fs";

const mark = process.argv[2];
if (mark && existsSync(mark)) {
  rmSync(mark, { force: true });
  if (process.stdout.isTTY) {
    // 대체 화면에서 나오고 커서를 다시 보인다 (화면 프로그램은 마우스 · bracketed paste 를 켜지 않는다)
    process.stdout.write("\x1b[?1049l\x1b[?25h");
    try { process.stdin.setRawMode(true); process.stdin.setRawMode(false); } catch { /* TTY 아님 */ }
    process.stdout.write("화면 프로그램이 비정상 종료되어 터미널을 되돌렸습니다.\n");
  }
}
