import { describe, expect, it } from 'vitest';
import { applyEvent, replayFrom } from '../events';
import type { KnowledgeId } from '../ids';
import { crowded } from '../testing/round';
import { A, P } from '../testing/warehouse';
import { initialState, type SimState } from '../world';
import { planBeliefUpdate, type BeliefProposal } from './update';

const scene = crowded();
const start: SimState = { ...initialState(scene, 3), round: 2 };
const kid = (id: string) => id as KnowledgeId;

const plan = (proposal: BeliefProposal, actor = P, state = start) => planBeliefUpdate(scene, state, actor, proposal);

describe('认知更新', () => {
  it('新增推测并分配标识，应用后进入本人认知', () => {
    const result = plan({
      add: [
        { text: '对手迟迟不放箭，也许在等更好的机会', confidence: 0.5, about: ['crossbow', 'antagonist'] },
        { text: '对手以为我不敢靠近南门', confidence: 0.4, about: ['south_gate'], order: 2, concerning: A },
      ],
      revise: [{ id: kid('protagonist:0:1'), confidence: 0.3 }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.added.map((k) => [k.id, k.modality, k.about])).toEqual([
      ['protagonist:2:3', 'inferred', ['antagonist', 'crossbow']],
      ['protagonist:2:4', 'inferred', ['south_gate']],
    ]);
    const next = applyEvent(scene, start, result.value);
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    const items = next.value.knowledge[P] ?? [];
    expect(items).toHaveLength(5);
    expect(items[1]?.confidence).toBe(0.3);
    expect(next.value.knowledge[A]).toEqual(start.knowledge[A]);
  });

  it('撤回的条目不能再修改', () => {
    const retract = plan({ retract: [kid('protagonist:0:1')] });
    if (!retract.ok) throw new Error('应当成功');
    const next = applyEvent(scene, start, retract.value);
    if (!next.ok) throw new Error('应当成功');
    expect(next.value.knowledge[P]?.[1]?.status).toBe('retracted');
    expect(plan({ revise: [{ id: kid('protagonist:0:1'), confidence: 1 }] }, P, next.value)).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'not_active' }),
    });
  });

  it.each<[string, BeliefProposal, string]>([
    ['修改他人的条目', { revise: [{ id: kid('antagonist:0:0'), confidence: 0 }] }, 'not_own'],
    ['修改不存在的条目', { revise: [{ id: kid('protagonist:9:9'), confidence: 0 }] }, 'unknown_ref'],
    ['相信程度越界', { add: [{ text: '对手很累', confidence: 1.5, about: [] }] }, 'invalid_confidence'],
    ['新增观察条目', { add: [{ text: '我看见了绊索', confidence: 1, about: [], modality: 'observed' }] }, 'not_inferred'],
    ['空文本', { add: [{ text: '  ', confidence: 0.5, about: [] }] }, 'empty_text'],
    ['引用视图外的标识', { add: [{ text: '南门大概有绊索', confidence: 0.6, about: ['tripwire'] }] }, 'unknown_ref'],
    ['二阶推测指向自己', { add: [{ text: '我以为我……', confidence: 0.5, about: [], order: 2, concerning: P }] }, 'invalid_order'],
    ['二阶推测没有指向', { add: [{ text: '他以为……', confidence: 0.5, about: [], order: 2 }] }, 'invalid_order'],
    ['一阶推测带有指向', { add: [{ text: '对手很累', confidence: 0.5, about: [], concerning: A }] }, 'invalid_order'],
    ['重复引用同一条目', { revise: [{ id: kid('protagonist:0:1'), confidence: 0.2 }], retract: [kid('protagonist:0:1')] }, 'duplicate_ref'],
  ])('拒绝：%s', (_name, proposal, code) => {
    expect(plan(proposal)).toEqual({ ok: false, error: expect.objectContaining({ code }) });
  });

  it('回放时拒绝被改坏的认知更新事件', () => {
    const result = plan({ add: [{ text: '对手很累', confidence: 0.5, about: [] }] });
    if (!result.ok) throw new Error('应当成功');
    const tampered = {
      ...result.value,
      added: result.value.added.map((k) => ({ ...k, modality: 'observed' as const })),
    };
    expect(replayFrom(scene, start, [tampered])).toEqual({
      ok: false,
      error: { index: 0, code: 'invalid_belief_update', detail: expect.objectContaining({ code: 'not_inferred' }) },
    });
  });
});
