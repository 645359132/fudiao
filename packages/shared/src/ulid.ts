const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * ULID：48 位毫秒时间加 80 位随机数，按时间可排序（硬性规则 22）。
 * 时间与随机字节由调用方传入，本函数保持纯函数；各运行环境用自己的时钟与随机源包装。
 */
export function ulid(now: number, random: Uint8Array): string {
  if (random.length !== 10) throw new Error('ULID 的随机部分必须是 10 字节');
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET.charAt(t % 32) + time;
    t = Math.floor(t / 32);
  }
  let bits = 0n;
  for (const byte of random) bits = (bits << 8n) | BigInt(byte);
  let rand = '';
  for (let i = 0; i < 16; i++) {
    rand = ALPHABET.charAt(Number(bits & 31n)) + rand;
    bits >>= 5n;
  }
  return time + rand;
}
