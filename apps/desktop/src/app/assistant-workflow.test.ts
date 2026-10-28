import { rmSync } from 'node:fs';
import type { AssistantTurnOutput } from '@fudiao/prompts';
import { afterEach, describe, expect, it } from 'vitest';
import { fsDeps, type TestDeps } from '../testing/fs-deps';
import { addTestedModel, reply } from '../testing/models';
import type { AssistantItem } from './assistant';
import type { BackgroundJobs } from './assistant-tools';
import type { BookSeed } from './quick-book';
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

async function setup() {
  const deps = fsDeps();
  all.push(deps);
  const app = createAppService(deps);
  value(await app.loadLibrary());
  value(await app.createWork('新作品'));
  // 一键成书的一步要写几万 Token：登记够大的最大输出，“检查模型”才放行。
  await addTestedModel(app, deps, { maxOutputTokens: 64_000 });
  return { deps, app };
}

const step = (deps: TestDeps, output: AssistantTurnOutput) => deps.llmResponses.push(reply(JSON.stringify(output)));
const lastResults = (items: readonly AssistantItem[]) => items.filter((i): i is Extract<AssistantItem, { role: 'results' }> => i.role === 'results').at(-1);

const seed: BookSeed = {
  title: '当铺夜谈',
  genre: '古风悬疑',
  synopsis: '落魄书生林舟深夜当玉。',
  outline: '开端：林舟当玉。结局：林舟得知身世。',
  characters: [{ name: '林舟', description: '落魄书生' }],
  relationships: [],
};

/** 状态层的后台：记下要推进的运行与停下的请求，测试决定什么时候推进。 */
function backgroundJobs() {
  const advanced: string[] = [];
  const stopped: string[] = [];
  const background: BackgroundJobs = {
    writeChapters: () => null,
    reviewChapters: () => null,
    reviseIssues: () => Promise.resolve(null),
    workflow(runId) {
      advanced.push(runId);
      return null;
    },
    simulating: () => false,
    writing: () => [],
    simulate: () => null,
    stop(what) {
      stopped.push(what);
      return '已停下：写作工作流停在当前这一步。';
    },
    run: () => Promise.resolve(null),
  };
  return { background, advanced, stopped };
}

