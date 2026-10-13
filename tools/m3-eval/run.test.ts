import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAppService } from '../../apps/desktop/src/app/service';
import { fsDeps, type TestDeps } from '../../apps/desktop/src/testing/fs-deps';
import { addTestedModel, reply } from '../../apps/desktop/src/testing/models';
import { estimateCost, estimateTokens, parseBook, parseConfig, type EvalBook } from './book';
import { detectionRates, renderReport, REVIEW_RETRIES, runEvaluation } from './run';

const all: TestDeps[] = [];
afterEach(async () => {
  for (const d of all.splice(0)) {
    await d.dispose();
    rmSync(d.root, { recursive: true, force: true });
  }
});

/** 经 parseBook 读入：省略的字段取默认值。 */
function bookOf(raw: unknown): EvalBook {
  const parsed = parseBook(JSON.stringify(raw));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

const book = bookOf({
  title: '当铺夜谈',
  outline: '第一章：林舟当玉被压价。第二章：真相揭晓。',
  chapterCount: 2,
  wordsPerChapter: 1500,
  entities: [
    { kind: 'character', name: '林舟', description: '落魄书生，左手握不住东西', locked: true },
    { kind: 'character', name: '钱四' },
  ],
  foreshadows: [{ title: '玉佩的缺口', content: '钱四多看了一眼', reveal: '玉佩是钱四的师父雕的' }],
  plants: [
    { id: 'sc-1', type: 'setting_conflict', chapter: 1, text: '林舟用左手稳稳端起茶盏。', expect: ['setting_conflict', 'character'] },
    { id: 'pov-1', type: 'pov_leak', chapter: 2, text: '钱四心里早把价钱翻了三倍。', expect: ['pov_leak'] },
    { id: 'pov-2', type: 'pov_leak', chapter: 2, text: '阿青暗暗打算去告诉掌柜。', expect: ['pov_leak'] },
  ],
});

const draft = {
  chapters: [
    { title: '第一章 夜叩', goal: '林舟当玉被压价', cast: ['林舟', '钱四', '阿青'], beats: ['叩门', '压价'], plant: ['玉佩的缺口'], payoff: [], treatment: '', targetWords: 1500 },
    { title: '第二章 揭晓', goal: '真相揭晓', cast: ['林舟', '钱四'], beats: ['对质'], plant: [], payoff: ['玉佩的缺口'], treatment: '', targetWords: 1500 },
  ],
  foreshadows: [],
};
const memory = (summary: string) => reply(JSON.stringify({ summary, cast: [{ name: '林舟', state: '带着玉离开' }], foreshadows: [] }));
const review = (issues: unknown[]) => reply(JSON.stringify({ issues }));

async function setup() {
  const deps = fsDeps();
  all.push(deps);
  const app = createAppService(deps);
  const library = await app.loadLibrary();
  if (!library.ok) throw new Error('作品库');
  // 与命令行入口一样：默认模型在应用设置里，打开作品之前配好并通过自检。
  await addTestedModel(app, deps);
  return { deps, app };
}

describe('M3 评估流程', () => {
  it('走完计划、写作、长篇记忆与审核，植入问题后重新审核，统计检出率并写出报告', async () => {
    const { deps, app } = await setup();
    deps.llmResponses.push(
      reply(JSON.stringify(draft)),
      // 第一章：写作、长篇记忆、审核（写手自己的正文上有一条问题）。
      reply('林舟叩响了门。\n钱四压低了价。\n林舟带着玉走了。'),
      memory('林舟当玉被压价。'),
      review([{ paragraph: 'P2', quote: '压低了价', kind: 'pacing', severity: 'low', evidence: [], description: '转折太快', suggestion: '加一句还价' }]),
      // 第二章。
      reply('林舟又来了。\n钱四说出了实情。\n林舟把玉留下。\n雨停了。'),
      memory('真相揭晓。'),
      review([]),
      // 植入后的审核：第一章的植入段在第三段，被指出且类型对；第二章两处，一处被指出但类型不在预期内，一处没有指出。
      review([{ paragraph: 'P3', quote: '用左手稳稳端起茶盏', kind: 'setting_conflict', severity: 'high', evidence: ['E1'], description: '林舟左手握不住东西', suggestion: '改用右手' }]),
      review([{ paragraph: 'P2', quote: '钱四心里早把价钱翻了三倍', kind: 'character', severity: 'medium', evidence: [], description: '钱四的心思写得太直白', suggestion: '改成神情' }]),
    );
    let clock = 0;
    const lines: string[] = [];
    const result = await runEvaluation(app, book, { log: (l) => lines.push(l), now: () => (clock += 1000) });

    expect(result.stopped).toBeNull();
    expect(deps.llmResponses).toHaveLength(0);
    expect(result.unmatchedCast).toEqual(['阿青']);
    expect(result.chapters.map((c) => [c.title, c.paragraphs, c.segments, c.issues.length, c.memory?.castStates])).toEqual([
      ['第一章 夜叩', 3, 1, 1, 1],
      ['第二章 揭晓', 4, 1, 0, 1],
    ]);
    expect(result.chapters[0]?.issues[0]).toMatchObject({ kind: 'pacing', source: 'model', quote: '压低了价' });
    // 全书正文是植入之前的。
    expect(result.bookText).toContain('第一章 夜叩\n\n林舟叩响了门。\n钱四压低了价。\n林舟带着玉走了。');
    expect(result.bookText).not.toContain('左手稳稳');

    expect(result.plants.map((p) => [p.plant.id, p.detected, p.kindMatched, p.reviewed])).toEqual([
      ['sc-1', true, true, true],
      ['pov-1', true, false, true],
      ['pov-2', false, false, true],
    ]);
    expect(result.chapters.map((c) => [c.reviewIncomplete, c.reviewRetries])).toEqual([
      [null, 0],
      [null, 0],
    ]);
    expect(detectionRates(result.plants)).toEqual({
      total: 3,
      detected: 2,
      kindMatched: 1,
      unreviewed: 0,
      byType: { setting_conflict: { total: 1, detected: 1, kindMatched: 1 }, pov_leak: { total: 2, detected: 1, kindMatched: 0 } },
    });
    expect(result.usage).toMatchObject({ calls: 9 });
    expect(lines.some((l) => l.includes('sc-1（setting_conflict）：检出'))).toBe(true);

    const report = renderReport(result, { model: 'S / m', startedAt: '2026-10-13T00:00:00.000Z' });
    for (const part of [
      '# M3 评估报告：《当铺夜谈》',
      '- 流程：全部走完',
      '- 计划草稿中没有对应设定的人物：阿青',
      '共植入 3 处：检出 2 处（67%），其中类型也对的 1 处（33%）。',
      '| 视角越界 | 2 | 1 | 0 |',
      '| sc-1 | 设定冲突 | 1 | 林舟用左手稳稳端起茶盏。 | 检出 | 设定冲突：林舟左手握不住东西 |',
      '| pov-1 | 视角越界 | 2 | 钱四心里早把价钱翻了三倍。 | 检出（类型不在预期内） |',
      '| pov-2 | 视角越界 | 2 | 阿青暗暗打算去告诉掌柜。 | 没有检出 |',
      '- 【重复与节奏·low·模型】“压低了价”：转折太快（建议：加一句还价）',
      '长篇记忆：林舟当玉被压价。（人物状态 1 条，伏笔进展 0 条）',
    ]) {
      expect(report).toContain(part);
    }
  });

  it('中途调用失败时停下，报告写明停在哪里，已完成的章节保留在结果里', async () => {
    const { deps, app } = await setup();
    deps.llmResponses.push(reply(JSON.stringify(draft)), reply('林舟叩响了门。\n钱四压低了价。'), memory('林舟当玉被压价。'), review([]));
    const result = await runEvaluation(app, book, { log: () => undefined, now: () => 0 });
    expect(result.stopped).toContain('“第二章 揭晓”没有写完');
    expect(result.chapters.map((c) => c.title)).toEqual(['第一章 夜叩']);
    expect(result.plants).toEqual([]);
    expect(renderReport(result, { model: 'S / m', startedAt: '' })).toContain('- 流程：中途停下（“第二章 揭晓”没有写完');
  });
});

describe('模型审核没有完成时', () => {
  const bad = () => reply('不是 JSON');
  // 一次审核：模型的输出连续不符合格式（首次加两次修正）。
  const failedReview = () => [bad(), bad(), bad()];

  it('重试一次；仍没有完成时报告写明原因，不把这一章算作“没有问题”，植入的问题不计入检出率', async () => {
    const { deps, app } = await setup();
    expect(REVIEW_RETRIES).toBe(1);
    deps.llmResponses.push(
      reply(JSON.stringify(draft)),
      // 第一章：审核第一次没有完成，重试后完成。
      reply('林舟叩响了门。\n钱四压低了价。\n林舟带着玉走了。'),
      memory('林舟当玉被压价。'),
      ...failedReview(),
      review([]),
      // 第二章：审核与重试都没有完成。
      reply('林舟又来了。\n钱四说出了实情。\n林舟把玉留下。\n雨停了。'),
      memory('真相揭晓。'),
      ...failedReview(),
      ...failedReview(),
      // 植入后：第一章完成并检出；第二章两次都没有完成。
      review([{ paragraph: 'P3', quote: '用左手稳稳端起茶盏', kind: 'setting_conflict', severity: 'high', evidence: ['E1'], description: '林舟左手握不住东西', suggestion: '改用右手' }]),
      ...failedReview(),
      ...failedReview(),
    );
    const result = await runEvaluation(app, book, { log: () => undefined, now: () => 0 });
    expect(result.stopped).toBeNull();
    expect(deps.llmResponses).toHaveLength(0);
    expect(result.chapters.map((c) => [c.reviewIncomplete === null, c.reviewRetries])).toEqual([
      [true, 1],
      [false, 1],
    ]);
    expect(result.plants.map((p) => [p.plant.id, p.reviewed, p.detected])).toEqual([
      ['sc-1', true, true],
      ['pov-1', false, false],
      ['pov-2', false, false],
    ]);
    expect(detectionRates(result.plants)).toMatchObject({ total: 1, detected: 1, kindMatched: 1, unreviewed: 2 });

    const report = renderReport(result, { model: 'S / m', startedAt: '' });
    for (const part of [
      '（重试 1 次） | 0 | 0 |',
      '0（模型审核没有完成）',
      '下面只有程序检查的问题，这一章不能算“没有问题”。',
      '有 2 处植入所在章节的模型审核没有完成，不计入下面的检出率。',
      '共植入 1 处：检出 1 处（100%）',
      '| pov-1 | 视角越界 | 2 | 钱四心里早把价钱翻了三倍。 | 审核没有完成 |',
    ]) {
      expect(report).toContain(part);
    }
    // 第二章没有“没有问题。”这句话。
    expect(report.split('### 第二章 揭晓')[1]).not.toContain('没有问题。');
  });
});

describe('M3 评估的材料与配置', () => {
  const root = join(__dirname, '..', '..', 'm3', 'eval');

  it('入库的短篇材料与配置示例都能读入；植入的问题都落在已有的章节里', () => {
    const parsed = parseBook(readFileSync(join(root, 'book.json'), 'utf8'));
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.value.chapterCount).toBeGreaterThanOrEqual(5);
    expect(parsed.value.plants.every((p) => p.chapter <= parsed.value.chapterCount)).toBe(true);
    expect(new Set(parsed.value.plants.map((p) => p.type))).toEqual(new Set(['setting_conflict', 'pov_leak', 'foreshadow']));
    expect(new Set(parsed.value.plants.map((p) => p.id)).size).toBe(parsed.value.plants.length);
    const config = parseConfig(readFileSync(join(root, 'config.example.json'), 'utf8'));
    if (!config.ok) throw new Error(config.error);
    // 示例里只有环境变量的名字，没有密钥。
    expect(config.value.provider.apiKeyEnv).toBe('DEEPSEEK_API_KEY');
  });

  it('材料不对时说明哪里不对', () => {
    expect(parseBook('{')).toMatchObject({ ok: false, error: expect.stringContaining('不是合法的 JSON') });
    expect(parseBook('{"title":"t","entities":[]}')).toMatchObject({ ok: false, error: expect.stringContaining('outline 应为文字') });
    const wrong = parseBook(JSON.stringify({ title: 't', outline: 'o', chapterCount: 0, wordsPerChapter: 2000, entities: [{ kind: 'hero', name: '' }], plants: [{ id: 'a', type: 'pov_leak', chapter: 1, text: 'x', expect: [] }] }));
    expect(wrong).toMatchObject({ ok: false });
    if (!wrong.ok) for (const part of ['chapterCount 应为', 'entities[0].kind 应为', 'entities[0].name 应为非空的文字', 'plants[0].expect 至少要有一种类型']) expect(wrong.error).toContain(part);
    // 省略的字段取默认值。
    expect(bookOf({ title: 't', outline: 'o', chapterCount: 1, wordsPerChapter: 2000, entities: [{ kind: 'character', name: '林舟' }] })).toMatchObject({
      genre: '',
      entities: [{ aliases: [], description: '', locked: false }],
      foreshadows: [],
      plants: [],
    });
    expect(parseConfig('{"provider":{"kind":"local","name":"本机","baseUrl":"http://127.0.0.1:11434/v1","apiKeyEnv":null},"model":{"id":"m","capabilities":{"structuredOutput":"prompt","contextWindow":8000,"maxOutputTokens":2000}}}')).toMatchObject({
      ok: true,
      value: { provider: { apiKeyEnv: null }, model: { capabilities: { promptCaching: false, reasoningControl: 'none' }, prices: null } },
    });
    expect(parseConfig('{"provider":{},"model":{}}')).toMatchObject({ ok: false, error: expect.stringContaining('provider.kind 应为') });
  });

  it('预计用量随章数与字数增长；没有价格时费用未知', () => {
    const small = estimateTokens({ outline: '大纲', chapterCount: 2, wordsPerChapter: 1500, plants: [] });
    const large = estimateTokens({ outline: '大纲', chapterCount: 6, wordsPerChapter: 2000, plants: book.plants });
    expect(small.calls).toBe(3 + 1 + 2 + 2 + 2);
    expect(large.input).toBeGreaterThan(small.input);
    expect(large.output).toBeGreaterThan(small.output);
    expect(estimateCost({ input: 1_000_000, output: 500_000 }, { input: 2, output: 8 })).toBe(6);
    expect(estimateCost(small, null)).toBeNull();
  });
});
