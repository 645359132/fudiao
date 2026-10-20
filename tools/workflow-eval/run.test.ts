import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAppService } from '../../apps/desktop/src/app/service';
import { fsDeps, type TestDeps } from '../../apps/desktop/src/testing/fs-deps';
import { addTestedModel, reply } from '../../apps/desktop/src/testing/models';
import { parseBook, type EvalBook } from '../m3-eval/book';
import { benchmarkSamples, CONTRADICTION, EVAL_ORDER } from './material';
import { planFlows, quoteFlows, renderReport, runWorkflowEval } from './run';

vi.setConfig({ testTimeout: 60_000 });

const all: TestDeps[] = [];
afterEach(async () => {
  for (const d of all.splice(0)) {
    await d.dispose();
    rmSync(d.root, { recursive: true, force: true });
  }
});

function material(): EvalBook {
  const parsed = parseBook(readFileSync(join(__dirname, '..', '..', 'm3', 'eval', 'book.json'), 'utf8'));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

async function setup() {
  const deps = fsDeps();
  all.push(deps);
  const app = createAppService(deps);
  if (!(await app.loadLibrary()).ok) throw new Error('作品库');
  await addTestedModel(app, deps);
  deps.llmRequests.length = 0;
  return { deps, app };
}

const json = (value: unknown) => reply(JSON.stringify(value));
const memory = (summary: string) => json({ summary, cast: [{ name: '林舟', state: '还欠着赌债' }], foreshadows: [], openThreads: [] });
const noIssues = () => json({ issues: [] });
const chapter = (n: number) => reply([`第${n}段之一，林舟走在雨里。`, `第${n}段之二，钱四拨着算盘。`, `第${n}段之三，阿青关上了门。`, `第${n}段之四，雨停了。`].join('\n'));

describe('写作工作流试用（M6-08）', () => {
  it('选中的工作流补上前置（扫榜拆书以外先一键成书），按固定顺序', () => {
    expect(planFlows(['benchmark'])).toEqual(['benchmark']);
    expect(planFlows(['next_volume', 'book_audit'])).toEqual(['quick_book', 'book_audit', 'next_volume']);
    expect(planFlows([...EVAL_ORDER].reverse())).toEqual([...EVAL_ORDER]);
  });

  it('对标样章只用材料与这次写手的正文；植入的两段在材料之外', () => {
    const book = material();
    const { rankText, books } = benchmarkSamples(book, { title: '第一章', text: '林舟推门。' });
    expect(books.map((b) => b.title)).toEqual(['当铺夜谈（材料）', '当铺夜谈（写手正文）']);
    expect(books[0]?.text).toContain(book.outline);
    expect(books[0]!.text.length).toBeGreaterThan(200);
    expect(rankText).toContain('1. 当铺夜谈（材料）');
    expect(benchmarkSamples(book, null).books).toHaveLength(1);
    expect(book.outline).not.toContain(CONTRADICTION.keyword);
  });

  it('预计：每个工作流按 quoteWorkflow，另加自检与修订，合计按价格算费用', async () => {
    const { app } = await setup();
    const book = material();
    const quote = await quoteFlows(app, book, planFlows([...EVAL_ORDER]));
    if (typeof quote === 'string') throw new Error(quote);
    expect(quote.rows.map((r) => r.key)).toEqual([...EVAL_ORDER, 'extra']);
    // 没有价格：费用未知。
    expect(quote.total.costUsd).toBeNull();
    expect(quote.total.calls).toBe(quote.rows.reduce((n, r) => n + r.calls, 0));
    const model = (await app.loadModelServices()).ok ? await app.loadModelServices() : null;
    const stored = model?.ok === true ? model.value.models[0] : undefined;
    if (stored === undefined) throw new Error('没有模型');
    await app.updateModel(stored, { displayName: stored.displayName, capabilities: stored.capabilities, prices: { input: 0.3, output: 1.2 } });
    const priced = await quoteFlows(app, book, ['benchmark']);
    if (typeof priced === 'string') throw new Error(priced);
    expect(priced.total.costUsd).toBeGreaterThan(0);
    // 只跑扫榜拆书时只有材料一本。
    expect(priced.rows[0]?.calls).toBe(2);
  });

  it('用排好的模型回复走完六个工作流：植入的矛盾被定位、开篇问题交给写手修订、报告写明各步与发现', async () => {
    const { deps, app } = await setup();
    const book = material();
    const plan = (titles: string[], volume = '') =>
      json({ chapters: titles.map((title) => ({ volume, title, goal: `${title}的目标`, cast: ['林舟', '钱四'], beats: ['开始', '结束'], plant: [], payoff: [], treatment: '', targetWords: 1500 })), foreshadows: [] });
    const continuity = {
      issues: [
        { paragraph: 'P3', quote: '他从怀里摸出父亲留下的那方端砚', kind: 'character', severity: 'high', evidence: ['A3'], description: '第一章端砚已经当掉', suggestion: '交代赎回' },
        // 没有前一章段落作依据：丢弃。
        { paragraph: 'P1', quote: '第3段之一', kind: 'pacing', severity: 'low', evidence: [], description: '无关', suggestion: '' },
      ],
    };
    const opening = { issues: [{ paragraph: 'P1', quote: '林舟走在雨里', kind: 'pacing', severity: 'high', evidence: [], description: '开头太平', suggestion: '从当玉写起' }] };
    const analysis = { genre: '古代市井', sellingPoints: ['旧物来历'], hook: '雨夜当玉', pacing: [], cast: [], conflict: '赌债', chapterHooks: '章末留疑', techniques: ['先抑后扬'], quotes: [] };
    deps.llmResponses.push(
      // 一键成书：计划，三章各写、记忆、审核。
      plan(['第一章 夜叩', '第二章 碰壁', '第三章 阿青']),
      chapter(1),
      memory('林舟当玉被压价。'),
      noIssues(),
      chapter(2),
      memory('林舟借钱碰壁。'),
      noIssues(),
      chapter(3),
      memory('阿青说漏了嘴。'),
      noIssues(),
      // 全书体检：植入后第一、三章的记忆重新整理；疑点；读原文定位。
      memory('林舟当掉了端砚。'),
      memory('林舟摸出端砚。'),
      json({ suspects: [{ earlier: 'C1', later: 'C3', kind: 'character', about: '第一章当掉了端砚，第三章端砚还在身上', severity: 'high' }] }),
      json(continuity),
      // 开篇打磨：诊断两章，修订一段，复诊两章。
      json(opening),
      noIssues(),
      reply('林舟揣着玉，站在钱记当铺门口。'),
      noIssues(),
      noIssues(),
      // 人物补全：修订过的第一章重新整理记忆；草稿。
      memory('林舟当玉。'),
      json({
        characters: [{ name: '周师傅', isNew: true, identity: '玉匠', look: '', personality: '严厉', motive: '', voice: '', firstChapter: 'C1', basis: ['C1'] }],
        relationships: [
          { from: '钱四', to: '林舟', category: 'other', label: '债主', mutual: false, description: '收了他的玉', secret: false, fromChapter: 'C1', basis: ['C1'] },
          { from: '无名氏', to: '林舟', category: 'enemy', label: '仇人', mutual: false, description: '', secret: false, fromChapter: '', basis: ['C2'] },
        ],
      }),
      // 续写一卷：卷纲、计划、写两章、本卷体检。
      json({ title: '第二卷 新账', summary: '林舟在当铺做了学徒。', mainline: ['拜师', '新债'], climax: '赵三爷再来', newCharacters: [], payoffs: [], newForeshadows: [] }),
      plan(['第四章 拜师', '第五章 新债'], '第二卷 新账'),
      chapter(4),
      memory('林舟拜师。'),
      noIssues(),
      chapter(5),
      memory('新债上门。'),
      noIssues(),
      json({ suspects: [] }),
      // 扫榜拆书：两本拆解、对比。
      json(analysis),
      json(analysis),
      json({ common: ['旧物牵出旧事'], gaps: ['女性视角'], borrow: ['章末留疑'], directions: [{ idea: '女掌柜', why: '空位' }], skill: '开局三百字内让主角陷入困境。' }),
    );
    const lines: string[] = [];
    let clock = 0;
    const result = await runWorkflowEval(app, book, [...EVAL_ORDER], { log: (l) => lines.push(l), now: () => (clock += 1000) });

    expect(deps.llmResponses, lines.join('\n')).toHaveLength(0);
    expect(result.flows.map((f) => [f.key, f.state, f.error])).toEqual(EVAL_ORDER.map((k) => [k, 'done', null]));
    expect(result.chapters.map((c) => [c.flow, c.title, c.paragraphs])).toEqual([
      ['quick_book', '第一章 夜叩', 4],
      ['quick_book', '第二章 碰壁', 4],
      ['quick_book', '第三章 阿青', 4],
      ['next_volume', '第四章 拜师', 4],
      ['next_volume', '第五章 新债', 4],
    ]);
    expect(result.plant).toMatchObject({ suspected: true, located: true, evidenceMatched: true });
    const audit = result.flows.find((f) => f.key === 'book_audit')!;
    expect(audit.dropped).toBe(1);
    // 一键成书里都审过了，“依次审核”不再审。
    expect(audit.steps.map((s) => s.status)).toEqual(['done', 'done', 'done', 'done', 'done', 'done']);
    expect(audit.steps[1]?.note).toContain('都审核过了');
    const polish = result.flows.find((f) => f.key === 'opening_polish')!;
    expect(polish.findings.some((f) => f.includes('改为“林舟揣着玉，站在钱记当铺门口。”'))).toBe(true);
    const cast = result.flows.find((f) => f.key === 'cast_completion')!;
    expect(cast.dropped).toBe(1);
    expect(cast.findings).toContain('人物（新）：周师傅——玉匠；严厉');
    const bench = result.flows.find((f) => f.key === 'benchmark')!;
    expect(bench.findings).toContain('样章原文已删除');
    expect(result.usage?.calls).toBe(33);
    expect(result.bookText).toContain('第四章 拜师');

    const report = renderReport(result, { model: 'S / m', startedAt: '2026-10-20T00:00:00.000Z', quote: null });
    for (const part of ['# 写作工作流试用报告：《当铺夜谈》', '## 全书体检', '- 读原文定位到植入的那一段：是', '- 依据是前一章植入的那一段：是', '| 跨章疑点 | 已完成 |', '## 扫榜拆书']) {
      expect(report).toContain(part);
    }
  });

  it('一键成书没有写出章节时，后面的工作流写明跳过，不再调用模型', async () => {
    const { deps, app } = await setup();
    // 计划草稿的回复不合格（首次加两次修正）。
    deps.llmResponses.push(reply('不是 JSON'), reply('不是 JSON'), reply('不是 JSON'));
    const result = await runWorkflowEval(app, material(), ['book_audit'], { log: () => undefined, now: () => 0 });
    expect(result.flows.map((f) => [f.key, f.state])).toEqual([
      ['quick_book', 'failed'],
      ['book_audit', 'not_started'],
    ]);
    expect(result.flows[1]?.error).toContain('跳过');
    expect(deps.llmResponses).toHaveLength(0);
    expect(deps.llmRequests).toHaveLength(3);
  });
});
