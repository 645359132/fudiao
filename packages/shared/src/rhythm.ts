// 一章的节奏目标（需求 B87，M8-01）：章节计划里的章节类型、对话多少与章尾方式。写手按它写，审核按它量，章节计划草稿按它排布
// （章名长短、字数轻重、过渡章与章尾收法轮换），免得整本书每章一个样子。

export const CHAPTER_TYPES = ['battle', 'confrontation', 'dialogue', 'transition', 'daily', 'travel', 'reveal', 'climax', 'other'] as const;
export type ChapterType = (typeof CHAPTER_TYPES)[number];

export const DIALOGUE_LEVELS = ['low', 'mid', 'high'] as const;
export type DialogueLevel = (typeof DIALOGUE_LEVELS)[number];

export const ENDING_STYLES = ['cliffhanger', 'dialogue', 'quiet', 'decision', 'emotion', 'humor'] as const;
export type EndingStyle = (typeof ENDING_STYLES)[number];

export type ChapterRhythm = {
  readonly type: ChapterType;
  readonly dialogue: DialogueLevel;
  readonly ending: EndingStyle;
};

export const CHAPTER_TYPE_LABEL: Readonly<Record<ChapterType, string>> = {
  battle: '战斗',
  confrontation: '对峙或谈判',
  dialogue: '对话为主',
  transition: '过渡',
  daily: '日常',
  travel: '赶路或探查',
  reveal: '揭晓',
  climax: '高潮',
  other: '其他',
};

export const DIALOGUE_LEVEL_LABEL: Readonly<Record<DialogueLevel, string>> = { low: '少', mid: '中', high: '多' };

/** 各档对话占比的目标（引号里的字占全章的比例）。中文网文常见 25%–45%，这是体裁经验，不是论文结论。 */
export const DIALOGUE_TARGET: Readonly<Record<DialogueLevel, number>> = { low: 0.12, mid: 0.25, high: 0.4 };

export const ENDING_STYLE_LABEL: Readonly<Record<EndingStyle, string>> = {
  cliffhanger: '悬念',
  dialogue: '一句对白',
  quiet: '安静的画面或日常动作',
  decision: '人物做出决定',
  emotion: '情绪落点',
  humor: '小幽默',
};

/** 给写手的说明：每种收法怎么写。 */
export const ENDING_STYLE_HINT: Readonly<Record<EndingStyle, string>> = {
  cliffhanger: '停在一个未解的问题、刚揭开一角的发现或马上要发生的冲突上',
  dialogue: '以人物的一句话收尾，话里带着没说完的意思',
  quiet: '停在一个安静的画面或一件日常的小事上，不制造悬念',
  decision: '人物在章末拿定一个主意或迈出一步，读者知道他要去做什么',
  emotion: '停在人物的一个情绪落点上，用动作或细节写，不直接说出情绪的名字',
  humor: '以一点轻松或自嘲的小幽默收尾，松一口气',
};

const asEnum = <T extends string>(values: readonly T[], value: unknown): T | null => (typeof value === 'string' && (values as readonly string[]).includes(value) ? (value as T) : null);

/** 读一份节奏：三项都认得才算；不认得的（旧数据、模型写错）为 null。 */
export function parseChapterRhythm(value: unknown): ChapterRhythm | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const type = asEnum(CHAPTER_TYPES, v['type']);
  const dialogue = asEnum(DIALOGUE_LEVELS, v['dialogue']);
  const ending = asEnum(ENDING_STYLES, v['ending']);
  return type === null || dialogue === null || ending === null ? null : { type, dialogue, ending };
}
