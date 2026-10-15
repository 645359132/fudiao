// 中文正文的标点规范化（需求 B74）：写手的输出偶尔混进半角标点、直引号与不规范的省略号、破折号。
// 只在紧挨汉字或中文标点的地方改，数字（3.5、10:30）、英文与网址不动。思路参考 oh-story-claudecode（MIT）的标点规范化。

const HAN = '\\p{Script=Han}';
/** 汉字或中文标点。 */
const CJK = `[${HAN}，。！？；：、“”‘’（）《》〈〉【】…—]`;

const PAIRS: readonly (readonly [RegExp, string])[] = [
  // 半角标点紧跟在汉字后面（后面不是数字或字母，以免误伤“第3.5版”“10:30”）。
  [new RegExp(`(${CJK}),(?![0-9])`, 'gu'), '$1，'],
  [new RegExp(`(${CJK});`, 'gu'), '$1；'],
  [new RegExp(`(${CJK}):(?![0-9/])`, 'gu'), '$1：'],
  [new RegExp(`(${CJK})\\?`, 'gu'), '$1？'],
  [new RegExp(`(${CJK})!`, 'gu'), '$1！'],
  [new RegExp(`(${HAN})\\.(?![0-9A-Za-z.])`, 'gu'), '$1。'],
  // 省略号：三个以上的点、两个以上的“。”、单个“…”统一为“……”。
  [/\.{3,}|。{2,}|…+/gu, '……'],
  // 破折号：两个以上的短横（或单个“—”）紧挨汉字时统一为“——”。
  [new RegExp(`(${CJK})(?:-{2,}|—+)(?=${CJK})`, 'gu'), '$1——'],
  // 汉字之间的空格去掉。
  [new RegExp(`(${HAN}) +(?=${HAN})`, 'gu'), '$1'],
  // 半角括号括住汉字时换成全角。
  [new RegExp(`\\((${CJK}[^()]*)\\)`, 'gu'), '（$1）'],
];

/** 一段里的直引号按出现的先后配成“”。数目为奇数时不动（多半是英文或别有用意）。 */
function pairQuotes(line: string): string {
  const count = (line.match(/"/g) ?? []).length;
  if (count === 0 || count % 2 !== 0 || !new RegExp(HAN, 'u').test(line)) return line;
  let open = true;
  return line.replace(/"/g, () => {
    const q = open ? '“' : '”';
    open = !open;
    return q;
  });
}

/** 规范一段或多段中文正文的标点；按行处理，换行不变。 */
export function normalizePunctuation(text: string): string {
  return text
    .split('\n')
    .map((line) => PAIRS.reduce((s, [pattern, replacement]) => s.replace(pattern, replacement), pairQuotes(line)))
    .join('\n');
}
