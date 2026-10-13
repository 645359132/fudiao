// 长篇记忆的用例（需求 B66，施工文档第五章“写手与审核”）。
// 一章的记忆由模型从这一章的正文整理：梗概、出场人物在章末的状态、有进展的伏笔。
// 它是派生结论（硬性规则 21）：记录依据的段落版本与调用记录；正文改过后标为待复核，作者可以重建。
import type { CallOptions } from '@fudiao/llm';
import { ChapterMemoryOutput, renderChapterMemory } from '@fudiao/prompts';
import { err, ok, type Result } from '@fudiao/shared';
import {
  findCallByRequestHash,
  getProject,
  listChapters,
  listEntities,
  listForeshadows,
  listParagraphs,
  saveChapterMemory,
  type ChapterMemory,
  type RepoError,
  type SqlPort,
} from '@fudiao/store';
import type { AppError } from './errors';
import { THINKING_ALLOWANCE, type modelRunner } from './model-runner';
import type { AppDeps } from './ports';

/** 输出上限：梗概、人物状态与伏笔进展合计约一千字，另留出思考的余量。 */
export const MEMORY_OUTPUT_TOKENS = 2_000 + THINKING_ALLOWANCE;

const repo = (error: RepoError): AppError => ({ code: 'repo', error });
const settings = (detail: string): AppError => ({ code: 'settings', detail });

export function memoryUseCases(deps: AppDeps, project: () => SqlPort | null, runner: ReturnType<typeof modelRunner>) {
  return {
    /** 生成（或重建）一章的长篇记忆。模型写出的人物与伏笔按名字对应到设定与账本，对不上的丢弃。 */
    async buildMemory(chapterId: string, options: CallOptions = {}): Promise<Result<ChapterMemory, AppError>> {
      const port = project();
      if (port === null) return err({ code: 'no_work' });
      const [work, chapters, paragraphs, entities, foreshadows] = await Promise.all([
        getProject(port),
        listChapters(port, 'normal'),
        listParagraphs(port, chapterId),
        listEntities(port),
        listForeshadows(port),
      ]);
      if (!work.ok) return err(repo(work.error));
      if (!chapters.ok) return err(repo(chapters.error));
      if (!paragraphs.ok) return err(repo(paragraphs.error));
      if (!entities.ok) return err(repo(entities.error));
      if (!foreshadows.ok) return err(repo(foreshadows.error));
      const chapter = chapters.value.find((c) => c.id === chapterId);
      if (chapter === undefined) return err(repo({ code: 'not_found' }));
      const text = paragraphs.value.map((p) => p.text).join('\n');
      if (text.trim() === '') return err(settings(`“${chapter.title}”还没有正文，不能生成长篇记忆`));

      const characters = entities.value.filter((e) => e.kind === 'character');
      const open = foreshadows.value.filter((f) => f.status !== 'dropped');
      const prompt = renderChapterMemory({
        title: work.value?.title ?? '',
        chapterTitle: chapter.title,
        characters: characters.map((c) => c.name),
        foreshadows: open.map((f) => ({ title: f.title, content: f.content, reveal: f.reveal })),
        text,
      });
      if (!prompt.ok) return err(settings(prompt.error));
      const result = await runner.structured({ prompt: prompt.value, maxOutputTokens: MEMORY_OUTPUT_TOKENS, effort: 'low' }, ChapterMemoryOutput, options);
      if (!result.ok) return result;
      const output = result.value.value;
      if (output.summary.trim() === '') return err(settings('模型没有写出本章的梗概'));

      const characterOf = new Map(characters.flatMap((e) => [e.name, ...e.aliases].map((n) => [n.trim(), e.id] as const)));
      const foreshadowOf = new Map(open.map((f) => [f.title.trim(), f.id]));
      const byId = (pairs: readonly (readonly [string | undefined, string])[]) =>
        Object.fromEntries(pairs.flatMap(([id, value]) => (id === undefined || value.trim() === '' ? [] : [[id, value.trim()] as const])));
      const hash = result.value.attempts.at(-1)?.requestHash;
      const call = hash === undefined ? null : await findCallByRequestHash(port, hash);
      // 依据取调用之前读到的段落版本：生成期间正文改了，这份记忆随后会被标为待复核。
      const saved = await saveChapterMemory(
        port,
        {
          chapterId,
          summary: output.summary.trim(),
          castState: byId(output.cast.map((c) => [characterOf.get(c.name.trim()), c.state])),
          foreshadowProgress: byId(output.foreshadows.map((f) => [foreshadowOf.get(f.title.trim()), f.progress])),
          basedOn: Object.fromEntries(paragraphs.value.map((p) => [p.id, p.version])),
          llmCallId: call?.ok === true ? (call.value?.id ?? null) : null,
        },
        { now: deps.clock.now() },
      );
      return saved.ok ? ok(saved.value) : err(repo(saved.error));
    },
  };
}
