import { describe, expect, it } from 'vitest';
import type { ActorId } from '@fudiao/domain';
import { proposalToAction } from './convert';
import { waitProposal } from './testing/fake-model';

const actor = 'a_qing' as ActorId;

describe('提案转为行动', () => {
  it('任何行动都保留附带的台词与旁人可见的动作描述', () => {
    const action = proposalToAction(
      waitProposal({
        kind: 'other',
        item: 'letter',
        description: ' 把信放在地上 ',
        utterance: { sentences: [' 信在这儿。 ', ''], volume: 'normal' },
      }),
      actor,
    );
    expect(action).toEqual({
      actor,
      kind: 'other',
      item: 'letter',
      description: '把信放在地上',
      utterance: { sentences: ['信在这儿。'], volume: 'normal' },
    });
  });

  it('非说话类行动的空台词与空描述不保留', () => {
    expect(proposalToAction(waitProposal({ utterance: { sentences: ['  '], volume: 'normal' }, description: ' ' }), actor)).toEqual({ actor, kind: 'wait' });
  });
});
