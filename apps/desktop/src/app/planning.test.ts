import { rmSync } from 'node:fs';
import type { PlanDraftData } from '@fudiao/prompts';
import { afterEach, describe, expect, it } from 'vitest';
import { fsDeps, type TestDeps } from '../testing/fs-deps';
import { addTestedModel, reply } from '../testing/models';
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
  value(await app.updateWorkInfo({ outline: '林舟深夜当玉，掌柜钱四起疑压价；第三章真相揭晓，玉是父亲的遗物。' }));
  value(await app.createChapter('第一章 夜叩'));
  const lin = value(await app.createEntity('character', '林舟')).created;
  value(await app.updateEntity(lin, { aliases: ['林相公'] }));
  value(await app.createEntity('character', '钱四'));
  return { deps, app };
}

const draft: PlanDraftData = {
  chapters: [
    { title: '夜叩', goal: '林舟当玉被压价', cast: ['林相公', '钱四'], beats: ['叩门', ' 压价 ', ''], plant: ['玉佩的来历'], payoff: [], treatment: '压价略写', targetWords: 3000 },
    { title: '第二章 夜雨', goal: '林舟另寻门路', cast: ['林舟', '阿青'], beats: ['雨中奔走'], plant: [], payoff: [], treatment: '', targetWords: null },
    { title: '第三章 揭晓', goal: '真相揭晓', cast: ['林舟'], beats: ['对质'], plant: [], payoff: ['玉佩的来历'], treatment: '对质展开', targetWords: 4000 },
  ],
  foreshadows: [{ title: '玉佩的来历', content: '钱四多看了玉佩一眼', reveal: '玉佩是林舟父亲的遗物' }],
};

describe('章节计划草稿', () => {
  it('由大纲生成草稿，不写入作品', async () => {
    const { deps, app } = await setup();
    await addTestedModel(app, deps);
    deps.llmResponses.push(reply(JSON.stringify(draft)));
    const result = value(await app.draftPlans({ chapterCount: 3, wordsPerChapter: 3000 }));
    expect(result.chapters).toHaveLength(3);
    const view = value(await app.planningView());
    expect(view.chapters.map((c) => c.plan)).toEqual([null]);
    expect(view.foreshadows).toEqual([]);
  });

  it('请求带上人物的说明与启用的规划技能（B75）：雪花写作法与要求视角人物写在详略说明开头', async () => {
    const { deps, app } = await setup();
    await addTestedModel(app, deps);
    const qian = value(await app.planningView()).characters.find((c) => c.name === '钱四')!;
    value(await app.updateEntity(qian, { description: '当铺掌柜，精明，认得这块玉' }));
    deps.llmRequests.length = 0;
    deps.llmResponses.push(reply(JSON.stringify(draft)));
    value(await app.draftPlans({ chapterCount: 3, wordsPerChapter: 3000 }));
    const body = JSON.stringify(deps.llmRequests[0]?.body ?? {});
    for (const part of ['- 钱四：当铺掌柜，精明，认得这块玉', '- 林舟', '【雪花写作法】', '场景—后续', '写在详略说明（treatment）的开头']) expect(body).toContain(part);
  });

  it('没有大纲时说明原因，不调用模型', async () => {
    const { deps, app } = await setup();
    await addTestedModel(app, deps);
    value(await app.updateWorkInfo({ outline: ' ' }));
    expect(await app.draftPlans({ chapterCount: 3, wordsPerChapter: 3000 })).toMatchObject({ ok: false, error: { code: 'settings' } });
  });
});

