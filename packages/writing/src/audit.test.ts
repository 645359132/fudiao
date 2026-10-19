import { describe, expect, it } from 'vitest';
import { foreshadowAudit } from './audit';
import type { ForeshadowItem } from './types';

const order = new Map([
  ['c1', 0],
  ['c2', 1],
  ['c3', 2],
]);
const all = new Set(['c1', 'c2', 'c3']);
const item = (id: string, over: Partial<ForeshadowItem>): ForeshadowItem => ({ id, title: id, reveal: '', plantChapterId: null, payoffChapterId: null, status: 'planned', ...over });

describe('全书体检的伏笔核对', () => {
  it('回收的章节已写好仍未回收为到期；埋设的章节已写好、账本仍是计划、记忆也没提到为没有埋下；没定章节的列出', () => {
    const findings = foreshadowAudit({
      foreshadows: [
        item('jade', { plantChapterId: 'c1', payoffChapterId: 'c2', status: 'planted' }),
        item('debt', { plantChapterId: 'c2' }),
        item('scar', { plantChapterId: 'c1' }),
        item('loose', {}),
        item('done', { plantChapterId: 'c1', payoffChapterId: 'c2', status: 'paid_off' }),
        item('later', { plantChapterId: 'c1', payoffChapterId: 'c3', status: 'planted' }),
      ],
      order,
      written: new Set(['c1', 'c2']),
      range: all,
      // 第一章的记忆里提到了“旧伤”：可能已经埋下，不报。
      progress: new Map([['c1', { scar: '林舟袖口露出旧伤' }]]),
    });
    expect(findings.map((f) => [f.foreshadowId, f.problem, f.chapterId])).toEqual([
      ['jade', 'overdue', 'c2'],
      ['debt', 'not_planted', 'c2'],
      ['loose', 'unscheduled', null],
    ]);
  });

  it('相关章节不在体检范围内的不报', () => {
    const findings = foreshadowAudit({
      foreshadows: [item('jade', { plantChapterId: 'c1', payoffChapterId: 'c2', status: 'planted' }), item('debt', { plantChapterId: 'c1' })],
      order,
      written: all,
      range: new Set(['c3']),
      progress: new Map(),
    });
    expect(findings).toEqual([]);
  });
});
