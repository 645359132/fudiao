import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Lock, Sources } from './build';

const root = fileURLToPath(new URL('../../packages/prompts/', import.meta.url));

export const paths = {
  templates: join(root, 'templates'),
  partials: join(root, 'templates', 'partials'),
  generated: join(root, 'src', 'generated', 'templates.ts'),
  lock: join(root, 'templates.lock.json'),
};

const readDir = (dir: string): Record<string, string> =>
  Object.fromEntries(
    readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => [basename(f, '.md'), readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n')]),
  );

// 局部模板常嵌在一行文字中间，去掉文件末尾的换行，避免把句子断开。
const trimFinalNewline = (record: Record<string, string>) =>
  Object.fromEntries(Object.entries(record).map(([k, v]) => [k, v.replace(/\n$/, '')]));

export const readSources = (): Sources => ({
  templates: readDir(paths.templates),
  partials: trimFinalNewline(readDir(paths.partials)),
});

export const readLock = (): Lock =>
  existsSync(paths.lock) ? (JSON.parse(readFileSync(paths.lock, 'utf8')) as Lock) : {};
