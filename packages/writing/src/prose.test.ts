import { describe, expect, it } from 'vitest';
import { maskDialogue, MAX_HITS_PER_RULE, proseChecks, visibleLength } from './prose';
import type { ParagraphText } from './types';

const paras = (...texts: string[]): ParagraphText[] => texts.map((text, i) => ({ id: `p${i}`, version: 1, text }));
const found = (...texts: string[]) => proseChecks(paras(...texts)).map((i) => [i.anchor.paragraphId, i.description, i.anchor.quote]);
const descriptions = (...texts: string[]) => proseChecks(paras(...texts)).map((i) => i.description);

describe('文字体检（B74）', () => {
  it('对白遮住后长度不变；可见字数不算标点', () => {
    const text = '他说：“不是我，是她。”然后走了。';
    const masked = maskDialogue(text);
    expect(masked).toHaveLength(text.length);
    expect(masked.includes('不是我')).toBe(false);
    expect(masked.startsWith('他说：“')).toBe(true);
    expect(visibleLength('你好，world！123')).toBe(10);
  });

  it('干净的正文没有问题；对白里的同样句式不算', () => {
    expect(found('雨下了一夜。林舟推开门，柜台后没有人。', '“不是我拿的，是他。”钱四说。')).toEqual([]);
    expect(found('他问：“是不是你？”她摇头。')).toEqual([]);
  });

  it('AI 常见句式：不是……而是、否定排比、全知旁白；定位到原文', () => {
    const issues = proseChecks(paras('这不是退让，而是试探。', '没有风，没有灯，没有人声，只有雨。', '她不知道的是，门外还站着一个人。'));
    expect(issues.map((i) => [i.anchor.paragraphId, i.kind, i.severity, i.anchor.quote])).toEqual([
      ['p0', 'ai_tone', 'low', '不是退让，而是'],
      ['p1', 'ai_tone', 'low', '没有风，没有灯，没有人声，'],
      ['p2', 'ai_tone', 'low', '她不知道的是'],
    ]);
  });

  it('写作材料、模型自称、占位与英文开场白混进正文时严重', () => {
    const issues = proseChecks(paras('本章目标：林舟当玉。', '作为一个AI，我无法继续写这一段。', '他走进当铺（此处省略三百字）。', 'Sure, here is the chapter.'));
    expect(issues.filter((i) => i.severity === 'high').map((i) => i.anchor.paragraphId)).toEqual(['p0', 'p1', 'p2', 'p3', 'p3']);
    // 写作研究、技术公司里的“作为 AI”不算自称。
    expect(descriptions('她作为AI研究员，熬了一夜。')).toEqual([]);
  });

  it('生成退化：同一长句出现三次、相邻两段一字不差、最后一段没写完', () => {
    const loop = '他把那块玉放回柜台上又拿了起来。';
    expect(descriptions(loop, '雨更大了。', loop, loop + '掌柜看着他。')).toEqual(['同一句话在本章出现了 3 次']);
    expect(descriptions('门开了，他走了进来。', '门开了，他走了进来。')).toEqual(['这一段与上一段一字不差']);
    const cut = proseChecks(paras('雨下了一夜。', '林舟推开门，看见掌柜正把一封'));
    expect(cut.map((i) => [i.description, i.anchor.paragraphId, i.anchor.quote])).toEqual([['本章最后一段没有写完（可能是输出被截断）', 'p1', '看见掌柜正把一封']]);
    expect(descriptions('他走了。“等等！”')).toEqual([]);
  });

  it('章尾的总结或预告收束只看最后几段；比喻太密时提示一次', () => {
    const long = Array.from({ length: 10 }, (_, i) => `第${i}个夜里，他在雨里站了很久，等对街那盏灯灭了才离开，鞋里灌满了水，一路走回城南的旧宅，推门时手还在抖，屋里的炭盆早就凉了。`);
    expect(descriptions('谁也不知道，这只是开始。', ...long)).toEqual([]);
    expect(descriptions('他走进雨里。', '命运的齿轮开始转动。')).toEqual(['章尾用总结或预告收束，像在替读者下结论']);
    const similes = Array.from({ length: 8 }, (_, i) => `灯光仿佛第${i}层水。`);
    expect(descriptions(...similes)).toEqual(['比喻用得太密：本章“仿佛、好像、如同”之类出现 8 次']);
  });

  it('对照句式“不仅是……更是”“与其说……不如说”、“进行＋动词”、堆叠的限定：定位到原文，一段只报一处', () => {
    const issues = proseChecks(paras('他不仅是她的师父，更是她的父亲。', '与其说是恨，不如说是怕。', '他进行了一次深呼吸，又进行了一番思考。', '她似乎有些犹豫，心里有某种难以言说的东西。'));
    expect(issues.map((i) => [i.anchor.paragraphId, i.anchor.quote])).toEqual([
      ['p0', '不仅是她的师父，更是'],
      ['p1', '与其说是恨，不如说'],
      ['p2', '进行了一次深呼吸'],
      ['p3', '似乎有些'],
    ]);
    expect(descriptions('他说：“与其说是恨，不如说是怕。”', '他进行到第三页。')).toEqual([]);
  });

  it('接连几句以同样的开头起句时提示一次（人名三句、代词四句）；换了主语或者对白开头的句子不算；破折号太密时提示一次', () => {
    expect(found('他推开门。他看见柜台后没有人。他叹了口气。他走了。')).toEqual([['p0', '接连 4 句都以“他”起头', '他推开门。']]);
    expect(found('林舟推开门。林舟看见柜台后没有人。林舟叹了口气。')).toEqual([['p0', '接连 3 句都以“林舟”起头', '林舟推开门。']]);
    expect(descriptions('他推开门。他看见柜台后没有人。他叹了口气。')).toEqual([]);
    expect(descriptions('他推开门。她看见柜台后没有人。他叹了口气。他走了。')).toEqual([]);
    expect(descriptions('他推开门。他看见柜台后没有人。“他来了。”他叹了口气。他走了。')).toEqual([]);
    const dashed = Array.from({ length: 6 }, (_, i) => `第${i}天——雨还在下。`);
    expect(descriptions(...dashed)).toEqual(['破折号用得太密：本章出现 6 处']);
    expect(descriptions('他停了一下——门外有脚步声。', ...Array.from({ length: 10 }, (_, i) => `第${i}夜雨下了一夜，巷子里积了水，挑担子的人把裤脚卷到膝盖，一步一步踩过去，谁也没有说话，远处的更鼓敲了三下。`))).toEqual([]);
  });

  it('同一规则一章最多报五处；问题按段落顺序排列', () => {
    const many = Array.from({ length: 8 }, (_, i) => `这不是第${i}次，而是最后一次。`);
    const issues = proseChecks(paras(...many));
    expect(issues).toHaveLength(MAX_HITS_PER_RULE);
    expect(issues.map((i) => i.anchor.paragraphId)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4']);
  });
});
