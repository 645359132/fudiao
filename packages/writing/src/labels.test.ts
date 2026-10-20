import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { chapterMention, paragraphMention, replaceLabels } from './labels';

const names = new Map([
  ['C1', '《第一章 夜叩》'],
  ['C3', '《第三章 死当》'],
  ['P1', '“雨下了一夜……”一段'],
  ['P53', '“林舟推门……”一段'],
  ['P54', '“钱四抬头……”一段'],
  ['A2', '《第一章 夜叩》“官差押走……”一段'],
  ['E1', '钱四'],
]);

describe('标签换成章节名与段落开头（M6-08 第 5 项）', () => {
  it('章节、段落、依据的标签换掉，区间写成“至”，成对的方括号去掉', () => {
    expect(replaceLabels('后在C3又提出三百两死当', names)).toBe('后在《第三章 死当》又提出三百两死当');
    expect(replaceLabels('C1 写明押了端砚，C3 章末又说没当过', names)).toBe('《第一章 夜叩》 写明押了端砚，《第三章 死当》 章末又说没当过');
    expect(replaceLabels('P53–P54 重复', names)).toBe('“林舟推门……”一段至“钱四抬头……”一段 重复');
    expect(replaceLabels('P53-54', names)).toBe('“林舟推门……”一段至“钱四抬头……”一段');
    expect(replaceLabels('与 [A2] 矛盾，见【E1】', names)).toBe('与 《第一章 夜叩》“官差押走……”一段 矛盾，见钱四');
    expect(replaceLabels('p1 太长', names)).toBe('“雨下了一夜……”一段 太长');
  });

  it('不在表里的标签、更长的编号与英文词里的字母数字不动', () => {
    expect(replaceLabels('C10 与 C2 没给出', names)).toBe('C10 与 C2 没给出');
    expect(replaceLabels('MP3、ABC1、C1x、C1_', names)).toBe('MP3、ABC1、C1x、C1_');
    expect(replaceLabels('[C2]', names)).toBe('[C2]');
  });

  it('区间只认得一端时，认得的一端照换', () => {
    expect(replaceLabels('P99至P1', names)).toBe('P99至“雨下了一夜……”一段');
  });

  it('属性：没有标签样式的文字原样返回', () => {
    fc.assert(
      fc.property(fc.string().filter((s) => !/[A-Za-z]\d/.test(s)), (text) => {
        expect(replaceLabels(text, names)).toBe(text);
      }),
    );
  });

  it('属性：换过之后表里的标签不再单独出现，再换一次结果不变', () => {
    const piece = fc.oneof(
      fc.constantFrom(...names.keys(), 'C10', 'P5', '至', '–', '[', ']', '【', '】', ' ', '，'),
      fc.string({ maxLength: 4 }).filter((s) => !/[A-Za-z0-9]/.test(s)),
    );
    fc.assert(
      fc.property(fc.array(piece, { maxLength: 20 }), (parts) => {
        const once = replaceLabels(parts.join(''), names);
        for (const label of names.keys()) expect(once).not.toMatch(new RegExp(`(?<![A-Za-z0-9_])${label}(?![0-9A-Za-z_])`, 'i'));
        expect(replaceLabels(once, names)).toBe(once);
      }),
    );
  });

  it('段落的称呼取开头几个字，空段写第几段；章节写书名号', () => {
    expect(paragraphMention('雨下了一夜，街上没有人。林舟推开当铺的门。', 0)).toBe('“雨下了一夜，街上……”一段');
    expect(paragraphMention('“走吧。”', 2)).toBe('“走吧。”一段');
    expect(paragraphMention('  ', 2)).toBe('本章第 3 段');
    expect(paragraphMention('官差把钱四押走了。', 0, '《第一章》')).toBe('《第一章》“官差把钱四押走了。”一段');
    expect(chapterMention('第一章 夜叩', 0)).toBe('《第一章 夜叩》');
    expect(chapterMention(' ', 4)).toBe('第 5 章');
  });
});
