import { rmSync } from 'node:fs';
import type { PlanDraftData } from '@fudiao/prompts';
import { getWorkflowRun, updateWorkflowSteps } from '@fudiao/store';
import { loadMigrations, openProjectDb } from '@fudiao/store/node';
import { afterEach, describe, expect, it } from 'vitest';
import { fsDeps, type TestDeps } from '../testing/fs-deps';
import { addTestedModel, reply } from '../testing/models';
import type { BookSeed } from './quick-book';
import { createAppService } from './service';
import type { WorkflowHooks } from './workflows';

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
  await addTestedModel(app, deps);
  deps.llmRequests.length = 0;
  return { deps, app };
}

const seed: BookSeed = {
  title: '当铺夜谈',
  genre: '古风悬疑',
  synopsis: '落魄书生林舟深夜当玉，掌柜钱四认出了玉的来历。',
  outline: '开端：林舟当玉。发展：钱四起疑。高潮：玉佩的主人现身。结局：林舟得知身世。',
  characters: [
    { name: '林舟', description: '落魄书生' },
    { name: '钱四', description: '当铺掌柜' },
  ],
  relationships: [],
};

const draft: PlanDraftData = {
  chapters: [
    { title: '夜叩', goal: '林舟当玉被压价', cast: ['林舟', '钱四'], beats: ['叩门', '压价'], plant: ['玉佩的来历'], payoff: [], treatment: '', targetWords: 2000 },
    { title: '揭晓', goal: '真相揭晓', cast: ['林舟'], beats: ['对质'], plant: [], payoff: ['玉佩的来历'], treatment: '', targetWords: 2000 },
  ],
  foreshadows: [{ title: '玉佩的来历', content: '钱四多看了玉佩一眼', reveal: '玉佩是林舟父亲的遗物' }],
};

const params = { idea: '落魄书生当铺夜遇旧主', genre: '古风悬疑', chapters: 2, wordsPerChapter: 2000 };

/** 不调用写手的写章节钩子：记下要写的章节。 */
function fakeWriter(result: { readonly ok: boolean; readonly summary: string; readonly cancelled?: boolean } = { ok: true, summary: '写完了 2 章并审核' }) {
  const calls: { ids: readonly string[]; review: boolean }[] = [];
  const hooks: WorkflowHooks = {
    writeChapters(ids, review) {
      calls.push({ ids, review });
      return Promise.resolve(result);
    },
    reviewChapters: () => Promise.resolve({ ok: true, summary: '' }),
  };
  return { calls, hooks };
}

