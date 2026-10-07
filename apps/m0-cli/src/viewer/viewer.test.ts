import { createEngine, type RunEvent } from '@novel-writer/engine';
import { fakeModel, testConfig, waitProposal } from '@novel-writer/engine/testing';
import { canaryScene, staticForbidden } from '@novel-writer/domain/testing';
import { memoryCallLog } from '@novel-writer/llm';
import { memoryEventStore } from '@novel-writer/store';
import { describe, expect, it } from 'vitest';
import { buildViewerData } from './data';
import { embedJson, renderViewerHtml } from './html';

async function recordedRun() {
  const scene = canaryScene();
  const store = memoryEventStore();
  const model = fakeModel({
    character_action: (ctx) =>
      ctx.subject === 'antagonist' && ctx.round === 1
        ? waitProposal({ kind: 'speak', utterance: { sentences: ['援兵就在门外。'], volume: 'shout' }, innerThought: '先吓住他' })
        : waitProposal({ kind: 'observe' }),
  });
  const engine = createEngine({ llm: model.port, events: store, calls: memoryCallLog(), now: () => '2026-10-07T00:00:00.000Z' });
  await engine.start('run1', scene, testConfig({ maxRounds: 2 }));
  await engine.run('run1', scene);
  const events = (await store.read('run1')).map((e) => e.payload as RunEvent);
  return { scene, events };
}

describe('静态查看页的数据', () => {
  it('按回合整理行动、发生的事、感知与世界状态', async () => {
    const { scene, events } = await recordedRun();
    const data = buildViewerData(scene, 'run1', events);
    expect(data.rounds.map((r) => r.round)).toEqual([1, 2]);
    const first = data.rounds[0]!;
    expect(first.proposals.find((p) => p.kind === 'speak')).toMatchObject({ actor: '对手', innerThought: '先吓住他' });
    const speech = first.occurrences.find((o) => o.kind === 'speak');
    expect(speech?.sentences).toEqual(['援兵就在门外。']);
    expect(speech?.perceivedBy.map((p) => p.actor).sort()).toEqual(['主角', '对手', '巡夜人'].sort());
    expect(data.endReason).toBe('max_rounds');
  });

  it('“角色所见”就是角色视图：不含他人的角色卡、秘密与场景元信息', async () => {
    const { scene, events } = await recordedRun();
    const data = buildViewerData(scene, 'run1', events);
    for (const round of data.rounds) {
      for (const actor of scene.actors) {
        const text = JSON.stringify(round.views[actor.id]);
        for (const marker of staticForbidden(scene, actor.id)) expect(text).not.toContain(marker);
      }
    }
  });
});

describe('静态查看页的 HTML', () => {
  it('内嵌数据中的 </script> 被转义，页面不加载外部资源', async () => {
    const { scene, events } = await recordedRun();
    const html = renderViewerHtml(buildViewerData(scene, 'run1', events));
    expect(embedJson({ text: '</script><script>alert(1)</script>' })).not.toContain('</script>');
    expect(html.match(/<script/g)).toHaveLength(2);
    expect(html).not.toMatch(/src=|href=/);
    expect(html).toContain('<html lang="zh-CN">');
  });
});
