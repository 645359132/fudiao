import { createInterface } from 'node:readline/promises';
import { main, type Console } from './cli';
import { ulid } from './ulid';

const terminal: Console = {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
  async confirm(question) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await rl.question(`${question}（y/N）`);
      return /^y(es)?$/i.test(answer.trim());
    } finally {
      rl.close();
    }
  },
};

process.exitCode = await main(process.argv.slice(2), {
  console: terminal,
  env: process.env,
  root: process.cwd(),
  now: () => new Date().toISOString(),
  newId: () => ulid(),
});
