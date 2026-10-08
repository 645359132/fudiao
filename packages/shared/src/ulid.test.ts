import { describe, expect, it } from 'vitest';
import { ulid } from './ulid';

describe('ULID', () => {
  it('26 位，按时间可排序', () => {
    const a = ulid(1_000, new Uint8Array(10));
    const b = ulid(2_000, new Uint8Array(10).fill(255));
    expect(a).toHaveLength(26);
    expect(a < b).toBe(true);
  });

  it('同一时间由随机部分区分', () => {
    expect(ulid(1_000, new Uint8Array(10))).not.toBe(ulid(1_000, new Uint8Array(10).fill(1)));
  });

  it('随机部分必须是 10 字节', () => {
    expect(() => ulid(1_000, new Uint8Array(9))).toThrow();
  });
});