describe('AI 助手发起与继续写作工作流（B78）', () => {
  it('开始一键成书：建好运行并交给后台推进，结果里有预计用量；查看、按原样采用并继续、停下', async () => {
    const { deps, app } = await setup();
    const { background, advanced, stopped } = backgroundJobs();

    step(deps, {
      message: '',
      actions: [{ tool: 'start_workflow', workflow: 'quick_book', mode: 'step', budgetUsd: null, idea: '落魄书生当铺夜遇旧主', genre: null, chapters: 6, wordsPerChapter: 3000, volumes: null, from: null, to: null, rereview: null, instruction: null, chapter: null }],
      done: false,
    });
    step(deps, { message: '已经排上。', actions: [], done: true });
    const started = value(await app.sendToAssistant('用一键成书把这个想法写成书：落魄书生当铺夜遇旧主', { background }));
    expect(lastResults(started.items)?.results[0]).toMatchObject({ tool: 'start_workflow', ok: true, detail: expect.stringMatching(/^已排上：“一键成书：落魄书生当铺夜遇旧主” \[/) });
    const [run] = value(await app.listWorkflows());
    expect(run?.run).toMatchObject({ workflow: 'quick_book', mode: 'step', params: { idea: '落魄书生当铺夜遇旧主', genre: '', chapters: 6, wordsPerChapter: 3000, volumeMode: 'auto', volumeCount: null } });
    expect(advanced).toEqual([run!.run.id]);

    // 后台推进到骨架草稿（这里由测试代替状态层推进）。
    deps.llmResponses.push(reply(JSON.stringify(seed)));
    value(await app.advanceWorkflow(run!.run.id));

    // 没有说按原样采用时不推进，说明停在哪一步。
    step(deps, { message: '', actions: [{ tool: 'get_workflow', run: null }, { tool: 'continue_workflow', run: run!.run.id, adopt: false }], done: false });
    step(deps, { message: '停在大纲与人物，等你看。', actions: [], done: true });
    const looked = value(await app.sendToAssistant('进度怎样', { background }));
    const [got, refused] = lastResults(looked.items)?.results ?? [];
    expect(got).toMatchObject({ tool: 'get_workflow', ok: true, detail: expect.stringContaining('2. 大纲与人物：等你处理——《当铺夜谈》：1 个主要人物') });
    expect(refused).toMatchObject({ tool: 'continue_workflow', ok: false, detail: expect.stringContaining('等作者处理') });
    expect(advanced).toHaveLength(1);

    step(deps, { message: '', actions: [{ tool: 'continue_workflow', run: run!.run.id, adopt: true }], done: false });
    step(deps, { message: '采用了，接着拆计划。', actions: [], done: true });
    const adopted = value(await app.sendToAssistant('就这样，采用吧', { background }));
    expect(lastResults(adopted.items)?.results[0]).toMatchObject({ ok: true, detail: expect.stringContaining('已采用第 2 步“大纲与人物”') });
    expect(value(await app.reloadWork()).project).toMatchObject({ title: '当铺夜谈', outline: seed.outline });
    expect(advanced).toEqual([run!.run.id, run!.run.id]);

    step(deps, { message: '', actions: [{ tool: 'stop_background', what: 'workflow' }], done: false });
    step(deps, { message: '停下了。', actions: [], done: true });
    value(await app.sendToAssistant('先停一下', { background }));
    expect(stopped).toEqual(['workflow']);
  });

  it('已有大纲时按原样采用骨架会替换大纲：助手先请作者确认，确认后才采用；后台在做事时不能换作品', async () => {
    const { deps, app } = await setup();
    const { background } = backgroundJobs();
    value(await app.updateWorkInfo({ outline: '原来的大纲' }));
    const run = value(await app.startWorkflow({ workflow: 'quick_book', params: { idea: '落魄书生', genre: '', chapters: 2, wordsPerChapter: 2000 }, mode: 'step', budgetUsd: null }));
    deps.llmResponses.push(reply(JSON.stringify(seed)));
    value(await app.advanceWorkflow(run.run.id));
    step(deps, { message: '', actions: [{ tool: 'continue_workflow', run: run.run.id, adopt: true }], done: false });
    const paused = value(await app.sendToAssistant('按原样采用', { background }));
    expect(paused.items.at(-1)).toMatchObject({ role: 'pending', summary: expect.stringContaining('采用会替换作品已有的大纲') });
    expect(value(await app.reloadWork()).project.outline).toBe('原来的大纲');
    step(deps, { message: '采用了。', actions: [], done: true });
    const approved = value(await app.resolveAssistantPending(true, { background }));
    expect(lastResults(approved.items)?.results[0]).toMatchObject({ tool: 'continue_workflow', ok: true });
    expect(value(await app.reloadWork()).project.outline).toBe(seed.outline);

    step(deps, { message: '', actions: [{ tool: 'create_work', title: '另一部', genre: null, synopsis: null, outline: null }], done: false });
    step(deps, { message: '不能换。', actions: [], done: true });
    const refused = value(await app.sendToAssistant('新建一部', { background: { ...background, busy: () => '写作工作流“一键成书”正在推进' } }));
    expect(lastResults(refused.items)?.results[0]).toMatchObject({ tool: 'create_work', ok: false, detail: expect.stringContaining('后台还在做') });
    expect(value(await app.reloadWork()).project.title).toBe('当铺夜谈');
  });

  it('一键成书的章数与每章字数由作者定：没说清时不发起、让助手先问；说了卷数时按指定卷数', async () => {
    const { deps, app } = await setup();
    const { background } = backgroundJobs();
    const start = (chapters: number | null, wordsPerChapter: number | null, volumes: number | null) => ({
      tool: 'start_workflow' as const,
      workflow: 'quick_book' as const,
      mode: 'step' as const,
      budgetUsd: null,
      idea: '落魄书生',
      genre: null,
      chapters,
      wordsPerChapter,
      volumes,
      from: null,
      to: null,
      rereview: null,
      instruction: null,
      chapter: null,
    });
    step(deps, { message: '', actions: [start(null, 3000, null)], done: false });
    step(deps, { message: '你想写多少章、每章多少字？', actions: [], done: true });
    const asked = value(await app.sendToAssistant('用一键成书写这个', { background }));
    expect(lastResults(asked.items)?.results[0]).toMatchObject({ tool: 'start_workflow', ok: false, detail: expect.stringContaining('先问清楚') });
    expect(value(await app.listWorkflows())).toEqual([]);

    step(deps, { message: '', actions: [start(60, 3000, 3)], done: false });
    step(deps, { message: '已经排上。', actions: [], done: true });
    value(await app.sendToAssistant('60 章，每章 3000 字，分 3 卷', { background }));
    const [run] = value(await app.listWorkflows());
    expect(run?.run.params).toMatchObject({ chapters: 60, wordsPerChapter: 3000, volumeMode: 'fixed', volumeCount: 3 });
    expect(run?.steps.map((s) => s.key)).toEqual(['model', 'seed', 'volumes', 'volumePlans', 'write', 'export']);
  });

  it('没有后台时（命令行与试用脚本之外）说明不能用；没有运行时 get_workflow 说明怎样开始', async () => {
    const { deps, app } = await setup();
    step(deps, {
      message: '',
      actions: [
        { tool: 'start_workflow', workflow: 'quick_book', mode: 'auto', budgetUsd: null, idea: '一句话', genre: null, chapters: null, wordsPerChapter: null, volumes: null, from: null, to: null, rereview: null, instruction: null, chapter: null },
        { tool: 'get_workflow', run: null },
      ],
      done: false,
    });
    step(deps, { message: '这里不能用。', actions: [], done: true });
    const out = value(await app.sendToAssistant('一键成书', {}));
    const [start, get] = lastResults(out.items)?.results ?? [];
    expect(start).toMatchObject({ ok: false, detail: '这里不能在后台推进写作工作流' });
    expect(get).toMatchObject({ ok: false, detail: expect.stringContaining('还没有运行过写作工作流') });
    expect(value(await app.listWorkflows())).toEqual([]);
  });
});

describe('AI 助手发起推演成章（B85）', () => {
  it('说了哪一章就发起：参数带这一章的标识与章名、默认回合上限；没说是哪一章时不发起、先问', async () => {
    const { deps, app } = await setup();
    const { background, advanced } = backgroundJobs();
    const chapter = value(await app.createChapter('第三章 当铺')).chapters[0]!;
    const action = { tool: 'start_workflow' as const, workflow: 'scene_chapter' as const, mode: 'step' as const, budgetUsd: null, idea: null, genre: null, chapters: null, wordsPerChapter: null, volumes: null, from: null, to: null, rereview: null, instruction: null };
    step(deps, { message: '', actions: [{ ...action, chapter: null }], done: false });
    step(deps, { message: '想推演哪一章？', actions: [], done: true });
    const asked = value(await app.sendToAssistant('把那场对峙推演出来再写', { background }));
    expect(lastResults(asked.items)?.results[0]).toMatchObject({ tool: 'start_workflow', ok: false, detail: expect.stringContaining('先问清楚') });
    expect(advanced).toEqual([]);

    step(deps, { message: '', actions: [{ ...action, chapter: '第三章 当铺' }], done: false });
    step(deps, { message: '已经排上。', actions: [], done: true });
    const started = value(await app.sendToAssistant('第三章', { background }));
    expect(lastResults(started.items)?.results[0]).toMatchObject({ tool: 'start_workflow', ok: true, detail: expect.stringMatching(/^已排上：“推演成章：第三章 当铺” \[/) });
    const [run] = value(await app.listWorkflows());
    expect(run?.run).toMatchObject({ workflow: 'scene_chapter', params: { chapterId: chapter.id, chapterTitle: '第三章 当铺', sceneId: null, maxRounds: 8 } });
    expect(run?.steps.map((s) => s.key)).toEqual(['scene', 'simulate', 'beats', 'narrate', 'write']);
    expect(advanced).toEqual([run!.run.id]);
  });
});
