// 审核代理的用例（需求 B64，施工文档第五章“写手与审核”）。
// 先做程序检查（packages/writing，纯函数），再做模型审核；模型用标签指代段落与依据，
// 定位不到原文、依据不存在的问题丢弃。问题是派生结论（硬性规则 21）：记录段落版本与调用记录，段落改过后标为过期。
// 作者可以忽略、标为已修改，或交给写手修订：写手只改问题所在的段落，写入前保存快照。
import type { CallOptions } from '@fudiao/llm';
import { createEntityMatcher } from '@fudiao/editor';
import { ChapterReviewOutput, renderChapterReview, renderWriterRevise } from '@fudiao/prompts';
import { err, ok, type Result } from '@fudiao/shared';
import {
  applyRangeReplace,
  createSnapshot,
  findCallByRequestHash,
  getChapterPlan,
  getIssue,
  getProject,
  listChapterMemories,
  listChapters,
  listChaptersWithText,
  listEntities,
  listFacts,
  listForeshadows,
  listIssues,
  listParagraphs,
  planRangeReplace,
  replacePendingIssues,
  reviewStaleIssues,
  setIssueStatus,
  setPlanStatus,
  type Chapter,
  type ChapterPlan,
  type Entity,
  type Fact,
  type Foreshadow,
  type IssueEvidence,
  type RepoError,
  type ReviewIssue,
  type SavedParagraph,
  type SqlPort,
} from '@fudiao/store';
import {
  dropHandled,
  effectiveAvoidPhrases,
  foreshadowsForChapter,
  normalizePunctuation,
  paragraphLabel,
  resolveModelIssues,
  runProgramChecks,
  splitParagraphs,
  type PlanItem,
  type ProgramIssue,
} from '@fudiao/writing';
import type { AppError } from './errors';
import { THINKING_ALLOWANCE, type modelRunner } from './model-runner';
import type { AppDeps } from './ports';

/** 带给审核的设定与事实的上限；出场人物优先，其余按在正文中出现的次数。 */
export const MAX_REVIEW_ENTITIES = 40;
export const MAX_REVIEW_FACTS = 40;
/** 前文梗概最多带多少字，超出时先去掉最远的章节。 */
export const REVIEW_MEMORY_CHARS = 6000;
/** 审核的输出上限：每条问题约一百字，另留出思考的余量。 */
export const REVIEW_OUTPUT_TOKENS = 8_000 + THINKING_ALLOWANCE;

const ENTITY_KIND: Readonly<Record<Entity['kind'], string>> = { character: '人物', location: '地点', organization: '组织', item: '物品', rule: '世界规则' };

/** 审核问题与它的依据（已写成文字，给作者看，也交给写手修订）。 */
export type ReviewIssueView = ReviewIssue & { readonly evidenceText: readonly string[] };

export type ReviewOutcome = {
  /** 这一章现在待处理的问题，严重的在前。 */
  readonly issues: readonly ReviewIssueView[];
  /** 模型审核是否完成；没有完成时 reason 写明原因，程序检查的问题仍然保留。 */
  readonly modelReviewed: boolean;
  readonly reason: string | null;
  /** 模型提出、但定位不到原文或依据不存在而丢弃的问题数。 */
  readonly dropped: number;
};

export type RevisionOutcome = { readonly chapterId: string; readonly issues: readonly ReviewIssueView[]; readonly paragraphs: readonly SavedParagraph[] };

const repo = (error: RepoError): AppError => ({ code: 'repo', error });
const settings = (detail: string): AppError => ({ code: 'settings', detail });
const HANDLED = ['ignored', 'fixed', 'sent_to_writer'] as const;

type Materials = {
  readonly title: string;
  readonly avoidPhrases: readonly string[];
  readonly chapter: Chapter;
  readonly chapters: readonly Chapter[];
  readonly order: ReadonlyMap<string, number>;
  readonly plan: ChapterPlan | null;
  readonly planItem: PlanItem;
  readonly paragraphs: readonly SavedParagraph[];
  readonly entities: readonly Entity[];
  readonly facts: readonly Fact[];
  readonly foreshadows: readonly Foreshadow[];
};

