import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { build } from './build';
import { paths, readLock, readSources } from './files';

const { generated, lock, errors } = build(readSources(), readLock());
if (errors.length > 0) {
  process.stderr.write(`${errors.join('\n')}\n`);
  process.exit(1);
}
mkdirSync(dirname(paths.generated), { recursive: true });
writeFileSync(paths.generated, generated);
writeFileSync(paths.lock, `${JSON.stringify(lock, null, 2)}\n`);
process.stdout.write(`已生成 ${Object.keys(lock).length} 个模板。\n`);
