import { describe, expect, it } from 'vitest';
import type { Action } from './actions';
import { adjudicate } from './adjudicate';
import { commitRound, type RoundCommit } from './commit';
import { crowded as crowdedScene, run } from './testing/round';
import { replayFrom } from './events';
import type { ActorId } from './ids';
import type { SemanticRuling } from './rulings';
import type { Scene } from './scene/validate';
import { withEffects } from './testing/state';
import { A, P, actor, item, zone } from './testing/warehouse';
import { initialState, type SimState } from './world';

const W = actor('watchman');

const crowded = crowdedScene();

const tryCommit = (scene: Scene, state: SimState, actions: readonly Action[], rulings: readonly SemanticRuling[]) => {
  const adjudication = adjudicate(scene, state, actions);
  if (!adjudication.ok) throw new Error(JSON.stringify(adjudication.error));
  return commitRound(scene, state, adjudication.value, rulings);
};

const perceptionsOf = (commit: RoundCommit, who: ActorId) => commit.perceptions.filter((p) => p.actor === who);

const start: SimState = { ...initialState(crowded, 3), round: 1 };

describe('commitRound', () => {
  it('产出状态变更与按角色分发的感知事件，新状态与回放一致', () => {
    const commit = run(crowded, start, [{ actor: P, kind: 'move', toZone: zone('shelves') }]);
    expect(commit.events.map((e) => e.type)).toEqual([
      'StateChanged',
      'PerceptionDelivered',
      'PerceptionDelivered',
      'PerceptionDelivered',
    ]);
    expect(commit.nextState.world.actors[P]?.zone).toBe('shelves');
    const replayed = replayFrom(crowded, start, commit.events);
    expect(replayed).toEqual({ ok: true, value: commit.nextState });
  });

  it('发生的事带有由回合号确定的标识', () => {
    const commit = run(crowded, start, [
      { actor: P, kind: 'move', toZone: zone('shelves') },
      { actor: W, kind: 'defend' },
    ]);
    expect(commit.occurrences.map((o) => o.id)).toEqual(['1:0', '1:1']);
  });

  describe('语义裁决', () => {
    const attack: Action[] = [{ actor: A, kind: 'attack', target: P, item: item('crossbow') }];

    it('确认的裁决效果在程序效果之后应用', () => {
      const commit = run(crowded, start, attack, [
        {
          requestId: '1:r0',
          effects: [{ type: 'setInjury', actor: P, level: 'severe' }],
          occurrences: [
            { participants: [A, P], zones: [zone('center')], visible: true, loudness: 2, description: { visual: '弩箭擦过主角右臂' } },
          ],
        },
      ]);
      expect(commit.nextState.world.actors[P]?.injury).toBe('severe');
      expect(commit.nextState.world.items[item('crossbow')]?.counters).toEqual({ bolts: 0 });
      expect(commit.occurrences.at(-1)).toMatchObject({ kind: 'ruled', ruling: '1:r0' });
    });

    it('缺少裁决、多余裁决都被拒绝', () => {
      expect(tryCommit(crowded, start, attack, [])).toEqual({
        ok: false,
        error: expect.objectContaining({ code: 'missing_ruling', ref: '1:r0' }),
      });
      expect(
        tryCommit(crowded, start, attack, [
          { requestId: '1:r0', effects: [], occurrences: [] },
          { requestId: '1:r9', effects: [], occurrences: [] },
        ]),
      ).toEqual({ ok: false, error: expect.objectContaining({ code: 'unknown_request', ref: '1:r9' }) });
    });

    it.each<[string, SemanticRuling, string]>([
      ['涉及请求外的角色', { requestId: '1:r0', effects: [{ type: 'setInjury', actor: W, level: 'light' }], occurrences: [] }, 'out_of_scope'],
      ['非相邻移动', { requestId: '1:r0', effects: [{ type: 'moveActor', actor: P, to: zone('office') }], occurrences: [] }, 'not_adjacent'],
      ['推进随机数', { requestId: '1:r0', effects: [{ type: 'advanceRng', to: [1, 2, 3, 4], draws: [] }], occurrences: [] }, 'effect_not_allowed'],
      ['使计数为负', { requestId: '1:r0', effects: [{ type: 'adjustCounter', item: item('crossbow'), counter: 'bolts' as never, delta: -1 }], occurrences: [] }, 'invariant'],
      ['请求外的物品', { requestId: '1:r0', effects: [{ type: 'transferItem', item: item('ledger'), to: { kind: 'actor', actor: A } }], occurrences: [] }, 'out_of_scope'],
      ['发生在无关区域', { requestId: '1:r0', effects: [], occurrences: [{ participants: [A], zones: [zone('office')], visible: true, loudness: 1, description: {} }] }, 'out_of_scope'],
    ])('拒绝越界的裁决：%s', (_name, ruling, code) => {
      expect(tryCommit(crowded, start, attack, [ruling])).toEqual({ ok: false, error: expect.objectContaining({ code }) });
    });
  });

  describe('机关', () => {
    it('进入南门触发绊索，加重伤势并失效；豁免角色与后来者不触发', () => {
      const commit = run(crowded, start, [
        { actor: P, kind: 'move', toZone: zone('south_gate') },
        { actor: W, kind: 'move', toZone: zone('south_gate') },
      ]);
      const actors = commit.nextState.world.actors;
      expect(actors[P]?.injury).toBe('severe');
      expect(actors[W]?.injury).toBe('none');
      expect(commit.nextState.world.mechanisms['tripwire' as never]).toEqual({ armed: false });
      expect(commit.occurrences.filter((o) => o.kind === 'trap_triggered')).toEqual([
        expect.objectContaining({ participants: [P], zones: ['south_gate'], loudness: 3 }),
      ]);
    });

    it('设置机关的角色不会触发', () => {
      const away = withEffects(crowded, start, [{ type: 'moveActor', actor: A, to: zone('center') }]);
      const commit = run(crowded, away, [{ actor: A, kind: 'move', toZone: zone('south_gate') }]);
      expect(commit.occurrences.map((o) => o.kind)).toEqual(['move']);
    });
  });

  describe('感知', () => {
    it('乙在甲看不见、也听不到的区域拾取物品，甲收不到任何感知', () => {
      const s = withEffects(crowded, start, [{ type: 'moveActor', actor: P, to: zone('shelves') }]);
      const commit = run(crowded, s, [{ actor: P, kind: 'take', item: item('tiles') }]);
      expect(perceptionsOf(commit, A)).toEqual([]);
      expect(perceptionsOf(commit, W)).toEqual([expect.objectContaining({ saw: true, heard: false })]);
      expect(perceptionsOf(commit, P)).toEqual([expect.objectContaining({ participant: true })]);
    });

    it('踢碎瓦片：看不见的角色只收到声音', () => {
      const s = withEffects(crowded, start, [
        { type: 'moveActor', actor: P, to: zone('shelves') },
        { type: 'transferItem', item: item('tiles'), to: { kind: 'actor', actor: P } },
      ]);
      const commit = run(crowded, s, [{ actor: P, kind: 'use_item', item: item('tiles') }]);
      expect(perceptionsOf(commit, A)).toEqual([
        { actor: A, occurrence: '1:0', participant: false, saw: false, heard: true },
      ]);
    });

    it('被打断的台词只传播打断点之前的句子；邻区只听到有人在说话', () => {
      const commit = run(crowded, start, [
        {
          actor: P,
          kind: 'speak',
          target: W,
          utterance: { sentences: ['我不是来找麻烦的。', '这封信……', '是给你们东家的。'], volume: 'normal', deliveredCount: 2 },
        },
      ]);
      expect(commit.occurrences[0]?.speech).toEqual({ sentences: ['我不是来找麻烦的。', '这封信……'], volume: 'normal' });
      expect(perceptionsOf(commit, W)).toEqual([expect.objectContaining({ heard: true, speech: 'full' })]);
      expect(perceptionsOf(commit, A)).toEqual([expect.objectContaining({ saw: true, heard: true, speech: 'muffled' })]);
    });

    it('耳语传不出所在区域', () => {
      const commit = run(crowded, start, [
        { actor: P, kind: 'speak', utterance: { sentences: ['别出声。'], volume: 'whisper' } },
      ]);
      expect(perceptionsOf(commit, W)).toEqual([expect.objectContaining({ speech: 'full' })]);
      expect(perceptionsOf(commit, A)).toEqual([expect.objectContaining({ saw: true, heard: false })]);
      expect(perceptionsOf(commit, A)[0]).not.toHaveProperty('speech');
    });

    it('已撤离的角色不再接收感知', () => {
      const gone = withEffects(crowded, start, [{ type: 'setActorStatus', actor: A, status: 'withdrawn' }]);
      const commit = run(crowded, gone, [
        { actor: P, kind: 'speak', utterance: { sentences: ['站住！'], volume: 'shout' } },
      ]);
      expect(perceptionsOf(commit, A)).toEqual([]);
    });

    it('移动在起点与终点两处都可被看见', () => {
      const commit = run(crowded, start, [{ actor: W, kind: 'move', toZone: zone('shelves') }]);
      expect(perceptionsOf(commit, A)).toEqual([expect.objectContaining({ saw: true })]);
    });
  });
});
