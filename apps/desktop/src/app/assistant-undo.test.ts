import { rmSync } from 'node:fs';
import type { AssistantTurnOutput } from '@fudiao/prompts';
import { afterEach, describe, expect, it } from 'vitest';
import { fsDeps, type TestDeps } from '../testing/fs-deps';
import { addTestedModel, reply } from '../testing/models';
import { undoTarget, type AssistantEffect, type AssistantItem } from './assistant';
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
  deps.llmRequests.length = 0;
  return { deps, app };
}

type App = Awaited<ReturnType<typeof setup>>['app'];
const step = (deps: TestDeps, output: AssistantTurnOutput) => deps.llmResponses.push(reply(JSON.stringify(output)));
const body = (deps: TestDeps, i: number) => JSON.stringify(deps.llmRequests[i]?.body ?? {});
const lastResults = (items: readonly AssistantItem[]) => items.filter((i): i is Extract<AssistantItem, { role: 'results' }> => i.role === 'results').at(-1);
const lastUndo = (items: readonly AssistantItem[]) => items.filter((i): i is Extract<AssistantItem, { role: 'undo' }> => i.role === 'undo').at(-1);

/** 作品里助手能改的结构化内容（比较撤销前后用）。 */
async function structure(app: App) {
  const work = value(await app.reloadWork());
  const planning = value(await app.planningView());
  const skills = value(await app.listWritingSkills());
  return {
    project: [work.project.title, work.project.genre, work.project.synopsis, work.project.outline],
    volumes: work.volumes.map((v) => [v.title, v.summary]),
    chapters: work.chapters.map((c) => [c.title, c.summary, work.volumes.find((v) => v.id === c.volumeId)?.title ?? null]),
    trashed: work.trashed.map((c) => c.title),
    entities: value(await app.listEntities()).map((e) => [e.kind, e.name, e.description, e.aliases]),
    relations: value(await app.relationsView()).relationships.map((r) => [r.label, r.mutual, r.secret]),
    plans: planning.chapters.flatMap((c) => (c.plan === null ? [] : [[c.chapter.title, c.plan.goal, c.plan.beats]])),
    foreshadows: planning.foreshadows.map((f) => [f.title, f.status]),
    skills: skills.skills.map((s) => [s.skill.name, s.skill.enabled, s.skill.instruction]),
    avoid: skills.avoidPhrases,
    facts: value(await app.listFacts()).map((f) => f.content),
  };
}

