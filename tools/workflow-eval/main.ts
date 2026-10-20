// 写作工作流试用的命令行入口：pnpm workflow:eval --config m3/eval/config.json [--workflow book_audit,benchmark]
// 调用真实的模型服务，只在本机由作者手动运行；运行前按 quoteWorkflow 显示预计的调用次数、Token 与费用并等待确认（硬性规则 14）。
// API Key 从环境变量读取，只放在内存里的凭据表中，不写入作品库、报告或日志（硬性规则 15、18）；
// 请求经 fsDeps 里与凭据代理同样规则的模拟层（只发往绑定的源、https）。
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { createAppService } from '../../apps/desktop/src/app/service';
import { fsDeps } from '../../apps/desktop/src/testing/fs-deps';
import { parseBook, parseConfig, type EvalConfig } from '../m3-eval/book';
import { EVAL_ORDER, type EvalWorkflow } from './material';
import { planFlows, quoteFlows, renderReport, runWorkflowEval } from './run';

const USAGE = `用法：pnpm workflow:eval --config <模型配置.json> [--workflow 工作流] [--book m3/eval/book.json] [--out m3/runs] [--yes]
   或：pnpm workflow:eval --base-url <OpenAI 兼容服务的地址> [--model 模型名] [--max-output Token 数] [--workflow 工作流] [--yes]
  --config    模型服务的配置（示例见 m3/eval/config.example.json）；API Key 从其中指定的环境变量读取，没有设置时取 FUDIAO_EVAL_KEY
  --base-url  OpenAI 兼容的服务，API Key 取自环境变量 FUDIAO_EVAL_KEY；不给 --model 时列出服务的模型让你选
  --workflow  all（默认），或用逗号分开的 ${EVAL_ORDER.join('、')}；扫榜拆书以外都会先用一键成书写出 3 章
  --yes       不询问，直接开始（仍会显示预计费用）`;

type Args = { config: string | null; baseUrl: string | null; model: string | null; maxOutput: number | null; workflows: EvalWorkflow[]; book: string; out: string; yes: boolean };

function parseArgs(argv: readonly string[]): Args | string {
  const args: Args = { config: null, baseUrl: null, model: null, maxOutput: null, workflows: [...EVAL_ORDER], book: 'm3/eval/book.json', out: 'm3/runs', yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] ?? '';
    if (a === '--config') args.config = next();
    else if (a === '--base-url') args.baseUrl = next();
    else if (a === '--model') args.model = next();
    else if (a === '--max-output') args.maxOutput = Number(next());
    else if (a === '--book') args.book = next();
    else if (a === '--out') args.out = next();
    else if (a === '--yes') args.yes = true;
    else if (a === '--workflow') {
      const value = next();
      if (value === 'all') continue;
      const keys = value.split(',').map((k) => k.trim());
      const wrong = keys.filter((k) => !(EVAL_ORDER as readonly string[]).includes(k));
      if (wrong.length > 0) return `没有这个工作流：${wrong.join('、')}（可选：all、${EVAL_ORDER.join('、')}）`;
      args.workflows = keys as EvalWorkflow[];
    } else return `不认识的参数：${a ?? ''}`;
  }
  if (args.maxOutput !== null && !(Number.isInteger(args.maxOutput) && args.maxOutput > 0)) return '--max-output 要给一个正整数';
  if (args.config === null && args.baseUrl === null) return '要给 --config 或 --base-url';
  return args;
}

