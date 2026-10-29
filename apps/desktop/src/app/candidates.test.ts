import { rmSync } from 'node:fs';
import { openaiChunks } from '@fudiao/llm/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { fsDeps, type TestDeps } from '../testing/fs-deps';
import { STALE_DURING_REASON, STALE_REASON } from './candidates';
import { createAppService } from './service';
import type { EditorSelection } from './writing-context';

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

const NONE = { include: [], exclude: [] };

async function setup(texts: string[]) {
  const deps = fsDeps();
  all.push(deps);
  const app = createAppService(deps);
  value(await app.loadLibrary());
  value(await app.createWork('雨夜'));
  const chapterId = value(await app.createChapter('第一章')).chapters[0]?.id ?? '';
  const content = value(await app.openChapter(chapterId));
  value(await app.saveChapter(chapterId, content.saved, texts.map((text, i) => ({ id: `p${i}`, text, source: 'handwritten' as const })), { splits: [], merges: [] }));
  const [p] = value(await app.saveProvider(null, { kind: 'openai_compatible', name: 'S', baseUrl: 'https://s.example.test/v1', authMethod: 'api_key', apiKey: 'sk' })).providers;
  value(await app.addModel(p?.id ?? '', 'm'));
  const generate = async (operation: 'rewrite' | 'continue', selection: EditorSelection | null, text: string) => {
    deps.llmResponses.push({ chunks: openaiChunks('m', { text: [text], end: 'stop' }) });
    const done = value(await app.runSelectionOperation({ chapterId, selection, operation, instruction: '', overrides: NONE }));
    if (done.candidate === null) throw new Error('没有候选稿');
    return done.candidate;
  };
  return { deps, app, chapterId, generate };
}

const sel = (paragraphId: string, from: number, to: number): EditorSelection => ({ from: { paragraphId, offset: from }, to: { paragraphId, offset: to } });

