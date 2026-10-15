import { rmSync } from 'node:fs';
import type { ChapterMemoryOutput } from '@fudiao/prompts';
import { afterEach, describe, expect, it } from 'vitest';
import { fsDeps, type TestDeps } from '../testing/fs-deps';
import { addTestedModel, reply } from '../testing/models';
import { createAppService } from './service';

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

const output: ChapterMemoryOutput = {
  summary: ' 林舟深夜到当铺当玉，钱四压价，林舟没有当成，带着玉离开。 ',
  cast: [
    { name: '林相公', state: '玉还在手里，三天后赌债到期' },
    { name: '钱四', state: '' },
    { name: '阿青', state: '在巷口望风' },
  ],
  foreshadows: [
    { title: '玉佩的来历', progress: '钱四盯着玉佩的缺口看了很久' },
    { title: '没有这条伏笔', progress: '不该记下' },
  ],
  openThreads: [' 林舟答应三天后再来 ', '', '钱四要人去打听玉的来历'],
};

/** 两章：第一章有正文与作者写的梗概；第二章有计划，回收“玉佩的来历”。 */
async function setup() {
  const deps = fsDeps();
  all.push(deps);
  const app = createAppService(deps);
  value(await app.loadLibrary());
  value(await app.createWork('当铺夜谈'));
  const c1 = value(await app.createChapter('第一章 夜叩')).chapters[0]!;
  const c2 = value(await app.createChapter('第二章 夜雨', c1.id)).chapters[1]!;
  value(await app.updateChapterNotes(c1, { summary: '作者写的梗概。', notes: '' }));
  const first = value(await app.openChapter(c1.id));
  value(await app.saveChapter(c1.id, first.saved, [{ id: 'p0', text: '林舟叩响了当铺的门。', source: 'handwritten' }], { splits: [], merges: [] }));
  const lin = value(await app.createEntity('character', '林舟')).created;
  value(await app.updateEntity(lin, { aliases: ['林相公'] }));
  const qian = value(await app.createEntity('character', '钱四')).created;
  const jade = value(await app.addForeshadow({ title: '玉佩的来历', content: '钱四多看了玉佩一眼', reveal: '玉佩是林舟父亲的遗物', plantChapterId: c1.id, plantAnchor: null, payoffChapterId: c2.id, payoffAnchor: null, status: 'planted' })).foreshadows[0]!;
  value(await app.savePlan(c2.id, { goal: '真相揭晓', castIds: [lin.id], beats: ['对质'], foreshadowPlant: [], foreshadowPayoff: [jade.id], treatment: '', targetWords: 1500 }));
  await addTestedModel(app, deps);
  deps.llmRequests.length = 0;
  return { deps, app, c1: c1.id, c2: c2.id, lin: lin.id, qian: qian.id, jade: jade.id };
}

const bodyText = (deps: TestDeps, index: number) => JSON.stringify(deps.llmRequests[index]?.body ?? {});

