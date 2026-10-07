// xoshiro128**：状态只有 4 个 uint32，可直接序列化进推演状态与事件。
// 抽取是纯函数，返回新状态；回放使用事件中记录的结果，不重新抽取（硬性规则 7、9）。

export type RngState = readonly [number, number, number, number];

const rotl = (x: number, k: number): number => ((x << k) | (x >>> (32 - k))) >>> 0;

/** 由 32 位种子展开出初始状态（splitmix32），保证状态不全为零。 */
export function seedRng(seed: number): RngState {
  let s = seed >>> 0;
  const next = (): number => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
  const state: [number, number, number, number] = [next(), next(), next(), next()];
  if (state.every((w) => w === 0)) state[0] = 1;
  return state;
}

function nextUint32(rng: RngState): { value: number; rng: RngState } {
  const [s0, s1, s2, s3] = rng;
  const value = Math.imul(rotl(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0;
  const t = (s1 << 9) >>> 0;
  let n2 = (s2 ^ s0) >>> 0;
  let n3 = (s3 ^ s1) >>> 0;
  const n1 = (s1 ^ n2) >>> 0;
  const n0 = (s0 ^ n3) >>> 0;
  n2 = (n2 ^ t) >>> 0;
  n3 = rotl(n3, 11);
  return { value, rng: [n0, n1, n2, n3] };
}

const RANGE = 0x1_0000_0000;

/** 抽取 [0, bound) 内的整数。用拒绝采样消除取模偏差。 */
export function drawInt(rng: RngState, bound: number): { value: number; rng: RngState } {
  if (!Number.isInteger(bound) || bound < 1 || bound > RANGE) {
    throw new RangeError(`bound 必须是 1 到 2^32 之间的整数：${bound}`);
  }
  const limit = RANGE - (RANGE % bound);
  let state = rng;
  for (;;) {
    const drawn = nextUint32(state);
    state = drawn.rng;
    if (drawn.value < limit) return { value: drawn.value % bound, rng: state };
  }
}
