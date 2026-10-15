// 由提示词模板文件生成 packages/prompts/src/generated/templates.ts，并维护版本锁。
// 修改模板必须提升版本号（硬性规则 12）：内容变了而版本没变时，生成失败。
import { sha256, SKILL_STAGES } from '@fudiao/shared';
import { parseSkillMd } from '../../packages/prompts/src/skill-md';

export type Lock = Readonly<Record<string, { readonly version: string; readonly sha256: string }>>;

export type Sources = {
  readonly templates: Readonly<Record<string, string>>;
  readonly partials: Readonly<Record<string, string>>;
  /** 内置写作技能（需求 B61）：SKILL.md 格式，文件名为技能键（与 name 相同），metadata 声明名称、版本、顺序与阶段（stages，可不写）。版本锁中记为 skill:键。 */
  readonly skills?: Readonly<Record<string, string>>;
};

const versionOf = (source: string): string | undefined => /^version:\s*(\S+)\s*$/m.exec(source)?.[1];

const partialRefs = (source: string): string[] => [...source.matchAll(/{{\s*>\s*([\w-]+)\s*}}/g)].map((m) => m[1] ?? '');

/** 模板的内容哈希包括它直接或间接引用的局部模板：改动局部模板同样改变提示词。 */
export function templateHash(source: string, partials: Sources['partials']): string {
  const used = new Set<string>();
  const queue = partialRefs(source);
  while (queue.length > 0) {
    const name = queue.shift() ?? '';
    if (used.has(name)) continue;
    used.add(name);
    queue.push(...partialRefs(partials[name] ?? ''));
  }
  const parts = [source, ...[...used].sort().map((name) => `\n@@partial ${name}\n${partials[name] ?? ''}`)];
  return sha256(parts.join(''));
}

export function build(sources: Sources, previous: Lock): { generated: string; lock: Lock; errors: string[] } {
  const errors: string[] = [];
  const lock: Record<string, { version: string; sha256: string }> = {};
  for (const [id, source] of Object.entries(sources.templates).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const version = versionOf(source);
    if (version === undefined) {
      errors.push(`${id}：缺少版本号`);
      continue;
    }
    const hash = templateHash(source, sources.partials);
    const before = previous[id];
    if (before !== undefined && before.sha256 !== hash && before.version === version) {
      errors.push(`${id}：内容已修改，请提升版本号（当前 ${version}）`);
    }
    for (const name of partialRefs(source)) {
      if (sources.partials[name] === undefined) errors.push(`${id}：引用了不存在的局部模板 ${name}`);
    }
    lock[id] = { version, sha256: hash };
  }

  for (const [key, source] of Object.entries(sources.skills ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const id = `skill:${key}`;
    const doc = parseSkillMd(source);
    if (!doc.ok) {
      errors.push(`${id}：${doc.error}`);
      continue;
    }
    const version = doc.value.metadata['version'];
    if (version === undefined || version === '') {
      errors.push(`${id}：metadata 缺少 version`);
      continue;
    }
    if (doc.value.name !== key) errors.push(`${id}：name 须与文件名相同（现在是 ${doc.value.name}）`);
    if ((doc.value.metadata['title'] ?? '') === '' || !/^\d+$/.test(doc.value.metadata['order'] ?? '')) errors.push(`${id}：metadata 须有 title 与 order`);
    const stages = doc.value.metadata['stages'];
    if (stages !== undefined && stages.split(/\s+/).some((s) => s !== '' && !(SKILL_STAGES as readonly string[]).includes(s))) {
      errors.push(`${id}：metadata.stages 只能是 ${SKILL_STAGES.join('、')}（空格分开），现在是 ${stages}`);
    }
    const hash = sha256(source);
    const before = previous[id];
    if (before !== undefined && before.sha256 !== hash && before.version === version) {
      errors.push(`${id}：内容已修改，请提升版本号（当前 ${version}）`);
    }
    lock[id] = { version, sha256: hash };
  }

  const literal = (record: Readonly<Record<string, string>>) =>
    Object.entries(record)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`)
      .join('\n');
  const generated = [
    '// 由 tools/prompts/build.ts 生成，不要手工修改。修改 packages/prompts/templates 后运行 pnpm prompts:build。',
    '',
    'export const TEMPLATE_SOURCES = {',
    literal(sources.templates),
    '} as const;',
    '',
    'export const PARTIAL_SOURCES: Readonly<Record<string, string>> = {',
    literal(sources.partials),
    '};',
    '',
    'export const SKILL_SOURCES: Readonly<Record<string, string>> = {',
    literal(sources.skills ?? {}),
    '};',
    '',
  ].join('\n');

  return { generated, lock, errors };
}
