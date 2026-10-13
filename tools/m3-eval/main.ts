// M3 评估的命令行入口：pnpm m3:eval --config m3/eval/config.json
// 调用真实的模型服务，只在本机由作者手动运行；运行前显示预计费用并等待确认（硬性规则 14）。
// API Key 从配置指定的环境变量读取，只放在内存里的凭据表中，不写入作品库、报告或日志（硬性规则 15、18）。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { createAppService } from '../../apps/desktop/src/app/service';
import { fsDeps } from '../../apps/desktop/src/testing/fs-deps';
import { estimateCost, estimateTokens, parseBook, parseConfig } from './book';
import { renderReport, runEvaluation } from './run';

type Args = { config: string | null; book: string; out: string; yes: boolean; chapters: number | null };

function parseArgs(argv: readonly string[]): Args | string {
  const args: Args = { config: null, book: 'm3/eval/book.json', out: 'm3/runs', yes: false, chapters: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] ?? '';
    if (a === '--config') args.config = next();
    else if (a === '--book') args.book = next();
    else if (a === '--out') args.out = next();
    else if (a === '--yes') args.yes = true;
    else if (a === '--chapters') args.chapters = Number(next());
    else return `不认识的参数：${a ?? ''}`;
  }
  if (args.chapters !== null && (!Number.isInteger(args.chapters) || args.chapters < 1)) return '--chapters 须为正整数';
  return args;
}

const USAGE = `用法：pnpm m3:eval --config <模型配置.json> [--book m3/eval/book.json] [--out m3/runs] [--chapters N] [--yes]
  --config    模型服务的配置（示例见 m3/eval/config.example.json）；API Key 从其中指定的环境变量读取
  --book      短篇的材料与要植入的问题
  --chapters  只写前 N 章（试跑时用）
  --yes       不询问，直接开始（仍会显示预计费用）`;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args === 'string' || args.config === null) {
    console.error(typeof args === 'string' ? `${args}\n${USAGE}` : USAGE);
    return 2;
  }
  const read = (file: string): string | null => {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  };
  const configText = read(args.config);
  const bookText = read(args.book);
  if (configText === null) return fail(`读不到模型配置：${args.config}`);
  if (bookText === null) return fail(`读不到短篇的材料：${args.book}`);
  const config = parseConfig(configText);
  if (!config.ok) return fail(config.error);
  const parsedBook = parseBook(bookText);
  if (!parsedBook.ok) return fail(parsedBook.error);
  const chapterCount = Math.min(args.chapters ?? parsedBook.value.chapterCount, parsedBook.value.chapterCount);
  const book = { ...parsedBook.value, chapterCount, plants: parsedBook.value.plants.filter((p) => p.chapter <= chapterCount) };

  const { provider, model } = config.value;
  const apiKey = provider.apiKeyEnv === null ? null : (process.env[provider.apiKeyEnv] ?? '');
  if (apiKey === '') return fail(`环境变量 ${provider.apiKeyEnv ?? ''} 没有设置。请在自己的终端里设置后再运行，不要把 API Key 写进文件。`);

  const tokens = estimateTokens(book);
  const cost = estimateCost(tokens, model.prices);
  console.log(`短篇：《${book.title}》，${book.chapterCount} 章，每章约 ${book.wordsPerChapter} 字；植入问题 ${book.plants.length} 处。`);
  console.log(`模型：${provider.name} / ${model.id}`);
  console.log(`预计约 ${tokens.calls} 次调用，输入 ${tokens.input.toLocaleString('en-US')} Token，输出 ${tokens.output.toLocaleString('en-US')} Token（偏高的估计）。`);
  console.log(cost === null ? '配置中没有价格，无法估算费用。' : `预计费用不超过约 $${cost.toFixed(2)}。`);
  if (!args.yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question('这会调用真实的模型服务并产生费用，是否继续？(y/N) ')).trim().toLowerCase();
    rl.close();
    if (answer !== 'y' && answer !== 'yes') {
      console.log('已取消。');
      return 0;
    }
  }

  const startedAt = new Date().toISOString();
  const dir = resolve(args.out, startedAt.replace(/[:.]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const deps = fsDeps(dir, { fetch: globalThis.fetch, realTime: true });
  const app = createAppService(deps);
  try {
    const library = await app.loadLibrary();
    if (!library.ok) return fail(`作品库没有打开：${JSON.stringify(library.error)}`);
    const saved = await app.saveProvider(null, { kind: provider.kind, name: provider.name, baseUrl: provider.baseUrl, authMethod: apiKey === null ? 'none' : 'api_key', apiKey });
    if (!saved.ok) return fail(`模型服务没有保存：${JSON.stringify(saved.error)}`);
    const providerId = saved.value.providers[0]?.id ?? '';
    const added = await app.addModel(providerId, model.id);
    if (!added.ok) return fail(`模型没有添加：${JSON.stringify(added.error)}`);
    const stored = added.value.models[0];
    if (stored === undefined) return fail('模型没有添加');
    const updated = await app.updateModel(stored, { displayName: stored.displayName, capabilities: { ...model.capabilities, selfTestPassed: false }, prices: model.prices });
    if (!updated.ok) return fail(`模型的能力与价格没有保存：${JSON.stringify(updated.error)}`);
    console.log('能力自检…');
    const tested = await app.runSelfTest(stored.id);
    if (!tested.ok) return fail(`能力自检没有完成：${JSON.stringify(tested.error)}`);
    if (!tested.value.report.passed) return fail(`能力自检没有通过，结构化任务不能用这个模型：${JSON.stringify(tested.value.report)}`);

    const result = await runEvaluation(app, book, { log: (line) => console.log(line), now: () => Date.now() });
    writeFileSync(join(dir, 'report.md'), renderReport(result, { model: `${provider.name} / ${model.id}`, startedAt }));
    writeFileSync(join(dir, 'result.json'), JSON.stringify({ ...result, bookText: undefined }, null, 2));
    writeFileSync(join(dir, 'book.txt'), result.bookText);
    console.log(`\n报告：${join(dir, 'report.md')}\n全书正文：${join(dir, 'book.txt')}`);
    return result.stopped === null ? 0 : 1;
  } finally {
    await deps.dispose();
  }
}

function fail(message: string): number {
  console.error(message);
  return 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  },
);
