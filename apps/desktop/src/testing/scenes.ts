// 测试用的场景配置草稿：模型按 scene_draft 模板给出的扁平形式（SceneDraftOutput）。
import type { SceneDraftOutput } from '@fudiao/prompts';

/** 两个区域、两个角色、一件藏着的物品、一个秘密。 */
export const sceneDraftFixture = (): SceneDraftOutput => ({
  zones: [
    { id: 'shop', name: '当铺' },
    { id: 'yard', name: '后院' },
  ],
  edges: [{ a: 'shop', b: 'yard', adjacent: true, visible: false, sound: 1, requiresFlag: null }],
  flags: [],
  actors: [
    {
      id: 'lin_zhou',
      name: '林舟',
      zone: 'shop',
      injury: 'none',
      goal: '把玉当个好价钱',
      bottomLine: '不说出玉的来历',
      traits: ['好面子'],
      riskPreference: '',
      emotionThreshold: '',
      lossOfControl: '被当面质疑出身',
      speechStyle: '',
      knowledge: [{ text: '玉是父亲留下的', modality: 'observed', confidence: 1, about: ['jade'], concerning: null }],
    },
    {
      id: 'qian_si',
      name: '钱四',
      zone: 'shop',
      injury: 'none',
      goal: '把玉留在铺子里',
      bottomLine: '',
      traits: [],
      riskPreference: '',
      emotionThreshold: '',
      lossOfControl: '',
      speechStyle: '话少',
      knowledge: [{ text: '他多半不知道这玉的来历', modality: 'inferred', confidence: 0.7, about: ['jade'], concerning: 'lin_zhou' }],
    },
  ],
  items: [{ id: 'jade', name: '玉佩', holder: 'lin_zhou', zone: null, counters: [], reach: null, noise: null, concealed: true }],
  mechanisms: [],
  secrets: [{ id: 'origin', text: '玉佩是钱四师父的遗作', subjects: ['jade'], knownBy: ['qian_si'] }],
  exits: ['yard'],
  consumption: [],
  injuryLimits: [],
  requirements: [],
  contest: 'ruling',
  narrativeRules: ['当铺里不许动手'],
});
