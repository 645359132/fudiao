import { describe, expect, it } from 'vitest';
import { checkPlan, foreshadowsForChapter, nextChapterToWrite, suggestForeshadowStatus } from './plan';
import type { ForeshadowItem, PlanItem } from './types';

const order = new Map([
  ['c1', 0],
  ['c2', 1],
  ['c3', 2],
]);

const jade: ForeshadowItem = { id: 'f1', title: '玉佩的来历', reveal: '玉佩是王家失物的仿品', plantChapterId: 'c1', payoffChapterId: 'c3', status: 'planted' };
const debt: ForeshadowItem = { id: 'f2', title: '赌债的债主', reveal: '债主是钱四的表兄', plantChapterId: 'c2', payoffChapterId: null, status: 'planned' };
const done: ForeshadowItem = { id: 'f3', title: '旧伤', reveal: '', plantChapterId: 'c1', payoffChapterId: 'c2', status: 'paid_off' };

const plan = (chapterId: string, over: Partial<PlanItem> = {}): PlanItem => ({
  chapterId,
  castIds: [],
  foreshadowPlant: [],
  foreshadowPayoff: [],
  status: 'todo',
  ...over,
});

describe('本章的伏笔', () => {
  it('列出本章要埋、要收的伏笔，以及还不能说破的伏笔', () => {
    const result = foreshadowsForChapter(plan('c2', { foreshadowPlant: ['f2'] }), [jade, debt, done], order);
    expect(result.toPlant.map((f) => f.id)).toEqual(['f2']);
    expect(result.toPayoff).toEqual([]);
    // 玉佩第三章才揭晓；债主没有定回收章节，同样不能说破；已回收的不算。
    expect(result.mustNotReveal.map((f) => f.id)).toEqual(['f1', 'f2']);
  });

  it('在本章回收的伏笔可以说破；废弃的伏笔不再约束', () => {
    const result = foreshadowsForChapter(plan('c3', { foreshadowPayoff: ['f1'] }), [jade, { ...debt, status: 'dropped' }], order);
    expect(result.toPayoff.map((f) => f.id)).toEqual(['f1']);
    expect(result.mustNotReveal).toEqual([]);
  });

  it('揭晓内容为空的伏笔没有需要守住的内容', () => {
    expect(foreshadowsForChapter(plan('c1'), [{ ...jade, reveal: '  ' }], order).mustNotReveal).toEqual([]);
  });
});

describe('计划检查', () => {
  it('引用了账本中没有的伏笔', () => {
    expect(checkPlan(plan('c1', { foreshadowPlant: ['nope'] }), [jade], order)).toEqual([{ code: 'unknown_foreshadow', foreshadowId: 'nope' }]);
  });

  it('回收章节在埋设章节之前', () => {
    const late: ForeshadowItem = { ...jade, plantChapterId: 'c3', payoffChapterId: null };
    expect(checkPlan(plan('c2', { foreshadowPayoff: ['f1'] }), [late], order)).toEqual([{ code: 'payoff_before_plant', foreshadowId: 'f1' }]);
  });

  it('已回收或废弃的伏笔又被安排埋设或回收', () => {
    expect(checkPlan(plan('c2', { foreshadowPlant: ['f3'] }), [done], order)).toEqual([{ code: 'foreshadow_closed', foreshadowId: 'f3' }]);
  });

  it('没有问题时为空', () => {
    expect(checkPlan(plan('c3', { foreshadowPayoff: ['f1'] }), [jade], order)).toEqual([]);
  });
});

describe('下一章写哪章', () => {
  it('按书中顺序取第一章待写的；都写过了为 null', () => {
    const plans = [plan('c3'), plan('c1', { status: 'written' }), plan('c2')];
    expect(nextChapterToWrite(plans, order)).toBe('c2');
    expect(nextChapterToWrite([plan('c1', { status: 'reviewed' })], order)).toBeNull();
  });

  it('不在书中（回收站）的章节不算', () => {
    expect(nextChapterToWrite([plan('gone')], order)).toBeNull();
  });
});

describe('账本状态的建议', () => {
  const written = (chapterId: string) => plan(chapterId, { status: 'written' });

  it('埋设的章节写完了、账本还是“计划”：建议标为已埋', () => {
    expect(suggestForeshadowStatus([debt], [plan('c1'), written('c2')])).toEqual([{ foreshadowId: 'f2', status: 'planted', chapterId: 'c2' }]);
  });

  it('回收的章节写完了：建议标为已回收，优先于已埋；已审核的章节同样算写完', () => {
    const planned: ForeshadowItem = { ...jade, status: 'planned' };
    expect(suggestForeshadowStatus([planned, jade], [written('c1'), plan('c3', { status: 'reviewed' })])).toEqual([
      { foreshadowId: 'f1', status: 'paid_off', chapterId: 'c3' },
      { foreshadowId: 'f1', status: 'paid_off', chapterId: 'c3' },
    ]);
  });

  it('章节没写完、没有定章节、已经是对应状态、已回收或废弃时没有建议', () => {
    const dropped: ForeshadowItem = { ...debt, id: 'f4', status: 'dropped' };
    const unplaced: ForeshadowItem = { ...debt, id: 'f5', plantChapterId: null };
    // jade 已埋，回收的第三章还在写；debt 的第二章待写；done 已回收。
    expect(suggestForeshadowStatus([jade, debt, done, dropped, unplaced], [written('c1'), plan('c2'), plan('c3', { status: 'writing' })])).toEqual([]);
  });
});
