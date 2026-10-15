// 界面与 AI 助手共用的中文名称：设定种类与章节计划的状态。类型约束键名，存储层增加取值时这里漏不掉。
import type { EntityKind, PlanStatus, RelationCategory } from '@fudiao/store';

export const ENTITY_KIND_LABEL: Readonly<Record<EntityKind, string>> = { character: '人物', location: '地点', organization: '组织', item: '物品', rule: '世界规则' };

export const PLAN_STATUS_LABEL: Readonly<Record<PlanStatus, string>> = { todo: '待写', writing: '写作中', written: '已写', reviewed: '已审核' };

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
