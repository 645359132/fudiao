// 第二遍去 AI 味的修订（需求 B87，M8-01）：写手写完一章后，按程序统计出的毛病（最近几章用得太多的说法、本章的高频词与固定搭配、
// 句首模板、对话占比、句长）用“润色与去 AI 味”技能再改一遍表达。依据：Self-Refine（Madaan 等 2023）的“生成—反馈—修订”，反馈由程序给、
// 不让模型自评；LAMP（Chakrabarty 等 2025）按毛病分类的自动编辑能拉近与人写文本的距离。
// 边界：只改表达——段落一段对一段，设定名与数字变了的那一组不写入；写入前存“写手写入”快照，段落仍是 AI 来源，可一键回退。
import { costOf, type CallOptions, type Prices } from '@fudiao/llm';
import { renderWriterPolish } from '@fudiao/prompts';
import { err, ok, type Result } from '@fudiao/shared';
import {
  applyRangeReplace,
  createSnapshot,
  getChapterPlan,
  getProject,
  listChapters,
  listEntities,
  listParagraphs,
  planRangeReplace,
  type RepoError,
  type SavedParagraph,
  type SqlPort,
} from '@fudiao/store';
import { effectiveAvoidPhrases, normalizePunctuation, styleChecks, styleLedger, visibleLength, type LedgerChapter } from '@fudiao/writing';
import type { AppError } from './errors';
import { THINKING_ALLOWANCE, type modelRunner } from './model-runner';
import type { AppDeps } from './ports';
import type { ChapterLockFn } from './review';
import { dialogueTargetOf, recentStyle } from './style-ledger';
import { THINKING_TOKENS_PER_CALL, TOKENS_PER_CHAR } from './thinking';
import { skillsForStage } from './writing-skills';

/** 一次交给模型修订的一组段落约多少字。 */
export const POLISH_GROUP_CHARS = 1500;
/** 只用这一项技能做修订（别的技能是写作时用的）。 */
export const POLISH_SKILL_KEY = 'polish';
/** 估算用：每组的输入约这么多 Token（技能、统计与一组段落）。 */
const POLISH_INPUT_TOKENS = 4_000;

export type PolishOutcome = {
  readonly status: 'polished' | 'cancelled' | 'stopped';
  /** 交给模型的组数与写回的组数。 */
  readonly groups: number;
  readonly changed: number;
  /** 没有写回的组与原因。 */
  readonly skipped: readonly string[];
  /** 程序统计出的反馈；为空时没有调用模型。 */
  readonly feedback: readonly string[];
  readonly reason: string | null;
};

/** 全书体检报告里的文风统计（B87）。 */
export type StyleReport = {
  readonly words: number;
  readonly dialogueRatio: number;
  readonly sentenceCv: number;
  readonly endings: Readonly<Record<string, number>>;
  readonly overused: readonly { readonly term: string; readonly count: number; readonly chapters: number }[];
};

export type PolishQuote = { readonly chapters: number; readonly calls: number; readonly inputTokens: number; readonly outputTokens: number; readonly costUsd: number | null };

const repo = (error: RepoError): AppError => ({ code: 'repo', error });
const settings = (detail: string): AppError => ({ code: 'settings', detail });

/** 一组段落的标签：P1、P2……（组内从头编）。 */
const label = (i: number) => `P${i + 1}`;

