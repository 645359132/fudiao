// 内置写作技能（需求 B61）：templates/skills/ 下的文件，文件名为技能键，文件头声明版本、名称与顺序。
// 写手模板按作品中启用的技能组合写作指令（packages/writing 的 composeSkills）。
import { SKILL_SOURCES } from './generated/templates';

export type BuiltinSkill = { readonly key: string; readonly name: string; readonly version: string; readonly order: number; readonly text: string };

function parseSkill(key: string, source: string): BuiltinSkill {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source);
  const head = match?.[1] ?? '';
  const field = (name: string) =>
    head
      .split('\n')
      .find((line) => line.startsWith(`${name}:`))
      ?.slice(name.length + 1)
      .trim() ?? '';
  return { key, name: field('name'), version: field('version'), order: Number(field('order')), text: (match?.[2] ?? '').trim() };
}

/** 全部内置技能，按顺序。 */
export const BUILTIN_SKILLS: readonly BuiltinSkill[] = Object.entries(SKILL_SOURCES)
  .map(([key, source]) => parseSkill(key, source))
  .sort((a, b) => a.order - b.order);
