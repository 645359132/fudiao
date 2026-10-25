import { rmSync } from 'node:fs';
import type { AssistantTurnOutput } from '@fudiao/prompts';
import { afterEach, describe, expect, it } from 'vitest';
import { fsDeps, type TestDeps } from '../testing/fs-deps';
import { addTestedModel, reply } from '../testing/models';
import { waitingItem, type AssistantItem } from './assistant';
import type { BackgroundJob, BackgroundJobs } from './assistant-tools';
import type { BatchRevisionOutcome, RevisionScope } from './review';
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
    reviseIssues: () => Promise.resolve(null),
    workflow: () => null,
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

describe('等待确认的动作', () => {
  const pending: AssistantItem = { id: 'p', role: 'pending', action: { tool: 'trash_chapter', chapter: '第二章' }, summary: '移入回收站', rest: [] };
  const changes = (turnOf?: string): AssistantItem => ({ id: `c${turnOf ?? ''}`, role: 'changes', tool: 'write_chapter', entries: [], kept: false, ...(turnOf !== undefined && { turnOf }) });
  it('排在它后面的后台改动记录（带 turnOf）不挡住确认；确认后执行的动作自己的改动记录（不带 turnOf）说明已经确认过', () => {
    expect(waitingItem([pending])).toBe(pending);
    expect(waitingItem([pending, changes('u1'), changes('u2')])).toBe(pending);
    expect(waitingItem([pending, changes()])).toBeNull();
    expect(waitingItem([pending, { id: 'r', role: 'results', results: [] }])).toBeNull();
  });
});

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

  it('后台做完的改动记回发起它的那段对话：排在等待确认的动作后面时照样能确认；不算作者用过那一段；那段删掉了不重建', async () => {
    const { deps, app } = await setup();
    const chapter = async (title: string, after: string | null) => {
      const created = value(await app.createChapter(title, after ?? undefined)).chapters.find((c) => c.title === title)!.id;
      value(await app.savePlan(created, { goal: title, castIds: [], beats: ['叩门'], foreshadowPlant: [], foreshadowPayoff: [], treatment: '', targetWords: 1500 }));
      return created;
    };
    const c1 = await chapter('第一章 夜叩', null);
    const c2 = await chapter('第二章 夜雨', c1);
    const c3 = await chapter('第三章 雨歇', c2);
    await chapter('第四章 天明', c3);
    const memoryReply = reply(JSON.stringify({ summary: '梗概。', cast: [], foreshadows: [], openThreads: [] }));
    const { background, jobs, finish } = backgroundJobs();

    // 在 A 里排上写第一章，接着让助手做一件要确认的事；确认之前后台写完了。
    step(deps, { message: '', actions: [{ tool: 'write_chapter', chapter: '第一章 夜叩' }], done: false });
    step(deps, { message: '在写了。', actions: [], done: true });
    value(await app.sendToAssistant('写第一章', { background }));
    step(deps, { message: '要把第二章移入回收站，请确认。', actions: [{ tool: 'trash_chapter', chapter: '第二章 夜雨' }], done: false });
    expect(value(await app.sendToAssistant('把第二章删了', { background })).pending).toBe(true);
    deps.llmResponses.push(reply('林舟叩响了门。'), memoryReply);
    expect(await finish(jobs[0]!)).toMatchObject({ ok: true });
    const items = value(await app.assistantItems());
    expect(items.at(-1)?.role).toBe('changes');
    expect(waitingItem(items)).toMatchObject({ role: 'pending', action: { tool: 'trash_chapter' } });
    step(deps, { message: '移好了。', actions: [], done: true });
    const resolved = value(await app.resolveAssistantPending(true, { background }));
    expect(lastResults(resolved.items)?.results[0]).toMatchObject({ tool: 'trash_chapter', ok: true });
    expect(value(await app.reloadWork()).trashed.map((c) => c.title)).toEqual(['第二章 夜雨']);

    // A 里再排一章，然后在新的一段 B 里说话；后台这时做完：改动记回 A，但最近用过的仍是 B。
    step(deps, { message: '', actions: [{ tool: 'write_chapter', chapter: '第三章 雨歇' }], done: false });
    step(deps, { message: '在写了。', actions: [], done: true });
    value(await app.sendToAssistant('写第三章', { background }));
    const a = value(await app.assistantConversations()).current;
    value(await app.clearAssistant());
    step(deps, { message: '好。', actions: [], done: true });
    value(await app.sendToAssistant('聊聊第四章', { background }));
    const b = value(await app.assistantConversations()).current;
    deps.llmResponses.push(reply('钱四开了门。'), memoryReply);
    expect(await finish(jobs[1]!)).toMatchObject({ ok: true });
    expect(value(await app.assistantConversations()).conversations.map((c) => c.id)).toEqual([b, a]);

    // B 里排上写第四章，写着的时候作者删掉了 B：做完时不把 B 重新建出来。
    step(deps, { message: '', actions: [{ tool: 'write_chapter', chapter: '第四章 天明' }], done: false });
    step(deps, { message: '在写了。', actions: [], done: true });
    value(await app.sendToAssistant('写第四章', { background }));
    value(await app.deleteAssistantConversation(b!));
    deps.llmResponses.push(reply('天亮了。'), memoryReply);
    expect(await finish(jobs[2]!)).toMatchObject({ ok: true });
    expect(value(await app.assistantConversations()).conversations.map((c) => c.id)).toEqual([a]);
  });
});

