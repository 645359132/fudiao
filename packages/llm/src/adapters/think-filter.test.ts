import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ThinkFilter } from './think-filter';

const run = (chunks: readonly string[]) => {
  const f = new ThinkFilter();
  const out = chunks.map((c) => f.push(c));
  return { text: out.join('') + f.end(), deltas: out };
};

describe('思考标签过滤', () => {
  it('去掉开头的思考与其后的空白', () => {
    expect(run(['<think>先想想</think>\n\n{"a":1}']).text).toBe('{"a":1}');
  });

  it('标签被拆在多个增量中', () => {
    const { text, deltas } = run(['  <th', 'ink>想', '了很久</th', 'ink>', '\n', '雨下得', '更紧了。']);
    expect(text).toBe('雨下得更紧了。');
    expect(deltas.join('')).not.toContain('想');
  });

  it('没有思考标签时原样保留', () => {
    expect(run(['{"a":', '1}']).text).toBe('{"a":1}');
    expect(run(['<', 'p>正文']).text).toBe('<p>正文');
    expect(run(['<th']).text).toBe('<th');
  });

  it('只处理开头：正文中间的标签文字保留', () => {
    expect(run(['他说：<think>是个标签</think>']).text).toBe('他说：<think>是个标签</think>');
  });

  it('未闭合的思考整体丢弃', () => {
    expect(run(['<think>想到一半']).text).toBe('');
  });

  it('任意切分方式结果相同', () => {
    const full = '<think>推理过程</think>\n{"kind":"wait"}';
    fc.assert(
      fc.property(fc.array(fc.nat({ max: full.length }), { maxLength: 8 }), (cuts) => {
        const points = [...new Set([0, ...cuts, full.length])].sort((a, b) => a - b);
        const chunks = points.slice(1).map((p, i) => full.slice(points[i], p));
        return run(chunks).text === '{"kind":"wait"}';
      }),
    );
  });
});
