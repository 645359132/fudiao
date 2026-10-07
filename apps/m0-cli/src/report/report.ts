import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { drawInt, seedRng, type RngState } from '@fudiao/domain';
import { err, ok, type Result } from '@fudiao/shared';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { parseCsv, toCsv } from './csv';

// M0 评估材料（需求第八章“M0 推演验证”）：按局面与条件均衡分配，隐藏来源，答案键单独保存。

export const CONDITIONS = ['baseline', 'simulation', 'director', 'batch_pick'] as const;
export type Condition = (typeof CONDITIONS)[number];

export const CONDITION_LABEL: Readonly<Record<Condition, string>> = {
  baseline: '单次提示词对照组',
  simulation: '角色推演',
  director: '角色推演 + 导演提议',
  batch_pick: '批量推演后由作者挑选',
};

/** 评价维度（需求：人物、情报依赖、转折、采纳意愿与修改量）。 */
export const DIMENSIONS = [
  { key: 'characters', label: '人物可信且可区分（1-5）' },
  { key: 'intel', label: '行动依赖实际情报（1-5）' },
  { key: 'twist', label: '意外但合理的转折（1-5）' },
  { key: 'adopt', label: '采纳意愿（1-5）' },
  { key: 'edits', label: '采纳前修改量（0 无，1 少量，2 较多，3 需重写）' },
] as const;

export const LAYERS = ['梗概', '正文'] as const;

export const Manifest = z.object({
  id: z.string().min(1),
  seed: z.number().int().min(0).default(1),
  evaluators: z.array(z.string().min(1)).min(1),
  /** 每位评价者阅读的样本数，控制阅读量。 */
  perEvaluator: z.number().int().positive(),
  samples: z
    .array(z.object({ scene: z.string().min(1), condition: z.enum(CONDITIONS), dir: z.string().min(1) }))
    .min(1),
});
export type Manifest = z.infer<typeof Manifest>;

export type Sample = Manifest['samples'][number] & {
  readonly code: string;
  readonly synopsis: string;
  readonly text: string;
  readonly costUsd: number | null;
  readonly waitMs: number | null;
};

export type AnswerKey = {
  readonly id: string;
  readonly samples: readonly Omit<Sample, 'synopsis' | 'text'>[];
  readonly assignments: Readonly<Record<string, readonly string[]>>;
};

export function loadManifest(text: string): Result<Manifest, string> {
  const parsed = Manifest.safeParse(parseYaml(text));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return err(`${issue?.path.join('.') ?? ''}: ${issue?.message ?? ''}`);
  }
  const m = parsed.data;
  if (m.perEvaluator > m.samples.length) return err('perEvaluator 不能大于样本数');
  return ok(m);
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

function shuffle<T>(items: readonly T[], rng: RngState): { items: T[]; rng: RngState } {
  const out = [...items];
  let state = rng;
  for (let i = out.length - 1; i > 0; i--) {
    const d = drawInt(state, i + 1);
    state = d.rng;
    [out[i], out[d.value]] = [out[d.value]!, out[i]!];
  }
  return { items: out, rng: state };
}

/**
 * 均衡分配：每位评价者按轮转的次序依次从各（局面，条件）组合中取样，
 * 每次取被分配次数最少的样本；同一评价者不重复阅读同一样本。
 */
