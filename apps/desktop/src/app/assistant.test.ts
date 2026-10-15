import { rmSync } from 'node:fs';
import { openaiChunks } from '@fudiao/llm/testing';
import type { AssistantTurnOutput } from '@fudiao/prompts';
import { afterEach, describe, expect, it } from 'vitest';
import { fsDeps, type TestDeps } from '../testing/fs-deps';
import { addTestedModel, reply } from '../testing/models';
import type { AssistantEffect, AssistantItem, AssistantSelection } from './assistant';
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
/** 动作结果（最后一条 results）。 */
const lastResults = (items: readonly AssistantItem[]) => items.filter((i): i is Extract<AssistantItem, { role: 'results' }> => i.role === 'results').at(-1);

/** 一章，带一段正文。 */
async function chapterWith(app: Awaited<ReturnType<typeof setup>>['app'], title: string, text: string) {
  const chapter = value(await app.createChapter(title)).chapters.find((c) => c.title === title)!;
  const opened = value(await app.openChapter(chapter.id));
  value(await app.saveChapter(chapter.id, opened.saved, [{ id: 'p0', text, source: 'handwritten' }], { splits: [], merges: [] }));
  return chapter.id;
}

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
    expect(paused.items.at(-1)).toMatchObject({ role: 'pending', summary: '删除设定“钱四”（与它有关的人物关系也一并删除）' });
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

  it('模型流式输出时逐字交出给作者的话（只用于显示）；这一步结束后为 null', async () => {
    const { deps, app } = await setup();
    const text = JSON.stringify({ message: '好的，“第一章”已经建好。', actions: [], done: true });
    const cut = [0, 14, 20, 26, text.length];
    deps.llmResponses.push({ chunks: openaiChunks('m', { text: cut.slice(1).map((end, i) => text.slice(cut[i], end)), end: 'stop', usage: { input: 1_000, output: 50, cacheRead: 0 } }) });
    const drafts: (string | null)[] = [];
    value(await app.sendToAssistant('建第一章', { onDraft: (d) => drafts.push(d) }));
    expect(drafts.at(-1)).toBeNull();
    const shown = drafts.filter((d): d is string => d !== null);
    expect(shown.length).toBeGreaterThan(1);
    for (const d of shown) expect('好的，“第一章”已经建好。'.startsWith(d)).toBe(true);
    expect(shown.at(-1)).toBe('好的，“第一章”已经建好。');
  });

  it('作者选中的文字写进现状；edit_selection 把它改成候选稿并在章节旁打开；没有选中时不能用', async () => {
    const { deps, app } = await setup();
    const chapterId = await chapterWith(app, '第一章 夜叩', '门在他身后合上了。雨很大。');
    const selection: AssistantSelection = { chapterId, range: { from: { paragraphId: 'p0', offset: 0 }, to: { paragraphId: 'p0', offset: 9 } }, text: '门在他身后合上了。' };
    step(deps, { message: '润色好了。', actions: [{ tool: 'edit_selection', operation: 'polish', instruction: '更轻一些' }], done: true });
    deps.llmResponses.push(reply('门在他身后轻轻合上。'));
    const effects: AssistantEffect[] = [];
    const outcome = value(await app.sendToAssistant('把这段润色一下', { selection, onEffect: (e) => effects.push(e) }));
    expect(body(deps, 0)).toContain('作者选中的文字（在《第一章 夜叩》中，共 9 字）');
    expect(body(deps, 0)).toContain('「门在他身后合上了。」');
    expect(body(deps, 1)).toContain('更轻一些');
    expect(lastResults(outcome.items)).toMatchObject({ results: [{ tool: 'edit_selection', ok: true, detail: expect.stringContaining('润色') }] });
    expect(effects).toContainEqual({ kind: 'show_candidates', chapterId });
    const candidates = value(await app.listCandidates(chapterId));
    expect(candidates).toMatchObject([{ status: 'pending', generated: '门在他身后轻轻合上。', baseText: '门在他身后合上了。' }]);
    // 正文没有变：候选稿要作者接受。
    expect(value(await app.openChapter(chapterId)).saved.map((p) => p.text)).toEqual(['门在他身后合上了。雨很大。']);

    step(deps, { message: '', actions: [{ tool: 'edit_selection', operation: 'expand', instruction: null }], done: true });
    step(deps, { message: '请先选中要改的文字。', actions: [], done: true });
    const without = value(await app.sendToAssistant('扩写一下'));
    expect(lastResults(without.items)).toMatchObject({ results: [{ tool: 'edit_selection', ok: false, detail: expect.stringContaining('没有在正文里选中文字') }] });
    expect(body(deps, 2)).not.toContain('作者选中的文字（在');
  });

  it('审核一章：结果里概括问题并在章节旁打开审核；没有问题时也说明', async () => {
    const { deps, app } = await setup();
    const chapterId = await chapterWith(app, '第一章 夜叩', '林舟推门进来，雨水顺着衣角往下滴。');
    step(deps, { message: '', actions: [{ tool: 'review_chapter', chapter: '夜叩' }], done: true });
    deps.llmResponses.push(
      reply(JSON.stringify({ issues: [{ paragraph: 'P1', quote: '雨水顺着衣角往下滴', kind: 'pacing', severity: 'medium', evidence: [], description: '开头的动作描写太长', suggestion: '压缩成一句' }] })),
    );
    const effects: AssistantEffect[] = [];
    const notes: (string | null)[] = [];
    const outcome = value(await app.sendToAssistant('审核第一章', { onEffect: (e) => effects.push(e), onProgress: (n) => notes.push(n) }));
    const detail = lastResults(outcome.items)?.results[0]?.detail ?? '';
    expect(detail).toMatch(/^审核完《第一章 夜叩》/);
    expect(effects).toContainEqual({ kind: 'show_review', chapterId });
    expect(notes).toEqual(['正在审核《第一章 夜叩》', null]);
    expect(detail).toContain('- 一般：开头的动作描写太长（建议：压缩成一句）');
    expect(value(await app.reviewIssues(chapterId))).toContainEqual(expect.objectContaining({ description: '开头的动作描写太长', source: 'model' }));
  });

  it('写手写章时报告进度；回退写手写入要作者确认，确认后正文回到写入之前', async () => {
    const { deps, app } = await setup();
    const chapterId = await chapterWith(app, '第一章 夜叩', '门在他身后合上了。');
    const lin = value(await app.createEntity('character', '林舟')).created;
    value(await app.savePlan(chapterId, { goal: '林舟当玉', castIds: [lin.id], beats: ['叩门', '压价'], foreshadowPlant: [], foreshadowPayoff: [], treatment: '', targetWords: 3000 }));
    step(deps, { message: '让写手写。', actions: [{ tool: 'write_chapter', chapter: '第一章 夜叩' }], done: true });
    deps.llmResponses.push(reply('林舟又叩响了门。'), reply('钱四压低了价。'));
    const notes: (string | null)[] = [];
    const effects: AssistantEffect[] = [];
    const written = value(await app.sendToAssistant('写第一章', { onProgress: (n) => notes.push(n), onEffect: (e) => effects.push(e) }));
    expect(lastResults(written.items)).toMatchObject({ results: [{ tool: 'write_chapter', ok: true }] });
    expect(notes).toEqual(['写手正在写《第一章 夜叩》', '写手正在写《第一章 夜叩》：已写 1/2 段', '写手正在写《第一章 夜叩》：已写 2/2 段', null]);
    expect(effects.filter((e) => e.kind === 'chapter_changed')).toHaveLength(2);
    expect(value(await app.openChapter(chapterId)).saved.map((p) => p.text)).toEqual(['门在他身后合上了。', '林舟又叩响了门。', '钱四压低了价。']);

    step(deps, { message: '要回退，请确认。', actions: [{ tool: 'rollback_writer', chapter: '第一章 夜叩' }], done: false });
    const paused = value(await app.sendToAssistant('不满意，回退'));
    expect(paused.pending).toBe(true);
    expect(paused.items.at(-1)).toMatchObject({ role: 'pending', summary: '把“第一章 夜叩”回退到写手写入之前（现稿会先存为快照）' });
    expect(value(await app.openChapter(chapterId)).saved).toHaveLength(3);
    step(deps, { message: '已回退。', actions: [], done: true });
    const approved = value(await app.resolveAssistantPending(true));
    expect(lastResults(approved.items)).toMatchObject({ results: [{ tool: 'rollback_writer', ok: true }] });
    expect(value(await app.openChapter(chapterId)).saved.map((p) => p.text)).toEqual(['门在他身后合上了。']);
  });

  it('伏笔、快照、从回收站恢复与导出：回收站写进现状，各动作经现有的用例完成', async () => {
    const { deps, app } = await setup();
    const chapterId = await chapterWith(app, '第一章 夜叩', '门在他身后合上了。');
    const scrap = value(await app.createChapter('废稿')).chapters.find((c) => c.title === '废稿')!;
    value(await app.trashChapter(scrap));
    step(deps, {
      message: '都办好了。',
      actions: [
        { tool: 'add_foreshadow', title: '玉佩', content: '掌柜多看了玉佩一眼', reveal: '玉佩是父亲的遗物', plant: '夜叩', payoff: null },
        { tool: 'save_snapshot', chapter: '第一章 夜叩' },
        { tool: 'restore_chapter', chapter: '废稿' },
        { tool: 'export_book', format: 'markdown', chapter: null },
      ],
      done: true,
    });
    const outcome = value(await app.sendToAssistant('记个伏笔，存个快照，把废稿找回来，再导出整本'));
    expect(body(deps, 0)).toContain(`回收站：[${scrap.id}] 废稿；`);
    expect(lastResults(outcome.items)).toMatchObject({ results: [{ ok: true }, { ok: true }, { ok: true }, { ok: true, detail: '已导出。' }] });
    expect(value(await app.planningView()).foreshadows).toMatchObject([{ title: '玉佩', content: '掌柜多看了玉佩一眼', reveal: '玉佩是父亲的遗物', plantChapterId: chapterId, payoffChapterId: null, status: 'planned' }]);
    expect(value(await app.listSnapshots(chapterId))).toHaveLength(1);
    expect(value(await app.reloadWork()).chapters.map((c) => c.title)).toEqual(['第一章 夜叩', '废稿']);
    expect(deps.exported.map((e) => e.name)).toEqual(['当铺夜谈.md']);
    expect(deps.exported[0]?.content).toContain('门在他身后合上了。');
  });

  it('人物关系（B73）：建立、修改与删除（删除须确认）；现状里列出已有的关系与适用章节', async () => {
    const { deps, app } = await setup();
    const chapterId = await chapterWith(app, '第一章 夜叩', '门在他身后合上了。');
    value(await app.createEntity('character', '林舟'));
    value(await app.createEntity('character', '钱四'));
    step(deps, {
      message: '关系建好了。',
      actions: [
        { tool: 'add_relationship', from: '钱四', to: '林舟', category: 'enemy', label: '债主', mutual: false, description: '林舟欠他三百两', secret: true, validFrom: '夜叩', validTo: null },
        { tool: 'add_relationship', from: '林舟', to: '无名氏', category: 'ally', label: '朋友', mutual: true, description: null, secret: false, validFrom: null, validTo: null },
      ],
      done: true,
    });
    step(deps, { message: '无名氏还没有人物卡片。', actions: [], done: true });
    const added = value(await app.sendToAssistant('钱四是林舟的债主，林舟和无名氏是朋友'));
    expect(lastResults(added.items)).toMatchObject({
      results: [
        { tool: 'add_relationship', ok: true, detail: expect.stringContaining('钱四是林舟的债主') },
        { tool: 'add_relationship', ok: false, detail: expect.stringContaining('找不到设定“无名氏”') },
      ],
    });
    const relation = value(await app.relationsView()).relationships[0]!;
    expect(relation).toMatchObject({ category: 'enemy', label: '债主', secret: true, description: '林舟欠他三百两', validFromChapterId: chapterId });
    // 第二步给模型的现状里列出了这条关系。
    expect(body(deps, 1)).toContain(`[${relation.id}] 钱四是林舟的债主（敌对，隐秘，《第一章 夜叩》起）`);

    step(deps, { message: '', actions: [{ tool: 'update_relationship', relationship: relation.id, category: null, label: '旧债主', mutual: null, description: null, secret: false, validFrom: '不限', validTo: null }], done: true });
    value(await app.sendToAssistant('债已经还清了'));
    expect(value(await app.relationsView()).relationships[0]).toMatchObject({ label: '旧债主', secret: false, description: '林舟欠他三百两', validFromChapterId: null });

    step(deps, { message: '要删掉这条关系。', actions: [{ tool: 'delete_relationship', relationship: relation.id }], done: false });
    const paused = value(await app.sendToAssistant('删掉他们的关系'));
    expect(paused.items.at(-1)).toMatchObject({ role: 'pending', summary: '删除关系“钱四是林舟的旧债主”' });
    step(deps, { message: '删了。', actions: [], done: true });
    value(await app.resolveAssistantPending(true));
    expect(value(await app.relationsView()).relationships).toEqual([]);
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
