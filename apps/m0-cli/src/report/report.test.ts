import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseCsv, toCsv } from './csv';
import { analyze, assign, loadManifest, loadSamples, writePackets, type Manifest } from './report';

const root = mkdtempSync(join(tmpdir(), 'fudiao-report-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const scenes = ['warehouse', 'pawnshop', 'rainy'];
const conditions = ['baseline', 'simulation'] as const;

function makeSamples(): Manifest['samples'] {
  const samples: Manifest['samples'][number][] = [];
  for (const scene of scenes) {
    for (const condition of conditions) {
      for (let i = 0; i < 3; i++) {
        const dir = join(root, 'samples', `${scene}-${condition}-${i}`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'text.md'), `${scene} 的正文 ${i}`);
        writeFileSync(join(dir, 'synopsis.md'), `- ${scene} 梗概 ${i}`);
        writeFileSync(join(dir, 'meta.json'), JSON.stringify({ kind: condition, costUsd: condition === 'baseline' ? 0.5 : 3, waitMs: 60_000 }));
        samples.push({ scene, condition, dir });
      }
    }
  }
  return samples;
}

const manifest: Manifest = {
  id: 'round1',
  seed: 42,
  evaluators: ['e1', 'e2', 'e3', 'e4', 'e5'],
  perEvaluator: 6,
  samples: makeSamples(),
};

describe('CSV', () => {
  it('引号、逗号与换行可以往返', () => {
    const rows = [['a', 'b,c'], ['"引号"', '换\n行']];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });
});

describe('均衡分配', () => {
  const codes = manifest.samples.map((_, i) => `S${i}`);
  const assignments = assign(manifest, codes);

  it('每位评价者读满阅读量，不重复', () => {
    for (const list of Object.values(assignments)) {
      expect(list).toHaveLength(6);
      expect(new Set(list).size).toBe(6);
    }
  });

  it('每位评价者读到的条件与局面均衡', () => {
    const info = new Map(codes.map((c, i) => [c, manifest.samples[i]!]));
    for (const list of Object.values(assignments)) {
      const byCondition = conditions.map((c) => list.filter((code) => info.get(code)?.condition === c).length);
      expect(Math.max(...byCondition) - Math.min(...byCondition)).toBeLessThanOrEqual(1);
      const byScene = scenes.map((s) => list.filter((code) => info.get(code)?.scene === s).length);
      expect(Math.max(...byScene) - Math.min(...byScene)).toBeLessThanOrEqual(1);
    }
  });

  it('每份样本的阅读次数相差不超过 1', () => {
    const reads = codes.map((c) => Object.values(assignments).filter((l) => l.includes(c)).length);
    expect(Math.max(...reads) - Math.min(...reads)).toBeLessThanOrEqual(1);
  });
});

describe('评估包与汇总', () => {
  const out = join(root, 'packets');
  const samples = loadSamples(manifest, (p) => p);
  if (!samples.ok) throw new Error(samples.error);
  const key = writePackets(out, manifest, samples.value);

  it('评估包只含梗概与正文，不暴露来源；答案键单独存放', () => {
    const files = readdirSync(join(out, 'e1'));
    expect(files).toContain('评分表.csv');
    expect(files).toContain('评价说明.md');
    for (const f of files.filter((f) => /^S\d+\.md$/.test(f))) {
      const text = readFileSync(join(out, 'e1', f), 'utf8');
      expect(text).toContain('## 事件梗概');
      expect(text).not.toMatch(/baseline|simulation|samples|costUsd/);
    }
    expect(readdirSync(join(out, '_key')).sort()).toEqual(['README.md', 'answer-key.json'].sort());
    expect(key.samples).toHaveLength(18);
  });

  it('评分表每份样本有梗概与正文两行', () => {
    const rows = parseCsv(readFileSync(join(out, 'e1', '评分表.csv'), 'utf8'));
    expect(rows).toHaveLength(1 + 6 * 2);
    expect(rows[1]?.[1]).toBe('梗概');
    expect(rows[2]?.[1]).toBe('正文');
  });

  it('汇总评分：按条件与层面求平均，附费用与等待', () => {
    for (const evaluator of manifest.evaluators) {
      const file = join(out, evaluator, '评分表.csv');
      const [header, ...rows] = parseCsv(readFileSync(file, 'utf8'));
      const condition = new Map(key.samples.map((s) => [s.code, s.condition]));
      const filled = rows.map((r) => {
        const score = condition.get(r[0] ?? '') === 'simulation' ? '4' : '2';
        return [r[0] ?? '', r[1] ?? '', score, score, score, score, '1', '备注，含逗号'];
      });
      writeFileSync(file, toCsv([header ?? [], ...filled]));
    }
    const report = analyze(out);
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value).toContain('| 角色推演 | 4.00（15） | 4.00（15）');
    expect(report.value).toContain('| 单次提示词对照组 | 2.00（15）');
    expect(report.value).toContain('| 角色推演 | 3.000 | 60.0 | 9 |');
  });
});