describe('采用草稿', () => {
  it('已有章节对应草稿的前几章（章名不改），多出的章节在末尾新建；伏笔记入账本并定好埋设与回收章节', async () => {
    const { app } = await setup();
    const applied = value(await app.applyPlanDraft(draft));
    const { view } = applied;
    expect(view.chapters.map((c) => c.chapter.title)).toEqual(['第一章 夜叩', '第二章 夜雨', '第三章 揭晓']);
    const [first, second, third] = view.chapters;
    const jade = view.foreshadows[0]!;
    expect(jade).toMatchObject({ title: '玉佩的来历', status: 'planned', plantChapterId: first!.chapter.id, payoffChapterId: third!.chapter.id });
    expect(first!.plan).toMatchObject({ goal: '林舟当玉被压价', beats: ['叩门', '压价'], foreshadowPlant: [jade.id], targetWords: 3000, status: 'todo' });
    expect(third!.plan).toMatchObject({ foreshadowPayoff: [jade.id] });
    // 人物按名字与别名对应；找不到的名字列出来，不新建设定。
    const names = new Map(view.characters.map((c) => [c.id, c.name]));
    expect(first!.plan!.castIds.map((id) => names.get(id))).toEqual(['林舟', '钱四']);
    expect(second!.plan!.castIds.map((id) => names.get(id))).toEqual(['林舟']);
    expect(applied.unmatchedCast).toEqual(['阿青']);
    expect(view.chapters.every((c) => c.problems.length === 0)).toBe(true);
  });

  it('分卷的草稿（B68）：卷按卷名对应，已有的沿用并补上空的简介、没有的在最后新建并写上梗概；未分卷的已有章节移进草稿给它的卷，新章节放进各自的卷', async () => {
    const { app } = await setup();
    const existing = value(await app.createVolume('第一卷 雨夜')).volumes[0]!;
    const volumed: PlanDraftData = {
      ...draft,
      volumes: [
        { title: '第一卷 雨夜', summary: '林舟当玉' },
        { title: '第二卷 天明', summary: '真相揭晓' },
      ],
      chapters: draft.chapters.map((c, i) => ({ ...c, volume: i < 2 ? '第一卷 雨夜' : '第二卷 天明' })),
    };
    value(await app.applyPlanDraft(volumed));
    const work = value(await app.reloadWork());
    expect(work.volumes.map((v) => [v.id === existing.id, v.title, v.summary])).toEqual([
      [true, '第一卷 雨夜', '林舟当玉'],
      [false, '第二卷 天明', '真相揭晓'],
    ]);
    const volumeTitle = (id: string | null) => work.volumes.find((v) => v.id === id)?.title ?? null;
    expect(work.chapters.map((c) => [c.title, volumeTitle(c.volumeId)])).toEqual([
      ['第一章 夜叩', '第一卷 雨夜'],
      ['第二章 夜雨', '第一卷 雨夜'],
      ['第三章 揭晓', '第二卷 天明'],
    ]);
  });

  it('分卷的草稿：作者已经放进某一卷的章节不动，已有卷的简介不被覆盖；不分卷的草稿不建卷', async () => {
    const { app } = await setup();
    const mine = value(await app.createVolume('楔子卷')).volumes[0]!;
    const described = value(await app.updateVolume(mine, { title: '楔子卷', summary: '作者写的' })).volumes[0]!;
    const first = value(await app.reloadWork()).chapters[0]!;
    value(await app.moveChapter(first, { volumeId: described.id, after: null }));
    value(await app.applyPlanDraft({ ...draft, volumes: [{ title: '楔子卷', summary: '模型写的' }], chapters: draft.chapters.map((c) => ({ ...c, volume: '楔子卷' })) }));
    const work = value(await app.reloadWork());
    expect(work.volumes.map((v) => [v.title, v.summary])).toEqual([['楔子卷', '作者写的']]);
    expect(work.chapters.every((c) => c.volumeId === described.id)).toBe(true);

    const { app: plain } = await setup();
    value(await plain.applyPlanDraft(draft));
    expect(value(await plain.reloadWork()).volumes).toEqual([]);
  });

  it('再次采用时沿用已有的伏笔、更新已有的计划', async () => {
    const { app } = await setup();
    value(await app.applyPlanDraft(draft));
    const again = value(await app.applyPlanDraft({ ...draft, chapters: draft.chapters.map((c) => ({ ...c, goal: `${c.goal}（改）` })) })).view;
    expect(again.foreshadows).toHaveLength(1);
    expect(again.chapters).toHaveLength(3);
    expect(again.chapters[0]!.plan).toMatchObject({ goal: '林舟当玉被压价（改）', version: 2 });
  });

  it('给一卷采用章节计划时计划没写成：新建的章节移入回收站，再采用不会多出一套章', async () => {
    const { app } = await setup();
    const volume = value(await app.createVolume('第二卷')).volumes.at(-1)!;
    // target_words 是 STRICT 表的整数列：小数写不进去，计划在建完章节之后写入失败。
    const broken = { ...draft, chapters: draft.chapters.map((c) => ({ ...c, targetWords: 1.5 })) };
    expect((await app.applyVolumeDraft(broken, volume.id)).ok).toBe(false);
    const work = value(await app.reloadWork());
    expect(work.chapters.map((c) => c.title)).toEqual(['第一章 夜叩']);
    expect(work.trashed.map((c) => c.title).sort()).toEqual(['夜叩', '第二章 夜雨', '第三章 揭晓'].sort());
    const applied = value(await app.applyVolumeDraft(draft, volume.id));
    expect(applied.view.chapters.filter((c) => c.chapter.volumeId === volume.id)).toHaveLength(3);
  });

  it('账本里已有、还没有定章节的伏笔：按草稿补上埋设与回收的章节；作者定过的章节不改', async () => {
    const { app } = await setup();
    const blank = { content: '', plantAnchor: null, payoffAnchor: null, status: 'planned' as const };
    value(await app.addForeshadow({ ...blank, title: '玉佩的来历', reveal: '玉佩是遗物', plantChapterId: null, payoffChapterId: null }));
    const view = value(await app.applyPlanDraft(draft)).view;
    const [first, , third] = view.chapters;
    expect(view.foreshadows).toHaveLength(1);
    expect(view.foreshadows[0]).toMatchObject({ plantChapterId: first!.chapter.id, payoffChapterId: third!.chapter.id, reveal: '玉佩是遗物' });

    // 作者把回收改到了第二章：再次采用草稿时不改回去。
    const moved = value(await app.updateForeshadow(view.foreshadows[0]!, { ...view.foreshadows[0]!, payoffChapterId: view.chapters[1]!.chapter.id }));
    const again = value(await app.applyPlanDraft(draft)).view;
    expect(again.foreshadows[0]).toMatchObject({ plantChapterId: first!.chapter.id, payoffChapterId: moved.chapters[1]!.chapter.id });
  });
});

