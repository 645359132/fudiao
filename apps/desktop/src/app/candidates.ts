// 候选稿的用例（需求 B17、B33，施工文档第五章）：AI 结果存为候选稿；作者可以修改、放弃或接受。
// 接受时先检查原文是否在生成之后改过（改过则标为过期），再建立“接受候选稿”快照，最后按范围写入正文并记录段落来源。
// 未经作者接受的内容不写入作品（硬性规则 21）。
import { err, ok, type Result } from '@fudiao/shared';
import {
  applyRangeReplace,
  createCandidate,
  createSnapshot,
  findCallByRequestHash,
  getCandidate,
  listCandidates,
  listParagraphs,
  planRangeReplace,
  setCandidateStatus,
  textInRange,
  updateCandidateContent,
  updateSpans,
  type Candidate,
  type CandidateOperation,
  type RepoError,
  type SavedParagraph,
  type SqlPort,
  type TextRange,
} from '@fudiao/store';
import { normalizePunctuation } from '@fudiao/writing';
import type { AppError } from './errors';
import type { AppDeps } from './ports';
import type { EditorSelection } from './writing-context';

export const STALE_REASON = '原文在生成之后被修改过';

/** 候选稿要替换的范围：有选区时为选区；没有时为本章末尾（续写）。 */
export function candidateRange(paragraphs: readonly SavedParagraph[], selection: EditorSelection | null): TextRange | null {
  if (selection !== null) return selection;
  const last = paragraphs.at(-1);
  if (last === undefined) return null;
  const end = { paragraphId: last.id, offset: last.text.length };
  return { from: end, to: end };
}

/** 范围涉及的段落的当前版本。 */
function versionsIn(paragraphs: readonly SavedParagraph[], range: TextRange): Record<string, number> {
  const i = paragraphs.findIndex((p) => p.id === range.from.paragraphId);
  const j = paragraphs.findIndex((p) => p.id === range.to.paragraphId);
  return Object.fromEntries(paragraphs.slice(i, j + 1).map((p) => [p.id, p.version]));
}

/**
 * 写入的文字与其中的 AI 区间：续写的位置在一段（非空）的末尾时，候选稿另起一段；
 * 作者改过候选稿时，只有与生成原文对得上的文字算 AI 文字。
 */
export function insertFor(candidate: Candidate, paragraphs: readonly SavedParagraph[]): { text: string; ai: { start: number; end: number }[]; unedited: boolean } {
  const content = candidate.content;
  const ai = candidate.content === candidate.generated ? (content === '' ? [] : [{ start: 0, end: content.length }]) : updateSpans(candidate.generated, [{ start: 0, end: candidate.generated.length }], content);
  const at = paragraphs.find((p) => p.id === candidate.target.from.paragraphId);
  const newParagraph = (candidate.operation === 'continue' || candidate.operation === 'narrate') && at !== undefined && at.text !== '' && candidate.target.from.offset === at.text.length;
  return newParagraph
    ? { text: `\n${content}`, ai: ai.map((s) => ({ start: s.start + 1, end: s.end + 1 })), unedited: content === candidate.generated }
    : { text: content, ai, unedited: content === candidate.generated };
}

const repo = (error: RepoError): AppError => ({ code: 'repo', error });
const settings = (detail: string): AppError => ({ code: 'settings', detail });

