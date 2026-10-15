import { rmSync } from 'node:fs';
import { openaiChunks } from '@fudiao/llm/testing';
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

const beats = ['叩门', '压价', '起疑', '离开'];

/** 两章：第一章已有作者写的正文与梗概；第二章有计划（四个情节点、三千字，分两段）。 */
async function setup() {
  const deps = fsDeps();
  all.push(deps);
  const app = createAppService(deps);
  value(await app.loadLibrary());
  value(await app.createWork('当铺夜谈'));
  const c1 = value(await app.createChapter('第一章 夜叩')).chapters[0]!;
  const work = value(await app.createChapter('第二章 夜雨', c1.id));
  const c2 = work.chapters[1]!;
  value(await app.updateChapterNotes(work.chapters[0]!, { summary: '林舟深夜当玉，被掌柜压价。', notes: '' }));
  const first = value(await app.openChapter(c1.id));
  value(await app.saveChapter(c1.id, first.saved, [{ id: 'p0', text: '门在他身后合上了。', source: 'handwritten' }], { splits: [], merges: [] }));
  const lin = value(await app.createEntity('character', '林舟')).created;
  value(await app.updateEntity(lin, { description: '落魄书生，好面子' }));
  const jade = value(await app.addForeshadow({ title: '玉佩的来历', content: '掌柜多看了玉佩一眼', reveal: '玉佩是林舟父亲的遗物', plantChapterId: c2.id, plantAnchor: null, payoffChapterId: null, payoffAnchor: null, status: 'planned' })).foreshadows[0]!;
  value(await app.savePlan(c2.id, { goal: '林舟再访当铺', castIds: [lin.id], beats, foreshadowPlant: [jade.id], foreshadowPayoff: [], treatment: '对峙展开', targetWords: 3000 }));
  await addTestedModel(app, deps);
  deps.llmRequests.length = 0;
  return { deps, app, c1: c1.id, c2: c2.id };
}

const texts = async (app: AppService, chapterId: string) => value(await app.openChapter(chapterId)).saved.map((p) => p.text);
const bodyText = (deps: TestDeps, index: number) => JSON.stringify(deps.llmRequests[index]?.body ?? {});

