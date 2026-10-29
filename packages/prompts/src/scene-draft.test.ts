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

describe('模型省掉或改名的字段（作者反馈 2026-10-29：Gemini 的输出连续三次不合格）', () => {
  it('知识条目的 text 写成 content 或 fact、about 与 concerning 省掉、各列表与可空字段省掉：本地解析按默认值补上，内容为空的条目丢弃', () => {
    const loose = {
      zones: [{ id: 'a', name: '甲' }],
      actors: [{ id: 'x', name: '某', zone: 'a', knowledge: [{ content: '他知道的事', modality: 'heard', confidence: 0.5 }, { text: '' }, { fact: '另一件事' }] }],
    };
    const parsed = SceneDraftOutput.parse(loose);
    expect(parsed.actors[0]?.knowledge).toEqual([
      { text: '他知道的事', modality: 'heard', confidence: 0.5, about: [], concerning: null },
      { text: '', modality: 'observed', confidence: 1, about: [], concerning: null },
      { text: '另一件事', modality: 'observed', confidence: 1, about: [], concerning: null },
    ]);
    expect(parsed).toMatchObject({ edges: [], flags: [], items: [], mechanisms: [], secrets: [], exits: [], contest: 'ruling', narrativeRules: [] });
    expect(parsed.actors[0]).toMatchObject({ injury: 'none', goal: '', traits: [] });
    const spec = sceneDraftToSpec(parsed);
    expect(spec.actors[0]?.card?.initialKnowledge?.map((k) => k.text)).toEqual(['他知道的事', '另一件事']);
    expect(parseScene(spec).ok).toBe(true);
    // 写全的输出照常；confidence 仍在本地校验。
    expect(SceneDraftOutput.safeParse(draft()).success).toBe(true);
    expect(SceneDraftOutput.safeParse({ ...loose, actors: [{ ...loose.actors[0], knowledge: [{ text: 'x', confidence: 2 }] }] }).success).toBe(false);
  });
});
