import { rmSync } from 'node:fs';
import { BUILTIN_SKILLS } from '@fudiao/prompts';
import { DEFAULT_AVOID_PHRASES } from '@fudiao/writing';
import { afterEach, describe, expect, it } from 'vitest';
import { fsDeps, type TestDeps } from '../testing/fs-deps';
import { createAppService } from './service';

const all: TestDeps[] = [];
afterEach(async () => {
  for (const d of all.splice(0)) {
    await d.dispose();
    rmSync(d.root, { recursive: true, force: true });
  }
});

function value<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

async function setup() {
  const deps = fsDeps();
  all.push(deps);
  const app = createAppService(deps);
  value(await app.loadLibrary());
  value(await app.createWork('雨夜'));
  return app;
}

describe('写作技能', () => {
  it('打开时登记全部内置技能并启用，附上模板文字；再次打开不重复登记', async () => {
    const app = await setup();
    const first = value(await app.listWritingSkills());
    expect(first.skills.map((s) => s.skill.key)).toEqual(BUILTIN_SKILLS.map((s) => s.key));
    expect(first.skills.every((s) => s.skill.enabled && s.builtinText !== null && s.builtinText.length > 0)).toBe(true);
    const again = value(await app.listWritingSkills());
    expect(again.skills.map((s) => s.skill.id)).toEqual(first.skills.map((s) => s.skill.id));
  });

  it('停用、改写说明与恢复内置文字', async () => {
    const app = await setup();
    const hook = value(await app.listWritingSkills()).skills.find((s) => s.skill.key === 'cliffhanger')!.skill;
    const edited = value(await app.updateWritingSkill(hook, { enabled: false, instruction: '停在悬念上，不要总结。' }));
    const changed = edited.skills.find((s) => s.skill.key === 'cliffhanger')!;
    expect(changed.skill).toMatchObject({ enabled: false, instruction: '停在悬念上，不要总结。' });
    const reset = value(await app.updateWritingSkill(changed.skill, { instruction: '' }));
    expect(reset.skills.find((s) => s.skill.key === 'cliffhanger')!.skill.instruction).toBe('');
  });

  it('添加与删除自定义技能；名称与说明不能为空；内置技能不能删除', async () => {
    const app = await setup();
    expect(await app.addCustomSkill(' ', '说明')).toMatchObject({ ok: false });
    expect(await app.addCustomSkill('对话', ' ')).toMatchObject({ ok: false });
    const added = value(await app.addCustomSkill('对话节奏', '对话三句内要有动作。'));
    const mine = added.skills.at(-1)!;
    expect(mine).toMatchObject({ builtinText: null, skill: { name: '对话节奏', enabled: true, builtinVersion: null } });
    expect(await app.deleteCustomSkill(added.skills[0]!.skill)).toMatchObject({ ok: false });
    const after = value(await app.deleteCustomSkill(mine.skill));
    expect(after.skills.some((s) => s.skill.id === mine.skill.id)).toBe(false);
  });

  it('技能的阶段（B75）：雪花写作法用于规划，其余内置技能写章节；自定义技能可以选阶段，内置技能的不能改', async () => {
    const app = await setup();
    const listed = value(await app.listWritingSkills()).skills;
    expect(listed.filter((s) => s.skill.stages.includes('planning')).map((s) => s.skill.key)).toEqual(['snowflake']);
    expect(listed.find((s) => s.skill.key === 'snowflake')).toMatchObject({ skill: { name: '雪花写作法', enabled: true }, description: expect.stringContaining('生成作品骨架') });
    const plain = value(await app.addCustomSkill('对话节奏', '对话三句内要有动作。')).skills.at(-1)!;
    expect(plain.skill.stages).toEqual(['writing']);
    const arc = value(await app.addCustomSkill('三幕', '按三幕安排章节。', '规划时使用', 'three-acts', ['planning'])).skills.at(-1)!;
    expect(arc.skill.stages).toEqual(['planning']);
    const both = value(await app.updateWritingSkill(arc.skill, { stages: ['planning', 'writing'] })).skills.find((s) => s.skill.key === 'three-acts')!;
    expect(both.skill.stages).toEqual(['planning', 'writing']);
    const snowflake = listed.find((s) => s.skill.key === 'snowflake')!;
    expect(await app.updateWritingSkill(snowflake.skill, { stages: ['writing'] })).toMatchObject({ ok: false });
  });
});

