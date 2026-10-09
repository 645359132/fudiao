// 写作技能与规避词表的用例（需求 B61、B37，施工文档第五章“写手与审核”）：
// 打开技能页时把内置技能登记进作品；作者可以启用、停用、改写说明、恢复内置文字，添加与删除自定义技能，编辑规避词表。
import { BUILTIN_SKILLS } from '@fudiao/prompts';
import { err, ok, type Result } from '@fudiao/shared';
import {
  createCustomSkill,
  deleteCustomSkill,
  ensureBuiltinSkills,
  getProject,
  updateProject,
  updateSkill,
  type RepoError,
  type SqlPort,
  type WritingSkill,
} from '@fudiao/store';
import { DEFAULT_AVOID_PHRASES } from '@fudiao/writing';
import type { AppError } from './errors';
import type { AppDeps } from './ports';

export type SkillView = {
  readonly skill: WritingSkill;
  /** 内置技能的模板文字；自定义技能为 null。 */
  readonly builtinText: string | null;
};

export type SkillsView = {
  readonly skills: readonly SkillView[];
  /** 当前生效的规避词表。 */
  readonly avoidPhrases: readonly string[];
  /** 作品是否有自己的词表；没有时用默认词表。 */
  readonly avoidPhrasesCustom: boolean;
};

const repo = (error: RepoError): AppError => ({ code: 'repo', error });

export function writingSkillUseCases(deps: AppDeps, project: () => SqlPort | null) {
  const ctx = () => ({ now: deps.clock.now() });
  const builtins = BUILTIN_SKILLS.map(({ key, name, version }) => ({ key, name, version }));
  const textOf = new Map(BUILTIN_SKILLS.map((s) => [s.key, s.text]));

  async function view(port: SqlPort): Promise<Result<SkillsView, AppError>> {
    const skills = await ensureBuiltinSkills(port, builtins, () => deps.ids.next(), ctx());
    if (!skills.ok) return err(repo(skills.error));
    const work = await getProject(port);
    if (!work.ok) return err(repo(work.error));
    const own = work.value?.avoidPhrases ?? null;
    return ok({
      // 已不再内置的技能（模板删掉了）不显示；作品中的记录保留，导出时不丢。
      skills: skills.value
        .filter((s) => s.builtinVersion === null || textOf.has(s.key))
        .map((skill) => ({ skill, builtinText: skill.builtinVersion === null ? null : (textOf.get(skill.key) ?? null) })),
      avoidPhrases: own ?? DEFAULT_AVOID_PHRASES,
      avoidPhrasesCustom: own !== null,
    });
  }

  async function change(f: (port: SqlPort) => Promise<Result<unknown, RepoError>>): Promise<Result<SkillsView, AppError>> {
    const port = project();
    if (port === null) return err({ code: 'no_work' });
    const done = await f(port);
    return done.ok ? view(port) : err(repo(done.error));
  }

  return {
    async listWritingSkills(): Promise<Result<SkillsView, AppError>> {
      const port = project();
      return port === null ? err({ code: 'no_work' }) : view(port);
    },

    /** 启用、停用或改写说明；内置技能的说明清空即恢复模板文字。 */
    updateWritingSkill: (skill: WritingSkill, patch: { readonly enabled?: boolean; readonly instruction?: string; readonly name?: string }) =>
      change((port) => updateSkill(port, skill, patch, ctx())),

    addCustomSkill(name: string, instruction: string): Promise<Result<SkillsView, AppError>> {
      const id = deps.ids.next();
      const title = name.trim();
      if (title === '') return Promise.resolve(err({ code: 'repo', error: { code: 'invalid', detail: '技能名称不能为空' } }));
      return change((port) => createCustomSkill(port, { id, key: `custom-${id.toLowerCase()}`, name: title, instruction: instruction.trim() }, ctx()));
    },

    deleteCustomSkill: (skill: WritingSkill) => change((port) => deleteCustomSkill(port, skill)),

    /** 设置规避词表；null 恢复默认词表，空数组表示不检查。 */
    setAvoidPhrases: (phrases: readonly string[] | null) =>
      change(async (port) => {
        const work = await getProject(port);
        if (!work.ok) return work;
        if (work.value === null) return err({ code: 'not_found' } as const);
        return updateProject(port, work.value.id, work.value.version, { avoidPhrases: phrases === null ? null : [...phrases] }, ctx());
      }),
  };
}
