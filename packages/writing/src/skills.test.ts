import { describe, expect, it } from 'vitest';
import { composeSkills, type BuiltinSkillText, type SkillSetting } from './skills';

const builtins: readonly BuiltinSkillText[] = [
  { key: 'foreshadow', name: '伏笔埋设与回收', description: '有伏笔时使用。', version: '1', stages: ['writing'], text: '埋伏笔时只写现象，不写解释。' },
  { key: 'pacing', name: '详略与节奏', description: '每一章都用。', version: '2', stages: ['writing'], text: '改变局面的时刻展开，过场略写。' },
  { key: 'cliffhanger', name: '章末钩子', description: '写结尾时使用。', version: '1', stages: ['writing'], text: '结尾停在一个未解的问题上。' },
];

const setting = (key: string, over: Partial<SkillSetting> = {}): SkillSetting => ({
  key,
  name: key,
  description: '',
  enabled: true,
  instruction: '',
  builtinVersion: '1',
  stages: ['writing'],
  ...over,
});

describe('写作技能的组合', () => {
  it('按内置技能的顺序取启用的技能，作者改过的说明代替模板文字', () => {
    const composed = composeSkills(
      [setting('cliffhanger', { instruction: '停在悬念上，不要总结。' }), setting('pacing', { enabled: false }), setting('foreshadow')],
      builtins,
      'writing',
    );
    expect(composed.map((s) => [s.key, s.text])).toEqual([
      ['foreshadow', '埋伏笔时只写现象，不写解释。'],
      ['cliffhanger', '停在悬念上，不要总结。'],
    ]);
  });

  it('带上适用说明：内置技能用模板里的，自定义技能用作者写的', () => {
    const composed = composeSkills([setting('foreshadow'), setting('mine', { builtinVersion: null, description: ' 写对话时使用。 ', instruction: '少用成语。' })], builtins, 'writing');
    expect(composed.map((s) => [s.key, s.description])).toEqual([
      ['foreshadow', '有伏笔时使用。'],
      ['mine', '写对话时使用。'],
    ]);
  });

  it('作者自定义的技能排在内置技能之后，按作品中的顺序', () => {
    const composed = composeSkills(
      [setting('mine2', { builtinVersion: null, name: '对话', instruction: '对话三句内要有动作。' }), setting('foreshadow'), setting('mine1', { builtinVersion: null, instruction: '少用成语。' })],
      builtins,
      'writing',
    );
    expect(composed.map((s) => s.key)).toEqual(['foreshadow', 'mine2', 'mine1']);
  });

  it('记下每项技能的来源与版本，供调用记录核对；作者改过的内置技能标为已修改', () => {
    const composed = composeSkills([setting('foreshadow'), setting('pacing', { instruction: '多写对话。' }), setting('mine', { builtinVersion: null, instruction: '少用成语。' })], builtins, 'writing');
    expect(composed.map((s) => [s.key, s.origin])).toEqual([
      ['foreshadow', 'builtin:1'],
      ['pacing', 'builtin:2:modified'],
      ['mine', 'custom'],
    ]);
  });

  it('作品中有、但已不再内置的技能跳过；没有登记的内置技能不启用', () => {
    expect(composeSkills([setting('retired')], builtins, 'writing')).toEqual([]);
  });

  it('按阶段取技能（B75）：内置技能看模板的阶段，自定义技能看作者设的阶段；两个阶段都有的两处都带上', () => {
    const withPlanning: readonly BuiltinSkillText[] = [...builtins, { key: 'snowflake', name: '雪花写作法', description: '规划时使用。', version: '1', stages: ['planning'], text: '先写一句话。' }];
    const settings = [
      setting('foreshadow'),
      // 作品库里的阶段与模板不一致时（还没同步），内置技能以模板为准。
      setting('snowflake', { stages: ['writing'] }),
      setting('prefs', { builtinVersion: null, instruction: '不要三角恋。', stages: ['planning', 'writing'] }),
      setting('arc', { builtinVersion: null, instruction: '按三幕排。', stages: ['planning'] }),
    ];
    expect(composeSkills(settings, withPlanning, 'planning').map((s) => s.key)).toEqual(['snowflake', 'prefs', 'arc']);
    expect(composeSkills(settings, withPlanning, 'writing').map((s) => s.key)).toEqual(['foreshadow', 'prefs']);
  });
});
