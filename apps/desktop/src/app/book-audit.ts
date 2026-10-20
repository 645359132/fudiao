// 全书体检的跨章连贯检查（需求 B80，施工文档 M6-03）：先由各章的长篇记忆找出可疑的两章（book_audit），
// 再逐条读这两章的原文定位到段落（continuity_check），问题记为跨章连贯检查（continuity）的审核问题，
// 锚在后一章的段落上，依据是前一章的段落（带当时的版本，那一段改过后问题过期）。
import { createEntityMatcher } from '@fudiao/editor';
import type { CallOptions } from '@fudiao/llm';
import { BookAuditOutput, ChapterReviewOutput, renderBookAudit, renderContinuityCheck } from '@fudiao/prompts';
import { err, ok, type Result } from '@fudiao/shared';
import {
  findCallByRequestHash,
  getProject,
  listChapterMemories,
  listChapters,
  listChaptersWithText,
  listEntities,
  listFacts,
  listIssues,
  listParagraphs,
  listRelationships,
  replacePendingIssues,
  type Chapter,
  type IssueEvidence,
  type RepoError,
  type SavedParagraph,
  type SqlPort,
} from '@fudiao/store';
import { dropHandled, paragraphLabel, resolveModelIssues, type ProgramIssue } from '@fudiao/writing';
import { z } from 'zod';
import type { AppError } from './errors';
import { ENTITY_KIND_LABEL } from './labels';
import { THINKING_ALLOWANCE, type modelRunner } from './model-runner';
import type { AppDeps } from './ports';

/** 带给疑点查找的设定与事实的上限。 */
const MAX_AUDIT_ENTITIES = 60;
const MAX_AUDIT_FACTS = 60;
const MAX_AUDIT_RELATIONS = 60;
/** 核对一处疑点时每章最多给出的字数：太长时给开头与结尾的段落。 */
export const CONTINUITY_CHAPTER_CHARS = 12_000;
const MAX_CONTINUITY_ENTITIES = 30;
const AUDIT_OUTPUT_TOKENS = 4_000 + THINKING_ALLOWANCE;
const CONTINUITY_OUTPUT_TOKENS = 3_000 + THINKING_ALLOWANCE;

/** 一处疑点：前后两章（标识）、类别、哪里对不上与严重程度。 */
export const AuditSuspect = z.object({
  earlierId: z.string(),
  laterId: z.string(),
  kind: z.enum(['character', 'timeline', 'setting_conflict']),
  about: z.string(),
  severity: z.enum(['high', 'medium', 'low']),
});
export type AuditSuspect = z.infer<typeof AuditSuspect>;

/** 一处疑点核对的结果：确认的问题（还没写入）、丢弃的条数与调用记录。 */
export type LocatedSuspect = { readonly laterId: string; readonly issues: readonly ProgramIssue[]; readonly dropped: number; readonly llmCallId: string | null };

const repo = (error: RepoError): AppError => ({ code: 'repo', error });
const settings = (detail: string): AppError => ({ code: 'settings', detail });
const HANDLED = ['ignored', 'fixed', 'sent_to_writer'] as const;

/**
 * 一章的段落太长时只留开头与结尾，各占一半字数。第一段与最后一段总是留下（超长时截短正文），
 * 不然整章只有一两个巨段（导入的文本）时什么也不给模型看，疑点会被当作“没有矛盾”。
 */
function clipParagraphs(paragraphs: readonly SavedParagraph[], limit: number): { readonly kept: readonly SavedParagraph[]; readonly clipped: boolean } {
  const total = paragraphs.reduce((n, p) => n + p.text.length, 0);
  if (total <= limit) return { kept: paragraphs, clipped: false };
  const half = Math.floor(limit / 2);
  const shorten = (p: SavedParagraph): SavedParagraph => (p.text.length > half ? { ...p, text: p.text.slice(0, half) } : p);
  const head: SavedParagraph[] = [];
  const tail: SavedParagraph[] = [];
  let used = 0;
  for (const p of paragraphs) {
    if (used + p.text.length > half) {
      if (head.length === 0) head.push(shorten(p));
      break;
    }
    head.push(p);
    used += p.text.length;
  }
  used = 0;
  for (const p of [...paragraphs].reverse()) {
    if (head.some((h) => h.id === p.id)) break;
    if (used + p.text.length > half) {
      if (tail.length === 0) tail.unshift(shorten(p));
      break;
    }
    tail.unshift(p);
    used += p.text.length;
  }
  return { kept: [...head, ...tail], clipped: true };
}