export function reviewUseCases(deps: AppDeps, session: () => { readonly port: SqlPort; readonly path: string } | null, runner: ReturnType<typeof modelRunner>) {
  const ctx = () => ({ now: deps.clock.now() });

  async function materials(port: SqlPort, chapterId: string): Promise<Result<Materials, AppError>> {
    const [work, chapters, plan, paragraphs, entities, facts, foreshadows] = await Promise.all([
      getProject(port),
      listChapters(port, 'normal'),
      getChapterPlan(port, chapterId),
      listParagraphs(port, chapterId),
      listEntities(port),
      listFacts(port),
      listForeshadows(port),
    ]);
    if (!work.ok) return err(repo(work.error));
    if (!chapters.ok) return err(repo(chapters.error));
    if (!plan.ok) return err(repo(plan.error));
    if (!paragraphs.ok) return err(repo(paragraphs.error));
    if (!entities.ok) return err(repo(entities.error));
    if (!facts.ok) return err(repo(facts.error));
    if (!foreshadows.ok) return err(repo(foreshadows.error));
    const chapter = chapters.value.find((c) => c.id === chapterId);
    if (chapter === undefined) return err(repo({ code: 'not_found' }));
    return ok({
      title: work.value?.title ?? '',
      avoidPhrases: effectiveAvoidPhrases(work.value?.avoidPhrases ?? null),
      chapter,
      chapters: chapters.value,
      order: new Map(chapters.value.map((c, i) => [c.id, i])),
      plan: plan.value,
      // 作者手写、没有计划的章节也能审核：没有要埋要收的伏笔，账本中未回收的伏笔仍不得说破。
      planItem: plan.value ?? { chapterId, castIds: [], foreshadowPlant: [], foreshadowPayoff: [], status: 'todo' },
      paragraphs: paragraphs.value,
      entities: entities.value,
      facts: facts.value,
      foreshadows: foreshadows.value,
    });
  }

  /** 依据写成文字；已经删掉的条目略去。 */
  function evidenceText(evidence: readonly IssueEvidence[], m: Pick<Materials, 'entities' | 'facts' | 'foreshadows' | 'paragraphs'>): string[] {
    return evidence.flatMap((e) => {
      switch (e.type) {
        case 'entity': {
          const entity = m.entities.find((x) => x.id === e.id);
          return entity === undefined ? [] : [`设定 ${entity.name}${entity.description.trim() === '' ? '' : `：${entity.description.trim()}`}`];
        }
        case 'fact': {
          const fact = m.facts.find((x) => x.id === e.id);
          return fact === undefined ? [] : [`事实：${fact.content}`];
        }
        case 'foreshadow': {
          const f = m.foreshadows.find((x) => x.id === e.id);
          return f === undefined ? [] : [`伏笔 ${f.title}：${f.content}${f.reveal.trim() === '' ? '' : `（揭晓的内容：${f.reveal.trim()}）`}`];
        }
        case 'paragraph': {
          const p = m.paragraphs.find((x) => x.id === e.id);
          return p === undefined ? [] : [`本章段落：${p.text.length > 40 ? `${p.text.slice(0, 40)}…` : p.text}`];
        }
        case 'plan':
          return ['章节计划'];
      }
    });
  }

  async function pendingView(port: SqlPort, chapterId: string, m: Pick<Materials, 'entities' | 'facts' | 'foreshadows' | 'paragraphs'>): Promise<Result<ReviewIssueView[], AppError>> {
    const stale = await reviewStaleIssues(port, chapterId, ctx());
    if (!stale.ok) return err(repo(stale.error));
    const pending = await listIssues(port, chapterId);
    return pending.ok ? ok(pending.value.map((i) => ({ ...i, evidenceText: evidenceText(i.evidence, m) }))) : err(repo(pending.error));
  }

  /** 程序检查（不调用模型），去掉作者处理过的问题后，换掉这一章仍待处理的程序问题。返回这一次的问题。 */
  async function refreshProgramIssues(port: SqlPort, m: Materials): Promise<Result<{ program: ProgramIssue[]; handled: ReviewIssue[] }, AppError>> {
    const chapterId = m.chapter.id;
    const handled = await listIssues(port, chapterId, HANDLED);
    if (!handled.ok) return err(repo(handled.error));
    const program = dropHandled(
      runProgramChecks({
        chapterId,
        paragraphs: m.paragraphs.filter((p) => p.text.trim() !== ''),
        avoidPhrases: m.avoidPhrases,
        mustNotReveal: foreshadowsForChapter(m.planItem, m.foreshadows, m.order).mustNotReveal,
        foreshadows: m.foreshadows,
        order: m.order,
        cast: m.entities.filter((e) => m.planItem.castIds.includes(e.id)),
      }),
      handled.value,
    );
    const saved = await replacePendingIssues(port, chapterId, 'program', program.map(toInput(chapterId, 'program', null)), ctx());
    return saved.ok ? ok({ program, handled: handled.value }) : err(repo(saved.error));
  }

  const toInput = (chapterId: string, source: 'program' | 'model', llmCallId: string | null) => (i: ProgramIssue) => ({
    id: deps.ids.next(),
    chapterId,
    kind: i.kind,
    severity: i.severity,
    anchor: i.anchor,
    evidence: i.evidence,
    description: i.description,
    suggestion: i.suggestion,
    source,
    llmCallId,
  });

  return {
    /** 这一章待处理的问题；先把段落改过的问题标为过期。 */
    async reviewIssues(chapterId: string): Promise<Result<ReviewIssueView[], AppError>> {
      const s = session();
      if (s === null) return err({ code: 'no_work' });
      const m = await materials(s.port, chapterId);
      return m.ok ? pendingView(s.port, chapterId, m.value) : m;
    },

    /**
     * 审核一章（写手所写与作者手写均可）。重新审核时，仍待处理的旧问题换成这一次的；作者处理过的问题不再提出。
     * 模型审核没有完成（没有模型、调用失败、取消）时，程序检查的问题仍然保存，结果中写明原因。
     */
    async reviewChapter(chapterId: string, options: CallOptions = {}): Promise<Result<ReviewOutcome, AppError>> {
      const s = session();
      if (s === null) return err({ code: 'no_work' });
      const { port } = s;
      const loaded = await materials(port, chapterId);
      if (!loaded.ok) return loaded;
      const m = loaded.value;
      const paragraphs = m.paragraphs.filter((p) => p.text.trim() !== '');
      if (paragraphs.length === 0) return err(settings(`“${m.chapter.title}”还没有正文，没有可以审核的内容`));
      const draft = await deps.drafts.read(s.path, chapterId);
      if (draft.ok && draft.value !== null) return err(settings(`“${m.chapter.title}”有未保存的修改：请先保存，审核读的是已保存的正文`));

      const cast = m.entities.filter((e) => m.planItem.castIds.includes(e.id));
      const fs = foreshadowsForChapter(m.planItem, m.foreshadows, m.order);
      const checked = await refreshProgramIssues(port, m);
      if (!checked.ok) return checked;
      const { program, handled } = checked.value;
      const finish = async (modelReviewed: boolean, reason: string | null, dropped: number): Promise<Result<ReviewOutcome, AppError>> => {
        const issues = await pendingView(port, chapterId, m);
        return issues.ok ? ok({ issues: issues.value, modelReviewed, reason, dropped }) : issues;
      };

      // 设定：出场人物在前，其余按在正文中出现的次数；事实：已确认、适用于本章、与这些设定有关。
      const text = paragraphs.map((p) => p.text).join('\n');
      const mentions = new Map<string, number>();
      for (const hit of createEntityMatcher(m.entities.map((e) => ({ id: e.id, kind: e.kind, name: e.name, aliases: e.aliases }))).find(text)) {
        mentions.set(hit.entityId, (mentions.get(hit.entityId) ?? 0) + 1);
      }
      const castIds = new Set(cast.map((c) => c.id));
      const others = m.entities.filter((e) => !castIds.has(e.id) && mentions.has(e.id)).sort((a, b) => (mentions.get(b.id) ?? 0) - (mentions.get(a.id) ?? 0));
      const entities = [...cast, ...others].slice(0, MAX_REVIEW_ENTITIES);
      const entityIds = new Set(entities.map((e) => e.id));
      const index = m.order.get(chapterId) ?? 0;
      const at = (id: string | null) => (id === null ? undefined : m.order.get(id));
      const facts = m.facts
        .filter((f) => {
          if (f.status !== 'confirmed') return false;
          const from = at(f.validFromChapterId);
          const to = at(f.validToChapterId);
          if ((from !== undefined && from > index) || (to !== undefined && to < index)) return false;
          return f.subjectIds.some((id) => entityIds.has(id)) || (f.holderId !== null && entityIds.has(f.holderId));
        })
        .slice(0, MAX_REVIEW_FACTS);
      const nameOf = new Map(m.entities.map((e) => [e.id, e.name]));
      const factText = (f: Fact) => {
        const holder = f.holderId === null ? undefined : nameOf.get(f.holderId);
        if (holder === undefined || f.kind === 'world') return f.content;
        return `（${holder}${f.kind === 'belief' ? '的认知' : '的说法'}）${f.content}`;
      };

      const [memories, withText] = await Promise.all([listChapterMemories(port), listChaptersWithText(port)]);
      if (!memories.ok) return err(repo(memories.error));
      if (!withText.ok) return err(repo(withText.error));
      const hasText = new Set(withText.value);
      const memoryOf = new Map(memories.value.filter((x) => hasText.has(x.chapterId)).map((x) => [x.chapterId, x]));
      const stateOf = new Map<string, string>();
      const earlier: { title: string; summary: string }[] = [];
      let used = 0;
      for (const c of m.chapters.slice(0, index)) for (const [id, state] of Object.entries(memoryOf.get(c.id)?.castState ?? {})) stateOf.set(id, state);
      for (const c of m.chapters.slice(0, index).reverse()) {
        const summary = (memoryOf.get(c.id)?.summary ?? c.summary).trim();
        if (summary === '') continue;
        if (used + summary.length > REVIEW_MEMORY_CHARS) break;
        used += summary.length;
        earlier.unshift({ title: c.title, summary });
      }

      const roles: { readonly f: Foreshadow; readonly role: string }[] = [
        ...fs.toPlant.map((f) => ({ f, role: '本章要埋' })),
        ...fs.toPayoff.map((f) => ({ f, role: '本章要回收' })),
        ...fs.mustNotReveal.filter((f) => !fs.toPlant.some((x) => x.id === f.id)).map((f) => ({ f, role: '不得说破' })),
      ];
      const evidence = new Map<string, IssueEvidence>();
      const labelled = <T extends { readonly id: string }>(prefix: string, type: IssueEvidence['type'], items: readonly T[]) =>
        items.map((item, i) => {
          const label = `${prefix}${i + 1}`;
          evidence.set(label, { type, id: item.id });
          return { label, item };
        });
      const entityRefs = labelled('E', 'entity', entities);
      const factRefs = labelled('F', 'fact', facts);
      const foreshadowRefs = labelled('S', 'foreshadow', roles.map((r) => ({ id: r.f.id, ...r })));
      if (m.plan !== null) evidence.set('plan', { type: 'plan', id: chapterId });

      const prompt = renderChapterReview({
        title: m.title,
        chapterTitle: m.chapter.title,
        entities: entityRefs.map(({ label, item }) => ({
          label,
          name: item.name,
          kind: ENTITY_KIND[item.kind],
          locked: item.locked,
          description: [item.description.trim(), ...item.attributes.map((a) => `${a.label}：${a.value}`)].filter((x) => x !== '').join('；'),
          state: stateOf.get(item.id) ?? '',
        })),
        facts: factRefs.map(({ label, item }) => ({ label, content: factText(item) })),
        memories: earlier,
        plan: m.plan === null ? null : { goal: m.plan.goal, treatment: m.plan.treatment, cast: cast.map((c) => c.name), beats: m.plan.beats },
        foreshadows: foreshadowRefs.map(({ label, item }) => ({
          label,
          title: item.f.title,
          role: item.role,
          content: item.f.content,
          // 要埋的伏笔同样不得说破，揭晓的内容一并给出。
          reveal: item.f.reveal,
        })),
        paragraphs: paragraphs.map((p, i) => ({ label: paragraphLabel(i), text: p.text })),
      });
      if (!prompt.ok) return err(settings(prompt.error));
      const result = await runner.structured({ prompt: prompt.value, maxOutputTokens: REVIEW_OUTPUT_TOKENS, effort: 'medium' }, ChapterReviewOutput, options);
      if (!result.ok) return finish(false, result.error.code === 'settings' ? result.error.detail : '调用模型失败', 0);

      const resolved = resolveModelIssues(result.value.value.issues, { paragraphs, evidence });
      // 程序检查已经指出的同一处问题不再重复。
      const model = dropHandled(dropHandled(resolved.issues, handled), program);
      const hash = result.value.attempts.at(-1)?.requestHash;
      const call = hash === undefined ? null : await findCallByRequestHash(port, hash);
      const callId = call?.ok === true ? (call.value?.id ?? null) : null;
      const savedModel = await replacePendingIssues(port, chapterId, 'model', model.map(toInput(chapterId, 'model', callId)), ctx());
      if (!savedModel.ok) return err(repo(savedModel.error));
      if (m.plan?.status === 'written') {
        const reviewed = await setPlanStatus(port, m.plan, 'reviewed', ctx());
        if (!reviewed.ok && reviewed.error.code !== 'conflict') return err(repo(reviewed.error));
      }
      return finish(true, null, resolved.dropped.filter((d) => d.reason !== 'duplicate').length);
    },

    /** 作者处理一条问题：忽略，或标为已经自己改好。 */
    async resolveIssue(issueId: string, status: 'ignored' | 'fixed'): Promise<Result<ReviewIssueView[], AppError>> {
      const s = session();
      if (s === null) return err({ code: 'no_work' });
      const issue = await getIssue(s.port, issueId);
      if (!issue.ok) return err(repo(issue.error));
      if (issue.value === null) return err(repo({ code: 'not_found' }));
      // 已经不在待处理里的（处理过，或正文改过后重新标出、换了标识）不再改，说清楚，免得以为处理了。
      if (issue.value.status !== 'pending') return err(settings('这条问题已经不在待处理里：处理过了，或正文改过后重新标出、换了标识'));
      const done = await setIssueStatus(s.port, issue.value, status, ctx());
      if (!done.ok) return err(repo(done.error));
      const m = await materials(s.port, issue.value.chapterId);
      return m.ok ? pendingView(s.port, issue.value.chapterId, m.value) : m;
    },

    /**
     * 交给写手修订：写手只改问题所在的那一段，写入前保存快照。这一段上其他指到具体文字的待处理问题一并交给它；
     * 针对整章、只是锚在这一段上的问题（例如计划中的人物没有出场）不算在内。
     * 修订后的段落记为 AI 生成，交出去的问题记为“已交写手修订”；随后重做程序检查，没改掉的规避词等会重新提出。
     */
    async reviseIssue(issueId: string, options: CallOptions = {}): Promise<Result<RevisionOutcome, AppError>> {
      const s = session();
      if (s === null) return err({ code: 'no_work' });
      const { port } = s;
      const found = await getIssue(port, issueId);
      if (!found.ok) return err(repo(found.error));
      if (found.value === null) return err(repo({ code: 'not_found' }));
      const chapterId = found.value.chapterId;
      const loaded = await materials(port, chapterId);
      if (!loaded.ok) return loaded;
      const m = loaded.value;
      const draft = await deps.drafts.read(s.path, chapterId);
      if (draft.ok && draft.value !== null) return err(settings(`“${m.chapter.title}”有未保存的修改：请先保存，写手不会覆盖你的修改`));
      const pending = await pendingView(port, chapterId, m);
      if (!pending.ok) return pending;
      const target = pending.value.find((i) => i.id === issueId);
      if (target === undefined) return err(settings('这条问题已经处理过，或它所在的段落已经改过'));
      const at = m.paragraphs.findIndex((p) => p.id === target.anchor.paragraphId);
      const paragraph = m.paragraphs[at];
      if (paragraph === undefined) return err(settings('找不到这条问题所在的段落'));
      const group = pending.value.filter((i) => i.id === target.id || (i.anchor.paragraphId === paragraph.id && i.anchor.quote !== ''));

      const fs = foreshadowsForChapter(m.planItem, m.foreshadows, m.order);
      const prompt = renderWriterRevise({
        title: m.title,
        chapterTitle: m.chapter.title,
        avoidPhrases: m.avoidPhrases,
        evidence: [...new Set(group.flatMap((i) => i.evidenceText).filter((t) => t !== '章节计划' && !t.startsWith('本章段落：')))],
        mustNotReveal: fs.mustNotReveal.map((f) => f.reveal.trim()),
        before: m.paragraphs[at - 1]?.text ?? '',
        paragraph: paragraph.text,
        after: m.paragraphs[at + 1]?.text ?? '',
        issues: group.map((i) => ({ quote: i.anchor.quote, description: i.description, suggestion: i.suggestion })),
      });
      if (!prompt.ok) return err(settings(prompt.error));
      const result = await runner.text({ prompt: prompt.value, maxOutputTokens: paragraph.text.length * 2 + THINKING_ALLOWANCE, effort: 'medium' }, options);
      if (!result.ok) return result;
      if (result.value.outcome === 'cancelled') return err(settings('已取消'));
      if (result.value.outcome === 'refused') return err(settings(`模型拒绝了这次修订${result.value.refusal?.explanation ? `：${result.value.refusal.explanation}` : ''}`));
      const revised = splitParagraphs(normalizePunctuation(result.value.text)).join('\n');
      if (revised === '') return err(settings('模型没有写出修订后的文字'));
      if (revised === paragraph.text) return err(settings('写手没有改动这一段；可以自己修改，或忽略这条问题'));

      const whole = { from: { paragraphId: paragraph.id, offset: 0 }, to: { paragraphId: paragraph.id, offset: paragraph.text.length } };
      const plan = planRangeReplace(m.paragraphs, whole, { text: revised, ai: [{ start: 0, end: revised.length }], unedited: true }, () => deps.ids.next());
      if (!plan.ok) return err(settings(plan.error));
      const snapshot = await createSnapshot(port, { id: deps.ids.next(), chapterId, reason: 'writer' }, ctx());
      if (!snapshot.ok) return err(repo(snapshot.error));
      const applied = await applyRangeReplace(port, chapterId, plan.value, ctx());
      if (!applied.ok) return applied.error.code === 'conflict' ? err(settings('这一段在修订过程中被修改，写手没有写入；请重新审核')) : err(repo(applied.error));
      for (const issue of group) {
        const sent = await setIssueStatus(port, issue, 'sent_to_writer', ctx());
        if (!sent.ok && sent.error.code !== 'conflict') return err(repo(sent.error));
      }
      const after = await listParagraphs(port, chapterId);
      if (!after.ok) return err(repo(after.error));
      const rechecked = await refreshProgramIssues(port, { ...m, paragraphs: after.value });
      if (!rechecked.ok) return rechecked;
      const issues = await pendingView(port, chapterId, { ...m, paragraphs: after.value });
      return issues.ok ? ok({ chapterId, issues: issues.value, paragraphs: after.value }) : issues;
    },
  };
}
