import { rmSync } from 'node:fs';
import type { AssistantTurnOutput } from '@fudiao/prompts';
import { afterEach, describe, expect, it } from 'vitest';
import { fsDeps, type TestDeps } from '../testing/fs-deps';
import { addTestedModel, reply } from '../testing/models';
import type { AssistantItem } from './assistant';
import type { BackgroundJob, BackgroundJobs } from './assistant-tools';
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
  value(await app.createWork('当铺夜谈'));
  await addTestedModel(app, deps);
  return { deps, app };
}

const step = (deps: TestDeps, output: AssistantTurnOutput) => deps.llmResponses.push(reply(JSON.stringify(output)));
const lastBody = (deps: TestDeps) => JSON.stringify(deps.llmRequests.at(-1)?.body ?? {});
const lastResults = (items: readonly AssistantItem[]) => items.filter((i): i is Extract<AssistantItem, { role: 'results' }> => i.role === 'results').at(-1);

/** 状态层的后台：排上的单章任务先记下，测试决定什么时候让它做。 */
function backgroundJobs() {
  const jobs: BackgroundJob[] = [];
  const done = new Set<BackgroundJob>();
  const background: BackgroundJobs = {
    writeChapters: () => null,
    reviewChapters: () => null,
    simulating: () => false,
    writing: () => jobs.filter((j) => !done.has(j) && j.kind !== 'review').map((j) => j.chapterId),
    simulate: () => null,
    stop: () => '',
    run(job) {
      jobs.push(job);
      return Promise.resolve(null);
    },
  };
  const finish = async (job: BackgroundJob) => {
    const outcome = await job.work({});
    done.add(job);
    return outcome;
  };
  return { background, jobs, finish };
}

