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

/** 人物关系的类别（与存储层的取值相同）。 */
export const RELATION_KINDS_FOR_ASSISTANT = ['family', 'romance', 'mentor', 'ally', 'rival', 'enemy', 'affiliation', 'other'] as const;

export const AssistantAction = z.discriminatedUnion('tool', [
  // 读取
  z.object({ tool: z.literal('list_chapters'), volume: opt }),
  z.object({ tool: z.literal('read_chapter'), chapter: text }),
  z.object({ tool: z.literal('search_text'), query: text }),
  z.object({ tool: z.literal('get_entity'), entity: text }),
  z.object({ tool: z.literal('list_facts'), about: opt }),
  z.object({ tool: z.literal('get_chapter_plan'), chapter: text }),
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
  // 计划与写作
  z.object({ tool: z.literal('save_chapter_plan'), chapter: text, goal: text, beats: z.array(z.string()), cast: list, targetWords: z.number().int().positive().nullable() }),
  z.object({ tool: z.literal('plan_chapters'), count: z.number().int().positive(), wordsPerChapter: z.number().int().positive().nullable() }),
  z.object({ tool: z.literal('write_chapter'), chapter: text }),
  z.object({ tool: z.literal('write_chapters'), chapters: list, review: z.boolean() }),
  z.object({ tool: z.literal('continue_chapter'), chapter: text, instruction: opt }),
  z.object({ tool: z.literal('edit_selection'), operation: z.enum(SELECTION_EDITS), instruction: opt }),
  z.object({ tool: z.literal('review_chapter'), chapter: text }),
  z.object({ tool: z.literal('review_chapters'), chapters: list }),
  z.object({ tool: z.literal('rollback_writer'), chapter: text }),
  z.object({ tool: z.literal('add_foreshadow'), title: text, content: text, reveal: opt, plant: opt, payoff: opt }),
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
