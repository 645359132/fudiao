import { describe, expect, it } from 'vitest';
import { styleChecks, type StyleCheckInput } from './style-checks';
import type { ParagraphText } from './types';

const paras = (...texts: string[]): ParagraphText[] => texts.map((text, i) => ({ id: `p${i}`, version: 1, text }));
const base: StyleCheckInput = { names: ['沈孤舟'], overused: [], overusedOpenings: [], previousEndings: [], dialogueTarget: null };
const found = (input: Partial<StyleCheckInput>, ...texts: string[]) => styleChecks(paras(...texts), { ...base, ...input }).map((i) => [i.kind, i.severity, i.anchor.paragraphId, i.description, i.anchor.quote] as const);

/** 一章够长、句子长短不一、对话够多的干净正文。 */
const clean = [
  '雪停了。沈孤舟把门闩落下，回头看了一眼柜台后那盏快要熄的油灯，灯芯上结着厚厚一层焦炭，火苗在穿堂风里来回晃。',
  '“你还不睡？”楚晚晴从楼梯上下来，手里端着一碗已经凉透的粥。',
  '“睡不着。”他说。',
  '她把碗放在柜台上，没有再问。',
  '外面的风小了些，远处有狗叫了两声，又安静下去。',
];

describe('文风的程序检查（B87）', () => {
  it('干净的正文没有问题', () => {
    expect(found({ dialogueTarget: 0.25 }, ...clean)).toEqual([]);
  });

  it('最近几章用得太多的说法本章又用了：定位到对白以外的第一处，带次数', () => {
    expect(found({ overused: ['令人牙酸', '腥甜'] }, '“令人牙酸。”铁门发出令人牙酸的声响，又是一声令人牙酸的刮擦。', '喉头涌上腥甜。')).toEqual([
      ['ai_tone', 'low', 'p0', '“令人牙酸”最近几章已经用得太多，本章又用了 2 次', '令人牙酸'],
      ['ai_tone', 'low', 'p1', '“腥甜”最近几章已经用得太多，本章又用了 1 次', '腥甜'],
    ]);
  });

  it('本章的高频实词：两字的词八次、三字以上的说法三次；已报过的不再报', () => {
    const contexts = ['撞在石上', '贴着皮肉', '发出闷响', '冷得刺骨', '压在胸口', '横在面前', '落在泥里', '磕在门上'];
    const many = contexts.map((x, i) => `第${i}下，生铁${x}。`).join('');
    const issues = found({}, many, '他微不可察地点头，又微不可察地摇头，再微不可察地叹气。');
    // “微不可察地”三次是固定搭配，它盖住的“微不可察”不再单独报。
    expect(issues.map((i) => i[3])).toEqual(['“生铁”在本章出现 8 次', '“微不可察地”在本章重复了 3 次']);
    expect(found({ overused: ['生铁'] }, many).map((i) => i[3])).toEqual(['“生铁”最近几章已经用得太多，本章又用了 8 次']);
    expect(found({}, contexts.slice(0, 7).map((x, i) => `第${i}下，生铁${x}。`).join(''))).toEqual([]);
  });

  it('固定搭配重复三次', () => {
    expect(found({}, '铁门发出一声闷响。', '木门发出一声闷响。', '石门发出一声闷响。').map((i) => [i[3], i[4]])).toEqual([['“门发出一声闷响”在本章重复了 3 次', '门发出一声闷响']]);
  });

  it('句首模板：账本里的句首本章又用了两次，或本章自己有六句同一开头', () => {
    const two = '沈孤舟没有回头。他走了。沈孤舟没有说话。';
    expect(found({ overusedOpenings: ['沈孤舟没有'] }, two).map((i) => [i[3], i[4]])).toEqual([['句子以“沈孤舟没有……”开头最近几章已经用得太多，本章又用了 2 次', '沈孤舟没有']]);
    expect(found({}, two)).toEqual([]);
    const six = ['的瓦松了', '有风掠过', '传来脚步', '是一片雪', '黑了下去', '又响了'].map((x) => `头顶${x}。`).join('');
    expect(found({}, six).map((i) => i[3])).toEqual(['本章有 6 句都以“头顶……”开头']);
  });

  it('对话占比低于目标六成时提出中等问题；太短的章与没有目标时不查', () => {
    const narration = Array.from({ length: 40 }, (_, i) => `第${i}夜雨下了一夜，巷子里积了水，挑担子的人把裤脚卷到膝盖，一步一步踩过去。`);
    const issues = found({ dialogueTarget: 0.25 }, ...narration, '“走。”');
    expect(issues.filter((i) => i[0] === 'pacing' && i[1] === 'medium').map((i) => i[3])).toEqual(['本章对话只占 0%，低于本章的目标（约 25%）']);
    expect(found({ dialogueTarget: 0.25 }, '雨下了一夜。')).toEqual([]);
    expect(found({}, ...narration).filter((i) => i[1] === 'medium')).toEqual([]);
  });

  it('叙述句子长短太均匀时提示一次', () => {
    const even = Array.from({ length: 45 }, (_, i) => `第${i}个人推开门走了进来。`);
    expect(found({}, ...even).map((i) => i[3]).filter((d) => d.startsWith('叙述的句子'))).toEqual([expect.stringMatching(/^叙述的句子长短太均匀（变异系数 0\.0\d）$/)]);
    const mixed = Array.from({ length: 45 }, (_, i) => (i % 2 === 0 ? `第${i}个人推开门走了进来，看了一眼柜台后面那盏快要熄灭的油灯，又把门带上。` : `第${i}个走了。`));
    expect(found({}, ...mixed).filter((i) => i[3].startsWith('叙述的句子'))).toEqual([]);
  });

  it('连续三章同一种收法时提示在最后一段', () => {
    expect(found({ previousEndings: ['freeze', 'freeze'] }, '他走进雨里。', '刀落在地上。')).toEqual([['ai_tone', 'low', 'p1', '连续 3 章都以一句短的定格收尾', '']]);
    expect(found({ previousEndings: ['dialogue', 'freeze'] }, '刀落在地上。')).toEqual([]);
    expect(found({ previousEndings: ['freeze'] }, '刀落在地上。')).toEqual([]);
  });

  it('一段长对白在交代前情', () => {
    const long = `“${'当年我随老掌柜去北边收账，'.repeat(10)}这些你都该知道。”`;
    const issues = found({}, '他咳出一口血，开口：' + long);
    expect(issues.map((i) => [i[0], i[3]])).toEqual([['pacing', `一段 ${[...long].filter((c) => /\p{Script=Han}/u.test(c)).length} 字的对白在交代前情`]]);
    expect(found({}, `“${'他看着雪，'.repeat(20)}”`)).toEqual([]);
  });

  it('空的正文没有问题', () => {
    expect(found({ dialogueTarget: 0.3 }, '', ' ')).toEqual([]);
  });
});
