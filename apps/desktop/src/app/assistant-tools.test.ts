import { ASSISTANT_TOOLS, AssistantAction, type AssistantTool } from '@fudiao/prompts';
import { describe, expect, it } from 'vitest';
import { confirmationFor, toolLabel, type ToolEnv } from './assistant-tools';

/** 只回答“作品有没有章节计划”的执行环境；动作没有被执行，其余用到就失败。 */
function envWithPlans(hasPlans: boolean): ToolEnv {
  const unused = () => {
    throw new Error('确认阶段不应调用');
  };
  return {
    host: new Proxy({}, { get: unused }) as ToolEnv['host'],
    project: unused,
    events: {},
    work: unused,
    findChapter: unused,
    findVolume: unused,
    findEntity: unused,
    hasPlans: () => Promise.resolve(hasPlans),
    changed: unused,
    call: unused,
  };
}

/** 每个动作的一个合法示例：每个字段取几个候选值中第一个能通过校验的。 */
const CANDIDATES: readonly unknown[] = [null, 'x', 3, [], 'character', 'world', 'polish', 'txt', 'book'];
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
    expect(confirmed.sort()).toEqual(['delete_entity', 'delete_volume', 'plan_chapters', 'rollback_writer', 'trash_chapter']);
    const plan = sample('plan_chapters');
    expect(await confirmationFor(plan.tool, plan, envWithPlans(false))).toBeNull();
    const trash = AssistantAction.parse({ tool: 'trash_chapter', chapter: '第三章' });
    expect(await confirmationFor(trash.tool, trash, envWithPlans(false))).toBe('把“第三章”移入回收站');
  });
});
