// M3 评估的流程（施工文档 M3-09）：用应用服务层的用例把一部短篇走完“计划 → 写手成章 → 长篇记忆 → 审核”，
// 再往写好的章节里植入问题、重新审核，统计检出率。只调用用例，不绕过它们；结果写成报告由作者阅读。
import type { IssueKind, ReviewIssue } from '@fudiao/store';
import { countWords } from '@fudiao/shared';
import type { AppService } from '../../apps/desktop/src/app/service';
import type { EvalBook, EvalPlant } from './book';

export type EvalIssue = Pick<ReviewIssue, 'kind' | 'severity' | 'source' | 'description' | 'suggestion'> & { readonly quote: string };

export type EvalChapter = {
  readonly title: string;
  readonly targetWords: number | null;
  readonly words: number;
  readonly paragraphs: number;
  readonly segments: number;
  /** 写作、长篇记忆与审核各用了多少毫秒。 */
  readonly writeMs: number;
  readonly memoryMs: number;
  readonly reviewMs: number;
  /** 植入问题之前的审核结果。 */
  readonly issues: readonly EvalIssue[];
  readonly dropped: number;
  /** 模型审核没有完成的原因（例如输出被截断）；完成时为 null。没有完成时 issues 里只有程序检查的问题。 */
  readonly reviewIncomplete: string | null;
  /** 模型审核没有完成后重试的次数。 */
  readonly reviewRetries: number;
  readonly memory: { readonly summary: string; readonly castStates: number; readonly foreshadowProgress: number } | null;
};

export type PlantResult = {
  readonly plant: EvalPlant;
  /** 植入后这一章的模型审核是否完成；没有完成的不计入检出率。 */
  readonly reviewed: boolean;
  /** 审核在植入的那一段上提出了问题。 */
  readonly detected: boolean;
  /** 并且类型在预期之内。 */
  readonly kindMatched: boolean;
  readonly issues: readonly EvalIssue[];
};

export type EvalResult = {
  readonly title: string;
  readonly chapters: readonly EvalChapter[];
  readonly unmatchedCast: readonly string[];
  readonly plants: readonly PlantResult[];
  /** 全部调用的用量与费用（来自作品库的调用记录）。 */
  readonly usage: { readonly calls: number; readonly inputTokens: number; readonly outputTokens: number; readonly cost: number; readonly unknownCost: number } | null;
  /** 流程中途停下的原因；全部走完时为 null。 */
  readonly stopped: string | null;
  /** 植入问题之前的全书正文。 */
  readonly bookText: string;
};

export type EvalHooks = { readonly log: (line: string) => void; readonly now: () => number };

const describe = (error: unknown): string => {
  if (typeof error === 'string') return error;
  const e = error as { code?: string; detail?: string };
  return e.detail ?? e.code ?? JSON.stringify(error);
};

const toEvalIssue = (i: ReviewIssue): EvalIssue => ({ kind: i.kind, severity: i.severity, source: i.source, description: i.description, suggestion: i.suggestion, quote: i.anchor.quote });

export type DetectionRates = {
  /** 模型审核完成了的植入数，检出率以它为分母。 */
  readonly total: number;
  readonly detected: number;
  readonly kindMatched: number;
  /** 所在章节的模型审核没有完成、不计入检出率的植入数。 */
  readonly unreviewed: number;
  readonly byType: Record<string, { total: number; detected: number; kindMatched: number }>;
};

/** 检出率：模型审核完成了的植入中被指出的比例；kindMatched 还要求类型在预期之内。 */
export function detectionRates(plants: readonly PlantResult[]): DetectionRates {
  const reviewed = plants.filter((p) => p.reviewed);
  const byType: Record<string, { total: number; detected: number; kindMatched: number }> = {};
  for (const p of reviewed) {
    const row = (byType[p.plant.type] ??= { total: 0, detected: 0, kindMatched: 0 });
    row.total++;
    if (p.detected) row.detected++;
    if (p.kindMatched) row.kindMatched++;
  }
  return {
    total: reviewed.length,
    detected: reviewed.filter((p) => p.detected).length,
    kindMatched: reviewed.filter((p) => p.kindMatched).length,
    unreviewed: plants.length - reviewed.length,
    byType,
  };
}

/** 模型审核没有完成（例如思考用完了输出上限）时重试的次数。 */
export const REVIEW_RETRIES = 1;

