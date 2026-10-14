import { createContext, useContext, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { Chapter, Volume } from '@fudiao/store';
import type { AppState, AppStore } from '../state/store';

const StoreContext = createContext<AppStore | null>(null);

export function StoreProvider({ store, children }: { readonly store: AppStore; readonly children: ReactNode }) {
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

/** 订阅界面状态的一部分。 */
export function useApp<T>(selector: (state: AppState) => T): T {
  const store = useContext(StoreContext);
  if (store === null) throw new Error('缺少 StoreProvider');
  return useStore(store, selector);
}

/** 选择器的空列表须是同一个引用：每次返回新数组会让订阅者无限重渲染。 */
export const NO_CHAPTERS: readonly Chapter[] = [];
export const NO_VOLUMES: readonly Volume[] = [];
