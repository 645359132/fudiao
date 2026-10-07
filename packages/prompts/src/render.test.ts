import {
  adjudicate,
  buildCharacterView,
  initialState,
  planBeliefUpdate,
  applyEvent,
  screenSecretInferences,
  type KnowledgeId,
  type SimState,
} from '@novel-writer/domain';
import {
  A,
  CANARY,
  P,
  Tape,
  canaryScene,
  crowded,
  item,
  run,
  simulate,
  staticForbidden,
  tapeArb,
  withEffects,
  zone,
} from '@novel-writer/domain/testing';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  renderActionRejected,
  renderBeatSheet,
  renderBeliefUpdate,
  renderCandidateText,
  renderCharacterAction,
  renderEvidenceJudgement,
  renderSceneDraft,
  renderSemanticRuling,
  renderStructuredRepair,
  type RenderedPrompt,
} from './render';

const scene = crowded();
const start: SimState = { ...initialState(scene, 3), round: 1 };

const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const fullText = (p: RenderedPrompt) => [...p.system.map((s) => s.text), ...p.messages.map((m) => m.content)].join('\n');

describe('角色行动提案', () => {
  const prompt = unwrap(renderCharacterAction(buildCharacterView(scene, start, P), { protocol: 'simultaneous' }));

  it('通用规则、角色卡与场地、本回合视图分段，在第二段末尾设置缓存断点', () => {
    expect(prompt.system.map((s) => s.cache === true)).toEqual([false, true, false]);
    expect(prompt.system[1]?.text).toContain('带着密信从南门脱身');
    expect(prompt.system[1]?.text).toContain('仓库中央[center]');
    expect(prompt.system[2]?.text).toContain('现在是第 1 回合');
    expect(prompt.template).toEqual({ id: 'character_action', version: '1' });
    expect(prompt.output?.name).toBe('ActionProposal');
  });

  it('列出本人的认知，包括错误信念与二阶推测', () => {
    const text = fullText(prompt);
    expect(text).toContain('对手的弩箭已经用完');
    expect(text).toContain('关于对手怎么看你：对手以为我伤得很轻');
    expect(text).toContain('相信程度 0.7');
  });

  it('不含他人的认知与秘密', () => {
    const text = fullText(prompt);
    expect(text).not.toContain('绊索');
    expect(text).not.toContain('最后一支箭');
  });

  it('把观察渲染为人物能读懂的叙述', () => {
    const s = withEffects(scene, start, [
      { type: 'moveActor', actor: P, to: zone('shelves') },
      { type: 'transferItem', item: item('tiles'), to: { kind: 'actor', actor: P } },
    ]);
    const after = run(scene, s, [{ actor: P, kind: 'use_item', item: item('tiles') }]).nextState;
    const text = fullText(unwrap(renderCharacterAction(buildCharacterView(scene, after, A), { protocol: 'simultaneous' })));
    expect(text).toContain('从货架区传来一阵响动，听得出是碎瓦');
    const own = fullText(unwrap(renderCharacterAction(buildCharacterView(scene, after, P), { protocol: 'simultaneous' })));
    expect(own).toContain('你在货架区使用碎瓦');
  });

  it('轮流对话时列出对方正在说的话，供听者选择打断点', () => {
    const together = withEffects(scene, start, [{ type: 'moveActor', actor: A, to: zone('center') }]);
    const text = fullText(
      unwrap(
        renderCharacterAction(buildCharacterView(scene, together, P), {
          protocol: 'turn_based',
          pendingSpeech: { speaker: A, sentences: ['把信交出来。', '我数到三。'] },
        }),
      ),
    );
    expect(text).toContain('对手正在对你说');
    expect(text).toContain('2. 我数到三。');
  });
});

