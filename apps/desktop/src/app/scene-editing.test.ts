import { warehouseSpec } from '@fudiao/domain/testing';
import { describe, expect, it } from 'vitest';
import { blankSceneConfig, checkSceneConfig } from './scene-editing';

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
