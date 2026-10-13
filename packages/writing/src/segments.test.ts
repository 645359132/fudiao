import { describe, expect, it } from 'vitest';
import { DEFAULT_CHAPTER_WORDS, planSegments, SEGMENT_WORDS, splitParagraphs } from './segments';

describe('按情节点分段', () => {
  it('每段约一千五百字：三千字、四个情节点分成两段，各两个情节点', () => {
    expect(planSegments(['叩门', '压价', '起疑', '离开'], 3000)).toEqual({ segments: [['叩门', '压价'], ['起疑', '离开']], words: [1500, 1500] });
  });

  it('情节点按顺序尽量均分，多出的放在前面的段', () => {
    expect(planSegments(['a', 'b', 'c', 'd', 'e'], 4500).segments).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
  });

  it('段数不超过情节点数；字数按段数均分', () => {
    expect(planSegments(['a', 'b'], 9000)).toEqual({ segments: [['a'], ['b']], words: [4500, 4500] });
  });

  it('字数少于一段时只写一段', () => {
    expect(planSegments(['a', 'b', 'c'], 800)).toEqual({ segments: [['a', 'b', 'c']], words: [800] });
  });

  it('没有情节点时按本章目标写一段；没有定字数时用默认字数', () => {
    expect(planSegments([], 2000)).toEqual({ segments: [[]], words: [2000] });
    expect(planSegments(['a', 'b'], null).words.reduce((n, w) => n + w, 0)).toBe(DEFAULT_CHAPTER_WORDS);
    expect(SEGMENT_WORDS).toBe(1500);
  });
});

describe('把写手的输出切成段落', () => {
  it('按换行切开，去掉首尾空白与空行', () => {
    expect(splitParagraphs('  林舟叩门。\n\n\r\n　钱四压价。  \n')).toEqual(['林舟叩门。', '钱四压价。']);
  });

  it('只有空白时没有段落', () => {
    expect(splitParagraphs(' \n\n')).toEqual([]);
  });
});