describe('长篇记忆（B66）', () => {
  it('由一章的正文生成：梗概、人物状态与伏笔进展按名字对应到设定与账本，记录依据的段落版本与调用记录', async () => {
    const { deps, app, c1, lin, jade } = await setup();
    deps.llmResponses.push(reply(JSON.stringify(output)));
    const memory = value(await app.buildMemory(c1));
    const paragraph = value(await app.openChapter(c1)).saved[0]!;
    expect(memory).toMatchObject({
      chapterId: c1,
      summary: '林舟深夜到当铺当玉，钱四压价，林舟没有当成，带着玉离开。',
      // 别名对应到人物；状态为空的、设定里没有的人物不记。
      castState: { [lin]: '玉还在手里，三天后赌债到期' },
      foreshadowProgress: { [jade]: '钱四盯着玉佩的缺口看了很久' },
      basedOn: { [paragraph.id]: paragraph.version },
      status: 'valid',
      // 章尾留给后面的事（B74）：去掉空白与空的条目。
      openThreads: ['林舟答应三天后再来', '钱四要人去打听玉的来历'],
    });
    expect(Object.keys(memory.castState)).toEqual([lin]);
    expect(Object.keys(memory.foreshadowProgress)).toEqual([jade]);
    expect(memory.llmCallId).not.toBeNull();
    const request = bodyText(deps, 0);
    for (const part of ['林舟叩响了当铺的门。', '人物：林舟；钱四；', '玉佩的来历：钱四多看了玉佩一眼']) expect(request).toContain(part);

    const view = value(await app.planningView());
    expect(view.chapters.map((c) => [c.hasText, c.memory?.status ?? null])).toEqual([
      [true, 'valid'],
      [false, null],
    ]);
  });

  it('没有正文的章节不生成，也不调用模型', async () => {
    const { deps, app, c2 } = await setup();
    expect(await app.buildMemory(c2)).toMatchObject({ ok: false, error: { code: 'settings', detail: expect.stringContaining('还没有正文') } });
    expect(deps.llmRequests).toHaveLength(0);
  });

  it('模型没有写出梗概时不保存', async () => {
    const { deps, app, c1 } = await setup();
    deps.llmResponses.push(reply(JSON.stringify({ summary: ' ', cast: [], foreshadows: [] })));
    expect(await app.buildMemory(c1)).toMatchObject({ ok: false, error: { code: 'settings' } });
    expect(value(await app.planningView()).chapters[0]?.memory).toBeNull();
  });

  it('正文修改后记忆标为待复核；重建后回到有效，依据换成新的段落版本', async () => {
    const { deps, app, c1 } = await setup();
    deps.llmResponses.push(reply(JSON.stringify(output)));
    value(await app.buildMemory(c1));
    const content = value(await app.openChapter(c1));
    value(await app.saveChapter(c1, content.saved, [{ id: content.saved[0]!.id, text: '林舟叩响了当铺的门，没有人应。', source: 'handwritten' }], { splits: [], merges: [] }));
    const stale = value(await app.planningView()).chapters[0]?.memory;
    expect(stale).toMatchObject({ status: 'stale', summary: '林舟深夜到当铺当玉，钱四压价，林舟没有当成，带着玉离开。' });

    deps.llmResponses.push(reply(JSON.stringify({ summary: '林舟叩门，无人应答。', cast: [], foreshadows: [] })));
    const rebuilt = value(await app.buildMemory(c1));
    const paragraph = value(await app.openChapter(c1)).saved[0]!;
    expect(rebuilt).toMatchObject({ status: 'valid', summary: '林舟叩门，无人应答。', castState: {}, basedOn: { [paragraph.id]: paragraph.version } });
    expect(value(await app.planningView()).chapters[0]?.memory?.status).toBe('valid');
  });

  it('写手写后面的章节时用前面章节的记忆：梗概代替作者写的章节梗概，带上人物最近的状态与要回收伏笔的进展', async () => {
    const { deps, app, c1, c2 } = await setup();
    deps.llmResponses.push(reply(JSON.stringify(output)));
    value(await app.buildMemory(c1));
    deps.llmRequests.length = 0;
    deps.llmResponses.push(reply('林舟把玉放在柜台上。'));
    expect(value(await app.writeChapter(c2))).toMatchObject({ status: 'written' });
    const request = bodyText(deps, 0);
    for (const part of [
      '第一章 夜叩：林舟深夜到当铺当玉，钱四压价，林舟没有当成，带着玉离开。',
      '林舟（最近的状态：玉还在手里，三天后赌债到期）',
      '前文中的进展：第一章 夜叩：钱四盯着玉佩的缺口看了很久；',
      // 请求体是 JSON：换行写作 \n。
      '上一章结尾留下的事（本章要接住，不一定都在本章了结，但不能当作没发生）：\\n- 林舟答应三天后再来\\n- 钱四要人去打听玉的来历',
    ]) {
      expect(request).toContain(part);
    }
    expect(request).not.toContain('作者写的梗概。');
  });

  it('正文清空后留下的记忆不再给写手：改用作者写的章节梗概', async () => {
    const { deps, app, c1, c2 } = await setup();
    deps.llmResponses.push(reply(JSON.stringify(output)));
    value(await app.buildMemory(c1));
    const content = value(await app.openChapter(c1));
    value(await app.saveChapter(c1, content.saved, [{ id: content.saved[0]!.id, text: '', source: 'handwritten' }], { splits: [], merges: [] }));
    expect(value(await app.planningView()).chapters[0]).toMatchObject({ hasText: false, memory: { status: 'stale' } });
    deps.llmRequests.length = 0;
    deps.llmResponses.push(reply('林舟把玉放在柜台上。'));
    value(await app.writeChapter(c2));
    const request = bodyText(deps, 0);
    expect(request).toContain('第一章 夜叩：作者写的梗概。');
    expect(request).not.toContain('林舟深夜到当铺当玉');
    expect(request).not.toContain('最近的状态');
  });
});
