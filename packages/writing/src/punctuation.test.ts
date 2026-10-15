import { describe, expect, it } from 'vitest';
import { normalizePunctuation } from './punctuation';

describe('标点规范化（B74）', () => {
  it.each([
    ['他来了,她走了.', '他来了，她走了。'],
    ['真的吗?不会吧!', '真的吗？不会吧！'],
    ['掌柜说:"这玉不对."', '掌柜说：“这玉不对。”'],
    ['他沉默了...很久', '他沉默了……很久'],
    ['他沉默了。。。很久', '他沉默了……很久'],
    ['他沉默了…很久', '他沉默了……很久'],
    ['话没说完--就被打断', '话没说完——就被打断'],
    ['城南 的 当铺', '城南的当铺'],
    ['他(其实是旧主)没回头', '他（其实是旧主）没回头'],
    ['先这样;再那样', '先这样；再那样'],
  ])('%s → %s', (before, after) => {
    expect(normalizePunctuation(before)).toBe(after);
  });

  it('数字、英文、时间、网址与已经规范的文字不动；按行处理', () => {
    for (const keep of ['第3.5版', '十点半，也就是10:30。', 'He said: "OK."', '见 https://example.com/a.b', '“好。”他说——然后走了……']) {
      expect(normalizePunctuation(keep)).toBe(keep);
    }
    expect(normalizePunctuation('一行,\n二行.')).toBe('一行，\n二行。');
    // 直引号数目为奇数时不配对。
    expect(normalizePunctuation('他说"等等')).toBe('他说"等等');
  });

  it('规范两次与规范一次相同', () => {
    const once = normalizePunctuation('他说:"走吧..." 她(没回头)摇了摇头,--');
    expect(normalizePunctuation(once)).toBe(once);
  });
});
