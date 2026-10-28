// pnpm prose:stats <txt> [--json 结果.json] [--compare 之前.json] [--names 沈孤舟,楚晚晴] [--top 40]
// 对导出的 TXT 算“AI 味”的统计，输出 Markdown 报告；--json 把数字存下来，--compare 与之前的一份并排比较。
// 只读文件、不入库原文；名字（人物、地点、物品）给出后不算进高频词。
import { readFileSync, writeFileSync } from 'node:fs';
import { compareReports, formatReport } from './report';
import { splitChapters } from './split';
import { bookStats, type BookStats } from './stats';

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const file = args.find((a, i) => !a.startsWith('--') && !(args[i - 1] ?? '').startsWith('--'));
if (file === undefined) {
  console.error('用法：pnpm prose:stats <txt> [--json 结果.json] [--compare 之前.json] [--names 名字,名字] [--top 40]');
  process.exit(2);
}
const text = readFileSync(file, 'utf8');
const chapters = splitChapters(text);
const names = (option('--names') ?? '').split(/[,，、\s]+/u).filter((s) => s !== '');
const top = Number(option('--top') ?? 40);
const stats = bookStats(chapters, { names, top: Number.isFinite(top) && top > 0 ? top : 40 });
console.log(formatReport(`文风统计：${file}`, stats));

const json = option('--json');
if (json !== undefined) {
  writeFileSync(json, `${JSON.stringify(stats, null, 2)}\n`);
  console.log(`\n数字已写入 ${json}`);
}
const compare = option('--compare');
if (compare !== undefined) {
  const before = JSON.parse(readFileSync(compare, 'utf8')) as BookStats;
  console.log(`\n## 与 ${compare} 比较（改前 → 改后）\n`);
  console.log(compareReports(before, stats));
}
