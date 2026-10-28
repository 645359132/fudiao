import { rmSync } from 'node:fs';
import { openaiChunks } from '@fudiao/llm/testing';
import type { ChapterReviewOutput } from '@fudiao/prompts';
import { afterEach, describe, expect, it } from 'vitest';
import { fsDeps, type TestDeps } from '../testing/fs-deps';
import { addTestedModel, reply } from '../testing/models';
import { createAppService, type AppService } from './service';
import { REVIEW_RETRIES, reviewWithRetry, type ReviewOutcome, type RevisionProgress } from './review';
import { addIssues } from '@fudiao/store';
import { err, ok } from '@fudiao/shared';

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

describe('连续处理多章时的审核重试（M6-08 之后）', () => {
  const outcome = (modelReviewed: boolean): ReviewOutcome => ({ issues: [], modelReviewed, reason: modelReviewed ? null : '输出被截断', dropped: 0 });

  it('模型审核没完成时重试一次；第二次完成即完成，仍没完成时交回原因', async () => {
    expect(REVIEW_RETRIES).toBe(1);
    const second = [ok(outcome(false)), ok(outcome(true))];
    const done = await reviewWithRetry(() => Promise.resolve(second.shift()!));
    expect(done).toMatchObject({ complete: true, retries: 1, reason: null });
    let calls = 0;
    const never = await reviewWithRetry(() => {
      calls += 1;
      return Promise.resolve(ok(outcome(false)));
    });
    expect(calls).toBe(2);
    expect(never).toMatchObject({ complete: false, retries: 1, reason: '输出被截断' });
  });

  it('调用失败与取消不重试', async () => {
    let calls = 0;
    const failed = await reviewWithRetry(() => {
      calls += 1;
      return Promise.resolve(err({ code: 'no_work' as const }));
    });
    expect(calls).toBe(1);
    expect(failed.complete).toBe(false);
    const stop = new AbortController();
    stop.abort();
    calls = 0;
    await reviewWithRetry(() => {
      calls += 1;
      return Promise.resolve(ok(outcome(false)));
    }, stop.signal);
    expect(calls).toBe(1);
  });
});