export function bookAuditUseCases(deps: AppDeps, project: () => SqlPort | null, runner: ReturnType<typeof modelRunner>) {
  const ctx = () => ({ now: deps.clock.now() });

  async function callId(port: SqlPort, attempts: readonly { readonly requestHash?: string }[]): Promise<string | null> {
    const hash = attempts.at(-1)?.requestHash;
    if (hash === undefined) return null;
    const call = await findCallByRequestHash(port, hash);
    return call.ok ? (call.value?.id ?? null) : null;
  }

  return {
    /**
     * 体检范围内、已有正文的章节，按书中顺序。from、to 为章节标识（null 为从头、到尾）；对不上的标识说明原因。
     */
    async auditChapters(from: string | null, to: string | null): Promise<Result<readonly Chapter[], AppError>> {
      const port = project();
      if (port === null) return err({ code: 'no_work' });
      const [chapters, withText] = await Promise.all([listChapters(port, 'normal'), listChaptersWithText(port)]);
      if (!chapters.ok) return err(repo(chapters.error));
      if (!withText.ok) return err(repo(withText.error));
      const at = (id: string | null, fallback: number) => (id === null ? fallback : chapters.value.findIndex((c) => c.id === id));
      const start = at(from, 0);
      const end = at(to, chapters.value.length - 1);
      if (start < 0 || end < 0) return err(settings('体检范围里的章节找不到了（可能移进了回收站）：请重新选择范围'));
      const hasText = new Set(withText.value);
      return ok(chapters.value.slice(Math.min(start, end), Math.max(start, end) + 1).filter((c) => hasText.has(c.id)));
    },

    /**
     * 由各章的长篇记忆找出跨章的疑点（不写入作品）。没有长篇记忆的章节用作者写的章节梗概。
     * 模型给的章节标签对不上、或前后颠倒的疑点丢弃，丢弃的条数一并返回。
     */
    async draftSuspects(chapterIds: readonly string[], stepKey: string, options: CallOptions = {}): Promise<Result<{ readonly suspects: AuditSuspect[]; readonly dropped: number }, AppError>> {
      const port = project();
      if (port === null) return err({ code: 'no_work' });
      if (chapterIds.length < 2) return ok({ suspects: [], dropped: 0 });
      const [work, chapters, memories, entities, relations, facts] = await Promise.all([
        getProject(port),
        listChapters(port, 'normal'),
        listChapterMemories(port),
        listEntities(port),
        listRelationships(port),
        listFacts(port),
      ]);
      if (!work.ok) return err(repo(work.error));
      if (!chapters.ok) return err(repo(chapters.error));
      if (!memories.ok) return err(repo(memories.error));
      if (!entities.ok) return err(repo(entities.error));
      if (!relations.ok) return err(repo(relations.error));
      if (!facts.ok) return err(repo(facts.error));
      const nameOf = new Map(entities.value.map((e) => [e.id, e.name]));
      const titleOf = new Map(chapters.value.map((c) => [c.id, c.title]));
      const memoryOf = new Map(memories.value.map((m) => [m.chapterId, m]));
      const wanted = new Set(chapterIds);
      const audited = chapters.value.filter((c) => wanted.has(c.id));
      const labels = new Map(audited.map((c, i) => [`C${i + 1}`, c.id]));
      const characters = entities.value.filter((e) => e.kind === 'character');
      const others = entities.value.filter((e) => e.kind !== 'character');
      const range = (r: { readonly validFromChapterId: string | null; readonly validToChapterId: string | null }) =>
        r.validFromChapterId === null && r.validToChapterId === null ? '' : `（${r.validFromChapterId === null ? '' : `《${titleOf.get(r.validFromChapterId) ?? ''}》起`}${r.validToChapterId === null ? '' : `至《${titleOf.get(r.validToChapterId) ?? ''}》`}）`;
      // 只带范围末章之前已经成立的事实与关系：第 50 章才成立的事实不该拿来判前 10 章“矛盾”。
      const position = new Map(chapters.value.map((c, i) => [c.id, i]));
      const last = Math.max(...audited.map((c) => position.get(c.id) ?? 0));
      const startedByRange = (fromChapterId: string | null) => fromChapterId === null || (position.get(fromChapterId) ?? 0) <= last;
      const prompt = renderBookAudit({
        title: work.value?.title ?? '',
        entities: [...characters, ...others].slice(0, MAX_AUDIT_ENTITIES).map((e) => ({ name: e.name, kind: ENTITY_KIND_LABEL[e.kind], locked: e.locked, description: e.description })),
        relations: relations.value
          .filter((r) => startedByRange(r.validFromChapterId))
          .slice(0, MAX_AUDIT_RELATIONS)
          .map((r) => `${r.mutual ? `${nameOf.get(r.fromId) ?? ''}与${nameOf.get(r.toId) ?? ''}：${r.label}` : `${nameOf.get(r.fromId) ?? ''}是${nameOf.get(r.toId) ?? ''}的${r.label}`}${range(r)}`),
        facts: facts.value
          .filter((f) => f.status === 'confirmed' && f.kind === 'world' && startedByRange(f.validFromChapterId))
          .slice(0, MAX_AUDIT_FACTS)
          .map((f) => f.content),
        chapters: audited.map((c, i) => {
          const memory = memoryOf.get(c.id);
          return {
            label: `C${i + 1}`,
            title: c.title,
            summary: memory?.summary ?? c.summary,
            cast: Object.entries(memory?.castState ?? {}).flatMap(([id, state]) => (nameOf.has(id) ? [{ name: nameOf.get(id) ?? '', state }] : [])),
            threads: memory?.openThreads ?? [],
          };
        }),
      });
      if (!prompt.ok) return err(settings(prompt.error));
      const result = await runner.structured({ prompt: prompt.value, maxOutputTokens: AUDIT_OUTPUT_TOKENS, effort: 'medium', stepKey }, BookAuditOutput, options);
      if (!result.ok) return result;
      const order = new Map(audited.map((c, i) => [c.id, i]));
      const suspects: AuditSuspect[] = [];
      let dropped = 0;
      for (const s of result.value.value.suspects) {
        const earlierId = labels.get(s.earlier.trim().toUpperCase());
        const laterId = labels.get(s.later.trim().toUpperCase());
        if (earlierId === undefined || laterId === undefined || (order.get(earlierId) ?? 0) >= (order.get(laterId) ?? 0) || s.about.trim() === '') {
          dropped += 1;
          continue;
        }
        suspects.push({ earlierId, laterId, kind: s.kind, about: s.about.trim(), severity: s.severity });
      }
      return ok({ suspects, dropped });
    },

    /**
     * 读前后两章的原文核对一处疑点，定位到后一章的段落；依据须有前一章的段落，没有的丢弃。
     * 不写入作品，由 saveContinuityIssues 一并写。
     */
    async locateSuspect(suspect: AuditSuspect, stepKey: string, options: CallOptions = {}): Promise<Result<LocatedSuspect, AppError>> {
      const port = project();
      if (port === null) return err({ code: 'no_work' });
      const [work, chapters, entities, earlierParagraphs, laterParagraphs] = await Promise.all([
        getProject(port),
        listChapters(port, 'normal'),
        listEntities(port),
        listParagraphs(port, suspect.earlierId),
        listParagraphs(port, suspect.laterId),
      ]);
      if (!work.ok) return err(repo(work.error));
      if (!chapters.ok) return err(repo(chapters.error));
      if (!entities.ok) return err(repo(entities.error));
      if (!earlierParagraphs.ok) return err(repo(earlierParagraphs.error));
      if (!laterParagraphs.ok) return err(repo(laterParagraphs.error));
      const earlierChapter = chapters.value.find((c) => c.id === suspect.earlierId);
      const laterChapter = chapters.value.find((c) => c.id === suspect.laterId);
      if (earlierChapter === undefined || laterChapter === undefined) return err(settings('疑点涉及的章节已经不在了'));
      const earlier = clipParagraphs(
        earlierParagraphs.value.filter((p) => p.text.trim() !== ''),
        CONTINUITY_CHAPTER_CHARS,
      );
      const later = clipParagraphs(
        laterParagraphs.value.filter((p) => p.text.trim() !== ''),
        CONTINUITY_CHAPTER_CHARS,
      );
      if (later.kept.length === 0 || earlier.kept.length === 0) return ok({ laterId: suspect.laterId, issues: [], dropped: 0, llmCallId: null });
      // 设定：两章正文里提到的，按提到的次数。
      const text = [...earlier.kept, ...later.kept].map((p) => p.text).join('\n');
      const mentions = new Map<string, number>();
      for (const hit of createEntityMatcher(entities.value.map((e) => ({ id: e.id, kind: e.kind, name: e.name, aliases: e.aliases }))).find(text)) {
        mentions.set(hit.entityId, (mentions.get(hit.entityId) ?? 0) + 1);
      }
      const mentioned = entities.value
        .filter((e) => mentions.has(e.id))
        .sort((a, b) => (mentions.get(b.id) ?? 0) - (mentions.get(a.id) ?? 0))
        .slice(0, MAX_CONTINUITY_ENTITIES);
      const evidence = new Map<string, IssueEvidence>();
      mentioned.forEach((e, i) => evidence.set(`E${i + 1}`, { type: 'entity', id: e.id }));
      earlier.kept.forEach((p, i) => evidence.set(`A${i + 1}`, { type: 'paragraph', id: p.id, chapterId: suspect.earlierId, version: p.version }));
      const prompt = renderContinuityCheck({
        title: work.value?.title ?? '',
        about: suspect.about,
        entities: mentioned.map((e, i) => ({ label: `E${i + 1}`, name: e.name, kind: ENTITY_KIND_LABEL[e.kind], locked: e.locked, description: e.description })),
        earlierTitle: earlierChapter.title,
        earlier: earlier.kept.map((p, i) => ({ label: `A${i + 1}`, text: p.text })),
        earlierClipped: earlier.clipped,
        laterTitle: laterChapter.title,
        later: later.kept.map((p, i) => ({ label: paragraphLabel(i), text: p.text })),
        laterClipped: later.clipped,
      });
      if (!prompt.ok) return err(settings(prompt.error));
      const result = await runner.structured({ prompt: prompt.value, maxOutputTokens: CONTINUITY_OUTPUT_TOKENS, effort: 'medium', stepKey }, ChapterReviewOutput, options);
      if (!result.ok) return result;
      const resolved = resolveModelIssues(result.value.value.issues, { paragraphs: later.kept, evidence });
      // 跨章的问题须有前一章的段落作依据。
      const issues = resolved.issues.filter((i) => i.evidence.some((e) => e.type === 'paragraph' && e.chapterId === suspect.earlierId));
      const dropped = resolved.dropped.filter((d) => d.reason !== 'duplicate').length + (resolved.issues.length - issues.length);
      return ok({ laterId: suspect.laterId, issues, dropped, llmCallId: await callId(port, result.value.attempts) });
    },

    /**
     * 把这次体检确认的问题写进各章：同一章仍待处理的连贯问题换成这一次的；作者处理过的同一处问题不再提出。
     * 体检范围内这次没有问题的章节，旧的待处理连贯问题同样换掉（标为过期）。返回写入的条数。
     */
    async saveContinuityIssues(chapterIds: readonly string[], located: readonly LocatedSuspect[]): Promise<Result<number, AppError>> {
      const port = project();
      if (port === null) return err({ code: 'no_work' });
      let saved = 0;
      for (const chapterId of chapterIds) {
        const handled = await listIssues(port, chapterId, HANDLED);
        if (!handled.ok) return err(repo(handled.error));
        const mine = located.filter((l) => l.laterId === chapterId);
        const inputs = mine.flatMap((l) =>
          dropHandled(l.issues, handled.value).map((i) => ({
            id: deps.ids.next(),
            chapterId,
            kind: i.kind,
            severity: i.severity,
            anchor: i.anchor,
            evidence: i.evidence,
            description: i.description,
            suggestion: i.suggestion,
            source: 'continuity' as const,
            llmCallId: l.llmCallId,
          })),
        );
        const done = await replacePendingIssues(port, chapterId, 'continuity', inputs, ctx());
        if (!done.ok) return err(repo(done.error));
        saved += inputs.length;
      }
      return ok(saved);
    },
  };
}