describe('规避词表', () => {
  it('技能带适用说明：内置的取自模板，自定义的由作者写', async () => {
    const app = await setup();
    const view = value(await app.listWritingSkills());
    expect(view.skills.find((s) => s.skill.key === 'cliffhanger')?.description).toBe(BUILTIN_SKILLS.find((s) => s.key === 'cliffhanger')?.description);
    const added = value(await app.addCustomSkill('对话节奏', '对话三句内要有动作。', '写对话时使用。'));
    expect(added.skills.at(-1)).toMatchObject({ description: '写对话时使用。', skill: { description: '写对话时使用。' } });
  });

  it('逐项添加时可以自定标识（SKILL.md 的 name）：不填时自动生成；与已有技能重复、含空格或引号时不添加', async () => {
    const app = await setup();
    const added = value(await app.addCustomSkill('对话节奏', '对话三句内要有动作。', '写对话时使用。', ' dialogue-rhythm '));
    expect(added.skills.at(-1)?.skill).toMatchObject({ key: 'dialogue-rhythm', name: '对话节奏', description: '写对话时使用。' });
    expect(value(await app.addCustomSkill('无标识', '指令', '说明')).skills.at(-1)?.skill.key).toMatch(/^custom-/);
    expect(await app.addCustomSkill('撞名', '指令', '说明', 'cliffhanger')).toMatchObject({ ok: false, error: { detail: expect.stringContaining('已被“章尾收束”使用') } });
    expect(await app.addCustomSkill('撞名', '指令', '说明', 'dialogue-rhythm')).toMatchObject({ ok: false, error: { detail: expect.stringContaining('已被“对话节奏”使用') } });
    expect(await app.addCustomSkill('坏标识', '指令', '说明', 'a b')).toMatchObject({ ok: false, error: { detail: expect.stringContaining('不能有空格') } });
    expect(value(await app.listWritingSkills()).skills.filter((s) => s.skill.builtinVersion === null)).toHaveLength(2);
  });

  it('导入 SKILL.md：成为自定义技能；同一标识再导入时更新；格式不对时说明原因', async () => {
    const app = await setup();
    const file = (body: string) => `---
name: webnovel-pacing
description: 网文节奏：写连载章节时使用。
metadata:
  title: "网文节奏"
---

${body}
`;
    const first = value(await app.importSkillMd(file('开篇三百字内进入冲突。')));
    expect(first).toMatchObject({ name: '网文节奏', replaced: false });
    expect(first.view.skills.at(-1)).toMatchObject({
      description: '网文节奏：写连载章节时使用。',
      builtinText: null,
      skill: { key: 'webnovel-pacing', name: '网文节奏', instruction: '开篇三百字内进入冲突。', enabled: true, builtinVersion: null },
    });
    const again = value(await app.importSkillMd(file('每章至少一个爽点。')));
    expect(again.replaced).toBe(true);
    expect(again.view.skills.filter((s) => s.skill.key === 'webnovel-pacing').map((s) => s.skill.instruction)).toEqual(['每章至少一个爽点。']);
    // 没有 metadata.title 时用 name 作名称。
    expect(value(await app.importSkillMd('---\nname: plain\ndescription: d\n---\n正文')).name).toBe('plain');
    expect(await app.importSkillMd('只是一段文字')).toMatchObject({ ok: false, error: { code: 'settings', detail: expect.stringContaining('不是 SKILL.md') } });
  });

  it('导出为 SKILL.md 再导回：自定义技能原样回来；内置技能导回时成为对它的改写，名称与说明仍用内置的', async () => {
    const app = await setup();
    const added = value(await app.addCustomSkill('对话节奏', '对话三句内要有动作。', '写对话时使用。'));
    const mine = added.skills.at(-1)!;
    const exported = app.skillMdOf(mine);
    expect(exported.fileName).toBe(`${mine.skill.key}.SKILL.md`);
    expect(exported.content).toContain('description: "写对话时使用。"');
    value(await app.deleteCustomSkill(mine.skill));
    const back = value(await app.importSkillMd(exported.content));
    expect(back.view.skills.at(-1)?.skill).toMatchObject({ key: mine.skill.key, name: '对话节奏', description: '写对话时使用。', instruction: '对话三句内要有动作。' });

    const hook = back.view.skills.find((s) => s.skill.key === 'cliffhanger')!;
    const hookFile = app.skillMdOf(hook);
    expect(hookFile.content).toContain(hook.builtinText!);
    // 原样导回：仍是模板文字（不算改写）。
    expect(value(await app.importSkillMd(hookFile.content)).view.skills.find((s) => s.skill.key === 'cliffhanger')?.skill.instruction).toBe('');
    const edited = value(await app.importSkillMd(hookFile.content.replace(hook.builtinText!, '停在悬念上。')));
    expect(edited).toMatchObject({ name: '章尾收束', replaced: true });
    expect(edited.view.skills.find((s) => s.skill.key === 'cliffhanger')?.skill).toMatchObject({ instruction: '停在悬念上。', builtinVersion: hook.skill.builtinVersion });
    expect(edited.view.skills.filter((s) => s.skill.key === 'cliffhanger')).toHaveLength(1);
  });

  it('SKILL.md 的阶段（B75）：导入时读 metadata.stages（没写时为写章节），导出时写上；只写章节的不写', async () => {
    const app = await setup();
    const file = (stages: string) => `---\nname: three-acts\ndescription: 规划时使用\nmetadata:\n  title: "三幕"\n${stages}---\n\n按三幕安排章节。\n`;
    const imported = value(await app.importSkillMd(file('  stages: "planning"\n'))).view.skills.at(-1)!;
    expect(imported.skill).toMatchObject({ key: 'three-acts', stages: ['planning'] });
    expect(app.skillMdOf(imported).content).toContain('stages: "planning"');
    // 再导入一次没写阶段的版本：回到写章节。
    const plain = value(await app.importSkillMd(file(''))).view.skills.find((s) => s.skill.key === 'three-acts')!;
    expect(plain.skill.stages).toEqual(['writing']);
    expect(app.skillMdOf(plain).content).not.toContain('stages');
    // 内置的雪花写作法导出时带上阶段；导回成为对它的改写，阶段仍是内置的。
    const snowflake = value(await app.listWritingSkills()).skills.find((s) => s.skill.key === 'snowflake')!;
    const exported = app.skillMdOf(snowflake).content;
    expect(exported).toContain('stages: "planning"');
    const back = value(await app.importSkillMd(exported.replace('stages: "planning"', 'stages: "writing"'))).view.skills.find((s) => s.skill.key === 'snowflake')!;
    expect(back.skill).toMatchObject({ stages: ['planning'], instruction: '' });
  });

  it('默认用内置词表；作者的词表去掉空白项；清空表示不检查；可恢复默认', async () => {
    const app = await setup();
    expect(value(await app.listWritingSkills())).toMatchObject({ avoidPhrases: DEFAULT_AVOID_PHRASES, avoidPhrasesCustom: false });
    expect(value(await app.setAvoidPhrases(['不禁', ' ', '一抹 ']))).toMatchObject({ avoidPhrases: ['不禁', '一抹'], avoidPhrasesCustom: true });
    expect(value(await app.setAvoidPhrases([]))).toMatchObject({ avoidPhrases: [], avoidPhrasesCustom: true });
    expect(value(await app.setAvoidPhrases(null))).toMatchObject({ avoidPhrases: DEFAULT_AVOID_PHRASES, avoidPhrasesCustom: false });
  });
});
