import { countWords } from '@fudiao/shared';
import { describe, expect, it } from 'vitest';
import { formatReport, runBenchmarks } from './benchmarks';
import { corpusText, generateCorpus, PRESETS } from './corpus';

describe('测试集生成', () => {
  it('同一种子生成相同的内容，不同种子不同', () => {
    const small = { name: '小', chapters: 3, charsPerChapter: 500 };
    expect(generateCorpus(small)).toEqual(generateCorpus(small));
    expect(generateCorpus(small, 1)).not.toEqual(generateCorpus(small, 2));
  });

  it('两档测试集的章数与字数符合需求第八章（字数误差不超过 2%）', () => {
    for (const [preset, words] of [
      [PRESETS.basic, 100_000],
      [PRESETS.serial, 2_000_000],
    ] as const) {
      const corpus = generateCorpus(preset);
      expect(corpus).toHaveLength(preset.chapters);
      const total = corpus.reduce((sum, c) => sum + c.paragraphs.reduce((s, p) => s + countWords(p), 0), 0);
      expect(Math.abs(total - words) / words).toBeLessThan(0.02);
    }
  });

  it('包含对话段落；TXT 每章以“第N章”开头、段落全角缩进', () => {
    const corpus = generateCorpus({ name: '小', chapters: 2, charsPerChapter: 2_000 });
    expect(corpus.flatMap((c) => c.paragraphs).some((p) => p.startsWith('“'))).toBe(true);
    const lines = corpusText(corpus).split('\n');
    expect(lines[0]).toMatch(/^第1章 /);
    expect(lines[1]?.startsWith('\u3000\u3000')).toBe(true);
  });
});

describe('性能基准', () => {
  it('在小测试集上跑通全部项目，报告带目标与结果', async () => {
    const report = await runBenchmarks('小', generateCorpus({ name: '小', chapters: 4, charsPerChapter: 800 }), { samples: 3, searchQueries: ['城隍庙', '灯'] });
    expect(report.chapters).toBe(4);
    expect(report.measures.map((m) => m.name)).toEqual([
      '导入全部章节（一个事务）',
      '打开作品并读取目录',
      '章节切换（读取一章正文）',
      '保存（改一段）',
      '保存（拆分一段）',
      expect.stringMatching(/^全文查找“城隍庙”（索引，\d+ 处）$/),
      expect.stringMatching(/^全文查找“灯”（扫描，\d+ 处）$/),
      '段落来源统计',
      '导出全部数据（作品包的 data 部分）',
      '备份（VACUUM INTO）',
    ]);
    expect(report.measures.find((m) => m.name.startsWith('章节切换'))).toMatchObject({ target: 1_000, pass: true });
    expect(formatReport(report)).toContain('| 章节切换（读取一章正文） | 3 |');
  });
});
