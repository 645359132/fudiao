// 统计结果写成 Markdown；两份结果并排比较。
import { ENDING_KINDS, type DialogueStats } from '@fudiao/writing';
import { endingLabel, type BookStats } from './stats';

const n = (value: number, digits = 0) => value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const pct = (ratio: number) => `${(ratio * 100).toFixed(1)}%`;

export function formatReport(title: string, s: BookStats): string {
  const lines: string[] = [];
  lines.push(`# ${title}`, '');
  lines.push('## 总览', '');
  lines.push('| 指标 | 数值 |', '| --- | --- |');
  lines.push(`| 章数 | ${s.chapters} |`);
  lines.push(`| 总字数（汉字、字母与数字） | ${n(s.words)} |`);
  lines.push(`| 每章字数 均值 / 标准差 / 变异系数 | ${n(s.chapterWords.mean)} / ${n(s.chapterWords.sd)} / ${s.chapterWords.cv.toFixed(2)} |`);
  lines.push(`| 对话占比（引号里的字） | ${pct(s.dialogue.overall)} |`);
  lines.push(`| 叙述句长 均值 / 标准差 / 变异系数 | ${n(s.sentences.mean, 1)} / ${n(s.sentences.sd, 1)} / ${s.sentences.cv.toFixed(2)} |`);
  lines.push(`| 段落长 均值 / 变异系数；每章段数 | ${n(s.paragraphs.mean, 1)} / ${s.paragraphs.cv.toFixed(2)}；${s.chapters === 0 ? 0 : n(s.paragraphs.count / s.chapters, 1)} |`);
  lines.push(`| 词汇多样性 MTLD（按字，各章中位数） | ${n(s.mtldMedian, 1)} |`);
  const d = s.dialogueSentences;
  const share = (k: number) => (d.sentences === 0 ? '—' : pct(k / d.sentences));
  lines.push(`| 对白句型 问 / 叹 / 没说完 / 陈述（共 ${n(d.sentences)} 句） | ${share(d.question)} / ${share(d.exclamation)} / ${share(d.unfinished)} / ${share(d.declarative)} |`);
  lines.push('');

  lines.push('## 章名字数', '');
  lines.push('| 字数 | 章数 |', '| --- | --- |');
  for (const [length, count] of Object.entries(s.titleLengths).sort((a, b) => Number(a[0]) - Number(b[0]))) lines.push(`| ${length} | ${count} |`);
  lines.push('');

  lines.push('## 对话占比', '');
  if (s.dialogue.byVolume.length > 1) {
    lines.push('| 卷 | 章数 | 对话占比 |', '| --- | --- | --- |');
    for (const v of s.dialogue.byVolume) lines.push(`| ${v.volume} | ${v.chapters} | ${pct(v.ratio)} |`);
    lines.push('');
  }
  lines.push(`对话最少的 ${s.dialogue.lowest.length} 章：`, '');
  lines.push('| 章 | 字数 | 对话占比 |', '| --- | --- | --- |');
  for (const r of s.dialogue.lowest) lines.push(`| ${r.index} ${r.title} | ${n(r.words)} | ${pct(r.dialogueRatio)} |`);
  lines.push('');

  lines.push('## 章尾方式', '');
  lines.push('| 收法 | 章数 |', '| --- | --- |');
  for (const k of ENDING_KINDS) lines.push(`| ${endingLabel(k)} | ${s.endings[k]} |`);
  lines.push('');

  lines.push('## 高频实词（对白与名字以外）', '');
  lines.push('| 词 | 次数 | 每万字 | 出现的章数 |', '| --- | --- | --- | --- |');
  for (const t of s.terms) lines.push(`| ${t.term} | ${n(t.count)} | ${t.perTenThousand.toFixed(1)} | ${t.chapters} |`);
  lines.push('');

  lines.push('## 句首模板', '');
  lines.push('| 句首 | 句数 | 每万字 | 出现的章数 |', '| --- | --- | --- | --- |');
  for (const t of s.openings) lines.push(`| ${t.term}…… | ${n(t.count)} | ${t.perTenThousand.toFixed(1)} | ${t.chapters} |`);
  lines.push('');

  lines.push('## 跨章重复的片段（四字及以上，按出现的章数）', '');
  lines.push('| 片段 | 出现的章数 | 次数 |', '| --- | --- | --- |');
  for (const t of s.crossChapter) lines.push(`| ${t.term} | ${t.chapters} | ${n(t.count)} |`);
  lines.push('');
  return lines.join('\n');
}

/** 两份结果并排：改前、改后与差值。 */
export function compareReports(before: BookStats, after: BookStats): string {
  const rows: readonly (readonly [string, number, number, (v: number) => string])[] = [
    ['章数', before.chapters, after.chapters, (v) => n(v)],
    ['每章字数 均值', before.chapterWords.mean, after.chapterWords.mean, (v) => n(v)],
    ['每章字数 变异系数', before.chapterWords.cv, after.chapterWords.cv, (v) => v.toFixed(2)],
    ['对话占比', before.dialogue.overall, after.dialogue.overall, pct],
    ['叙述句长 变异系数', before.sentences.cv, after.sentences.cv, (v) => v.toFixed(2)],
    ['段落长 变异系数', before.paragraphs.cv, after.paragraphs.cv, (v) => v.toFixed(2)],
    ['MTLD 中位数', before.mtldMedian, after.mtldMedian, (v) => n(v, 1)],
    ['章名字数的种类', Object.keys(before.titleLengths).length, Object.keys(after.titleLengths).length, (v) => n(v)],
    ['最常见收法的占比', share(before), share(after), pct],
    ['前十高频词每万字合计', sumTop(before), sumTop(after), (v) => v.toFixed(1)],
    ['对白里问、叹与没说完的占比', mood(before), mood(after), pct],
  ];
  const lines = ['| 指标 | 改前 | 改后 | 差 |', '| --- | --- | --- | --- |'];
  for (const [name, a, b, f] of rows) lines.push(`| ${name} | ${f(a)} | ${f(b)} | ${b - a >= 0 ? '+' : ''}${f(b - a)} |`);
  return lines.join('\n');
}

function share(s: BookStats): number {
  const total = Object.values(s.endings).reduce((a, b) => a + b, 0);
  return total === 0 ? 0 : Math.max(...Object.values(s.endings)) / total;
}

const sumTop = (s: BookStats) => s.terms.slice(0, 10).reduce((a, t) => a + t.perTenThousand, 0);

/** 较早的 JSON 没有对白句型时按 0。 */
function mood(s: BookStats): number {
  const d = s.dialogueSentences as DialogueStats | undefined;
  return d === undefined || d.sentences === 0 ? 0 : (d.question + d.exclamation + d.unfinished) / d.sentences;
}
