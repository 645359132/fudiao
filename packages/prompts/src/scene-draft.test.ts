import { parseScene } from '@fudiao/domain';
import { describe, expect, it } from 'vitest';
import { sceneDraftToSpec } from './scene-draft';
import { SceneDraftOutput } from './schemas';

const draft = (): SceneDraftOutput => ({
  zones: [
    { id: 'counter', name: '柜台' },
    { id: 'back_room', name: '后堂' },
  ],
  edges: [{ a: 'counter', b: 'back_room', adjacent: true, visible: false, sound: 1, requiresFlag: null }],
  flags: [],
  actors: [
    {
      id: 'clerk',
      name: '掌柜',
      zone: 'counter',
      injury: 'none',
      goal: '压价收下玉佩',
      bottomLine: '不收来路不明的东西',
      traits: ['精明'],
      riskPreference: '',
      emotionThreshold: '',
      lossOfControl: '',
      speechStyle: '慢条斯理',
      knowledge: [{ text: '书生的玉佩成色极好', modality: 'observed', confidence: 1, about: ['jade'], concerning: null }],
    },
    {
      id: 'scholar',
      name: '书生',
      zone: 'counter',
      injury: 'none',
      goal: '凑够盘缠',
      bottomLine: '不卖祖传之物以外的东西',
      traits: [],
      riskPreference: '',
      emotionThreshold: '',
      lossOfControl: '被当面质疑出身时会失去冷静',
      speechStyle: '',
      knowledge: [{ text: '掌柜以为我不懂行', modality: 'inferred', confidence: 0.6, about: ['clerk'], concerning: 'clerk' }],
    },
  ],
  items: [
    { id: 'jade', name: '玉佩', holder: 'scholar', zone: null, counters: [], reach: null, noise: null, concealed: false },
    { id: 'silver', name: '钱袋', holder: 'clerk', zone: null, counters: [{ name: 'taels', value: 30 }], reach: null, noise: null, concealed: true },
  ],
  mechanisms: [],
  secrets: [{ id: 'stolen', text: '玉佩其实是偷来的', subjects: ['jade'], knownBy: ['scholar'] }],
  exits: ['counter'],
  consumption: [],
  injuryLimits: [],
  requirements: [],
  contest: 'ruling',
  narrativeRules: ['当铺打烊前必须成交或离开'],
});

describe('场景配置草稿', () => {
  it('转换后通过场景校验', () => {
    expect(SceneDraftOutput.safeParse(draft()).success).toBe(true);
    const result = parseScene(sceneDraftToSpec(draft()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const scholar = result.value.actors.find((a) => a.id === 'scholar');
    expect(scholar?.card.initialKnowledge[0]).toMatchObject({ order: 2, concerning: 'clerk', modality: 'inferred' });
    expect(scholar?.card.speechStyle).toBeUndefined();
    expect(result.value.rules.narrativeRules).toEqual(['当铺打烊前必须成交或离开']);
  });

  it('草稿中的错误由场景校验指出', () => {
    const bad = draft();
    bad.items[0] = { ...bad.items[0]!, holder: null, zone: null };
    const result = parseScene(sceneDraftToSpec(bad));
    expect(result.ok).toBe(false);
  });
});