export async function runEvaluation(app: AppService, book: EvalBook, hooks: EvalHooks): Promise<EvalResult> {
  const { log, now } = hooks;
  const chapters: EvalChapter[] = [];
  const plants: PlantResult[] = [];
  let unmatchedCast: readonly string[] = [];
  let bookText = '';
  const finish = async (stopped: string | null): Promise<EvalResult> => {
    const usage = await app.usage();
    const total = usage.ok ? usage.value.summary.total : null;
    if (stopped !== null) log(`停下：${stopped}`);
    return {
      title: book.title,
      chapters,
      unmatchedCast,
      plants,
      usage: total === null ? null : { calls: total.calls, inputTokens: total.inputTokens, outputTokens: total.outputTokens, cost: total.cost, unknownCost: total.unknownCost },
      stopped,
      bookText,
    };
  };

  /** 审核一章；模型审核没有完成时重试，仍没有完成则带着原因返回（程序检查的问题已保存）。 */
  const review = async (id: string) => {
    for (let retries = 0; ; retries++) {
      const result = await app.reviewChapter(id);
      if (!result.ok) return result;
      if (result.value.modelReviewed || retries >= REVIEW_RETRIES) return { ok: true as const, value: { ...result.value, retries } };
      log(`  模型审核没有完成（${result.value.reason ?? ''}），重试…`);
    }
  };

  // 一、作品、设定与伏笔。
  const created = await app.createWork(book.title);
  if (!created.ok) return finish(`新建作品失败：${describe(created.error)}`);
  const info = await app.updateWorkInfo({ genre: book.genre, synopsis: book.synopsis, outline: book.outline });
  if (!info.ok) return finish(`写入作品信息失败：${describe(info.error)}`);
  for (const e of book.entities) {
    const entity = await app.createEntity(e.kind, e.name);
    if (!entity.ok) return finish(`新建设定“${e.name}”失败：${describe(entity.error)}`);
    const updated = await app.updateEntity(entity.value.created, { aliases: [...e.aliases], description: e.description });
    if (!updated.ok) return finish(`写入设定“${e.name}”失败：${describe(updated.error)}`);
    const current = updated.value.find((x) => x.id === entity.value.created.id);
    if (e.locked && current !== undefined) {
      const locked = await app.setEntityLocked(current, true);
      if (!locked.ok) return finish(`锁定设定“${e.name}”失败：${describe(locked.error)}`);
    }
  }
  for (const f of book.foreshadows) {
    const added = await app.addForeshadow({ title: f.title, content: f.content, reveal: f.reveal, plantChapterId: null, plantAnchor: null, payoffChapterId: null, payoffAnchor: null, status: 'planned' });
    if (!added.ok) return finish(`记入伏笔“${f.title}”失败：${describe(added.error)}`);
  }

  // 二、章节计划：由大纲生成草稿并采用。
  log(`生成 ${book.chapterCount} 章的计划草稿…`);
  const draft = await app.draftPlans({ chapterCount: book.chapterCount, wordsPerChapter: book.wordsPerChapter });
  if (!draft.ok) return finish(`计划草稿没有生成：${describe(draft.error)}`);
  const applied = await app.applyPlanDraft(draft.value);
  if (!applied.ok) return finish(`采用计划草稿失败：${describe(applied.error)}`);
  unmatchedCast = applied.value.unmatchedCast;
  const planned = applied.value.view.chapters.filter((c) => c.plan !== null);
  log(`计划共 ${planned.length} 章。`);

  // 三、逐章：写手成章 → 长篇记忆 → 审核。
  const texts: string[] = [];
  for (const [i, item] of planned.entries()) {
    const id = item.chapter.id;
    const title = item.chapter.title;
    log(`第 ${i + 1} / ${planned.length} 章“${title}”：写作…`);
    let at = now();
    const written = await app.writeChapter(id);
    const writeMs = now() - at;
    if (!written.ok) return finish(`“${title}”没有写成：${describe(written.error)}`);
    if (written.value.status !== 'written') return finish(`“${title}”没有写完（${written.value.segmentsDone} / ${written.value.segmentsTotal} 段）：${written.value.reason ?? ''}`);

    at = now();
    const memory = await app.buildMemory(id);
    const memoryMs = now() - at;
    if (!memory.ok) log(`  长篇记忆没有生成：${describe(memory.error)}`);

    at = now();
    const reviewed = await review(id);
    const reviewMs = now() - at;
    if (!reviewed.ok) return finish(`“${title}”的审核失败：${describe(reviewed.error)}`);
    if (!reviewed.value.modelReviewed) log(`  模型审核没有完成：${reviewed.value.reason ?? ''}`);

    const content = await app.openChapter(id);
    if (!content.ok) return finish(`读取“${title}”失败：${describe(content.error)}`);
    const text = content.value.saved.map((p) => p.text).join('\n');
    texts.push(`${title}\n\n${text}`);
    chapters.push({
      title,
      targetWords: item.plan?.targetWords ?? null,
      words: countWords(text),
      paragraphs: content.value.saved.length,
      segments: written.value.segmentsTotal,
      writeMs,
      memoryMs,
      reviewMs,
      issues: reviewed.value.issues.map(toEvalIssue),
      dropped: reviewed.value.dropped,
      reviewIncomplete: reviewed.value.modelReviewed ? null : (reviewed.value.reason ?? '原因不明'),
      reviewRetries: reviewed.value.retries,
      memory: memory.ok ? { summary: memory.value.summary, castStates: Object.keys(memory.value.castState).length, foreshadowProgress: Object.keys(memory.value.foreshadowProgress).length } : null,
    });
    log(`  ${countWords(text)} 字，审核提出 ${reviewed.value.issues.length} 条问题${reviewed.value.modelReviewed ? '' : '（只有程序检查）'}。`);
  }
  bookText = texts.join('\n\n\n');

  // 四、植入问题：每章把要植入的段落均匀插进正文中间，再审核一次。
  const byChapter = new Map<number, EvalPlant[]>();
  for (const p of book.plants) byChapter.set(p.chapter, [...(byChapter.get(p.chapter) ?? []), p]);
  for (const [number, list] of [...byChapter.entries()].sort((a, b) => a[0] - b[0])) {
    const item = planned[number - 1];
    if (item === undefined) {
      log(`第 ${number} 章不存在，跳过 ${list.length} 处植入。`);
      continue;
    }
    const id = item.chapter.id;
    const content = await app.openChapter(id);
    if (!content.ok) return finish(`读取“${item.chapter.title}”失败：${describe(content.error)}`);
    const saved = content.value.saved;
    const current: { id: string; text: string; source: 'handwritten' }[] = saved.map((p) => ({ id: p.id, text: p.text, source: 'handwritten' }));
    // 从后往前插，前面的位置不受影响；避开第一段与最后一段。
    const positions = list.map((_, k) => Math.max(1, Math.min(saved.length - 1, Math.round(((k + 1) * saved.length) / (list.length + 1)))));
    for (let k = list.length - 1; k >= 0; k--) {
      const plant = list[k];
      if (plant !== undefined) current.splice(positions[k] ?? 1, 0, { id: `plant-${plant.id}`, text: plant.text, source: 'handwritten' });
    }
    const stored = await app.saveChapter(id, saved, current, { splits: [], merges: [] });
    if (!stored.ok) return finish(`植入“${item.chapter.title}”失败：${describe(stored.error)}`);
    log(`第 ${number} 章植入 ${list.length} 处问题，重新审核…`);
    const reviewed = await review(id);
    if (!reviewed.ok) return finish(`“${item.chapter.title}”植入后的审核失败：${describe(reviewed.error)}`);
    const complete = reviewed.value.modelReviewed;
    if (!complete) log(`  模型审核没有完成：${reviewed.value.reason ?? ''}`);
    for (const plant of list) {
      const paragraph = stored.value.find((p) => p.text === plant.text);
      const hits = paragraph === undefined ? [] : reviewed.value.issues.filter((i) => i.anchor.paragraphId === paragraph.id);
      const kinds: readonly IssueKind[] = plant.expect;
      plants.push({ plant, reviewed: complete, detected: hits.length > 0, kindMatched: hits.some((i) => kinds.includes(i.kind)), issues: hits.map(toEvalIssue) });
      log(`  ${plant.id}（${plant.type}）：${hits.length > 0 ? `检出（${hits.map((h) => h.kind).join('、')}）` : complete ? '没有检出' : '审核没有完成，不计'}`);
    }
  }
  return finish(null);
}

