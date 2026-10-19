// 写作工作流（需求 B78）的步骤状态与运行模式：作品库（packages/store）与步骤状态机（packages/writing）共用这些取值。

/**
 * 步骤的状态：待做、进行中、等作者（草稿等作者看、改、采用，或等作者确认、动手）、已完成、出错、已跳过、
 * 中断（应用关闭或被停下时没有做完）、可能过时（它前面的步骤重做或撤回过）。
 */
export const WORKFLOW_STEP_STATUSES = ['pending', 'running', 'awaiting_author', 'done', 'failed', 'skipped', 'interrupted', 'stale'] as const;
export type WorkflowStepStatus = (typeof WORKFLOW_STEP_STATUSES)[number];

/** 运行模式：step 每步停下给作者看；auto 一路做完（草稿直接采用，会覆盖作品内容与须作者动手的步骤仍停下）。 */
export const WORKFLOW_MODES = ['step', 'auto'] as const;
export type WorkflowMode = (typeof WORKFLOW_MODES)[number];
