// 界面状态（Zustand）。动作只调用应用服务层的用例，把结果放进状态；组件订阅状态、调用动作。
import type { Result } from '@fudiao/shared';
import type { Chapter, ProjectPatch } from '@fudiao/store';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { describeError } from '../app/errors';
import type { AppError, AppService, LibraryView, WorkView } from '../app/service';

export type AppState = {
  readonly library: LibraryView | null;
  readonly work: WorkView | null;
  readonly selectedChapterId: string | null;
  readonly panel: 'chapter' | 'info' | 'trash';
  readonly busy: boolean;
  /** 最近一次失败的说明，作者关闭后清除。 */
  readonly message: string | null;

  readonly init: () => Promise<void>;
  readonly createWork: (title: string) => Promise<boolean>;
  readonly openWork: (id: string) => Promise<void>;
  readonly addWorkFromFolder: () => Promise<void>;
  readonly closeWork: () => Promise<void>;
  readonly setArchived: (id: string, archived: boolean) => Promise<void>;
  readonly removeMissingWork: (id: string) => Promise<void>;
  readonly chooseLibraryDir: () => Promise<void>;
  readonly updateWorkInfo: (patch: ProjectPatch) => Promise<boolean>;
  readonly createChapter: (title: string) => Promise<boolean>;
  readonly renameChapter: (id: string, title: string) => Promise<boolean>;
  readonly updateChapterNotes: (id: string, notes: { summary: string; notes: string }) => Promise<boolean>;
  /** 把章节移到 after 之后；after 为 null 时移到最前。 */
  readonly moveChapter: (id: string, after: string | null) => Promise<void>;
  readonly moveUp: (id: string) => Promise<void>;
  readonly moveDown: (id: string) => Promise<void>;
  /** 拖到某一章上：放到该章所在的位置。 */
  readonly dropChapter: (id: string, targetId: string) => Promise<void>;
  readonly trashChapter: (id: string) => Promise<void>;
  readonly restoreChapter: (id: string) => Promise<void>;
  readonly selectChapter: (id: string) => void;
  readonly showPanel: (panel: AppState['panel']) => void;
  readonly dismissMessage: () => void;
};

export type AppStore = StoreApi<AppState>;

export function createAppStore(service: AppService): AppStore {
  return createStore<AppState>()((set, get) => {
    /** 执行一个用例：失败时显示说明；内容在别处被修改时重新读取作品。返回是否成功。 */
    async function run<T>(task: Promise<Result<T, AppError>>, apply: (value: T) => Partial<AppState>): Promise<boolean> {
      set({ busy: true });
      const result = await task;
      if (result.ok) {
        set({ ...apply(result.value), busy: false, message: null });
        return true;
      }
      set({ busy: false, message: describeError(result.error) });
      if (result.error.code === 'repo' && result.error.error.code === 'conflict') {
        const reloaded = await service.reloadWork();
        if (reloaded.ok) set({ work: reloaded.value });
      }
      return false;
    }

    const chapter = (id: string): Chapter | undefined => {
      const work = get().work;
      return work?.chapters.find((c) => c.id === id) ?? work?.trashed.find((c) => c.id === id);
    };
    const withChapter = (id: string, f: (c: Chapter) => Promise<Result<WorkView, AppError>>, after?: Partial<AppState>) => {
      const c = chapter(id);
      return c === undefined ? Promise.resolve(false) : run(f(c), (work) => ({ work, ...after }));
    };
    const opened = (work: WorkView): Partial<AppState> => ({ work, selectedChapterId: work.chapters[0]?.id ?? null, panel: 'chapter' });

    return {
      library: null,
      work: null,
      selectedChapterId: null,
      panel: 'chapter',
      busy: false,
      message: null,

      async init() {
        await run(service.loadLibrary(), (library) => ({ library }));
      },
      createWork: (title) => run(service.createWork(title), opened),
      async openWork(id) {
        await run(service.openWork(id), opened);
      },
      async addWorkFromFolder() {
        await run(service.addWorkFromFolder(), (work) => (work === null ? {} : opened(work)));
      },
      async closeWork() {
        await service.closeWork();
        set({ work: null, selectedChapterId: null });
        await get().init();
      },
      async setArchived(id, archived) {
        await run(service.setArchived(id, archived), (library) => ({ library }));
      },
      async removeMissingWork(id) {
        await run(service.removeMissingWork(id), (library) => ({ library }));
      },
      async chooseLibraryDir() {
        await run(service.chooseLibraryDir(), (library) => (library === null ? {} : { library }));
      },
      updateWorkInfo: (patch) => run(service.updateWorkInfo(patch), (work) => ({ work })),

      async createChapter(title) {
        const selected = get().selectedChapterId;
        const ok = await run(service.createChapter(title, selected ?? undefined), (work) => ({ work }));
        if (ok) {
          // 新章节插在所选章节之后（没有所选时在末尾），并成为所选。
          const work = get().work;
          const index = selected === null ? (work?.chapters.length ?? 0) - 1 : (work?.chapters.findIndex((c) => c.id === selected) ?? -1) + 1;
          set({ selectedChapterId: work?.chapters[index]?.id ?? null, panel: 'chapter' });
        }
        return ok;
      },
      renameChapter: (id, title) => withChapter(id, (c) => service.renameChapter(c, title)),
      updateChapterNotes: (id, notes) => withChapter(id, (c) => service.updateChapterNotes(c, notes)),
      async moveChapter(id, after) {
        await withChapter(id, (c) => service.moveChapter(c, after));
      },
      async moveUp(id) {
        const list = get().work?.chapters ?? [];
        const i = list.findIndex((c) => c.id === id);
        if (i > 0) await get().moveChapter(id, list[i - 2]?.id ?? null);
      },
      async moveDown(id) {
        const list = get().work?.chapters ?? [];
        const i = list.findIndex((c) => c.id === id);
        const next = list[i + 1];
        if (i >= 0 && next !== undefined) await get().moveChapter(id, next.id);
      },
      async dropChapter(id, targetId) {
        if (id === targetId) return;
        const list = get().work?.chapters ?? [];
        const from = list.findIndex((c) => c.id === id);
        const to = list.findIndex((c) => c.id === targetId);
        if (from < 0 || to < 0) return;
        // 向下拖放到目标之后，向上拖放到目标之前。
        const after = from < to ? targetId : (list[to - 1]?.id ?? null);
        await get().moveChapter(id, after);
      },
      async trashChapter(id) {
        const selected = get().selectedChapterId === id;
        await withChapter(id, (c) => service.trashChapter(c), selected ? { selectedChapterId: null } : {});
      },
      async restoreChapter(id) {
        await withChapter(id, (c) => service.restoreChapter(c), { selectedChapterId: id, panel: 'chapter' });
      },
      selectChapter: (id) => set({ selectedChapterId: id, panel: 'chapter' }),
      showPanel: (panel) => set({ panel }),
      dismissMessage: () => set({ message: null }),
    };
  });
}
