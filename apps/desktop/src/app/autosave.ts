// 自动保存（施工文档第七章、需求 B05）：停止输入约 800 毫秒后保存；输入法组合期间不保存；
// 保存进行中又有编辑时，保存完成后再保存一次；失败后退避重试，内容一直留在编辑器中。
import type { Result } from '@fudiao/shared';
import type { CurrentParagraph, SavedParagraph, StructuralEdits } from '@fudiao/store';

export type SaveStatus =
  | { readonly kind: 'saved' }
  | { readonly kind: 'dirty' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'failed'; readonly message: string };

export type Timers = {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};

export type AutosaveDeps = {
  /** 编辑器当前的段落；还有段落没有标识（组合未结束）时为 null。 */
  readonly snapshot: () => { readonly paragraphs: readonly CurrentParagraph[] | null; readonly edits: StructuralEdits };
  readonly isComposing: () => boolean;
  readonly save: (saved: readonly SavedParagraph[], current: readonly CurrentParagraph[], edits: StructuralEdits) => Promise<Result<SavedParagraph[], string>>;
  readonly writeDraft: (paragraphs: readonly CurrentParagraph[]) => void;
  readonly onStatus: (status: SaveStatus) => void;
  readonly timers: Timers;
  readonly delayMs?: number;
  readonly draftDelayMs?: number;
  readonly retryMs?: readonly number[];
};

/** 内容是否与已保存的一致。空章节里只有一个空段落时视为没有内容。 */
export function sameContent(saved: readonly SavedParagraph[], current: readonly CurrentParagraph[]): boolean {
  if (saved.length === 0) return current.every((p) => p.text === '') && current.length <= 1;
  return saved.length === current.length && saved.every((s, i) => s.id === current[i]?.id && s.text === current[i]?.text && s.source === current[i]?.source);
}

export class AutosaveController {
  private saved: readonly SavedParagraph[];
  private status: SaveStatus = { kind: 'saved' };
  private saveTimer: unknown = null;
  private draftTimer: unknown = null;
  private inFlight: Promise<boolean> | null = null;
  private editedDuringSave = false;
  private failures = 0;
  private disposed = false;
  private readonly delayMs: number;
  private readonly draftDelayMs: number;
  private readonly retryMs: readonly number[];

  constructor(
    private readonly deps: AutosaveDeps,
    initial: readonly SavedParagraph[],
  ) {
    this.saved = initial;
    this.delayMs = deps.delayMs ?? 800;
    this.draftDelayMs = deps.draftDelayMs ?? 1_000;
    this.retryMs = deps.retryMs ?? [2_000, 5_000, 15_000, 30_000];
  }

  get current(): SaveStatus {
    return this.status;
  }

  get savedParagraphs(): readonly SavedParagraph[] {
    return this.saved;
  }

  /** 每次文档变化时调用。 */
  changed(): void {
    if (this.disposed) return;
    if (this.inFlight !== null) this.editedDuringSave = true;
    if (this.status.kind !== 'failed' && this.status.kind !== 'saving') this.setStatus({ kind: 'dirty' });
    this.schedule(this.delayMs);
    if (this.draftTimer === null) {
      this.draftTimer = this.deps.timers.set(() => {
        this.draftTimer = null;
        const { paragraphs } = this.deps.snapshot();
        if (paragraphs !== null && !sameContent(this.saved, paragraphs)) this.deps.writeDraft(paragraphs);
      }, this.draftDelayMs);
    }
  }

  /** 输入法组合结束时调用：组合期间推迟的保存重新计时。 */
  compositionEnded(): void {
    if (this.status.kind !== 'saved') this.schedule(this.delayMs);
  }

  /** 立即保存（手动保存、切换章节、关闭窗口前）。返回内容是否已全部保存。 */
  async flush(): Promise<boolean> {
    this.cancelTimer();
    if (this.inFlight !== null) await this.inFlight;
    // 点按钮时输入法组合通常随即结束：稍等片刻，避免把正在结束的组合当成保存失败。
    for (let waited = 0; this.deps.isComposing() && waited < 1_500; waited += 100) {
      await new Promise<void>((resolve) => this.deps.timers.set(resolve, 100));
    }
    return this.saveNow();
  }

  dispose(): void {
    this.disposed = true;
    this.cancelTimer();
    if (this.draftTimer !== null) this.deps.timers.clear(this.draftTimer);
    this.draftTimer = null;
  }

  private setStatus(status: SaveStatus): void {
    const same = status.kind === this.status.kind && (status.kind !== 'failed' || (this.status.kind === 'failed' && status.message === this.status.message));
    if (same) return;
    this.status = status;
    this.deps.onStatus(status);
  }

  private cancelTimer(): void {
    if (this.saveTimer !== null) this.deps.timers.clear(this.saveTimer);
    this.saveTimer = null;
  }

  private schedule(ms: number): void {
    this.cancelTimer();
    this.saveTimer = this.deps.timers.set(() => {
      this.saveTimer = null;
      void this.saveNow();
    }, ms);
  }

  private async saveNow(): Promise<boolean> {
    if (this.disposed) return false;
    if (this.inFlight !== null) {
      this.editedDuringSave = true;
      return this.inFlight;
    }
    // 组合期间不保存，也不改动文档；组合结束后会重新计时。
    if (this.deps.isComposing()) {
      this.schedule(this.delayMs);
      return false;
    }
    const { paragraphs, edits } = this.deps.snapshot();
    if (paragraphs === null) {
      this.schedule(this.delayMs);
      return false;
    }
    if (sameContent(this.saved, paragraphs)) {
      if (this.status.kind !== 'saved') this.setStatus({ kind: 'saved' });
      return true;
    }
    this.setStatus({ kind: 'saving' });
    this.editedDuringSave = false;
    this.inFlight = this.deps.save(this.saved, paragraphs, edits).then((result) => {
      this.inFlight = null;
      if (this.disposed) return result.ok;
      if (!result.ok) {
        const wait = this.retryMs[Math.min(this.failures, this.retryMs.length - 1)] ?? 30_000;
        this.failures++;
        this.setStatus({ kind: 'failed', message: result.error });
        this.schedule(wait);
        return false;
      }
      this.failures = 0;
      this.saved = result.value;
      const latest = this.deps.snapshot().paragraphs;
      if (this.editedDuringSave || (latest !== null && !sameContent(this.saved, latest))) {
        this.setStatus({ kind: 'dirty' });
        this.schedule(this.delayMs);
        return false;
      }
      this.setStatus({ kind: 'saved' });
      return true;
    });
    return this.inFlight;
  }
}