describe('写手成章', () => {
  it('按情节点分两段写入章末，段落记为 AI 生成；写入前有快照；写完后计划为已写', async () => {
    const { deps, app, c2 } = await setup();
    deps.llmResponses.push(reply('林舟又叩响了门。\n\n钱四压低了价。'), reply('钱四的目光停在玉上。\n林舟转身走进雨里。'));
    const seen: number[] = [];
    const outcome = value(await app.writeChapter(c2, { onSegment: (done) => seen.push(done) }));
    expect(outcome).toMatchObject({ status: 'written', segmentsDone: 2, segmentsTotal: 2, plan: { status: 'written' } });
    expect(seen).toEqual([1, 2]);
    const saved = value(await app.openChapter(c2)).saved;
    expect(saved.map((p) => [p.text, p.source])).toEqual([
      ['林舟又叩响了门。', 'ai_generated'],
      ['钱四压低了价。', 'ai_generated'],
      ['钱四的目光停在玉上。', 'ai_generated'],
      ['林舟转身走进雨里。', 'ai_generated'],
    ]);
    expect(value(await app.listSnapshots(c2)).map((s) => s.reason)).toEqual(['writer']);
    expect(deps.llmRequests).toHaveLength(2);
  });

  it('写手只带写章节的技能（B75）：雪花写作法不带；两个阶段都选的自定义技能带上，只用于规划的不带', async () => {
    const { deps, app, c2 } = await setup();
    value(await app.addCustomSkill('作者偏好', '- 不要三角恋', '规划与写每一章时都遵守', 'prefs', ['planning', 'writing']));
    value(await app.addCustomSkill('三幕', '按三幕安排章节。', '规划时使用', 'three-acts', ['planning']));
    deps.llmResponses.push(reply('林舟又叩响了门。'), reply('他没回头。'));
    value(await app.writeChapter(c2));
    const body = bodyText(deps, 0);
    expect(body).toContain('【章末钩子】');
    expect(body).toContain('【不用副词】');
    expect(body).toContain('【作者偏好】');
    expect(body).not.toContain('雪花写作法');
    expect(body).not.toContain('【三幕】');
  });

  it('同一章同时只有一个写手：写作期间再写或回退这一章都被拒绝，停下以后可以接着写', async () => {
    const { deps, app, c2 } = await setup();
    const abort = new AbortController();
    deps.llmResponses.push({ chunks: openaiChunks('m', { text: ['林舟'], end: 'stop' }, { stopAfterText: true }), hang: true });
    const first = app.writeChapter(c2, { signal: abort.signal });
    while (deps.llmRequests.length === 0) await new Promise((r) => setTimeout(r, 5));
    expect(await app.writeChapter(c2)).toMatchObject({ ok: false, error: { code: 'settings', detail: expect.stringContaining('写手正在写这一章') } });
    expect(await app.rollbackWriter(c2)).toMatchObject({ ok: false, error: { code: 'settings', detail: expect.stringContaining('写手正在写这一章') } });
    expect(app.writingChapters()).toEqual([c2]);
    abort.abort();
    expect(value(await first).status).toBe('cancelled');
    expect(app.writingChapters()).toEqual([]);
    deps.llmResponses.push(reply('林舟又叩响了门。'), reply('他没回头。'));
    expect(value(await app.writeChapter(c2)).status).toBe('written');
  });

  it('写入正文前规范标点（B74）：半角标点、直引号与省略号换成中文的写法', async () => {
    const { deps, app, c2 } = await setup();
    deps.llmResponses.push(reply('林舟推开门,看见掌柜...\n\n掌柜说:"这玉不对."'), reply('他没回头.'));
    value(await app.writeChapter(c2));
    expect(await texts(app, c2)).toEqual(['林舟推开门，看见掌柜……', '掌柜说：“这玉不对。”', '他没回头。']);
  });

  it('请求中带上本章成立、至少一端出场的人物关系（B73）；隐秘的关系要求只暗示', async () => {
    const { deps, app, c1, c2 } = await setup();
    const lin = value(await app.listEntities()).find((e) => e.name === '林舟')!;
    const qian = value(await app.createEntity('character', '钱四')).created;
    const qing = value(await app.createEntity('character', '阿青')).created;
    const ghost = value(await app.createEntity('character', '无关的人')).created;
    const rel = (fromId: string, toId: string, label: string, extra: Partial<{ secret: boolean; validFromChapterId: string; validToChapterId: string }> = {}) =>
      app.addRelationship({ fromId, toId, category: 'enemy', label, mutual: false, description: '', secret: false, validFromChapterId: null, validToChapterId: null, ...extra });
    value(await rel(qian.id, lin.id, '债主'));
    value(await rel(qing.id, lin.id, '亲妹妹', { secret: true }));
    value(await rel(qian.id, lin.id, '岳父', { validToChapterId: c1 }));
    value(await rel(qian.id, ghost.id, '东家'));
    deps.llmResponses.push(reply('林舟又叩响了门。'), reply('钱四压低了价。'));
    value(await app.writeChapter(c2));
    const body = bodyText(deps, 0);
    expect(body).toContain('钱四是林舟的债主');
    expect(body).toContain('阿青是林舟的亲妹妹〔隐秘〕');
    expect(body).toContain('标为“隐秘”的人物关系读者还不知道');
    // 第一章结束就不成立的关系、两端都不出场的关系不带。
    expect(body).not.toContain('岳父');
    expect(body).not.toContain('东家');
  });

  it('请求中带上作品材料：技能、规避词、人物设定、前文梗概、上一章结尾、要埋的伏笔与不得说破的内容；第二段带上已写的结尾与情节点的进度', async () => {
    const { deps, app, c2 } = await setup();
    deps.llmResponses.push(reply('林舟又叩响了门。'), reply('林舟转身走进雨里。'));
    value(await app.writeChapter(c2));
    const first = bodyText(deps, 0);
    for (const part of ['【伏笔埋设与回收】', '不要使用这些说法', '林舟：落魄书生，好面子', '第一章 夜叩：林舟深夜当玉，被掌柜压价。', '门在他身后合上了。', '玉佩的来历：掌柜多看了玉佩一眼', '玉佩是林舟父亲的遗物', '（这次写）叩门', '（以后写）起疑', '这不是本章的结尾']) {
      expect(first).toContain(part);
    }
    const second = bodyText(deps, 1);
    for (const part of ['（已写）压价', '（这次写）离开', '本章已经写到这里：', '林舟又叩响了门。', '这是本章的最后一段']) {
      expect(second).toContain(part);
    }
  });

  it('只带适用于本章的事实：后面章节才成立的、本章之前已不再成立的事实不给写手', async () => {
    const { deps, app, c1, c2 } = await setup();
    const c3 = value(await app.createChapter('第三章 天明', c2)).chapters.find((c) => c.title === '第三章 天明')!.id;
    const lin = value(await app.listEntities()).find((e) => e.name === '林舟')!;
    const fact = (content: string, from: string | null, to: string | null) => ({
      kind: 'world' as const,
      holderId: null,
      subjectIds: [lin.id],
      content,
      modality: null,
      confidence: null,
      validFromChapterId: from,
      validToChapterId: to,
      validFrom: null,
      validTo: null,
      basis: [],
    });
    value(await app.createFact(fact('林舟欠着房租', c1, null), 'confirmed'));
    value(await app.createFact(fact('林舟中了举', c3, null), 'confirmed'));
    value(await app.createFact(fact('林舟还住在破庙', null, c1), 'confirmed'));
    deps.llmResponses.push(reply('一。'), reply('二。'));
    value(await app.writeChapter(c2));
    const request = bodyText(deps, 0);
    expect(request).toContain('林舟欠着房租');
    expect(request).not.toContain('林舟中了举');
    expect(request).not.toContain('林舟还住在破庙');
  });

  it('本章在某一卷里时，请求带上卷名与本卷梗概（B68）', async () => {
    const { deps, app, c2 } = await setup();
    const created = value(await app.createVolume('第一卷 夜雨'));
    const volume = value(await app.updateVolume(created.volumes[0]!, { title: '第一卷 夜雨', summary: '林舟两访当铺' })).volumes[0]!;
    const chapter = value(await app.reloadWork()).chapters.find((c) => c.id === c2)!;
    value(await app.moveChapter(chapter, { volumeId: volume.id, after: null }));
    deps.llmResponses.push(reply('一。'), reply('二。'));
    value(await app.writeChapter(c2));
    expect(bodyText(deps, 0)).toContain('本卷：第一卷 夜雨');
    expect(bodyText(deps, 0)).toContain('本卷梗概：林舟两访当铺');
  });

  it('没有计划、已经写过或有未保存的修改时不写，并说明原因', async () => {
    const { deps, app, c1, c2 } = await setup();
    expect(await app.writeChapter(c1)).toMatchObject({ ok: false, error: { code: 'settings', detail: expect.stringContaining('还没有章节计划') } });
    value(await deps.drafts.write(value(await app.reloadWork()).entry.path, c2, '{"paragraphs":[]}'));
    expect(await app.writeChapter(c2)).toMatchObject({ ok: false, error: { code: 'settings', detail: expect.stringContaining('未保存的修改') } });
    value(await deps.drafts.remove(value(await app.reloadWork()).entry.path, c2));
    deps.llmResponses.push(reply('一。'), reply('二。'));
    value(await app.writeChapter(c2));
    expect(await app.writeChapter(c2)).toMatchObject({ ok: false, error: { code: 'settings', detail: expect.stringContaining('已经写过') } });
    expect(deps.llmRequests).toHaveLength(2);
  });

  it('中途调用失败：已写入的段保留，状态为写作中；接着写时只调用没写完的段，不重复写入', async () => {
    const { deps, app, c2 } = await setup();
    deps.llmResponses.push(reply('林舟又叩响了门。'));
    const stopped = value(await app.writeChapter(c2));
    expect(stopped).toMatchObject({ status: 'stopped', segmentsDone: 1, segmentsTotal: 2, plan: { status: 'writing' } });
    expect(stopped.reason).not.toBeNull();
    expect(await texts(app, c2)).toEqual(['林舟又叩响了门。']);

    const requestsBefore = deps.llmRequests.length;
    deps.llmResponses.push(reply('林舟转身走进雨里。'));
    const resumed = value(await app.writeChapter(c2));
    expect(resumed).toMatchObject({ status: 'written', segmentsDone: 2 });
    expect(await texts(app, c2)).toEqual(['林舟又叩响了门。', '林舟转身走进雨里。']);
    // 续写只调用了没写完的第二段，没有重写第一段；也只有一个“写手写入”快照。
    expect(deps.llmRequests.length - requestsBefore).toBe(1);
    expect(value(await app.listSnapshots(c2)).filter((s) => s.reason === 'writer')).toHaveLength(1);
  });

  it('作者取消：正在写的段不写入，已写的段保留，可以接着写', async () => {
    const { deps, app, c2 } = await setup();
    deps.llmResponses.push(reply('林舟又叩响了门。'), reply('林舟转身走进雨里。'));
    const abort = new AbortController();
    const cancelled = value(await app.writeChapter(c2, { signal: abort.signal, onSegment: () => abort.abort() }));
    expect(cancelled).toMatchObject({ status: 'cancelled', segmentsDone: 1 });
    expect(await texts(app, c2)).toEqual(['林舟又叩响了门。']);
    expect(value(await app.writeChapter(c2))).toMatchObject({ status: 'written' });
    expect(await texts(app, c2)).toEqual(['林舟又叩响了门。', '林舟转身走进雨里。']);
  });

  it('回退到写手写入前：正文回到写入前，现稿另存快照，计划回到待写，可以重写', async () => {
    const { deps, app, c2 } = await setup();
    const before = value(await app.openChapter(c2));
    value(await app.saveChapter(c2, before.saved, [{ id: 'a0', text: '作者写的开头。', source: 'handwritten' }], { splits: [], merges: [] }));
    deps.llmResponses.push(reply('一。'), reply('二。'));
    value(await app.writeChapter(c2));
    expect(await texts(app, c2)).toEqual(['作者写的开头。', '一。', '二。']);

    expect(value(await app.rollbackWriter(c2))).toMatchObject({ status: 'todo', progress: null });
    expect(await texts(app, c2)).toEqual(['作者写的开头。']);
    expect(value(await app.listSnapshots(c2)).map((s) => s.reason).sort()).toEqual(['before_restore', 'writer']);
    expect(await app.rollbackWriter(c2)).toMatchObject({ ok: false, error: { code: 'settings' } });

    deps.llmResponses.push(reply('重写一。'), reply('重写二。'));
    expect(value(await app.writeChapter(c2))).toMatchObject({ status: 'written' });
    expect(await texts(app, c2)).toEqual(['作者写的开头。', '重写一。', '重写二。']);
  });
});
