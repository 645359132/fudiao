// 推演场景的编辑辅助（需求 B22、B23、B39，施工文档 M4-02）：空白场景、校验结果的说明。
// 校验本身在领域内核（parseScene）；这里只把出错的位置与原因写成作者看得懂的话。
import { parseScene, type SceneError, type SceneSpecInput } from '@fudiao/domain';

/** 从空白开始时的场景：一个区域、一个角色，作者在此基础上修改。 */
export function blankSceneConfig(): SceneSpecInput {
  return {
    zones: [{ id: 'room', name: '场地' }],
    edges: [],
    actors: [{ id: 'actor_1', name: '角色一', zone: 'room', card: { traits: [], initialKnowledge: [] } }],
    items: [],
    secrets: [],
    rules: { narrativeRules: [] },
  };
}

const SECTION: Readonly<Record<string, string>> = {
  meta: '场景信息',
  zones: '区域',
  edges: '区域之间的关系',
  actors: '角色',
  items: '物品',
  mechanisms: '机关',
  secrets: '秘密',
  flags: '标记',
  exits: '出口',
  clock: '场景时钟',
  rules: '规则',
  loudness: '响度表',
};

const FIELD: Readonly<Record<string, string>> = {
  id: '键',
  name: '名字',
  zone: '所在区域',
  injury: '伤势',
  card: '角色卡',
  initialKnowledge: '初始认知',
  text: '内容',
  about: '涉及的对象',
  concerning: '指向的角色',
  order: '认知的阶数',
  confidence: '相信程度',
  subjects: '涉及的对象',
  knownBy: '知情的角色',
  location: '位置',
  actor: '角色',
  between: '两端的区域',
  sound: '声音衰减',
  requiresFlag: '通行所需的标记',
  exempt: '不受影响的角色',
  consumption: '消耗规则',
  injuryLimits: '伤势限制',
  requirements: '前提条件',
  narrativeRules: '叙述规则',
  item: '物品',
  target: '目标',
  requiresHolding: '须持有的物品',
  forbidItems: '禁用的物品',
  fromRound: '起始回合',
  label: '时辰',
};

/** 路径写成“角色 第 2 个 › 角色卡 › 初始认知 第 1 条 › 指向的角色”。 */
function describePath(path: readonly (string | number)[]): string {
  const parts: string[] = [];
  for (const [i, part] of path.entries()) {
    if (typeof part === 'number') {
      const last = parts.pop() ?? '';
      parts.push(`${last} 第 ${part + 1} 项`);
    } else {
      parts.push((i === 0 ? SECTION[part] : FIELD[part]) ?? part);
    }
  }
  return parts.join(' › ');
}

function describeProblem(error: SceneError): string {
  const where = describePath(error.path);
  const ref = error.ref === undefined ? '' : `“${error.ref}”`;
  switch (error.code) {
    case 'schema':
      return `${where}：没有填写，或格式不对`;
    case 'duplicate_id':
      return `${where}：键${ref}重复了，同一个场景里每个键只能用一次`;
    case 'unknown_ref':
      return `${where}：引用了场景里没有的${ref}`;
    case 'self_loop':
      return `${where}：区域不能与自己相连`;
    case 'duplicate_edge':
      return `${where}：这两个区域之间已经有一条关系了`;
    case 'invalid_order':
      return `${where}：一阶认知不能指向角色，二阶认知必须指向另一个角色；场景时钟须按回合递增`;
  }
}

export function describeSceneProblems(errors: readonly SceneError[]): string[] {
  return [...new Set(errors.map(describeProblem))];
}

/** 场景配置里不对的地方；没有问题时为空。 */
export function checkSceneConfig(config: unknown): string[] {
  const parsed = parseScene(config);
  return parsed.ok ? [] : describeSceneProblems(parsed.error);
}

type Edge = NonNullable<SceneSpecInput['edges']>[number];

/** 区域两两之间的关系（需求 B41）；没有配置的一对，edge 为 null：不相邻、互相看不见、声音传不过去。 */
export type ZonePair = { readonly a: string; readonly b: string; readonly edge: Edge | null };

const sameEdge = (e: Edge, a: string, b: string) => (e.between[0] === a && e.between[1] === b) || (e.between[0] === b && e.between[1] === a);

export function zonePairs(config: SceneSpecInput): ZonePair[] {
  const pairs: ZonePair[] = [];
  for (const [i, a] of config.zones.entries()) {
    for (const b of config.zones.slice(i + 1)) pairs.push({ a: a.id, b: b.id, edge: (config.edges ?? []).find((e) => sameEdge(e, a.id, b.id)) ?? null });
  }
  return pairs;
}

export type EdgePatch = { readonly adjacent?: boolean; readonly visible?: boolean; readonly sound?: number | null; readonly requiresFlag?: string };

/** 修改两个区域之间的关系。什么都不通（不相邻、看不见、声音传不过去、没有通行条件）时去掉这条关系。 */
export function setZoneEdge(config: SceneSpecInput, a: string, b: string, patch: EdgePatch): SceneSpecInput {
  const edges = config.edges ?? [];
  const current = edges.find((e) => sameEdge(e, a, b));
  const { requiresFlag: _old, ...base } = current ?? { between: [a, b] as [string, string], adjacent: false, visible: false, sound: null };
  const flag = (patch.requiresFlag ?? current?.requiresFlag ?? '').trim();
  const next: Edge = { ...base, ...(patch.adjacent !== undefined && { adjacent: patch.adjacent }), ...(patch.visible !== undefined && { visible: patch.visible }), ...(patch.sound !== undefined && { sound: patch.sound }), ...(flag !== '' && { requiresFlag: flag }) };
  const empty = !next.adjacent && !next.visible && next.sound === null && next.requiresFlag === undefined;
  const others = edges.filter((e) => !sameEdge(e, a, b));
  return { ...config, edges: empty ? others : current === undefined ? [...others, next] : edges.map((e) => (sameEdge(e, a, b) ? next : e)) };
}

/** 改区域的键，并把引用它的地方一并改过来：区域关系、角色与物品的位置、机关、出口。 */
export function renameZone(config: SceneSpecInput, from: string, to: string): SceneSpecInput {
  const zones = config.zones.map((z) => (z.id === from ? { ...z, id: to } : z));
  const swap = (id: string) => (id === from ? to : id);
  return {
    ...config,
    zones,
    ...(config.edges !== undefined && { edges: config.edges.map((e) => ({ ...e, between: [swap(e.between[0]), swap(e.between[1])] as [string, string] })) }),
    actors: config.actors.map((a) => ({ ...a, zone: swap(a.zone) })),
    ...(config.items !== undefined && { items: config.items.map((i) => (i.location.kind === 'zone' ? { ...i, location: { kind: 'zone' as const, zone: swap(i.location.zone) } } : i)) }),
    ...(config.mechanisms !== undefined && { mechanisms: config.mechanisms.map((m) => ({ ...m, zone: swap(m.zone) })) }),
    ...(config.exits !== undefined && { exits: config.exits.map(swap) }),
  };
}

/** 删除一个区域，连同它的关系与出口。还在这个区域里的角色、物品与机关不动，由校验提示作者改到别处。 */
export function removeZone(config: SceneSpecInput, id: string): SceneSpecInput {
  return {
    ...config,
    zones: config.zones.filter((z) => z.id !== id),
    ...(config.edges !== undefined && { edges: config.edges.filter((e) => !e.between.includes(id)) }),
    ...(config.exits !== undefined && { exits: config.exits.filter((x) => x !== id) }),
  };
}
