import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { cruise, type ICruiseResult, type IConfiguration } from 'dependency-cruiser';
import { beforeAll, describe, expect, it } from 'vitest';

// 用一组故意违规的夹具验证 .dependency-cruiser.cjs 的每条规则确实生效，
// 防止规则写错后 pnpm depcheck 静默通过。
const config = createRequire(import.meta.url)('../../.dependency-cruiser.cjs') as IConfiguration;
const fixtureRoot = fileURLToPath(new URL('./fixtures', import.meta.url));

type Violation = { rule: string; from: string; to: string };

let violations: Violation[] = [];

const rulesFor = (from: string): string[] =>
  violations.filter((v) => v.from === from).map((v) => v.rule).sort();

beforeAll(async () => {
  const { output } = await cruise(['packages', 'apps'], {
    ...config.options,
    validate: true,
    ruleSet: { forbidden: config.forbidden ?? [] },
    baseDir: fixtureRoot,
  });
  violations = (output as ICruiseResult).summary.violations.map((v) => ({
    rule: v.rule.name,
    from: v.from,
    to: v.to,
  }));
}, 60_000);

describe('依赖边界规则', () => {
  it('领域内核可以依赖 shared', () => {
    expect(rulesFor('packages/domain/src/allowed.ts')).toEqual([]);
  });

  it('领域内核不得导入 Node 内置模块', () => {
    expect(rulesFor('packages/domain/src/uses-node-builtin.ts')).toEqual([
      'pure-core-no-node-builtins',
    ]);
  });

  it('领域内核不得依赖外层包', () => {
    expect(rulesFor('packages/domain/src/imports-engine.ts')).toEqual([
      'domain-depends-only-on-shared',
    ]);
  });

  it('领域内核不得使用白名单以外的第三方包', () => {
    expect(rulesFor('packages/domain/src/imports-npm.ts')).toEqual(['pure-core-npm-allowlist']);
  });

  it('shared 不得依赖其他工作区包', () => {
    expect(rulesFor('packages/shared/src/imports-engine.ts')).toEqual(['shared-is-leaf']);
  });

  it('packages 不得依赖 apps', () => {
    expect(rulesFor('packages/engine/src/imports-app.ts')).toEqual(['packages-not-to-apps']);
  });

  it('产品代码不得导入开发依赖，测试文件可以', () => {
    expect(rulesFor('packages/engine/src/imports-dev-dep.ts')).toEqual(['not-to-dev-dep']);
    expect(rulesFor('packages/engine/src/allowed.test.ts')).toEqual([]);
    expect(rulesFor('packages/domain/src/testing/helper.ts')).toEqual([]);
  });

  it('产品代码不得导入测试辅助代码', () => {
    expect(rulesFor('packages/domain/src/imports-testing.ts')).toEqual(['not-to-testing']);
  });

  it('检出循环依赖', () => {
    expect(rulesFor('packages/engine/src/cycle-a.ts')).toEqual(['no-circular']);
  });

  it('检出无法解析的导入', () => {
    expect(rulesFor('packages/engine/src/unresolvable.ts')).toEqual(['not-to-unresolvable']);
  });
});