export function candidateUseCases(deps: AppDeps, project: () => SqlPort | null) {
  const ctx = () => ({ now: deps.clock.now() });
  const port = (): Result<SqlPort, AppError> => {
    const p = project();
    return p === null ? err({ code: 'no_work' }) : ok(p);
  };

  return {
    /** 把一次选区操作的结果存为候选稿；记下原文与相关段落的版本，接受时据此检查。 */
    async saveCandidate(input: {
      readonly chapterId: string;
      readonly selection: EditorSelection | null;
      readonly operation: CandidateOperation;
      readonly text: string;
      readonly requestHash: string;
    }): Promise<Result<Candidate, AppError>> {
      const p = port();
      if (!p.ok) return p;
      const paragraphs = await listParagraphs(p.value, input.chapterId);
      if (!paragraphs.ok) return err(repo(paragraphs.error));
      const range = candidateRange(paragraphs.value, input.selection);
      const baseText = range === null ? null : textInRange(paragraphs.value, range);
      if (range === null || baseText === null) return err(settings('找不到原文的位置，请重新选择'));
      const call = await findCallByRequestHash(p.value, input.requestHash);
      const created = await createCandidate(
        p.value,
        {
          id: deps.ids.next(),
          chapterId: input.chapterId,
          operation: input.operation,
          target: range,
          baseText,
          baseVersions: versionsIn(paragraphs.value, range),
          // 与写手写入的正文一样规范标点（B74）。
          generated: normalizePunctuation(input.text.trim()),
          llmCallId: call.ok ? (call.value?.id ?? null) : null,
        },
        ctx(),
      );
      return created.ok ? created : err(repo(created.error));
    },

    async listCandidates(chapterId: string): Promise<Result<Candidate[], AppError>> {
      const p = port();
      if (!p.ok) return p;
      const list = await listCandidates(p.value, chapterId);
      return list.ok ? list : err(repo(list.error));
    },

    async editCandidate(candidate: Candidate, content: string): Promise<Result<Candidate, AppError>> {
      const p = port();
      if (!p.ok) return p;
      const updated = await updateCandidateContent(p.value, candidate, content, ctx());
      return updated.ok ? updated : err(repo(updated.error));
    },

    async discardCandidate(candidate: Candidate): Promise<Result<Candidate, AppError>> {
      const p = port();
      if (!p.ok) return p;
      const updated = await setCandidateStatus(p.value, candidate, 'discarded', null, ctx());
      return updated.ok ? updated : err(repo(updated.error));
    },

    /**
     * 接受候选稿：原文没变才写入；先建快照（可以回退），再在一个事务中替换正文、写入来源。
     * 返回写入后的本章段落，界面据此重新载入编辑器。
     */
    async acceptCandidate(candidateId: string): Promise<Result<{ candidate: Candidate; paragraphs: SavedParagraph[] }, AppError>> {
      const p = port();
      if (!p.ok) return p;
      const found = await getCandidate(p.value, candidateId);
      if (!found.ok) return err(repo(found.error));
      const candidate = found.value;
      if (candidate.status !== 'pending') return err(settings('这份候选稿已经处理过了'));
      if (candidate.operation === 'narrate') return err(settings('推演写成的正文须经“采纳”写入：选定它讲述的事件后一起写入作品'));
      const paragraphs = await listParagraphs(p.value, candidate.chapterId);
      if (!paragraphs.ok) return err(repo(paragraphs.error));
      const stale = async () => {
        await setCandidateStatus(p.value, candidate, 'stale', STALE_REASON, ctx());
        return err(settings(`候选稿已过期：${STALE_REASON}，请重新生成`));
      };
      const current = versionsIn(paragraphs.value, candidate.target);
      const sameVersions =
        Object.keys(current).length === Object.keys(candidate.baseVersions).length && Object.entries(candidate.baseVersions).every(([id, v]) => current[id] === v);
      if (!sameVersions || textInRange(paragraphs.value, candidate.target) !== candidate.baseText) return stale();

      const plan = planRangeReplace(paragraphs.value, candidate.target, insertFor(candidate, paragraphs.value), () => deps.ids.next());
      if (!plan.ok) return stale();
      const snapshot = await createSnapshot(p.value, { id: deps.ids.next(), chapterId: candidate.chapterId, reason: 'accept_candidate' }, ctx());
      if (!snapshot.ok) return err(repo(snapshot.error));
      const applied = await applyRangeReplace(p.value, candidate.chapterId, plan.value, ctx());
      if (!applied.ok) return applied.error.code === 'conflict' ? stale() : err(repo(applied.error));
      const accepted = await setCandidateStatus(p.value, candidate, 'accepted', null, ctx());
      if (!accepted.ok) return err(repo(accepted.error));
      const after = await listParagraphs(p.value, candidate.chapterId);
      return after.ok ? ok({ candidate: accepted.value, paragraphs: after.value }) : err(repo(after.error));
    },
  };
}
