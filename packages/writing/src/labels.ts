// 模型在提示词里用标签指代章节、段落与依据（C1、P3、A2、E1……），写出的说明里常常照抄这些标签。
// 写进作品（审核问题、设定说明、人物关系）之前换成作者看得懂的说法：章节换成书名号里的章节名，段落换成开头几个字。

/** 段落提及里取开头的字数。 */
export const MENTION_HEAD_CHARS = 8;

// 标签：一个字母加数字，前后不能紧挨字母、数字；可以写成区间（P53–P54、P53-54），可以带方括号（[P3]、【P3】）。
const LABEL = /([[【]?)(?<![A-Za-z0-9_])([A-Za-z])(\d{1,4})(?:\s*[-–—~～至到]\s*\2?(\d{1,4}))?(?![A-Za-z0-9_])([\]】]?)/g;

/**
 * 把 text 里出现的标签换成 names 中的说法（键为大写的标签，例如 C3、P12）。不在 names 里的标签原样保留；
 * 区间写成“甲至乙”；标签外的方括号成对时一并去掉。只扫描一遍，换进去的说法不会再被替换。
 */
export function replaceLabels(text: string, names: ReadonlyMap<string, string>): string {
  if (names.size === 0) return text;
  return text.replace(LABEL, (match: string, open: string, letter: string, from: string, to: string | undefined, close: string) => {
    const name = (n: string) => names.get(`${letter.toUpperCase()}${String(Number(n))}`);
    const first = name(from);
    const last = to === undefined ? undefined : name(to);
    if (first === undefined && last === undefined) return match;
    const a = first ?? `${letter}${from}`;
    const body = to === undefined ? a : `${a}至${last ?? `${letter}${to}`}`;
    const paired = open !== '' && close !== '' && (open === '[') === (close === ']');
    return paired ? body : `${open}${body}${close}`;
  });
}

/** 段落的称呼：开头几个字（“雨下了一夜，街上……”一段）；段落为空时写第几段（index 从 0 起），where 为“本章”或章节名。 */
export function paragraphMention(text: string, index: number, where = '本章'): string {
  const plain = text.trim().replace(/[“”"]/g, '');
  if (plain === '') return `${where}第 ${index + 1} 段`;
  const chars = [...plain];
  // 只多出一两个字时整段写出，不为省两个字加省略号。
  const whole = chars.length <= MENTION_HEAD_CHARS + 2;
  const head = whole ? plain : chars.slice(0, MENTION_HEAD_CHARS).join('');
  return `${where === '本章' ? '' : where}“${head}${whole ? '' : '……'}”一段`;
}

/** 章节的称呼：书名号里的章节名；没有章节名时写第几章（index 从 0 起）。 */
export function chapterMention(title: string, index: number): string {
  return title.trim() === '' ? `第 ${index + 1} 章` : `《${title.trim()}》`;
}
