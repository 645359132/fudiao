import { describe, expect, it } from 'vitest';
import type { Action } from './actions';
import { adjudicate } from './adjudicate';
import { commitRound } from './commit';
import { speechAudience } from './perception';
import { withEffects } from './testing/state';
import { A, P, warehouse, zone } from './testing/warehouse';
import { initialState, type SimState } from './world';
import type { Volume } from './scene/schema';

const scene = warehouse();
const round1: SimState = { ...initialState(scene, 1), round: 1 };
const say = (volume: Volume, extra: Partial<Action> = {}): Action => ({
  actor: P,
  kind: 'speak',
  utterance: { sentences: ['把信交出来。', '我数到三。'], volume },
  ...extra,
});

describe('speechAudience：轮流对话中谁听得清台词', () => {
  it('同一区域的人听得清，说话者自己不在其中', () => {
    const together = withEffects(scene, round1, [{ type: 'moveActor', actor: A, to: zone('center') }]);
    expect(speechAudience(scene, together, say('whisper'))).toEqual(new Map([[A, 'full']]));
  });

  it('隔一个区域：正常音量只听到有人说话，喊叫听得清，耳语听不到', () => {
    expect(speechAudience(scene, round1, say('normal'))).toEqual(new Map([[A, 'muffled']]));
    expect(speechAudience(scene, round1, say('shout'))).toEqual(new Map([[A, 'full']]));
    expect(speechAudience(scene, round1, say('whisper'))).toEqual(new Map());
  });

  it('对谁说不改变谁听得到：耳语的对象隔着区域同样听不到', () => {
    expect(speechAudience(scene, round1, say('whisper', { target: A }))).toEqual(new Map());
  });

  it('离场的人不再听到', () => {
    const gone = withEffects(scene, round1, [{ type: 'setActorStatus', actor: A, status: 'withdrawn' }]);
    expect(speechAudience(scene, gone, say('shout'))).toEqual(new Map());
  });

  it('没有台词时没有听众', () => {
    expect(speechAudience(scene, round1, { actor: P, kind: 'wait' })).toEqual(new Map());
  });

  it('与提交后按感知分发的结果一致：听得清的人得到台词，听不清的只知道有人说话', () => {
    for (const volume of ['whisper', 'normal', 'shout'] as const) {
      const adj = adjudicate(scene, round1, [say(volume), { actor: A, kind: 'wait' }]);
      if (!adj.ok) throw new Error('裁决失败');
      const committed = commitRound(scene, round1, adj.value, []);
      if (!committed.ok) throw new Error('提交失败');
      const delivered = new Map(
        committed.value.events.flatMap((e) =>
          e.type === 'PerceptionDelivered' && e.actor === A
            ? e.observations.flatMap((o) =>
                o.kind === 'speak' && o.speech !== undefined && o.speech.clarity !== 'unheard' ? [[A, o.speech.clarity] as const] : [],
              )
            : [],
        ),
      );
      expect(speechAudience(scene, round1, say(volume)), volume).toEqual(delivered);
    }
  });
});
