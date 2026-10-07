import { describe, expect, it } from 'vitest';
import { err, ok, type Result } from './index';

const parsePositive = (n: number): Result<number, 'not_positive'> =>
  n > 0 ? ok(n) : err('not_positive');

describe('Result', () => {
  it('以 ok 字段区分成功与失败', () => {
    const good = parsePositive(3);
    const bad = parsePositive(-1);
    expect(good).toEqual({ ok: true, value: 3 });
    expect(bad).toEqual({ ok: false, error: 'not_positive' });
  });
});
