// 测试夹具：需求文档 I04 对战示例中的废仓库。仅供测试使用。
import type { ActorId, ItemId, ZoneId } from '../ids';
import { parseScene } from '../scene/validate';
import type { Scene } from '../scene/validate';
import type { SceneSpecInput } from '../scene/schema';

export const warehouseSpec = (): SceneSpecInput => ({
  zones: [
    { id: 'center', name: '仓库中央' },
    { id: 'shelves', name: '货架区' },
    { id: 'south_gate', name: '南门' },
    { id: 'office', name: '账房' },
  ],
  edges: [
    { between: ['center', 'shelves'], adjacent: true, visible: true, sound: 1 },
    { between: ['center', 'south_gate'], adjacent: true, visible: true, sound: 1 },
    { between: ['shelves', 'south_gate'], adjacent: false, visible: false, sound: 2 },
    {
      between: ['center', 'office'],
      adjacent: true,
      visible: false,
      sound: 2,
      requiresFlag: 'office_open',
    },
  ],
  actors: [
    { id: 'protagonist', name: '主角', zone: 'center', injury: 'light' },
    { id: 'antagonist', name: '对手', zone: 'south_gate' },
  ],
  items: [
    { id: 'letter', name: '密信', location: { kind: 'actor', actor: 'protagonist' } },
    { id: 'dagger', name: '短刀', location: { kind: 'actor', actor: 'protagonist' }, reach: 'melee' },
    {
      id: 'crossbow',
      name: '弩',
      location: { kind: 'actor', actor: 'antagonist' },
      counters: { bolts: 1 },
      reach: 'ranged',
    },
    { id: 'tiles', name: '碎瓦', location: { kind: 'zone', zone: 'shelves' }, use: { loudness: 5 } },
    { id: 'office_key', name: '账房钥匙', location: { kind: 'zone', zone: 'shelves' } },
    { id: 'ledger', name: '账本', location: { kind: 'zone', zone: 'office' } },
  ],
  mechanisms: [
    {
      id: 'tripwire',
      name: '南门绊索',
      zone: 'south_gate',
      trigger: 'enter',
      exempt: ['antagonist'],
      effect: { injury: 1, loudness: 3 },
    },
  ],
  flags: { office_open: false },
  exits: ['south_gate'],
  rules: {
    consumption: [
      { item: 'crossbow', counter: 'bolts', kinds: ['attack'], amount: 1, whenEmpty: 'fail' },
    ],
    injuryLimits: [{ actor: 'protagonist', atLeast: 'light', forbidItems: ['crossbow'] }],
    requirements: [
      {
        target: 'office',
        kinds: ['use_item', 'other'],
        requiresHolding: 'office_key',
        whenMissing: 'reject',
        onSuccess: { setFlag: 'office_open', value: true },
      },
    ],
    contests: { take: 'draw' },
  },
});

export function sceneOf(spec: SceneSpecInput): Scene {
  const parsed = parseScene(spec);
  if (!parsed.ok) throw new Error(`测试场景无效：${JSON.stringify(parsed.error)}`);
  return parsed.value;
}

export const warehouse = (edit?: (spec: SceneSpecInput) => void): Scene => {
  const spec = warehouseSpec();
  edit?.(spec);
  return sceneOf(spec);
};

// 测试中直接把字面量当作标识使用。
export const actor = (id: string): ActorId => id as ActorId;
export const zone = (id: string): ZoneId => id as ZoneId;
export const item = (id: string): ItemId => id as ItemId;
export const P = actor('protagonist');
export const A = actor('antagonist');
