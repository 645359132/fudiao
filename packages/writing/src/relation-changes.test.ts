import { describe, expect, it } from 'vitest';
import { castTimelines, exitAt, exitNote, presentAt } from './presence';
import {
  projectRelations,
  relationToChange,
  resolveRelationChanges,
  type ChangeChapter,
  type LabeledRelation,
  type PendingChange,
  type RelationChangeDraft,
  type RelationRecord,
} from './relation-changes';

const order = new Map(['c1', 'c2', 'c3', 'c4', 'c5'].map((id, i) => [id, i]));
const names: Record<string, string> = { shen: '沈孤舟', gu: '顾寒衣', chu: '楚晚晴', si: '司空礼' };
const nameOf = (id: string) => names[id] ?? '';

describe('人物的进出', () => {
  const timelines = castTimelines({
    order,
    appearances: [
      { chapterId: 'c2', entityId: 'gu' },
      { chapterId: 'c4', entityId: 'gu' },
      { chapterId: 'c1', entityId: 'shen' },
      { chapterId: 'trashed', entityId: 'chu' },
    ],
    records: [
      { entityId: 'gu', chapterId: 'c2', kind: 'exit', note: '坠崖' },
      { entityId: 'gu', chapterId: 'c4', kind: 'return', note: '被渔人救起' },
      { entityId: 'si', chapterId: 'c3', kind: 'enter', note: '' },
      { entityId: 'si', chapterId: 'c5', kind: 'exit', note: '' },
    ],
  });

  it('第一次出场取最早出现的章节；回收站里的章节不算', () => {
    expect(timelines.get('gu')?.first).toBe(1);
    expect(timelines.get('si')?.first).toBe(2);
    expect(timelines.has('chu')).toBe(false);
  });

  it('退场那一章还在，下一章起不在；回归那一章起又在', () => {
    const gu = timelines.get('gu');
    expect([0, 1, 2, 3, 4].map((i) => presentAt(gu, i))).toEqual([false, true, false, true, true]);
    expect(exitAt(gu, 2)).toEqual({ at: 1, note: '坠崖' });
    expect(exitAt(gu, 3)).toBeNull();
    expect(presentAt(undefined, 3)).toBe(false);
  });

  it('退场的说明：书写到最后仍在退场中时写“第 N 章退场”', () => {
    expect(exitNote(timelines.get('gu'), 5)).toBe('');
    expect(exitNote(timelines.get('si'), 5)).toBe('第 5 章退场');
    expect(exitNote(timelines.get('si'), 4)).toBe('');
  });
});

const record = (id: string, fromId: string, toId: string, label: string, patch: Partial<RelationRecord> = {}): RelationRecord => ({
  id,
  fromId,
  toId,
  category: 'enemy',
  label,
  mutual: true,
  description: '',
  secret: false,
  validFromChapterId: null,
  validToChapterId: null,
  ...patch,
});

const pending = (patch: Partial<PendingChange>): PendingChange => ({
  chapterId: 'c2',
  kind: 'relation_add',
  relationshipId: null,
  fromId: 'shen',
  fromName: '沈孤舟',
  toId: 'gu',
  toName: '顾寒衣',
  category: 'ally',
  label: '暂时联手',
  oldLabel: '',
  mutual: true,
  secret: false,
  description: '',
  validToChapterId: null,
  ...patch,
});

