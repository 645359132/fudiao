import { describe, expect, it } from 'vitest';
import type { Chapter, Entity, Fact, Project, Relationship, StoredModel } from '@fudiao/store';
import { AFTER_CHARS, BEFORE_CHARS, contextBudget, DEFAULT_CONTEXT_BUDGET, gatherWritingInput, splitAround } from './writing-context';

const paragraphs = [
  { id: 'a', text: '雨下得更紧了。' },
  { id: 'b', text: '沈砚推开当铺的门。' },
  { id: 'c', text: '柜台后没有人。' },
];

describe('按选区分开正文', () => {
  it('选区跨段时前文、选中的文字与后文以换行连接；没有选区时从章末续写', () => {
    expect(splitAround(paragraphs, { from: { paragraphId: 'b', offset: 2 }, to: { paragraphId: 'c', offset: 3 } })).toEqual({
      before: '雨下得更紧了。\n沈砚',
      selection: '推开当铺的门。\n柜台后',
      after: '没有人。',
    });
    expect(splitAround(paragraphs, { from: { paragraphId: 'a', offset: 0 }, to: { paragraphId: 'a', offset: 0 } })).toEqual({
      before: '',
      selection: '',
      after: '雨下得更紧了。\n沈砚推开当铺的门。\n柜台后没有人。',
    });
    expect(splitAround(paragraphs, null).after).toBe('');
    expect(splitAround(paragraphs, null).before).toBe('雨下得更紧了。\n沈砚推开当铺的门。\n柜台后没有人。');
  });

  it('前文与后文按长度截取；找不到段落时按章末处理', () => {
    const long = [{ id: 'x', text: '甲'.repeat(BEFORE_CHARS + 100) }, { id: 'y', text: '乙'.repeat(AFTER_CHARS + 100) }];
    const parts = splitAround(long, { from: { paragraphId: 'y', offset: 0 }, to: { paragraphId: 'y', offset: 0 } });
    expect(parts.before).toHaveLength(BEFORE_CHARS);
    expect(parts.after).toHaveLength(AFTER_CHARS);
    expect(splitAround(paragraphs, { from: { paragraphId: 'gone', offset: 0 }, to: { paragraphId: 'gone', offset: 0 } }).selection).toBe('');
  });
});

const chapter = (id: string, title: string, summary = ''): Chapter =>
  ({ id, title, summary, notes: '', orderKey: id, status: 'normal', trashedAt: null, volumeId: null, version: 1, createdAt: '', updatedAt: '' });
const entity = (id: string, name: string, aliases: string[] = []): Entity =>
  ({ id, kind: 'character', name, aliases, description: `${name}的说明`, attributes: [], locked: false, version: 1, createdAt: '', updatedAt: '' });
const fact = (id: string, patch: Partial<Fact>): Fact =>
  ({
    id,
    kind: 'world',
    holderId: null,
    subjectIds: [],
    content: id,
    modality: null,
    confidence: null,
    validFromChapterId: null,
    validToChapterId: null,
    validFrom: null,
    validTo: null,
    status: 'confirmed',
    reviewReason: null,
    version: 1,
    createdAt: '',
    updatedAt: '',
    basis: [],
    eventIds: [],
    ...patch,
  });

describe('收集写作上下文', () => {
  const project = { title: '雨夜', genre: '悬疑', synopsis: '梗概', outline: '' } as Project;
  const chapters = [chapter('c1', '第一章', '初遇'), chapter('c2', '第二章', '收信'), chapter('c3', '第三章'), chapter('c4', '第四章')];
  const entities = [entity('shen', '沈砚', ['沈先生']), entity('shop', '当铺'), entity('lin', '林晚')];

  it('设定按本章提及计数，选区附近出现的标出；前面的章节从近到远', () => {
    const input = gatherWritingInput(
      { project, chapters, chapterId: 'c3', paragraphs: [...paragraphs, { id: 'd', text: '沈先生坐下。' }], entities, facts: [] },
      { from: { paragraphId: 'b', offset: 0 }, to: { paragraphId: 'b', offset: 2 } },
    );
    expect(input?.previousChapters.map((c) => c.id)).toEqual(['c2', 'c1']);
    expect(input?.entities.map((e) => [e.id, e.mentions, e.nearSelection])).toEqual([
      ['shen', 2, true],
      ['shop', 1, true],
    ]);
    expect(input?.selection).toBe('沈砚');
  });

  it('事实：与出现的设定有关、适用于本章、没有被否决', () => {
    const facts = [
      fact('相关', { subjectIds: ['shen'] }),
      fact('持有者相关', { kind: 'belief', holderId: 'shen' }),
      fact('无关', { subjectIds: ['lin'] }),
      fact('之后才成立', { subjectIds: ['shen'], validFromChapterId: 'c4' }),
      fact('已经过时', { subjectIds: ['shen'], validToChapterId: 'c2' }),
      fact('本章为止', { subjectIds: ['shen'], validToChapterId: 'c3' }),
      fact('已否决', { subjectIds: ['shen'], status: 'rejected' }),
      fact('待复核', { subjectIds: ['shen'], status: 'needs_review' }),
    ];
    const input = gatherWritingInput({ project, chapters, chapterId: 'c3', paragraphs, entities, facts }, null);
    expect(input?.facts.map((f) => [f.id, f.status])).toEqual([
      ['相关', 'confirmed'],
      ['持有者相关', 'confirmed'],
      ['本章为止', 'confirmed'],
      ['待复核', 'needs_review'],
    ]);
    expect(gatherWritingInput({ project, chapters, chapterId: 'gone', paragraphs, entities, facts }, null)).toBeNull();
  });

  it('人物关系（B73）：适用于本章、至少一端在本章出现；两端都出现时标出', () => {
    const rel = (id: string, fromId: string, toId: string, patch: Partial<Relationship> = {}): Relationship => ({
      id,
      fromId,
      toId,
      category: 'ally',
      label: id,
      mutual: false,
      description: '',
      secret: false,
      validFromChapterId: null,
      validToChapterId: null,
      version: 1,
      createdAt: '',
      updatedAt: '',
      ...patch,
    });
    const relationships = [
      rel('两端出现', 'shen', 'shop'),
      rel('一端出现', 'lin', 'shen', { secret: true }),
      rel('都不出现', 'lin', 'ghost'),
      rel('之后才成立', 'shen', 'shop', { validFromChapterId: 'c4' }),
      rel('已经结束', 'shen', 'shop', { validToChapterId: 'c2' }),
    ];
    const input = gatherWritingInput({ project, chapters, chapterId: 'c3', paragraphs, entities, facts: [], relationships }, null);
    expect(input?.relations?.map((r) => [r.id, r.from, r.to, r.bothPresent, r.secret])).toEqual([
      ['两端出现', '沈砚', '当铺', true, false],
      ['一端出现', '林晚', '沈砚', false, true],
    ]);
  });

  it('预算：默认模型上下文长度的 60%，最多 32,000；没有默认模型时用保守值', () => {
    const model = (contextWindow: number, known = true) => ({ capabilities: { contextWindow, limitsKnown: { contextWindow: known, maxOutputTokens: false } } }) as StoredModel;
    expect(contextBudget(null)).toBe(DEFAULT_CONTEXT_BUDGET);
    expect(contextBudget(model(32_000))).toBe(19_200);
    expect(contextBudget(model(1_000_000))).toBe(32_000);
    // 上下文长度没有依据时按估算的 128,000 算，封顶 32,000。
    expect(contextBudget(model(32_000, false))).toBe(32_000);
  });
});
