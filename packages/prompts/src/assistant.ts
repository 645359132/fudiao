// AI 助手（需求 B69，施工文档 M5-01）：每一步模型输出一个对象——给作者看的话、要执行的动作与是否完成。
// 动作是可辨识联合（以 tool 区分），各参数在 Zod 中校验；工具的说明写在模板 partials/assistant_tools.md，
// 两边由测试核对一致。可选的参数一律可为 null（严格的结构化输出要求每个字段都出现）。
import { z } from 'zod';

const text = z.string();
const opt = z.string().nullable();
const list = z.array(z.string()).nullable();

export const ENTITY_KINDS_FOR_ASSISTANT = ['character', 'location', 'organization', 'item', 'rule'] as const;

/** 助手对作者选中的文字可做的修改（选区操作中除续写以外的四种）。 */
export const SELECTION_EDITS = ['rewrite', 'expand', 'shorten', 'polish'] as const;

/** 助手可以打开的页面。 */
export const ASSISTANT_PAGES = ['book', 'planning', 'settings', 'relations', 'facts', 'simulation', 'search', 'skills', 'usage', 'tasks'] as const;

/** 助手可以发起的写作工作流（与应用层工作流命令表的键相同，由类型检查核对）。 */
export const ASSISTANT_WORKFLOWS = ['quick_book', 'book_audit', 'next_volume', 'opening_polish', 'cast_completion'] as const;

/** 人物关系的类别（与存储层的取值相同）。 */
export const RELATION_KINDS_FOR_ASSISTANT = ['family', 'romance', 'mentor', 'ally', 'rival', 'enemy', 'affiliation', 'other'] as const;

/** 伏笔账本的状态（与存储层的取值相同）。 */
export const FORESHADOW_STATUSES_FOR_ASSISTANT = ['planned', 'planted', 'paid_off', 'dropped'] as const;

