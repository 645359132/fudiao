// 写手与审核的纯函数使用的数据形状。应用服务层把仓储的记录转成这些形状，本包不依赖仓储与模型调用。

export type ForeshadowStatus = 'planned' | 'planted' | 'paid_off' | 'dropped';

export type ForeshadowItem = {
  readonly id: string;
  readonly title: string;
  /** 揭晓的内容：计划回收之前不得说破。 */
  readonly reveal: string;
  readonly plantChapterId: string | null;
  readonly payoffChapterId: string | null;
  readonly status: ForeshadowStatus;
};

export type PlanItem = {
  readonly chapterId: string;
  readonly castIds: readonly string[];
  readonly foreshadowPlant: readonly string[];
  readonly foreshadowPayoff: readonly string[];
  readonly status: 'todo' | 'writing' | 'written' | 'reviewed';
};

/** 章节在书中的顺序（回收站以外的章节，从 0 起）。 */
export type ChapterOrder = ReadonlyMap<string, number>;

export type ParagraphText = { readonly id: string; readonly version: number; readonly text: string };

export type CastMember = { readonly id: string; readonly name: string; readonly aliases: readonly string[] };

export type IssueKind = 'setting_conflict' | 'timeline' | 'pov_leak' | 'foreshadow' | 'character' | 'off_plan' | 'pacing' | 'ai_tone';

export type IssueAnchor = {
  readonly paragraphId: string;
  readonly paragraphVersion: number;
  readonly start: number;
  readonly end: number;
  /** 段内引文；针对整章的问题（如伏笔到期未回收）为空，锚在相关段落上。 */
  readonly quote: string;
};

export type IssueEvidence = { readonly type: 'entity' | 'fact' | 'foreshadow' | 'paragraph' | 'plan'; readonly id: string };

/** 程序检查出的审核问题（source 为 program），由应用服务层写入审核问题表。 */
export type ProgramIssue = {
  readonly kind: IssueKind;
  readonly severity: 'high' | 'medium' | 'low';
  readonly anchor: IssueAnchor;
  readonly evidence: readonly IssueEvidence[];
  readonly description: string;
  readonly suggestion: string;
};