describe('一批章节开始时的关系', () => {
  const records = [record('r1', 'shen', 'gu', '灭门仇敌'), record('r2', 'shen', 'chu', '互利同盟', { category: 'ally', validToChapterId: 'c1' })];

  it('已有的关系里在这一章成立的', () => {
    expect(projectRelations(records, [], nameOf, 1, order).map((r) => r.label)).toEqual(['灭门仇敌']);
    expect(projectRelations(records, [], nameOf, 0, order).map((r) => r.label)).toEqual(['灭门仇敌', '互利同盟']);
  });

  it('叠上这一章之前待确认的改变、新增与结束；这一章与之后的不算', () => {
    const changes = [
      pending({ kind: 'relation_change', relationshipId: 'r1', oldLabel: '灭门仇敌' }),
      pending({ chapterId: 'c3', kind: 'relation_add', fromId: null, fromName: '白衣人', toId: 'shen', toName: '沈孤舟', label: '刺客', category: 'enemy', mutual: false }),
      pending({ chapterId: 'c4', kind: 'relation_end', relationshipId: 'r1', label: '灭门仇敌' }),
    ];
    expect(projectRelations(records, changes, nameOf, 2, order).map((r) => `${r.relationshipId ?? '待确认'}:${r.label}`)).toEqual(['待确认:暂时联手']);
    const at = (index: number) => projectRelations(records, changes, nameOf, index, order).map((r) => `${r.from.name}-${r.to.name}:${r.label}`);
    expect(at(3)).toEqual(['沈孤舟-顾寒衣:暂时联手', '白衣人-沈孤舟:刺客']);
    // 第四章的结束指认的 r1 已被改变取代：结束两人之间现在唯一的那条。
    expect(at(4)).toEqual(['白衣人-沈孤舟:刺客']);
    // 新增时已经说明到哪一章为止的，过了那一章不算。
    expect(projectRelations([], [pending({ validToChapterId: 'c3' })], nameOf, 4, order)).toEqual([]);
  });
});

