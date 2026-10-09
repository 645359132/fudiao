import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '**/src-tauri/target/**', '**/src-tauri/gen/**', 'tools/**/fixtures/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      // 允许用解构剩余属性的写法去掉某个字段。
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // Vitest 的非对称匹配器（expect.objectContaining 等）类型为 any。
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: { '@typescript-eslint/no-unsafe-assignment': 'off' },
  },
  {
    files: ['**/*.js', '**/*.cjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },
  {
    // 硬性规则 11：模型输出只能在 packages/llm 的结构化输出管线中解析。
    // 推演与上下文相关的包没有解析 JSON 的正当理由，在此直接禁止。
    files: [
      'packages/domain/src/**/*.ts',
      'packages/writing/src/**/*.ts',
      'packages/engine/src/**/*.ts',
      'packages/context/src/**/*.ts',
      'packages/prompts/src/**/*.ts',
    ],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'JSON',
          property: 'parse',
          message: '模型输出只能经 packages/llm 的结构化输出管线解析（硬性规则 11）。',
        },
      ],
    },
  },
  {
    // 硬性规则 5、7、22：领域内核是纯函数，时间与随机数由调用方作为数据传入；packages/writing 同样是纯函数。
    files: ['packages/domain/src/**/*.ts', 'packages/writing/src/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'JSON',
          property: 'parse',
          message: '模型输出只能经 packages/llm 的结构化输出管线解析（硬性规则 11）。',
        },
        {
          object: 'Math',
          property: 'random',
          message: '随机数状态属于推演状态，抽取结果写入事件（硬性规则 7）。',
        },
        {
          object: 'Date',
          property: 'now',
          message: '领域内核不读取系统时间，时间由调用方传入。',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date']",
          message: '领域内核不读取系统时间，时间由调用方传入。',
        },
      ],
    },
  },
);
