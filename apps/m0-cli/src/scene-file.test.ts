import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCharacterView, checkAction, clockAt, initialState, type ActorId, type ZoneId } from '@fudiao/domain';
import { canonicalJson } from '@fudiao/shared';
import { describe, expect, it } from 'vitest';
import { loadSceneFile } from './scene-file';

const dir = fileURLToPath(new URL('../../../m0/scenes/', import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith('.yaml'));

describe('M0 实验场景', () => {
  it('有三个场景', () => {
    expect(files.sort()).toEqual(['pawnshop.yaml', 'rainy-night.yaml', 'warehouse.yaml']);
  });

  describe.each(files)('%s', (file) => {
    const loaded = loadSceneFile(readFileSync(join(dir, file), 'utf8'));

    it('通过校验', () => {
      expect(loaded).toMatchObject({ ok: true });
    });

    it('符合首版原型范围：两名角色、4 到 6 个区域、每人最多五条初始认知', () => {
      if (!loaded.ok) return;
      const { scene } = loaded.value;
      expect(scene.actors).toHaveLength(2);
      expect(scene.zones.length).toBeGreaterThanOrEqual(4);
      expect(scene.zones.length).toBeLessThanOrEqual(6);
      for (const a of scene.actors) expect(a.card.initialKnowledge.length).toBeLessThanOrEqual(5);
    });

    it('轮流对话的两人起初在同一区域，能听清彼此的话', () => {
      if (!loaded.ok || loaded.value.run.protocol !== 'turn_based') return;
      const zones = new Set(loaded.value.scene.actors.map((a) => a.zone));
      expect(zones.size).toBe(1);
    });

    it('角色视图中不出现场景标题、探索问题与秘密的原文', () => {
      if (!loaded.ok) return;
      const { scene } = loaded.value;
      const state = initialState(scene, 1);
      for (const a of scene.actors) {
        const text = canonicalJson(buildCharacterView(scene, state, a.id));
        if (scene.meta.title) expect(text).not.toContain(scene.meta.title);
        for (const q of scene.meta.questions) expect(text).not.toContain(q);
        for (const s of scene.secrets) expect(text).not.toContain(s.text);
      }
    });

    it('有场景时钟，时辰随回合推进（M0-13 调整：让有期限的目标有时间压力）', () => {
      if (!loaded.ok) return;
      const { scene, run } = loaded.value;
      expect(clockAt(scene, 1)).not.toBeNull();
      expect(clockAt(scene, run.maxRounds)).not.toBe(clockAt(scene, 1));
    });
  });

  it('仓库：后墙破口不能直接撤离，要先扒开碎砖，扒砖的声响在仓库中央听得见', () => {
    const loaded = loadSceneFile(readFileSync(join(dir, 'warehouse.yaml'), 'utf8'));
    if (!loaded.ok) throw new Error('场景无效');
    const { scene } = loaded.value;
    const atBreach = { ...initialState(scene, 1), round: 1 };
    const moved = { ...atBreach, world: { ...atBreach.world, actors: { ...atBreach.world.actors, shen_yan: { ...atBreach.world.actors['shen_yan' as ActorId]!, zone: 'back_wall' as ZoneId } } } };
    expect(checkAction(scene, moved, { actor: 'shen_yan' as ActorId, kind: 'withdraw' })).toMatchObject({ kind: 'reject', violation: { code: 'not_at_exit' } });
    expect(scene.flags).toEqual({ breach_cleared: false });
    expect(scene.mechanisms.find((m) => m.id === 'loose_bricks')).toMatchObject({ zone: 'back_wall', hidden: false });
  });

  it('运行配置有误时报告位置', () => {
    expect(loadSceneFile('run: { protocol: sometimes, maxRounds: 3 }\nscene: {}')).toEqual({
      ok: false,
      error: { code: 'run', path: ['protocol'] },
    });
  });
});