describe('模型找出的变化换成建议', () => {
  const chapters: ChangeChapter[] = [
    { label: 'C1', chapterId: 'c3', index: 2, prevId: 'c2' },
    { label: 'C2', chapterId: 'c4', index: 3, prevId: 'c3' },
  ];
  const people = [
    { id: 'shen', name: '沈孤舟', aliases: ['沈三'] },
    { id: 'gu', name: '顾寒衣', aliases: [] },
    { id: 'chu', name: '楚晚晴', aliases: [] },
  ];
  const relations: LabeledRelation[] = [{ tag: 'R1', relationshipId: 'r1', from: { id: 'shen', name: '沈孤舟' }, to: { id: 'gu', name: '顾寒衣' }, category: 'enemy', label: '灭门仇敌', mutual: true, description: '', secret: false }];
  const rel = (patch: Partial<RelationChangeDraft['relations'][number]>): RelationChangeDraft['relations'][number] => ({
    chapter: 'C1',
    kind: 'add',
    relation: '',
    from: '沈孤舟',
    to: '楚晚晴',
    category: 'romance',
    label: '心上人',
    mutual: true,
    description: '',
    secret: false,
    reason: '',
    ...patch,
  });
  const resolve = (draft: Partial<RelationChangeDraft>) => resolveRelationChanges({ chapters, people, relations, draft: { relations: [], cast: [], ...draft }, rewrite: (t) => t.replace('C1', '《第三章》') });

  it('改变与结束指认原来的关系；改变带上原来的称谓；说明里的标签换成章节名；别名对到人物', () => {
    const { changes, dropped } = resolve({
      relations: [
        rel({ kind: 'change', relation: 'R1', from: '沈三', to: '顾寒衣', category: 'ally', label: '暂时联手', reason: 'C1 末两人约定' }),
        rel({ chapter: 'C2', kind: 'end', relation: '', from: '顾寒衣', to: '沈孤舟', category: 'enemy', label: '灭门仇敌' }),
      ],
    });
    expect(dropped).toBe(0);
    expect(changes).toEqual([
      expect.objectContaining({ kind: 'relation_change', chapterId: 'c3', relationshipId: 'r1', from: { id: 'shen', name: '沈孤舟' }, to: { id: 'gu', name: '顾寒衣' }, label: '暂时联手', oldLabel: '灭门仇敌', category: 'ally', reason: '《第三章》 末两人约定' }),
      // 结束按两人找到原来的那条，方向与称谓照原来的。
      expect.objectContaining({ kind: 'relation_end', chapterId: 'c4', relationshipId: 'r1', from: { id: 'shen', name: '沈孤舟' }, label: '灭门仇敌' }),
    ]);
  });

  it('新人物先出场，关系可以连到他；已有的人物不算新出场；退场与回归对到人物', () => {
    const { changes, dropped } = resolve({
      relations: [rel({ from: '白衣人', to: '沈孤舟', category: 'enemy', label: '刺客', mutual: false })],
      cast: [
        { chapter: 'C1', kind: 'exit', name: '顾寒衣', description: '坠崖', reason: '' },
        { chapter: 'C1', kind: 'enter', name: '白衣人', description: '雨夜出手的剑客', reason: '' },
        { chapter: 'C1', kind: 'enter', name: '楚晚晴', description: '', reason: '' },
        { chapter: 'C2', kind: 'return', name: '无名氏', description: '', reason: '' },
      ],
    });
    expect(changes.map((c) => `${c.kind}:${c.from.name}${c.to === null ? '' : `-${c.to.name}`}`)).toEqual(['cast_enter:白衣人', 'relation_add:白衣人-沈孤舟', 'cast_exit:顾寒衣']);
    expect(changes[0]).toMatchObject({ from: { id: null, name: '白衣人' }, description: '雨夜出手的剑客' });
    expect(dropped).toBe(2);
  });

  it('同一批里先新增、后结束：新增的那条到结束的那一章为止；后改变：到前一章为止，改变后的从这一章起', () => {
    const ended = resolve({ relations: [rel({}), rel({ chapter: 'C2', kind: 'end', label: '心上人' })] });
    expect(ended.changes).toEqual([expect.objectContaining({ kind: 'relation_add', chapterId: 'c3', label: '心上人', validToChapterId: 'c4' })]);
    const changed = resolve({ relations: [rel({}), rel({ chapter: 'C2', kind: 'change', category: 'enemy', label: '负心人', mutual: false })] });
    expect(changed.changes).toEqual([
      expect.objectContaining({ kind: 'relation_add', chapterId: 'c3', label: '心上人', validToChapterId: 'c3' }),
      expect.objectContaining({ kind: 'relation_add', chapterId: 'c4', label: '负心人', validToChapterId: null }),
    ]);
    // 同一章里新增又改变：只留改变后的样子。
    const same = resolve({ relations: [rel({}), rel({ kind: 'change', label: '未婚妻', category: 'family' })] });
    expect(same.changes).toEqual([expect.objectContaining({ kind: 'relation_add', label: '未婚妻', category: 'family', validToChapterId: null })]);
  });

  it('丢弃：章节或名字对不上、同一人、已有的关系、没有变化、找不到原来关系的结束；找不到原来关系的改变当作新增', () => {
    const { changes, dropped } = resolve({
      relations: [
        rel({ chapter: 'C9' }),
        rel({ to: '路人' }),
        rel({ to: '沈孤舟' }),
        rel({ from: '顾寒衣', to: '沈孤舟', category: 'enemy', label: '灭门仇敌' }),
        rel({ kind: 'change', relation: 'R1', from: '沈孤舟', to: '顾寒衣', category: 'enemy', label: '灭门仇敌' }),
        rel({ kind: 'end', from: '楚晚晴', to: '顾寒衣', label: '旧识' }),
        // 指认的关系两端对不上：按两人重新找，楚晚晴与顾寒衣之间没有关系，改变当作新增。
        rel({ kind: 'change', relation: 'R1', from: '楚晚晴', to: '顾寒衣', category: 'rival', label: '情敌' }),
      ],
    });
    expect(dropped).toBe(6);
    expect(changes).toEqual([expect.objectContaining({ kind: 'relation_add', from: { id: 'chu', name: '楚晚晴' }, label: '情敌', relationshipId: null })]);
  });
});

describe('采用时找原来的关系', () => {
  const records = [record('r1', 'shen', 'gu', '灭门仇敌', { validToChapterId: 'c2' }), record('r2', 'gu', 'shen', '暂时联手', { validFromChapterId: 'c3', category: 'ally' }), record('r3', 'shen', 'chu', '互利同盟')];

  it('指认的那条仍成立时取它；否则在这一章成立的两人之间按称谓或唯一的一条', () => {
    expect(relationToChange(records, 'r1', 'shen', 'gu', '灭门仇敌', 1, order)?.id).toBe('r1');
    // r1 到第二章为止，第四章时改由同样两人之间成立的 r2 接替。
    expect(relationToChange(records, 'r1', 'shen', 'gu', '灭门仇敌', 3, order)?.id).toBe('r2');
    expect(relationToChange(records, null, 'chu', 'gu', '', 3, order)).toBeUndefined();
  });
});
