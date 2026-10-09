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
});

describe('规避词表', () => {
  it('默认用内置词表；作者的词表去掉空白项；清空表示不检查；可恢复默认', async () => {
    const app = await setup();
    expect(value(await app.listWritingSkills())).toMatchObject({ avoidPhrases: DEFAULT_AVOID_PHRASES, avoidPhrasesCustom: false });
    expect(value(await app.setAvoidPhrases(['不禁', ' ', '一抹 ']))).toMatchObject({ avoidPhrases: ['不禁', '一抹'], avoidPhrasesCustom: true });
    expect(value(await app.setAvoidPhrases([]))).toMatchObject({ avoidPhrases: [], avoidPhrasesCustom: true });
    expect(value(await app.setAvoidPhrases(null))).toMatchObject({ avoidPhrases: DEFAULT_AVOID_PHRASES, avoidPhrasesCustom: false });
  });
});
