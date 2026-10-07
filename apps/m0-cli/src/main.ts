import { parseCommand, usage } from './commands';

const parsed = parseCommand(process.argv.slice(2));

if (!parsed.ok) {
  process.stderr.write(`${parsed.error}\n\n${usage}\n`);
  process.exitCode = 1;
} else if (parsed.value === 'help') {
  process.stdout.write(`${usage}\n`);
} else {
  process.stderr.write(`命令 ${parsed.value} 尚未实现（M0-09）。\n`);
  process.exitCode = 1;
}
