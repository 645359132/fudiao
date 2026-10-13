// 金丝雀泄露测试的夹具：在每处私有信息中嵌入唯一标记。仅供测试使用。
import type { ActorId } from '../ids';
import type { SceneSpecInput } from '../scene/schema';
import type { Scene } from '../scene/validate';
import { sceneOf, warehouseSpec } from './warehouse';

export const CANARY = 'CANARY';

const cardCanaries = (id: string) => ({
  goal: `${CANARY}-CARD-${id}-goal`,
  bottomLine: `${CANARY}-CARD-${id}-bottomLine`,
  traits: [`${CANARY}-CARD-${id}-trait`],
  riskPreference: `${CANARY}-CARD-${id}-risk`,
  emotionThreshold: `${CANARY}-CARD-${id}-emotion`,
  lossOfControl: `${CANARY}-CARD-${id}-lossOfControl`,
  speechStyle: `${CANARY}-CARD-${id}-speech`,
});

/** 废仓库加巡夜人，所有私有文本都带有标记。返回场景配置（未校验的输入形式），供需要保存配置的测试使用。 */
export function canarySpec(): SceneSpecInput {
  const spec: SceneSpecInput = warehouseSpec();
  spec.meta = {
    title: `${CANARY}-META-title`,
    genre: `${CANARY}-META-genre`,
    questions: [`${CANARY}-META-question`],
  };
  spec.secrets = [
    { id: 'tripwire_secret', text: `${CANARY}-SECRET-tripwire`, subjects: ['tripwire', 'south_gate'], knownBy: ['antagonist'] },
  ];
  spec.actors.push({ id: 'watchman', name: '巡夜人', zone: 'center' });
  for (const a of spec.actors) {
    const knowledge = a.card?.initialKnowledge ?? [{ text: '今夜风大' }];
    a.card = {
      ...cardCanaries(a.id),
      initialKnowledge: knowledge.map((k, i) => ({ ...k, text: `${CANARY}-CARD-${a.id}-k${i} ${k.text}` })),
    };
  }
  for (const m of spec.mechanisms ?? []) m.name = `${CANARY}-MECH-${m.id}`;
  for (const i of spec.items ?? []) {
    if (i.id === 'letter' || i.id === 'ledger') i.name = `${CANARY}-ITEM-${i.id}`;
  }
  return spec;
}

export const canaryScene = (): Scene => sceneOf(canarySpec());

/** 任何时候都不得出现在 actor 视图中的标记：场景元信息、秘密、他人的角色卡。 */
export function staticForbidden(scene: Scene, actor: ActorId): string[] {
  return [
    `${CANARY}-META-`,
    `${CANARY}-SECRET-`,
    ...scene.actors.filter((a) => a.id !== actor).map((a) => `${CANARY}-CARD-${a.id}-`),
  ];
}
