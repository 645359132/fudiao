import { canonicalJson } from '@fudiao/shared';
import { describe, expect, it } from 'vitest';
import type { ActorId, ClaimId, CounterKey } from '../ids';
import { crowded, run } from '../testing/round';
import { withEffects } from '../testing/state';
import { A, P, actor, item, warehouse, zone } from '../testing/warehouse';
import { initialState, type SimState } from '../world';
import type { KnowledgeItem, Observation } from './types';

const W = actor('watchman');
const scene = crowded();
const start: SimState = { ...initialState(scene, 3), round: 1 };

const added = (before: SimState, after: SimState, who: ActorId): readonly KnowledgeItem[] =>
  (after.knowledge[who] ?? []).slice((before.knowledge[who] ?? []).length);

const observations = (before: SimState, after: SimState, who: ActorId): Observation[] =>
  added(before, after, who).flatMap((k) => (k.body.kind === 'observation' ? [k.body.observation] : []));

describe('初始认知', () => {
  it('由角色卡生成，标识按顺序确定', () => {
    const items = start.knowledge[P] ?? [];
    expect(items.map((k) => k.id)).toEqual(['protagonist:0:0', 'protagonist:0:1', 'protagonist:0:2']);
    expect(items[2]).toEqual({
      id: 'protagonist:0:2',
      holder: P,
      round: 0,
      modality: 'inferred',
      confidence: 0.6,
      order: 2,
      concerning: A,
      about: ['protagonist'],
      body: { kind: 'text', text: '对手以为我伤得很轻' },
      status: 'active',
    });
  });

  it('认知与事实分离：主角误信弩箭已用完，世界状态的余量不变', () => {
    expect(start.knowledge[P]?.[1]?.body).toEqual({ kind: 'text', text: '对手的弩箭已经用完' });
    expect(start.world.items[item('crossbow')]?.counters['bolts' as CounterKey]).toBe(1);
  });

  it('没有角色卡的角色没有初始认知', () => {
    expect(start.knowledge[W]).toEqual([]);
  });
});

describe('由感知生成认知', () => {
  it('当事人知道失败原因，旁观者只知道失败', () => {
    const empty = withEffects(scene, start, [
      { type: 'adjustCounter', item: item('crossbow'), counter: 'bolts' as CounterKey, delta: -1 },
    ]);
    const after = run(scene, empty, [{ actor: A, kind: 'attack', target: P, item: item('crossbow') }]).nextState;
    expect(observations(empty, after, A)).toEqual([
      expect.objectContaining({
        channel: 'participant',
        kind: 'failed_attempt',
        failed: true,
        violation: expect.objectContaining({ code: 'resource_exhausted' }),
      }),
    ]);
    const seen = observations(empty, after, P);
    expect(seen).toEqual([
      expect.objectContaining({ channel: 'sight', kind: 'failed_attempt', attempted: 'attack', failed: true, actor: A, item: 'crossbow' }),
    ]);
    expect(seen[0]).not.toHaveProperty('violation');
    expect(added(empty, after, P)[0]).toMatchObject({ modality: 'observed', confidence: 1, about: expect.arrayContaining([A, 'crossbow']) });
  });

  it('只听见碎瓦声：得到声音类别、声源区域与物品，没有行动者', () => {
    const s = withEffects(scene, start, [
      { type: 'moveActor', actor: P, to: zone('shelves') },
      { type: 'transferItem', item: item('tiles'), to: { kind: 'actor', actor: P } },
    ]);
    const after = run(scene, s, [{ actor: P, kind: 'use_item', item: item('tiles') }]).nextState;
    expect(observations(s, after, A)).toEqual([
      { occurrence: '1:0', channel: 'sound', sound: 'noise', zones: ['shelves'], item: 'tiles' },
    ]);
    expect(added(s, after, A)[0]).toMatchObject({ modality: 'heard', about: ['shelves', 'tiles'] });
  });

  it('只听见拾取声：不知道拿走了什么', () => {
    const loud = warehouse((sp) => {
      sp.loudness = { take: 3 };
    });
    const s = withEffects(loud, { ...initialState(loud, 1), round: 1 }, [
      { type: 'moveActor', actor: P, to: zone('shelves') },
    ]);
    const after = run(loud, s, [{ actor: P, kind: 'take', item: item('office_key') }]).nextState;
    expect(observations(s, after, A)).toEqual([
      { occurrence: '1:0', channel: 'sound', sound: 'handling', zones: ['shelves'] },
    ]);
    expect(canonicalJson(after.knowledge[A] ?? [])).not.toContain('office_key');
  });

  it('同区域观察发现机关，只有观察者获得关于机关的认知', () => {
    const s = withEffects(scene, start, [{ type: 'moveActor', actor: P, to: zone('south_gate') }]);
    const after = run(scene, s, [{ actor: P, kind: 'observe' }]).nextState;
    expect(added(s, after, P).some((k) => k.about.includes('tripwire'))).toBe(true);
    expect(added(s, after, W).some((k) => k.about.includes('tripwire'))).toBe(false);
  });

  it('看见语义裁决的结果只得到视觉描述', () => {
    const after = run(scene, start, [{ actor: A, kind: 'attack', target: P, item: item('crossbow') }], [
      {
        requestId: '1:r0',
        effects: [],
        occurrences: [
          { participants: [A, P], zones: [zone('center')], visible: true, loudness: 2, description: { visual: '弩箭钉进主角身旁的木柱', sound: '一声闷响' } },
        ],
      },
    ]).nextState;
    expect(observations(start, after, W)).toEqual([
      expect.objectContaining({ channel: 'sight', kind: 'ruled', description: { visual: '弩箭钉进主角身旁的木柱', sound: '一声闷响' } }),
    ]);
    expect(observations(start, after, P)[0]?.channel).toBe('participant');
  });
});

