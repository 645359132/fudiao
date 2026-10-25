import { ASSISTANT_TOOLS, AssistantAction, type AssistantTool } from '@fudiao/prompts';
import { describe, expect, it } from 'vitest';
import { confirmationFor, toolLabel, type ToolEnv } from './assistant-tools';

/** 只回答“作品有没有章节计划”与按名称找章节、卷、设定的执行环境；动作没有被执行，其余用到就失败。 */
function envWithPlans(hasPlans: boolean): ToolEnv {
  const unused = () => {
    throw new Error('确认阶段不应调用');
  };
  // 删除关系的说明要读出这条关系，一键修订多章的说明要读出预计；其余用到就失败。
  const quote = { bySeverity: { high: 2, medium: 1, low: 0 }, issues: 3, chapterIds: ['c1', 'c2'], wholeChapter: 1, calls: 2, inputTokens: 3_000, outputTokens: 12_500, costUsd: 0.0312, model: 'm' };
  const host = new Proxy(
    { relationsView: () => Promise.resolve({ ok: true, value: { relationships: [], members: [], positions: [] } }), quoteRevision: () => Promise.resolve({ ok: true, value: quote }) },
    { get: (target, key) => (key in target ? target[key as keyof typeof target] : unused()) },
  ) as unknown as ToolEnv['host'];
  return {
    host,
    project: unused,
    events: {},
    work: unused,
    // 按名称找到的一项：标识为“id:名称”，名称原样（确认说明用找到的那一项）。
    findChapter: (ref) => Promise.resolve({ ok: true, value: { id: `id:${ref}`, title: ref } as never }),
    findVolume: (ref) => Promise.resolve({ ok: true, value: { id: `id:${ref}`, title: ref } as never }),
    findEntity: (ref) => Promise.resolve({ ok: true, value: { id: `id:${ref}`, name: ref } as never }),
    hasPlans: () => Promise.resolve(hasPlans),
    changed: unused,
    call: unused,
  };
}

/** 每个动作的一个合法示例：每个字段取几个候选值中第一个能通过校验的。 */
const CANDIDATES: readonly unknown[] = [null, 'x', 3, [], false, 'character', 'world', 'polish', 'txt', 'book', 'family', 'all', 'fixed', 'quick_book', 'step'];
function sample(tool: AssistantTool): AssistantAction {
  const shape = AssistantAction.options.find((o) => o.shape.tool.value === tool)!.shape as Record<string, { safeParse: (v: unknown) => { success: boolean } }>;
  const values = Object.fromEntries(Object.entries(shape).map(([key, schema]) => [key, key === 'tool' ? tool : CANDIDATES.find((v) => schema.safeParse(v).success)]));
  return AssistantAction.parse(values);
}

describe('AI 助手的命令表（B69、B71）', () => {
  it('每个动作都有给作者看的名称；不认识的动作（旧版本记下的）原样显示', () => {
    for (const tool of ASSISTANT_TOOLS) expect(toolLabel(tool)).not.toBe(tool);
    expect(toolLabel('format_disk')).toBe('format_disk');
  });

  it('须作者确认的恰好是删除与覆盖类的动作；重新生成章节计划只在作品已有计划时确认', async () => {
    const confirmed: string[] = [];
    for (const tool of ASSISTANT_TOOLS) {
      const action = sample(tool);
      if ((await confirmationFor(action.tool, action, envWithPlans(true))) !== null) confirmed.push(tool);
    }
    // continue_workflow 只在按原样采用会覆盖内容的草稿时确认（要查运行，这里的样本没有运行）。
    // 一键修订全书（chapters 为 null）或不止一章时先给出条数与预计费用。
    expect(confirmed.sort()).toEqual(['delete_entity', 'delete_relationship', 'delete_volume', 'plan_chapters', 'revise_review_issues', 'rollback_writer', 'trash_chapter']);
    const plan = sample('plan_chapters');
    expect(await confirmationFor(plan.tool, plan, envWithPlans(false))).toBeNull();
    const book = AssistantAction.parse({ tool: 'revise_review_issues', chapters: null, severities: ['high', 'medium'] });
    expect(await confirmationFor(book.tool, book, envWithPlans(false))).toEqual({
      summary: '把 2 章里 3 条严重、一般的待处理审核问题交给写手修订（其中 1 条针对整章，会跳过）：预计调用模型 2 次，约 $0.03（按 m 的价格估计）；每章改之前存快照，可以撤销',
      action: { tool: 'revise_review_issues', chapters: ['c1', 'c2'], severities: ['high', 'medium'] },
    });
    // 只修一章（与审核抽屉的“全部交给写手修订”一样）不用确认。
    const one = AssistantAction.parse({ tool: 'revise_review_issues', chapters: ['第一章'], severities: null });
    expect(await confirmationFor(one.tool, one, envWithPlans(false))).toBeNull();
    const trash = AssistantAction.parse({ tool: 'trash_chapter', chapter: '第三章' });
    // 确认绑定找到的那一项：作者确认后执行的动作用它的标识。
    expect(await confirmationFor(trash.tool, trash, envWithPlans(false))).toEqual({ summary: '把“第三章”移入回收站', action: { tool: 'trash_chapter', chapter: 'id:第三章' } });
  });
});
