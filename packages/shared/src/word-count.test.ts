import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { countWords } from './word-count';

// 逐字分类之前的写法（按正则匹配出整串结果再计数），作为对照。
const EAST_ASIAN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}、-〿！-｠￠-￦—…‘’“”·]/gu;
const WORD = /[A-Za-z0-9À-ɏ]+(?:['’-][A-Za-z0-9À-ɏ]+)*/g;
const byRegex = (text: string) => (text.match(EAST_ASIAN)?.length ?? 0) + (text.replace(EAST_ASIAN, ' ').match(WORD)?.length ?? 0);

describe('字数（同 Word 的“字数”）', () => {
  it('每个汉字计 1', () => {
    expect(countWords('雨下得更紧了')).toBe(6);
  });

  it('全角标点与中文常用标点计 1', () => {
    expect(countWords('他说：“走吧。”')).toBe(8);
    // 省略号与破折号各由两个字符组成。
    expect(countWords('等等……不——')).toBe(7);
    expect(countWords('（注）')).toBe(3);
  });

  it('连续的英文字母或数字计 1 个词', () => {
    expect(countWords('hello world')).toBe(2);
    expect(countWords("don't stop-motion")).toBe(2);
    expect(countWords('2026 年')).toBe(2);
    expect(countWords('第3章')).toBe(3);
  });

  it('混排', () => {
    // 他打开（3）iPhone（1）15（1），（1）看了一眼（4）。（1）
    expect(countWords('他打开 iPhone 15，看了一眼。')).toBe(11);
  });

  it('空白与半角标点不计', () => {
    expect(countWords('  \n\t　 ')).toBe(0);
    expect(countWords('a, b. c!')).toBe(3);
    expect(countWords('')).toBe(0);
  });

  it('段落之间相加', () => {
    fc.assert(
      // 换行不会把两段的词连在一起，所以总数恒等于两段之和。
      fc.property(fc.string({ unit: 'grapheme' }), fc.string({ unit: 'grapheme' }), (a, b) => countWords(`${a}\n${b}`) === countWords(a) + countWords(b)),
    );
    expect(countWords('雨夜\n当铺')).toBe(countWords('雨夜') + countWords('当铺'));
  });

  it('与按正则匹配的结果相同（任意文字，含扩展区汉字、表情、单独的代理项与各种连接符）', () => {
    const pieces = ['a', 'Z', '9', 'é', 'ɏ', 'ɐ', "'", '’', '-', '—', ' ', '\n', '雨', '夜', 'か', 'カ', 'ｶ', '한', '、', '。', '！', '～', '￥', '…', '“', '·', '𠀀', '😀', '\ud800', '\udc00', ',', '.', '_', '０', 'Ａ'];
    const mixed = fc.array(fc.constantFrom(...pieces), { maxLength: 40 }).map((parts) => parts.join(''));
    fc.assert(
      fc.property(fc.oneof(mixed, fc.string({ unit: 'grapheme' }), fc.string({ unit: 'binary' })), (text) => countWords(text) === byRegex(text)),
      { numRuns: 3000 },
    );
  });
});
