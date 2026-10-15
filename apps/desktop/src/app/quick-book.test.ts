import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { fsDeps, type TestDeps } from '../testing/fs-deps';
import { addTestedModel, reply } from '../testing/models';
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
  return { deps, app };
}

const seed: BookSeed = {
  title: '当铺夜谈',
  genre: '古风悬疑',
  synopsis: '落魄书生林舟深夜当玉，掌柜钱四认出了玉的来历。',
  outline: '开端：林舟当玉。发展：钱四起疑，暗中打听。高潮：玉佩的主人现身。结局：林舟得知身世。',
  characters: [
    { name: '林舟', description: '落魄书生，好面子' },
    { name: '钱四', description: '当铺掌柜，精明多疑' },
  ],
};

describe('快速成书（B67）', () => {
  it('各步的状态：没有默认模型时说明原因；有了模型、骨架、计划之后逐步变化', async () => {
    const { deps, app } = await setup();
    expect(value(await app.quickBookStatus())).toEqual({
      model: { ready: false, name: null, problem: '还没有设置默认模型' },
      outline: false,
      characters: 0,
      chapters: 0,
      planned: 0,
      written: 0,
      reviewed: 0,
      pendingIssues: 0,
    });
    await addTestedModel(app, deps);
    value(await app.applyBookSeed(seed));
    expect(value(await app.quickBookStatus())).toMatchObject({ model: { ready: true, problem: null }, outline: true, characters: 2, chapters: 0 });
  });

  it('由一句话的想法生成骨架：请求带上想法、章数与已有人物，结果不写入作品', async () => {
    const { deps, app } = await setup();
    await addTestedModel(app, deps);
    value(await app.createEntity('character', '林舟'));
    deps.llmRequests.length = 0;
    deps.llmResponses.push(reply(JSON.stringify(seed)));
    const drafted = value(await app.draftBookSeed({ idea: '落魄书生当铺夜遇旧主', genre: '古风悬疑', chapterCount: 12, wordsPerChapter: 3000 }));
    // 较早格式的输出没有人物关系，解析后为空。
    expect(drafted).toEqual({ ...seed, relationships: [] });
    const body = JSON.stringify(deps.llmRequests[0]?.body ?? {});
    for (const part of ['落魄书生当铺夜遇旧主', '计划写 12 章', '已有的人物：林舟；', '作品名：新作品']) expect(body).toContain(part);
    expect(value(await app.reloadWork()).project).toMatchObject({ outline: '', title: '新作品' });
    expect(await app.draftBookSeed({ idea: ' ', genre: '', chapterCount: 5, wordsPerChapter: 2000 })).toMatchObject({ ok: false, error: { code: 'settings' } });
  });

  it('生成骨架时带上启用的规划技能（B75）：默认有雪花写作法，停用后不带；写章节的技能不带', async () => {
    const { deps, app } = await setup();
    await addTestedModel(app, deps);
    deps.llmRequests.length = 0;
    deps.llmResponses.push(reply(JSON.stringify(seed)), reply(JSON.stringify(seed)));
    value(await app.draftBookSeed({ idea: '落魄书生当铺夜遇旧主', genre: '', chapterCount: 12, wordsPerChapter: 3000 }));
    const first = JSON.stringify(deps.llmRequests[0]?.body ?? {});
    for (const part of ['规划技能', '【雪花写作法】', '三次越来越重的挫折', '动机', '领悟']) expect(first).toContain(part);
    expect(first).not.toContain('【章末钩子】');
    const snowflake = value(await app.listWritingSkills()).skills.find((s) => s.skill.key === 'snowflake')!;
    value(await app.updateWritingSkill(snowflake.skill, { enabled: false }));
    value(await app.draftBookSeed({ idea: '落魄书生当铺夜遇旧主', genre: '', chapterCount: 12, wordsPerChapter: 3000 }));
    expect(JSON.stringify(deps.llmRequests[1]?.body ?? {})).not.toContain('规划技能');
  });

  it('采用骨架：写入作品名、类型、简介与大纲，作品列表随之改名；人物新建并写上说明，已有的不改，重复采用不重复建', async () => {
    const { app } = await setup();
    const lin = value(await app.createEntity('character', '林舟')).created;
    value(await app.updateEntity(lin, { description: '作者写的说明', aliases: ['林生'] }));
    expect(value(await app.applyBookSeed({ ...seed, characters: [...seed.characters, { name: '林生', description: '别名' }] }))).toEqual({ created: 1, relations: 0 });
    const work = value(await app.reloadWork());
    expect(work.project).toMatchObject({ title: '当铺夜谈', genre: '古风悬疑', synopsis: seed.synopsis, outline: seed.outline });
    expect(work.entry.title).toBe('当铺夜谈');
    const characters = value(await app.listEntities()).filter((e) => e.kind === 'character');
    expect(characters.map((e) => [e.name, e.description])).toEqual(
      expect.arrayContaining([
        ['林舟', '作者写的说明'],
        ['钱四', '当铺掌柜，精明多疑'],
      ]),
    );
    expect(characters).toHaveLength(2);
    expect(value(await app.applyBookSeed(seed))).toEqual({ created: 0, relations: 0 });
    expect(await app.applyBookSeed({ ...seed, outline: ' ' })).toMatchObject({ ok: false, error: { detail: expect.stringContaining('大纲不能为空') } });
  });

  it('骨架里的人物关系（B73）按名字（含别名）建立；对不上的人物、自己连自己与重复的关系跳过', async () => {
    const { app } = await setup();
    const relation = (from: string, to: string, label: string, extra: Partial<NonNullable<BookSeed['relationships']>[number]> = {}) => ({
      from,
      to,
      label,
      category: 'enemy' as const,
      mutual: false,
      secret: false,
      description: '',
      ...extra,
    });
    const withRelations: BookSeed = {
      ...seed,
      characters: [...seed.characters, { name: '阿青', description: '' }],
      relationships: [
        relation('钱四', '林舟', '债主', { description: '林舟欠他三百两' }),
        relation('钱四', '阿青', '生父', { category: 'family', secret: true }),
        relation('林舟', '阿青', '旧识', { category: 'ally', mutual: true }),
        relation('林舟', '无名氏', '仇人'),
        relation('林舟', '林舟', '自己'),
        relation('钱四', '林舟', '债主'),
      ],
    };
    expect(value(await app.applyBookSeed(withRelations))).toEqual({ created: 3, relations: 3 });
    const view = value(await app.relationsView());
    const name = new Map(view.members.map((m) => [m.id, m.name]));
    expect(view.relationships.map((r) => [name.get(r.fromId), r.label, name.get(r.toId), r.category, r.mutual, r.secret, r.description])).toEqual([
      ['钱四', '债主', '林舟', 'enemy', false, false, '林舟欠他三百两'],
      ['钱四', '生父', '阿青', 'family', false, true, ''],
      ['林舟', '旧识', '阿青', 'ally', true, false, ''],
    ]);
    // 再采用一次不重复建。
    expect(value(await app.applyBookSeed(withRelations))).toEqual({ created: 0, relations: 0 });
  });

  it('采用骨架之后，计划草稿里的人物都能对上设定', async () => {
    const { deps, app } = await setup();
    await addTestedModel(app, deps);
    value(await app.applyBookSeed(seed));
    const plan = {
      chapters: [{ title: '第一章 夜叩', goal: '林舟当玉', cast: ['林舟', '钱四'], beats: ['叩门', '压价'], plant: [], payoff: [], treatment: '', targetWords: 3000 }],
      foreshadows: [],
    };
    deps.llmResponses.push(reply(JSON.stringify(plan)));
    const draft = value(await app.draftPlans({ chapterCount: 1, wordsPerChapter: 3000 }));
    const applied = value(await app.applyPlanDraft(draft));
    expect(applied.unmatchedCast).toEqual([]);
    expect(value(await app.quickBookStatus())).toMatchObject({ chapters: 1, planned: 1, written: 0 });
  });
});