describe('撤销 AI 助手一轮的改动（M5-20）', () => {
  it('一轮里新建、修改、移动与删除的结构化内容都改回去；之后再说话时模型知道作者撤销了什么；不能撤销两次', async () => {
    const { deps, app } = await setup();
    const one = value(await app.createChapter('第一章 夜叩')).chapters[0]!;
    value(await app.createChapter('第二章 夜雨'));
    const lin = value(await app.createEntity('character', '林舟')).created;
    value(await app.updateEntity(lin, { description: '落魄书生' }));
    value(await app.createEntity('character', '钱四'));
    value(await app.savePlan(one.id, { goal: '林舟当玉', castIds: [lin.id], beats: ['叩门'], foreshadowPlant: [], foreshadowPayoff: [], treatment: '', targetWords: 3000 }));
    const before = await structure(app);

    step(deps, {
      message: '都改好了。',
      actions: [
        { tool: 'update_work', title: null, genre: '古风悬疑', synopsis: '林舟当玉。', outline: null },
        { tool: 'create_volume', title: '第一卷 雨夜', summary: '林舟当玉', after: null },
        { tool: 'move_chapter', chapter: '第二章 夜雨', volume: '第一卷 雨夜', after: null },
        { tool: 'create_chapter', title: '第三章 揭晓', volume: '第一卷 雨夜', after: null },
        { tool: 'update_chapter', chapter: '第一章 夜叩', title: '第一章 叩门', summary: '雨夜叩门', notes: null },
        { tool: 'create_entity', kind: 'character', name: '沈砚', description: '捕快', aliases: ['阿砚'] },
        { tool: 'update_entity', entity: '林舟', name: null, description: '被革职的捕快', aliases: null },
        { tool: 'add_relationship', from: '沈砚', to: '林舟', category: 'rival', label: '对头', mutual: true, description: null, secret: false, validFrom: null, validTo: null },
        { tool: 'save_chapter_plan', chapter: '第三章 揭晓', goal: '真相揭晓', beats: ['对质'], cast: ['沈砚'], targetWords: null },
        { tool: 'save_chapter_plan', chapter: '第一章 叩门', goal: '林舟叩门', beats: ['叩门', '压价'], cast: null, targetWords: null },
        { tool: 'add_foreshadow', title: '玉佩', content: '玉佩是遗物', reveal: null, plant: '第一章 叩门', payoff: null },
        { tool: 'remember_preference', preference: '对白要短' },
        { tool: 'add_avoid_phrases', phrases: ['不禁'] },
        { tool: 'set_skill', skill: '雪花写作法', enabled: false },
        { tool: 'add_fact', kind: 'world', content: '当铺在城南', holder: null, subjects: null },
        { tool: 'trash_chapter', chapter: '第二章 夜雨' },
      ],
      done: false,
    });
    const paused = value(await app.sendToAssistant('把这些都安排上'));
    expect(paused.pending).toBe(true);
    step(deps, { message: '都改好了。', actions: [], done: true });
    const changed = value(await app.resolveAssistantPending(true));
    expect(lastResults(changed.items)?.results.every((r) => r.ok)).toBe(true);
    expect(await structure(app)).not.toEqual(before);
    // 改动记在对话里，不给模型看。
    expect(changed.items.filter((i) => i.role === 'changes').length).toBeGreaterThan(10);
    expect(body(deps, 1)).not.toContain('"entries"');
    expect(undoTarget(changed.items)?.lastId).toBe(changed.items.at(-1)?.id);

    const effects: AssistantEffect[] = [];
    const undone = value(await app.undoAssistantTurn({ onEffect: (e) => effects.push(e) }));
    // 助手新建的章节移入回收站（不直接删掉），其余与改动之前相同。
    expect(await structure(app)).toEqual({ ...before, trashed: ['第三章 揭晓'] });
    const report = lastUndo(undone.items)?.report ?? '';
    for (const part of ['已撤销：', '新建的《第三章 揭晓》（移入了回收站）', '新建的设定“沈砚”', '改动的设定“林舟”', '新建的卷“第一卷 雨夜”', '改动的作品信息', '新建的《第三章 揭晓》的章节计划', '改动的《第一章 叩门》的章节计划']) {
      expect(report).toContain(part);
    }
    expect(report).not.toContain('没有撤销：');
    expect(effects).toContainEqual({ kind: 'changed' });
    expect(undoTarget(undone.items)).toBeNull();
    expect(await app.undoAssistantTurn()).toMatchObject({ ok: true });
    expect(lastUndo(value(await app.assistantItems()))?.id).toBe(lastUndo(undone.items)?.id);

    // 作品重新打开后，对话里的改动与撤销都还在；下一句话时模型看到作者撤销了什么。
    step(deps, { message: '好的。', actions: [], done: true });
    value(await app.sendToAssistant('刚才的撤销了'));
    expect(body(deps, 2)).toContain('作者在对话框里点了撤销：已撤销：');
  });

  it('删掉的设定连同它的关系一并重建：沿用原来的标识，以它为依据的事实与关系照旧指向它', async () => {
    const { deps, app } = await setup();
    const lin = value(await app.createEntity('character', '林舟')).created;
    value(await app.updateEntity(lin, { description: '落魄书生', aliases: ['阿舟'] }));
    value(await app.createEntity('character', '钱四'));
    step(deps, { message: '', actions: [{ tool: 'add_relationship', from: '林舟', to: '钱四', category: 'enemy', label: '仇人', mutual: true, description: '旧怨', secret: true, validFrom: null, validTo: null }], done: true });
    value(await app.sendToAssistant('林舟和钱四是仇人'));
    const before = await structure(app);

    step(deps, { message: '要删掉林舟，请确认。', actions: [{ tool: 'delete_entity', entity: '林舟' }], done: false });
    value(await app.sendToAssistant('删掉林舟'));
    step(deps, { message: '删了。', actions: [], done: true });
    value(await app.resolveAssistantPending(true));
    expect(value(await app.listEntities()).map((e) => e.name)).toEqual(['钱四']);

    const undone = value(await app.undoAssistantTurn());
    expect(await structure(app)).toEqual(before);
    const relation = value(await app.relationsView()).relationships[0]!;
    const rebuilt = value(await app.listEntities()).find((e) => e.name === '林舟')!;
    expect(rebuilt.id).toBe(lin.id);
    expect(rebuilt).toMatchObject({ description: '落魄书生', aliases: ['阿舟'] });
    expect([relation.fromId, relation.toId]).toContain(rebuilt.id);
    expect(lastUndo(undone.items)?.report).toContain('删掉的设定“林舟”');
    // 再撤销一次是更早的那一轮：关系也去掉。
    value(await app.undoAssistantTurn());
    expect(value(await app.relationsView()).relationships).toEqual([]);
  });

  it('另一段对话里删掉又撤销回来的卷（重建后换了标识）：回到建它的那段对话撤销时照样找得到', async () => {
    const { deps, app } = await setup();
    const titles = async () => value(await app.reloadWork()).volumes.map((v) => v.title).filter((t) => t === '第二卷 雨夜');
    step(deps, { message: '', actions: [{ tool: 'create_volume', title: '第二卷 雨夜', summary: '林舟当玉', after: null }], done: true });
    value(await app.sendToAssistant('建一卷'));
    const a = value(await app.assistantConversations()).current!;
    // 新的一段对话里删掉它、再撤销：卷重建了，标识换了，记在这一段的撤销记录里。
    value(await app.clearAssistant());
    step(deps, { message: '要删掉这一卷，请确认。', actions: [{ tool: 'delete_volume', volume: '第二卷 雨夜' }], done: false });
    value(await app.sendToAssistant('删掉第二卷'));
    step(deps, { message: '删了。', actions: [], done: true });
    value(await app.resolveAssistantPending(true));
    expect(await titles()).toEqual([]);
    value(await app.undoAssistantTurn());
    expect(await titles()).toEqual(['第二卷 雨夜']);
    // 回到最初那段撤销“建一卷”：去掉的是重建后的那一卷。
    value(await app.openAssistantConversation(a));
    const undone = value(await app.undoAssistantTurn());
    expect(lastUndo(undone.items)).toMatchObject({ ok: true });
    expect(await titles()).toEqual([]);
  });

  it('删掉的人物连同级联删掉的出场退场与关系图位置一并重建；待确认的关系变化建议不重建，说明里如实写明（审查后的修正 2026-10-29）', async () => {
    const { deps, app } = await setup();
    const lin = value(await app.createEntity('character', '林舟')).created;
    value(await app.createEntity('character', '钱四'));
    const chapter = value(await app.createChapter('第一章 夜叩')).chapters[0]!;
    const opened = value(await app.openChapter(chapter.id));
    value(await app.saveChapter(chapter.id, opened.saved, [{ id: 'p1', text: '林舟叩门，钱四验玉。', source: 'handwritten' }], { splits: [], merges: [] }));
    value(await app.saveCastPresence(null, { entityId: lin.id, chapterId: chapter.id, kind: 'exit', note: '远走西域' }));
    value(await app.setRelationPosition(lin.id, { x: 120, y: 40 }));
    // 一条待确认的关系变化建议（从这一章的长篇记忆找出），两端都是有卡片的人物。
    deps.llmResponses.push(reply(JSON.stringify({ summary: '林舟叩门。', cast: [{ name: '林舟', state: '叩门' }], foreshadows: [], openThreads: [] })));
    value(await app.buildMemory(chapter.id));
    deps.llmResponses.push(reply(JSON.stringify({ relations: [{ chapter: 'C1', kind: 'add', relation: '', from: '林舟', to: '钱四', category: 'ally', label: '旧识', mutual: true, description: '', secret: false, reason: '' }], cast: [] })));
    expect(value(await app.findRelationChanges([chapter.id]))).toMatchObject({ added: 1 });
    expect(value(await app.relationSuggestionCount())).toBe(1);
    deps.llmRequests.length = 0;

    step(deps, { message: '要删掉林舟，请确认。', actions: [{ tool: 'delete_entity', entity: '林舟' }], done: false });
    value(await app.sendToAssistant('删掉林舟'));
    step(deps, { message: '删了。', actions: [], done: true });
    value(await app.resolveAssistantPending(true));
    expect(value(await app.castPresenceView()).records).toEqual([]);
    expect(value(await app.relationsView()).positions).toEqual([]);
    expect(value(await app.relationSuggestionCount())).toBe(0);

    const undone = value(await app.undoAssistantTurn());
    expect(value(await app.listEntities()).map((e) => e.name)).toEqual(['林舟', '钱四']);
    expect(value(await app.castPresenceView()).records.map((r) => [r.entityId, r.chapterId, r.kind, r.note])).toEqual([[lin.id, chapter.id, 'exit', '远走西域']]);
    expect(value(await app.relationsView()).positions).toEqual([{ entityId: lin.id, x: 120, y: 40 }]);
    expect(value(await app.relationSuggestionCount())).toBe(0);
    const report = lastUndo(undone.items)?.report ?? '';
    expect(report).toContain('“林舟”在《第一章 夜叩》的退场');
    expect(report).toContain('“林舟”在关系图上的位置');
    expect(report).toContain('待确认的关系变化“林舟与钱四：旧识”（待确认的关系变化不重建');
  });

  it('只改节奏目标的章节计划也记为改动，撤销时改回（审查后的修正 2026-10-29）', async () => {
    const { deps, app } = await setup();
    value(await app.updateWorkInfo({ outline: '林舟深夜当玉，掌柜起疑。' }));
    const chapter = value(await app.createChapter('第一章 夜叩')).chapters[0]!;
    const rhythm = { type: 'confrontation', dialogue: 'high', ending: 'dialogue' } as const;
    value(await app.savePlan(chapter.id, { goal: '当玉', castIds: [], beats: ['叩门'], foreshadowPlant: [], foreshadowPayoff: [], treatment: '', targetWords: 3000, rhythm }));
    // 助手按大纲重新生成计划：草稿与现有计划只差节奏目标。
    step(deps, { message: '要重新生成计划，请确认。', actions: [{ tool: 'plan_chapters', count: 1, wordsPerChapter: null }], done: false });
    value(await app.sendToAssistant('重新生成计划'));
    deps.llmResponses.push(
      reply(JSON.stringify({ chapters: [{ title: '第一章 夜叩', goal: '当玉', cast: [], beats: ['叩门'], plant: [], payoff: [], treatment: '', targetWords: 3000, rhythm: { type: 'transition', dialogue: 'low', ending: 'quiet' } }], foreshadows: [] })),
    );
    step(deps, { message: '生成了。', actions: [], done: true });
    value(await app.resolveAssistantPending(true));
    const planOf = async () => value(await app.planningView()).chapters.find((c) => c.chapter.id === chapter.id)?.plan;
    expect((await planOf())?.rhythm).toEqual({ type: 'transition', dialogue: 'low', ending: 'quiet' });
    const undone = value(await app.undoAssistantTurn());
    expect(lastUndo(undone.items)?.report).toContain('改动的《第一章 夜叩》的章节计划');
    expect((await planOf())?.rhythm).toEqual(rhythm);
  });

  it('助手改过之后又被作者改过的不动，在说明里写明；锁定的设定不改回', async () => {
    const { deps, app } = await setup();
    const lin = value(await app.createEntity('character', '林舟')).created;
    value(await app.createEntity('character', '钱四'));
    step(deps, {
      message: '',
      actions: [
        { tool: 'update_entity', entity: '林舟', name: null, description: '捕快', aliases: null },
        { tool: 'update_entity', entity: '钱四', name: null, description: '掌柜', aliases: null },
        { tool: 'create_entity', kind: 'character', name: '沈砚', description: null, aliases: null },
      ],
      done: true,
    });
    value(await app.sendToAssistant('补上人物说明'));
    const now = value(await app.listEntities());
    value(await app.updateEntity(now.find((e) => e.name === '林舟')!, { description: '作者改过的说明' }));
    value(await app.setEntityLocked(now.find((e) => e.name === '钱四')!, true));

    const undone = value(await app.undoAssistantTurn());
    const report = lastUndo(undone.items)?.report ?? '';
    expect(report).toContain('已撤销：新建的设定“沈砚”');
    expect(report).toContain('改动的设定“林舟”（之后又改过，没有动它）');
    expect(report).toContain('改动的设定“钱四”（是锁定设定');
    expect(value(await app.listEntities()).map((e) => [e.name, e.description])).toEqual([
      ['林舟', '作者改过的说明'],
      ['钱四', '掌柜'],
    ]);
    expect(lin.id).toBe(value(await app.listEntities()).find((e) => e.name === '林舟')?.id);
  });

  it('作者说“撤销”时助手用 undo_last_turn 撤销上一轮；再说一次撤销更早的一轮；写手写的章回退到写入之前', async () => {
    const { deps, app } = await setup();
    const chapter = value(await app.createChapter('第一章 夜叩')).chapters[0]!;
    const opened = value(await app.openChapter(chapter.id));
    value(await app.saveChapter(chapter.id, opened.saved, [{ id: 'p0', text: '门在他身后合上了。', source: 'handwritten' }], { splits: [], merges: [] }));
    step(deps, { message: '', actions: [{ tool: 'save_chapter_plan', chapter: '第一章 夜叩', goal: '林舟当玉', beats: ['叩门', '压价'], cast: null, targetWords: 3000 }], done: true });
    value(await app.sendToAssistant('给第一章做个计划'));

    step(deps, { message: '让写手写。', actions: [{ tool: 'write_chapter', chapter: '第一章 夜叩' }], done: true });
    deps.llmResponses.push(reply('林舟又叩响了门。'), reply('钱四压低了价。'), reply(JSON.stringify({ summary: '林舟叩门当玉。', cast: [], foreshadows: [], openThreads: [] })));
    value(await app.sendToAssistant('写第一章'));
    expect(value(await app.openChapter(chapter.id)).saved).toHaveLength(3);

    // 要撤销的那一轮里有写手写的章：和直接回退写手写入一样，先请作者确认。
    step(deps, { message: '', actions: [{ tool: 'undo_last_turn' }], done: false });
    const asked = value(await app.sendToAssistant('撤销刚才的'));
    expect(asked.pending).toBe(true);
    expect(asked.items.at(-1)).toMatchObject({ role: 'pending', summary: expect.stringContaining('《第一章 夜叩》') });
    expect(value(await app.openChapter(chapter.id)).saved).toHaveLength(3);
    step(deps, { message: '撤销了写手写的第一章。', actions: [], done: true });
    const first = value(await app.resolveAssistantPending(true));
    expect(lastResults(first.items)?.results[0]).toMatchObject({ tool: 'undo_last_turn', ok: true, detail: expect.stringContaining('写手写入的《第一章 夜叩》') });
    expect(value(await app.openChapter(chapter.id)).saved.map((p) => p.text)).toEqual(['门在他身后合上了。']);
    expect(value(await app.planningView()).chapters[0]?.plan).toMatchObject({ status: 'todo', goal: '林舟当玉' });
    // 助手自己的撤销只在动作结果里告诉模型一次。
    expect(body(deps, deps.llmRequests.length - 1).match(/写手写入的《第一章 夜叩》/g)).toHaveLength(1);

    step(deps, { message: '', actions: [{ tool: 'undo_last_turn' }], done: false });
    step(deps, { message: '计划也撤了。', actions: [], done: true });
    const second = value(await app.sendToAssistant('计划也不要了'));
    expect(lastResults(second.items)?.results[0]).toMatchObject({ ok: true, detail: expect.stringContaining('新建的《第一章 夜叩》的章节计划') });
    expect(value(await app.planningView()).chapters[0]?.plan).toBeNull();

    step(deps, { message: '', actions: [{ tool: 'undo_last_turn' }], done: false });
    step(deps, { message: '没有可以撤销的了。', actions: [], done: true });
    const third = value(await app.sendToAssistant('再撤销'));
    expect(lastResults(third.items)?.results[0]).toMatchObject({ ok: false, detail: expect.stringContaining('没有可以撤销的改动') });
  });

  it('写手写的章、写手修订的段落之后又被作者改过（或有未保存的修改）时，撤销不动它们', async () => {
    const { deps, app } = await setup();
    const chapter = value(await app.createChapter('第一章 夜叩')).chapters[0]!;
    step(deps, { message: '', actions: [{ tool: 'save_chapter_plan', chapter: '第一章 夜叩', goal: '林舟当玉', beats: ['叩门', '压价'], cast: null, targetWords: 3000 }], done: true });
    value(await app.sendToAssistant('给第一章做个计划'));
    step(deps, { message: '让写手写。', actions: [{ tool: 'write_chapter', chapter: '第一章 夜叩' }], done: true });
    deps.llmResponses.push(reply('林舟又叩响了门。'), reply('钱四压低了价。'), reply(JSON.stringify({ summary: '林舟叩门当玉。', cast: [], foreshadows: [], openThreads: [] })));
    value(await app.sendToAssistant('写第一章'));
    const written = value(await app.openChapter(chapter.id)).saved;
    value(await app.saveChapter(chapter.id, written, written.map((p, i) => ({ id: p.id, text: i === 0 ? '林舟又一次叩响了门。' : p.text, source: 'handwritten' })), { splits: [], merges: [] }));

    expect(await app.undoAssistantTurn()).toMatchObject({ ok: false, error: { code: 'settings', detail: expect.stringContaining('之后又改过') } });
    expect(value(await app.openChapter(chapter.id)).saved.map((p) => p.text)).toEqual(['林舟又一次叩响了门。', '钱四压低了价。']);
    expect(value(await app.planningView()).chapters[0]?.plan?.status).toBe('written');

  });

  it('写手写的章有未保存的修改时，撤销不动它（回退会丢掉草稿）', async () => {
    const { deps, app } = await setup();
    const chapter = value(await app.createChapter('第一章 夜叩')).chapters[0]!;
    value(await app.savePlan(chapter.id, { goal: '林舟当玉', castIds: [], beats: ['叩门', '压价'], foreshadowPlant: [], foreshadowPayoff: [], treatment: '', targetWords: 3000 }));
    step(deps, { message: '让写手写。', actions: [{ tool: 'write_chapter', chapter: '第一章 夜叩' }], done: true });
    deps.llmResponses.push(reply('林舟又叩响了门。'), reply('钱四压低了价。'), reply(JSON.stringify({ summary: '林舟叩门当玉。', cast: [], foreshadows: [], openThreads: [] })));
    value(await app.sendToAssistant('写第一章'));
    const draft = JSON.stringify({ version: 1, chapterId: chapter.id, writtenAt: '2026-10-19T00:00:00.000Z', paragraphs: [{ id: 'x', text: '还没保存的一段。', source: 'handwritten' }] });
    value(await deps.drafts.write(value(await app.reloadWork()).entry.path, chapter.id, draft));
    expect(value(await app.undoAssistantTurn()).items.at(-1)).toMatchObject({ role: 'undo', ok: false, report: expect.stringContaining('未保存的修改') });
    expect(value(await app.openChapter(chapter.id)).saved).toHaveLength(2);
  });
});