describe('人物说法', () => {
  // 台词只有同区域才能听清，对手走到主角身边说话。
  const together = withEffects(scene, start, [{ type: 'moveActor', actor: A, to: zone('center') }]);
  const lie = {
    actor: A,
    kind: 'speak' as const,
    target: P,
    utterance: { sentences: ['援兵就在门外。', '你跑不掉的。'], volume: 'shout' as const },
  };

  it('谎言作为说法进入听者认知，相信程度待评估，世界状态不变', () => {
    const after = run(scene, together, [lie]).nextState;
    expect(after.world).toEqual(together.world);
    expect(after.claims['1:0' as ClaimId]).toEqual({
      id: '1:0',
      speaker: A,
      round: 1,
      sentences: ['援兵就在门外。', '你跑不掉的。'],
      addressee: P,
    });
    const claimed = added(together, after, P).filter((k) => k.modality === 'claimed');
    expect(claimed).toEqual([
      expect.objectContaining({ confidence: null, about: [A], body: { kind: 'claim', claim: '1:0' } }),
    ]);
  });

  // 巡夜人在账房：看不见中央，声音经过衰减 2 的边。
  const far = withEffects(scene, together, [
    { type: 'setFlag', flag: 'office_open' as never, value: true },
    { type: 'moveActor', actor: W, to: zone('office') },
  ]);

  it('隔墙余量不足时只听到有人在说话，不获得说法与句子', () => {
    // 正常说话（2）在中央，传到账房后余量为 0，听不到；喊话（4）余量为 2，能听清。用中等音量的场景配置验证听不清的情形。
    const quiet = warehouse((sp) => {
      sp.actors.push({ id: 'watchman', name: '巡夜人', zone: 'center' });
      sp.loudness = { speak: { shout: 3 } };
    });
    const s = withEffects(quiet, { ...initialState(quiet, 3), round: 1 }, [
      { type: 'moveActor', actor: A, to: zone('center') },
      { type: 'setFlag', flag: 'office_open' as never, value: true },
      { type: 'moveActor', actor: W, to: zone('office') },
    ]);
    const after = run(quiet, s, [lie]).nextState;
    const heard = observations(s, after, W);
    expect(heard).toEqual([expect.objectContaining({ channel: 'sound', sound: 'voice', speech: { clarity: 'muffled' } })]);
    expect(added(s, after, W).some((k) => k.modality === 'claimed')).toBe(false);
    expect(canonicalJson(after.knowledge[W] ?? [])).not.toContain('援兵');
  });

  it('隔墙的喊声余量足够时听得清，但看不见说话的人，不记为某人的说法', () => {
    const after = run(scene, far, [lie]).nextState;
    const [heard] = observations(far, after, W);
    expect(heard).toMatchObject({ channel: 'sound', speech: { clarity: 'full', sentences: ['援兵就在门外。', '你跑不掉的。'] } });
    expect(heard).not.toHaveProperty('actor');
    expect(added(far, after, W).some((k) => k.modality === 'claimed')).toBe(false);
  });

  it('看得见却听不到时，只知道对方在说话', () => {
    const after = run(scene, start, [
      { actor: P, kind: 'speak', utterance: { sentences: ['别出声。'], volume: 'whisper' } },
    ]).nextState;
    expect(observations(start, after, A)).toEqual([
      expect.objectContaining({ channel: 'sight', kind: 'speak', actor: P, speech: { clarity: 'unheard' } }),
    ]);
  });

  it('被打断后未说出的句子不进入任何认知', () => {
    const after = run(scene, together, [{ ...lie, utterance: { ...lie.utterance, deliveredCount: 1 } }]).nextState;
    expect(canonicalJson({ knowledge: after.knowledge, claims: after.claims })).not.toContain('你跑不掉的');
    expect(after.claims['1:0' as ClaimId]?.sentences).toEqual(['援兵就在门外。']);
  });

  it('离场的角色不再获得新的认知', () => {
    const gone = withEffects(scene, together, [{ type: 'setActorStatus', actor: P, status: 'withdrawn' }]);
    const after = run(scene, gone, [lie]).nextState;
    expect(added(gone, after, P)).toEqual([]);
  });
});
