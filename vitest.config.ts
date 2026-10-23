import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.{ts,tsx}', 'tools/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'tools/**/fixtures/**'],
    // 不少测试在磁盘上新建作品库（二十多个迁移）并跑完整个流程；GitHub 的 Windows 机器上文件读写比开发机慢好几倍，
    // 默认的 5 秒不够（2026-10-23 的持续集成里推演的中断恢复测试超时）。真正卡住的测试照样会失败，只是晚一点。
    testTimeout: 20_000,
  },
});
