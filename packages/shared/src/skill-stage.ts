// 写作技能用在哪个阶段（需求 B61、B75）：planning 是生成作品骨架（大纲与人物）与章节计划，writing 是写手写章节。
// SKILL.md 的 metadata.stages 与作品库里写作技能的 stages 列都写成空格分开的阶段名，例如 "planning writing"。

export const SKILL_STAGES = ['planning', 'writing'] as const;
export type SkillStage = (typeof SKILL_STAGES)[number];

/** 读阶段：认得的按固定顺序去重；一个也没有（包括没写）时为写章节，与没有这一项之前的技能一致。 */
export function parseSkillStages(text: string | null | undefined): SkillStage[] {
  const named = new Set((text ?? '').split(/[\s,，、]+/).map((s) => s.trim().toLowerCase()));
  const stages = SKILL_STAGES.filter((s) => named.has(s));
  return stages.length === 0 ? ['writing'] : stages;
}

/** 写阶段：按固定顺序、空格分开；空的按写章节。 */
export function formatSkillStages(stages: readonly SkillStage[]): string {
  return parseSkillStages(stages.join(' ')).join(' ');
}