describe('精简评估包（只看梗概、只打部分评分项）', () => {
  const out = join(root, 'packets-lite');
  const lite: Manifest = { ...manifest, id: 'lite', layers: ['梗概'], dimensions: ['twist', 'adopt'] };
  const samples = loadSamples(lite, (p) => p);
  if (!samples.ok) throw new Error(samples.error);
  const key = writePackets(out, lite, samples.value);

  it('样本只含梗概，评分表只有梗概一行与选定的评分项', () => {
    const files = readdirSync(join(out, 'e1')).filter((f) => /^S\d+\.md$/.test(f));
    for (const f of files) {
      const text = readFileSync(join(out, 'e1', f), 'utf8');
      expect(text).toContain('## 事件梗概');
      expect(text).not.toContain('## 正文');
      expect(text).not.toContain('的正文');
    }
    const rows = parseCsv(readFileSync(join(out, 'e1', '评分表.csv'), 'utf8'));
    expect(rows[0]).toEqual(['样本', '层面', '意外但合理的转折（1-5）', '采纳意愿（1-5）', '备注']);
    expect(rows).toHaveLength(1 + 6);
    expect(rows.slice(1).every((r) => r[1] === '梗概')).toBe(true);
    const readme = readFileSync(join(out, 'e1', '评价说明.md'), 'utf8');
    expect(readme).toContain('事件梗概');
    expect(readme).not.toContain('采纳前修改量');
  });

  it('汇总按表头识别评分项，未出现的评分项与层面显示为空', () => {
    for (const evaluator of lite.evaluators) {
      const file = join(out, evaluator, '评分表.csv');
      const [header, ...rows] = parseCsv(readFileSync(file, 'utf8'));
      const condition = new Map(key.samples.map((s) => [s.code, s.condition]));
      const filled = rows.map((r) => {
        const score = condition.get(r[0] ?? '') === 'simulation' ? '5' : '3';
        return [r[0] ?? '', r[1] ?? '', score, score, ''];
      });
      writeFileSync(file, toCsv([header ?? [], ...filled]));
    }
    const report = analyze(out);
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value).toContain('| 角色推演 | — | — | 5.00（15） | 5.00（15） | — |');
    expect(report.value).toContain('| 单次提示词对照组 | — | — | 3.00（15） | 3.00（15） | — |');
  });

  it('清单中未知的层面或评分项报错', () => {
    const base = 'id: x\nevaluators: [a]\nperEvaluator: 1\nsamples:\n  - { scene: s, condition: baseline, dir: d }\n';
    expect(loadManifest(`${base}layers: [大纲]\n`).ok).toBe(false);
    expect(loadManifest(`${base}dimensions: [nope]\n`).ok).toBe(false);
    expect(loadManifest(`${base}layers: [梗概]\ndimensions: [twist]\n`).ok).toBe(true);
  });
});

describe('作者挑选的样本', () => {
  it('与原属条件是同一篇时，同一位评价者不会读到两次', () => {
    const samples: Manifest['samples'] = [
      ...makeSamples(),
      ...scenes.map((scene) => ({ scene, condition: 'batch_pick' as const, dir: join(root, 'samples', `${scene}-simulation-0`) })),
    ];
    const manifest: Manifest = { id: 'pick', seed: 3, evaluators: ['甲', '乙', '丙', '丁', '戊'], perEvaluator: 9, samples };
    const codes = samples.map((_, i) => `S${String(i + 1).padStart(2, '0')}`);
    const dirOf = new Map(codes.map((c, i) => [c, samples[i]!.dir]));
    for (const mine of Object.values(assign(manifest, codes))) {
      const dirs = mine.map((c) => dirOf.get(c));
      expect(new Set(dirs).size).toBe(dirs.length);
    }
  });
});

describe('清单校验', () => {
  it('阅读量大于样本数时报错', () => {
    expect(loadManifest('id: x\nevaluators: [a]\nperEvaluator: 5\nsamples:\n  - { scene: s, condition: baseline, dir: d }\n')).toEqual({
      ok: false,
      error: 'perEvaluator 不能大于样本数',
    });
  });

  it('两种导演触发方式是两个条件（m0/README.md），笼统的 director 不再接受', () => {
    const manifest = (condition: string) => `id: x
evaluators: [a]
perEvaluator: 1
samples:
  - { scene: s, condition: ${condition}, dir: d }
`;
    expect(loadManifest(manifest('director_stalemate')).ok).toBe(true);
    expect(loadManifest(manifest('director_curve')).ok).toBe(true);
    expect(loadManifest(manifest('director')).ok).toBe(false);
  });
});
