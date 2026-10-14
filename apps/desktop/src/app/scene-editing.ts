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
