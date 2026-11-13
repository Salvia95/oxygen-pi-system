// 사용자 입력 표시 (docs/pi-tui-spec.md §9, 사용자 2026-11-14: "사용자 입력 의 경우 청록색 배경으로만 표시되고 있는데 앞에 > 를 붙여서 사용자 입력임을 명확히 해줘").
// pi 의 사용자 메시지는 Markdown 으로 그려져 줄 앞의 `> ` 는 인용문이 된다. 백슬래시(`\>`)는 pi 가 그대로 보이고(preserveBackslashEscapes),
// `&gt;` 도 글자 그대로 보인다(실측). 폭 0 인 단어 결합 문자(U+2060)를 앞에 두면 인용문이 아니고 `> ` 만 보인다 (모델이 받는 글은 바꾸지 않는다).
export const USER_MARK = "⁠> ";

/** 사용자 메시지 Markdown 앞에 `>` 를 붙인다 (이미 붙어 있으면 그대로) */
export function markUser(markdown: string): string {
  if (!markdown || markdown.startsWith(USER_MARK)) return markdown;
  return USER_MARK + markdown;
}