describe('一键交给写手修订（B64 补充）', () => {
  /** 第二章写上几段（没有规避词，也不涉及伏笔）。 */
  async function fillSecond(app: AppService, c2: string, texts: readonly string[]) {
    const content = value(await app.openChapter(c2));
    value(await app.saveChapter(c2, content.saved, texts.map((text, i) => ({ id: `q${i}`, text, source: 'handwritten' as const })), { splits: [], merges: [] }));
    return paragraphs(app, c2);
  }

  it('同一段上有引文的问题一次修订；前一条改了段落后，后面的问题在现在的正文里重新定位；针对整章的跳过；每章只存一份快照', async () => {
    const { deps, app, c1 } = await setup();
    deps.llmResponses.push(review([draft({}), draft({ quote: '', kind: 'pacing', severity: 'medium', evidence: [], description: '这一段节奏拖沓', suggestion: '删掉叹气' })]));
    expect(kinds(value(await app.reviewChapter(c1)).issues)).toEqual([
      'model:pacing:',
      'model:setting_conflict:用左手稳稳接过茶盏',
      'program:ai_tone:不禁',
      'program:foreshadow:这玉是你父亲的遗物',
      'program:off_plan:',
    ]);
    deps.llmRequests.length = 0;
    deps.llmResponses.push(reply('钱四在当铺里打量着那块玉。'), reply('林舟叹了口气，用右手接过茶盏。'), reply('林舟伸出右手，接过茶盏。'));
    const progress: RevisionProgress[] = [];
    const outcome = value(await app.reviseIssues({ chapterIds: [c1], severities: null }, { onProgress: (p) => progress.push(p) }));

    // 严重的在前：先改第二段的伏笔；再改第一段（规避词随设定冲突一并修订，程序检查重新标出时换了标识，对回原来那一条）；
    // 没有引文的节奏问题跟着第一段走，读的是第二次修订后的文字；计划中的人物没有出场针对整章，跳过。
    expect(outcome).toMatchObject({ total: 5, revised: 4, calls: 3, alongside: 0, failed: [], untouched: 0, cancelled: false, halted: null });
    expect(outcome.skipped.map((s) => s.reason)).toEqual([expect.stringContaining('针对整章')]);
    expect(bodyText(deps, 0)).toContain('钱四在当铺里说');
    expect(bodyText(deps, 1)).toContain('“不禁”：命中规避表达“不禁”');
    expect(bodyText(deps, 2)).toContain('林舟叹了口气，用右手接过茶盏。');
    expect(bodyText(deps, 2)).toContain('这一段节奏拖沓');
    expect((await paragraphs(app, c1)).map((p) => [p.text, p.source])).toEqual([
      ['林舟伸出右手，接过茶盏。', 'ai_generated'],
      ['钱四在当铺里打量着那块玉。', 'ai_generated'],
    ]);
    const snapshots = value(await app.listSnapshots(c1));
    expect(snapshots.map((s) => s.reason)).toEqual(['writer']);
    expect(outcome.chapters).toEqual([{ chapterId: c1, title: '第一章 夜叩', snapshotId: snapshots[0]!.id, revised: 4 }]);
    // 快照是第一次修订之前的正文：恢复它就回到一键修订之前。
    expect(value(await app.getSnapshot(snapshots[0]!.id)).paragraphs.map((p) => p.text)).toEqual(['林舟不禁叹了口气，用左手稳稳接过茶盏。', '钱四在当铺里说：“这玉是你父亲的遗物吧。”']);
    expect(kinds(value(await app.reviewIssues(c1)))).toEqual(['program:off_plan:']);
    expect(progress.at(-1)).toMatchObject({ chapterId: c1, chapterIndex: 0, chapters: 1, done: 5, total: 5, revised: 4, skipped: 1, failed: 0 });
    expect(outcome.summary).toMatch(/^交给写手修订 5 条：修订了 4 条（写手改了 3 段），跳过 1 条（针对整章/);
  });

  it('按严重程度筛选；同一段上不在范围里的问题随之一并修订；依据的段落被前面的修订改过的跳过', async () => {
    const { deps, app, c1, c2 } = await setup();
    const [q0] = await fillSecond(app, c2, ['雨夜，林舟又来到当铺。']);
    deps.llmResponses.push(review([draft({}), draft({ quote: '叹了口气', kind: 'pacing', severity: 'low', evidence: [], description: '多余的动作' })]));
    value(await app.reviewChapter(c1));
    // 全书体检的跨章连贯问题：依据是第一章第一段当时的版本。
    const [p0] = await paragraphs(app, c1);
    const db = value(await deps.opener.open(value(await app.reloadWork()).entry.path, deps.clock.now()));
    value(
      await addIssues(
        db.port,
        [
          {
            id: 'continuity-1',
            chapterId: c2,
            kind: 'timeline',
            severity: 'medium',
            anchor: { paragraphId: q0!.id, paragraphVersion: q0!.version, start: 3, end: 5, quote: '林舟' },
            evidence: [{ type: 'paragraph', id: p0!.id, chapterId: c1, version: p0!.version }],
            description: '前一章林舟还在当铺里',
            suggestion: '写明他离开过',
            llmCallId: null,
            source: 'continuity',
          },
        ],
        { now: deps.clock.now() },
      ),
    );
    deps.llmRequests.length = 0;
    deps.llmResponses.push(reply('钱四在当铺里打量着那块玉。'), reply('林舟用右手接过茶盏。'));
    const quote = value(await app.quoteRevision({ chapterIds: null, severities: ['high', 'medium'] }));
    expect(quote).toMatchObject({ bySeverity: { high: 2, medium: 1, low: 3 }, issues: 3, chapterIds: [c1, c2], wholeChapter: 0, calls: 3, costUsd: null, model: 'm' });

    const outcome = value(await app.reviseIssues({ chapterIds: null, severities: ['high', 'medium'] }));
    expect(outcome).toMatchObject({ total: 3, revised: 2, calls: 2, alongside: 2, failed: [] });
    expect(outcome.skipped).toEqual([{ chapterId: c2, issueId: 'continuity-1', description: '前一章林舟还在当铺里', reason: expect.stringContaining('依据的段落改过了') }]);
    expect(deps.llmRequests).toHaveLength(2);
    expect(outcome.chapters.map((c) => c.chapterId)).toEqual([c1]);
    expect(value(await app.listSnapshots(c2))).toEqual([]);
    expect(outcome.summary).toContain('同一段上另有 2 条一并修订');
  });

  it('一条失败不挡住其余，结束时写明原因；连续三条同样的原因失败时停下，后面的不再调用', async () => {
    const { deps, app, c1, c2 } = await setup();
    deps.llmResponses.push(review([draft({})]));
    value(await app.reviewChapter(c1));
    deps.llmRequests.length = 0;
    // 伏笔那一段改好了；设定冲突那一段写手原样交回（失败）。
    deps.llmResponses.push(reply('钱四在当铺里打量着那块玉。'), reply('林舟不禁叹了口气，用左手稳稳接过茶盏。'));
    const first = value(await app.reviseIssues({ chapterIds: [c1], severities: ['high'] }));
    expect(first).toMatchObject({ total: 2, revised: 1, calls: 1, halted: null });
    expect(first.failed).toEqual([expect.objectContaining({ reason: expect.stringContaining('没有改动') })]);
    expect(first.summary).toContain('失败 1 条（写手没有改动这一段');
    expect(value(await app.reviewIssues(c1)).some((i) => i.kind === 'setting_conflict')).toBe(true);

    const texts = ['门开了一条缝。', '风灌了进来。', '灯火晃了晃。', '他没有说话。'];
    await fillSecond(app, c2, texts);
    deps.llmResponses.push(review(texts.map((t, i) => draft({ paragraph: `P${i + 1}`, quote: t.slice(0, 2), kind: 'pacing', evidence: [], description: `第 ${i + 1} 段拖沓` }))));
    value(await app.reviewChapter(c2));
    deps.llmRequests.length = 0;
    deps.llmResponses.push(...texts.map((t) => reply(t)));
    const halted = value(await app.reviseIssues({ chapterIds: [c2], severities: ['high'] }));
    expect(halted).toMatchObject({ revised: 0, calls: 0, untouched: 1, halted: expect.stringContaining('没有改动') });
    expect(halted.failed).toHaveLength(3);
    expect(deps.llmRequests).toHaveLength(3);
    expect(halted.summary).toContain('连续 3 条因为同一个原因失败，停下了，还有 1 条没有处理');
  });

  it('取消：正在修订的那一条不写入，后面的不再做；已经改好的保留', async () => {
    const { deps, app, c1 } = await setup();
    deps.llmResponses.push(review([draft({})]));
    value(await app.reviewChapter(c1));
    deps.llmRequests.length = 0;
    deps.llmResponses.push(reply('钱四在当铺里打量着那块玉。'), { chunks: openaiChunks('m', { text: ['林舟'], end: 'stop' }, { stopAfterText: true }), hang: true });
    const abort = new AbortController();
    const running = app.reviseIssues({ chapterIds: [c1], severities: ['high'] }, { signal: abort.signal });
    while (deps.llmRequests.length < 2) await new Promise((r) => setTimeout(r, 5));
    abort.abort();
    const outcome = value(await running);
    expect(outcome).toMatchObject({ total: 2, revised: 1, failed: [], untouched: 1, cancelled: true });
    expect(outcome.summary).toContain('中途停下了，还有 1 条没有处理');
    expect((await paragraphs(app, c1)).map((p) => p.text)).toEqual(['林舟不禁叹了口气，用左手稳稳接过茶盏。', '钱四在当铺里打量着那块玉。']);
    expect(value(await app.reviewIssues(c1)).some((i) => i.kind === 'setting_conflict')).toBe(true);
  });

  it('写手正在写的章节、有未保存修改的章节跳过，不调用模型', async () => {
    const { deps, app, c1, c2, lin } = await setup();
    deps.llmResponses.push(review([draft({})]));
    value(await app.reviewChapter(c1));
    value(await deps.drafts.write(value(await app.reloadWork()).entry.path, c1, '{"paragraphs":[]}'));
    deps.llmRequests.length = 0;
    const drafted = value(await app.reviseIssues({ chapterIds: [c1], severities: ['high'] }));
    expect(drafted).toMatchObject({ total: 2, revised: 0, calls: 0, chapters: [] });
    expect(drafted.skipped.map((s) => s.reason)).toEqual([expect.stringContaining('未保存的修改'), expect.stringContaining('未保存的修改')]);
    expect(deps.llmRequests).toHaveLength(0);
    value(await deps.drafts.remove(value(await app.reloadWork()).entry.path, c1));

    // 写手正在写第二章时，第二章的问题跳过（修订与写章共用写手锁）。
    await fillSecond(app, c2, ['门开了一条缝。']);
    deps.llmResponses.push(review([draft({ quote: '门开了', kind: 'pacing', evidence: [], description: '拖沓' })]));
    value(await app.reviewChapter(c2));
    value(await app.savePlan(c2, { goal: '真相揭晓', castIds: [lin], beats: ['对质'], foreshadowPlant: [], foreshadowPayoff: [], treatment: '', targetWords: 1500 }));
    let during: Awaited<ReturnType<typeof app.reviseIssues>> | null = null;
    deps.beforeLlm.push(async () => {
      during = await app.reviseIssues({ chapterIds: [c2], severities: null });
    });
    deps.llmResponses.push(reply('林舟把玉放在柜台上。'));
    value(await app.writeChapter(c2));
    expect(during).toMatchObject({ ok: true, value: { revised: 0, calls: 0 } });
    expect(value(during!).skipped.every((s) => s.reason.includes('写手正在写这一章'))).toBe(true);
    expect(value(await app.reviseIssues({ chapterIds: [], severities: null })).summary).toBe('范围里没有待处理的审核问题');
  });
});

