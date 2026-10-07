import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCharacterView, initialState } from '@fudiao/domain';
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
  });

  it('运行配置有误时报告位置', () => {
    expect(loadSceneFile('run: { protocol: sometimes, maxRounds: 3 }\nscene: {}')).toEqual({
      ok: false,
      error: { code: 'run', path: ['protocol'] },
    });
  });
});
