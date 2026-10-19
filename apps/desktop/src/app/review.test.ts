import { rmSync } from 'node:fs';
import { openaiChunks } from '@fudiao/llm/testing';
import type { ChapterReviewOutput } from '@fudiao/prompts';
import { afterEach, describe, expect, it } from 'vitest';
import { fsDeps, type TestDeps } from '../testing/fs-deps';
import { addTestedModel, reply } from '../testing/models';
import { createAppService, type AppService } from './service';

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

type Draft = ChapterReviewOutput['issues'][number];
const draft = (over: Partial<Draft>): Draft => ({
  paragraph: 'P1',
  quote: '用左手稳稳接过茶盏',
  kind: 'setting_conflict',
  severity: 'high',
  evidence: ['E1'],
  description: '林舟左手有伤，接不稳茶盏',
  suggestion: '改用右手',
  ...over,
});
const review = (issues: Draft[]) => reply(JSON.stringify({ issues }));

/**
 * 两章。第一章是作者手写的两段：第一段有规避词“不禁”，并与“林舟左手有伤”的设定矛盾；
 * 第二段说破了计划在第二章回收的伏笔。第一章的计划里有没出场的阿青。
 */
async function setup() {
  const deps = fsDeps();
  all.push(deps);
  const app = createAppService(deps);
  value(await app.loadLibrary());
  value(await app.createWork('当铺夜谈'));
  const c1 = value(await app.createChapter('第一章 夜叩')).chapters[0]!;
  const c2 = value(await app.createChapter('第二章 夜雨', c1.id)).chapters[1]!;
  const content = value(await app.openChapter(c1.id));
  value(
    await app.saveChapter(
      c1.id,
      content.saved,
      [
        { id: 'p0', text: '林舟不禁叹了口气，用左手稳稳接过茶盏。', source: 'handwritten' },
        { id: 'p1', text: '钱四在当铺里说：“这玉是你父亲的遗物吧。”', source: 'handwritten' },
      ],
      { splits: [], merges: [] },
    ),
  );
  const lin = value(await app.createEntity('character', '林舟')).created;
  value(await app.updateEntity(lin, { description: '落魄书生，左手有伤' }));
  const qing = value(await app.createEntity('character', '阿青')).created;
  value(await app.createEntity('location', '当铺'));
  const jade = value(await app.addForeshadow({ title: '玉佩的来历', content: '钱四多看了玉佩一眼', reveal: '这玉是你父亲的遗物', plantChapterId: c1.id, plantAnchor: null, payoffChapterId: c2.id, payoffAnchor: null, status: 'planned' })).foreshadows[0]!;
  value(await app.savePlan(c1.id, { goal: '林舟当玉', castIds: [lin.id, qing.id], beats: ['叩门', '压价'], foreshadowPlant: [jade.id], foreshadowPayoff: [], treatment: '', targetWords: 3000 }));
  await addTestedModel(app, deps);
  deps.llmRequests.length = 0;
  return { deps, app, c1: c1.id, c2: c2.id, lin: lin.id, qing: qing.id, jade: jade.id };
}

const kinds = (issues: readonly { kind: string; source: string; anchor: { quote: string } }[]) => issues.map((i) => `${i.source}:${i.kind}:${i.anchor.quote}`).sort();
const paragraphs = async (app: AppService, chapterId: string) => value(await app.openChapter(chapterId)).saved;
const bodyText = (deps: TestDeps, index: number) => JSON.stringify(deps.llmRequests[index]?.body ?? {});

