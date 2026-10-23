import { rmSync } from 'node:fs';
import type { ChapterMemoryOutput, RelationChangesOutput } from '@fudiao/prompts';
import { afterEach, describe, expect, it } from 'vitest';
import { fsDeps, type TestDeps } from '../testing/fs-deps';
import { addTestedModel, reply } from '../testing/models';
import { membersAt, presenceTimelines } from './relations';
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

type App = ReturnType<typeof createAppService>;

const memory = (summary: string, cast: ChapterMemoryOutput['cast']): ChapterMemoryOutput => ({ summary, cast, foreshadows: [], openThreads: [] });

/** 四章都有正文；沈孤舟与顾寒衣是灭门仇敌；第一、二章整理过长篇记忆。 */
async function setup() {
  const deps = fsDeps();
  all.push(deps);
  const app = createAppService(deps);
  value(await app.loadLibrary());
  value(await app.createWork('长夜问刀'));
  const ids: string[] = [];
  for (const title of ['塞北残灯', '古玉冷痕', '恶客临门', '残刀夜奔']) {
    const work = value(await app.createChapter(title, ids.at(-1)));
    const chapter = work.chapters.at(-1)!;
    ids.push(chapter.id);
    const opened = value(await app.openChapter(chapter.id));
    value(await app.saveChapter(chapter.id, opened.saved, [{ id: `p-${ids.length}`, text: `${title}的正文。`, source: 'handwritten' }], { splits: [], merges: [] }));
  }
  const shen = value(await app.createEntity('character', '沈孤舟')).created;
  const gu = value(await app.createEntity('character', '顾寒衣')).created;
  const chu = value(await app.createEntity('character', '楚晚晴')).created;
  value(await app.updateEntity(shen, { aliases: ['沈三'], description: '塞北刀客，沈家唯一的活口' }));
  value(await app.addRelationship({ fromId: shen.id, toId: gu.id, category: 'enemy', label: '灭门仇敌', mutual: true, description: '顾家灭了沈家满门', secret: false, validFromChapterId: null, validToChapterId: null }));
  await addTestedModel(app, deps);
  const [c1, c2, c3, c4] = ids as [string, string, string, string];
  deps.llmResponses.push(reply(JSON.stringify(memory('沈孤舟在塞北客栈遇见楚晚晴。', [{ name: '沈孤舟', state: '负伤' }, { name: '楚晚晴', state: '在客栈' }]))));
  value(await app.buildMemory(c1));
  deps.llmResponses.push(reply(JSON.stringify(memory('顾寒衣找上门，两人约定先联手对付藏锋山庄；楚晚晴远走西域。', [{ name: '沈孤舟', state: '答应联手' }, { name: '顾寒衣', state: '与沈孤舟同行' }]))));
  value(await app.buildMemory(c2));
  deps.llmRequests.length = 0;
  return { deps, app, c1, c2, c3, c4, shen: shen.id, gu: gu.id, chu: chu.id };
}

const changes = (patch: Partial<RelationChangesOutput> = {}): RelationChangesOutput => ({
  relations: [
    { chapter: 'C1', kind: 'change', relation: 'R1', from: '沈孤舟', to: '顾寒衣', category: 'ally', label: '暂时联手', mutual: true, description: '先对付藏锋山庄', secret: false, reason: 'C1：两人约定先联手' },
    { chapter: 'C1', kind: 'add', relation: '', from: '白衣人', to: '沈孤舟', category: 'enemy', label: '刺客', mutual: false, description: '奉命取沈孤舟性命', secret: true, reason: '' },
  ],
  cast: [
    { chapter: 'C1', kind: 'enter', name: '白衣人', description: '雨夜里出手的剑客', reason: '' },
    { chapter: 'C1', kind: 'exit', name: '楚晚晴', description: '远走西域', reason: '' },
  ],
  ...patch,
});

