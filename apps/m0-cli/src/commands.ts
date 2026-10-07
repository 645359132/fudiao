import { err, ok, type Result } from '@novel-writer/shared';

export const commands = ['run', 'baseline', 'narrate', 'motive-check', 'report'] as const;
export type Command = (typeof commands)[number];

export const usage = [
  '用法：pnpm m0 <命令> [参数]',
  '',
  '命令：',
  '  run           运行推演场景',
  '  baseline      运行单次提示词对照组',
  '  narrate       由推演记录生成正文',
  '  motive-check  动机可达性检验',
  '  report        生成评估材料',
].join('\n');

const isCommand = (s: string): s is Command => (commands as readonly string[]).includes(s);

export function parseCommand(argv: readonly string[]): Result<Command | 'help', string> {
  const [first] = argv;
  if (first === undefined || first === 'help' || first === '--help' || first === '-h') {
    return ok('help');
  }
  return isCommand(first) ? ok(first) : err(`未知命令：${first}`);
}
