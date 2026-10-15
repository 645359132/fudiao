// 每个“东亚字符”计 1：汉字、假名、谚文，以及全角标点和中文常用的标点（引号、省略号、破折号、间隔号）。
const EAST_ASIAN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}、-〿！-｠￠-￦—…‘’“”·]/u;
// 连续的字母或数字计 1 个词；词中的撇号与连字符不拆开（’ 属于东亚字符，见上，所以只有 ' 与 -）。
const WORD_CHAR = /[A-Za-z0-9À-ɏ]/;

const OTHER = 0;
const EAST = 1;
const LETTER = 2;
const JOINER = 3;
const UNKNOWN = 255;

// 基本多文种平面里每个字符的类别，第一次遇到时用上面的正则判定后记下。
// 正文每次按键、来源统计都要数全书或整章的字，逐字分类比正则匹配出整串结果快一个数量级，也不产生大量临时字符串。
const classes = new Uint8Array(0x10000).fill(UNKNOWN);

function classOf(code: number): number {
  const known = classes[code] ?? OTHER;
  if (known !== UNKNOWN) return known;
  const ch = String.fromCharCode(code);
  const k = EAST_ASIAN.test(ch) ? EAST : WORD_CHAR.test(ch) ? LETTER : ch === "'" || ch === '-' ? JOINER : OTHER;
  classes[code] = k;
  return k;
}

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** 字数，同 Word 的“字数”：东亚字符各计 1，西文按词计，空白与半角标点不计。 */
export function countWords(text: string): number {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    let k: number;
    if (isHigh(code) && isLow(text.charCodeAt(i + 1))) {
      // 基本平面以外的字符（扩展区的汉字等）很少见，直接用正则判定。
      k = EAST_ASIAN.test(text.slice(i, i + 2)) ? EAST : OTHER;
      i++;
    } else {
      k = classOf(code);
    }
    if (k === EAST) {
      count++;
      inWord = false;
    } else if (k === LETTER) {
      if (!inWord) count++;
      inWord = true;
    } else if (!(k === JOINER && inWord && i + 1 < text.length && classOf(text.charCodeAt(i + 1)) === LETTER)) {
      inWord = false;
    }
  }
  return count;
}
