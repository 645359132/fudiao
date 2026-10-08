// pnpm bench [basic|serial] [--json 报告.json]：生成测试集并运行性能基准，输出 Markdown 表格；有未达标项时退出码为 1。
// pnpm bench [basic|serial] --txt 文件.txt：只把测试集写成 TXT，供在应用中手工导入。
import { writeFileSync } from 'node:fs';
import { formatReport, runBenchmarks } from './benchmarks';
import { corpusText, generateCorpus, PRESETS, type PresetKey } from './corpus';

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const key = (args.find((a) => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--')) ?? 'basic') as PresetKey;
if (!(key in PRESETS)) {
  console.error(`测试集只有：${Object.keys(PRESETS).join('、')}`);
  process.exit(2);
}
const preset = PRESETS[key];
const corpus = generateCorpus(preset);

const txt = option('--txt');
if (txt !== undefined) {
  writeFileSync(txt, corpusText(corpus));
  console.log(`已写入 ${txt}（${preset.name}，${corpus.length} 章）`);
} else {
  const report = await runBenchmarks(preset.name, corpus);
  console.log(formatReport(report));
  const json = option('--json');
  if (json !== undefined) writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`);
  if (report.measures.some((m) => m.pass === false)) process.exitCode = 1;
}