describe('其他模板', () => {
  it('规则拒绝的修正请求说明原因', () => {
    const text = fullText(unwrap(renderActionRejected(buildCharacterView(scene, start, P), { code: 'not_adjacent', ref: zone('office') })));
    expect(text).toContain('一回合到不了');
  });

  it('结构化输出的修正消息逐条列出问题', () => {
    expect(unwrap(renderStructuredRepair(['kind: 无效的值', 'intent: 必填']))).toContain('- intent: 必填');
  });

  it('认知更新标出本回合新得到的条目', () => {
    const text = fullText(unwrap(renderBeliefUpdate(buildCharacterView(scene, start, P), ['protagonist:0:1' as KnowledgeId])));
    expect(text).toContain('[protagonist:0:1]');
    expect(text).toContain('他人说法');
  });

  it('语义裁决给出涉及的人与物的真实状态，不含场景标题与人物内心', () => {
    const adjudication = unwrap(
      ((r) => (r.ok ? { ok: true as const, value: r.value } : { ok: false as const, error: JSON.stringify(r.error) }))(
        adjudicate(scene, start, [{ actor: A, kind: 'attack', target: P, item: item('crossbow') }]),
      ),
    );
    const request = adjudication.pending[0]!;
    const text = fullText(unwrap(renderSemanticRuling({ scene, state: start, adjudication, request })));
    expect(text).toContain('对手[antagonist]：在南门');
    expect(text).toContain('弩[crossbow]（bolts 1）');
    expect(text).toContain('攻击，对象 主角，使用 弩（需要裁决）');
    expect(text).not.toContain('废仓库夺信');
    expect(text).not.toContain('带着密信从南门脱身');
  });

  it('证据链判断附上秘密与人物已有的线索', () => {
    const planned = planBeliefUpdate(scene, start, P, { add: [{ text: '南门恐怕有埋伏', confidence: 0.5, about: ['south_gate'] }] });
    if (!planned.ok) throw new Error('应当成功');
    const next = applyEvent(scene, start, planned.value);
    if (!next.ok) throw new Error('应当成功');
    const candidates = screenSecretInferences(scene, next.value, P, planned.value.added);
    const text = fullText(
      unwrap(renderEvidenceJudgement(buildCharacterView(scene, next.value, P), candidates, { tripwire_secret: '对手在南门布置了绊索' })),
    );
    expect(text).toContain('南门恐怕有埋伏');
    expect(text).toContain('相关的秘密：对手在南门布置了绊索');
    expect(text).toContain('- 没有');
  });

  describe('正文视角', () => {
    const together = withEffects(scene, start, [{ type: 'moveActor', actor: A, to: zone('center') }]);
    const after = run(scene, together, [
      { actor: A, kind: 'speak', target: P, utterance: { sentences: ['援兵就在门外。'], volume: 'normal' } },
    ]).nextState;
    const view = buildCharacterView(scene, after, P);
    const heard = view.knowledge.at(-1)!.id;

    it('节拍表的材料只能来自视角人物的认知', () => {
      expect(renderBeatSheet(view, { materials: ['antagonist:0:0' as KnowledgeId], thoughts: [] }).ok).toBe(false);
      const text = fullText(unwrap(renderBeatSheet(view, { materials: [heard], thoughts: [{ round: 1, text: '他在虚张声势吗？' }] })));
      expect(text).toContain('对手说：“援兵就在门外。”');
      expect(text).toContain('他在虚张声势吗？');
    });

    it('标记为省略的节拍不进入正文请求', () => {
      const first = view.knowledge[0]!.id;
      const text = fullText(
        unwrap(
          renderCandidateText(view, {
            beats: [
              { ref: first, treatment: 'omit', note: '', withhold: false },
              { ref: heard, treatment: 'expand', note: '写出主角的迟疑', withhold: true },
            ],
            thoughts: [],
          }),
        ),
      );
      expect(text).not.toContain('左肩有伤');
      expect(text).toContain('【展开】【暂不说明】');
      expect(text).toContain('写出主角的迟疑');
    });
  });

  it('场景配置草稿包含作者的描述', () => {
    expect(fullText(unwrap(renderSceneDraft('当铺里，掌柜与落魄书生讨价还价。')))).toContain('落魄书生');
  });
});

describe('金丝雀泄露测试（提示词）', () => {
  const canary = canaryScene();
  const actors = canary.actors.map((a) => a.id);

  it('任意回合后，角色提示词中不出现场景元信息、秘密与他人的角色卡', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffffff }), fc.integer({ min: 0, max: 6 }), tapeArb, (seed, rounds, values) => {
        const { final } = simulate(canary, seed, rounds, new Tape(values));
        for (const who of actors) {
          const view = buildCharacterView(canary, final, who);
          const prompts = [
            unwrap(renderCharacterAction(view, { protocol: 'simultaneous' })),
            unwrap(renderBeliefUpdate(view, [])),
          ];
          for (const prompt of prompts) {
            const text = fullText(prompt);
            for (const marker of staticForbidden(canary, who)) expect(text).not.toContain(marker);
            expect(text).toContain(`${CANARY}-CARD-${who}-goal`);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it('裁决提示词不含场景元信息与任何角色卡', () => {
    const state = { ...initialState(canary, 1), round: 1 };
    const adjudication = adjudicate(canary, state, [{ actor: A, kind: 'attack', target: P, item: item('crossbow') }]);
    if (!adjudication.ok) throw new Error('应当成功');
    const text = fullText(unwrap(renderSemanticRuling({ scene: canary, state, adjudication: adjudication.value, request: adjudication.value.pending[0]! })));
    expect(text).not.toContain(`${CANARY}-META-`);
    expect(text).not.toContain(`${CANARY}-CARD-`);
    expect(text).not.toContain(`${CANARY}-SECRET-`);
  });
});