export function assign(manifest: Manifest, codes: readonly string[]): Record<string, string[]> {
  const scenes = [...new Set(manifest.samples.map((s) => s.scene))];
  const conditions = CONDITIONS.filter((c) => manifest.samples.some((s) => s.condition === c));
  const count = new Map(codes.map((c) => [c, 0]));
  const result: Record<string, string[]> = {};

  manifest.evaluators.forEach((evaluator, k) => {
    // 类似拉丁方的交错：每连续若干篇覆盖全部条件，且局面逐组错开；第 k 位评价者整体偏移 k，
    // 使条件与局面在评价者之间也错开。
    // 条件取 j mod C，局面取 (j + ⌊j / lcm(C, S)⌋) mod S：遍历全部组合，且任意前缀中条件与局面各自相差不超过 1。
    const total = conditions.length * scenes.length;
    const lcm = (conditions.length * scenes.length) / gcd(conditions.length, scenes.length);
    const ordered: { scene: string; condition: Condition }[] = [];
    for (let i = 0; i < total; i++) {
      // 偏移后仍须落在一个完整周期内，否则局面的平移会重复某些组合。
      const j = (i + k) % total;
      const condition = conditions[j % conditions.length]!;
      const scene = scenes[(j + Math.floor(j / lcm)) % scenes.length]!;
      if (manifest.samples.some((s) => s.scene === scene && s.condition === condition)) ordered.push({ scene, condition });
    }
    const mine: string[] = [];
    for (let pass = 0; mine.length < manifest.perEvaluator && pass < manifest.perEvaluator * 2; pass++) {
      for (const cell of ordered) {
        if (mine.length >= manifest.perEvaluator) break;
        const candidates = manifest.samples
          .map((s, i) => ({ s, code: codes[i]! }))
          .filter(({ s, code }) => s.scene === cell.scene && s.condition === cell.condition && !mine.includes(code))
          .sort((a, b) => (count.get(a.code) ?? 0) - (count.get(b.code) ?? 0) || (a.code < b.code ? -1 : 1));
        const pick = candidates[0];
        if (pick === undefined) continue;
        mine.push(pick.code);
        count.set(pick.code, (count.get(pick.code) ?? 0) + 1);
      }
    }
    result[evaluator] = mine;
  });
  return result;
}

const read = (dir: string, file: string) => (existsSync(join(dir, file)) ? readFileSync(join(dir, file), 'utf8').trim() : '');

export function loadSamples(manifest: Manifest, resolve: (p: string) => string): Result<Sample[], string> {
  const rng = seedRng(manifest.seed);
  const numbers = shuffle(
    manifest.samples.map((_, i) => i + 1),
    rng,
  ).items;
  const samples: Sample[] = [];
  for (const [i, s] of manifest.samples.entries()) {
    const dir = resolve(s.dir);
    const text = read(dir, 'text.md');
    const synopsis = read(dir, 'synopsis.md');
    if (text === '' || synopsis === '') return err(`样本缺少正文或梗概：${s.dir}`);
    const meta = existsSync(join(dir, 'meta.json'))
      ? (JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as { costUsd?: number | null; waitMs?: number | null })
      : {};
    samples.push({
      ...s,
      code: `S${String(numbers[i]).padStart(2, '0')}`,
      synopsis,
      text,
      costUsd: meta.costUsd ?? null,
      waitMs: meta.waitMs ?? null,
    });
  }
  return ok(samples);
}

const EVALUATOR_README = (perEvaluator: number) => `# 评价说明

你会读到 ${perEvaluator} 份样本。每份都是同一类局面下的一场戏，包含“事件梗概”与“正文”两部分。样本的来源已经隐藏，请不要猜测或打听它们是怎么写出来的。

请在“评分表.csv”中为每份样本的梗概与正文分别打分：

${DIMENSIONS.map((d) => `- ${d.label}`).join('\n')}

“备注”中可以写下值得采用的转折、违和之处或需要修改的地方。每份样本请独立评价，不必互相比较。

判定门槛已在实验前与评价者一同确定，记录在 m0/DECISION.md 中，实验后不调整。
`;

/** 生成评估包：每位评价者一个文件夹（样本与评分表），答案键单独存放。 */
export function writePackets(outDir: string, manifest: Manifest, samples: readonly Sample[]): AnswerKey {
  const assignments = assign(
    manifest,
    samples.map((s) => s.code),
  );
  const byCode = new Map(samples.map((s) => [s.code, s]));
  mkdirSync(outDir, { recursive: true });
  for (const [evaluator, codes] of Object.entries(assignments)) {
    const dir = join(outDir, evaluator);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '评价说明.md'), EVALUATOR_README(codes.length));
    for (const code of codes) {
      const s = byCode.get(code);
      if (s === undefined) continue;
      writeFileSync(join(dir, `${code}.md`), `# 样本 ${code}\n\n## 事件梗概\n\n${s.synopsis}\n\n## 正文\n\n${s.text}\n`);
    }
    writeFileSync(
      join(dir, '评分表.csv'),
      toCsv([
        ['样本', '层面', ...DIMENSIONS.map((d) => d.label), '备注'],
        ...codes.flatMap((code) => LAYERS.map((layer) => [code, layer, ...DIMENSIONS.map(() => ''), ''])),
      ]),
    );
  }
  const key: AnswerKey = {
    id: manifest.id,
    samples: samples.map(({ synopsis, text, ...rest }) => rest),
    assignments,
  };
  const keyDir = join(outDir, '_key');
  mkdirSync(keyDir, { recursive: true });
  writeFileSync(join(keyDir, 'answer-key.json'), `${JSON.stringify(key, null, 2)}\n`);
  writeFileSync(join(keyDir, 'README.md'), '# 答案键\n\n此文件夹记录每份样本的来源，不得分发给评价者。\n');
  return key;
}