describe('AI 助手一键交给写手修订（B64 补充）', () => {
  /** 一章一段，审核出一条节奏问题。 */
  async function chapterWithIssue(app: Awaited<ReturnType<typeof setup>>['app'], deps: TestDeps, title: string, text: string, quote: string, after?: string) {
    const id = value(await app.createChapter(title, after)).chapters.find((c) => c.title === title)!.id;
    const opened = value(await app.openChapter(id));
    value(await app.saveChapter(id, opened.saved, [{ id: `p-${id}`, text, source: 'handwritten' }], { splits: [], merges: [] }));
    deps.llmResponses.push(reply(JSON.stringify({ issues: [{ paragraph: 'P1', quote, kind: 'pacing', severity: 'medium', evidence: [], description: `${title}的动作描写太长`, suggestion: '压缩成一句' }] })));
    value(await app.reviewChapter(id));
    return id;
  }
  const texts = async (app: Awaited<ReturnType<typeof setup>>['app'], id: string) => value(await app.openChapter(id)).saved.map((p) => p.text);

  it('没有后台时就地做完一章：结果写明修订了几条；撤销这一轮时恢复改之前的快照', async () => {
    const { deps, app } = await setup();
    const id = await chapterWithIssue(app, deps, '第一章 夜叩', '林舟推门进来，雨水顺着衣角往下滴。', '雨水顺着衣角往下滴');
    step(deps, { message: '', actions: [{ tool: 'revise_review_issues', chapters: ['第一章 夜叩'], severities: null }], done: true });
    deps.llmResponses.push(reply('林舟推门进来，带进一身雨气。'));
    const outcome = value(await app.sendToAssistant('把第一章的问题都改了'));
    expect(outcome.pending).toBe(false);
    expect(lastResults(outcome.items)?.results[0]).toMatchObject({ tool: 'revise_review_issues', ok: true, detail: expect.stringMatching(/^交给写手修订 1 条：修订了 1 条（写手改了 1 段）/) });
    expect(await texts(app, id)).toEqual(['林舟推门进来，带进一身雨气。']);
    expect(outcome.items.find((i) => i.role === 'changes')).toMatchObject({ tool: 'revise_review_issues', entries: [{ kind: 'text', id, title: '第一章 夜叩' }] });

    const undone = value(await app.undoAssistantTurn());
    expect(undone.items.at(-1)).toMatchObject({ role: 'undo', ok: true });
    expect(await texts(app, id)).toEqual(['林舟推门进来，雨水顺着衣角往下滴。']);
  });

  it('不止一章时先给作者看条数与预计费用；确认后交给后台；做完的那句话放进之后的现状，撤销发起的那一轮时各章恢复', async () => {
    const { deps, app } = await setup();
    const c1 = await chapterWithIssue(app, deps, '第一章 夜叩', '林舟推门进来，雨水顺着衣角往下滴。', '雨水顺着衣角往下滴');
    const c2 = await chapterWithIssue(app, deps, '第二章 夜雨', '雨下得更紧了，檐下的灯笼被风吹得乱晃。', '被风吹得乱晃', c1);
    const scopes: RevisionScope[] = [];
    const ends: ((outcome: BatchRevisionOutcome | null, summary: string) => void)[] = [];
    const { background } = backgroundJobs();
    const jobs: BackgroundJobs = {
      ...background,
      reviseIssues(scope, onEnd) {
        scopes.push(scope);
        if (onEnd !== undefined) ends.push(onEnd);
        return Promise.resolve(null);
      },
    };

    step(deps, { message: '全书有两条问题，确认后交给写手。', actions: [{ tool: 'revise_review_issues', chapters: null, severities: ['medium'] }], done: false });
    const asked = value(await app.sendToAssistant('把全书的问题都交给写手改', { background: jobs }));
    expect(asked.pending).toBe(true);
    expect(waitingItem(asked.items)).toMatchObject({ summary: expect.stringMatching(/^把 2 章里 2 条一般的待处理审核问题交给写手修订：预计调用模型 2 次，费用未知/) });
    expect(scopes).toEqual([]);

    step(deps, { message: '已排上。', actions: [], done: true });
    const resolved = value(await app.resolveAssistantPending(true, { background: jobs }));
    expect(lastResults(resolved.items)?.results[0]).toMatchObject({ tool: 'revise_review_issues', ok: true, detail: expect.stringContaining('已排上：写手在后台依次修订 2 章里 2 条一般的待处理审核问题') });
    expect(scopes).toEqual([{ chapterIds: [c1, c2], severities: ['medium'] }]);

    // 状态层在后台做完这一批，把结果交回。
    deps.llmResponses.push(reply('林舟推门进来，带进一身雨气。'), reply('雨下得更紧了，灯笼乱晃。'));
    const done = value(await app.reviseIssues(scopes[0]!));
    expect(done).toMatchObject({ total: 2, revised: 2 });
    ends[0]!(done, done.summary);
    for (let i = 0; i < 50 && !value(await app.assistantItems()).some((x) => x.role === 'changes' && x.tool === 'revise_review_issues'); i++) await new Promise((r) => setTimeout(r, 10));
    expect(value(await app.assistantItems()).find((x) => x.role === 'changes')).toMatchObject({ tool: 'revise_review_issues', entries: [{ kind: 'text', id: c1 }, { kind: 'text', id: c2 }], turnOf: expect.any(String) });

    step(deps, { message: '两章都改好了。', actions: [], done: true });
    value(await app.sendToAssistant('改好了吗', { background: jobs }));
    expect(lastBody(deps)).toContain('一键修订审核问题：交给写手修订 2 条：修订了 2 条');

    const undone = value(await app.undoAssistantTurn());
    expect(undone.items.at(-1)).toMatchObject({ role: 'undo', ok: true });
    expect(await texts(app, c1)).toEqual(['林舟推门进来，雨水顺着衣角往下滴。']);
    expect(await texts(app, c2)).toEqual(['雨下得更紧了，檐下的灯笼被风吹得乱晃。']);
  });
});