describe('文风的程序检查（B87）', () => {
  it('对话低于本章的目标、本章的高频词都成为程序问题；模型审核照常', async () => {
    const { deps, app, c2 } = await setup();
    const contexts = ['撞在石上', '贴着皮肉', '发出闷响', '冷得刺骨', '压在胸口', '横在面前', '落在泥里', '磕在门上', '沉在水底'];
    const content = value(await app.openChapter(c2));
    value(
      await app.saveChapter(
        c2,
        content.saved,
        contexts.map((x, i) => ({ id: `q${i}`, text: `第${i + 1}下，生铁${x}。林舟把那截铁收回袖中，看了第${i + 1}眼柜台后面那盏快要熄灭的油灯，雨还在下，巷子里积了水，挑担子的人把裤脚卷到膝盖，一步一步踩过去，谁也没有说话，远处的更鼓敲了${i + 1}下，风从巷口灌进来，吹得他脖子后面发凉，他把衣领拢了拢。`, source: 'handwritten' as const })),
        { splits: [], merges: [] },
      ),
    );
    const lin = value(await app.planningView()).characters.find((c) => c.name === '林舟')!;
    value(await app.savePlan(c2, { goal: '林舟再访', castIds: [lin.id], beats: ['再访'], foreshadowPlant: [], foreshadowPayoff: [], treatment: '', targetWords: 1000, rhythm: { type: 'confrontation', dialogue: 'high', ending: 'dialogue' } }));
    deps.llmResponses.push(review([]));
    const outcome = value(await app.reviewChapter(c2));
    const descriptions = outcome.issues.filter((i) => i.source === 'program').map((i) => i.description);
    expect(descriptions).toContain('“生铁”在本章出现 9 次');
    expect(descriptions).toContain('本章对话只占 0%，低于本章的目标（约 40%）');
    expect(outcome.issues.find((i) => i.description.startsWith('本章对话'))).toMatchObject({ kind: 'pacing', severity: 'medium' });
  });
});
