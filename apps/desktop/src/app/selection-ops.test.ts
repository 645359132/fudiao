import { rmSync } from 'node:fs';
import { buildWritingContext } from '@fudiao/context';
import { openaiChunks } from '@fudiao/llm/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { fsDeps, type TestDeps } from '../testing/fs-deps';
import { THINKING_ALLOWANCE } from './model-runner';
import { CONTINUE_LENGTH, maxOutputTokens, promptParts, targetLength } from './selection-ops';
import { createAppService } from './service';

describe('选区操作的参数', () => {
  it('目标字数：续写固定，扩写约两倍，缩写约一半，改写与润色与原文相当', () => {
    const text = '字'.repeat(100);
    expect(targetLength('continue', '')).toBe(CONTINUE_LENGTH);
    expect(targetLength('expand', text)).toBe(200);
    expect(targetLength('expand', '短')).toBe(101);
    expect(targetLength('shorten', text)).toBe(50);
    expect(targetLength('shorten', '短')).toBe(20);
    expect(targetLength('rewrite', text)).toBe(100);
    expect(maxOutputTokens(300)).toBe(600 + THINKING_ALLOWANCE);
  });

  it('从上下文清单取出材料与前后文', () => {
    const manifest = buildWritingContext(
      {
        project: { title: '雨夜', genre: '悬疑', synopsis: '', outline: '' },
        chapter: { id: 'c1', title: '第一章', summary: '', notes: '' },
        before: '前',
        selection: '选',
        after: '后',
        previousChapters: [],
        entities: [],
        facts: [],
      },
      1_000,
    );
    expect(promptParts(manifest)).toEqual({ materials: [{ title: '作品信息', text: '类型：悬疑' }], before: '前', selection: '选', after: '后' });
  });
});

const all: TestDeps[] = [];
afterEach(async () => {
  for (const d of all.splice(0)) {
    await d.dispose();
    rmSync(d.root, { recursive: true, force: true });
  }
});

function value<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

describe('选区操作的用例', () => {
  async function setup() {
    const deps = fsDeps();
    all.push(deps);
    const app = createAppService(deps);
    value(await app.loadLibrary());
    const work = value(await app.createWork('雨夜'));
    const chapter = value(await app.createChapter('第一章')).chapters[0];
    if (chapter === undefined) throw new Error('样本');
    const content = value(await app.openChapter(chapter.id));
    value(await app.saveChapter(chapter.id, content.saved, [{ id: 'p1', text: '沈砚推开当铺的门。', source: 'handwritten' }], { splits: [], merges: [] }));
    const created = value(await app.createEntity('character', '沈砚'));
    value(await app.updateEntity(created.created, { description: '当铺掌柜的旧友' }));
    const [p] = value(await app.saveProvider(null, { kind: 'openai_compatible', name: 'S', baseUrl: 'https://s.example.test/v1', authMethod: 'api_key', apiKey: 'sk' })).providers;
    value(await app.addModel(p?.id ?? '', 'm'));
    return { deps, app, chapterId: chapter.id, work };
  }

  it('改写选中的文字：提示词带上设定与选中的文字，结果流式返回，调用记为选区操作', async () => {
    const { deps, app, chapterId } = await setup();
    deps.llmResponses.push({ chunks: openaiChunks('m', { text: ['他推', '开了门。'], end: 'stop', usage: { input: 50, output: 8, cacheRead: 0 } }) });
    const deltas: string[] = [];
    const done = value(
      await app.runSelectionOperation(
        { chapterId, selection: { from: { paragraphId: 'p1', offset: 2 }, to: { paragraphId: 'p1', offset: 8 } }, operation: 'rewrite', instruction: '更简短', overrides: { include: [], exclude: [] } },
        { onEvent: (e) => (e.type === 'text' ? deltas.push(e.delta) : undefined) },
      ),
    );
    expect(done.result).toMatchObject({ outcome: 'completed', text: '他推开了门。' });
    expect(deltas).toEqual(['他推', '开了门。']);
    const body = JSON.stringify(deps.llmRequests.at(-1)?.body);
    expect(body).toContain('沈砚：当铺掌柜的旧友');
    expect(body).toContain('需要处理的文字：\\n推开当铺的门');
    expect(body).toContain('作者的要求：更简短');
    expect(value(await app.usage()).recent[0]).toMatchObject({ taskKind: 'selection_edit', templateId: 'selection_edit', stepKey: null });
  });

  it('除续写外都要先选中文字；续写可以只有光标', async () => {
    const { deps, app, chapterId } = await setup();
    const cursor = { from: { paragraphId: 'p1', offset: 9 }, to: { paragraphId: 'p1', offset: 9 } };
    expect(await app.runSelectionOperation({ chapterId, selection: cursor, operation: 'polish', instruction: '', overrides: { include: [], exclude: [] } })).toEqual({
      ok: false,
      error: { code: 'settings', detail: '请先在正文中选中要处理的文字' },
    });
    expect(deps.llmRequests).toHaveLength(0);
    deps.llmResponses.push({ chunks: openaiChunks('m', { text: ['柜台后没有人。'], end: 'stop' }) });
    const cont = value(await app.runSelectionOperation({ chapterId, selection: cursor, operation: 'continue', instruction: '', overrides: { include: [], exclude: [] } }));
    expect(cont.result.text).toBe('柜台后没有人。');
    expect(JSON.stringify(deps.llmRequests.at(-1)?.body)).toContain('往下写约 300 字');
  });

  it('作者移除的上下文不进入提示词', async () => {
    const { deps, app, chapterId } = await setup();
    const entityId = value(await app.listEntities())[0]?.id ?? '';
    deps.llmResponses.push({ chunks: openaiChunks('m', { text: ['好'], end: 'stop' }) });
    value(await app.runSelectionOperation({ chapterId, selection: null, operation: 'continue', instruction: '', overrides: { include: [], exclude: [`entity:${entityId}`] } }));
    expect(JSON.stringify(deps.llmRequests.at(-1)?.body)).not.toContain('当铺掌柜的旧友');
  });
});
