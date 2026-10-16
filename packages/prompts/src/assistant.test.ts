import { describe, expect, it } from 'vitest';
import { ASSISTANT_TOOLS, AssistantTurnOutput } from './assistant';
import { PARTIAL_SOURCES } from './generated/templates';
import { modelJsonSchema } from './json-schema';
import { renderAssistantTurn, type AssistantState } from './render';

const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

const state: AssistantState = {
  works: ['当铺夜谈', '雨夜'],
  work: {
    title: '当铺夜谈',
    genre: '古风悬疑',
    synopsis: '林舟当玉。',
    outline: '',
    volumes: [{ id: 'V1', title: '第一卷 雨夜', summary: '林舟当玉' }],
    chapters: [{ id: 'C1', title: '第一章 夜叩', volume: '第一卷 雨夜', words: 1200, plan: '已写' }],
    chapterCount: 1,
    totalWords: 1200,
    plannedCount: 1,
    omitted: false,
    entities: [{ id: 'E1', kind: '人物', name: '林舟', locked: true }],
    trashed: [],
    current: '第一章 夜叩',
    selection: null,
  },
};

describe('AI 助手的提示词（B69）', () => {
  it('动作说明与输出结构一一对应：模板里写到的动作正是可以执行的动作，顺序相同', () => {
    const documented = [...(PARTIAL_SOURCES['assistant_tools'] ?? '').matchAll(/^- ([a-z_]+)：/gm)].map((m) => m[1]);
    expect(documented).toEqual([...ASSISTANT_TOOLS]);
  });

  it('系统提示只有规则与动作说明（不随对话变化）；最后一条消息给出作品现状与作者的请求', () => {
    const prompt = unwrap(renderAssistantTurn({ history: [{ role: 'user', text: '新建一章叫第二章' }], state }));
    expect(prompt).toMatchObject({ template: { id: 'assistant_turn' }, task: 'assistant', output: { name: 'AssistantTurnOutput' } });
    expect(prompt.system).toHaveLength(1);
    expect(prompt.system[0]?.cache).toBe(true);
    expect(prompt.system[0]?.text).toContain('- create_chapter：');
    expect(prompt.system[0]?.text).not.toContain('当铺夜谈');
    expect(prompt.messages).toHaveLength(1);
    const last = prompt.messages[0]!.content;
    for (const part of ['打开的作品：《当铺夜谈》（古风悬疑）', '大纲：还没有', '- [V1] 第一卷 雨夜：林舟当玉', '章节（共 1 章，合计 1200 字，其中 1 章有章节计划）', '- [C1] 第一章 夜叩（第一卷 雨夜），1200 字，计划：已写', '- [E1] 人物：林舟（锁定）', '作者正在看：第一章 夜叩', '作品列表：《当铺夜谈》《雨夜》', '【作者】新建一章叫第二章']) {
      expect(last).toContain(part);
    }
  });

  it('之前的对话按原样排在前面：作者的话与动作结果是 user，助手的输出是 assistant；连续的同一方合并；最后一条是现状加最新的结果', () => {
    const output = { message: '', actions: [{ tool: 'read_chapter' as const, chapter: 'C1' }], done: false };
    const prompt = unwrap(
      renderAssistantTurn({
        history: [
          { role: 'user', text: '第一章写得怎么样' },
          { role: 'user', text: '顺便看看人物' },
          { role: 'assistant', output },
          { role: 'results', results: [{ tool: 'read_chapter', ok: true, detail: '正文：……' }] },
        ],
        state,
      }),
    );
    expect(prompt.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(prompt.messages[0]?.content).toBe('【作者】第一章写得怎么样\n\n【作者】顺便看看人物');
    expect(prompt.messages[1]?.content).toBe(JSON.stringify(output));
    expect(prompt.messages[2]?.content).toContain('【动作结果】\n- read_chapter：成功。正文：……');
    expect(prompt.messages[2]?.content).not.toContain('【作者】');
    // 以助手的输出结尾不能再请求。
    expect(renderAssistantTurn({ history: [{ role: 'assistant', output }], state }).ok).toBe(false);
  });

  it('作者选中的文字与回收站写进现状；没有时不出现', () => {
    const work = state.work!;
    const withSelection: AssistantState = {
      ...state,
      work: { ...work, trashed: [{ id: 'C9', title: '废稿' }], selection: { chapter: '第一章 夜叩', text: '雨下得很大。', length: 6, clipped: false } },
    };
    const last = unwrap(renderAssistantTurn({ history: [{ role: 'user', text: '把这段润色一下' }], state: withSelection })).messages[0]!.content;
    expect(last).toContain('回收站：[C9] 废稿；');
    expect(last).toContain('作者选中的文字（在《第一章 夜叩》中，共 6 字）：\n「雨下得很大。」');
    const plain = unwrap(renderAssistantTurn({ history: [{ role: 'user', text: '你好' }], state })).messages[0]!.content;
    expect(plain).not.toContain('回收站');
    expect(plain).not.toContain('作者选中的文字');
  });

  it('没有打开作品时说明这一点，并列出作品列表', () => {
    const last = unwrap(renderAssistantTurn({ history: [{ role: 'user', text: '开一本新书' }], state: { works: [], work: null } })).messages[0]!.content;
    expect(last).toContain('还没有打开作品。');
    expect(last).toContain('作品列表：还没有作品');
  });

  it('输出结构：动作按 tool 区分并逐个校验参数；可辨识联合在 JSON Schema 中写成 anyOf', () => {
    expect(
      AssistantTurnOutput.safeParse({
        message: '好的',
        actions: [
          { tool: 'create_volume', title: '第一卷', summary: null, after: null },
          { tool: 'create_entity', kind: 'character', name: '林舟', description: '落魄书生', aliases: ['林生'] },
        ],
        done: true,
      }).success,
    ).toBe(true);
    expect(AssistantTurnOutput.safeParse({ message: '', actions: [{ tool: 'create_volume', title: '第一卷' }], done: false }).success).toBe(false);
    expect(AssistantTurnOutput.safeParse({ message: '', actions: [{ tool: 'format_disk' }], done: false }).success).toBe(false);
    const schema = JSON.stringify(modelJsonSchema(AssistantTurnOutput));
    expect(schema).toContain('"anyOf"');
    expect(schema).not.toContain('"oneOf"');
  });
});
