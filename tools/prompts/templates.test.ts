import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { build, templateHash } from './build';
import { paths, readLock, readSources } from './files';

describe('提示词模板与生成文件', () => {
  const sources = readSources();
  const lock = readLock();
  const result = build(sources, lock);

  it('没有错误：版本号齐全、局部模板存在、修改过的模板已提升版本', () => {
    expect(result.errors).toEqual([]);
  });

  it('生成文件与模板文件一致（修改模板后运行 pnpm prompts:build）', () => {
    expect(readFileSync(paths.generated, 'utf8')).toBe(result.generated);
  });

  it('版本锁与模板一致', () => {
    expect(lock).toEqual(result.lock);
  });
});

describe('版本锁规则', () => {
  const partials = { p: 'P1' };
  const template = (body: string, version = '1') => `---\nid: t\nversion: ${version}\ntask: x\n---\n@@user\n${body}`;

  it('内容变化而版本不变时报错', () => {
    const previous = { t: { version: '1', sha256: templateHash(template('旧'), partials) } };
    expect(build({ templates: { t: template('新') }, partials }, previous).errors).toEqual([
      't：内容已修改，请提升版本号（当前 1）',
    ]);
    expect(build({ templates: { t: template('新', '2') }, partials }, previous).errors).toEqual([]);
  });

  it('内置写作技能同样要求修改后提升版本号，文件头须有名称与顺序', () => {
    const skill = (body: string, version = '1') => `---\nversion: ${version}\nname: 章末钩子\norder: 1\n---\n${body}`;
    const first = build({ templates: {}, partials, skills: { hook: skill('旧') } }, {});
    expect(first.errors).toEqual([]);
    expect(Object.keys(first.lock)).toEqual(['skill:hook']);
    expect(build({ templates: {}, partials, skills: { hook: skill('新') } }, first.lock).errors).toEqual(['skill:hook：内容已修改，请提升版本号（当前 1）']);
    expect(build({ templates: {}, partials, skills: { hook: skill('新', '2') } }, first.lock).errors).toEqual([]);
    expect(build({ templates: {}, partials, skills: { bad: '---\nversion: 1\n---\n文字' } }, {}).errors).toEqual(['skill:bad：文件头须有 name 与 order']);
  });

  it('局部模板的改动计入引用它的模板', () => {
    const source = template('{{> p}}');
    expect(templateHash(source, { p: 'P1' })).not.toBe(templateHash(source, { p: 'P2' }));
    expect(templateHash(template('无引用'), { p: 'P1' })).toBe(templateHash(template('无引用'), { p: 'P2' }));
  });
});
