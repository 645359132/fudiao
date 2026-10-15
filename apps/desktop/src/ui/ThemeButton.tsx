import type { Theme } from '../app/library';
import { Icon, type IconName } from './Icon';
import { useApp } from './store-context';

const NEXT: Readonly<Record<Theme, Theme>> = { system: 'light', light: 'dark', dark: 'system' };
const LABEL: Readonly<Record<Theme, string>> = { system: '跟随系统', light: '浅色', dark: '深色' };
const ICON: Readonly<Record<Theme, IconName>> = { system: 'monitor', light: 'sun', dark: 'moon' };

/** 外观切换：跟随系统 → 浅色 → 深色，依次轮换，对所有作品生效。 */
export function ThemeButton() {
  const theme = useApp((s) => s.library?.preferences.theme ?? 'system');
  const setTheme = useApp((s) => s.setTheme);
  return (
    <button type="button" className="ghost icon-only" aria-label={`外观：${LABEL[theme]}`} title={`外观：${LABEL[theme]}（点击切换为${LABEL[NEXT[theme]]}）`} onClick={() => void setTheme(NEXT[theme])}>
      <Icon name={ICON[theme]} />
    </button>
  );
}
