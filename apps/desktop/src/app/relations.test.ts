import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { fsDeps, type TestDeps } from '../testing/fs-deps';
import { FULL_VIEW, fitView, GRAPH_SIZE, layoutGraph, relationsAt, zoomView } from './relations';
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
  const lin = value(await app.createEntity('character', '林舟')).created;
  const qian = value(await app.createEntity('character', '钱四')).created;
  const shop = value(await app.createEntity('organization', '聚宝当铺')).created;
  value(await app.createEntity('location', '渡口'));
  return { app, lin, qian, shop };
}

const fields = (fromId: string, toId: string, label: string) => ({
  fromId,
  toId,
  category: 'enemy' as const,
  label,
  mutual: false,
  description: '',
  secret: false,
  validFromChapterId: null,
  validToChapterId: null,
});

describe('人物关系的用例（B73）', () => {
  it('关系页列出人物与组织（地点等只在有关系时列出）；新建、修改、删除；拖定与取消位置、重新排布', async () => {
    const { app, lin, qian, shop } = await setup();
    let view = value(await app.relationsView());
    expect(view.members.map((m) => m.name)).toEqual(['林舟', '钱四', '聚宝当铺']);

    value(await app.addRelationship(fields(qian.id, lin.id, '债主')));
    view = value(await app.addRelationship({ ...fields(qian.id, shop.id, '掌柜'), category: 'affiliation' }));
    const debt = view.relationships[0]!;
    view = value(await app.updateRelationship(debt, { ...debt, label: '旧债主', secret: true }));
    expect(view.relationships.map((r) => [r.label, r.secret])).toEqual([
      ['旧债主', true],
      ['掌柜', false],
    ]);
    expect(await app.updateRelationship(debt, debt)).toMatchObject({ ok: false, error: { code: 'repo', error: { code: 'conflict' } } });

    value(await app.setRelationPosition(lin.id, { x: 100, y: 200 }));
    view = value(await app.setRelationPosition(qian.id, { x: 300, y: 200 }));
    expect(view.positions).toHaveLength(2);
    view = value(await app.setRelationPosition(lin.id, null));
    expect(view.positions.map((p) => p.entityId)).toEqual([qian.id]);
    view = value(await app.resetRelationLayout());
    expect(view.positions).toEqual([]);

    view = value(await app.deleteRelationship(view.relationships[1]!));
    expect(view.relationships.map((r) => r.label)).toEqual(['旧债主']);
    // 删除人物：他的关系一并删除。
    value(await app.deleteEntity(lin));
    expect(value(await app.relationsView()).relationships).toEqual([]);
  });

  it('按章节查看：只列这一章时成立的关系', async () => {
    const { app, lin, qian } = await setup();
    const chapters = value(await app.createChapter('第一章')).chapters;
    const c2 = value(await app.createChapter('第二章', chapters[0]!.id)).chapters[1]!;
    const view = value(await app.addRelationship({ ...fields(qian.id, lin.id, '盟友'), validToChapterId: chapters[0]!.id }));
    const next = value(await app.addRelationship({ ...fields(qian.id, lin.id, '仇人'), validFromChapterId: c2.id }));
    const order = [chapters[0]!.id, c2.id];
    expect(relationsAt(view.relationships, order, null).map((r) => r.label)).toEqual(['盟友']);
    expect(relationsAt(next.relationships, order, 0).map((r) => r.label)).toEqual(['盟友']);
    expect(relationsAt(next.relationships, order, 1).map((r) => r.label)).toEqual(['仇人']);
    expect(relationsAt(next.relationships, order, null).map((r) => r.label)).toEqual(['盟友', '仇人']);
  });
});

describe('关系图的布局', () => {
  const ids = ['a', 'b', 'c', 'd', 'lonely'];
  const edges = [
    ['a', 'b'],
    ['b', 'c'],
    ['c', 'a'],
    ['c', 'd'],
  ] as const;

  it('同样的输入得到同样的位置；都在画布之内，彼此不重叠；没有关系的人物排在底部', () => {
    const first = layoutGraph(ids, edges, new Map());
    expect(layoutGraph(ids, edges, new Map())).toEqual(first);
    for (const p of first.values()) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(GRAPH_SIZE.width);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(GRAPH_SIZE.height);
    }
    const linked = ['a', 'b', 'c', 'd'].map((id) => first.get(id)!);
    for (const [i, p] of linked.entries()) for (const q of linked.slice(i + 1)) expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeGreaterThan(80);
    const lonely = first.get('lonely')!;
    expect(lonely.y).toBeGreaterThan(Math.max(...linked.map((p) => p.y)));
  });

  it('拖定的人物留在原处；有关系的人物离得比没有关系的近', () => {
    const placed = layoutGraph(ids, edges, new Map([['a', { x: 120, y: 90 }]]));
    expect(placed.get('a')).toEqual({ x: 120, y: 90 });
    const far = layoutGraph(['a', 'b', 'c'], [['a', 'b']], new Map([['c', { x: 900, y: 100 }]]));
    const d = (x: string, y: string) => Math.hypot(far.get(x)!.x - far.get(y)!.x, far.get(x)!.y - far.get(y)!.y);
    expect(d('a', 'b')).toBeLessThan(d('a', 'c'));
    expect(layoutGraph([], [], new Map()).size).toBe(0);
    expect(layoutGraph(['x'], [], new Map()).get('x')).toBeDefined();
  });
});

describe('关系图的缩放', () => {
  it('以一点为中心缩放时那一点不动；最多放大到 4 倍、缩小到 2 倍大的范围；长宽比不变', () => {
    const at = { x: 300, y: 200 };
    const zoomed = zoomView(FULL_VIEW, 0.5, at);
    expect(zoomed.w).toBe(GRAPH_SIZE.width / 2);
    expect(zoomed.h / zoomed.w).toBeCloseTo(GRAPH_SIZE.height / GRAPH_SIZE.width);
    // at 在视图里的相对位置不变。
    expect((at.x - zoomed.x) / zoomed.w).toBeCloseTo(at.x / FULL_VIEW.w);
    expect((at.y - zoomed.y) / zoomed.h).toBeCloseTo(at.y / FULL_VIEW.h);
    let v = FULL_VIEW;
    for (let i = 0; i < 20; i++) v = zoomView(v, 0.5, at);
    expect(v.w).toBe(GRAPH_SIZE.width / 4);
    for (let i = 0; i < 20; i++) v = zoomView(v, 2, at);
    expect(v.w).toBe(GRAPH_SIZE.width * 2);
  });

  it('适应全图：刚好装下这些点并留出边距，长宽比不变；没有点时看全图', () => {
    const fitted = fitView([
      { x: 100, y: 100 },
      { x: 400, y: 180 },
    ]);
    expect(fitted.h / fitted.w).toBeCloseTo(GRAPH_SIZE.height / GRAPH_SIZE.width);
    for (const p of [
      { x: 100, y: 100 },
      { x: 400, y: 180 },
    ]) {
      expect(p.x).toBeGreaterThan(fitted.x);
      expect(p.x).toBeLessThan(fitted.x + fitted.w);
      expect(p.y).toBeGreaterThan(fitted.y);
      expect(p.y).toBeLessThan(fitted.y + fitted.h);
    }
    expect(fitted.w).toBeLessThan(GRAPH_SIZE.width);
    expect(fitView([])).toEqual(FULL_VIEW);
    // 只有一个人物时不放大到看不清周围：最多 4 倍。
    expect(fitView([{ x: 500, y: 300 }]).w).toBe(GRAPH_SIZE.width / 4);
  });
});
