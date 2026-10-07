import { describe, expect, it } from 'vitest';
import { warehouseSpec } from '../testing/warehouse';
import { parseScene, type SceneError } from './validate';

const errorsOf = (input: unknown): readonly SceneError[] => {
  const result = parseScene(input);
  if (result.ok) throw new Error('预期场景无效');
  return result.error;
};

describe('parseScene', () => {
  it('接受合法场景并补全默认值', () => {
    const result = parseScene(warehouseSpec());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.loudness.speak.normal).toBe(2);
    expect(result.value.actors.find((a) => a.id === 'antagonist')?.injury).toBe('none');
  });

  it('结构不合法时返回 schema 错误与路径', () => {
    const spec = warehouseSpec();
    (spec.zones[0] as { id: string }).id = '带 空格';
    expect(errorsOf(spec)).toContainEqual(
      expect.objectContaining({ code: 'schema', path: ['zones', 0, 'id'] }),
    );
  });

  it('检出重复标识', () => {
    const spec = warehouseSpec();
    spec.zones.push({ id: 'center', name: '另一个中央' });
    expect(errorsOf(spec)).toContainEqual({ code: 'duplicate_id', path: ['zones', 4, 'id'], ref: 'center' });
  });

  it('检出自环与重复边', () => {
    const spec = warehouseSpec();
    spec.edges?.push(
      { between: ['center', 'center'], adjacent: true, visible: true, sound: 0 },
      { between: ['shelves', 'center'], adjacent: true, visible: true, sound: 1 },
    );
    const errors = errorsOf(spec);
    expect(errors).toContainEqual({ code: 'self_loop', path: ['edges', 4], ref: 'center' });
    expect(errors).toContainEqual({ code: 'duplicate_edge', path: ['edges', 5], ref: 'center|shelves' });
  });

  it('检查角色卡与秘密的引用', () => {
    const spec = warehouseSpec();
    const card = spec.actors[0]!.card!;
    card.initialKnowledge![0]!.about = ['nowhere'];
    card.initialKnowledge![2]!.concerning = 'ghost';
    spec.actors[1]!.card!.initialKnowledge![0]!.order = 2;
    spec.secrets![0]!.subjects = ['tripwire', 'phantom'];
    spec.secrets![0]!.knownBy = ['ghost'];
    spec.secrets!.push({ id: 'tripwire_secret', text: '重复', subjects: ['tripwire'] });
    expect(errorsOf(spec)).toEqual(
      expect.arrayContaining([
        { code: 'unknown_ref', path: ['actors', 0, 'card', 'initialKnowledge', 0, 'about', 0], ref: 'nowhere' },
        { code: 'unknown_ref', path: ['actors', 0, 'card', 'initialKnowledge', 2, 'concerning'], ref: 'ghost' },
        { code: 'invalid_order', path: ['actors', 1, 'card', 'initialKnowledge', 0] },
        { code: 'unknown_ref', path: ['secrets', 0, 'subjects', 1], ref: 'phantom' },
        { code: 'unknown_ref', path: ['secrets', 0, 'knownBy', 0], ref: 'ghost' },
        { code: 'duplicate_id', path: ['secrets', 1, 'id'], ref: 'tripwire_secret' },
      ]),
    );
  });

  it('二阶认知不能指向自己', () => {
    const spec = warehouseSpec();
    spec.actors[0]!.card!.initialKnowledge![2]!.concerning = 'protagonist';
    expect(errorsOf(spec)).toContainEqual({ code: 'invalid_order', path: ['actors', 0, 'card', 'initialKnowledge', 2] });
  });

  it('初始认知最多五条', () => {
    const spec = warehouseSpec();
    spec.actors[0]!.card!.initialKnowledge = Array.from({ length: 6 }, (_, i) => ({ text: `第${i}条` }));
    expect(errorsOf(spec)).toContainEqual(
      expect.objectContaining({ code: 'schema', path: ['actors', 0, 'card', 'initialKnowledge'] }),
    );
  });

  it('检出悬空引用', () => {
    const spec = warehouseSpec();
    spec.actors[0]!.zone = 'roof';
    spec.items![0]!.location = { kind: 'actor', actor: 'ghost' };
    spec.exits = ['nowhere'];
    spec.rules!.consumption![0]!.counter = 'arrows';
    spec.mechanisms![0]!.exempt = ['ghost'];
    spec.rules!.requirements![0]!.onSuccess = { setFlag: 'undeclared', value: true };
    spec.rules!.requirements![0]!.target = 'mystery';
    spec.edges![3]!.requiresFlag = 'missing_flag';
    const errors = errorsOf(spec);
    expect(errors).toEqual(
      expect.arrayContaining([
        { code: 'unknown_ref', path: ['actors', 0, 'zone'], ref: 'roof' },
        { code: 'unknown_ref', path: ['items', 0, 'location', 'actor'], ref: 'ghost' },
        { code: 'unknown_ref', path: ['exits', 0], ref: 'nowhere' },
        { code: 'unknown_ref', path: ['rules', 'consumption', 0, 'counter'], ref: 'arrows' },
        { code: 'unknown_ref', path: ['mechanisms', 0, 'exempt', 0], ref: 'ghost' },
        { code: 'unknown_ref', path: ['rules', 'requirements', 0, 'onSuccess', 'setFlag'], ref: 'undeclared' },
        { code: 'unknown_ref', path: ['rules', 'requirements', 0, 'target'], ref: 'mystery' },
        { code: 'unknown_ref', path: ['edges', 3, 'requiresFlag'], ref: 'missing_flag' },
      ]),
    );
  });
});
