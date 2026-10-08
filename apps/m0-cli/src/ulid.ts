import { randomBytes } from 'node:crypto';
import { ulid as pureUlid } from '@fudiao/shared';

/** 命令行的标识：系统时钟加 Node 的随机源。 */
export const ulid = (now: number = Date.now(), random: Uint8Array = randomBytes(10)): string => pureUlid(now, random);
