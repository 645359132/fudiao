// 开篇打磨（需求 B81，施工文档 M6-05）：对前几章算出客观数字，按开篇的要求逐章诊断，问题记为开篇诊断（opening）
// 的审核问题，定位到段落；作者处理后复诊，对比前后。
import type { CallOptions } from '@fudiao/llm';
import { ChapterReviewOutput, renderOpeningReview } from '@fudiao/prompts';
import { err, ok, type Result } from '@fudiao/shared';
import {
  findCallByRequestHash,
  getChapterPlan,
  getProject,
  listChapterMemories,
  listChapters,
  listChaptersWithText,
  listEntities,
  listIssues,
  listParagraphs,
  replacePendingIssues,
  type IssueEvidence,
  type RepoError,
  type SqlPort,
} from '@fudiao/store';
import { dropHandled, guessProtagonist, openingMetrics, paragraphLabel, resolveModelIssues, type OpeningMetrics } from '@fudiao/writing';
import type { AppError } from './errors';
import { THINKING_ALLOWANCE, type modelRunner } from './model-runner';
import type { AppDeps } from './ports';

const OPENING_OUTPUT_TOKENS = 4_000 + THINKING_ALLOWANCE;
const HANDLED = ['ignored', 'fixed', 'sent_to_writer'] as const;

export type OpeningChapter = { readonly chapterId: string; readonly title: string; readonly metrics: OpeningMetrics };
export type OpeningSurvey = { readonly protagonist: { readonly id: string; readonly name: string } | null; readonly chapters: readonly OpeningChapter[] };

const repo = (error: RepoError): AppError => ({ code: 'repo', error });
const settings = (detail: string): AppError => ({ code: 'settings', detail });

export function openingUseCases(deps: AppDeps, project: () => SqlPort | null, runner: ReturnType<typeof modelRunner>) {
  const ctx = () => ({ now: deps.clock.now() });

  return {
    /** 书中最前面的 count 章里已有正文的章节的客观数字，以及推断的主角（前几章里出现最多的人物）。 */
    async openingSurvey(count: number): Promise<Result<OpeningSurvey, AppError>> {
      const port = project();
      if (port === null) return err({ code: 'no_work' });
      const [chapters, withText, entities] = await Promise.all([listChapters(port, 'normal'), listChaptersWithText(port), listEntities(port)]);
      if (!chapters.ok) return err(repo(chapters.error));
      if (!withText.ok) return err(repo(withText.error));
      if (!entities.ok) return err(repo(entities.error));
      const hasText = new Set(withText.value);
      const first = chapters.value.slice(0, count).filter((c) => hasText.has(c.id));
      if (first.length === 0) return err(settings('最前面的几章还没有正文：先写开头几章，再来打磨'));
      const texts: { chapterId: string; title: string; paragraphs: { text: string }[] }[] = [];
      for (const c of first) {
        const paragraphs = await listParagraphs(port, c.id);
        if (!paragraphs.ok) return err(repo(paragraphs.error));
        texts.push({ chapterId: c.id, title: c.title, paragraphs: paragraphs.value.filter((p) => p.text.trim() !== '') });
      }
      const characters = entities.value.filter((e) => e.kind === 'character').map((e) => ({ id: e.id, name: e.name, aliases: e.aliases }));
      const protagonist = guessProtagonist(
        texts.map((t) => t.paragraphs.map((p) => p.text).join('\n')),
        characters,
      );
      const names = entities.value.flatMap((e) => [e.name, ...e.aliases]);
      return ok({
        protagonist: protagonist === null ? null : { id: protagonist.id, name: protagonist.name },
        chapters: texts.map((t) => ({ chapterId: t.chapterId, title: t.title, metrics: openingMetrics(t.paragraphs, protagonist, names) })),
      });
    },

    /**
     * 按开篇的要求诊断一章（第 index 章，共 count 章），问题写进这一章的审核（来源 opening）：仍待处理的旧开篇问题换成这一次的，
     * 作者处理过的同一处问题不再提出。返回写入与丢弃的条数。
     */
    async diagnoseOpening(
      survey: OpeningSurvey,
      index: number,
      stepKey: string,
      options: CallOptions = {},
    ): Promise<Result<{ readonly issues: number; readonly dropped: number }, AppError>> {
      const port = project();
      if (port === null) return err({ code: 'no_work' });
      const chapter = survey.chapters[index];
      if (chapter === undefined) return err(settings('要诊断的这一章不在了'));
      const [work, paragraphs, plan, memories, handled] = await Promise.all([
        getProject(port),
        listParagraphs(port, chapter.chapterId),
        getChapterPlan(port, chapter.chapterId),
        listChapterMemories(port),
        listIssues(port, chapter.chapterId, HANDLED),
      ]);
      if (!work.ok) return err(repo(work.error));
      if (!paragraphs.ok) return err(repo(paragraphs.error));
      if (!plan.ok) return err(repo(plan.error));
      if (!memories.ok) return err(repo(memories.error));
      if (!handled.ok) return err(repo(handled.error));
      const text = paragraphs.value.filter((p) => p.text.trim() !== '');
      if (text.length === 0) return err(settings(`《${chapter.title}》已经没有正文`));
      const memoryOf = new Map(memories.value.map((m) => [m.chapterId, m]));
      const prompt = renderOpeningReview({
        title: work.value?.title ?? '',
        genre: work.value?.genre ?? '',
        synopsis: work.value?.synopsis ?? '',
        protagonist: survey.protagonist?.name ?? '',
        openingCount: survey.chapters.length,
        index: index + 1,
        chapterTitle: chapter.title,
        goal: plan.value?.goal ?? '',
        earlier: survey.chapters.slice(0, index).flatMap((c) => {
          const summary = memoryOf.get(c.chapterId)?.summary.trim() ?? '';
          return summary === '' ? [] : [{ title: c.title, summary }];
        }),
        metrics: chapter.metrics,
        paragraphs: text.map((p, i) => ({ label: paragraphLabel(i), text: p.text })),
      });
      if (!prompt.ok) return err(settings(prompt.error));
      const result = await runner.structured({ prompt: prompt.value, maxOutputTokens: OPENING_OUTPUT_TOKENS, effort: 'medium', stepKey }, ChapterReviewOutput, options);
      if (!result.ok) return result;
      const resolved = resolveModelIssues(result.value.value.issues, { paragraphs: text, evidence: new Map<string, IssueEvidence>() });
      const issues = dropHandled(resolved.issues, handled.value);
      const hash = result.value.attempts.at(-1)?.requestHash;
      const call = hash === undefined ? null : await findCallByRequestHash(port, hash);
      const llmCallId = call?.ok === true ? (call.value?.id ?? null) : null;
      const saved = await replacePendingIssues(
        port,
        chapter.chapterId,
        'opening',
        issues.map((i) => ({ id: deps.ids.next(), chapterId: chapter.chapterId, kind: i.kind, severity: i.severity, anchor: i.anchor, evidence: i.evidence, description: i.description, suggestion: i.suggestion, source: 'opening' as const, llmCallId })),
        ctx(),
      );
      if (!saved.ok) return err(repo(saved.error));
      return ok({ issues: issues.length, dropped: resolved.dropped.filter((d) => d.reason !== 'duplicate').length });
    },

  };
}
