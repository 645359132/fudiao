import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { keysBetween } from '@fudiao/shared';
import { planParagraphSave, type CurrentParagraph, type SavedParagraph, type StructuralEdits } from './paragraph-plan';

const NONE: StructuralEdits = { splits: [], merges: [] };

function saved(...texts: string[]): SavedParagraph[] {
  const keys = keysBetween(null, null, texts.length);
  return texts.map((text, i) => ({ id: `p${i}`, orderKey: keys[i] ?? '', text, version: 1, source: 'handwritten' }));
}

const cur = (id: string, text: string): CurrentParagraph => ({ id, text, source: 'handwritten' });

/** 把保存计划应用到内存中的段落表，返回按排序键排列的结果。 */
function apply(before: readonly SavedParagraph[], plan: ReturnType<typeof planParagraphSave>) {
  const rows = new Map(before.map((p) => [p.id, { ...p }]));
  for (const id of plan.deletes.map((d) => d.id)) rows.delete(id);
  for (const u of plan.updates) {
    const row = rows.get(u.id);
    if (!row) throw new Error(`更新了不存在的段落 ${u.id}`);
    if (u.text !== undefined) row.text = u.text;
    if (u.source !== undefined) row.source = u.source;
    if (u.orderKey !== undefined) row.orderKey = u.orderKey;
  }
  for (const i of plan.inserts) rows.set(i.id, { id: i.id, orderKey: i.orderKey, text: i.text, version: 1, source: i.source });
  const list = [...rows.values()].sort((a, b) => (a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : 0));
  return list;
}

