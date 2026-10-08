// 依赖边界检查。规则来源：AGENTS.md“仓库结构与依赖方向”、施工文档第三章。
// 依赖只能向内：apps → engine / context / store / llm → domain → shared。

// 测试文件与 src/testing/ 下的测试辅助代码（夹具、随机生成器）。
const TEST_FILE = '(\\.test\\.tsx?$|/src/testing/)';

// 领域内核与 shared 可以使用的第三方包。新增前须说明理由与许可证（AGENTS.md“工作方式”）。
const PURE_NPM_ALLOWLIST = ['zod'];

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: '包之间与模块之间不得循环依赖。',
      from: {},
      to: { circular: true },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      comment: '无法解析的导入通常是拼写错误或缺少依赖声明。',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'shared-is-leaf',
      severity: 'error',
      comment: 'packages/shared 位于最内层，不得依赖其他工作区包。',
      from: { path: '^packages/shared/' },
      to: { path: '^(packages|apps)/', pathNot: '^packages/shared/' },
    },
    {
      name: 'domain-depends-only-on-shared',
      severity: 'error',
      comment: '领域内核只能依赖 packages/shared。',
      from: { path: '^packages/domain/' },
      to: { path: '^(packages|apps)/', pathNot: '^packages/(domain|shared)/' },
    },
    {
      name: 'packages-not-to-apps',
      severity: 'error',
      comment: '依赖只能向内，packages 不得依赖 apps。',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'pure-core-no-node-builtins',
      severity: 'error',
      comment: '领域内核与 shared 禁止任何 IO，也要能在 WebView 中运行，不得导入 Node 内置模块。',
      from: { path: '^packages/(domain|shared)/' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'desktop-ui-no-node-builtins',
      severity: 'error',
      comment: '桌面界面运行在 WebView 中，没有 Node；测试可以使用 Node 内置模块。',
      from: { path: '^apps/desktop/src/', pathNot: TEST_FILE },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'pure-core-npm-allowlist',
      severity: 'error',
      comment: `领域内核与 shared 只能使用白名单内的第三方包（${PURE_NPM_ALLOWLIST.join('、')}），防止引入 Tauri、数据库或网络库。`,
      from: { path: '^packages/(domain|shared)/', pathNot: TEST_FILE },
      to: {
        dependencyTypesNot: ['local', 'core'],
        pathNot: [`node_modules/(${PURE_NPM_ALLOWLIST.join('|')})/`, '^packages/(domain|shared)/'],
      },
    },
    {
      name: 'not-to-dev-dep',
      severity: 'error',
      comment: '产品代码不得导入开发依赖（测试文件除外）。',
      from: { path: '^(packages|apps)/[^/]+/src/', pathNot: TEST_FILE },
      to: { dependencyTypes: ['npm-dev'] },
    },
    {
      name: 'not-to-testing',
      severity: 'error',
      comment: '产品代码不得导入 src/testing/ 下的测试辅助代码。',
      from: { path: '^(packages|apps)/[^/]+/src/', pathNot: TEST_FILE },
      to: { path: '/src/testing/' },
    },
    {
      name: 'no-undeclared-npm',
      severity: 'error',
      comment: '第三方包必须在 package.json 中声明。',
      from: {},
      to: { dependencyTypes: ['npm-no-pkg', 'npm-unknown'] },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // 仅类型的导入同样受边界约束。
    tsPreCompilationDeps: true,
    combinedDependencies: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.tsx', '.js', '.json'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
