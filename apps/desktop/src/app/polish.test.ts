import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { fsDeps, type TestDeps } from '../testing/fs-deps';
import { addTestedModel, reply } from '../testing/models';
import { groupParagraphs, parsePolished, sameSubstance } from './polish';
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

/** 八段叙述：“生铁”出现九次（本章的高频词），没有对白。 */
const CONTEXTS = ['撞在石上', '贴着皮肉', '发出闷响', '冷得刺骨', '压在胸口', '横在面前', '落在泥里', '磕在门上', '沉在水底'];
const PLACES = ['河沿', '城墙根', '后巷', '石桥', '渡口', '牌坊下', '庙前', '米行门口', '柳树底下'];
const texts = CONTEXTS.map(
  (x, i) =>
    `第${i + 1}下，生铁${x}。林舟没有说话，把那截铁收回袖中，雨还在下。他沿着${PLACES[i] ?? ''}走了很久，两旁的铺面都上了板，只有一盏灯还亮着，灯下坐着个打盹的老头，脚边一只黄狗抬头看他一眼又趴下去，远处传来更鼓的声音，数到第三下时他停住脚步，把袖子里的东西又按了按，才继续往前走，鞋底踩碎了路面结着的一层薄冰。风从巷口灌进来，吹得他脖子后面发凉，他把衣领拢了拢，想起白天当铺里那张算盘脸，又想起袖子里这截铁的分量，天快亮时雨小了些。`,
);

async function setup() {
  const deps = fsDeps();
  all.push(deps);
  const app = createAppService(deps);
  value(await app.loadLibrary());
  value(await app.createWork('当铺夜谈'));
  const c1 = value(await app.createChapter('第一章 夜叩')).chapters[0]!;
  const content = value(await app.openChapter(c1.id));
  value(await app.saveChapter(c1.id, content.saved, texts.map((text, i) => ({ id: `p${i}`, text, source: 'ai_generated' as const })), { splits: [], merges: [] }));
  const lin = value(await app.createEntity('character', '林舟')).created;
  value(await app.savePlan(c1.id, { goal: '林舟当玉', castIds: [lin.id], beats: ['叩门'], foreshadowPlant: [], foreshadowPayoff: [], treatment: '', targetWords: 500, rhythm: { type: 'confrontation', dialogue: 'high', ending: 'dialogue' } }));
  await addTestedModel(app, deps);
  deps.llmRequests.length = 0;
  return { deps, app, c1: c1.id };
}

const paragraphs = async (app: AppService, chapterId: string) => value(await app.openChapter(chapterId)).saved.map((p) => p.text);
const bodyText = (deps: TestDeps, index: number) => JSON.stringify(deps.llmRequests[index]?.body ?? {});

describe('第二遍去 AI 味的修订（B87）：纯函数', () => {
  it('按字数分组，一段不拆；标签对回段落，缺了、多了、乱了都不要', () => {
    const items = [{ text: '一'.repeat(900) }, { text: '二'.repeat(900) }, { text: '三'.repeat(100) }];
    expect(groupParagraphs(items, 1000).map((g) => g.length)).toEqual([1, 2]);
    expect(groupParagraphs([], 1000)).toEqual([]);
    expect(parsePolished('[P1] 第一段。\n[P2] 第二段，\n还有一行。', 2)).toEqual(['第一段。', '第二段，还有一行。']);
    expect(parsePolished('[P1] 第一段。', 2)).toBeNull();
    expect(parsePolished('[P2] 第二段。\n[P1] 第一段。', 2)).toBeNull();
    expect(parsePolished('说明：[P1] 第一段。', 1)).toBeNull();
    expect(parsePolished('[P1] 第一段。\n[P2]  ', 2)).toBeNull();
  });

  it('实质没变：设定名、数字与对白的条数都相同', () => {
    const names = ['林舟', '钱四'];
    expect(sameSubstance('林舟递过玉，钱四压到三十两。', '林舟把玉推过去，钱四只肯出三十两。', names)).toBe(true);
    expect(sameSubstance('林舟递过玉。', '钱四递过玉。', names)).toBe(false);
    expect(sameSubstance('钱四压到三十两。', '钱四压到二十两。', names)).toBe(false);
    expect(sameSubstance('他说：“不卖。”', '他摇头。', names)).toBe(false);
  });
});

