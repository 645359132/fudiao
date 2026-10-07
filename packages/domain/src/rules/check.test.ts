import { describe, expect, it } from 'vitest';
import type { Action } from '../actions';
import type { CounterKey } from '../ids';
import { withEffects } from '../testing/state';
import { A, P, item, warehouse, zone } from '../testing/warehouse';
import { initialState } from '../world';
import { checkAction } from './check';

const scene = warehouse();
const start = initialState(scene, 1);
const bolts = 'bolts' as CounterKey;

const rejected = (code: string) => ({ kind: 'reject', violation: expect.objectContaining({ code }) });
const failed = (code: string) => ({ kind: 'fail', violation: expect.objectContaining({ code }) });
const pass = { kind: 'pass' };

const check = (action: Action, state = start) => checkAction(scene, state, action);

describe('行动前提检查', () => {
  describe('位置与移动', () => {
    it('可以移动到相邻区域', () => {
      expect(check({ actor: P, kind: 'move', toZone: zone('shelves') })).toEqual(pass);
    });

    it('非相邻移动被拒绝', () => {
      expect(check({ actor: A, kind: 'move', toZone: zone('shelves') })).toEqual(rejected('not_adjacent'));
    });

    it('通行条件未满足时被拒绝', () => {
      expect(check({ actor: P, kind: 'move', toZone: zone('office') })).toEqual(rejected('path_blocked'));
    });

    it('原地移动与未知区域被拒绝', () => {
      expect(check({ actor: P, kind: 'move', toZone: zone('center') })).toEqual(rejected('same_zone'));
      expect(check({ actor: P, kind: 'move', toZone: zone('roof') })).toEqual(rejected('target_unknown'));
      expect(check({ actor: P, kind: 'move' })).toEqual(rejected('missing_field'));
    });
  });

  describe('持有', () => {
    it('只能拾取同区域且无人持有的物品', () => {
      expect(check({ actor: P, kind: 'take', item: item('tiles') })).toEqual(rejected('item_not_here'));
      expect(check({ actor: A, kind: 'take', item: item('letter') })).toEqual(rejected('item_held'));
      const atShelves = withEffects(scene, start, [{ type: 'moveActor', actor: P, to: zone('shelves') }]);
      expect(check({ actor: P, kind: 'take', item: item('tiles') }, atShelves)).toEqual(pass);
    });

    it('使用与放下要求持有该物品', () => {
      expect(check({ actor: P, kind: 'use_item', item: item('crossbow') })).toEqual(rejected('not_holding'));
      expect(check({ actor: P, kind: 'drop', item: item('tiles') })).toEqual(rejected('not_holding'));
      expect(check({ actor: P, kind: 'drop', item: item('letter') })).toEqual(pass);
    });
  });

  describe('视线与距离', () => {
    it('远程攻击要求可见', () => {
      expect(check({ actor: A, kind: 'attack', target: P, item: item('crossbow') })).toEqual(pass);
      const hidden = withEffects(scene, start, [{ type: 'moveActor', actor: P, to: zone('shelves') }]);
      expect(check({ actor: A, kind: 'attack', target: P, item: item('crossbow') }, hidden)).toEqual(
        rejected('out_of_sight'),
      );
    });

    it('近战与徒手攻击要求同区域', () => {
      expect(check({ actor: P, kind: 'attack', target: A, item: item('dagger') })).toEqual(
        rejected('out_of_reach'),
      );
      expect(check({ actor: P, kind: 'attack', target: A })).toEqual(rejected('out_of_reach'));
      const close = withEffects(scene, start, [{ type: 'moveActor', actor: P, to: zone('south_gate') }]);
      expect(check({ actor: P, kind: 'attack', target: A, item: item('dagger') }, close)).toEqual(pass);
    });

    it('攻击对象必须是在场的其他角色', () => {
      expect(check({ actor: P, kind: 'attack', target: P })).toEqual(rejected('target_self'));
      expect(check({ actor: P, kind: 'attack', target: 'tiles' })).toEqual(rejected('target_not_actor'));
      const gone = withEffects(scene, start, [{ type: 'setActorStatus', actor: A, status: 'withdrawn' }]);
      expect(check({ actor: P, kind: 'attack', target: A }, gone)).toEqual(rejected('target_absent'));
    });
  });

  describe('消耗', () => {
    it('余量不足时按规则形成失败尝试', () => {
      const empty = withEffects(scene, start, [
        { type: 'adjustCounter', item: item('crossbow'), counter: bolts, delta: -1 },
      ]);
      expect(check({ actor: A, kind: 'attack', target: P, item: item('crossbow') }, empty)).toEqual(
        failed('resource_exhausted'),
      );
    });

    it('余量不足时按规则拒绝', () => {
      const strict = warehouse((s) => {
        s.rules!.consumption![0]!.whenEmpty = 'reject';
      });
      const empty = withEffects(strict, initialState(strict, 1), [
        { type: 'adjustCounter', item: item('crossbow'), counter: bolts, delta: -1 },
      ]);
      expect(checkAction(strict, empty, { actor: A, kind: 'attack', target: P, item: item('crossbow') })).toEqual(
        rejected('resource_exhausted'),
      );
    });
  });

  describe('伤势等级', () => {
    it('左肩受伤的主角不能使用弩', () => {
      const armed = withEffects(scene, start, [
        { type: 'transferItem', item: item('crossbow'), to: { kind: 'actor', actor: P } },
      ]);
      expect(check({ actor: P, kind: 'attack', target: A, item: item('crossbow') }, armed)).toEqual(
        rejected('injury_forbids'),
      );
    });

    it('失去行动力时只允许等待', () => {
      const down = withEffects(scene, start, [{ type: 'setInjury', actor: A, level: 'incapacitated' }]);
      expect(check({ actor: A, kind: 'move', toZone: zone('center') }, down)).toEqual(rejected('incapacitated'));
      expect(check({ actor: A, kind: 'wait' }, down)).toEqual(pass);
    });
  });

  describe('前提条件', () => {
    it('没有钥匙开锁被拒绝', () => {
      expect(check({ actor: P, kind: 'other', target: 'office' })).toEqual(rejected('requirement_unmet'));
    });

    it('持有钥匙时通过', () => {
      const keyed = withEffects(scene, start, [
        { type: 'transferItem', item: item('office_key'), to: { kind: 'actor', actor: P } },
      ]);
      expect(check({ actor: P, kind: 'use_item', item: item('office_key'), target: 'office' }, keyed)).toEqual(pass);
    });
  });

  describe('其他', () => {
    it('已撤离的角色不能行动', () => {
      const gone = withEffects(scene, start, [{ type: 'setActorStatus', actor: P, status: 'withdrawn' }]);
      expect(check({ actor: P, kind: 'wait' }, gone)).toEqual(rejected('actor_withdrawn'));
    });

    it('只能在出口撤离', () => {
      expect(check({ actor: P, kind: 'withdraw' })).toEqual(rejected('not_at_exit'));
      expect(check({ actor: A, kind: 'withdraw' })).toEqual(pass);
    });

    it('台词至少一句，说出的句数不超过总句数', () => {
      expect(check({ actor: P, kind: 'speak', utterance: { sentences: [], volume: 'normal' } })).toEqual(
        rejected('empty_utterance'),
      );
      expect(
        check({ actor: P, kind: 'speak', utterance: { sentences: ['站住。'], volume: 'normal', deliveredCount: 2 } }),
      ).toEqual(rejected('invalid_delivery'));
      expect(check({ actor: P, kind: 'speak', utterance: { sentences: ['站住。'], volume: 'shout' } })).toEqual(pass);
    });

    it('未知角色与未知对象被拒绝', () => {
      expect(check({ actor: 'ghost' as typeof P, kind: 'wait' })).toEqual(rejected('actor_unknown'));
      expect(check({ actor: P, kind: 'observe', target: 'moon' })).toEqual(rejected('target_unknown'));
    });
  });
});