describe('审核一章（B64）', () => {
  it('程序检查加模型审核：问题定位到段落与引文，写明依据；定位不到原文、依据不存在的问题丢弃', async () => {
    const { deps, app, c1, lin, jade, qing } = await setup();
    deps.llmResponses.push(
      review([
        draft({}),
        draft({ quote: '正文里没有这句话' }),
        draft({ paragraph: 'P2', quote: '', kind: 'off_plan', evidence: ['F9'], description: '没有写到压价' }),
        // 与程序检查指出的是同一处，不重复。
        draft({ quote: '不禁', kind: 'ai_tone', severity: 'low', evidence: [], description: '套话' }),
      ]),
    );
    const outcome = value(await app.reviewChapter(c1));
    expect(outcome).toMatchObject({ modelReviewed: true, reason: null, dropped: 2 });
    expect(kinds(outcome.issues)).toEqual(['model:setting_conflict:用左手稳稳接过茶盏', 'program:ai_tone:不禁', 'program:foreshadow:这玉是你父亲的遗物', 'program:off_plan:']);
    // 严重的在前。
    expect(outcome.issues.map((i) => i.severity)).toEqual(['high', 'high', 'low', 'low']);

    const [p0, p1] = await paragraphs(app, c1);
    const conflict = outcome.issues.find((i) => i.kind === 'setting_conflict');
    expect(conflict).toMatchObject({
      anchor: { paragraphId: p0!.id, paragraphVersion: p0!.version, start: 9, end: 18, quote: '用左手稳稳接过茶盏' },
      evidence: [{ type: 'entity', id: lin }],
      evidenceText: ['设定 林舟：落魄书生，左手有伤'],
      source: 'model',
    });
    expect(conflict?.llmCallId).not.toBeNull();
    expect(outcome.issues.find((i) => i.kind === 'foreshadow')).toMatchObject({ anchor: { paragraphId: p1!.id }, evidence: [{ type: 'foreshadow', id: jade }], llmCallId: null });
    expect(outcome.issues.find((i) => i.kind === 'off_plan')).toMatchObject({ evidence: [{ type: 'entity', id: qing }] });

    const request = bodyText(deps, 0);
    for (const part of ['[E1] 林舟（人物）：落魄书生，左手有伤', '当铺（地点）', '章节计划 [plan]', '[S1] 玉佩的来历（本章要埋）', '[P1] 林舟不禁叹了口气', '[P2] 钱四在当铺里说']) {
      expect(request).toContain(part);
    }
    expect(value(await app.reviewIssues(c1))).toEqual(outcome.issues);
    expect(value(await app.planningView()).chapters.map((c) => c.pendingIssues)).toEqual([4, 0]);
  });

  it('模型审核没有完成时说明原因，程序检查的问题仍然保存', async () => {
    const { app, c1 } = await setup();
    const outcome = value(await app.reviewChapter(c1));
    expect(outcome.modelReviewed).toBe(false);
    expect(outcome.reason).not.toBeNull();
    expect(kinds(outcome.issues)).toEqual(['program:ai_tone:不禁', 'program:foreshadow:这玉是你父亲的遗物', 'program:off_plan:']);
  });

  it('没有正文、有未保存的修改时不审核', async () => {
    const { deps, app, c1, c2 } = await setup();
    expect(await app.reviewChapter(c2)).toMatchObject({ ok: false, error: { code: 'settings', detail: expect.stringContaining('还没有正文') } });
    value(await deps.drafts.write(value(await app.reloadWork()).entry.path, c1, '{"paragraphs":[]}'));
    expect(await app.reviewChapter(c1)).toMatchObject({ ok: false, error: { code: 'settings', detail: expect.stringContaining('未保存的修改') } });
    expect(deps.llmRequests).toHaveLength(0);
  });

  it('忽略的问题重新审核时不再提出；仍待处理的旧问题换成新的，不重复', async () => {
    const { deps, app, c1 } = await setup();
    deps.llmResponses.push(review([draft({})]));
    const first = value(await app.reviewChapter(c1));
    const tone = first.issues.find((i) => i.kind === 'ai_tone')!;
    const conflict = first.issues.find((i) => i.kind === 'setting_conflict')!;
    expect(kinds(value(await app.resolveIssue(tone.id, 'ignored')))).not.toContain('program:ai_tone:不禁');
    value(await app.resolveIssue(conflict.id, 'ignored'));

    deps.llmResponses.push(review([draft({ description: '换了个说法' }), draft({ quote: '叹了口气', kind: 'pacing', severity: 'low', evidence: [], description: '多余的动作' })]));
    const second = value(await app.reviewChapter(c1));
    expect(kinds(second.issues)).toEqual(['model:pacing:叹了口气', 'program:foreshadow:这玉是你父亲的遗物', 'program:off_plan:']);

    deps.llmResponses.push(review([draft({ quote: '叹了口气', kind: 'pacing', severity: 'low', evidence: [], description: '多余的动作' })]));
    expect(kinds(value(await app.reviewChapter(c1)).issues)).toEqual(['model:pacing:叹了口气', 'program:foreshadow:这玉是你父亲的遗物', 'program:off_plan:']);
  });

  it('段落改过后，它上面的问题过期；重新审核按新的正文提出', async () => {
    const { deps, app, c1 } = await setup();
    deps.llmResponses.push(review([draft({})]));
    value(await app.reviewChapter(c1));
    const saved = await paragraphs(app, c1);
    value(
      await app.saveChapter(
        c1,
        saved,
        [
          { id: saved[0]!.id, text: '林舟叹了口气，用右手接过茶盏。', source: 'handwritten' },
          { id: saved[1]!.id, text: saved[1]!.text, source: 'handwritten' },
        ],
        { splits: [], merges: [] },
      ),
    );
    // 第一段上的问题（含锚在第一段上的“人物没有出场”）过期，第二段的问题还在。
    expect(kinds(value(await app.reviewIssues(c1)))).toEqual(['program:foreshadow:这玉是你父亲的遗物']);
    deps.llmResponses.push(review([]));
    expect(kinds(value(await app.reviewChapter(c1)).issues)).toEqual(['program:foreshadow:这玉是你父亲的遗物', 'program:off_plan:']);
  });

  it('写手写完的章节审核后，计划状态为已审核', async () => {
    const { deps, app, c2, lin } = await setup();
    value(await app.savePlan(c2, { goal: '真相揭晓', castIds: [lin], beats: ['对质'], foreshadowPlant: [], foreshadowPayoff: [], treatment: '', targetWords: 1500 }));
    deps.llmResponses.push(reply('林舟把玉放在柜台上。'));
    expect(value(await app.writeChapter(c2))).toMatchObject({ status: 'written' });
    deps.llmResponses.push(review([]));
    const outcome = value(await app.reviewChapter(c2));
    expect(outcome.modelReviewed).toBe(true);
    expect(value(await app.planningView()).chapters[1]?.plan?.status).toBe('reviewed');
  });
});

