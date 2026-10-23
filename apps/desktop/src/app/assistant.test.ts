import { rmSync } from 'node:fs';
import { openaiChunks } from '@fudiao/llm/testing';
import type { AssistantTurnOutput } from '@fudiao/prompts';
import { afterEach, describe, expect, it } from 'vitest';
import { loadMigrations, openProjectDb } from '@fudiao/store/node';
import { fsDeps, type TestDeps } from '../testing/fs-deps';
import { addTestedModel, reply } from '../testing/models';
import type { AssistantEffect, AssistantItem, AssistantSelection, AssistantUsage } from './assistant';
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
async function chapterWith(app: Awaited<ReturnType<typeof setup>>['app'], title: string, text: string, paragraphId = 'p0') {
  const chapter = value(await app.createChapter(title)).chapters.find((c) => c.title === title)!;
  const opened = value(await app.openChapter(chapter.id));
  value(await app.saveChapter(chapter.id, opened.saved, [{ id: paragraphId, text, source: 'handwritten' }], { splits: [], merges: [] }));
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
    // 改动记录（changes）跟在动作后面：新建作品不在撤销范围（kept），卷、章节与人物记下改动前后。
    expect(roles(items)).toEqual(['user', 'assistant', 'changes', 'results', 'assistant', 'changes', 'changes', 'changes', 'results']);
    expect(items[2]).toMatchObject({ role: 'changes', tool: 'create_work', entries: [], kept: true });
    expect(items[3]).toMatchObject({ results: [{ tool: 'create_work', ok: true }] });
    // 第一步时还没有作品；第二步给模型的现状里已经是新作品。
    expect(body(deps, 0)).toContain('还没有打开作品');
    expect(body(deps, 1)).toContain('打开的作品：《江湖狂想》（武侠）');
  });

  it('作品建好之前的调用补记进新作品：用量与费用不漏算（M5-22）', async () => {
    const { deps, app } = await setup(null);
    deps.llmResponses.push(reply(JSON.stringify({ message: '想好书名了吗？', actions: [], done: true } satisfies AssistantTurnOutput), { input: 1_111, output: 11, cacheRead: 0 }));
    value(await app.sendToAssistant('我想写一本武侠小说'));
    step(deps, { message: '先建书。', actions: [{ tool: 'create_work', title: '江湖狂想', genre: '武侠', synopsis: '', outline: null }], done: false });
    step(deps, { message: '书已建好。', actions: [], done: true });
    value(await app.sendToAssistant('就叫江湖狂想'));

    const usage = value(await app.usage());
    // 三次调用：第一轮一次、第二轮建书之前一次（都在没有作品时），建书之后一次。
    expect(usage.recent.filter((c) => c.taskKind === 'assistant')).toHaveLength(3);
    expect(usage.recent.some((c) => c.usage?.input === 1_111)).toBe(true);
    // 补记过的不再重复记。
    step(deps, { message: '好的。', actions: [], done: true });
    value(await app.sendToAssistant('谢谢'));
    expect(value(await app.usage()).recent.filter((c) => c.taskKind === 'assistant')).toHaveLength(4);
  });

  it('一轮里两次换作品：作者的话与这一轮的对话都存进最后打开的作品，不丢', async () => {
    const { deps, app } = await setup(null);
    step(deps, {
      message: '建两本。',
      actions: [
        { tool: 'create_work', title: '甲书', genre: '', synopsis: '', outline: null },
        { tool: 'create_work', title: '乙书', genre: '', synopsis: '', outline: null },
      ],
      done: true,
    });
    value(await app.sendToAssistant('建两本书'));
    expect(value(await app.reloadWork()).project.title).toBe('乙书');
    const items = value(await app.assistantItems());
    expect(items[0]).toMatchObject({ role: 'user', text: '建两本书' });
    expect(roles(items)).toEqual(['user', 'assistant', 'changes', 'changes', 'results']);
  });

  it('生成章节计划期间作者新建的设定不算助手的改动：撤销这一轮只撤助手采用的计划，作者的设定留着', async () => {
    const { deps, app } = await setup();
    value(await app.updateWorkInfo({ outline: '林舟深夜当玉，掌柜起疑。' }));
    step(deps, { message: '生成计划。', actions: [{ tool: 'plan_chapters', count: 1, wordsPerChapter: null }], done: true });
    deps.llmResponses.push(
      reply(JSON.stringify({ chapters: [{ title: '第一章 夜叩', goal: '当玉', cast: [], beats: ['叩门'], plant: [], payoff: [], treatment: '', targetWords: 3000 }], foreshadows: [] })),
    );
    // 第二个请求（生成计划草稿）到达时，作者在设定页新建了一个人物。
    deps.beforeLlm.push(null, async () => {
      value(await app.createEntity('character', '作者新建的人'));
    });
    value(await app.sendToAssistant('按大纲生成一章的计划'));
    expect(value(await app.planningView()).chapters.some((c) => c.plan !== null)).toBe(true);
    value(await app.undoAssistantTurn());
    expect(value(await app.listEntities()).map((e) => e.name)).toEqual(['作者新建的人']);
    expect(value(await app.planningView()).chapters.every((c) => c.plan === null)).toBe(true);
  });

  it('对话存不进作品库时停下并说明，不当作没事接着调用模型', async () => {
    const { deps, app } = await setup();
    const other = openProjectDb(value(await app.reloadWork()).entry.path, { migrations: loadMigrations(), now: '2026-10-19T00:00:00.000Z' });
    if (!other.ok) throw new Error('open');
    value(await other.value.db.transaction([{ sql: "CREATE TRIGGER fail_append BEFORE INSERT ON assistant_message BEGIN SELECT RAISE(ABORT, '磁盘已满'); END" }]));
    other.value.db.close();
    step(deps, { message: '好。', actions: [], done: true });
    expect(await app.sendToAssistant('你好')).toMatchObject({ ok: false, error: { code: 'repo' } });
    expect(deps.llmRequests).toHaveLength(0);
  });

  it('思考深度与上下文用量：按作者选的深度发请求；每一步结束后报告发给模型的 Token 数与模型的上下文上限', async () => {
    const { deps, app } = await setup();
    const model = value(await app.loadModelServices()).models[0]!;
    value(await app.updateModel(model, { displayName: model.displayName, capabilities: { ...model.capabilities, reasoningControl: 'effort', contextWindow: 200_000, limitsKnown: { ...model.capabilities.limitsKnown, contextWindow: true } }, prices: model.prices }));
    deps.llmRequests.length = 0;
    const done: AssistantTurnOutput = { message: '好的。', actions: [], done: true };
    deps.llmResponses.push(reply(JSON.stringify(done), { input: 3_000, output: 200, cacheRead: 0 }));
    const usages: AssistantUsage[] = [];
    value(await app.sendToAssistant('你好', { effort: 'high', onUsage: (u) => usages.push(u) }));
    expect(body(deps, 0)).toContain('"reasoning_effort":"high"');
    expect(usages).toEqual([{ promptTokens: 3_000, contextWindow: 200_000 }]);
    // 没有指定时为 medium。
    deps.llmResponses.push(reply(JSON.stringify(done)));
    value(await app.sendToAssistant('再说一句'));
    expect(body(deps, 1)).toContain('"reasoning_effort":"medium"');
  });

  it('确认绑定在确认时找到的那一项：作者确认之前改了名、又新建了同名的设定，删掉的仍是确认的那一个', async () => {
    const { deps, app } = await setup();
    const qian = value(await app.createEntity('character', '钱四')).created;
    step(deps, { message: '要删掉钱四，请确认。', actions: [{ tool: 'delete_entity', entity: '钱' }], done: false });
    const asked = value(await app.sendToAssistant('删掉钱四'));
    expect(asked.items.at(-1)).toMatchObject({ role: 'pending', summary: expect.stringContaining('“钱四”') });
    value(await app.updateEntity(qian, { name: '钱老四' }));
    value(await app.createEntity('character', '钱五'));
    step(deps, { message: '删了。', actions: [], done: true });
    const done = value(await app.resolveAssistantPending(true));
    expect(lastResults(done.items)?.results[0]).toMatchObject({ tool: 'delete_entity', ok: true });
    expect(value(await app.listEntities()).map((e) => e.name)).toEqual(['钱五']);
  });

  it('删除类动作先停下请作者确认；确认后执行并接着执行同一步里排在后面的动作，拒绝时它们都不执行并如实告诉模型', async () => {
    const { deps, app } = await setup();
    value(await app.createEntity('character', '钱四'));
    value(await app.createEntity('character', '路人'));
    step(deps, {
      message: '要删掉钱四，请确认。',
      actions: [
        { tool: 'delete_entity', entity: '钱四' },
        { tool: 'create_chapter', title: '第二章', volume: null, after: null },
      ],
      done: false,
    });
    const paused = value(await app.sendToAssistant('把钱四删了'));
    expect(paused.pending).toBe(true);
    expect(paused.items.at(-1)).toMatchObject({ role: 'pending', summary: '删除设定“钱四”（与它有关的人物关系也一并删除）' });
    expect(value(await app.listEntities()).map((e) => e.name)).toContain('钱四');

    step(deps, { message: '已删除钱四。', actions: [], done: true });
    const approved = value(await app.resolveAssistantPending(true));
    expect(approved.items.find((i) => i.role === 'results')).toMatchObject({
      results: [
        { tool: 'delete_entity', ok: true, detail: expect.stringContaining('作者确认后执行') },
        { tool: 'create_chapter', ok: true },
      ],
    });
    expect(value(await app.listEntities()).map((e) => e.name)).toEqual(['路人']);
    expect(value(await app.reloadWork()).chapters.map((c) => c.title)).toEqual(['第二章']);

    step(deps, {
      message: '要删掉路人。',
      actions: [
        { tool: 'delete_entity', entity: '路人' },
        { tool: 'create_chapter', title: '第三章', volume: null, after: null },
      ],
      done: false,
    });
    value(await app.sendToAssistant('路人也删了'));
    step(deps, { message: '好的，不删。', actions: [], done: true });
    const rejected = value(await app.resolveAssistantPending(false));
    expect(rejected.items.at(-2)).toMatchObject({
      role: 'results',
      results: [
        { tool: 'delete_entity', ok: false, detail: expect.stringContaining('作者没有同意') },
        { tool: 'create_chapter', ok: false, detail: expect.stringContaining('没有执行') },
      ],
    });
    // 模型下一步看得到排在后面的动作没有执行。
    expect(body(deps, deps.llmRequests.length - 1)).toContain('create_chapter：没有执行。排在作者没有同意的动作后面');
    expect(value(await app.listEntities()).map((e) => e.name)).toEqual(['路人']);
    expect(value(await app.reloadWork()).chapters.map((c) => c.title)).toEqual(['第二章']);
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
    expect(roles(value(await app.assistantItems()))).toEqual(['user', 'assistant', 'user', 'assistant', 'changes', 'results']);
    value(await app.clearAssistant());
    expect(value(await app.assistantItems())).toEqual([]);
  });

  it('历史对话：新对话另开一段，之前的留着；可以切回去接着说，新的一段只带它自己的对话；可以删掉；重新打开作品时是最近用过的一段', async () => {
    const { deps, app } = await setup();
    step(deps, { message: '好。', actions: [], done: true });
    value(await app.sendToAssistant('先看看大纲'));
    // 新对话：还没说话时不存，列表里只有旧的那一段，正在看的是一段新的。
    value(await app.clearAssistant());
    expect(value(await app.assistantItems())).toEqual([]);
    const fresh = value(await app.assistantConversations());
    expect(fresh.conversations.map((c) => c.title)).toEqual(['先看看大纲']);
    expect(fresh.conversations.some((c) => c.id === fresh.current)).toBe(false);
    step(deps, { message: '好。', actions: [], done: true });
    value(await app.sendToAssistant('给主角起个名字，要有古风的味道，两个字就够了，最好带点江湖气'));
    const both = value(await app.assistantConversations());
    expect(both.conversations.map((c) => [c.title, c.messages])).toEqual([
      ['给主角起个名字，要有古风的味道，两个字就够了，最…', 2],
      ['先看看大纲', 2],
    ]);
    // 切回旧的那一段接着说：发给模型的对话只有那一段。
    const old = both.conversations[1]!;
    expect(roles(value(await app.openAssistantConversation(old.id)))).toEqual(['user', 'assistant']);
    step(deps, { message: '大纲还空着。', actions: [], done: true });
    deps.llmRequests.length = 0;
    value(await app.sendToAssistant('大纲写了什么'));
    const sent = JSON.stringify(deps.llmRequests[0]?.body ?? {});
    expect(sent).toContain('先看看大纲');
    expect(sent).not.toContain('给主角起个名字');
    expect(value(await app.assistantConversations()).conversations.map((c) => c.id)[0]).toBe(old.id);
    // 删掉正在看的那一段：换到最近用过的另一段。
    value(await app.deleteAssistantConversation(old.id));
    const left = value(await app.assistantConversations());
    expect(left.conversations.map((c) => c.messages)).toEqual([2]);
    expect(left.current).toBe(left.conversations[0]?.id);
    expect(roles(value(await app.assistantItems()))).toEqual(['user', 'assistant']);
    // 换到别的作品再回来：正在看的是最近用过的那一段。
    const first = value(await app.reloadWork()).project.id;
    value(await app.createWork('另一部'));
    expect(value(await app.assistantItems())).toEqual([]);
    value(await app.openWork(first));
    expect((value(await app.assistantItems())[0] as { text?: string }).text).toContain('给主角起个名字');
  });

  it('上下文用量只算正在看的这段对话里最近的一步；从备份恢复后正在看的是恢复后最近用过的一段', async () => {
    const { deps, app } = await setup();
    step(deps, { message: '好。', actions: [], done: true });
    value(await app.sendToAssistant('先看看大纲'));
    const a = value(await app.assistantConversations()).current!;
    expect(value(await app.assistantContextUsage())).toMatchObject({ promptTokens: 1000 });
    const backup = value(await app.createBackup());
    // 新的一段里说一句，再切回 A：最近一步是 B 的，A 不显示它的用量。
    value(await app.clearAssistant());
    step(deps, { message: '好。', actions: [], done: true });
    value(await app.sendToAssistant('另起一段'));
    const b = value(await app.assistantConversations()).current!;
    value(await app.openAssistantConversation(a));
    expect(value(await app.assistantContextUsage())).toBeNull();
    // 在 B 里时恢复到建 B 之前的备份：B 不在了，正在看的是 A，接着说话接在 A 后面。
    value(await app.openAssistantConversation(b));
    value(await app.restoreBackup(backup.name));
    const restored = value(await app.assistantConversations());
    expect(restored.conversations.map((c) => c.id)).toEqual([a]);
    expect(restored.current).toBe(a);
    expect((value(await app.assistantItems())[0] as { text?: string }).text).toBe('先看看大纲');
  });

  it('助手正在处理一句话时不恢复备份（恢复会换掉这一轮正在写的对话）', async () => {
    const { deps, app } = await setup();
    const backup = value(await app.createBackup());
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let asked = () => {};
    const thinking = new Promise<void>((resolve) => (asked = resolve));
    deps.llmRoute.current = async () => {
      asked();
      await gate;
      return reply(JSON.stringify({ message: '好。', actions: [], done: true }));
    };
    const turn = app.sendToAssistant('先看看大纲');
    await thinking;
    expect(await app.restoreBackup(backup.name)).toMatchObject({ ok: false, error: { code: 'settings', detail: expect.stringContaining('AI 助手正在处理') } });
    release();
    value(await turn);
    deps.llmRoute.current = null;
    expect(value(await app.restoreBackup(backup.name)).project.title).toBe('当铺夜谈');
  });

  it('一句话最多走固定的步数，不会无休止地调用；走满时告诉作者停在这里、说“继续”接着做', async () => {
    const { deps, app } = await setup();
    for (let i = 0; i < MAX_ASSISTANT_STEPS + 2; i++) step(deps, { message: '', actions: [{ tool: 'list_chapters', volume: null }], done: false });
    const outcome = value(await app.sendToAssistant('一直列章节'));
    expect(deps.llmRequests).toHaveLength(MAX_ASSISTANT_STEPS);
    expect(outcome.items.at(-1)).toMatchObject({ role: 'assistant', output: { message: expect.stringContaining(`已经走了 ${MAX_ASSISTANT_STEPS} 步`), actions: [], done: true } });
  });

  it('之前几轮的动作结果只留开头与结尾，这一轮的结果完整；对话太长时略去最早的几轮', async () => {
    const { deps, app } = await setup();
    const long = '雨'.repeat(3_000);
    await chapterWith(app, '第一章 夜叩', `开头${long}结尾`);
    step(deps, { message: '', actions: [{ tool: 'read_chapter', chapter: '夜叩' }], done: false });
    step(deps, { message: '读完了。', actions: [], done: true });
    value(await app.sendToAssistant('读第一章'));
    // 这一轮的第二步拿到完整的结果。
    expect(body(deps, 1)).toContain(long);
    step(deps, { message: '好。', actions: [], done: true });
    value(await app.sendToAssistant('再说说'));
    expect(body(deps, 2)).not.toContain(long);
    expect(body(deps, 2)).toContain('【作者】读第一章');
    // 很多轮之后，最早的一轮不再带上。
    for (let i = 0; i < 40; i++) {
      step(deps, { message: '嗯'.repeat(1_000), actions: [], done: true });
      value(await app.sendToAssistant(`第 ${i} 句`));
    }
    const last = body(deps, deps.llmRequests.length - 1);
    expect(last).not.toContain('【作者】读第一章');
    expect(last).toContain('【作者】第 39 句');
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

  it('审核问题：列出待处理的问题（带标识），标为已改好或忽略，交给写手修订那一段', async () => {
    const { deps, app } = await setup();
    const chapterId = await chapterWith(app, '第一章 夜叩', '林舟推门进来，雨水顺着衣角往下滴。');
    deps.llmResponses.push(
      reply(
        JSON.stringify({
          issues: [
            { paragraph: 'P1', quote: '雨水顺着衣角往下滴', kind: 'pacing', severity: 'medium', evidence: [], description: '开头的动作描写太长', suggestion: '压缩成一句' },
            { paragraph: 'P1', quote: '林舟推门进来', kind: 'pacing', severity: 'low', evidence: [], description: '进门太平', suggestion: '' },
          ],
        }),
      ),
    );
    value(await app.reviewChapter(chapterId));
    const [first, second] = value(await app.reviewIssues(chapterId));
    step(deps, { message: '', actions: [{ tool: 'list_review_issues', chapter: null }], done: false });
    step(deps, { message: '', actions: [{ tool: 'resolve_review_issue', issue: second!.id, status: 'ignored' }], done: false });
    step(deps, { message: '改好了。', actions: [{ tool: 'revise_review_issue', issue: first!.id }], done: true });
    deps.llmResponses.push(reply('林舟推门进来，带进一身雨气。'));
    const effects: AssistantEffect[] = [];
    const outcome = value(await app.sendToAssistant('把审核出的问题处理一下，进门那条不用管', { onEffect: (e) => effects.push(e) }));
    const all = outcome.items.filter((i): i is Extract<AssistantItem, { role: 'results' }> => i.role === 'results').flatMap((i) => i.results);
    expect(all.map((r) => [r.tool, r.ok])).toEqual([
      ['list_review_issues', true],
      ['resolve_review_issue', true],
      ['revise_review_issue', true],
    ]);
    expect(all[0]?.detail).toContain(`《第一章 夜叩》2 条：\n- [${first!.id}] 一般：开头的动作描写太长（建议：压缩成一句）；原文：“雨水顺着衣角往下滴”`);
    expect(all[1]?.detail).toContain('忽略');
    expect(all[2]?.detail).toContain('build_chapter_memory');
    expect(value(await app.openChapter(chapterId)).saved.map((p) => p.text)).toEqual(['林舟推门进来，带进一身雨气。']);
    expect(effects).toContainEqual({ kind: 'show_review', chapterId });
    expect(value(await app.reviewIssues(chapterId))).toEqual([]);
    // 已经不在待处理里的问题再处理，说清楚没有改，不报成功。
    step(deps, { message: '', actions: [{ tool: 'resolve_review_issue', issue: second!.id, status: 'fixed' }], done: true });
    step(deps, { message: '那条已经处理过了。', actions: [], done: true });
    expect(lastResults(value(await app.sendToAssistant('那条标为已改好')).items)).toMatchObject({ results: [{ ok: false, detail: expect.stringContaining('不在待处理里') }] });
  });

  it('长篇记忆、伏笔账本与写作技能：读记忆与账本，改伏笔的状态与章节，停用与启用技能', async () => {
    const { deps, app } = await setup();
    const one = await chapterWith(app, '第一章 夜叩', '林舟把玉佩押在柜台上。');
    const two = value(await app.createChapter('第二章 夜雨')).chapters.find((c) => c.title === '第二章 夜雨')!.id;
    value(await app.createEntity('character', '林舟'));
    value(await app.addForeshadow({ title: '玉佩', content: '掌柜多看了玉佩一眼', reveal: '玉佩是父亲的遗物', plantChapterId: one, plantAnchor: null, payoffChapterId: null, payoffAnchor: null, status: 'planned' }));
    deps.llmResponses.push(reply(JSON.stringify({ summary: '林舟当玉。', cast: [{ name: '林舟', state: '缺钱' }], foreshadows: [{ title: '玉佩', progress: '掌柜起了疑' }], openThreads: ['掌柜说三日后再来'] })));
    value(await app.buildMemory(one));
    step(deps, {
      message: '',
      actions: [
        { tool: 'get_chapter_memory', chapter: '夜叩' },
        { tool: 'get_chapter_memory', chapter: '夜雨' },
        { tool: 'list_foreshadows', chapter: null },
        { tool: 'update_foreshadow', foreshadow: '玉佩', title: null, content: null, reveal: null, plant: null, payoff: '夜雨', status: 'planted' },
        { tool: 'list_skills', stage: 'planning' },
        { tool: 'set_skill', skill: '雪花写作法', enabled: false },
        { tool: 'set_skill', skill: '不用副词', enabled: true },
      ],
      done: true,
    });
    const outcome = value(await app.sendToAssistant('前面写了什么？玉佩埋下了，第二章收；别用雪花写作法'));
    const results = lastResults(outcome.items)!.results;
    expect(results.map((r) => r.ok)).toEqual([true, true, true, true, true, true, true]);
    expect(results[0]?.detail).toBe('《第一章 夜叩》的长篇记忆\n梗概：林舟当玉。\n人物状态：林舟：缺钱\n伏笔进展：玉佩：掌柜起了疑\n章尾留给后面的事：掌柜说三日后再来');
    expect(results[1]?.detail).toContain('还没有长篇记忆');
    expect(results[2]?.detail).toMatch(/^- \[\w+\] 玉佩（计划；埋设 《第一章 夜叩》，回收 未定）：掌柜多看了玉佩一眼；揭晓前不得说破：玉佩是父亲的遗物/);
    expect(results[4]?.detail).toMatch(/^- 雪花写作法（规划；启用）：/);
    expect(results[5]?.detail).toContain('已停用写作技能“雪花写作法”');
    expect(results[6]?.detail).toBe('“不用副词”本来就是启用的。');
    expect(value(await app.planningView()).foreshadows).toMatchObject([{ title: '玉佩', plantChapterId: one, payoffChapterId: two, status: 'planted' }]);
    expect(value(await app.listWritingSkills()).skills.find((s) => s.skill.name === '雪花写作法')?.skill.enabled).toBe(false);

    // 正文改过以后，按现在的正文重新整理长篇记忆。
    step(deps, { message: '', actions: [{ tool: 'build_chapter_memory', chapter: '夜叩' }], done: true });
    deps.llmResponses.push(reply(JSON.stringify({ summary: '林舟当玉，掌柜收下。', cast: [], foreshadows: [], openThreads: [] })));
    expect(lastResults(value(await app.sendToAssistant('重新整理第一章的记忆')).items)).toMatchObject({ results: [{ tool: 'build_chapter_memory', ok: true }] });
    expect(value(await app.planningView()).chapters.find((c) => c.chapter.id === one)?.memory).toMatchObject({ summary: '林舟当玉，掌柜收下。' });
  });

  it('停下后台任务：交给后台去停，结果原样告诉模型', async () => {
    const { deps, app } = await setup();
    const asked: string[] = [];
    const background = {
      reviewChapters: () => null,
      writeChapters: () => null,
      workflow: () => null,
      simulating: () => false, run: () => Promise.resolve(null),
      writing: () => [],
      simulate: () => null,
      stop: (what: string) => {
        asked.push(what);
        return '已停下：写手停在这一段之后。';
      },
    };
    step(deps, { message: '停了。', actions: [{ tool: 'stop_background', what: 'writing' }], done: true });
    const outcome = value(await app.sendToAssistant('先别写了', { background }));
    expect(asked).toEqual(['writing']);
    expect(lastResults(outcome.items)).toMatchObject({ results: [{ tool: 'stop_background', ok: true, detail: '已停下：写手停在这一段之后。' }] });
  });

  it('排在后台写作里的章节（正在写或排着）助手不直接写，也不回退', async () => {
    const { deps, app } = await setup();
    const id = value(await app.createChapter('第一章 夜叩')).chapters[0]!.id;
    value(await app.savePlan(id, { goal: '林舟当玉', castIds: [], beats: ['叩门'], foreshadowPlant: [], foreshadowPayoff: [], treatment: '', targetWords: 3000 }));
    const background = { reviewChapters: () => null, writeChapters: () => null, workflow: () => null, simulating: () => false, run: () => Promise.resolve(null), writing: () => [id], simulate: () => null, stop: () => '' };
    step(deps, { message: '', actions: [{ tool: 'write_chapter', chapter: '第一章 夜叩' }], done: true });
    step(deps, { message: '已经排在后台了。', actions: [], done: true });
    const outcome = value(await app.sendToAssistant('写第一章', { background }));
    expect(lastResults(outcome.items)?.results[0]).toMatchObject({ tool: 'write_chapter', ok: false, detail: expect.stringContaining('后台') });
    expect(deps.llmRequests).toHaveLength(2);
  });

  it('写或审核多章交给后台：动作立即返回“已排上”，后台收到按书中顺序的章节；没有后台时说明不能用', async () => {
    const { deps, app } = await setup();
    const one = await chapterWith(app, '第一章 夜叩', '门在他身后合上了。');
    const two = await chapterWith(app, '第二章 夜雨', '雨下得更紧了。', 'p1');
    const three = value(await app.createChapter('第三章 揭晓')).chapters.find((c) => c.title === '第三章 揭晓')!.id;
    value(await app.savePlan(three, { goal: '真相揭晓', castIds: [], beats: ['对质'], foreshadowPlant: [], foreshadowPayoff: [], treatment: '', targetWords: 3000 }));
    const reviewed: (readonly string[])[] = [];
    const written: [readonly string[], boolean][] = [];
    const background = {
      reviewChapters: (ids: readonly string[]) => {
        reviewed.push(ids);
        return null;
      },
      writeChapters: (ids: readonly string[], review: boolean) => {
        written.push([ids, review]);
        return null;
      },
      workflow: () => null,
      simulating: () => false, run: () => Promise.resolve(null),
      writing: () => [],
      simulate: () => null,
      stop: () => '后台没有在进行的写作或审核。',
    };
    step(deps, {
      message: '排上了。',
      actions: [
        { tool: 'review_chapters', chapters: null },
        { tool: 'write_chapters', chapters: null, review: true },
      ],
      done: true,
    });
    const outcome = value(await app.sendToAssistant('审核写好的章节，再把剩下的写完', { background }));
    expect(reviewed).toEqual([[one, two]]);
    expect(written).toEqual([[[three], true]]);
    expect(lastResults(outcome.items)?.results.map((r) => [r.tool, r.ok, r.detail.startsWith('已排上')])).toEqual([
      ['review_chapters', true, true],
      ['write_chapters', true, true],
    ]);

    // 后台已有一批时说明原因；指名的章节里没有正文的不排。
    const busy = { reviewChapters: () => '已经有一批在依次审核', writeChapters: () => null, workflow: () => null, simulating: () => false, run: () => Promise.resolve(null), writing: () => [], simulate: () => null, stop: () => '' };
    // 动作失败时助手会再走一步说明：每次排两步。
    const failing = (actions: AssistantTurnOutput['actions']) => {
      step(deps, { message: '', actions, done: true });
      step(deps, { message: '没有排上。', actions: [], done: true });
    };
    const results = (items: readonly AssistantItem[]) => items.filter((i): i is Extract<AssistantItem, { role: 'results' }> => i.role === 'results').at(-1);
    failing([{ tool: 'review_chapters', chapters: ['第一章 夜叩'] }]);
    expect(results(value(await app.sendToAssistant('再审第一章', { background: busy })).items)).toMatchObject({ results: [{ ok: false, detail: '已经有一批在依次审核' }] });
    failing([{ tool: 'review_chapters', chapters: ['第三章 揭晓'] }]);
    expect(results(value(await app.sendToAssistant('审第三章', { background })).items)).toMatchObject({ results: [{ ok: false, detail: expect.stringContaining('还没有正文') }] });
    // 没有后台（例如测试与命令行）时不能用，提示改用一章一章的动作。
    failing([{ tool: 'review_chapters', chapters: null }]);
    expect(results(value(await app.sendToAssistant('审全书')).items)).toMatchObject({ results: [{ ok: false, detail: expect.stringContaining('review_chapter') }] });
  });

  it('写手写章时报告进度；回退写手写入要作者确认，确认后正文回到写入之前', async () => {
    const { deps, app } = await setup();
    const chapterId = await chapterWith(app, '第一章 夜叩', '门在他身后合上了。');
    const lin = value(await app.createEntity('character', '林舟')).created;
    value(await app.savePlan(chapterId, { goal: '林舟当玉', castIds: [lin.id], beats: ['叩门', '压价'], foreshadowPlant: [], foreshadowPayoff: [], treatment: '', targetWords: 3000 }));
    step(deps, { message: '让写手写。', actions: [{ tool: 'write_chapter', chapter: '第一章 夜叩' }], done: true });
    deps.llmResponses.push(reply('林舟又叩响了门。'), reply('钱四压低了价。'), reply(JSON.stringify({ summary: '林舟叩门当玉，钱四压价。', cast: [{ name: '林舟', state: '缺钱' }], foreshadows: [], openThreads: [] })));
    const notes: (string | null)[] = [];
    const effects: AssistantEffect[] = [];
    const written = value(await app.sendToAssistant('写第一章', { onProgress: (n) => notes.push(n), onEffect: (e) => effects.push(e) }));
    expect(lastResults(written.items)).toMatchObject({ results: [{ tool: 'write_chapter', ok: true, detail: expect.stringContaining('长篇记忆已整理') }] });
    expect(notes).toEqual(['写手正在写《第一章 夜叩》', '写手正在写《第一章 夜叩》：已写 1/2 段', '写手正在写《第一章 夜叩》：已写 2/2 段', '正在整理《第一章 夜叩》的长篇记忆', null]);
    // 写完一章就有长篇记忆，问“前面写了什么”时用得上。
    expect(value(await app.planningView()).chapters.find((c) => c.chapter.id === chapterId)?.memory).toMatchObject({ summary: '林舟叩门当玉，钱四压价。' });
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

  it('改写已有的大纲前请作者确认（大纲没有历史版本）；大纲是空的或没改大纲时直接执行', async () => {
    const { deps, app } = await setup();
    step(deps, { message: '', actions: [{ tool: 'update_work', title: null, genre: null, synopsis: null, outline: '开端：林舟当玉。' }], done: true });
    expect(value(await app.sendToAssistant('写个大纲')).pending).toBe(false);
    expect(value(await app.reloadWork()).project.outline).toBe('开端：林舟当玉。');

    step(deps, { message: '', actions: [{ tool: 'update_work', title: null, genre: '古风悬疑', synopsis: null, outline: null }], done: true });
    expect(value(await app.sendToAssistant('类型改成古风悬疑')).pending).toBe(false);

    step(deps, { message: '要换大纲。', actions: [{ tool: 'update_work', title: null, genre: null, synopsis: null, outline: '开端：沈砚下山。' }], done: false });
    const paused = value(await app.sendToAssistant('大纲重写'));
    expect(paused.items.at(-1)).toMatchObject({ role: 'pending', summary: '用新写的大纲替换现在的作品大纲（原来的大纲不保留）' });
    expect(value(await app.reloadWork()).project.outline).toBe('开端：林舟当玉。');
    step(deps, { message: '换好了。', actions: [], done: true });
    value(await app.resolveAssistantPending(true));
    expect(value(await app.reloadWork()).project.outline).toBe('开端：沈砚下山。');
  });

  it('作者偏好（B74）：记下明确说出的偏好（重复的不再记），写进“作者偏好”技能与现状；作者讨厌的说法加进规避词表', async () => {
    const { deps, app } = await setup();
    step(deps, {
      message: '记下了。',
      actions: [
        { tool: 'remember_preference', preference: '对白要短，不要长篇独白' },
        { tool: 'remember_preference', preference: ' 主角不说脏话 ' },
        { tool: 'add_avoid_phrases', phrases: ['嘴角上扬', ' 不禁 ', ''] },
      ],
      done: true,
    });
    const first = value(await app.sendToAssistant('以后对白要短，主角不说脏话；别再写“嘴角上扬”'));
    expect(lastResults(first.items)).toMatchObject({ results: [{ ok: true }, { ok: true }, { ok: true, detail: '已把“嘴角上扬”加进规避词表，审核时会逐处标出。' }] });
    const skills = value(await app.listWritingSkills());
    const pref = skills.skills.find((s) => s.skill.key === 'author-preferences')!;
    expect(pref.skill).toMatchObject({ name: '作者偏好', enabled: true, instruction: '- 对白要短，不要长篇独白\n- 主角不说脏话', stages: ['planning', 'writing'] });
    expect(skills.avoidPhrases).toContain('嘴角上扬');
    expect(skills.avoidPhrasesCustom).toBe(true);

    step(deps, { message: '', actions: [{ tool: 'remember_preference', preference: '主角不说脏话' }], done: true });
    const again = value(await app.sendToAssistant('再说一遍：主角不说脏话'));
    expect(lastResults(again.items)).toMatchObject({ results: [{ ok: true, detail: '“主角不说脏话”已经记下了。' }] });
    // 已记下的偏好列在给模型的现状里。
    expect(body(deps, 1)).toContain('作者偏好（已记下）：\\n- 对白要短，不要长篇独白\\n- 主角不说脏话');
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
