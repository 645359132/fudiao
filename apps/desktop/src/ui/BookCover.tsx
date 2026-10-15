import type { CSSProperties } from 'react';

// 没有封面时的文字封面（B76）：书名竖排，配色由作品标识决定，同一部作品每次一样。
const PALETTES: readonly (readonly [string, string])[] = [
  ['#2f3e5c', '#ece4d2'],
  ['#3d5a4a', '#ece6d3'],
  ['#6b2d2d', '#f1e4d0'],
  ['#5a4632', '#f0e2c6'],
  ['#4b3a5c', '#ebe2ef'],
  ['#33494f', '#e4ece9'],
];

function paletteOf(seed: string): readonly [string, string] {
  let h = 0;
  for (const ch of seed) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return PALETTES[h % PALETTES.length] ?? PALETTES[0]!;
}

/**
 * 作品封面：有图片时显示图片，没有时显示文字封面。decorative 为 true 时不读给读屏软件（旁边已有书名）。
 * small 用于作品列表的卡片，large 用于作品信息页。
 */
export function BookCover({ title, image, seed, size, decorative = false }: { readonly title: string; readonly image: string | null; readonly seed: string; readonly size: 'small' | 'large'; readonly decorative?: boolean }) {
  if (image !== null) return <img className={`book-cover ${size}`} src={image} alt={decorative ? '' : `《${title}》的封面`} />;
  const [background, ink] = paletteOf(seed);
  const style = { '--cover-bg': background, '--cover-ink': ink } as CSSProperties;
  const long = [...title].length > 8;
  return (
    <div className={`book-cover text-cover ${size}${long ? ' long' : ''}`} style={style} {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': `《${title}》的文字封面` })}>
      <span className="text-cover-title">{title}</span>
    </div>
  );
}