export const AssistantAction = z.discriminatedUnion('tool', [
  // 读取
  z.object({ tool: z.literal('list_chapters'), volume: opt }),
  z.object({ tool: z.literal('get_work') }),
  z.object({ tool: z.literal('read_chapter'), chapter: text }),
  z.object({ tool: z.literal('search_text'), query: text }),
  z.object({ tool: z.literal('get_entity'), entity: text }),
  z.object({ tool: z.literal('list_facts'), about: opt }),
  z.object({ tool: z.literal('get_chapter_plan'), chapter: text }),
  z.object({ tool: z.literal('build_chapter_memory'), chapter: text }),
  z.object({ tool: z.literal('get_chapter_memory'), chapter: text }),
  z.object({ tool: z.literal('list_foreshadows'), chapter: opt }),
  z.object({ tool: z.literal('list_review_issues'), chapter: opt }),
  z.object({ tool: z.literal('list_skills'), stage: z.enum(['planning', 'writing']).nullable() }),
  // 联网（B84）
  z.object({ tool: z.literal('web_search'), query: text }),
  z.object({ tool: z.literal('read_web_page'), url: text }),
  // 作品
  z.object({ tool: z.literal('create_work'), title: text, genre: opt, synopsis: opt, outline: opt }),
  z.object({ tool: z.literal('open_work'), work: text }),
  z.object({ tool: z.literal('update_work'), title: opt, genre: opt, synopsis: opt, outline: opt }),
  // 卷
  z.object({ tool: z.literal('create_volume'), title: text, summary: opt, after: opt }),
  z.object({ tool: z.literal('update_volume'), volume: text, title: opt, summary: opt }),
  z.object({ tool: z.literal('move_volume'), volume: text, after: opt }),
  z.object({ tool: z.literal('delete_volume'), volume: text }),
  // 章节
  z.object({ tool: z.literal('create_chapter'), title: text, volume: opt, after: opt }),
  z.object({ tool: z.literal('update_chapter'), chapter: text, title: opt, summary: opt, notes: opt }),
  z.object({ tool: z.literal('move_chapter'), chapter: text, volume: opt, after: opt }),
  z.object({ tool: z.literal('trash_chapter'), chapter: text }),
  z.object({ tool: z.literal('open_chapter'), chapter: text }),
  z.object({ tool: z.literal('restore_chapter'), chapter: text }),
  z.object({ tool: z.literal('save_snapshot'), chapter: text }),
  // 设定（人物卡片、地点、组织、物品、世界规则）
  z.object({ tool: z.literal('create_entity'), kind: z.enum(ENTITY_KINDS_FOR_ASSISTANT), name: text, description: opt, aliases: list }),
  z.object({ tool: z.literal('update_entity'), entity: text, name: opt, description: opt, aliases: list }),
  z.object({ tool: z.literal('delete_entity'), entity: text }),
  z.object({ tool: z.literal('add_fact'), kind: z.enum(['world', 'belief']), content: text, holder: opt, subjects: list }),
  // 人物关系
  z.object({
    tool: z.literal('add_relationship'),
    from: text,
    to: text,
    category: z.enum(RELATION_KINDS_FOR_ASSISTANT),
    label: text,
    mutual: z.boolean(),
    description: opt,
    secret: z.boolean(),
    validFrom: opt,
    validTo: opt,
  }),
  z.object({
    tool: z.literal('update_relationship'),
    relationship: text,
    category: z.enum(RELATION_KINDS_FOR_ASSISTANT).nullable(),
    label: opt,
    mutual: z.boolean().nullable(),
    description: opt,
    secret: z.boolean().nullable(),
    validFrom: opt,
    validTo: opt,
  }),
  z.object({ tool: z.literal('delete_relationship'), relationship: text }),
  // 作者偏好
  z.object({ tool: z.literal('remember_preference'), preference: text }),
  z.object({ tool: z.literal('add_avoid_phrases'), phrases: z.array(z.string()) }),
  z.object({ tool: z.literal('set_skill'), skill: text, enabled: z.boolean() }),
  // 计划与写作
  z.object({ tool: z.literal('save_chapter_plan'), chapter: text, goal: text, beats: z.array(z.string()), cast: list, targetWords: z.number().int().positive().nullable() }),
  z.object({ tool: z.literal('plan_chapters'), count: z.number().int().positive(), wordsPerChapter: z.number().int().positive().nullable() }),
  z.object({ tool: z.literal('write_chapter'), chapter: text }),
  z.object({ tool: z.literal('write_chapters'), chapters: list, review: z.boolean() }),
  z.object({ tool: z.literal('continue_chapter'), chapter: text, instruction: opt }),
  z.object({ tool: z.literal('edit_selection'), operation: z.enum(SELECTION_EDITS), instruction: opt }),
  z.object({ tool: z.literal('review_chapter'), chapter: text }),
  z.object({ tool: z.literal('review_chapters'), chapters: list }),
  z.object({ tool: z.literal('stop_background'), what: z.enum(['writing', 'review', 'simulation', 'workflow', 'all']) }),
  z.object({ tool: z.literal('resolve_review_issue'), issue: text, status: z.enum(['fixed', 'ignored']) }),
  z.object({ tool: z.literal('revise_review_issue'), issue: text }),
  z.object({ tool: z.literal('rollback_writer'), chapter: text }),
  z.object({ tool: z.literal('add_foreshadow'), title: text, content: text, reveal: opt, plant: opt, payoff: opt }),
  z.object({
    tool: z.literal('update_foreshadow'),
    foreshadow: text,
    title: opt,
    content: opt,
    reveal: opt,
    plant: opt,
    payoff: opt,
    status: z.enum(FORESHADOW_STATUSES_FOR_ASSISTANT).nullable(),
  }),
  // 角色推演：建场景、在后台推演、看全局概要、按视角写成候选稿；待核实的裁决与采纳由作者在界面上做
  z.object({ tool: z.literal('list_simulations'), scene: opt }),
  z.object({ tool: z.literal('create_sim_scene'), description: text, title: opt, chapter: opt, maxRounds: z.number().int().positive().nullable() }),
  z.object({ tool: z.literal('start_simulation'), scene: text, budgetUsd: z.number().positive().nullable() }),
  z.object({ tool: z.literal('continue_simulation'), run: text }),
  z.object({ tool: z.literal('get_simulation'), run: text }),
  z.object({ tool: z.literal('narrate_simulation'), run: text, pov: text, chapter: text, fromRound: z.number().int().positive().nullable(), toRound: z.number().int().positive().nullable() }),
  // 写作工作流：按固定的步骤依次做，在后台推进，每步的结果作者可以看、改、采用
  z.object({ tool: z.literal('list_workflows') }),
  z.object({
    tool: z.literal('start_workflow'),
    workflow: z.enum(ASSISTANT_WORKFLOWS),
    mode: z.enum(['step', 'auto']),
    budgetUsd: z.number().positive().nullable(),
    idea: opt,
    genre: opt,
    chapters: z.number().int().positive().nullable(),
    wordsPerChapter: z.number().int().positive().nullable(),
    /** 一键成书的卷数：null 按故事自动分，1 不分卷，2 以上为指定卷数。 */
    volumes: z.number().int().positive().nullable(),
    from: opt,
    to: opt,
    rereview: z.boolean().nullable(),
    instruction: opt,
  }),
  z.object({ tool: z.literal('get_workflow'), run: opt }),
  z.object({ tool: z.literal('continue_workflow'), run: text, adopt: z.boolean() }),
  // 撤销
  z.object({ tool: z.literal('undo_last_turn') }),
  // 导出
  z.object({ tool: z.literal('export_book'), format: z.enum(['txt', 'markdown']), chapter: opt }),
  // 界面
  z.object({ tool: z.literal('open_page'), page: z.enum(ASSISTANT_PAGES) }),
]);
export type AssistantAction = z.infer<typeof AssistantAction>;
export type AssistantTool = AssistantAction['tool'];

/** 全部工具名，按模板中的顺序。 */
export const ASSISTANT_TOOLS: readonly AssistantTool[] = AssistantAction.options.map((o) => o.shape.tool.value);

/** 一步的输出：message 是给作者看的话（可以为空），actions 按顺序执行；done 为真表示这次请求已经办完，不再继续。 */
export const AssistantTurnOutput = z.object({
  message: z.string(),
  actions: z.array(AssistantAction),
  done: z.boolean(),
});
export type AssistantTurnOutput = z.infer<typeof AssistantTurnOutput>;