const bodyText = (deps: TestDeps, index: number) => JSON.stringify(deps.llmRequests[index]?.body ?? {});
const sentence = (app: App) => async () => {
  const view = value(await app.relationsView());
  const nameOf = new Map(view.members.map((m) => [m.id, m.name]));
  const titleOf = new Map(value(await app.reloadWork()).chapters.map((c) => [c.id, c.title]));
  const at = (id: string | null) => (id === null ? '' : (titleOf.get(id) ?? '?'));
  return view.relationships.map((r) => `${nameOf.get(r.fromId)}-${nameOf.get(r.toId)}:${r.label}[${at(r.validFromChapterId)}~${at(r.validToChapterId)}]`);
};

describe('人物关系随剧情变化（B73 补充）', () => {
  it('从一章的长篇记忆找出变化，存为待确认的建议：记下来源章节、记忆版本与调用记录；说明里的标签换成章节名', async () => {
    const { deps, app, c2, shen } = await setup();
    deps.llmResponses.push(reply(JSON.stringify(changes())));
    expect(value(await app.findRelationChanges([c2]))).toEqual({ scanned: 1, added: 4, dropped: 0 });
    const request = bodyText(deps, 0);
    for (const part of ['[R1] 沈孤舟与顾寒衣：灭门仇敌：顾家灭了沈家满门', '- 沈孤舟（又名沈三）：塞北刀客', '[C1] 古玉冷痕：顾寒衣找上门', '沈孤舟：答应联手']) expect(request).toContain(part);
    // 三人在这一章之前或这一章都出场了。
    expect(request).not.toContain('还没出场');
    const view = value(await app.relationChangesView());
    expect(view.suggestions.map((s) => `${s.kind}:${s.fromName}`)).toEqual(['cast_enter:白衣人', 'relation_add:白衣人', 'relation_change:沈孤舟', 'cast_exit:楚晚晴']);
    expect(view.suggestions[2]).toMatchObject({ chapterId: c2, fromId: shen, oldLabel: '灭门仇敌', label: '暂时联手', reason: '《古玉冷痕》：两人约定先联手', status: 'pending' });
    expect(view.suggestions.every((s) => s.llmCallId !== null && s.memoryVersion === 1)).toBe(true);
    expect(value(await app.relationSuggestionCount())).toBe(4);
    // 第二章找过了；第一章的记忆还没找过，第三、四章没有记忆。
    expect(view.scan).toEqual({ todo: [expect.any(String)], noMemory: 2 });
  });

  it('全部采用：改变的旧关系到上一章为止、新的从这一章起；新人物建卡片并记下出场；退场记下说明；按章节查看时退场的人物不显示', async () => {
    const { deps, app, c1, c2, c3, chu } = await setup();
    deps.llmResponses.push(reply(JSON.stringify(changes())));
    value(await app.findRelationChanges([c2]));
    expect(value(await app.adoptAllRelationSuggestions())).toEqual({ adopted: 4, failed: [] });
    expect(await sentence(app)()).toEqual(['沈孤舟-顾寒衣:灭门仇敌[~塞北残灯]', '白衣人-沈孤舟:刺客[古玉冷痕~]', '沈孤舟-顾寒衣:暂时联手[古玉冷痕~]']);
    const entities = value(await app.listEntities());
    const white = entities.find((e) => e.name === '白衣人');
    expect(white).toMatchObject({ kind: 'character', description: '雨夜里出手的剑客' });
    const presence = value(await app.castPresenceView());
    expect(presence.records.map((r) => `${entities.find((e) => e.id === r.entityId)?.name}:${r.kind}:${r.note}`).sort()).toEqual(['楚晚晴:exit:远走西域', '白衣人:enter:']);
    expect(presence.firstChapter[white!.id]).toBe(c2);
    expect(value(await app.relationSuggestionCount())).toBe(0);
    expect(value(await app.relationChangesView()).suggestions).toEqual([]);

    const view = value(await app.relationsView());
    const order = value(await app.reloadWork()).chapters.map((c) => c.id);
    const timelines = presenceTimelines(view.presence, order);
    const shown = (index: number) => membersAt(view.members, timelines, index).map((m) => m.name);
    expect(shown(order.indexOf(c1))).toEqual(['楚晚晴', '沈孤舟']);
    expect(shown(order.indexOf(c2))).toEqual(['楚晚晴', '沈孤舟', '白衣人', '顾寒衣']);
    expect(shown(order.indexOf(c3))).not.toContain('楚晚晴');
    expect(timelines.get(chu)?.changes).toEqual([{ kind: 'exit', at: 1, note: '远走西域' }]);
  });

  it('先采用连到新人物的关系：顺带采用他的出场；同一条再采用不会重复建；结束找不到原来关系时说明可以忽略', async () => {
    const { deps, app, c2 } = await setup();
    deps.llmResponses.push(reply(JSON.stringify(changes())));
    value(await app.findRelationChanges([c2]));
    const list = value(await app.relationChangesView()).suggestions;
    value(await app.adoptRelationSuggestion(list.find((s) => s.kind === 'relation_add')!.id));
    expect(value(await app.relationChangesView()).suggestions.map((s) => s.kind)).toEqual(['relation_change', 'cast_exit']);
    expect(value(await app.listEntities()).filter((e) => e.name === '白衣人')).toHaveLength(1);
    expect(await app.adoptRelationSuggestion(list.find((s) => s.kind === 'relation_add')!.id)).toMatchObject({ ok: false });

    // 第三章：结束一条已经不存在的关系。
    const { c3 } = await setupMore(app, deps);
    deps.llmResponses.push(
      reply(JSON.stringify({ relations: [{ chapter: 'C1', kind: 'end', relation: 'R2', from: '白衣人', to: '沈孤舟', category: 'enemy', label: '刺客', mutual: false, description: '', secret: true, reason: '' }], cast: [] })),
    );
    value(await app.findRelationChanges([c3]));
    const end = value(await app.relationChangesView()).suggestions.find((s) => s.kind === 'relation_end')!;
    const view = value(await app.relationsView());
    const assassin = view.relationships.find((r) => r.label === '刺客')!;
    value(await app.deleteRelationship(assassin));
    expect(await app.adoptRelationSuggestion(end.id)).toMatchObject({ ok: false, error: { code: 'settings', detail: expect.stringContaining('这条建议可以忽略') } });
    value(await app.ignoreRelationSuggestion(end.id));
    expect(value(await app.relationChangesView()).suggestions.map((s) => s.kind)).toEqual(['relation_change', 'cast_exit']);
  });

  it('后面几章找变化时，给模型的现在的关系与人物叠上前面待确认的建议；重新找时换掉待确认的、不再提忽略过的', async () => {
    const { deps, app, c2 } = await setup();
    deps.llmResponses.push(reply(JSON.stringify(changes())));
    value(await app.findRelationChanges([c2]));
    const { c3 } = await setupMore(app, deps);
    deps.llmResponses.push(reply(JSON.stringify({ relations: [], cast: [] })));
    value(await app.findRelationChanges([c3]));
    const later = bodyText(deps, deps.llmRequests.length - 1);
    for (const part of ['沈孤舟与顾寒衣：暂时联手', '白衣人是沈孤舟的刺客', '白衣人：雨夜里出手的剑客〔待作者确认的新人物〕', '楚晚晴〔第 2 章退场：远走西域〕']) expect(later).toContain(part);
    expect(later).not.toContain('灭门仇敌');

    const exit = value(await app.relationChangesView()).suggestions.find((s) => s.kind === 'cast_exit')!;
    value(await app.ignoreRelationSuggestion(exit.id));
    deps.llmResponses.push(reply(JSON.stringify(changes())));
    expect(value(await app.findRelationChanges([c2]))).toEqual({ scanned: 1, added: 3, dropped: 1 });
    expect(value(await app.relationSuggestionCount())).toBe(3);
  });

  it('从已写的章节找出变化：按书中顺序分批，只找还没按当前这一版记忆找过的；记忆重建后那一章再找一次；没有记忆的章节不找', async () => {
    const { deps, app, c1, c2 } = await setup();
    deps.llmResponses.push(reply(JSON.stringify(changes())));
    value(await app.findRelationChanges([c2]));
    const { c3 } = await setupMore(app, deps);
    const before = deps.llmRequests.length;
    deps.llmResponses.push(reply(JSON.stringify({ relations: [], cast: [] })));
    const done = value(await app.backfillRelationChanges());
    expect(done).toMatchObject({ batches: 1, scanned: 2, left: 0, stop: null });
    // 第一章与第三章一次找完。
    expect(deps.llmRequests.length - before).toBe(1);
    expect(bodyText(deps, before)).toContain('[C2] 恶客临门');
    expect(value(await app.relationChangesView()).scan.todo).toEqual([]);
    expect(value(await app.backfillRelationChanges())).toMatchObject({ batches: 0, scanned: 0 });

    deps.llmResponses.push(reply(JSON.stringify(memory('沈孤舟在塞北客栈养伤。', [{ name: '沈孤舟', state: '负伤' }]))));
    value(await app.buildMemory(c1));
    expect(value(await app.relationChangesView()).scan.todo).toEqual([c1]);
    expect(await app.findRelationChanges([c3 + 'x'])).toMatchObject({ ok: false, error: { code: 'settings' } });
  });

  it('补找时某一批没有做成：停下并说明还剩几章，已找完的批次留着', async () => {
    const { deps, app } = await setup();
    await setupMore(app, deps);
    deps.llmResponses.push({ status: 400, body: JSON.stringify({ error: { message: 'bad', type: 'invalid_request_error' } }) });
    const done = value(await app.backfillRelationChanges());
    expect(done).toMatchObject({ batches: 0, scanned: 0, left: 3 });
    expect(done.stop).not.toBeNull();
  });

  it('关系改变落在原来那条开始的章节：就地改成新的样子；人物的出场与退场可以记下、修改与删除', async () => {
    const { deps, app, c2, c3, gu } = await setup();
    const view = value(await app.relationsView());
    const old = view.relationships[0]!;
    value(await app.updateRelationship(old, { ...old, validFromChapterId: c2 }));
    deps.llmResponses.push(reply(JSON.stringify(changes({ cast: changes().cast.slice(0, 1) }))));
    value(await app.findRelationChanges([c2]));
    value(await app.adoptAllRelationSuggestions());
    expect(await sentence(app)()).toEqual(['沈孤舟-顾寒衣:暂时联手[古玉冷痕~]', '白衣人-沈孤舟:刺客[古玉冷痕~]']);

    let presence = value(await app.saveCastPresence(null, { entityId: gu, chapterId: c2, kind: 'exit', note: '坠崖' }));
    const record = presence.records.find((r) => r.entityId === gu)!;
    presence = value(await app.saveCastPresence(record, { entityId: gu, chapterId: c3, kind: 'exit', note: '坠崖身亡' }));
    expect(presence.records.find((r) => r.entityId === gu)).toMatchObject({ chapterId: c3, note: '坠崖身亡' });
    presence = value(await app.deleteCastPresence(presence.records.find((r) => r.entityId === gu)!));
    expect(presence.records.filter((r) => r.entityId === gu)).toEqual([]);
  });

  it('规划交给模型的人物说明带上退场：“第 N 章退场：说明”', async () => {
    const { deps, app, c2, chu } = await setup();
    value(await app.saveCastPresence(null, { entityId: chu, chapterId: c2, kind: 'exit', note: '远走西域' }));
    value(await app.updateWorkInfo({ outline: '沈孤舟报仇。' }));
    deps.llmResponses.push(reply(JSON.stringify({ chapters: [], foreshadows: [] })));
    await app.draftPlans({ chapterCount: 2, wordsPerChapter: 2000 });
    expect(bodyText(deps, 0)).toContain('（第 2 章退场：远走西域）');
  });
});

/** 第三章也整理长篇记忆。 */
async function setupMore(app: App, deps: TestDeps) {
  const c3 = value(await app.reloadWork()).chapters[2]!.id;
  deps.llmResponses.push(reply(JSON.stringify(memory('白衣人再次现身，沈孤舟与顾寒衣并肩退敌。', [{ name: '沈孤舟', state: '与顾寒衣同行' }]))));
  value(await app.buildMemory(c3));
  return { c3 };
}
