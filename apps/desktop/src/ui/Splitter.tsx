import { useRef } from 'react';

/** 可以拖动的分隔条调整的栏：左栏在分隔条左侧（拖向右变宽），助手在右侧（拖向左变宽）。 */
export type SplitterProps = {
  readonly label: string;
  /** 被调整的栏在分隔条的哪一侧。 */
  readonly side: 'left' | 'right';
  /** 写宽度的 CSS 变量（在 .app-shell 上）。 */
  readonly cssVar: '--sidebar-width' | '--assistant-width';
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly defaultValue: number;
  /** 拖动或按键结束后保存宽度。 */
  readonly onCommit: (width: number) => void;
};

/** 中间的编辑区至少留这么宽。 */
const MAIN_MIN = 420;
const STEP = 16;

/**
 * 栏之间的分隔条（role="separator"）：拖动调整宽度，双击恢复默认；聚焦后左右方向键每次 16 像素，Home、End 到最窄与最宽。
 * 拖动中直接改 CSS 变量，不经过状态，松开后才保存。
 */
export function Splitter({ label, side, cssVar, value, min, max, defaultValue, onCommit }: SplitterProps) {
  const drag = useRef<{ startX: number; startWidth: number; width: number } | null>(null);
  const handle = useRef<HTMLDivElement>(null);

  const shell = () => handle.current?.closest<HTMLElement>('.app-shell') ?? null;
  // 窗口窄时，最宽不能把编辑区挤到 MAIN_MIN 以下。
  const upper = () => {
    const el = shell();
    // 没有排版（例如测试环境）时宽度为 0，只按上下限。
    if (el === null || el.clientWidth === 0) return max;
    const other = cssVar === '--sidebar-width' ? '--assistant-width' : '--sidebar-width';
    const otherWidth = Number.parseFloat(getComputedStyle(el).getPropertyValue(other)) || 0;
    return Math.max(min, Math.min(max, el.clientWidth - otherWidth - MAIN_MIN));
  };
  const clamp = (w: number) => Math.round(Math.min(upper(), Math.max(min, w)));
  const apply = (w: number) => shell()?.style.setProperty(cssVar, `${w}px`);

  return (
    <div className={`splitter splitter-${side}`}>
      <div
        ref={handle}
        className="splitter-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label={label}
        aria-valuenow={value}
        aria-valuemin={min}
        aria-valuemax={max}
        tabIndex={0}
        title={`${label}（拖动调整，双击恢复默认）`}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture?.(e.pointerId);
          drag.current = { startX: e.clientX, startWidth: value, width: value };
          document.body.classList.add('resizing');
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d === null) return;
          const dx = e.clientX - d.startX;
          d.width = clamp(d.startWidth + (side === 'left' ? dx : -dx));
          apply(d.width);
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          if (d === null) return;
          drag.current = null;
          e.currentTarget.releasePointerCapture?.(e.pointerId);
          document.body.classList.remove('resizing');
          if (d.width !== value) onCommit(d.width);
        }}
        onDoubleClick={() => {
          apply(defaultValue);
          onCommit(defaultValue);
        }}
        onKeyDown={(e) => {
          const grow = side === 'left' ? 'ArrowRight' : 'ArrowLeft';
          const shrink = side === 'left' ? 'ArrowLeft' : 'ArrowRight';
          let next: number | null = null;
          if (e.key === grow) next = value + STEP;
          else if (e.key === shrink) next = value - STEP;
          else if (e.key === 'Home') next = min;
          else if (e.key === 'End') next = max;
          else if (e.key === 'Enter') next = defaultValue;
          if (next === null) return;
          e.preventDefault();
          const w = clamp(next);
          apply(w);
          onCommit(w);
        }}
      />
    </div>
  );
}