const ask = async (question: string): Promise<string> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim();
};

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args === 'string') {
    console.error(`${args}\n${USAGE}`);
    return 2;
  }
  let config: EvalConfig | null = null;
  if (args.config !== null) {
    let text: string;
    try {
      text = readFileSync(args.config, 'utf8');
    } catch {
      return fail(`读不到模型配置：${args.config}`);
    }
    const parsed = parseConfig(text);
    if (!parsed.ok) return fail(parsed.error);
    config = parsed.value;
  }
  let bookText: string;
  try {
    bookText = readFileSync(args.book, 'utf8');
  } catch {
    return fail(`读不到短篇的材料：${args.book}`);
  }
  const book = parseBook(bookText);
  if (!book.ok) return fail(book.error);

  const provider = config?.provider ?? { kind: 'openai_compatible' as const, name: '中转站', baseUrl: args.baseUrl ?? '', apiKeyEnv: 'FUDIAO_EVAL_KEY' };
  // 配置里指定的环境变量没有设置时，退回 FUDIAO_EVAL_KEY（与 --base-url 相同）。
  const apiKey = provider.apiKeyEnv === null ? null : process.env[provider.apiKeyEnv] || (process.env['FUDIAO_EVAL_KEY'] ?? '');
  if (apiKey === '') return fail(`环境变量 ${provider.apiKeyEnv === 'FUDIAO_EVAL_KEY' ? 'FUDIAO_EVAL_KEY' : `${provider.apiKeyEnv ?? ''} 与 FUDIAO_EVAL_KEY 都`}没有设置。请在运行这条命令的同一个终端里设置（例如 $env:FUDIAO_EVAL_KEY = '…'）后再运行，不要把 API Key 写进文件。`);

  const startedAt = new Date().toISOString();
  const dir = resolve(args.out, `workflow-${startedAt.replace(/[:.]/g, '-')}`);
  mkdirSync(dir, { recursive: true });
  const deps = fsDeps(dir, { fetch: globalThis.fetch, realTime: true });
  const app = createAppService(deps);
  // 没有开始试用（取消或出错）时删掉这次的目录，只留跑过的。
  let started = false;
  try {
    const library = await app.loadLibrary();
    if (!library.ok) return fail(`作品库没有打开：${JSON.stringify(library.error)}`);
    const saved = await app.saveProvider(null, { kind: provider.kind, name: provider.name, baseUrl: provider.baseUrl, authMethod: apiKey === null ? 'none' : 'api_key', apiKey });
    if (!saved.ok) return fail(`模型服务没有保存：${JSON.stringify(saved.error)}`);
    const providerId = saved.value.providers[0]?.id ?? '';
    let modelId = config?.model.id ?? args.model ?? '';
    let listedModel = null;
    if (config === null) {
      // 获取模型列表不调用模型、不计费。
      const listed = await app.fetchModelList(providerId);
      if (!listed.ok) {
        if (modelId === '') return fail(`获取模型列表失败，请用 --model 指定：${JSON.stringify(listed.error)}`);
      } else if (modelId === '') {
        listed.value.forEach((m, i) => console.log(`  ${i + 1}. ${m.id}`));
        const answer = await ask('用哪个模型？输入序号或模型名：');
        modelId = listed.value[Number(answer) - 1]?.id ?? answer;
      }
      if (listed.ok) listedModel = listed.value.find((m) => m.id === modelId) ?? null;
    }
    if (modelId === '') return fail('没有选模型');
    const added = await app.addModel(providerId, modelId, listedModel);
    if (!added.ok) return fail(`模型没有添加：${JSON.stringify(added.error)}`);
    const stored = added.value.models[0];
    if (stored === undefined) return fail('模型没有添加');
    if (config !== null) {
      const updated = await app.updateModel(stored, { displayName: stored.displayName, capabilities: { ...config.model.capabilities, selfTestPassed: false }, prices: config.model.prices });
      if (!updated.ok) return fail(`模型的能力与价格没有保存：${JSON.stringify(updated.error)}`);
    } else if (args.maxOutput !== null) {
      const updated = await app.updateModel(stored, { displayName: stored.displayName, capabilities: { ...stored.capabilities, maxOutputTokens: args.maxOutput }, prices: stored.prices });
      if (!updated.ok) return fail(`模型的最大输出没有保存：${JSON.stringify(updated.error)}`);
    }

    const flows = planFlows(args.workflows);
    const quote = await quoteFlows(app, book.value, flows);
    if (typeof quote === 'string') return fail(quote);
    console.log(`服务：${provider.name}（${provider.baseUrl}）；模型：${modelId}`);
    console.log(`短篇：《${book.value.title}》；依次运行：${quote.rows.filter((r) => r.key !== 'extra').map((r) => r.title).join(' → ')}`);
    for (const r of quote.rows) console.log(`  ${r.title}：约 ${r.calls} 次调用，输入 ${r.inputTokens.toLocaleString('en-US')}、输出 ${r.outputTokens.toLocaleString('en-US')} Token${r.costUsd === null ? '' : `，约 $${r.costUsd.toFixed(3)}`}`);
    const t = quote.total;
    console.log(`合计：约 ${t.calls} 次调用，输入 ${t.inputTokens.toLocaleString('en-US')}、输出 ${t.outputTokens.toLocaleString('en-US')} Token（偏高的估计，思考计入输出）；${t.costUsd === null ? '没有价格，无法估算费用' : `预计费用不超过约 $${t.costUsd.toFixed(2)}`}。`);
    if (!args.yes) {
      const answer = (await ask('这会调用真实的模型服务并产生费用，是否继续？(y/N) ')).toLowerCase();
      if (answer !== 'y' && answer !== 'yes') {
        console.log('已取消。');
        return 0;
      }
    }

    console.log('能力自检…');
    const tested = await app.runSelfTest(stored.id);
    if (!tested.ok) return fail(`能力自检没有完成：${JSON.stringify(tested.error)}`);
    if (!tested.value.report.passed) return fail(`能力自检没有通过，结构化任务不能用这个模型：${JSON.stringify(tested.value.report)}`);

    started = true;
    const result = await runWorkflowEval(app, book.value, args.workflows, { log: (line) => console.log(line), now: () => Date.now() });
    writeFileSync(join(dir, 'report.md'), renderReport(result, { model: `${provider.name} / ${modelId}`, startedAt, quote }));
    writeFileSync(join(dir, 'result.json'), JSON.stringify({ ...result, bookText: undefined }, null, 2));
    writeFileSync(join(dir, 'book.txt'), `${result.bookText}\n`);
    const u = result.usage;
    console.log(`\n用量：${u === null ? '没有取到' : `${u.calls} 次调用，输入 ${u.inputTokens.toLocaleString('en-US')}、输出 ${u.outputTokens.toLocaleString('en-US')} Token，$${u.cost.toFixed(4)}`}`);
    console.log(`报告：${join(dir, 'report.md')}\n正文：${join(dir, 'book.txt')}`);
    return result.flows.every((f) => f.error === null) ? 0 : 1;
  } finally {
    await deps.dispose();
    if (!started) rmSync(dir, { recursive: true, force: true });
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
