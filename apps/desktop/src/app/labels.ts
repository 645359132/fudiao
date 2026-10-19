// 界面与 AI 助手共用的中文名称：设定种类、章节计划与推演的状态等。类型约束键名，存储层增加取值时这里漏不掉。
import type { SkillStage, WorkflowStepStatus } from '@fudiao/shared';
import type { RunState } from '@fudiao/writing';
import type { EntityKind, ForeshadowStatus, PlanStatus, RelationCategory, SimRun } from '@fudiao/store';

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

/** 推演的状态、结束与暂停的原因（B28）。结束与暂停的原因来自引擎的事件，没有收录的原样显示。 */
export const SIM_RUN_STATUS_LABEL: Readonly<Record<SimRun['status'], string>> = { created: '还没有开始', running: '进行中', awaiting_author: '等待作者', paused: '已暂停', ended: '已结束' };
export const SIM_END_LABEL: Readonly<Record<string, string>> = { max_rounds: '到达回合上限', actors_left: '角色都已离场', budget: '预算用完', author_stop: '作者停止', stalemate: '僵局' };
export const SIM_PAUSE_LABEL: Readonly<Record<string, string>> = {
  author: '作者暂停',
  proposal_invalid: '角色的行动多次不合规则',
  llm_error: '模型调用失败',
  refused: '模型拒绝了请求',
  truncated: '模型的输出被截断',
  invalid_output: '模型的输出格式不对',
  ruling_invalid: '裁决不合规则',
  stalemate: '僵局',
};

/** 写作工作流（B78）一次运行的状态。 */
export const WORKFLOW_STATE_LABEL: Readonly<Record<RunState, string>> = {
  ready: '可以开始',
  running: '进行中',
  waiting: '等你处理',
  failed: '出错',
  paused: '停在中途',
  done: '已完成',
  abandoned: '已放弃',
};

/** 写作工作流一步的状态。 */
export const WORKFLOW_STEP_STATUS_LABEL: Readonly<Record<WorkflowStepStatus, string>> = {
  pending: '待做',
  running: '进行中',
  awaiting_author: '等你处理',
  done: '已完成',
  failed: '出错',
  skipped: '已跳过',
  interrupted: '中断',
  stale: '可能过时',
};