describe('第二遍去 AI 味的修订（B87）：用例', () => {
  it('按程序统计的反馈修订：请求带统计、润色技能与带标签的段落；写回改过的段，写入前存快照；设定名变了的段不写入', async () => {
    const { deps, app, c1 } = await setup();
    // 九段分两组（约 1,500 字一组）；第一组每段都改，第二组的第一段把林舟改成钱四（不写入）、其余原样。
    const groups = groupParagraphs(texts.map((text) => ({ text })));
    expect(groups).toHaveLength(2);
    const [g1, g2] = groups as [{ text: string }[], { text: string }[]];
    deps.llmResponses.push(
      reply(g1.map((p, i) => `[P${i + 1}] ${p.text.replace('生铁', '那截铁').replace('林舟没有说话', '林舟抿着嘴')}`).join('\n')),
      reply(g2.map((p, i) => `[P${i + 1}] ${i === 0 ? p.text.replace('林舟', '钱四') : p.text}`).join('\n')),
    );
    const before = await paragraphs(app, c1);
    const outcome = value(await app.polishChapter(c1));
    expect(outcome.status).toBe('polished');
    expect(outcome.feedback).toContain('“生铁”在本章出现 9 次');
    expect(outcome.feedback.some((f) => f.startsWith('本章对话只占'))).toBe(true);
    expect(outcome.groups).toBe(2);
    expect(outcome.changed).toBe(g1.length);
    expect(outcome.skipped).toEqual(['第 2 组第 1 段：设定名、数字或对白的条数变了，没有写入']);
    const body = bodyText(deps, 0);
    expect(body).toContain('这一章的统计：');
    expect(body).toContain('“生铁”在本章出现 9 次');
    expect(body).toContain('【润色与去 AI 味】');
    expect(body).not.toContain('【写作基本功】');
    expect(body).toContain('[P1] 第1下，生铁撞在石上。');
    const after = await paragraphs(app, c1);
    expect(after.slice(0, g1.length).every((t) => t.includes('那截铁') && !t.includes('生铁'))).toBe(true);
    expect(after.slice(g1.length)).toEqual(before.slice(g1.length));
    expect(value(await app.listSnapshots(c1)).map((s) => s.reason)).toEqual(['writer']);
    expect(value(await app.openChapter(c1)).saved[0]?.source).toBe('ai_generated');
  });

  it('没有统计出毛病时不调用模型；输出的标签对不上时整组不写入', async () => {
    const { deps, app, c1 } = await setup();
    const clean = value(await app.createChapter('第二章 夜雨', c1)).chapters[1]!;
    const content = value(await app.openChapter(clean.id));
    value(await app.saveChapter(clean.id, content.saved, [{ id: 'q0', text: '雨停了。“走吧。”她说。', source: 'ai_generated' }], { splits: [], merges: [] }));
    expect(value(await app.polishChapter(clean.id))).toMatchObject({ status: 'polished', groups: 0, changed: 0, feedback: [] });
    expect(deps.llmRequests).toHaveLength(0);

    deps.llmResponses.push(reply('[P1] 只有一段。'), reply('[P1] 只有一段。'));
    const outcome = value(await app.polishChapter(c1));
    expect(outcome.changed).toBe(0);
    expect(outcome.groups).toBe(2);
    expect(outcome.skipped).toHaveLength(2);
    expect(outcome.skipped[0]).toBe('第 1 组：模型输出的段落数或标签对不上');
    expect(value(await app.listSnapshots(c1))).toEqual([]);
  });

  it('预计用量按字数估调用数', async () => {
    const { app, c1 } = await setup();
    const quote = value(await app.quotePolish([c1]));
    // 约 1,700 字分两组。
    expect(quote).toMatchObject({ chapters: 1, calls: 2 });
    expect(quote.inputTokens).toBeGreaterThan(0);
    expect(quote.outputTokens).toBeGreaterThan(0);
  });
});