describe('交给写手修订（B64）', () => {
  it('写手只改问题所在的段落：写入前保存快照，段落记为 AI 生成，这一段上的问题记为已交写手修订', async () => {
    const { deps, app, c1 } = await setup();
    deps.llmResponses.push(review([draft({})]));
    const first = value(await app.reviewChapter(c1));
    const conflict = first.issues.find((i) => i.kind === 'setting_conflict')!;
    const before = await paragraphs(app, c1);
    deps.llmRequests.length = 0;

    deps.llmResponses.push(reply('林舟叹了口气，用右手接过茶盏。'));
    const outcome = value(await app.reviseIssue(conflict.id));
    expect(outcome.paragraphs.map((p) => [p.id, p.text, p.source])).toEqual([
      [before[0]!.id, '林舟叹了口气，用右手接过茶盏。', 'ai_generated'],
      [before[1]!.id, before[1]!.text, 'handwritten'],
    ]);
    expect(value(await app.listSnapshots(c1)).map((s) => s.reason)).toEqual(['writer']);
    // 同一段上的规避词问题一并交给了写手；另一段的问题还在；针对整章的问题不交给写手，修订后重新提出。
    expect(kinds(outcome.issues)).toEqual(['program:foreshadow:这玉是你父亲的遗物', 'program:off_plan:']);

    const request = bodyText(deps, 0);
    for (const part of ['要修订的段落：', '林舟不禁叹了口气，用左手稳稳接过茶盏。', '后一段：', '“用左手稳稳接过茶盏”：林舟左手有伤，接不稳茶盏（建议：改用右手）', '“不禁”：命中规避表达“不禁”', '设定 林舟：落魄书生，左手有伤']) {
      expect(request).toContain(part);
    }
    expect(request).not.toContain('没有在本章出场');
    // 这一章的伏笔还没到回收的章节：修订时同样不得说破。
    expect(request).toContain('不得说破');

    // 已交写手的问题不能再处理一次。
    expect(await app.reviseIssue(conflict.id)).toMatchObject({ ok: false, error: { code: 'settings' } });
  });

  it('写手正在写这一章时不交给写手修订（同一章同时只有一个写手）', async () => {
    const { deps, app, c1 } = await setup();
    deps.llmResponses.push(review([draft({})]));
    const conflict = value(await app.reviewChapter(c1)).issues.find((i) => i.kind === 'setting_conflict')!;
    // 写手的第一个请求到达时，作者在审核抽屉里点了“交给写手修订”。
    let revised: Awaited<ReturnType<typeof app.reviseIssue>> | null = null;
    deps.beforeLlm.push(async () => {
      revised = await app.reviseIssue(conflict.id);
    });
    deps.llmResponses.push(reply('林舟又叩响了门。'), reply('钱四压低了价。'));
    expect(value(await app.writeChapter(c1)).status).toBe('written');
    expect(revised).toMatchObject({ ok: false, error: { code: 'settings', detail: expect.stringContaining('写手正在写这一章') } });
  });

  it('修订的输出被截断：半截的文字不写入，说明原因，问题仍待处理', async () => {
    const { deps, app, c1 } = await setup();
    deps.llmResponses.push(review([draft({})]));
    const conflict = value(await app.reviewChapter(c1)).issues.find((i) => i.kind === 'setting_conflict')!;
    const before = await paragraphs(app, c1);
    deps.llmResponses.push({ chunks: openaiChunks('m', { text: ['林舟叹了口'], end: 'length' }) });
    expect(await app.reviseIssue(conflict.id)).toMatchObject({ ok: false, error: { code: 'settings', detail: expect.stringContaining('截断') } });
    expect((await paragraphs(app, c1)).map((p) => p.text)).toEqual(before.map((p) => p.text));
    expect(value(await app.listSnapshots(c1))).toEqual([]);
    expect(value(await app.reviewIssues(c1)).some((i) => i.id === conflict.id)).toBe(true);
  });

  it('写手没有改动、没有写出文字或有未保存的修改时不写入，问题仍待处理', async () => {
    const { deps, app, c1 } = await setup();
    deps.llmResponses.push(review([draft({})]));
    const conflict = value(await app.reviewChapter(c1)).issues.find((i) => i.kind === 'setting_conflict')!;
    deps.llmResponses.push(reply('林舟不禁叹了口气，用左手稳稳接过茶盏。'));
    expect(await app.reviseIssue(conflict.id)).toMatchObject({ ok: false, error: { code: 'settings', detail: expect.stringContaining('没有改动') } });
    value(await deps.drafts.write(value(await app.reloadWork()).entry.path, c1, '{"paragraphs":[]}'));
    expect(await app.reviseIssue(conflict.id)).toMatchObject({ ok: false, error: { code: 'settings', detail: expect.stringContaining('未保存的修改') } });
    value(await deps.drafts.remove(value(await app.reloadWork()).entry.path, c1));
    expect(value(await app.listSnapshots(c1))).toEqual([]);
    expect(value(await app.reviewIssues(c1)).some((i) => i.id === conflict.id)).toBe(true);
  });
});
