import { err, ok, type Result } from '@fudiao/shared';
import type { CurrentParagraph, SavedParagraph, StructuralEdits } from '@fudiao/store';
import { describe, expect, it } from 'vitest';
import { AutosaveController, sameContent, type SaveStatus } from './autosave';

/** 让已排队的 Promise 回调全部执行。 */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** 手动推进的计时器。 */
function fakeTimers() {
  let now = 0;
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    timers: {
      set: (fn: () => void, ms: number) => {
        const id = ++seq;
        pending.set(id, { at: now + ms, fn });
        return id;
      },
      clear: (h: unknown) => void pending.delete(h as number),
    },
    async advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const next = [...pending.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (next === undefined) break;
        pending.delete(next[0]);
        now = next[1].at;
        next[1].fn();
        await settle();
      }
      now = until;
      await settle();
    },
  };
}

const p = (id: string, text: string): CurrentParagraph => ({ id, text, source: 'handwritten' });
const asSaved = (ps: readonly CurrentParagraph[], version = 1): SavedParagraph[] => ps.map((x, i) => ({ ...x, orderKey: `a${i}`, version, aiOriginText: null, spans: [] }));

function setup(options: { failTimes?: number; slow?: boolean } = {}) {
  const clock = fakeTimers();
  let doc: CurrentParagraph[] | null = [p('a', '雨')];
  let composing = false;
  const saves: CurrentParagraph[][] = [];
  const drafts: CurrentParagraph[][] = [];
  const statuses: SaveStatus['kind'][] = [];
  let failures = options.failTimes ?? 0;
  let release: (() => void) | null = null;
  const controller = new AutosaveController(
    {
      snapshot: () => ({ paragraphs: doc, edits: { splits: [], merges: [] } satisfies StructuralEdits }),
      isComposing: () => composing,
      save: async (_saved, current): Promise<Result<SavedParagraph[], string>> => {
        saves.push([...current]);
        if (options.slow) await new Promise<void>((r) => (release = r));
        if (failures > 0) {
          failures--;
          return err('磁盘已满');
        }
        return ok(asSaved(current));
      },
      writeDraft: (ps) => drafts.push([...ps]),
      onStatus: (s) => statuses.push(s.kind),
      timers: clock.timers,
    },
    asSaved([p('a', '雨')]),
  );
  return {
    clock,
    controller,
    saves,
    drafts,
    statuses,
    edit(next: CurrentParagraph[] | null) {
      doc = next;
      controller.changed();
    },
    compose(on: boolean) {
      composing = on;
      if (!on) controller.compositionEnded();
    },
    release: () => release?.(),
  };
}

describe('自动保存', () => {
  it('停止输入 800 毫秒后保存一次；连续输入只在最后保存', async () => {
    const s = setup();
    s.edit([p('a', '雨下')]);
    await s.clock.advance(500);
    s.edit([p('a', '雨下得')]);
    await s.clock.advance(500);
    expect(s.saves).toEqual([]);
    await s.clock.advance(300);
    expect(s.saves).toEqual([[p('a', '雨下得')]]);
    expect(s.controller.current).toEqual({ kind: 'saved' });
    expect(s.statuses).toEqual(['dirty', 'saving', 'saved']);
  });

  it('输入法组合期间不保存，组合结束后重新计时', async () => {
    const s = setup();
    s.compose(true);
    s.edit([p('a', '雨xia')]);
    await s.clock.advance(5_000);
    expect(s.saves).toEqual([]);
    s.edit([p('a', '雨下')]);
    s.compose(false);
    await s.clock.advance(800);
    expect(s.saves).toEqual([[p('a', '雨下')]]);
  });

  it('还有段落没有标识时不保存', async () => {
    const s = setup();
    s.edit(null);
    await s.clock.advance(2_000);
    expect(s.saves).toEqual([]);
    s.edit([p('a', '雨'), p('b', '风')]);
    await s.clock.advance(800);
    expect(s.saves).toHaveLength(1);
  });

  it('保存进行中又有编辑：完成后再保存一次', async () => {
    const s = setup({ slow: true });
    s.edit([p('a', '雨下')]);
    await s.clock.advance(800);
    s.edit([p('a', '雨下得')]);
    s.release();
    await s.clock.advance(0);
    expect(s.controller.current.kind).toBe('dirty');
    await s.clock.advance(800);
    s.release();
    await s.clock.advance(0);
    expect(s.saves.map((x) => x[0]?.text)).toEqual(['雨下', '雨下得']);
    expect(s.controller.current.kind).toBe('saved');
  });

  it('失败后显示原因并退避重试，成功后恢复', async () => {
    const s = setup({ failTimes: 2 });
    s.edit([p('a', '雨下')]);
    await s.clock.advance(800);
    expect(s.controller.current).toEqual({ kind: 'failed', message: '磁盘已满' });
    await s.clock.advance(2_000);
    expect(s.saves).toHaveLength(2);
    expect(s.controller.current.kind).toBe('failed');
    await s.clock.advance(5_000);
    expect(s.saves).toHaveLength(3);
    expect(s.controller.current.kind).toBe('saved');
  });

  it('立即保存（切换章节前）：取消计时，等进行中的保存结束', async () => {
    const s = setup();
    s.edit([p('a', '雨下')]);
    expect(await s.controller.flush()).toBe(true);
    expect(s.saves).toHaveLength(1);
    await s.clock.advance(2_000);
    expect(s.saves).toHaveLength(1);
  });

  it('立即保存时若输入法组合正在结束，稍等后保存；组合一直不结束时报告未保存', async () => {
    const s = setup();
    s.compose(true);
    s.edit([p('a', '雨下')]);
    const flushed = s.controller.flush();
    await s.clock.advance(300);
    s.compose(false);
    await s.clock.advance(100);
    expect(await flushed).toBe(true);
    expect(s.saves).toHaveLength(1);

    s.compose(true);
    s.edit([p('a', '雨下得')]);
    const stuck = s.controller.flush();
    await s.clock.advance(2_000);
    expect(await stuck).toBe(false);
  });

  it('编辑约 1 秒后写草稿，内容与已保存的相同时不写', async () => {
    const s = setup({ slow: true });
    s.edit([p('a', '雨下')]);
    await s.clock.advance(1_000);
    expect(s.drafts).toEqual([[p('a', '雨下')]]);
    s.edit([p('a', '雨')]);
    await s.clock.advance(1_000);
    expect(s.drafts).toHaveLength(1);
  });

  it('空章节里只有一个空段落时视为没有内容', () => {
    expect(sameContent([], [p('a', '')])).toBe(true);
    expect(sameContent([], [p('a', '雨')])).toBe(false);
    expect(sameContent(asSaved([p('a', '雨')]), [p('a', '雨')])).toBe(true);
    expect(sameContent(asSaved([p('a', '雨')]), [p('b', '雨')])).toBe(false);
  });
});
