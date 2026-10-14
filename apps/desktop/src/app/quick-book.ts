// 快速成书（需求 B67，施工文档 M3-10）：把“出一本书”串成一页——连接模型、由一句话的想法生成作品骨架
// （作品名、类型、简介、大纲、主要人物）、拆出章节计划、写手依次写完并审核、导出。这里只有骨架与各步的状态；
// 章节计划、写作、审核与导出沿用计划页与成书进度的用例，写入的是同一份数据。
import type { CallOptions } from '@fudiao/llm';
import { BookSeedOutput, renderBookSeed } from '@fudiao/prompts';
import { err, ok, type Result } from '@fudiao/shared';
import { createEntity, getProject, listEntities, updateEntity, type ProjectPatch, type RepoError, type SqlPort } from '@fudiao/store';
import type { AppError } from './errors';
import { THINKING_ALLOWANCE, type modelRunner } from './model-runner';
import type { PlanningView } from './planning';
import type { AppDeps } from './ports';

export type BookSeedRequest = {
  /** 一句话的想法，例如“落魄书生当铺夜遇旧主”。 */
  readonly idea: string;
  readonly genre: string;
  readonly chapterCount: number;
  readonly wordsPerChapter: number;
};

export type BookSeed = BookSeedOutput;

/** 快速成书各步的状态：每一步做完没有，由作品里已有的数据得出。 */
export type QuickBookStatus = {
  /** 默认模型是否可以用于结构化任务（已设置且通过能力自检）；problem 是不能用的原因。 */
  readonly model: { readonly ready: boolean; readonly name: string | null; readonly problem: string | null };
  readonly outline: boolean;
  readonly characters: number;
  readonly chapters: number;
  readonly planned: number;
  readonly written: number;
  readonly reviewed: number;
  readonly pendingIssues: number;
};

/** 作品骨架的输出上限：大纲随章数变长，另留出思考的余量。 */
export const seedOutputTokens = (chapterCount: number) => Math.min(16_000, 2_000 + chapterCount * 150) + THINKING_ALLOWANCE;

const repo = (error: RepoError): AppError => ({ code: 'repo', error });
const settings = (detail: string): AppError => ({ code: 'settings', detail });

export type QuickBookDeps = {
  readonly deps: AppDeps;
  readonly project: () => SqlPort | null;
  readonly runner: ReturnType<typeof modelRunner>;
  readonly planningView: () => Promise<Result<PlanningView, AppError>>;
  readonly defaultModel: () => Promise<
    Result<{ readonly model: { readonly displayName: string; readonly capabilities: { readonly selfTestPassed: boolean; readonly structuredOutput: string } } } | null, AppError>
  >;
  /** 修改作品信息（作品名改了时同步作品列表）。 */
  readonly updateWorkInfo: (patch: ProjectPatch) => Promise<Result<unknown, AppError>>;
};

export function quickBookUseCases({ deps, project, runner, planningView, defaultModel, updateWorkInfo }: QuickBookDeps) {
  const ctx = () => ({ now: deps.clock.now() });

  return {
    /** 各步的状态：只读，不调用模型。 */
    async quickBookStatus(): Promise<Result<QuickBookStatus, AppError>> {
      const choice = await defaultModel();
      if (!choice.ok) return choice;
      const plan = await planningView();
      if (!plan.ok) return plan;
      const model = choice.value?.model ?? null;
      const problem =
        model === null
          ? '还没有设置默认模型'
          : !model.capabilities.selfTestPassed || model.capabilities.structuredOutput === 'none'
            ? `“${model.displayName}”还没有通过能力自检`
            : null;
      const chapters = plan.value.chapters;
      return ok({
        model: { ready: problem === null, name: model?.displayName ?? null, problem },
        outline: plan.value.outline.trim() !== '',
        characters: plan.value.characters.length,
        chapters: chapters.length,
        planned: chapters.filter((c) => c.plan !== null).length,
        written: chapters.filter((c) => c.plan?.status === 'written' || c.plan?.status === 'reviewed').length,
        reviewed: chapters.filter((c) => c.plan?.status === 'reviewed').length,
        pendingIssues: chapters.reduce((n, c) => n + c.pendingIssues, 0),
      });
    },

    /** 由一句话的想法生成作品骨架（不写入作品）。作品名不是新建时的默认名时沿用；已有的人物名一并给模型。 */
    async draftBookSeed(request: BookSeedRequest, options: CallOptions = {}): Promise<Result<BookSeed, AppError>> {
      const port = project();
      if (port === null) return err({ code: 'no_work' });
      if (request.idea.trim() === '') return err(settings('先写一句想法：主角是谁、遇到了什么事'));
      const work = await getProject(port);
      if (!work.ok) return err(repo(work.error));
      const entities = await listEntities(port);
      if (!entities.ok) return err(repo(entities.error));
      const prompt = renderBookSeed({
        idea: request.idea.trim(),
        genre: request.genre.trim() || (work.value?.genre ?? ''),
        title: work.value?.title ?? '',
        characters: entities.value.filter((e) => e.kind === 'character').map((e) => e.name),
        chapterCount: request.chapterCount,
        wordsPerChapter: request.wordsPerChapter,
      });
      if (!prompt.ok) return err(settings(prompt.error));
      const result = await runner.structured({ prompt: prompt.value, maxOutputTokens: seedOutputTokens(request.chapterCount), effort: 'medium' }, BookSeedOutput, options);
      return result.ok ? ok(result.value.value) : result;
    },

    /**
     * 采用作者改过的骨架：写入作品名、类型、简介与大纲；人物按名字（含别名）对应到人物设定，
     * 没有的新建并写上说明，已有的不改（锁定与否都不动）。可以重复采用，不会重复建人物。
     */
    async applyBookSeed(seed: BookSeed): Promise<Result<{ readonly created: number }, AppError>> {
      const port = project();
      if (port === null) return err({ code: 'no_work' });
      if (seed.outline.trim() === '') return err(settings('大纲不能为空：章节计划由大纲拆出'));
      const title = seed.title.trim();
      const info = await updateWorkInfo({ ...(title !== '' && { title }), genre: seed.genre.trim(), synopsis: seed.synopsis.trim(), outline: seed.outline.trim() });
      if (!info.ok) return info;
      const entities = await listEntities(port);
      if (!entities.ok) return err(repo(entities.error));
      const known = new Set(entities.value.filter((e) => e.kind === 'character').flatMap((e) => [e.name, ...e.aliases].map((n) => n.trim())));
      let created = 0;
      for (const c of seed.characters) {
        const name = c.name.trim();
        if (name === '' || known.has(name)) continue;
        known.add(name);
        const entity = await createEntity(port, { id: deps.ids.next(), kind: 'character', name }, ctx());
        if (!entity.ok) return err(repo(entity.error));
        if (c.description.trim() !== '') {
          const described = await updateEntity(port, entity.value.id, entity.value.version, { description: c.description.trim() }, ctx());
          if (!described.ok) return err(repo(described.error));
        }
        created += 1;
      }
      return ok({ created });
    },
  };
}