type Cell = { sum: number; n: number };

/** 汇总评分：按条件与层面求各维度的平均分，并附上费用与等待时间。 */
export function analyze(outDir: string): Result<string, string> {
  const keyFile = join(outDir, '_key', 'answer-key.json');
  if (!existsSync(keyFile)) return err('找不到答案键');
  const key = JSON.parse(readFileSync(keyFile, 'utf8')) as AnswerKey;
  const conditionOf = new Map(key.samples.map((s) => [s.code, s.condition]));
  const cells = new Map<string, Cell>();
  let rows = 0;
  for (const evaluator of readdirSync(outDir).filter((d) => d !== '_key' && existsSync(join(outDir, d, '评分表.csv')))) {
    const [header, ...data] = parseCsv(readFileSync(join(outDir, evaluator, '评分表.csv'), 'utf8'));
    if (header === undefined) continue;
    for (const row of data) {
      const [code = '', layer = ''] = row;
      const condition = conditionOf.get(code);
      if (condition === undefined) continue;
      DIMENSIONS.forEach((d, i) => {
        const raw = row[2 + i]?.trim() ?? '';
        if (raw === '') return;
        const value = Number(raw);
        if (!Number.isFinite(value)) return;
        const id = `${condition}|${layer}|${d.key}`;
        const cell = cells.get(id) ?? { sum: 0, n: 0 };
        cells.set(id, { sum: cell.sum + value, n: cell.n + 1 });
      });
      rows++;
    }
  }
  const present = CONDITIONS.filter((c) => key.samples.some((s) => s.condition === c));
  const fmt = (c: Cell | undefined) => (c === undefined || c.n === 0 ? '—' : `${(c.sum / c.n).toFixed(2)}（${c.n}）`);
  const lines = [`# 评分汇总：${key.id}`, '', `共读入 ${rows} 行评分。括号内为评分数。`, ''];
  for (const layer of LAYERS) {
    lines.push(`## ${layer}`, '', `| 条件 | ${DIMENSIONS.map((d) => d.label).join(' | ')} |`, `| --- | ${DIMENSIONS.map(() => '---').join(' | ')} |`);
    for (const c of present) {
      lines.push(`| ${CONDITION_LABEL[c]} | ${DIMENSIONS.map((d) => fmt(cells.get(`${c}|${layer}|${d.key}`))).join(' | ')} |`);
    }
    lines.push('');
  }
  lines.push('## 费用与等待', '', '| 条件 | 平均费用（美元） | 平均等待（秒） | 样本数 |', '| --- | --- | --- | --- |');
  for (const c of present) {
    const ss = key.samples.filter((s) => s.condition === c);
    const avg = (xs: (number | null)[]) => {
      const known = xs.filter((x): x is number => x !== null);
      return known.length === 0 ? null : known.reduce((a, b) => a + b, 0) / known.length;
    };
    const cost = avg(ss.map((s) => s.costUsd));
    const wait = avg(ss.map((s) => s.waitMs));
    lines.push(`| ${CONDITION_LABEL[c]} | ${cost === null ? '未知' : cost.toFixed(3)} | ${wait === null ? '未知' : (wait / 1000).toFixed(1)} | ${ss.length} |`);
  }
  return ok(`${lines.join('\n')}\n`);
}
