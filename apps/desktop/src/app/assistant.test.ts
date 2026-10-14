import { rmSync } from 'node:fs';
import type { AssistantTurnOutput } from '@fudiao/prompts';
import { afterEach, describe, expect, it } from 'vitest';
import { fsDeps, type TestDeps } from '../testing/fs-deps';
import { addTestedModel, reply } from '../testing/models';
import type { AssistantEffect, AssistantItem } from './assistant';
import { MAX_ASSISTANT_STEPS } from './assistant';
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

async function setup(work: string | null = '当铺夜谈') {
  const deps = fsDeps();
  all.push(deps);
  const app = createAppService(deps);
  value(await app.loadLibrary());
  if (work !== null) value(await app.createWork(work));
  await addTestedModel(app, deps);
  deps.llmRequests.length = 0;
  return { deps, app };
}

/** 排一步模型输出。 */
const step = (deps: TestDeps, output: AssistantTurnOutput) => deps.llmResponses.push(reply(JSON.stringify(output)));
const body = (deps: TestDeps, i: number) => JSON.stringify(deps.llmRequests[i]?.body ?? {});
const roles = (items: readonly AssistantItem[]) => items.map((i) => i.role);

describe('AI 助手（B69）', () => {
  it('没有打开作品时开一本新书：新建作品、卷、章节与人物卡片；这一轮对话存进新作品，界面收到“作品换了”', async () => {
    const { deps, app } = await setup(null);
    step(deps, { message: '先建书。', actions: [{ tool: 'create_work', title: '江湖狂想', genre: '武侠', synopsis: '少年寻父。', outline: null }], done: false });
    step(deps, {
      message: '书已建好，还建了第一卷、第一章与主角。',
      actions: [
        { tool: 'create_volume', title: '第一卷 出山', summary: '少年下山', after: null },
        { tool: 'create_chapter', title: '第一章 下山', volume: '第一卷 出山', after: null },
        { tool: 'create_entity', kind: 'character', name: '沈砚', description: '十七岁，寻父', aliases: ['阿砚'] },
      ],
      done: true,
    });
    const effects: AssistantEffect[] = [];
    const outcome = value(await app.sendToAssistant('帮我开一本武侠小说，叫江湖狂想', { onEffect: (e) => effects.push(e) }));
    expect(outcome.pending).toBe(false);
    expect(effects.some((e) => e.kind === 'work_opened')).toBe(true);

    const work = value(await app.reloadWork());
    expect(work.project).toMatchObject({ title: '江湖狂想', genre: '武侠', synopsis: '少年寻父。' });
    expect(work.volumes).toMatchObject([{ title: '第一卷 出山', summary: '少年下山' }]);
    expect(work.chapters.map((c) => [c.title, c.volumeId])).toEqual([['第一章 下山', work.volumes[0]!.id]]);
    expect(value(await app.listEntities())).toMatchObject([{ kind: 'character', name: '沈砚', description: '十七岁，寻父', aliases: ['阿砚'] }]);

    // 这一轮存进了新作品：作者的话、两步输出与两次结果。
    const items = value(await app.assistantItems());
    expect(roles(items)).toEqual(['user', 'assistant', 'results', 'assistant', 'results']);
    expect(items[2]).toMatchObject({ results: [{ tool: 'create_work', ok: true }] });
    // 第一步时还没有作品；第二步给模型的现状里已经是新作品。
    expect(body(deps, 0)).toContain('还没有打开作品');
    expect(body(deps, 1)).toContain('打开的作品：《江湖狂想》（武侠）');
  });

  it('删除类动作先停下请作者确认；确认后执行并接着走，拒绝时不执行', async () => {
    const { deps, app } = await setup();
    value(await app.createEntity('character', '钱四'));
    value(await app.createEntity('character', '路人'));
    step(deps, { message: '要删掉钱四，请确认。', actions: [{ tool: 'delete_entity', entity: '钱四' }], done: false });
    const paused = value(await app.sendToAssistant('把钱四删了'));
    expect(paused.pending).toBe(true);
    expect(paused.items.at(-1)).toMatchObject({ role: 'pending', summary: '删除设定“钱四”' });
    expect(value(await app.listEntities()).map((e) => e.name)).toContain('钱四');

    step(deps, { message: '已删除钱四。', actions: [], done: true });
    const approved = value(await app.resolveAssistantPending(true));
    expect(approved.items.find((i) => i.role === 'results')).toMatchObject({ results: [{ tool: 'delete_entity', ok: true, detail: expect.stringContaining('作者确认后执行') }] });
    expect(value(await app.listEntities()).map((e) => e.name)).toEqual(['路人']);

    step(deps, { message: '要删掉路人。', actions: [{ tool: 'delete_entity', entity: '路人' }], done: false });
    value(await app.sendToAssistant('路人也删了'));
    step(deps, { message: '好的，不删。', actions: [], done: true });
    const rejected = value(await app.resolveAssistantPending(false));
    expect(rejected.items.at(-2)).toMatchObject({ role: 'results', results: [{ tool: 'delete_entity', ok: false, detail: expect.stringContaining('作者没有同意') }] });
    expect(value(await app.listEntities()).map((e) => e.name)).toEqual(['路人']);
    expect(await app.resolveAssistantPending(true)).toMatchObject({ ok: false });
  });

  it('读取的结果给下一步；动作失败（找不到、锁定设定）时把原因告诉模型并再走一步', async () => {
    const { deps, app } = await setup();
    const chapter = value(await app.createChapter('第一章 夜叩')).chapters[0]!;
    const opened = value(await app.openChapter(chapter.id));
    value(await app.saveChapter(chapter.id, opened.saved, [{ id: 'p0', text: '门在他身后合上了。', source: 'handwritten' }], { splits: [], merges: [] }));
    const lin = value(await app.createEntity('character', '林舟')).created;
    value(await app.setEntityLocked(lin, true));
    step(deps, {
      message: '',
      actions: [
        { tool: 'read_chapter', chapter: '夜叩' },
        { tool: 'update_entity', entity: '林舟', name: null, description: '改一改', aliases: null },
        { tool: 'read_chapter', chapter: '第九章' },
      ],
      done: true,
    });
    step(deps, { message: '第一章只有一句；林舟是锁定设定，没有改。', actions: [], done: true });
    const outcome = value(await app.sendToAssistant('看看第一章，顺便改一下林舟'));
    const results = outcome.items.find((i) => i.role === 'results');
    expect(results).toMatchObject({
      results: [
        { tool: 'read_chapter', ok: true, detail: expect.stringContaining('门在他身后合上了。') },
        { tool: 'update_entity', ok: false, detail: expect.stringContaining('锁定设定') },
        { tool: 'read_chapter', ok: false, detail: expect.stringContaining('找不到章节“第九章”') },
      ],
    });
    // 有动作失败：虽然说办完了，仍再走一步。
    expect(deps.llmRequests).toHaveLength(2);
    expect(body(deps, 1)).toContain('门在他身后合上了。');
  });

  it('系统提示与之前的对话在前、现状在最后；对话跨请求保留，可以清空', async () => {
    const { deps, app } = await setup();
    step(deps, { message: '你好，这部作品还没有章节。', actions: [], done: true });
    value(await app.sendToAssistant('现在写到哪了'));
    step(deps, { message: '好。', actions: [{ tool: 'create_chapter', title: '第一章', volume: null, after: null }], done: true });
    value(await app.sendToAssistant('建第一章'));
    const second = deps.llmRequests[1]!.body as { messages: { role: string; content: string }[] };
    expect(second.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(second.messages[0]?.content).toContain('- create_chapter：');
    expect(second.messages[1]?.content).toBe('【作者】现在写到哪了');
    expect(second.messages[3]?.content).toContain('打开的作品：《当铺夜谈》');
    expect(second.messages[3]?.content).toContain('【作者】建第一章');
    expect(roles(value(await app.assistantItems()))).toEqual(['user', 'assistant', 'user', 'assistant', 'results']);
    value(await app.clearAssistant());
    expect(value(await app.assistantItems())).toEqual([]);
  });

  it('一句话最多走固定的步数，不会无休止地调用', async () => {
    const { deps, app } = await setup();
    for (let i = 0; i < MAX_ASSISTANT_STEPS + 2; i++) step(deps, { message: '', actions: [{ tool: 'list_chapters', volume: null }], done: false });
    value(await app.sendToAssistant('一直列章节'));
    expect(deps.llmRequests).toHaveLength(MAX_ASSISTANT_STEPS);
  });

  it('章节计划、移动章节与打开页面：计划写入、章节进卷、界面收到打开的请求', async () => {
    const { deps, app } = await setup();
    value(await app.createEntity('character', '林舟'));
    value(await app.createVolume('第一卷'));
    value(await app.createChapter('楔子'));
    step(deps, {
      message: '已安排。',
      actions: [
        { tool: 'save_chapter_plan', chapter: '楔子', goal: '林舟登场', beats: ['叩门', '压价'], cast: ['林舟', '无名氏'], targetWords: 2000 },
        { tool: 'move_chapter', chapter: '楔子', volume: '第一卷', after: null },
        { tool: 'open_page', page: 'planning' },
      ],
      done: true,
    });
    const effects: AssistantEffect[] = [];
    const outcome = value(await app.sendToAssistant('给楔子做个计划，放进第一卷，然后打开计划页', { onEffect: (e) => effects.push(e) }));
    expect(outcome.items.at(-1)).toMatchObject({ role: 'results', results: [{ ok: true, detail: expect.stringContaining('无名氏') }, { ok: true }, { ok: true }] });
    const plan = value(await app.planningView()).chapters[0]!.plan;
    expect(plan).toMatchObject({ goal: '林舟登场', beats: ['叩门', '压价'], targetWords: 2000 });
    expect(plan?.castIds).toHaveLength(1);
    expect(value(await app.reloadWork()).chapters[0]?.volumeId).toBe(value(await app.reloadWork()).volumes[0]?.id);
    expect(effects).toContainEqual({ kind: 'open_page', page: 'planning' });
  });
});
