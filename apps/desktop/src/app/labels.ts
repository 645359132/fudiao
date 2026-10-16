// 界面与 AI 助手共用的中文名称：设定种类与章节计划的状态。类型约束键名，存储层增加取值时这里漏不掉。
import type { SkillStage } from '@fudiao/shared';
import type { EntityKind, ForeshadowStatus, PlanStatus, RelationCategory } from '@fudiao/store';

export const ENTITY_KIND_LABEL: Readonly<Record<EntityKind, string>> = { character: '人物', location: '地点', organization: '组织', item: '物品', rule: '世界规则' };

export const PLAN_STATUS_LABEL: Readonly<Record<PlanStatus, string>> = { todo: '待写', writing: '写作中', written: '已写', reviewed: '已审核' };

/** 伏笔账本的状态（B63）。 */
export const FORESHADOW_STATUS_LABEL: Readonly<Record<ForeshadowStatus, string>> = { planned: '计划', planted: '已埋', paid_off: '已回收', dropped: '废弃' };

/** 写作技能用在哪个阶段（B75）。 */
export const SKILL_STAGE_LABEL: Readonly<Record<SkillStage, string>> = { planning: '规划', writing: '写章节' };
export const SKILL_STAGE_HINT: Readonly<Record<SkillStage, string>> = { planning: '生成作品骨架（大纲与人物）和章节计划时', writing: '写手写章节时' };

/** 人物关系的类别（B73）。 */
export const RELATION_CATEGORY_LABEL: Readonly<Record<RelationCategory, string>> = {
  family: '亲属',
  romance: '情感',
  mentor: '师承',
  ally: '友盟',
  rival: '竞争',
  enemy: '敌对',
  affiliation: '从属',
  other: '其他',
};
