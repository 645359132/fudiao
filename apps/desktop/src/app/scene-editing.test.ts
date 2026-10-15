import { warehouseSpec } from '@fudiao/domain/testing';
import { describe, expect, it } from 'vitest';
import { blankSceneConfig, checkSceneConfig, parseSceneConfigText, removeZone, renameZone, setZoneEdge, zonePairs } from './scene-editing';

describe('场景配置的检查', () => {
  it('空白场景与测试场景没有问题', () => {
    expect(checkSceneConfig(blankSceneConfig())).toEqual([]);
    expect(checkSceneConfig(warehouseSpec())).toEqual([]);
  });

  it('用作者看得懂的话说明哪里不对：位置写成中文，引用的键原样给出', () => {
    const config = blankSceneConfig();
    config.actors.push({ id: 'actor_1', name: '角色二', zone: 'nowhere', card: { initialKnowledge: [{ text: '他以为我不知道', order: 1, concerning: 'actor_1' }] } });
    config.secrets = [{ id: 's1', text: '', subjects: ['ghost'] }];
    config.items = [{ id: 'letter', name: '信', location: { kind: 'actor', actor: 'nobody' } }];
    const problems = checkSceneConfig(config);
    expect(problems).toContain('秘密 第 1 项 › 内容：没有填写，或格式不对');
    // 结构通过之后才检查引用与重复。
    config.secrets = [{ id: 's1', text: '信是假的', subjects: ['ghost'] }];
    const next = checkSceneConfig(config);
    expect(next).toEqual(
      expect.arrayContaining([
        expect.stringContaining('键“actor_1”重复了'),
        '角色 第 2 项 › 所在区域：引用了场景里没有的“nowhere”',
        '秘密 第 1 项 › 涉及的对象 第 1 项：引用了场景里没有的“ghost”',
        '物品 第 1 项 › 位置 › 角色：引用了场景里没有的“nobody”',
      ]),
    );
    expect(next.some((p) => p.includes('一阶认知不能指向角色'))).toBe(true);
  });

  it('根本不是场景配置时也给出说明，而不是抛错', () => {
    expect(checkSceneConfig(null).length).toBeGreaterThan(0);
    expect(checkSceneConfig({ zones: [], actors: [] })).toEqual(expect.arrayContaining(['区域：没有填写，或格式不对', '角色：没有填写，或格式不对']));
  });
});

describe('“高级”里直接编辑的场景配置', () => {
  it('合法的配置原样读回；区域与角色不是数组时当作空的；不是对象或不是 JSON 时说明原因，不抛出异常', () => {
    const spec = warehouseSpec();
    expect(parseSceneConfigText(JSON.stringify(spec))).toEqual({ ok: true, value: spec });
    expect(parseSceneConfigText('{"zones": 3}')).toEqual({ ok: true, value: { zones: [], actors: [] } });
    expect(parseSceneConfigText('[1, 2]')).toEqual({ ok: false, error: '不是合法的 JSON：须是一个对象' });
    const broken = parseSceneConfigText('{"zones": [');
    expect(broken.ok).toBe(false);
    expect(broken.ok ? '' : broken.error).toMatch(/^不是合法的 JSON：/);
  });
});

describe('区域图的编辑（B41）', () => {
  const base = () => {
    const config = warehouseSpec();
    return { ...config, zones: [{ id: 'a', name: '甲' }, { id: 'b', name: '乙' }, { id: 'c', name: '丙' }], edges: [{ between: ['b', 'a'] as [string, string], adjacent: true, visible: false, sound: 1 }], actors: [{ id: 'x', name: '某人', zone: 'a' }], items: [{ id: 'i', name: '物', location: { kind: 'zone' as const, zone: 'a' } }], mechanisms: [], secrets: [], exits: ['a', 'c'], rules: {} };
  };

  it('列出区域两两之间的关系：配置过的带上内容（不分先后），没有配置的为空', () => {
    expect(zonePairs(base())).toEqual([
      { a: 'a', b: 'b', edge: { between: ['b', 'a'], adjacent: true, visible: false, sound: 1 } },
      { a: 'a', b: 'c', edge: null },
      { a: 'b', b: 'c', edge: null },
    ]);
  });

  it('修改关系：没有的新建，已有的原地改；什么都不通时去掉', () => {
    const added = setZoneEdge(base(), 'a', 'c', { visible: true });
    expect(added.edges).toEqual([
      { between: ['b', 'a'], adjacent: true, visible: false, sound: 1 },
      { between: ['a', 'c'], adjacent: false, visible: true, sound: null },
    ]);
    const changed = setZoneEdge(added, 'a', 'b', { sound: null, requiresFlag: ' door_open ' });
    expect(changed.edges?.[0]).toEqual({ between: ['b', 'a'], adjacent: true, visible: false, sound: null, requiresFlag: 'door_open' });
    // 清掉通行条件、取消相邻：这条关系什么都不通了。
    const cleared = setZoneEdge(setZoneEdge(changed, 'b', 'a', { requiresFlag: '' }), 'a', 'b', { adjacent: false });
    expect(cleared.edges).toEqual([{ between: ['a', 'c'], adjacent: false, visible: true, sound: null }]);
    expect(checkSceneConfig(cleared)).toEqual([]);
  });

  it('改区域的键：关系、角色与物品的位置、出口一并改过来', () => {
    const renamed = renameZone(base(), 'a', 'hall');
    expect(renamed.zones.map((z) => z.id)).toEqual(['hall', 'b', 'c']);
    expect(renamed.edges?.[0]?.between).toEqual(['b', 'hall']);
    expect(renamed.actors[0]?.zone).toBe('hall');
    expect(renamed.items?.[0]?.location).toEqual({ kind: 'zone', zone: 'hall' });
    expect(renamed.exits).toEqual(['hall', 'c']);
    expect(checkSceneConfig(renamed)).toEqual([]);
  });

  it('删除区域：它的关系与出口一并去掉；还在里面的角色由校验指出', () => {
    const removed = removeZone(base(), 'a');
    expect(removed.zones.map((z) => z.id)).toEqual(['b', 'c']);
    expect(removed.edges).toEqual([]);
    expect(removed.exits).toEqual(['c']);
    expect(checkSceneConfig(removed)).toEqual(expect.arrayContaining(['角色 第 1 项 › 所在区域：引用了场景里没有的“a”']));
  });
});
