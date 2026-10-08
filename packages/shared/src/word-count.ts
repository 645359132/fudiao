// 每个“东亚字符”计 1：汉字、假名、谚文，以及全角标点和中文常用的标点（引号、省略号、破折号、间隔号）。
const EAST_ASIAN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}、-〿！-｠￠-￦—…‘’“”·]/gu;
// 连续的字母或数字计 1 个词；词中的撇号与连字符不拆开。
const WORD = /[A-Za-z0-9À-ɏ]+(?:['’-][A-Za-z0-9À-ɏ]+)*/g;

/** 字数，同 Word 的“字数”：东亚字符各计 1，西文按词计，空白与半角标点不计。 */
export function countWords(text: string): number {
  const eastAsian = text.match(EAST_ASIAN)?.length ?? 0;
  const words = text.replace(EAST_ASIAN, ' ').match(WORD)?.length ?? 0;
  return eastAsian + words;
}