describe('写作工作流（B78）', () => {
  it('列出一键成书的步骤；开始前给出预计用量，价格未知时费用为 null；参数不完整时说明', async () => {
    const { app } = await setup();
    const [book] = app.workflowCatalog();
    expect(book).toMatchObject({ key: 'quick_book', title: '一键成书' });
    expect(book?.steps.map((s) => [s.key, s.kind])).toEqual([
      ['model', 'check'],
      ['seed', 'draft'],
      ['plan', 'draft'],
      ['write', 'act'],
      ['export', 'manual'],
    ]);
    const quote = value(await app.quoteWorkflow('quick_book', params));
    expect(quote.calls).toBeGreaterThan(2);
    expect(quote.inputTokens).toBeGreaterThan(0);
    expect(quote).toMatchObject({ costUsd: null, model: 'm' });
    expect(await app.quoteWorkflow('quick_book', { ...params, chapters: 0 })).toMatchObject({ ok: false, error: { code: 'settings' } });
  });

  it('每步停下：检查模型后停在骨架草稿；作者改过再采用，作品里是改过的内容；计划同样；写章节交给钩子；导出须作者动手', async () => {
    const { deps, app } = await setup();
    const started = value(await app.startWorkflow({ workflow: 'quick_book', params, mode: 'step', budgetUsd: null }));
    expect(started.state).toBe('ready');
    deps.llmResponses.push(reply(JSON.stringify(seed)));
    const first = value(await app.advanceWorkflow(started.run.id));
    expect(first.view.steps.map((s) => s.status)).toEqual(['done', 'awaiting_author', 'pending', 'pending', 'pending']);
    expect(first.summary).toContain('等你处理');
    expect(first.view.state).toBe('waiting');
    // 草稿没有写入作品。
    expect(value(await app.reloadWork()).project.outline).toBe('');
    // 用量记进这一步。
    expect(first.view.steps[1]?.usage).toMatchObject({ input: 1_000, output: 500, unknown: 1 });

    value(await app.editWorkflowStep(started.run.id, 1, { ...seed, title: '夜当' }));
    expect(await app.editWorkflowStep(started.run.id, 1, { title: '缺字段' })).toMatchObject({ ok: false, error: { code: 'settings' } });
    const adopted = value(await app.adoptWorkflowStep(started.run.id, 1));
    expect(adopted.steps[1]).toMatchObject({ status: 'done', edited: true });
    expect(value(await app.reloadWork()).project).toMatchObject({ title: '夜当', outline: seed.outline });

    deps.llmResponses.push(reply(JSON.stringify(draft)));
    const second = value(await app.advanceWorkflow(started.run.id));
    expect(second.view.steps.map((s) => s.status)).toEqual(['done', 'done', 'awaiting_author', 'pending', 'pending']);
    value(await app.adoptWorkflowStep(started.run.id, 2));
    const plans = value(await app.planningView()).chapters;
    expect(plans.map((c) => c.chapter.title)).toEqual(['夜叩', '揭晓']);
    expect(plans.every((c) => c.plan !== null)).toBe(true);

    const writer = fakeWriter();
    const third = value(await app.advanceWorkflow(started.run.id, { hooks: writer.hooks }));
    expect(writer.calls).toEqual([{ ids: plans.map((c) => c.chapter.id), review: true }]);
    expect(third.view.steps.map((s) => s.status)).toEqual(['done', 'done', 'done', 'done', 'awaiting_author']);
    expect(third.view.steps[3]?.note).toBe('写完了 2 章并审核');

    value(await app.adoptWorkflowStep(started.run.id, 4));
    expect(deps.exported.map((e) => e.name)).toEqual(['夜当.txt']);
    const done = value(await app.workflowRun(started.run.id));
    expect(done.state).toBe('done');
    expect(value(await app.advanceWorkflow(started.run.id)).summary).toContain('全部做完');
  });

  it('一路做完：草稿直接采用；已有计划时停下等作者确认覆盖', async () => {
    const { deps, app } = await setup();
    value(await app.createChapter('第一章'));
    value(await app.savePlan(value(await app.planningView()).chapters[0]!.chapter.id, { goal: '旧计划', castIds: [], beats: [], foreshadowPlant: [], foreshadowPayoff: [], treatment: '', targetWords: null }));
    const run = value(await app.startWorkflow({ workflow: 'quick_book', params, mode: 'auto', budgetUsd: null }));
    deps.llmResponses.push(reply(JSON.stringify(seed)), reply(JSON.stringify(draft)));
    const out = value(await app.advanceWorkflow(run.run.id));
    expect(out.view.steps.map((s) => s.status)).toEqual(['done', 'done', 'awaiting_author', 'pending', 'pending']);
    expect(out.view.steps[2]?.note).toContain('覆盖已有的 1 章');
    expect(value(await app.reloadWork()).project.title).toBe('当铺夜谈');
  });

  it('写章节没有写完时这一步出错并写明原因；重做后再写', async () => {
    const { deps, app } = await setup();
    const run = value(await app.startWorkflow({ workflow: 'quick_book', params, mode: 'auto', budgetUsd: null }));
    deps.llmResponses.push(reply(JSON.stringify(seed)), reply(JSON.stringify(draft)));
    const failing = fakeWriter({ ok: false, summary: '停在《揭晓》：输出被截断' });
    const out = value(await app.advanceWorkflow(run.run.id, { hooks: failing.hooks }));
    expect(out.view.steps[3]).toMatchObject({ status: 'failed', note: '停在《揭晓》：输出被截断' });
    expect(out.view.state).toBe('failed');
    expect(out.summary).toContain('出错');
    // 出错的一步停在那里，作者重做后接着写。
    const writer = fakeWriter();
    expect(value(await app.advanceWorkflow(run.run.id, { hooks: writer.hooks })).summary).toContain('出错');
    expect(writer.calls).toHaveLength(0);
    value(await app.redoWorkflowStep(run.run.id, 3));
    const again = value(await app.advanceWorkflow(run.run.id, { hooks: writer.hooks }));
    expect(writer.calls).toHaveLength(1);
    expect(again.view.steps[3]).toMatchObject({ status: 'done', attempt: 2 });
  });

  it('关掉应用时进行中的一步：重新打开后为中断，继续时接着做同一次，已完成的模型调用不再请求', async () => {
    const { deps, app } = await setup();
    const run = value(await app.startWorkflow({ workflow: 'quick_book', params, mode: 'step', budgetUsd: null }));
    deps.llmResponses.push(reply(JSON.stringify(seed)));
    value(await app.advanceWorkflow(run.run.id));
    // 模拟调用已经记下、步骤还没写成“等作者”时应用被关掉：把这一步改回进行中。
    const work = value(await app.loadLibrary()).works[0]!;
    await app.closeWork();
    const opened = openProjectDb(work.path, { migrations: loadMigrations(), now: '2026-10-19T00:00:00.000Z' });
    if (!opened.ok) throw new Error('打不开');
    const data = value(await getWorkflowRun(opened.value.db, run.run.id))!;
    value(await updateWorkflowSteps(opened.value.db, run.run.id, [{ step: data.steps[1]!, patch: { status: 'running', output: null } }], { now: '2026-10-19T00:00:00.000Z' }));
    opened.value.db.close();
    value(await app.openWork(work.id));
    const reopened = value(await app.workflowRun(run.run.id));
    expect(reopened.steps[1]?.status).toBe('interrupted');
    expect(reopened.state).toBe('paused');
    deps.llmRequests.length = 0;
    const resumed = value(await app.advanceWorkflow(run.run.id));
    expect(deps.llmRequests).toHaveLength(0);
    expect(resumed.view.steps[1]).toMatchObject({ status: 'awaiting_author', attempt: 1 });
    expect(resumed.view.steps[1]?.output).toMatchObject({ title: seed.title });
  });

  it('停下：进行中的一步为中断；预算用完时停在下一步之前', async () => {
    const { deps, app } = await setup();
    const stop = new AbortController();
    const run = value(await app.startWorkflow({ workflow: 'quick_book', params, mode: 'step', budgetUsd: null }));
    deps.beforeLlm.push(() => {
      stop.abort();
      return Promise.resolve();
    });
    deps.llmResponses.push(reply(JSON.stringify(seed)));
    const stopped = value(await app.advanceWorkflow(run.run.id, { signal: stop.signal }));
    expect(stopped.view.steps[1]?.status).toBe('interrupted');
    expect(stopped.view.steps[1]?.note).toContain('已停下');

    // 有价格的模型：一次调用的费用超过预算后不再开始下一步。
    const priced = value(await app.loadModelServices()).models[0]!;
    value(await app.updateModel(priced, { displayName: priced.displayName, capabilities: priced.capabilities, prices: { input: 10_000, output: 10_000 } }));
    const tight = value(await app.startWorkflow({ workflow: 'quick_book', params, mode: 'auto', budgetUsd: 0.01 }));
    deps.llmResponses.push(reply(JSON.stringify(seed)));
    const capped = value(await app.advanceWorkflow(tight.run.id));
    expect(capped.view.steps.map((s) => s.status)).toEqual(['done', 'done', 'pending', 'pending', 'pending']);
    expect(capped.summary).toContain('预算上限');
    expect(capped.view.spent.cost).toBeGreaterThan(0.01);
  });

  it('撤回一次采用：作品回到采用之前，这一步回到等作者，后面已完成的标为可能过时；重做、跳过与保留', async () => {
    const { deps, app } = await setup();
    const run = value(await app.startWorkflow({ workflow: 'quick_book', params, mode: 'auto', budgetUsd: null }));
    deps.llmResponses.push(reply(JSON.stringify(seed)), reply(JSON.stringify(draft)));
    value(await app.advanceWorkflow(run.run.id, { hooks: fakeWriter().hooks }));
    expect(value(await app.listEntities()).map((e) => e.name).sort()).toEqual(['林舟', '钱四']);

    const withdrawn = value(await app.withdrawWorkflowStep(run.run.id, 1));
    expect(withdrawn.view.steps.map((s) => s.status)).toEqual(['done', 'awaiting_author', 'stale', 'stale', 'pending']);
    expect(value(await app.reloadWork()).project).toMatchObject({ title: '新作品', outline: '' });
    // 人物已被采用的章节计划用作出场人物，不能删，说明里写明没有改回。
    expect(value(await app.listEntities()).map((e) => e.name).sort()).toEqual(['林舟', '钱四']);
    expect(withdrawn.note).toContain('没有改回');
    expect(await app.withdrawWorkflowStep(run.run.id, 3)).toMatchObject({ ok: false });

    // 再采用；可能过时的计划保留，写章节重做。
    value(await app.adoptWorkflowStep(run.run.id, 1));
    const waiting = value(await app.advanceWorkflow(run.run.id));
    expect(waiting.summary).toContain('可能过时');
    value(await app.keepWorkflowStep(run.run.id, 2));
    value(await app.redoWorkflowStep(run.run.id, 3));
    value(await app.skipWorkflowStep(run.run.id, 3));
    const finished = value(await app.advanceWorkflow(run.run.id));
    expect(finished.view.steps.map((s) => s.status)).toEqual(['done', 'done', 'done', 'skipped', 'awaiting_author']);
    const abandoned = value(await app.abandonWorkflow(run.run.id));
    expect(abandoned.state).toBe('abandoned');
    expect(await app.adoptWorkflowStep(run.run.id, 4)).toMatchObject({ ok: false });
    expect(value(await app.listWorkflows()).map((v) => v.run.id)).toEqual([run.run.id]);
  });

  it('没写想法而作品已有大纲时跳过“大纲与人物”；没有大纲时这一步说明要先写想法', async () => {
    const { deps, app } = await setup();
    const none = value(await app.startWorkflow({ workflow: 'quick_book', params: { ...params, idea: ' ' }, mode: 'step', budgetUsd: null }));
    const failed = value(await app.advanceWorkflow(none.run.id));
    expect(failed.view.steps[1]).toMatchObject({ status: 'failed', note: expect.stringContaining('先写一句想法') });
    value(await app.updateWorkInfo({ outline: '开端：林舟当玉。结局：得知身世。' }));
    const run = value(await app.startWorkflow({ workflow: 'quick_book', params: { ...params, idea: '' }, mode: 'step', budgetUsd: null }));
    deps.llmResponses.push(reply(JSON.stringify(draft)));
    const out = value(await app.advanceWorkflow(run.run.id));
    expect(out.view.steps.map((s) => s.status)).toEqual(['done', 'skipped', 'awaiting_author', 'pending', 'pending']);
    expect(out.view.steps[1]?.note).toBe('没有写想法，沿用作品已有的大纲与人物');
  });

  it('两处同时采用同一步（成书页与 AI 助手）：只有一处采用成，草稿只写进作品一次', async () => {
    const { deps, app } = await setup();
    const run = value(await app.startWorkflow({ workflow: 'quick_book', params, mode: 'step', budgetUsd: null }));
    deps.llmResponses.push(reply(JSON.stringify(seed)));
    value(await app.advanceWorkflow(run.run.id));
    const [a, b] = await Promise.all([app.adoptWorkflowStep(run.run.id, 1), app.adoptWorkflowStep(run.run.id, 1)]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(value(await app.listEntities()).map((e) => e.name).sort()).toEqual(['林舟', '钱四']);
    expect(value(await app.workflowRun(run.run.id)).steps[1]?.status).toBe('done');
  });

  it('采用过的草稿先撤回再重做；写手被停下时写章节一步为中断，继续时接着做同一次', async () => {
    const { deps, app } = await setup();
    const run = value(await app.startWorkflow({ workflow: 'quick_book', params, mode: 'step', budgetUsd: null }));
    deps.llmResponses.push(reply(JSON.stringify(seed)));
    value(await app.advanceWorkflow(run.run.id));
    value(await app.adoptWorkflowStep(run.run.id, 1));
    expect(await app.redoWorkflowStep(run.run.id, 1)).toMatchObject({ ok: false, error: { code: 'settings', detail: expect.stringContaining('先“撤回这次采用”') } });
    value(await app.withdrawWorkflowStep(run.run.id, 1));
    expect(value(await app.redoWorkflowStep(run.run.id, 1)).steps[1]?.status).toBe('pending');

    // 跳到写章节：写手队列被停下（成书进度的“停下”）时这一步是中断而不是出错。
    value(await app.skipWorkflowStep(run.run.id, 1));
    value(await app.skipWorkflowStep(run.run.id, 2));
    value(await app.savePlan(value(await app.createChapter('第一章')).chapters[0]!.id, { goal: '当玉', castIds: [], beats: [], foreshadowPlant: [], foreshadowPayoff: [], treatment: '', targetWords: 2000 }));
    const stopped = value(await app.advanceWorkflow(run.run.id, { hooks: fakeWriter({ ok: false, summary: '写手停下了', cancelled: true }).hooks }));
    expect(stopped.view.steps[3]).toMatchObject({ status: 'interrupted', attempt: 1, note: '写手停下了' });
    expect(stopped.summary).toContain('停在第 4 步');
    const again = value(await app.advanceWorkflow(run.run.id, { hooks: fakeWriter().hooks }));
    expect(again.view.steps[3]).toMatchObject({ status: 'done', attempt: 1 });
  });

  it('预算在一步中途用完：这一步停下（中断）、用量已记下，继续时接着做同一次', async () => {
    const { deps, app } = await setup();
    const priced = value(await app.loadModelServices()).models[0]!;
    value(await app.updateModel(priced, { displayName: priced.displayName, capabilities: priced.capabilities, prices: { input: 10_000, output: 10_000 } }));
    const write = async (title: string, text: string) => {
      const id = value(await app.createChapter(title)).chapters.find((c) => c.title === title)!.id;
      const opened = value(await app.openChapter(id));
      value(await app.saveChapter(id, opened.saved, [{ id: `p-${title}`, text, source: 'handwritten' }], { splits: [], merges: [] }));
    };
    await write('第一章', '林舟当玉。');
    await write('第二章', '钱四起疑。');
    const run = value(await app.startWorkflow({ workflow: 'book_audit', params: { from: null, to: null, rereview: false }, mode: 'auto', budgetUsd: 0.01 }));
    // 第一章的长篇记忆一次调用就超过上限：第二章不再调用，这一步中断。
    deps.llmResponses.push(reply(JSON.stringify({ summary: '林舟当玉。', cast: [], foreshadows: [], openThreads: [] })));
    const out = value(await app.advanceWorkflow(run.run.id));
    expect(out.view.steps[0]).toMatchObject({ status: 'interrupted', note: expect.stringContaining('预算上限') });
    expect(out.view.steps[0]?.usage?.cost).toBeGreaterThan(0.01);
    expect(out.summary).toContain('停在第 1 步');
    expect(deps.llmRequests).toHaveLength(1);
    // 预算没提高：下一次继续在这一步之前就停。
    expect(value(await app.advanceWorkflow(run.run.id)).summary).toContain('预算上限');
  });

  it('模型步骤的步骤键为“workflow:运行:步骤:第几次”', async () => {
    const { deps, app } = await setup();
    const run = value(await app.startWorkflow({ workflow: 'quick_book', params, mode: 'step', budgetUsd: null }));
    deps.llmResponses.push(reply(JSON.stringify(seed)));
    value(await app.advanceWorkflow(run.run.id));
    const calls = value(await app.usage()).recent;
    expect(calls.map((c) => c.stepKey)).toContain(`workflow:${run.run.id}:seed:1`);
  });
});

describe('全书体检（B80）', () => {
  async function twoChapters(app: Awaited<ReturnType<typeof setup>>['app']) {
    const write = async (title: string, text: string) => {
      const id = value(await app.createChapter(title)).chapters.find((c) => c.title === title)!.id;
      const opened = value(await app.openChapter(id));
      value(await app.saveChapter(id, opened.saved, [{ id: `p-${title}`, text, source: 'handwritten' }], { splits: [], merges: [] }));
      return id;
    };
    const first = await write('第一章', '官差把钱四押进了大牢。');
    const second = await write('第二章', '钱四在柜台后拨着算盘，招呼客人。');
    return { first, second };
  }
  const memory = (summary: string) => reply(JSON.stringify({ summary, cast: [], foreshadows: [], openThreads: [] }));
  const noIssues = () => reply(JSON.stringify({ issues: [] }));

  it('补齐记忆、依次审核、找疑点（作者确认）、读原文定位：问题记在后一章，依据是前一章的段落；前一章那段改过后问题过期', async () => {
    const { deps, app } = await setup();
    const { first, second } = await twoChapters(app);
    const run = value(await app.startWorkflow({ workflow: 'book_audit', params: { from: null, to: null, rereview: false }, mode: 'step', budgetUsd: null }));
    expect(run.steps.map((s) => s.key)).toEqual(['memory', 'review', 'foreshadow', 'suspects', 'locate', 'report']);
    deps.llmResponses.push(
      memory('钱四被押进大牢。'),
      memory('钱四在当铺招呼客人。'),
      noIssues(),
      noIssues(),
      reply(
        JSON.stringify({
          suspects: [
            { earlier: 'C1', later: 'C2', kind: 'character', about: 'C1 钱四进了大牢，C2 他却在当铺', severity: 'high' },
            // 前后颠倒的丢弃。
            { earlier: 'C2', later: 'C1', kind: 'timeline', about: '颠倒', severity: 'low' },
          ],
        }),
      ),
    );
    const first1 = value(await app.advanceWorkflow(run.run.id));
    expect(first1.view.steps.map((s) => s.status)).toEqual(['done', 'done', 'done', 'awaiting_author', 'pending', 'pending']);
    expect(first1.view.steps[0]?.note).toBe('整理了 2 章的长篇记忆');
    expect(first1.view.steps[1]?.note).toContain('审完了 2 章');
    expect(first1.view.steps[3]?.output).toMatchObject({ suspects: [{ earlierId: first, laterId: second, kind: 'character' }], dropped: 1 });

    value(await app.adoptWorkflowStep(run.run.id, 3));
    deps.llmResponses.push(
      reply(
        JSON.stringify({
          issues: [
            { paragraph: 'P1', quote: '钱四在柜台后拨着算盘', kind: 'character', severity: 'high', evidence: ['A1'], description: '第一章钱四已被押进大牢', suggestion: '交代他怎么出来的' },
            // 没有前一章的段落作依据的丢弃。
            { paragraph: 'P1', quote: '招呼客人', kind: 'pacing', severity: 'low', evidence: [], description: '无关', suggestion: '' },
          ],
        }),
      ),
    );
    const done = value(await app.advanceWorkflow(run.run.id));
    expect(done.view.state).toBe('done');
    expect(done.view.steps[4]?.output).toEqual({ issues: 1, unconfirmed: 0, dropped: 1, failed: 0 });
    expect(done.view.steps[5]?.note).toContain('跨章连贯 1 条');
    const issues = value(await app.reviewIssues(second));
    const continuity = issues.filter((i) => i.source === 'continuity');
    expect(continuity).toHaveLength(1);
    expect(continuity[0]?.evidenceText).toEqual(['《第一章》的段落：官差把钱四押进了大牢。']);

    // 单章重新审核不冲掉体检的问题（来源不同）。
    deps.llmResponses.push(noIssues());
    value(await app.reviewChapter(second));
    expect(value(await app.reviewIssues(second)).filter((i) => i.source === 'continuity')).toHaveLength(1);

    // 前一章那一段改过：问题过期。
    const opened = value(await app.openChapter(first));
    value(await app.saveChapter(first, opened.saved, [{ id: opened.saved[0]!.id, text: '官差把钱四押进了大牢，第二天又放了。', source: 'handwritten' }], { splits: [], merges: [] }));
    expect(value(await app.reviewIssues(second)).filter((i) => i.source === 'continuity')).toEqual([]);
  });

  it('几处疑点里有没核对成的：这一步中断、什么也不写；继续时核对成的不再请求；只体检后面的章节不冲掉首章已有的连贯问题', async () => {
    const { deps, app } = await setup();
    const { first, second } = await twoChapters(app);
    const run = value(await app.startWorkflow({ workflow: 'book_audit', params: { from: null, to: null, rereview: false }, mode: 'auto', budgetUsd: null }));
    const suspect = (about: string) => ({ earlier: 'C1', later: 'C2', kind: 'character', about, severity: 'high' });
    const issue = (quote: string, description: string) => ({ paragraph: 'P1', quote, kind: 'character', severity: 'high', evidence: ['A1'], description, suggestion: '' });
    deps.llmResponses.push(memory('钱四被押进大牢。'), memory('钱四在当铺招呼客人。'), noIssues(), noIssues(), reply(JSON.stringify({ suspects: [suspect('大牢与当铺'), suspect('算盘')] })));
    deps.llmResponses.push(reply(JSON.stringify({ issues: [issue('钱四在柜台后', '第一章钱四已被押进大牢')] })), { status: 400, body: '{"error":{"message":"坏请求"}}' });
    const out = value(await app.advanceWorkflow(run.run.id));
    expect(out.view.steps[4]).toMatchObject({ status: 'interrupted', attempt: 1, note: expect.stringContaining('1 处疑点没有核对成') });
    expect(value(await app.reviewIssues(second)).filter((i) => i.source === 'continuity')).toEqual([]);

    deps.llmRequests.length = 0;
    deps.llmResponses.push(reply(JSON.stringify({ issues: [issue('拨着算盘', '他在牢里没有算盘')] })));
    const done = value(await app.advanceWorkflow(run.run.id));
    expect(done.view.state).toBe('done');
    expect(deps.llmRequests).toHaveLength(1);
    expect(done.view.steps[4]).toMatchObject({ status: 'done', attempt: 1, output: { issues: 2, failed: 0 } });
    expect(value(await app.reviewIssues(second)).filter((i) => i.source === 'continuity')).toHaveLength(2);

    // 只体检第二章：它前面的章节不在范围里，这次没有查那一对章节，已有的连贯问题不换掉。
    const part = value(await app.startWorkflow({ workflow: 'book_audit', params: { from: second, to: second, rereview: false }, mode: 'auto', budgetUsd: null }));
    // 这些章没有章节计划、不算审核过：依次审核再审一次第二章。
    deps.llmResponses.push(noIssues());
    expect(value(await app.advanceWorkflow(part.run.id)).view.state).toBe('done');
    expect(value(await app.reviewIssues(second)).filter((i) => i.source === 'continuity')).toHaveLength(2);
    void first;
  });

  it('只有一章时不找疑点；伏笔核对列出到期未回收的；再体检时记忆是最新的不再整理', async () => {
    const { deps, app } = await setup();
    const { first } = await twoChapters(app);
    value(await app.addForeshadow({ title: '玉佩', content: '钱四多看了一眼', reveal: '', plantChapterId: null, plantAnchor: null, payoffChapterId: first, payoffAnchor: null, status: 'planted' }));
    const run = value(await app.startWorkflow({ workflow: 'book_audit', params: { from: first, to: first, rereview: false }, mode: 'auto', budgetUsd: null }));
    deps.llmResponses.push(memory('钱四被押进大牢。'), noIssues());
    const out = value(await app.advanceWorkflow(run.run.id));
    expect(out.view.state).toBe('done');
    expect(out.view.steps[2]).toMatchObject({ note: '到期未回收 1 条', output: { findings: [{ title: '玉佩', problem: 'overdue', chapterId: first }] } });
    expect(out.view.steps[3]?.note).toBe('没有找到跨章的疑点');
    expect(out.view.steps[4]?.note).toBe('没有要核对的疑点');
    const again = value(await app.startWorkflow({ workflow: 'book_audit', params: { from: first, to: first, rereview: false }, mode: 'auto', budgetUsd: null }));
    deps.llmResponses.push(noIssues());
    const second = value(await app.advanceWorkflow(again.run.id));
    expect(second.view.steps[0]?.note).toBe('范围内 1 章的长篇记忆都是最新的');
  });
});

describe('续写一卷（B82）', () => {
  it('补齐记忆、卷纲（采用后新建一卷与人物、伏笔）、只给这一卷拆章、写手写这一卷；前面的章节与计划不变', async () => {
    const { deps, app } = await setup();
    const firstId = value(await app.createChapter('第一章 夜叩')).chapters[0]!.id;
    const opened = value(await app.openChapter(firstId));
    value(await app.saveChapter(firstId, opened.saved, [{ id: 'p1', text: '林舟当了玉，钱四认出了它。', source: 'handwritten' }], { splits: [], merges: [] }));
    value(await app.savePlan(firstId, { goal: '当玉', castIds: [], beats: ['叩门'], foreshadowPlant: [], foreshadowPayoff: [], treatment: '', targetWords: 2000 }));
    const run = value(await app.startWorkflow({ workflow: 'next_volume', params: { chapters: 2, wordsPerChapter: 2000, instruction: '节奏快一些' }, mode: 'step', budgetUsd: null }));
    const outline = {
      title: '第二卷 归乡',
      summary: '林舟带着玉佩回乡寻亲。',
      mainline: ['离开当铺', '回到故乡', '找到旧宅'],
      climax: '旧宅里藏着父亲的信。',
      newCharacters: [{ name: '阿青', description: '同乡的少女' }],
      payoffs: [],
      newForeshadows: [{ title: '父亲的信', content: '墙缝里露出一角纸', reveal: '信里写着身世' }],
    };
    deps.llmResponses.push(reply(JSON.stringify({ summary: '林舟当玉。', cast: [], foreshadows: [], openThreads: ['钱四要找人打听玉的来历'] })), reply(JSON.stringify(outline)));
    const first = value(await app.advanceWorkflow(run.run.id));
    expect(first.view.steps.map((s) => s.status)).toEqual(['done', 'awaiting_author', 'pending', 'pending', 'pending']);
    const outlineBody = JSON.stringify(deps.llmRequests.at(-1)?.body ?? {});
    for (const part of ['这一卷约 2 章', '节奏快一些', '最后一章章尾留下的事', '钱四要找人打听玉的来历']) expect(outlineBody).toContain(part);

    const adoptedOutline = value(await app.adoptWorkflowStep(run.run.id, 1));
    const work = value(await app.reloadWork());
    expect(work.volumes.map((v) => [v.title, v.summary])).toEqual([['第二卷 归乡', '林舟带着玉佩回乡寻亲。\n主线：离开当铺；回到故乡；找到旧宅\n卷末：旧宅里藏着父亲的信。']]);
    expect(value(await app.listEntities()).map((e) => e.name)).toEqual(['阿青']);
    // 采用时记下新建的那一卷：作者改了卷名，后面的步骤照样找得到。
    expect(adoptedOutline.steps[1]?.output).toMatchObject({ volumeId: work.volumes[0]!.id });
    value(await app.updateVolume(work.volumes[0]!, { title: '第二卷 归乡路', summary: work.volumes[0]!.summary }));

    const plan = {
      chapters: [
        { volume: '第二卷 归乡', title: '第二章 离开', goal: '离开当铺', cast: ['阿青'], beats: ['收拾行李'], plant: ['父亲的信'], payoff: [], treatment: '', targetWords: 2000 },
        { volume: '第二卷 归乡', title: '第三章 旧宅', goal: '找到旧宅', cast: ['林舟'], beats: ['推开门'], plant: [], payoff: ['父亲的信'], treatment: '', targetWords: 2000 },
      ],
      foreshadows: [],
    };
    deps.llmResponses.push(reply(JSON.stringify(plan)));
    const second = value(await app.advanceWorkflow(run.run.id));
    expect(second.view.steps[2]?.status).toBe('awaiting_author');
    const planBody = JSON.stringify(deps.llmRequests.at(-1)?.body ?? {});
    for (const part of ['只给新的一卷“第二卷 归乡路”拆 2 章', '新的一卷：第二卷 归乡路', '最近几章的梗概', '第一章 夜叩：林舟当玉。']) expect(planBody).toContain(part);

    value(await app.adoptWorkflowStep(run.run.id, 2));
    const view = value(await app.planningView());
    expect(view.chapters.map((c) => [c.chapter.title, c.chapter.volumeId === null ? '未分卷' : '第二卷'])).toEqual([
      ['第一章 夜叩', '未分卷'],
      ['第二章 离开', '第二卷'],
      ['第三章 旧宅', '第二卷'],
    ]);
    expect(view.chapters[0]?.plan?.goal).toBe('当玉');
    const letter = view.foreshadows.find((f) => f.title === '父亲的信');
    expect(letter).toMatchObject({ plantChapterId: view.chapters[1]?.chapter.id, payoffChapterId: view.chapters[2]?.chapter.id });

    const writer = fakeWriter();
    const third = value(await app.advanceWorkflow(run.run.id, { hooks: writer.hooks }));
    expect(writer.calls).toEqual([{ ids: [view.chapters[1]!.chapter.id, view.chapters[2]!.chapter.id], review: true }]);
    expect(third.view.state).toBe('done');
    // 写手是替身，新卷没有正文：本卷体检说明没有体检。
    expect(third.view.steps[4]?.note).toBe('这一卷还没有写好的章节，没有体检');
  });

  it('还没有写好的章节时第一步说明先写几章，不调用模型', async () => {
    const { deps, app } = await setup();
    const run = value(await app.startWorkflow({ workflow: 'next_volume', params: { chapters: 2, wordsPerChapter: 2000, instruction: '' }, mode: 'auto', budgetUsd: null }));
    const out = value(await app.advanceWorkflow(run.run.id));
    expect(out.view.steps[0]).toMatchObject({ status: 'failed', note: expect.stringContaining('还没有写好的章节') });
    expect(deps.llmRequests.filter((r) => JSON.stringify(r.body).includes('volume_outline'))).toHaveLength(0);
  });
});

describe('开篇打磨（B81）', () => {
  it('算出数字、逐章诊断（问题记为开篇诊断）、停下等作者处理、复诊、对比前后；单章审核不冲掉开篇的问题', async () => {
    const { deps, app } = await setup();
    value(await app.createEntity('character', '林舟'));
    const write = async (title: string, text: string) => {
      const id = value(await app.createChapter(title)).chapters.find((c) => c.title === title)!.id;
      const opened = value(await app.openChapter(id));
      value(await app.saveChapter(id, opened.saved, [{ id: `p-${title}`, text, source: 'handwritten' }], { splits: [], merges: [] }));
      return id;
    };
    const first = await write('第一章', '雨下了一夜，街上没有人。林舟推开当铺的门。');
    await write('第二章', '林舟把玉放在柜台上。');
    const run = value(await app.startWorkflow({ workflow: 'opening_polish', params: { chapters: 2 }, mode: 'auto', budgetUsd: null }));
    const issue = { paragraph: 'P1', quote: '雨下了一夜，街上没有人', kind: 'pacing', severity: 'high', evidence: [], description: '从天气写起，主角在第 10 字之后才出场', suggestion: '从推门写起' };
    deps.llmResponses.push(reply(JSON.stringify({ issues: [issue] })), reply(JSON.stringify({ issues: [] })));
    const out = value(await app.advanceWorkflow(run.run.id));
    // 处理问题须作者动手：一路做完也停在这里。
    expect(out.view.steps.map((s) => s.status)).toEqual(['done', 'done', 'awaiting_author', 'pending', 'pending']);
    expect(out.view.steps[0]?.note).toBe('主角：林舟；《第一章》主角在第 10 字之后出场');
    expect(out.view.steps[1]?.note).toContain('前 2 章诊断出 1 个问题');
    const body = JSON.stringify(deps.llmRequests.at(-2)?.body ?? {});
    for (const part of ['现在诊断第 1 章', '主角第一次出现在第 10 字之后']) expect(body).toContain(part);
    expect(value(await app.reviewIssues(first)).filter((i) => i.source === 'opening')).toHaveLength(1);
    // 单章审核换的是模型与程序的问题。
    deps.llmResponses.push(reply(JSON.stringify({ issues: [] })));
    value(await app.reviewChapter(first));
    expect(value(await app.reviewIssues(first)).filter((i) => i.source === 'opening')).toHaveLength(1);

    // 作者把开头改了，处理完了：复诊。
    const opened = value(await app.openChapter(first));
    value(await app.saveChapter(first, opened.saved, [{ id: opened.saved[0]!.id, text: '林舟推开当铺的门，雨水顺着衣角往下滴。', source: 'handwritten' }], { splits: [], merges: [] }));
    value(await app.adoptWorkflowStep(run.run.id, 2));
    deps.llmResponses.push(reply(JSON.stringify({ issues: [] })), reply(JSON.stringify({ issues: [] })));
    const done = value(await app.advanceWorkflow(run.run.id));
    expect(done.view.state).toBe('done');
    expect(done.view.steps[4]?.note).toBe('开篇问题从 1 个变为 0 个');
    expect(done.view.steps[4]?.output).toMatchObject({ rows: [{ title: '第一章', before: { issues: 1, metrics: { protagonistAt: 10 } }, after: { issues: 0, metrics: { protagonistAt: 0 } } }, { title: '第二章' }] });
    expect(value(await app.reviewIssues(first)).filter((i) => i.source === 'opening')).toEqual([]);
  });

  it('最前面的几章还没有正文时第一步说明原因', async () => {
    const { app } = await setup();
    value(await app.createChapter('第一章'));
    const run = value(await app.startWorkflow({ workflow: 'opening_polish', params: { chapters: 3 }, mode: 'step', budgetUsd: null }));
    const out = value(await app.advanceWorkflow(run.run.id));
    expect(out.view.steps[0]).toMatchObject({ status: 'failed', note: expect.stringContaining('还没有正文') });
  });
});

describe('人物小传与关系网补全（B83）', () => {
  it('找出缺口、生成草稿（标签与名字对不上的、锁定的丢弃）；取消勾选的不采用；已有说明的补充、空的写上；撤回后改回', async () => {
    const { deps, app } = await setup();
    const lin = value(await app.createEntity('character', '林舟')).created;
    value(await app.updateEntity(lin, { description: '落魄书生' }));
    const qianId = value(await app.createEntity('character', '钱四')).created;
    value(await app.updateEntity(qianId, { aliases: ['钱掌柜'] }));
    const wang = value(await app.createEntity('character', '王掌柜')).created;
    value(await app.setEntityLocked(wang, true));
    const write = async (title: string, text: string) => {
      const id = value(await app.createChapter(title)).chapters.find((c) => c.title === title)!.id;
      const opened = value(await app.openChapter(id));
      value(await app.saveChapter(id, opened.saved, [{ id: `p-${title}`, text, source: 'handwritten' }], { splits: [], merges: [] }));
      return id;
    };
    const c1 = await write('第一章', '林舟把玉押给钱四。');
    await write('第二章', '同乡阿青来找林舟。');
    const memory = (summary: string, cast: { name: string; state: string }[]) => reply(JSON.stringify({ summary, cast, foreshadows: [], openThreads: [] }));
    deps.llmResponses.push(
      memory('林舟把玉押给钱四。', [
        { name: '林舟', state: '欠了钱' },
        { name: '钱四', state: '收下玉' },
      ]),
      memory('阿青来找林舟。', [{ name: '林舟', state: '见到同乡' }]),
      reply(
        JSON.stringify({
          characters: [
            { name: '钱四', isNew: false, identity: '当铺掌柜', look: '正文未交代', personality: '精明', motive: '想弄清玉的来历', voice: '说话慢', firstChapter: 'C1', basis: ['C1'] },
            { name: '阿青', isNew: true, identity: '林舟的同乡', look: '', personality: '直爽', motive: '', voice: '', firstChapter: 'C2', basis: ['C2'] },
            { name: '王掌柜', isNew: false, identity: '改不得', look: '', personality: '', motive: '', voice: '', firstChapter: '', basis: ['C1'] },
            { name: '林舟', isNew: false, identity: '书生', look: '', personality: '', motive: '', voice: '', firstChapter: 'C1', basis: ['C9'] },
            // 同一个人用别名又列了一次：丢弃。
            { name: '钱掌柜', isNew: false, identity: '掌柜', look: '', personality: '', motive: '', voice: '', firstChapter: 'C1', basis: ['C1'] },
          ],
          relationships: [
            { from: '钱四', to: '林舟', category: 'other', label: '债主', mutual: false, description: '林舟押玉欠了钱', secret: false, fromChapter: 'C1', basis: ['C1'] },
            { from: '阿青', to: '林舟', category: 'ally', label: '同乡', mutual: true, description: '', secret: false, fromChapter: '', basis: ['C2'] },
            // 互为的关系反过来写是同一条：丢弃。
            { from: '林舟', to: '阿青', category: 'ally', label: '同乡', mutual: true, description: '', secret: false, fromChapter: '', basis: ['C2'] },
            { from: '李五', to: '林舟', category: 'enemy', label: '仇人', mutual: false, description: '', secret: false, fromChapter: '', basis: ['C2'] },
          ],
        }),
      ),
    );
    const run = value(await app.startWorkflow({ workflow: 'cast_completion', params: {}, mode: 'step', budgetUsd: null }));
    const out = value(await app.advanceWorkflow(run.run.id));
    expect(out.view.steps.map((s) => s.status)).toEqual(['done', 'done', 'awaiting_author']);
    expect(out.view.steps[1]?.note).toBe('说明为空的人物 2 个，出场却没有关系的 2 个');
    const draft = out.view.steps[2]?.output as { characters: { name: string; entityId: string | null; selected: boolean }[]; relationships: { from: string }[]; dropped: number };
    expect(draft.characters.map((c) => [c.name, c.entityId === null])).toEqual([
      ['钱四', false],
      ['阿青', true],
    ]);
    expect(draft.relationships.map((r) => r.from)).toEqual(['钱四', '阿青']);
    expect(draft.dropped).toBe(5);

    // 不要阿青：她的关系也建不了，写明原因。
    value(await app.editWorkflowStep(run.run.id, 2, { ...draft, characters: draft.characters.map((c) => ({ ...c, selected: c.name !== '阿青' })) }));
    const adopted = value(await app.adoptWorkflowStep(run.run.id, 2));
    expect(adopted.steps[2]?.note).toContain('补充说明 1 个，新建关系 1 条');
    expect(adopted.steps[2]?.note).toContain('阿青与林舟的关系');
    const qian = value(await app.listEntities()).find((e) => e.name === '钱四')!;
    expect(qian.description).toBe('身份：当铺掌柜；性格：精明；动机与目标：想弄清玉的来历；说话方式：说话慢；首次出场：《第一章》');
    expect(value(await app.listEntities()).map((e) => e.name).sort()).toEqual(['林舟', '王掌柜', '钱四'].sort());
    const relations = value(await app.relationsView()).relationships;
    expect(relations.map((r) => [r.label, r.validFromChapterId])).toEqual([['债主', c1]]);

    const withdrawn = value(await app.withdrawWorkflowStep(run.run.id, 2));
    expect(withdrawn.view.steps[2]?.status).toBe('awaiting_author');
    expect(value(await app.listEntities()).find((e) => e.name === '钱四')?.description).toBe('');
    expect(value(await app.relationsView()).relationships).toEqual([]);
  });
});

describe('扫榜拆书（B79）', () => {
  // 金丝雀：样章原文里的标记只能出现在逐本拆解的请求里。
  const CANARY = '金丝雀样章七号';
  const sample = `第一章 雨夜\n${`林舟推开当铺沉重的木门时，雨水顺着衣角落在青石板上，${CANARY}。`.repeat(8)}`;
  const analysis = {
    genre: '古风悬疑',
    // 模型抄了一长段样章：复述检查截短。
    sellingPoints: ['身份反差', `开头：${sample.slice(7, 50)}`],
    hook: '雨夜当玉，主角第一段就出场',
    pacing: [{ chapter: '第一章', role: '亮出困境', beats: '被压价' }],
    cast: [{ role: '主角', description: '落魄书生' }],
    conflict: '身世之谜',
    chapterHooks: '章末留下疑问',
    techniques: ['先抑后扬'],
    quotes: [{ text: '这一段引文写得太长了超过了三十个字的上限所以要截短才行，还要再多写几个字', why: '环境与人物同时出场' }],
  };
  const compare = {
    common: ['开局即困境'],
    gaps: ['女性视角的当铺故事'],
    borrow: ['章末留疑问'],
    directions: [{ idea: '女掌柜收下一件会说话的旧物', why: '补了女性视角的空位' }],
    skill: '开局三百字内让主角陷入困境；每章末留一个疑问；人物按主角、对手、引路人配置。',
  };

  it('导入、逐本拆解（复述检查）、对标分析（只读拆解）、存为规划技能、删除样章；样章原文不出现在之后的任何请求与导出里', async () => {
    const { deps, app } = await setup();
    expect(await app.startWorkflow({ workflow: 'benchmark', params: { idea: '', entries: 1 }, mode: 'step', budgetUsd: null })).toMatchObject({ ok: false });
    expect(await app.startBenchmark({ rankText: '1. 夜当', books: [{ title: '夜当', text: '太短' }], idea: '', mode: 'step', budgetUsd: null })).toMatchObject({ ok: false, error: { code: 'settings' } });

    const run = value(await app.startBenchmark({ rankText: '1. 夜当\n标签：古风\n简介：落魄书生当玉。\n\n2. 剑来\n标签：仙侠', books: [{ title: '夜当', text: sample }], idea: '女掌柜', mode: 'step', budgetUsd: null }));
    expect(run.run.params).toEqual({ idea: '女掌柜', entries: 2 });
    expect(JSON.stringify(run)).not.toContain(CANARY);
    deps.llmResponses.push(reply(JSON.stringify(analysis)), reply(JSON.stringify(compare)));
    deps.llmRequests.length = 0;
    const out = value(await app.advanceWorkflow(run.run.id));
    expect(out.view.steps.map((s) => s.status)).toEqual(['done', 'done', 'awaiting_author', 'pending']);
    expect(out.view.steps[0]?.note).toBe(`榜单 2 条，其中 1 本有样章（共 ${sample.trim().length.toLocaleString('en-US')} 字）`);
    const analyzed = out.view.steps[1]?.output as { analyses: { analysis: typeof analysis; trimmed: number }[] };
    expect(analyzed.analyses[0]?.trimmed).toBe(2);
    expect(analyzed.analyses[0]?.analysis.sellingPoints[1]).toBe(`开头：${sample.slice(7, 37)}……`);
    expect(analyzed.analyses[0]?.analysis.quotes[0]?.text).toHaveLength(32);
    expect(JSON.stringify(out.view.steps[1]?.output)).not.toContain(CANARY);
    // 逐本拆解的请求带样章；对比的请求只有拆解。
    const [book, compared] = deps.llmRequests.map((r) => JSON.stringify(r.body));
    expect(book).toContain(CANARY);
    expect(compared).not.toContain(CANARY);
    expect(compared).toContain('作者自己的想法：女掌柜');
    expect(compared).toContain('剑来');
    // 样章在对比一结束就删掉，不等作者采用。
    expect(value(await app.benchmarkBooks(run.run.id))).toEqual([]);
    expect(out.view.steps[2]?.note).toContain('样章原文已从作品库删除');

    value(await app.adoptWorkflowStep(run.run.id, 2));
    const skills = value(await app.listWritingSkills()).skills.find((s) => s.skill.name === '对标分析');
    expect(skills?.skill).toMatchObject({ stages: ['planning'] });
    const done = value(await app.advanceWorkflow(run.run.id));
    expect(done.view.state).toBe('done');
    expect(value(await app.benchmarkBooks(run.run.id))).toEqual([]);

    // 之后的规划请求带对标分析的规划技能，不带样章。
    deps.llmRequests.length = 0;
    deps.llmResponses.push(reply(JSON.stringify({ title: '旧物', genre: '', synopsis: '', outline: '大纲', characters: [], relationships: [] })));
    value(await app.draftBookSeed({ idea: '女掌柜收旧物', genre: '', chapterCount: 3, wordsPerChapter: 2000 }));
    const seedBody = JSON.stringify(deps.llmRequests[0]?.body ?? {});
    expect(seedBody).toContain('开局三百字内让主角陷入困境');
    expect(seedBody).not.toContain(CANARY);
    value(await app.exportProject());
    expect(JSON.stringify(deps.exportedPackages.at(-1)?.files ?? [])).not.toContain(CANARY);
  });

  it('放弃时删除样章；作品包导出时样章不在里面；重新打开作品时还在用的样章保留', async () => {
    const { deps, app } = await setup();
    const run = value(await app.startBenchmark({ rankText: '', books: [{ title: '夜当', text: sample }], idea: '', mode: 'step', budgetUsd: null }));
    value(await app.exportProject());
    expect(JSON.stringify(deps.exportedPackages.at(-1)?.files ?? [])).not.toContain(CANARY);
    expect(value(await app.benchmarkBooks(run.run.id))).toHaveLength(1);
    const work = value(await app.loadLibrary()).works[0]!;
    await app.closeWork();
    value(await app.openWork(work.id));
    expect(value(await app.benchmarkBooks(run.run.id))).toHaveLength(1);
    value(await app.abandonWorkflow(run.run.id));
    expect(value(await app.benchmarkBooks(run.run.id))).toEqual([]);
    expect(value(await app.workflowRun(run.run.id)).state).toBe('abandoned');
  });
});
