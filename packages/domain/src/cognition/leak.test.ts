import { canonicalJson } from '@novel-writer/shared';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Action } from '../actions';
import type { ActorId, FlagKey } from '../ids';
import { Tape, tapeArb } from '../testing/arbitraries';
import { CANARY, canaryScene, staticForbidden } from '../testing/canary';
import { run } from '../testing/round';
import { simulate } from '../testing/simulate';
import { withEffects } from '../testing/state';
import { A, P, actor, item, zone } from '../testing/warehouse';
import { initialState, type SimState } from '../world';
import { buildCharacterView } from './view';

// 金丝雀泄露测试（硬性规则 4）：私有信息中嵌入唯一标记，检查角色视图中是否出现无权限的标记。
const W = actor('watchman');
const scene = canaryScene();
const actors = scene.actors.map((a) => a.id);
const start: SimState = { ...initialState(scene, 11), round: 1 };

const viewText = (state: SimState, who: ActorId) => canonicalJson(buildCharacterView(scene, state, who));

const expectAbsent = (state: SimState, who: ActorId, marker: string) =>
  expect(viewText(state, who), `${who} 的视图不应包含 ${marker}`).not.toContain(marker);

describe('金丝雀泄露测试', () => {
  it('任意回合后，场景元信息、秘密与他人的角色卡都不出现在角色视图中', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffffff }), fc.integer({ min: 0, max: 8 }), tapeArb, (seed, rounds, values) => {
        const { snapshots, final } = simulate(scene, seed, rounds, new Tape(values));
        for (const state of [...snapshots.map((s) => s.state), final]) {
          for (const who of actors) {
            const text = viewText(state, who);
            for (const marker of staticForbidden(scene, who)) expect(text).not.toContain(marker);
            // 本人的角色卡与初始认知可以出现。
            expect(text).toContain(`${CANARY}-CARD-${who}-goal`);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it('隐藏机关的名称只在知情或发现之后出现', () => {
    expectAbsent(start, P, `${CANARY}-MECH-`);
    expectAbsent(start, W, `${CANARY}-MECH-`);
    expect(viewText(start, A)).toContain(`${CANARY}-MECH-tripwire`);
    const atGate = withEffects(scene, start, [{ type: 'moveActor', actor: P, to: zone('south_gate') }]);
    const after = run(scene, atGate, [{ actor: P, kind: 'observe' }]).nextState;
    expect(viewText(after, P)).toContain(`${CANARY}-MECH-tripwire`);
    expectAbsent(after, W, `${CANARY}-MECH-`);
  });

  it('藏匿的物品只有持有者知道，放下后旁人才看得见', () => {
    expectAbsent(start, A, `${CANARY}-ITEM-letter`);
    expectAbsent(start, W, `${CANARY}-ITEM-letter`);
    expect(viewText(start, P)).toContain(`${CANARY}-ITEM-letter`);
    const dropped = run(scene, start, [{ actor: P, kind: 'drop', item: item('letter') }]).nextState;
    expect(viewText(dropped, W)).toContain(`${CANARY}-ITEM-letter`);
  });

  it('看不见的区域中的物品不出现，进入后才出现', () => {
    for (const who of actors) expectAbsent(start, who, `${CANARY}-ITEM-ledger`);
    const inside = withEffects(scene, start, [
      { type: 'setFlag', flag: 'office_open' as FlagKey, value: true },
      { type: 'moveActor', actor: P, to: zone('office') },
    ]);
    expect(viewText(inside, P)).toContain(`${CANARY}-ITEM-ledger`);
    expectAbsent(inside, W, `${CANARY}-ITEM-ledger`);
  });

  describe('台词', () => {
    const say = (sentences: string[], extra: Partial<Action> = {}): Action => ({
      actor: A,
      kind: 'speak',
      utterance: { sentences, volume: 'shout' },
      ...extra,
    });

    it('只有同区域的听者得到台词内容', () => {
      // 对手在南门喊话：主角与巡夜人在中央，只听到有人在说话。
      const after = run(scene, start, [say([`${CANARY}-SPEECH-far`])]).nextState;
      expectAbsent(after, P, `${CANARY}-SPEECH-`);
      expectAbsent(after, W, `${CANARY}-SPEECH-`);
      expect(viewText(after, A)).toContain(`${CANARY}-SPEECH-far`);
    });

    it('被打断后未说出的句子不出现在任何视图中', () => {
      const together = withEffects(scene, start, [{ type: 'moveActor', actor: A, to: zone('center') }]);
      const after = run(scene, together, [
        say([`${CANARY}-SPEECH-said`, `${CANARY}-SPEECH-unsaid`], {
          utterance: { sentences: [`${CANARY}-SPEECH-said`, `${CANARY}-SPEECH-unsaid`], volume: 'normal', deliveredCount: 1 },
        }),
      ]).nextState;
      expect(viewText(after, P)).toContain(`${CANARY}-SPEECH-said`);
      for (const who of actors) expectAbsent(after, who, `${CANARY}-SPEECH-unsaid`);
    });

    it('已撤离的角色听不到之后的台词', () => {
      const gone = withEffects(scene, start, [
        { type: 'moveActor', actor: A, to: zone('center') },
        { type: 'setActorStatus', actor: P, status: 'withdrawn' },
      ]);
      const after = run(scene, gone, [say([`${CANARY}-SPEECH-late`])]).nextState;
      expectAbsent(after, P, `${CANARY}-SPEECH-`);
      expect(viewText(after, W)).toContain(`${CANARY}-SPEECH-late`);
    });
  });

  it('视线外的取物不进入旁人的视图', () => {
    const s = withEffects(scene, start, [
      { type: 'moveActor', actor: W, to: zone('south_gate') },
      { type: 'moveActor', actor: P, to: zone('shelves') },
    ]);
    const after = run(scene, s, [{ actor: P, kind: 'take', item: item('office_key') }]).nextState;
    expect(viewText(after, W)).not.toContain('office_key');
    expect(viewText(after, A)).not.toContain('office_key');
  });
});