describe('段落保存计划', () => {
  it('没有变化时不写任何东西', () => {
    const s = saved('甲', '乙');
    const plan = planParagraphSave(s, [cur('p0', '甲'), cur('p1', '乙')], NONE);
    expect(plan).toEqual({ inserts: [], updates: [], deletes: [], linkCopies: [] });
  });

  it('改文本只更新该段，并带上版本', () => {
    const s = saved('甲', '乙');
    const plan = planParagraphSave(s, [cur('p0', '甲'), cur('p1', '乙改')], NONE);
    expect(plan.updates).toEqual([{ id: 'p1', expectedVersion: 1, text: '乙改' }]);
    expect(plan.inserts).toEqual([]);
  });

  it('在两段之间新增，排序键介于两者之间，原有段落不动', () => {
    const s = saved('甲', '乙');
    const plan = planParagraphSave(s, [cur('p0', '甲'), cur('n1', '新'), cur('p1', '乙')], NONE);
    expect(plan.updates).toEqual([]);
    expect(plan.inserts).toHaveLength(1);
    expect(apply(s, plan).map((p) => p.text)).toEqual(['甲', '新', '乙']);
  });

  it('删除段落带上版本', () => {
    const s = saved('甲', '乙', '丙');
    const plan = planParagraphSave(s, [cur('p0', '甲'), cur('p2', '丙')], NONE);
    expect(plan.deletes).toEqual([{ id: 'p1', expectedVersion: 1 }]);
  });

  it('移动段落：保留最长的有序部分，只改被移动段落的排序键', () => {
    const s = saved('甲', '乙', '丙', '丁');
    const plan = planParagraphSave(s, [cur('p3', '丁'), cur('p0', '甲'), cur('p1', '乙'), cur('p2', '丙')], NONE);
    expect(plan.updates.map((u) => u.id)).toEqual(['p3']);
    expect(plan.updates[0]).not.toHaveProperty('text');
    expect(apply(s, plan).map((p) => p.text)).toEqual(['丁', '甲', '乙', '丙']);
  });

  it('拆分：新段落记录来源段落并复制其事件关联', () => {
    const s = saved('甲乙', '丙');
    const plan = planParagraphSave(s, [cur('p0', '甲'), cur('n1', '乙'), cur('p1', '丙')], { splits: [{ id: 'n1', from: 'p0' }], merges: [] });
    expect(plan.inserts[0]).toMatchObject({ id: 'n1', splitFrom: 'p0' });
    expect(plan.linkCopies).toEqual([{ from: 'p0', to: 'n1' }]);
  });

  it('连续拆分时，事件关联追溯到已保存的段落', () => {
    const s = saved('甲乙丙');
    const plan = planParagraphSave(s, [cur('p0', '甲'), cur('n1', '乙'), cur('n2', '丙')], {
      splits: [
        { id: 'n1', from: 'p0' },
        { id: 'n2', from: 'n1' },
      ],
      merges: [],
    });
    expect(plan.linkCopies).toEqual([
      { from: 'p0', to: 'n1' },
      { from: 'p0', to: 'n2' },
    ]);
    expect(plan.inserts.find((i) => i.id === 'n2')?.splitFrom).toBe('n1');
  });

  it('合并：被合并段落的关联并入保留的段落后再删除', () => {
    const s = saved('甲', '乙', '丙');
    const plan = planParagraphSave(s, [cur('p0', '甲乙'), cur('p2', '丙')], { splits: [], merges: [{ removed: 'p1', into: 'p0' }] });
    expect(plan.linkCopies).toEqual([{ from: 'p1', to: 'p0' }]);
    expect(plan.deletes).toEqual([{ id: 'p1', expectedVersion: 1 }]);
  });

  it('连续合并时追溯到最终保留的段落；撤销后仍存在的段落不算合并', () => {
    const s = saved('甲', '乙', '丙');
    const chained = planParagraphSave(s, [cur('p0', '甲乙丙')], {
      splits: [],
      merges: [
        { removed: 'p2', into: 'p1' },
        { removed: 'p1', into: 'p0' },
      ],
    });
    expect(chained.linkCopies).toEqual([
      { from: 'p1', to: 'p0' },
      { from: 'p2', to: 'p0' },
    ]);
    const undone = planParagraphSave(s, [cur('p0', '甲'), cur('p1', '乙'), cur('p2', '丙')], { splits: [], merges: [{ removed: 'p1', into: 'p0' }] });
    expect(undone.linkCopies).toEqual([]);
  });

  it('来源变化也写入', () => {
    const s = saved('甲');
    const plan = planParagraphSave(s, [{ id: 'p0', text: '甲', source: 'ai_modified' }], NONE);
    expect(plan.updates).toEqual([{ id: 'p0', expectedVersion: 1, source: 'ai_modified' }]);
  });

  it('当前段落标识重复时报错', () => {
    expect(() => planParagraphSave(saved('甲'), [cur('p0', '甲'), cur('p0', '乙')], NONE)).toThrow();
  });

  it('任意编辑后，应用计划得到的段落与编辑器一致；未改动的段落不写入', () => {
    const op = fc.oneof(
      fc.record({ kind: fc.constant('insert' as const), at: fc.nat(), text: fc.string({ maxLength: 4 }) }),
      fc.record({ kind: fc.constant('delete' as const), at: fc.nat() }),
      fc.record({ kind: fc.constant('edit' as const), at: fc.nat(), text: fc.string({ maxLength: 4 }) }),
      fc.record({ kind: fc.constant('move' as const), from: fc.nat(), to: fc.nat() }),
    );
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 12 }), fc.array(op, { maxLength: 15 }), (n, ops) => {
        const before = saved(...Array.from({ length: n }, (_, i) => `段${i}`));
        let doc: CurrentParagraph[] = before.map((p) => cur(p.id, p.text));
        let next = 0;
        for (const o of ops) {
          if (o.kind === 'insert') doc.splice(o.at % (doc.length + 1), 0, cur(`n${next++}`, o.text));
          else if (doc.length === 0) continue;
          else if (o.kind === 'delete') doc.splice(o.at % doc.length, 1);
          else if (o.kind === 'edit') doc = doc.map((p, i) => (i === o.at % doc.length ? { ...p, text: o.text } : p));
          else {
            const [moved] = doc.splice(o.from % doc.length, 1);
            if (moved) doc.splice(o.to % (doc.length + 1), 0, moved);
          }
        }
        const plan = planParagraphSave(before, doc, NONE);
        const after = apply(before, plan);
        if (JSON.stringify(after.map((p) => [p.id, p.text])) !== JSON.stringify(doc.map((p) => [p.id, p.text]))) return false;
        const touched = new Set([...plan.updates.map((u) => u.id), ...plan.deletes.map((d) => d.id)]);
        const untouched = before.filter((p) => !touched.has(p.id));
        return untouched.every((p) => doc.some((d) => d.id === p.id && d.text === p.text));
      }),
    );
  });
});
