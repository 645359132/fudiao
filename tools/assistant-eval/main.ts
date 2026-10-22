// AI 助手试用的命令行入口：pnpm assistant:eval --config m3/eval/config.json
// 调用真实的模型服务，只在本机由作者手动运行；运行前显示预计费用并等待确认（硬性规则 14）。
// API Key 从配置指定的环境变量读取，只放在内存里的凭据表中，不写入作品库、报告或日志（硬性规则 15、18）。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { countWords } from '@fudiao/shared';
import { createAppService } from '../../apps/desktop/src/app/service';
import { fsDeps } from '../../apps/desktop/src/testing/fs-deps';
import { parseConfig, type EvalConfig } from '../m3-eval/book';
import { renderReport, runScenario } from './scenario';
import { SCENARIOS, scenarioByKey, withFaults } from './scenarios';

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--config');
  const configPath = at >= 0 ? argv[at + 1] : undefined;
  const outAt = argv.indexOf('--out');
  const out = outAt >= 0 ? (argv[outAt + 1] ?? 'm3/runs') : 'm3/runs';
  const yes = argv.includes('--yes');
  const baseAt = argv.indexOf('--base-url');
  const baseUrl = baseAt >= 0 ? argv[baseAt + 1] : undefined;
  const modelAt = argv.indexOf('--model');
  const wanted = modelAt >= 0 ? argv[modelAt + 1] : undefined;
  // 服务没有给出能力、内置表里也没有的模型，最大输出按保守的 4,096 计；先思考的模型会被截断，可以在这里指定。
  const maxOutAt = argv.indexOf('--max-output');
  const maxOutput = maxOutAt >= 0 ? Number(argv[maxOutAt + 1]) : null;
  if (maxOutput !== null && !(Number.isInteger(maxOutput) && maxOutput > 0)) return fail('--max-output 要给一个正整数');
  if (argv.includes('--list')) {
    for (const s of SCENARIOS) console.log(`${s.key}：${s.title}（${s.turns.length} 句）`);
    return 0;
  }
  const scenarioAt = argv.indexOf('--scenario');
  const scenarioKey = scenarioAt >= 0 ? (argv[scenarioAt + 1] ?? '') : 'default';
  const scenario = scenarioByKey(scenarioKey);
  if (scenario === undefined) return fail(`没有这个场景：${scenarioKey}（--list 列出全部）`);
  const ESTIMATE = scenario.estimate;
  if (configPath === undefined && baseUrl === undefined) {
    console.error(
      '用法：pnpm assistant:eval --config <模型配置.json> [--scenario 场景] [--out m3/runs] [--yes]\n   或：pnpm assistant:eval --base-url <OpenAI 兼容服务的地址> [--model 模型名] [--max-output Token 数] [--scenario 场景] [--yes]（API Key 取自环境变量 FUDIAO_EVAL_KEY；不给 --model 时列出服务的模型让你选）\n   场景：pnpm assistant:eval --list',
    );
    return 2;
  }
  // 给了服务地址：OpenAI 兼容的服务（例如中转站），能力与价格按服务返回的信息与内置表合并，不另外指定。
  let config: EvalConfig | null = null;
  if (configPath !== undefined) {
    let configText: string;
    try {
      configText = readFileSync(configPath, 'utf8');
    } catch {
      return fail(`读不到模型配置：${configPath}`);
    }
    const parsed = parseConfig(configText);
    if (!parsed.ok) return fail(parsed.error);
    config = parsed.value;
  }
  const provider = config?.provider ?? { kind: 'openai_compatible' as const, name: '中转站', baseUrl: baseUrl ?? '', apiKeyEnv: 'FUDIAO_EVAL_KEY' };
  const apiKey = provider.apiKeyEnv === null ? null : (process.env[provider.apiKeyEnv] ?? '');
  if (apiKey === '') return fail(`环境变量 ${provider.apiKeyEnv ?? ''} 没有设置。请在自己的终端里设置后再运行，不要把 API Key 写进文件。`);

  const prices = config?.model.prices ?? null;
  const cost = prices === null ? null : (ESTIMATE.input * prices.input + ESTIMATE.output * prices.output) / 1_000_000;
  console.log(`服务：${provider.name}（${provider.baseUrl}）；场景：${scenario.title}，对话 ${scenario.turns.length} 句。`);
  console.log(cost === null ? `没有价格，无法估算费用；用量约输入 ${ESTIMATE.input.toLocaleString('en-US')}、输出 ${ESTIMATE.output.toLocaleString('en-US')} Token（偏高的估计）。` : `预计费用不超过约 $${cost.toFixed(2)}。`);
  if (!yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question('这会调用真实的模型服务并产生费用，是否继续？(y/N) ')).trim().toLowerCase();
    rl.close();
    if (answer !== 'y' && answer !== 'yes') {
      console.log('已取消。');
      return 0;
    }
  }

  const startedAt = new Date().toISOString();
  const dir = resolve(out, `assistant-${startedAt.replace(/[:.]/g, '-')}`);
  mkdirSync(dir, { recursive: true });
  const deps = fsDeps(dir, { fetch: globalThis.fetch, realTime: true });
  const faults = scenario.faults;
  const app = createAppService(faults === undefined ? deps : { ...deps, llm: { forProvider: (p) => withFaults(deps.llm.forProvider(p), faults, (line) => console.log(line)) } });
  try {
    const library = await app.loadLibrary();
    if (!library.ok) return fail(`作品库没有打开：${JSON.stringify(library.error)}`);
    const saved = await app.saveProvider(null, { kind: provider.kind, name: provider.name, baseUrl: provider.baseUrl, authMethod: apiKey === null ? 'none' : 'api_key', apiKey });
    if (!saved.ok) return fail(`模型服务没有保存：${JSON.stringify(saved.error)}`);
    const providerId = saved.value.providers[0]?.id ?? '';
    let modelId = config?.model.id ?? wanted ?? '';
    let listedModel = null;
    if (config === null) {
      const listed = await app.fetchModelList(providerId);
      if (!listed.ok) {
        if (modelId === '') return fail(`获取模型列表失败，请用 --model 指定：${JSON.stringify(listed.error)}`);
      } else if (modelId === '') {
        listed.value.forEach((m, i) => console.log(`  ${i + 1}. ${m.id}`));
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = (await rl.question('用哪个模型？输入序号或模型名：')).trim();
        rl.close();
        const byIndex = listed.value[Number(answer) - 1];
        modelId = byIndex?.id ?? answer;
      }
      if (listed.ok) listedModel = listed.value.find((m) => m.id === modelId) ?? null;
    }
    if (modelId === '') return fail('没有选模型');
    const added = await app.addModel(providerId, modelId, listedModel);
    if (!added.ok) return fail(`模型没有添加：${JSON.stringify(added.error)}`);
    const stored = added.value.models[0];
    if (stored === undefined) return fail('模型没有添加');
    console.log(`模型：${modelId}（上下文 ${stored.capabilities.contextWindow.toLocaleString('en-US')}，最大输出 ${(maxOutput ?? stored.capabilities.maxOutputTokens).toLocaleString('en-US')}，结构化输出 ${stored.capabilities.structuredOutput}）`);
    if (config !== null) {
      const updated = await app.updateModel(stored, { displayName: stored.displayName, capabilities: { ...config.model.capabilities, selfTestPassed: false, limitsKnown: { contextWindow: true, maxOutputTokens: true } }, prices: config.model.prices });
      if (!updated.ok) return fail(`模型的能力与价格没有保存：${JSON.stringify(updated.error)}`);
    } else if (maxOutput !== null) {
      const updated = await app.updateModel(stored, { displayName: stored.displayName, capabilities: { ...stored.capabilities, maxOutputTokens: maxOutput, limitsKnown: { ...stored.capabilities.limitsKnown, maxOutputTokens: true } }, prices: stored.prices });
      if (!updated.ok) return fail(`模型的最大输出没有保存：${JSON.stringify(updated.error)}`);
    }
    console.log('能力自检…');
    const tested = await app.runSelfTest(stored.id);
    if (!tested.ok) return fail(`能力自检没有完成：${JSON.stringify(tested.error)}`);
    if (!tested.value.report.passed) return fail(`能力自检没有通过：${JSON.stringify(tested.value.report)}`);

    if (scenario.prepare !== undefined) {
      console.log('准备作品…');
      const prepared = await scenario.prepare(app);
      if (!prepared.ok) return fail(prepared.error);
    }
    const records = await runScenario(app, scenario.turns, { log: (line) => console.log(line), now: () => Date.now() });

    const usage = await app.usage();
    const total = usage.ok ? usage.value.summary.total : null;
    const usageLine = total === null ? '没有取到' : `${total.calls} 次调用，输入 ${total.inputTokens.toLocaleString('en-US')} Token，输出 ${total.outputTokens.toLocaleString('en-US')} Token，约 $${total.cost.toFixed(3)}`;
    const work = await app.reloadWork();
    const chapterLines: string[] = ['各章：'];
    const book: string[] = [];
    if (work.ok) {
      for (const c of work.value.chapters) {
        const content = await app.openChapter(c.id);
        const text = content.ok ? content.value.saved.map((p) => p.text).join('\n') : '';
        chapterLines.push(`- 《${c.title}》${countWords(text)} 字`);
        book.push(`# ${c.title}\n\n${text}`);
      }
    }
    writeFileSync(join(dir, 'report.md'), renderReport(records, { scenario: scenario.title, model: `${provider.name} / ${modelId}`, startedAt, usage: usageLine, chapters: chapterLines.join('\n') }));
    writeFileSync(join(dir, 'book.txt'), `${book.join('\n\n')}\n`);
    console.log(`\n用量：${usageLine}\n报告：${join(dir, 'report.md')}\n正文：${join(dir, 'book.txt')}`);
    return 0;
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