/** 按约 POLISH_GROUP_CHARS 字分组，一段不拆。 */
export function groupParagraphs<T extends { readonly text: string }>(paragraphs: readonly T[], chars: number = POLISH_GROUP_CHARS): T[][] {
  const groups: T[][] = [];
  let current: T[] = [];
  let size = 0;
  for (const p of paragraphs) {
    const n = visibleLength(p.text);
    if (current.length > 0 && size + n > chars) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(p);
    size += n;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/** 模型的输出按标签对回段落；标签缺了、多了或顺序不对时为 null。 */
export function parsePolished(text: string, count: number): string[] | null {
  const parts = text.split(/^\s*\[P(\d+)\]\s*/mu);
  // split 的结果：[前导, 序号, 文字, 序号, 文字……]
  if (parts.length < 3 || (parts[0] ?? '').trim() !== '') return null;
  const out: string[] = [];
  for (let i = 1; i + 1 < parts.length; i += 2) {
    if (Number(parts[i]) !== out.length + 1) return null;
    const body = normalizePunctuation((parts[i + 1] ?? '').trim()).replace(/\s*\n\s*/gu, '');
    if (body === '') return null;
    out.push(body);
  }
  return out.length === count ? out : null;
}

/** 修订前后的“实质”没变：设定名字出现的集合、数字串、引号里的话的条数都相同。 */
export function sameSubstance(before: string, after: string, names: readonly string[]): boolean {
  const mentioned = (text: string) => new Set(names.filter((n) => n.trim() !== '' && text.includes(n)));
  const digits = (text: string) => (text.match(/[0-9０-９一二两三四五六七八九十百千万]+(?=[年月日时辰里丈尺寸两斤人名个口匹艘枚张把条道声步更夜天])/gu) ?? []).sort().join('|');
  const quotes = (text: string) => (text.match(/[“「『]/gu) ?? []).length;
  const a = mentioned(before);
  const b = mentioned(after);
  return a.size === b.size && [...a].every((n) => b.has(n)) && digits(before) === digits(after) && quotes(before) === quotes(after);
}

export function polishUseCases(deps: AppDeps, session: () => { readonly port: SqlPort; readonly path: string } | null, runner: ReturnType<typeof modelRunner>, extra: { readonly lock?: ChapterLockFn; readonly pricing?: () => Promise<{ readonly model: string; readonly prices: Prices | undefined } | null> } = {}) {
  const ctx = () => ({ now: deps.clock.now() });
  const lock: ChapterLockFn = extra.lock ?? ((_chapterId, f) => f());

  async function polish(port: SqlPort, path: string, chapterId: string, options: CallOptions): Promise<Result<PolishOutcome, AppError>> {
    const [work, chapters, plan, loaded, entities, skills] = await Promise.all([getProject(port), listChapters(port, 'normal'), getChapterPlan(port, chapterId), listParagraphs(port, chapterId), listEntities(port), skillsForStage(port, 'writing', deps)]);
    if (!work.ok) return err(repo(work.error));
    if (!chapters.ok) return err(repo(chapters.error));
    if (!plan.ok) return err(repo(plan.error));
    if (!loaded.ok) return err(repo(loaded.error));
    if (!entities.ok) return err(repo(entities.error));
    if (!skills.ok) return err(repo(skills.error));
    const chapter = chapters.value.find((c) => c.id === chapterId);
    if (chapter === undefined) return err(repo({ code: 'not_found' }));
    const draft = await deps.drafts.read(path, chapterId);
    if (draft.ok && draft.value !== null) return err(settings(`“${chapter.title}”有未保存的修改：请先保存，修订读的是已保存的正文`));
    let paragraphs: readonly SavedParagraph[] = loaded.value;
    const filled = paragraphs.filter((p) => p.text.trim() !== '');
    if (filled.length === 0) return err(settings(`“${chapter.title}”还没有正文`));

    // 程序统计出的毛病就是给模型的反馈（与审核的文风检查同一套规则）。
    const names = entities.value.flatMap((e) => [e.name, ...e.aliases]);
    const index = chapters.value.findIndex((c) => c.id === chapterId);
    const style = await recentStyle(port, chapters.value, index, { names });
    if (!style.ok) return err(repo(style.error));
    const issues = styleChecks(filled, {
      names,
      overused: style.value.ledger.overused.map((t) => t.term),
      overusedOpenings: style.value.ledger.overusedOpenings.map((t) => t.term),
      previousEndings: style.value.ledger.endings,
      dialogueTarget: dialogueTargetOf(plan.value?.rhythm ?? null),
    });
    const feedback = [...new Set(issues.map((i) => i.description))];
    if (feedback.length === 0) return ok({ status: 'polished', groups: 0, changed: 0, skipped: [], feedback, reason: null });

    const polishSkills = skills.value.filter((s) => s.key === POLISH_SKILL_KEY).map((s) => ({ name: s.name, description: s.description, text: s.text }));
    const avoidPhrases = effectiveAvoidPhrases(work.value?.avoidPhrases ?? null);
    const groups = groupParagraphs(filled);
    const skipped: string[] = [];
    let changed = 0;
    let snapshotTaken = false;
    const runId = deps.ids.next();
    const aborted = () => options.signal?.aborted === true;
    for (const [g, group] of groups.entries()) {
      if (aborted()) return ok({ status: 'cancelled', groups: groups.length, changed, skipped, feedback, reason: null });
      const prompt = renderWriterPolish({
        title: work.value?.title ?? '',
        chapterTitle: chapter.title,
        skills: polishSkills,
        avoidPhrases,
        feedback,
        paragraphs: group.map((p, i) => ({ label: label(i), text: p.text })),
      });
      if (!prompt.ok) return err(settings(prompt.error));
      const chars = group.reduce((n, p) => n + p.text.length, 0);
      const result = await runner.text({ prompt: prompt.value, maxOutputTokens: chars * 2 + THINKING_ALLOWANCE, effort: 'medium', stepKey: `polish:${chapterId}:${runId}:${g}` }, options);
      if (!result.ok) return ok({ status: aborted() ? 'cancelled' : 'stopped', groups: groups.length, changed, skipped, feedback, reason: result.error.code === 'settings' ? result.error.detail : '调用模型失败' });
      if (result.value.outcome === 'cancelled') return ok({ status: 'cancelled', groups: groups.length, changed, skipped, feedback, reason: null });
      if (result.value.outcome === 'refused' || result.value.outcome === 'truncated') {
        skipped.push(`第 ${g + 1} 组：${result.value.outcome === 'refused' ? '模型拒绝了' : '输出被截断'}`);
        continue;
      }
      const texts = parsePolished(result.value.text, group.length);
      if (texts === null) {
        skipped.push(`第 ${g + 1} 组：模型输出的段落数或标签对不上`);
        continue;
      }
      for (const [i, p] of group.entries()) {
        const revised = texts[i] ?? '';
        if (revised === p.text) continue;
        if (!sameSubstance(p.text, revised, names)) {
          skipped.push(`第 ${g + 1} 组第 ${i + 1} 段：设定名、数字或对白的条数变了，没有写入`);
          continue;
        }
        if (!snapshotTaken) {
          const snapshot = await createSnapshot(port, { id: deps.ids.next(), chapterId, reason: 'writer' }, ctx());
          if (!snapshot.ok) return err(repo(snapshot.error));
          snapshotTaken = true;
        }
        const current = paragraphs.find((x) => x.id === p.id);
        if (current === undefined) continue;
        const whole = { from: { paragraphId: current.id, offset: 0 }, to: { paragraphId: current.id, offset: current.text.length } };
        const planned = planRangeReplace(paragraphs, whole, { text: revised, ai: [{ start: 0, end: revised.length }], unedited: true }, () => deps.ids.next());
        if (!planned.ok) {
          skipped.push(`第 ${g + 1} 组第 ${i + 1} 段：${planned.error}`);
          continue;
        }
        const applied = await applyRangeReplace(port, chapterId, planned.value, ctx());
        if (!applied.ok) {
          if (applied.error.code === 'conflict') return ok({ status: 'stopped', groups: groups.length, changed, skipped, feedback, reason: `“${chapter.title}”在修订过程中被修改，写手已停下` });
          return err(repo(applied.error));
        }
        const after = await listParagraphs(port, chapterId);
        if (!after.ok) return err(repo(after.error));
        paragraphs = after.value;
        changed += 1;
      }
    }
    return ok({ status: 'polished', groups: groups.length, changed, skipped, feedback, reason: null });
  }

  return {
    /** 给一章做第二遍修订（写手锁内：写作或修订中的章不改）。 */
    polishChapter(chapterId: string, options: CallOptions = {}): Promise<Result<PolishOutcome, AppError>> {
      const s = session();
      if (s === null) return Promise.resolve(err({ code: 'no_work' }));
      return lock(chapterId, () => polish(s.port, s.path, chapterId, options));
    },

    /** 范围内各章正文合起来的文风统计（全书体检的报告用），不调用模型。 */
    async styleReport(chapterIds: readonly string[]): Promise<Result<StyleReport, AppError>> {
      const s = session();
      if (s === null) return err({ code: 'no_work' });
      const [chapters, entities] = await Promise.all([listChapters(s.port, 'normal'), listEntities(s.port)]);
      if (!chapters.ok) return err(repo(chapters.error));
      if (!entities.ok) return err(repo(entities.error));
      const wanted = new Set(chapterIds);
      const items: LedgerChapter[] = [];
      for (const c of chapters.value.filter((x) => wanted.has(x.id))) {
        const paragraphs = await listParagraphs(s.port, c.id);
        if (!paragraphs.ok) return err(repo(paragraphs.error));
        const texts = paragraphs.value.map((x) => x.text).filter((t) => t.trim() !== '');
        if (texts.length > 0) items.push({ title: c.title, paragraphs: texts });
      }
      const ledger = styleLedger(items, entities.value.flatMap((e) => [e.name, ...e.aliases]), { window: items.length });
      const endings: Record<string, number> = {};
      for (const e of ledger.endings) endings[e] = (endings[e] ?? 0) + 1;
      const cvs = ledger.chapters.map((c) => c.sentenceCv);
      return ok({
        words: ledger.words,
        dialogueRatio: ledger.dialogueRatio,
        sentenceCv: cvs.length === 0 ? 0 : cvs.reduce((a, b) => a + b, 0) / cvs.length,
        endings,
        overused: [...ledger.overused, ...ledger.overusedOpenings.map((t) => ({ ...t, term: `句首“${t.term}……”` }))].map((t) => ({ term: t.term, count: t.count, chapters: t.chapters })),
      });
    },

    /** 预计用量：按各章字数估调用数（每约 1,500 字一次）；没有正文的章按 words 估。 */
    async quotePolish(chapterIds: readonly string[], words: number = 3_000): Promise<Result<PolishQuote, AppError>> {
      const s = session();
      if (s === null) return err({ code: 'no_work' });
      let chars = 0;
      for (const id of chapterIds) {
        const paragraphs = await listParagraphs(s.port, id);
        if (!paragraphs.ok) return err(repo(paragraphs.error));
        const n = paragraphs.value.reduce((sum, p) => sum + visibleLength(p.text), 0);
        chars += n > 0 ? n : words;
      }
      const calls = Math.ceil(chars / POLISH_GROUP_CHARS);
      const inputTokens = calls * POLISH_INPUT_TOKENS + Math.round(chars * TOKENS_PER_CHAR);
      const outputTokens = Math.round(chars * TOKENS_PER_CHAR) + calls * THINKING_TOKENS_PER_CALL;
      const price = extra.pricing === undefined ? null : await extra.pricing();
      return ok({ chapters: chapterIds.length, calls, inputTokens, outputTokens, costUsd: costOf({ inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 }, price?.prices) });
    },
  };
}

/** 估算用量时每写一章另计的修订调用（偏好开着时）：按每章约 3,000 字两组。 */
export const POLISH_CALLS_PER_CHAPTER = 2;
export const POLISH_INPUT_PER_CHAPTER = POLISH_CALLS_PER_CHAPTER * POLISH_INPUT_TOKENS + 4_500;
export const POLISH_OUTPUT_PER_CHAPTER = 4_500;
