// 写作技能的组合（需求 B61、B75）：请求中的技能由启用的、用于这一阶段的技能按顺序拼成——写章节的给写手，
// 规划的给作品骨架与章节计划；内置技能的文字与阶段来自提示词模板（packages/prompts/templates/skills/），
// 作者改过的说明代替模板文字。
import type { SkillStage } from '@fudiao/shared';

/** 作品中一项技能的设置（来自写作技能表）。builtinVersion 为空的是作者自定义的技能。 */
export type SkillSetting = {
  readonly key: string;
  readonly name: string;
  /** 适用说明（SKILL.md 的 description）；内置技能用模板里的。 */
  readonly description: string;
  readonly enabled: boolean;
  /** 作者的说明；内置技能为空时沿用模板文字。 */
  readonly instruction: string;
  readonly builtinVersion: string | null;
  /** 自定义技能用在哪些阶段；内置技能的以模板为准。 */
  readonly stages: readonly SkillStage[];
};

/** 内置技能的模板文字、版本与阶段。 */
export type BuiltinSkillText = {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly stages: readonly SkillStage[];
  readonly text: string;
};

export type ComposedSkill = {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly text: string;
  /** 调用记录中核对用：builtin:版本、builtin:版本:modified（作者改过说明）或 custom。 */
  readonly origin: string;
};

/** 这一阶段要带上的技能：内置技能在前（按模板顺序），自定义技能在后（按作品中的顺序）。 */
export function composeSkills(settings: readonly SkillSetting[], builtins: readonly BuiltinSkillText[], stage: SkillStage): ComposedSkill[] {
  const byKey = new Map(settings.map((s) => [s.key, s]));
  const composed: ComposedSkill[] = [];
  for (const b of builtins) {
    const s = byKey.get(b.key);
    if (s === undefined || !s.enabled || s.builtinVersion === null || !b.stages.includes(stage)) continue;
    const own = s.instruction.trim();
    composed.push({ key: b.key, name: b.name, description: b.description, text: own === '' ? b.text : own, origin: own === '' ? `builtin:${b.version}` : `builtin:${b.version}:modified` });
  }
  for (const s of settings) {
    if (s.builtinVersion !== null || !s.enabled || s.instruction.trim() === '' || !s.stages.includes(stage)) continue;
    composed.push({ key: s.key, name: s.name, description: s.description.trim(), text: s.instruction.trim(), origin: 'custom' });
  }
  return composed;
}