describe('AI 助手把单章的写作、审核与修订交给后台（M5-23）', () => {
  it('写手写章：排上就返回；写完后下一句话的现状里有结果（只说一次）；撤销发起的那一轮时回退写手写入', async () => {
    const { deps, app } = await setup();
    const id = value(await app.createChapter('第一章 夜叩')).chapters[0]!.id;
    value(await app.savePlan(id, { goal: '林舟当玉', castIds: [], beats: ['叩门', '压价'], foreshadowPlant: [], foreshadowPayoff: [], treatment: '', targetWords: 3000 }));
    const { background, jobs, finish } = backgroundJobs();

    const before = deps.llmRequests.length;
    step(deps, { message: '', actions: [{ tool: 'write_chapter', chapter: '第一章 夜叩' }], done: false });
    step(deps, { message: '写手在后台写第一章了。', actions: [], done: true });
    const queued = value(await app.sendToAssistant('写第一章', { background }));
    expect(lastResults(queued.items)?.results[0]).toMatchObject({ tool: 'write_chapter', ok: true, detail: expect.stringMatching(/^已排上：在后台写手写《第一章 夜叩》/) });
    expect(jobs.map((j) => [j.kind, j.chapterId, j.title])).toEqual([['writing', id, '写手写 · 第一章 夜叩']]);
    // 这一轮只有助手的两步，写手还没有动笔。
    expect(deps.llmRequests.length - before).toBe(2);
    expect(value(await app.openChapter(id)).saved.map((p) => p.text).join('')).toBe('');

    // 写手写着的时候不对这一章再发起修订：直接说明。
    step(deps, { message: '', actions: [{ tool: 'write_chapter', chapter: '第一章 夜叩' }], done: false });
    step(deps, { message: '还在写。', actions: [], done: true });
    const again = value(await app.sendToAssistant('再写一遍第一章', { background }));
    expect(lastResults(again.items)?.results[0]).toMatchObject({ ok: false, detail: expect.stringContaining('正在后台写作或修订') });
    expect(jobs).toHaveLength(1);

    deps.llmResponses.push(reply('林舟又叩响了门。'), reply('钱四压低了价。'), reply(JSON.stringify({ summary: '林舟叩门当玉。', cast: [], foreshadows: [], openThreads: [] })));
    expect(await finish(jobs[0]!)).toMatchObject({ ok: true, detail: expect.stringContaining('长篇记忆已整理') });
    expect(value(await app.openChapter(id)).saved.map((p) => p.text)).toEqual(['林舟又叩响了门。', '钱四压低了价。']);

    step(deps, { message: '第一章写完了。', actions: [], done: true });
    value(await app.sendToAssistant('写好了吗', { background }));
    expect(lastBody(deps)).toContain('后台刚做完的（上一句话之后）');
    expect(lastBody(deps)).toContain('写手写《第一章 夜叩》：写手已写完《第一章 夜叩》');
    step(deps, { message: '好的。', actions: [], done: true });
    value(await app.sendToAssistant('谢谢', { background }));
    expect(lastBody(deps)).not.toContain('后台刚做完的（上一句话之后）');

    // 改动记在发起写作的那一轮（“写第一章”）：之后两轮没有改动，撤销的就是它。
    const undone = value(await app.undoAssistantTurn());
    expect(undone.items.at(-1)).toMatchObject({ role: 'undo', ok: true, report: expect.stringContaining('写手写入的《第一章 夜叩》') });
    expect(value(await app.openChapter(id)).saved.map((p) => p.text).join('')).toBe('');
  });

  it('审核与修订：排上就返回，做完的结果写进之后的现状；没有后台时就地做完', async () => {
    const { deps, app } = await setup();
    const chapterId = value(await app.createChapter('第一章 夜叩')).chapters[0]!.id;
    const opened = value(await app.openChapter(chapterId));
    value(await app.saveChapter(chapterId, opened.saved, [{ id: 'p0', text: '林舟推门进来，雨水顺着衣角往下滴。', source: 'handwritten' }], { splits: [], merges: [] }));
    const { background, jobs, finish } = backgroundJobs();

    step(deps, { message: '', actions: [{ tool: 'review_chapter', chapter: '夜叩' }], done: true });
    value(await app.sendToAssistant('审核第一章', { background }));
    expect(jobs.map((j) => j.kind)).toEqual(['review']);
    deps.llmResponses.push(
      reply(JSON.stringify({ issues: [{ paragraph: 'P1', quote: '雨水顺着衣角往下滴', kind: 'pacing', severity: 'medium', evidence: [], description: '开头的动作描写太长', suggestion: '压缩成一句' }] })),
    );
    expect(await finish(jobs[0]!)).toMatchObject({ ok: true, detail: expect.stringContaining('开头的动作描写太长') });
    const [issue] = value(await app.reviewIssues(chapterId));

    step(deps, { message: '', actions: [{ tool: 'revise_review_issue', issue: issue!.id }], done: true });
    const revising = value(await app.sendToAssistant('把这条改了', { background }));
    expect(lastBody(deps)).toContain('审核《第一章 夜叩》：审核完《第一章 夜叩》');
    expect(lastResults(revising.items)?.results[0]).toMatchObject({ ok: true, detail: expect.stringMatching(/^已排上：在后台写手修订《第一章 夜叩》/) });
    expect(jobs.map((j) => [j.kind, j.chapterId])).toEqual([
      ['review', chapterId],
      ['revise', chapterId],
    ]);
    deps.llmResponses.push(reply('林舟推门进来，带进一身雨气。'));
    expect(await finish(jobs[1]!)).toMatchObject({ ok: true });
    expect(value(await app.openChapter(chapterId)).saved.map((p) => p.text)).toEqual(['林舟推门进来，带进一身雨气。']);

    // 没有后台（测试与命令行）时照旧在这一轮里审完。
    step(deps, { message: '', actions: [{ tool: 'review_chapter', chapter: '夜叩' }], done: true });
    deps.llmResponses.push(reply(JSON.stringify({ issues: [] })));
    const inline = value(await app.sendToAssistant('再审一遍'));
    expect(lastResults(inline.items)?.results[0]?.detail).toMatch(/^审核完《第一章 夜叩》/);
    expect(jobs).toHaveLength(2);
  });

  it('整批写作或审核结束时，怎样结束的放进之后一轮的现状（M5-25）', async () => {
    const { deps, app } = await setup();
    const id = value(await app.createChapter('第一章 夜叩')).chapters[0]!.id;
    value(await app.savePlan(id, { goal: '林舟当玉', castIds: [], beats: ['叩门'], foreshadowPlant: [], foreshadowPayoff: [], treatment: '', targetWords: 3000 }));
    const ends: ((summary: string) => void)[] = [];
    const { background } = backgroundJobs();
    const batch: BackgroundJobs = {
      ...background,
      writeChapters(_ids, _review, onEnd) {
        if (onEnd !== undefined) ends.push(onEnd);
        return null;
      },
    };
    step(deps, { message: '已排上。', actions: [{ tool: 'write_chapters', chapters: null, review: false }], done: true });
    value(await app.sendToAssistant('写完全书', { background: batch }));
    expect(ends).toHaveLength(1);
    ends[0]!('写手依次写 1 章：一章也没有写完；停在这里：第 1 段的输出被截断');
    step(deps, { message: '第一章停下了。', actions: [], done: true });
    value(await app.sendToAssistant('写完了吗', { background: batch }));
    expect(lastBody(deps)).toContain('- 写手依次写 1 章：一章也没有写完；停在这里：第 1 段的输出被截断');
  });
});
