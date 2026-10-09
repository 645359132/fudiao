// 写作技能的组合（需求 B61）：写手请求中的写作指令由启用的技能按顺序拼成；
// 内置技能的文字来自提示词模板（packages/prompts/templates/skills/），作者改过的说明代替模板文字。

/** 作品中一项技能的设置（来自写作技能表）。builtinVersion 为空的是作者自定义的技能。 */
export type SkillSetting = {
  readonly key: string;
  readonly name: string;
  readonly enabled: boolean;
  /** 作者的说明；内置技能为空时沿用模板文字。 */
  readonly instruction: string;
  readonly builtinVersion: string | null;
};

/** 内置技能的模板文字与版本。 */
export type BuiltinSkillText = { readonly key: string; readonly name: string; readonly version: string; readonly text: string };

export type ComposedSkill = {
  readonly key: string;
  readonly name: string;
  readonly text: string;
  /** 调用记录中核对用：builtin:版本、builtin:版本:modified（作者改过说明）或 custom。 */
  readonly origin: string;
};

export function composeSkills(settings: readonly SkillSetting[], builtins: readonly BuiltinSkillText[]): ComposedSkill[] {
  const byKey = new Map(settings.map((s) => [s.key, s]));
  const composed: ComposedSkill[] = [];
  for (const b of builtins) {
    const s = byKey.get(b.key);
    if (s === undefined || !s.enabled || s.builtinVersion === null) continue;
    const own = s.instruction.trim();
    composed.push({ key: b.key, name: b.name, text: own === '' ? b.text : own, origin: own === '' ? `builtin:${b.version}` : `builtin:${b.version}:modified` });
  }
  for (const s of settings) {
    if (s.builtinVersion !== null || !s.enabled || s.instruction.trim() === '') continue;
    composed.push({ key: s.key, name: s.name, text: s.instruction.trim(), origin: 'custom' });
  }
  return composed;
}