const KIND: Readonly<Record<IssueKind, string>> = {
  setting_conflict: '设定冲突',
  timeline: '时间线',
  pov_leak: '视角越界',
  foreshadow: '伏笔',
  character: '人物言行',
  off_plan: '偏离计划',
  pacing: '重复与节奏',
  ai_tone: 'AI 腔',
};
const PLANT_TYPE: Readonly<Record<EvalPlant['type'], string>> = { setting_conflict: '设定冲突', pov_leak: '视角越界', foreshadow: '伏笔提前说破', timeline: '时间线矛盾', character: '人物言行不符' };
const seconds = (ms: number) => `${Math.round(ms / 1000)} 秒`;
const cell = (text: string) => text.replace(/\|/g, '｜').replace(/\n/g, ' ');

/** 评估报告（Markdown）：流程是否走通、各章字数与耗时、审核提出的问题、植入问题的检出率、用量与费用。 */
export function renderReport(result: EvalResult, meta: { readonly model: string; readonly startedAt: string }): string {
  const rates = detectionRates(result.plants);
  const percent = (n: number, total: number) => (total === 0 ? '—' : `${Math.round((n / total) * 100)}%`);
  const out: string[] = [];
  out.push(`# M3 评估报告：《${result.title}》`, '');
  out.push(`- 模型：${meta.model}`, `- 开始时间：${meta.startedAt}`);
  out.push(`- 流程：${result.stopped === null ? '全部走完' : `中途停下（${result.stopped}）`}`);
  if (result.usage !== null) {
    const u = result.usage;
    out.push(`- 用量：${u.calls} 次调用，输入 ${u.inputTokens.toLocaleString('en-US')} Token，输出 ${u.outputTokens.toLocaleString('en-US')} Token`);
    out.push(`- 费用：${u.unknownCost > 0 ? `至少 $${u.cost.toFixed(4)}（${u.unknownCost} 次调用费用未知）` : `$${u.cost.toFixed(4)}`}`);
  }
  if (result.unmatchedCast.length > 0) out.push(`- 计划草稿中没有对应设定的人物：${result.unmatchedCast.join('、')}`);
  out.push('', '## 各章', '', '| 章节 | 字数（计划） | 段数 | 写作 | 长篇记忆 | 审核 | 问题 | 丢弃 |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const c of result.chapters) {
    out.push(
      `| ${cell(c.title)} | ${c.words}（${c.targetWords ?? '—'}） | ${c.paragraphs} | ${seconds(c.writeMs)} | ${c.memory === null ? '没有生成' : seconds(c.memoryMs)} | ${seconds(c.reviewMs)}${c.reviewRetries > 0 ? `（重试 ${c.reviewRetries} 次）` : ''} | ${c.reviewIncomplete === null ? c.issues.length : `${c.issues.length}（模型审核没有完成）`} | ${c.dropped} |`,
    );
  }
  out.push('', '## 植入问题的检出', '');
  if (result.plants.length === 0) out.push('没有植入问题。');
  else {
    if (rates.unreviewed > 0) out.push(`有 ${rates.unreviewed} 处植入所在章节的模型审核没有完成，不计入下面的检出率。`, '');
    out.push(`共植入 ${rates.total} 处：检出 ${rates.detected} 处（${percent(rates.detected, rates.total)}），其中类型也对的 ${rates.kindMatched} 处（${percent(rates.kindMatched, rates.total)}）。`, '');
    out.push('| 种类 | 植入 | 检出 | 类型也对 |', '| --- | --- | --- | --- |');
    for (const [type, row] of Object.entries(rates.byType)) out.push(`| ${PLANT_TYPE[type as EvalPlant['type']]} | ${row.total} | ${row.detected} | ${row.kindMatched} |`);
    out.push('', '| 编号 | 种类 | 章 | 植入的文字 | 结果 | 审核的说法 |', '| --- | --- | --- | --- | --- | --- |');
    for (const p of result.plants) {
      const verdict = !p.reviewed && !p.detected ? '审核没有完成' : !p.detected ? '没有检出' : p.kindMatched ? '检出' : '检出（类型不在预期内）';
      out.push(`| ${p.plant.id} | ${PLANT_TYPE[p.plant.type]} | ${p.plant.chapter} | ${cell(p.plant.text)} | ${verdict} | ${cell(p.issues.map((i) => `${KIND[i.kind]}：${i.description}`).join('；'))} |`);
    }
  }
  out.push('', '## 植入之前审核提出的问题', '', '这些问题出在写手自己写的正文上，需要作者对照正文判断是不是真问题（误报率由此估计）。', '');
  for (const c of result.chapters) {
    out.push(`### ${c.title}`, '');
    if (c.reviewIncomplete !== null) out.push(`模型审核没有完成：${c.reviewIncomplete}。下面只有程序检查的问题，这一章不能算“没有问题”。`, '');
    else if (c.issues.length === 0) out.push('没有问题。', '');
    for (const i of c.issues) out.push(`- 【${KIND[i.kind]}·${i.severity}·${i.source === 'program' ? '程序' : '模型'}】${i.quote === '' ? '' : `“${i.quote}”：`}${i.description}${i.suggestion === '' ? '' : `（建议：${i.suggestion}）`}`);
    if (c.issues.length > 0) out.push('');
    if (c.memory !== null) out.push(`长篇记忆：${c.memory.summary}（人物状态 ${c.memory.castStates} 条，伏笔进展 ${c.memory.foreshadowProgress} 条）`, '');
  }
  out.push('## 需要作者判断的事', '', '1. 通读全书（book.txt）：情节是否按计划推进，前后是否接得上，伏笔是否埋下并回收。', '2. 上一节的问题里，哪些是真问题、哪些是误报。', '3. 没有检出的植入问题，是提示词的缺口还是材料不够（例如审核不知道本章的视角人物）。', '');
  return out.join('\n');
}
