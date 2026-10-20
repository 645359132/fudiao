// 规避表达词表（需求 B37）：中文模型常见的口癖。作品没有自己的词表（null）时用这一份；作者清空为 [] 表示不检查。
export const DEFAULT_AVOID_PHRASES: readonly string[] = [
  '嘴角勾起一抹弧度',
  '嘴角微微上扬',
  '眼中闪过一丝',
  '眸子里闪过',
  '倒吸一口凉气',
  '心中一凛',
  '不禁',
  '不由得',
  '仿佛',
  '宛如',
  '一抹',
  '缓缓开口',
  // 2026-10-20 参照 Humanizer-zh 与 blader/humanizer 的思路补上的小说里常见的套话。
  '空气仿佛凝固',
  '时间仿佛静止',
  '鬼使神差',
  '涌上心头',
  '心头一紧',
  '一股暖流',
  '不得不说',
  '值得一提的是',
  '某种意义上',
];

export const effectiveAvoidPhrases = (own: readonly string[] | null): readonly string[] => own ?? DEFAULT_AVOID_PHRASES;
