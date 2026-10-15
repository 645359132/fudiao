// 写作技能与规避词表的用例（需求 B61、B37，施工文档第五章“写手与审核”）：
// 打开技能页时把内置技能登记进作品；作者可以启用、停用、改写说明、恢复内置文字，添加与删除自定义技能，编辑规避词表。
// 技能采用 SKILL.md 格式（M3-11）：可以导入别处的 SKILL.md，也可以把任一技能导出为 SKILL.md。
// 技能分阶段（B75）：规划的技能用于生成作品骨架与章节计划，写章节的技能交给写手；SKILL.md 的 metadata.stages 写明。
import { BUILTIN_SKILLS, formatSkillMd, parseSkillMd } from '@fudiao/prompts';
import { err, formatSkillStages, ok, parseSkillStages, type Result, type SkillStage } from '@fudiao/shared';
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
import { composeSkills, DEFAULT_AVOID_PHRASES, type ComposedSkill } from '@fudiao/writing';
import type { AppError } from './errors';
import type { AppDeps } from './ports';

export type SkillView = {
  readonly skill: WritingSkill;
  /** 内置技能的模板文字；自定义技能为 null。 */
  readonly builtinText: string | null;
  /** 适用说明：内置技能的取自模板，自定义技能的是作者写的。 */
  readonly description: string;
};

export type SkillsView = {
  readonly skills: readonly SkillView[];
  /** 当前生效的规避词表。 */
  readonly avoidPhrases: readonly string[];
  /** 作品是否有自己的词表；没有时用默认词表。 */
  readonly avoidPhrasesCustom: boolean;
};

const repo = (error: RepoError): AppError => ({ code: 'repo', error });
const settings = (detail: string): AppError => ({ code: 'settings', detail });
const BUILTINS = BUILTIN_SKILLS.map(({ key, name, version, stages }) => ({ key, name, version, stages }));

/**
 * 这一阶段要带上的技能：写章节的交给写手，规划的交给作品骨架与章节计划。
 * 作品还没打开过“写作技能”页时，内置技能在这里登记（全部启用）。
 */
export async function skillsForStage(port: SqlPort, stage: SkillStage, deps: AppDeps): Promise<Result<ComposedSkill[], RepoError>> {
  const skills = await ensureBuiltinSkills(port, BUILTINS, () => deps.ids.next(), { now: deps.clock.now() });
  return skills.ok ? ok(composeSkills(skills.value, BUILTIN_SKILLS, stage)) : skills;
}

export function writingSkillUseCases(deps: AppDeps, project: () => SqlPort | null) {
  const ctx = () => ({ now: deps.clock.now() });
  const builtins = BUILTINS;
  const textOf = new Map(BUILTIN_SKILLS.map((s) => [s.key, s.text]));
  const builtinOf = new Map(BUILTIN_SKILLS.map((s) => [s.key, s]));

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
        .map((skill) => ({
          skill,
          builtinText: skill.builtinVersion === null ? null : (textOf.get(skill.key) ?? null),
          description: skill.builtinVersion === null ? skill.description : (builtinOf.get(skill.key)?.description ?? ''),
        })),
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

    /** 启用、停用、改写说明或改阶段（只有自定义技能能改阶段）；内置技能的说明清空即恢复模板文字。 */
    updateWritingSkill: (
      skill: WritingSkill,
      patch: { readonly enabled?: boolean; readonly instruction?: string; readonly name?: string; readonly description?: string; readonly stages?: readonly SkillStage[] },
    ) => change((port) => updateSkill(port, skill, patch, ctx())),

    /**
     * 添加自己的技能，字段与 SKILL.md 对应：名称（metadata.title）、标识（name，可不填，不填时自动生成）、
     * 适用说明（description）、指令与阶段（metadata.stages，没给时为写章节）。标识与已有技能（含内置技能）重复时不添加。
     */
    async addCustomSkill(name: string, instruction: string, description = '', key = '', stages: readonly SkillStage[] = ['writing']): Promise<Result<SkillsView, AppError>> {
      const port = project();
      if (port === null) return err({ code: 'no_work' });
      const id = deps.ids.next();
      const title = name.trim();
      if (title === '') return err({ code: 'repo', error: { code: 'invalid', detail: '技能名称不能为空' } });
      const wanted = key.trim();
      if (/[\s:"'#]/.test(wanted)) return err(settings('标识里不能有空格、冒号、引号或 #：常见写法是小写字母、数字与连字符，例如 dialogue-voice'));
      if (wanted !== '') {
        const current = await ensureBuiltinSkills(port, builtins, () => deps.ids.next(), ctx());
        if (!current.ok) return err(repo(current.error));
        const taken = current.value.find((s) => s.key === wanted);
        if (taken !== undefined) return err(settings(`标识“${wanted}”已被“${taken.name}”使用：换一个，或用“导入 SKILL.md”更新那项技能`));
      }
      return change((p) =>
        createCustomSkill(p, { id, key: wanted === '' ? `custom-${id.toLowerCase()}` : wanted, name: title, description: description.trim(), instruction: instruction.trim(), stages }, ctx()),
      );
    },

    /**
     * 导入一个 SKILL.md：name 作为技能的标识，metadata.title 作为名称（没有时用 name），description、指令与阶段（metadata.stages）照录。
     * 作品里已有同一标识的自定义技能时用导入的内容更新它（别处改了新版本可以再导入）。与内置技能同名时
     * （例如导出内置技能、在别处改过再导回），导入的指令成为作者对这项内置技能的改写，名称与适用说明仍用内置的。
     */
    async importSkillMd(text: string): Promise<Result<{ readonly view: SkillsView; readonly name: string; readonly replaced: boolean }, AppError>> {
      const port = project();
      if (port === null) return err({ code: 'no_work' });
      const doc = parseSkillMd(text);
      if (!doc.ok) return err(settings(doc.error));
      const { name: key, description, metadata, body } = doc.value;
      const title = (metadata['title'] ?? '').trim() || key;
      const stages = parseSkillStages(metadata['stages']);
      const current = await ensureBuiltinSkills(port, builtins, () => deps.ids.next(), ctx());
      if (!current.ok) return err(repo(current.error));
      const existing = current.value.find((s) => s.key === key);
      const done =
        existing !== undefined && existing.builtinVersion !== null
          ? await updateSkill(port, existing, { instruction: body === builtinOf.get(key)?.text ? '' : body }, ctx())
          : existing === undefined
          ? await createCustomSkill(port, { id: deps.ids.next(), key, name: title, description, instruction: body, stages }, ctx())
          : await updateSkill(port, existing, { name: title, description, instruction: body, stages }, ctx());
      if (!done.ok) return err(repo(done.error));
      const next = await view(port);
      return next.ok ? ok({ view: next.value, name: existing !== undefined && existing.builtinVersion !== null ? existing.name : title, replaced: existing !== undefined }) : next;
    },

    /** 把一项技能写成 SKILL.md（内置技能用作者改过的说明，没改时用模板文字），以及建议的文件名。只用于写章节的技能不写阶段。 */
    skillMdOf(item: SkillView): { readonly fileName: string; readonly content: string } {
      const { skill } = item;
      const body = skill.instruction.trim() === '' ? (item.builtinText ?? '') : skill.instruction;
      const stages = formatSkillStages(skill.stages);
      const content = formatSkillMd({ name: skill.key, description: item.description, metadata: { title: skill.name, ...(stages !== 'writing' && { stages }) }, body });
      return { fileName: `${skill.key}.SKILL.md`, content };
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
