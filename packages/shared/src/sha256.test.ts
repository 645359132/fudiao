import { describe, expect, it } from 'vitest';
import { sha256 } from './sha256';

describe('sha256', () => {
  it.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    ],
    ['密信由主角持有', 'e60c954402d545167e152aa010bf6402f08b201ee028d44dbfbbc14223f2f258'],
    ['😀𝄞', 'aad398b1608f9ba6ee61d1e70a71fb15f95256223b9d7431f4d5cc94f2af9f02'],
  ])('标准向量 %j', (input, expected) => {
    expect(sha256(input)).toBe(expected);
  });

  // 55、56、64 字节分别落在填充需要一块或两块的边界上。
  it.each([
    [55, '9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318'],
    [56, 'b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a'],
    [64, 'ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb'],
    [1_000_000, 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0'],
  ])('填充边界：%i 个 a', (n, expected) => {
    expect(sha256('a'.repeat(n))).toBe(expected);
  });
});
