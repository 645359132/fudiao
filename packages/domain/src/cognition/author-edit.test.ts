import { describe, expect, it } from 'vitest';
import { applyEvent, replayFrom } from '../events';
import type { KnowledgeId } from '../ids';
import { crowded } from '../testing/round';
import { P } from '../testing/warehouse';
import { initialState, type SimState } from '../world';
import { planKnowledgeEdit } from './author-edit';
import { buildCharacterView } from './view';

const scene = crowded();
const start: SimState = { ...initialState(scene, 3), round: 2 };

describe('作者修改角色认知', () => {
  it('让主角提前知道绊索的位置：条目进入认知，机关出现在视图中', () => {
    const planned = planKnowledgeEdit(scene, start, P, {
      add: [{ text: '南门门槛下有一道绊索', modality: 'heard', confidence: 0.9, about: ['tripwire', 'south_gate'] }],
      retract: ['protagonist:0:1' as KnowledgeId],
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const next = applyEvent(scene, start, planned.value);
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    const view = buildCharacterView(scene, next.value, P);
    expect(view.knowledge.map((k) => k.modality)).toContain('heard');
    expect(view.knowledge.map((k) => k.id)).not.toContain('protagonist:0:1');
    expect(view.visible.mechanisms.map((m) => m.id)).toEqual(['tripwire']);
  });

  it('引用不存在的对象或已撤回的条目时报错', () => {
    expect(planKnowledgeEdit(scene, start, P, { add: [{ text: 'x', modality: 'heard', confidence: 1, about: ['moon'] }], retract: [] })).toEqual({
      ok: false,
      error: { code: 'unknown_ref', ref: 'moon' },
    });
  });

  it('回放时拒绝把人物说法当作作者修改写入', () => {
    const planned = planKnowledgeEdit(scene, start, P, { add: [{ text: 'x', modality: 'heard', confidence: 1, about: [] }], retract: [] });
    if (!planned.ok) throw new Error('应当成功');
    const tampered = { ...planned.value, added: planned.value.added.map((k) => ({ ...k, modality: 'claimed' as const })) };
    expect(replayFrom(scene, start, [tampered])).toEqual({
      ok: false,
      error: expect.objectContaining({ index: 0, code: 'invalid_knowledge_edit' }),
    });
  });
});