describe('账本状态的建议', () => {
  it('埋设的章节写完后建议标为已埋，带上长篇记忆里的进展；作者标过之后不再建议', async () => {
    const { deps, app } = await setup();
    await addTestedModel(app, deps);
    const view = value(await app.applyPlanDraft(draft)).view;
    const first = view.chapters[0]!;
    const jade = view.foreshadows[0]!;
    expect(view.foreshadowSuggestions).toEqual([]);

    // 第一章计划三千字，分两段写。
    deps.llmResponses.push(reply('林舟叩响了门。'), reply('钱四多看了玉佩一眼。'));
    expect(value(await app.writeChapter(first.chapter.id))).toMatchObject({ status: 'written' });
    // 还没有长篇记忆：只说章节写完了。
    expect(value(await app.planningView()).foreshadowSuggestions).toEqual([{ foreshadowId: jade.id, status: 'planted', chapterId: first.chapter.id, progress: null }]);

    deps.llmResponses.push(reply(JSON.stringify({ summary: '林舟当玉。', cast: [], foreshadows: [{ title: '玉佩的来历', progress: '钱四多看了玉佩一眼' }] })));
    value(await app.buildMemory(first.chapter.id));
    const after = value(await app.planningView());
    expect(after.foreshadowSuggestions).toEqual([{ foreshadowId: jade.id, status: 'planted', chapterId: first.chapter.id, progress: '钱四多看了玉佩一眼' }]);

    const current = after.foreshadows[0]!;
    expect(value(await app.updateForeshadow(current, { ...current, status: 'planted' })).foreshadowSuggestions).toEqual([]);
  });
});

describe('计划与伏笔账本的编辑', () => {
  it('保存计划；回收章节在埋设章节之前时列出问题', async () => {
    const { app } = await setup();
    const view = value(await app.applyPlanDraft(draft)).view;
    const jade = view.foreshadows[0]!;
    const first = view.chapters[0]!;
    const saved = value(await app.savePlan(first.chapter.id, { ...first.plan!, foreshadowPlant: [], foreshadowPayoff: [jade.id] }));
    // 玉佩的埋设章节是第一章，在第一章回收没有问题；把埋设改到第三章后，第一章的回收就在埋设之前。
    expect(saved.chapters[0]!.problems).toEqual([]);
    const moved = value(await app.updateForeshadow(jade, { ...jade, plantChapterId: view.chapters[2]!.chapter.id }));
    expect(moved.chapters[0]!.problems).toEqual([{ code: 'payoff_before_plant', foreshadowId: jade.id }]);
  });

  it('伏笔的新建、修改与删除', async () => {
    const { app } = await setup();
    const fields = { title: '债主', content: '', reveal: '债主是钱四的表兄', plantChapterId: null, plantAnchor: null, payoffChapterId: null, payoffAnchor: null, status: 'planned' as const };
    const added = value(await app.addForeshadow(fields));
    const debt = added.foreshadows[0]!;
    const edited = value(await app.updateForeshadow(debt, { ...fields, status: 'dropped' }));
    expect(edited.foreshadows[0]).toMatchObject({ status: 'dropped', version: 2 });
    expect(await app.updateForeshadow(debt, fields)).toMatchObject({ ok: false, error: { code: 'repo', error: { code: 'conflict' } } });
    expect(value(await app.deleteForeshadow(edited.foreshadows[0]!)).foreshadows).toEqual([]);
  });
});
