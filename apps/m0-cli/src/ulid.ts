import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** ULID：48 位毫秒时间加 80 位随机数，按时间可排序（硬性规则 22）。 */
export function ulid(now: number = Date.now(), random: Uint8Array = randomBytes(10)): string {
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = (ALPHABET[t % 32] ?? '0') + time;
    t = Math.floor(t / 32);
  }
  let bits = 0n;
  for (const byte of random) bits = (bits << 8n) | BigInt(byte);
  let rand = '';
  for (let i = 0; i < 16; i++) {
    rand = (ALPHABET[Number(bits & 31n)] ?? '0') + rand;
    bits >>= 5n;
  }
  return time + rand;
}
