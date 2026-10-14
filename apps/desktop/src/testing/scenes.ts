// 推演相关测试共用的夹具：模型按 scene_draft 模板给出的场景配置草稿，以及测试模型在废仓库场景里的行为。
import { waitProposal, type Policy } from '@fudiao/engine/testing';
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

// 覆盖各个阶段的行为：第一回合反派出手（需要裁决），主角喊话并提出推测（证据链判断），之后观察与防守。
export const dramaPolicy: Policy = {
  character_action: (ctx) => {
    if (ctx.subject === 'antagonist') {
      return ctx.round === 1 ? waitProposal({ kind: 'attack', target: 'protagonist', item: 'crossbow' }) : waitProposal({ kind: 'defend' });
    }
    return waitProposal({
      kind: ctx.round === 2 ? 'observe' : 'speak',
      ...(ctx.round !== 2 && { utterance: { sentences: ['你到底想要什么？'], volume: 'shout' as const } }),
      inferences: [{ content: '南门恐怕有埋伏', about: ['south_gate'], confidence: 0.5, concerning: null }],
    });
  },
  semantic_ruling: () => ({
    rationale: '弩箭擦过',
    effects: [{ type: 'setInjury', actor: 'protagonist', level: 'severe' }],
    occurrences: [{ participants: ['antagonist', 'protagonist'], zones: ['center'], visible: true, loudness: 2, visual: '弩箭擦过主角肩头', sound: null }],
    uncertainties: [],
  }),
  judgement: (ctx) => ({
    judgements: [...ctx.text.matchAll(/推测 \[([^\]]+)\] 对照秘密 \[([^\]]+)\]/g)].map((m) => ({ inference: m[1] ?? '', secret: m[2] ?? '', hit: true, supported: false, explanation: '没有线索' })),
  }),
};
