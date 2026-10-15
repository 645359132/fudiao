// 内置写作技能（需求 B61、B75）：templates/skills/ 下的 SKILL.md 格式文件，文件名为技能键（与文件头的 name 相同），
// description 说明做什么、什么时候用，metadata 里是界面上的名称、版本、顺序与阶段（stages，没写时为写章节）。
// 写手模板按作品中启用的写章节技能组合写作指令，作品骨架与章节计划的模板带上规划技能（packages/writing 的 composeSkills）。
import { parseSkillStages, type SkillStage } from '@fudiao/shared';
import { SKILL_SOURCES } from './generated/templates';
import { parseSkillMd } from './skill-md';

export type BuiltinSkill = {
  readonly key: string;
  /** 界面上显示的名称（metadata.title）。 */
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly order: number;
  /** 用在哪些阶段：规划（作品骨架与章节计划）、写章节。 */
  readonly stages: readonly SkillStage[];
  readonly text: string;
};

function parseSkill(key: string, source: string): BuiltinSkill {
  const doc = parseSkillMd(source);
  // 文件头的检查在 pnpm prompts:build 中进行，生成的模块里只有通过检查的文件。
  if (!doc.ok) throw new Error(`内置技能 ${key}：${doc.error}`);
  const { metadata } = doc.value;
  return {
    key,
    name: metadata['title'] ?? key,
    description: doc.value.description,
    version: metadata['version'] ?? '',
    order: Number(metadata['order']),
    stages: parseSkillStages(metadata['stages']),
    text: doc.value.body,
  };
}

/** 全部内置技能，按顺序。 */
export const BUILTIN_SKILLS: readonly BuiltinSkill[] = Object.entries(SKILL_SOURCES)
  .map(([key, source]) => parseSkill(key, source))
  .sort((a, b) => a.order - b.order);
