// 大作品测试集生成器（需求第八章“大作品操作”）：给定种子生成确定的章节与段落，文字近似网文正文。
// 两档：基础集（10 万字、40 章）与连载规模集（200 万字、800 章）。生成内容与真实作品无关，只用于测性能。

export type CorpusChapter = { readonly title: string; readonly paragraphs: readonly string[] };

export type CorpusPreset = { readonly name: string; readonly chapters: number; readonly charsPerChapter: number };

export const PRESETS = {
  basic: { name: '基础集', chapters: 40, charsPerChapter: 2_500 },
  serial: { name: '连载规模集', chapters: 800, charsPerChapter: 2_500 },
} as const satisfies Record<string, CorpusPreset>;

export type PresetKey = keyof typeof PRESETS;

/** mulberry32：小而确定的伪随机数，同一种子在任何平台上生成相同的测试集。 */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = ['沈砚', '林晚', '顾长青', '掌柜', '老周', '阿七', '苏先生', '小满'];
const PLACES = ['当铺', '长街', '渡口', '客栈', '城隍庙', '药铺', '码头', '后院'];
const THINGS = ['那封信', '一把旧伞', '铜钥匙', '账本', '半块玉佩', '灯笼', '茶盏', '药方'];
const CLAUSES = [
  '雨下得更紧了',
  '风从巷口灌进来',
  '{n}没有回头',
  '{n}把{t}压在袖子里',
  '{p}的门半掩着',
  '远处传来打更的声音',
  '{n}低声说了一句什么',
  '灯芯噼啪响了一下',
  '{n}站在{p}门口等了很久',
  '谁也没有先开口',
  '{t}上还带着水渍',
  '{n}忽然想起三年前的那个晚上',
  '街上的人渐渐少了',
  '{n}抬起头看了看天色',
  '{p}里只剩下一盏灯',
  '他把话咽了回去',
  '她攥紧了手指',
  '{n}的声音有些发哑',
];
const TITLES = ['雨夜', '旧账', '来客', '渡口', '灯下', '回信', '长街', '对质', '暗号', '归途', '药方', '夜谈'];

/** 生成一部测试作品。每章字数达到 charsPerChapter 即止（略有超出），标题形如“第12章 雨夜”。 */
export function generateCorpus(preset: CorpusPreset, seed = 20261008): CorpusChapter[] {
  const rand = random(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)] as T;
  const clause = () => pick(CLAUSES).replace('{n}', pick(NAMES)).replace('{p}', pick(PLACES)).replace('{t}', pick(THINGS));
  const sentence = (min: number, max: number) => Array.from({ length: min + Math.floor(rand() * (max - min + 1)) }, clause).join('，');

  const chapters: CorpusChapter[] = [];
  for (let c = 1; c <= preset.chapters; c++) {
    const paragraphs: string[] = [];
    let chars = 0;
    while (chars < preset.charsPerChapter) {
      const r = rand();
      // 约三成是对话，偶有很长的段落，与网文的段落长度分布相近。
      const text =
        r < 0.3 ? `“${sentence(1, 3)}。”${pick(NAMES)}说。` : r < 0.95 ? `${sentence(1, 6)}。` : `${Array.from({ length: 4 }, () => sentence(3, 6)).join('。')}。`;
      paragraphs.push(text);
      chars += [...text].length;
    }
    chapters.push({ title: `第${c}章 ${pick(TITLES)}`, paragraphs });
  }
  return chapters;
}

/** 导出为 TXT（章节标题独占一行、段落首行缩进），供在应用中“导入 TXT”测试。 */
export function corpusText(chapters: readonly CorpusChapter[]): string {
  return chapters.map((c) => [c.title, ...c.paragraphs.map((p) => `\u3000\u3000${p}`)].join('\n')).join('\n\n') + '\n';
}