describe('候选稿', () => {
  it('候选稿与写手写入的正文一样规范标点（B74）：半角的逗号句号、直引号与省略号换成中文的写法', async () => {
    const { generate } = await setup(['雨下得更紧了。', '他推开门。']);
    const candidate = await generate('rewrite', sel('p1', 0, 4), '他推开门,说:"走吧..."');
    expect(candidate).toMatchObject({ generated: '他推开门，说：“走吧……”', content: '他推开门，说：“走吧……”' });
  });

  it('改写的结果存为候选稿；接受后替换原文、记录来源、建立快照、关联生成它的调用', async () => {
    const { app, chapterId, generate } = await setup(['雨下得更紧了。', '他推开门。']);
    const candidate = await generate('rewrite', sel('p1', 1, 3), '轻轻推开了\n');
    expect(candidate).toMatchObject({ status: 'pending', baseText: '推开', generated: '轻轻推开了', content: '轻轻推开了', baseVersions: { p1: 1 } });
    expect(candidate.llmCallId).toBe(value(await app.usage()).recent[0]?.id);
    expect(value(await app.listCandidates(chapterId)).map((c) => c.id)).toEqual([candidate.id]);

    const accepted = value(await app.acceptCandidate(candidate.id));
    expect(accepted.candidate.status).toBe('accepted');
    expect(accepted.paragraphs.map((p) => [p.text, p.source])).toEqual([
      ['雨下得更紧了。', 'handwritten'],
      ['他轻轻推开了门。', 'mixed'],
    ]);
    expect(value(await app.listSnapshots(chapterId))[0]?.reason).toBe('accept_candidate');
    expect(value(await app.listCandidates(chapterId))).toEqual([]);
    // 正文已写入库：再打开本章读到新文字；AI 参与字数按插入的文字计。
    expect(value(await app.openChapter(chapterId)).saved[1]?.text).toBe('他轻轻推开了门。');
    expect(value(await app.sourceStats()).total.aiWords).toBe(5);
  });

  it('在段末续写：另起新段落，记为 AI 生成并保存生成原文', async () => {
    const { app, generate } = await setup(['他推开门。']);
    const candidate = await generate('continue', sel('p0', 5, 5), '屋里很暗。\n他点亮了灯。');
    const { paragraphs } = value(await app.acceptCandidate(candidate.id));
    expect(paragraphs.map((p) => [p.text, p.source, p.aiOriginText])).toEqual([
      ['他推开门。', 'handwritten', null],
      ['屋里很暗。', 'ai_generated', '屋里很暗。'],
      ['他点亮了灯。', 'ai_generated', '他点亮了灯。'],
    ]);
  });

  it('作者修改候选稿后接受：只有与生成原文对得上的文字算 AI 文字', async () => {
    const { app, generate } = await setup(['他推开门。']);
    const candidate = await generate('continue', sel('p0', 5, 5), '屋里很暗，什么也看不见。');
    const edited = value(await app.editCandidate(candidate, '屋里很暗，他只听见雨声。'));
    const { paragraphs } = value(await app.acceptCandidate(edited.id));
    expect(paragraphs[1]).toMatchObject({ text: '屋里很暗，他只听见雨声。', source: 'mixed', spans: [{ start: 0, end: 5 }] });
  });

  it('原文在生成之后被改过：候选稿过期，正文不变', async () => {
    const { app, chapterId, generate } = await setup(['他推开门。']);
    const candidate = await generate('rewrite', sel('p0', 1, 3), '轻轻推开');
    const content = value(await app.openChapter(chapterId));
    value(await app.saveChapter(chapterId, content.saved, [{ id: 'p0', text: '他关上门。', source: 'handwritten' }], { splits: [], merges: [] }));
    expect(await app.acceptCandidate(candidate.id)).toEqual({ ok: false, error: { code: 'settings', detail: `候选稿已过期：${STALE_REASON}，请重新生成` } });
    expect(value(await app.openChapter(chapterId)).saved[0]?.text).toBe('他关上门。');
    expect(value(await app.listCandidates(chapterId))).toEqual([]);
    expect(await app.acceptCandidate(candidate.id)).toMatchObject({ ok: false, error: { detail: '这份候选稿已经处理过了' } });
  });

  it('放弃候选稿：正文不变，不再列出', async () => {
    const { app, chapterId, generate } = await setup(['他推开门。']);
    const candidate = await generate('rewrite', sel('p0', 1, 3), '轻轻推开');
    expect(value(await app.discardCandidate(candidate)).status).toBe('discarded');
    expect(value(await app.listCandidates(chapterId))).toEqual([]);
    expect(value(await app.openChapter(chapterId)).saved[0]?.text).toBe('他推开门。');
  });

  it('取消的生成不存为候选稿', async () => {
    const { deps, app, chapterId } = await setup(['他推开门。']);
    deps.llmResponses.push({ chunks: openaiChunks('m', { text: ['屋里'], end: 'stop' }, { stopAfterText: true }), hang: true });
    const abort = new AbortController();
    const done = value(
      await app.runSelectionOperation(
        { chapterId, selection: null, operation: 'continue', instruction: '', overrides: NONE },
        { signal: abort.signal, onEvent: (e) => (e.type === 'text' ? abort.abort() : undefined) },
      ),
    );
    expect(done.result.outcome).toBe('cancelled');
    expect(done.candidate).toBeNull();
    expect(value(await app.listCandidates(chapterId))).toEqual([]);
  });
});

describe('生成期间原文被改过（审查后的修正，2026-10-29）', () => {
  it('候选稿的依据是发起调用时的原文与版本；模型返回后即标为过期，不能接受，作者的修改保留', async () => {
    const { deps, app, chapterId } = await setup(['他推开门。']);
    // 模型生成期间作者把“推开”改成“关上”。
    deps.beforeLlm.push(async () => {
      const content = value(await app.openChapter(chapterId));
      value(await app.saveChapter(chapterId, content.saved, [{ id: 'p0', text: '他关上门。', source: 'handwritten' }], { splits: [], merges: [] }));
    });
    deps.llmResponses.push({ chunks: openaiChunks('m', { text: ['轻轻推开'], end: 'stop' }) });
    const done = value(await app.runSelectionOperation({ chapterId, selection: sel('p0', 1, 3), operation: 'rewrite', instruction: '', overrides: NONE }));
    expect(done.candidate).toMatchObject({ baseText: '推开', baseVersions: { p0: 1 }, generated: '轻轻推开', status: 'stale', statusReason: STALE_DURING_REASON });
    expect(await app.acceptCandidate(done.candidate?.id ?? '')).toMatchObject({ ok: false, error: { detail: '这份候选稿已经处理过了' } });
    expect(value(await app.openChapter(chapterId)).saved[0]?.text).toBe('他关上门。');
    expect(value(await app.listCandidates(chapterId))).toEqual([]);
  });
});
