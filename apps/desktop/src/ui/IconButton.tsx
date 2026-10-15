import { Tooltip } from 'radix-ui';
import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

/** 悬停或聚焦时显示说明的气泡（Radix Tooltip）。 */
export function Tip({ label, children, side = 'bottom' }: { readonly label: string; readonly children: ReactNode; readonly side?: 'top' | 'bottom' | 'left' | 'right' }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip" side={side} sideOffset={6} collisionPadding={8}>
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

/** 只有图标的按钮：label 是按钮的名称（读屏与测试用），tip 是气泡里的说明（默认同 label）。 */
export function IconButton({
  icon,
  label,
  tip,
  onClick,
  disabled = false,
  pressed,
  side,
}: {
  readonly icon: IconName;
  readonly label: string;
  readonly tip?: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly pressed?: boolean;
  readonly side?: 'top' | 'bottom' | 'left' | 'right';
}) {
  return (
    <Tip label={tip ?? label} {...(side !== undefined && { side })}>
      <button type="button" className="ghost icon-only" aria-label={label} aria-pressed={pressed} disabled={disabled} onClick={onClick}>
        <Icon name={icon} />
      </button>
    </Tip>
  );
}
