import {
  adjudicate,
  buildCharacterView,
  initialState,
  planBeliefUpdate,
  applyEvent,
  screenSecretInferences,
  type KnowledgeId,
  type SimState,
} from '@fudiao/domain';
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
  warehouse,
  withEffects,
  zone,
} from '@fudiao/domain/testing';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  renderActionRejected,
  renderBaseline,
  renderBeatSheet,
  renderBeliefUpdate,
  renderCandidateText,
  renderCharacterAction,
  renderDirectorProposal,
  renderEvidenceJudgement,
  renderChapterMemory,
  renderChapterReview,
  renderBookAudit,
  renderBenchmarkBook,
  renderBenchmarkCompare,
  renderCastCompletion,
  renderRelationChanges,
  renderContinuityCheck,
  renderOpeningReview,
  renderBookVolumes,
  renderPlanDraft,
  renderBookSeed,
  renderRunSynopsis,
  renderSceneDraft,
  renderSemanticRuling,
  renderStalemateJudgement,
  renderStructuredRepair,
  renderWriterChapter,
  renderWriterRevise,
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

  it('认知条目（只追加）排在每回合都会变的局面之前：下一回合多了新条目时，请求的开头不变', () => {
    const round2 = { ...start, round: 2 };
    const planned = planBeliefUpdate(scene, round2, P, { add: [{ text: '对手在等援兵', confidence: 0.4, about: [A] }] });
    if (!planned.ok) throw new Error('应当成功');
    const next = applyEvent(scene, round2, planned.value);
    if (!next.ok) throw new Error('应当成功');
    const later = unwrap(renderCharacterAction(buildCharacterView(scene, next.value, P), { protocol: 'simultaneous' }));
    const before = prompt.system[2]!.text;
    const after = later.system[2]!.text;
    expect(before.startsWith('你所知道、记得和推测的事')).toBe(true);
    const known = before.slice(0, before.indexOf('现在是第'));
    expect(after.startsWith(known.trimEnd())).toBe(true);
    expect(after.slice(known.trimEnd().length, after.indexOf('现在是第'))).toContain('对手在等援兵');
    expect(prompt.system.slice(0, 2).map((s) => s.text)).toEqual(later.system.slice(0, 2).map((s) => s.text));
  });

  it('通用规则、角色卡与场地、本回合视图分段，在第二段末尾设置缓存断点', () => {
    expect(prompt.system.map((s) => s.cache === true)).toEqual([false, true, false]);
    expect(prompt.system[1]?.text).toContain('带着密信从南门脱身');
    expect(prompt.system[1]?.text).toContain('仓库中央[center]');
    expect(prompt.system[2]?.text).toContain('现在是第 1 回合');
    expect(prompt.template).toEqual({ id: 'character_action', version: '10' });
    expect(prompt.output?.name).toBe('ActionProposal');
  });

  it('写出场景时钟给出的时辰，以及压力与取舍的规则', () => {
    const timed = warehouse((s) => {
      s.clock = [
        { fromRound: 1, label: '三更' },
        { fromRound: 3, label: '五更，天快亮了' },
      ];
    });
    const text = fullText(unwrap(renderCharacterAction(buildCharacterView(timed, { ...initialState(timed, 1), round: 3 }, P), { protocol: 'simultaneous' })));
    expect(text).toContain('现在是第 3 回合，大约五更，天快亮了。');
    expect(text).toContain('不要重复你已经说过的条件或理由');
    expect(text).toContain('triggered');
    const untimed = fullText(prompt);
    expect(untimed).toContain('现在是第 1 回合。');
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
    expect(text).toContain('对手正在说话，你听得清');
    expect(text).toContain('2. 我数到三。');
    // 不靠提示词要求模型“忽略”没听到的部分（硬性规则 2）：被打断时这次回应由引擎作废。
    expect(text).not.toContain('不算你知道的事');
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

  it('语义裁决写出旁人可见的具体动作与同时说的话', () => {
    const adjudication = unwrap(
      ((r) => (r.ok ? { ok: true as const, value: r.value } : { ok: false as const, error: JSON.stringify(r.error) }))(
        adjudicate(scene, start, [
          { actor: A, kind: 'other', target: P, description: '把弩横放在地上', utterance: { sentences: ['我不想动手。'], volume: 'normal' } },
        ]),
      ),
    );
    const text = fullText(unwrap(renderSemanticRuling({ scene, state: start, adjudication, request: adjudication.pending[0]! })));
    expect(text).toContain('具体动作：把弩横放在地上，说：“我不想动手。”（需要裁决）');
  });

  describe('证据链判断', () => {
    const secrets = [{ id: 'tripwire_secret', text: '对手在南门布置了绊索', subjects: ['tripwire', 'south_gate'] }];
    const infer = (state: SimState, texts: readonly string[]) => {
      const planned = planBeliefUpdate(scene, state, P, { add: texts.map((text) => ({ text, confidence: 0.5, about: ['south_gate'] })) });
      if (!planned.ok) throw new Error('应当成功');
      const next = applyEvent(scene, state, planned.value);
      if (!next.ok) throw new Error('应当成功');
      return { state: next.value, candidates: screenSecretInferences(scene, next.value, P, planned.value.added) };
    };
    const userText = (state: SimState, candidates: ReturnType<typeof infer>['candidates']) =>
      unwrap(renderEvidenceJudgement(buildCharacterView(scene, state, P), candidates, secrets)).messages[0]!.content;

    it('先列他不知道的秘密，再列已有的线索，最后是本回合的推测；本回合的推测不作线索', () => {
      const first = infer(start, ['南门恐怕有埋伏']);
      const text = userText(first.state, first.candidates);
      expect(text).toContain('- [tripwire_secret] 对手在南门布置了绊索');
      expect(text).toContain('他已有的相关线索：\n- 没有');
      expect(text).toContain('- 推测 [protagonist:1:3] 对照秘密 [tripwire_secret]：南门恐怕有埋伏');
      expect(text.indexOf('他不知道的秘密')).toBeLessThan(text.indexOf('他已有的相关线索'));
      expect(text.indexOf('他已有的相关线索')).toBeLessThan(text.indexOf('这一回合要判断的推测'));
    });

    it('线索只列一遍，不为每条推测重复；前几回合的推测算线索', () => {
      const first = infer(start, ['南门恐怕有埋伏']);
      const second = infer({ ...first.state, round: 2 }, ['南门地上可能拉了线', '对手守着南门是有准备的']);
      expect(second.candidates).toHaveLength(2);
      const text = userText(second.state, second.candidates);
      expect(text.split('南门恐怕有埋伏').length - 1).toBe(1);
      expect(text).toContain('- 推测 [protagonist:2:4]');
      expect(text).toContain('- 推测 [protagonist:2:5]');
    });

    it('同一人物前后几回合的请求开头相同（秘密与已有线索只追加），服务端的前缀缓存才能命中', () => {
      const first = infer(start, ['南门恐怕有埋伏']);
      const second = infer({ ...first.state, round: 2 }, ['南门地上可能拉了线']);
      const third = infer({ ...second.state, round: 3 }, ['对手守着南门是有准备的']);
      const head = (text: string) => text.slice(0, text.indexOf('这一回合要判断的推测'));
      const two = head(userText(second.state, second.candidates));
      const three = head(userText(third.state, third.candidates));
      // 第三回合的线索在第二回合的基础上只多了第二回合的那条推测，加在末尾。
      expect(three.startsWith(two.trimEnd())).toBe(true);
      expect(three.slice(two.trimEnd().length)).toContain('南门地上可能拉了线');
    });
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

  it('对照组提示词包含全部设定与秘密，但不含场景标题与探索问题', () => {
    const text = fullText(unwrap(renderBaseline(scene, { targetLength: 2000 })));
    expect(text).toContain('约 2000 字');
    expect(text).toContain('带着密信从南门脱身');
    expect(text).toContain('我在南门布了绊索');
    expect(text).toContain('对手在南门布置了绊索');
    expect(text).toContain('碎瓦（在货架区）');
    expect(text).not.toContain('废仓库夺信');
    expect(text).not.toContain('主角能否发现南门的绊索');
  });

  it('事件梗概写出开场时的状态，并要求合并重复的拉锯、写清同一回合的先后', () => {
    const hurt = warehouse((s) => {
      s.actors[0]!.injury = 'light';
    });
    const text = fullText(unwrap(renderRunSynopsis(hurt, initialState(hurt, 1), { ...initialState(hurt, 1), round: 2 }, [])));
    expect(text).toContain('开场时：');
    expect(text).toMatch(/开场时：\n- 主角在仓库中央，轻伤/);
    expect(text).toContain('来回重复、没有新东西的拉锯合并成一条');
    expect(text).toContain('说话发生在他移动之前所在的地方');
  });

  it('场景配置草稿包含作者的描述；没有章节材料时按描述建，默认两个人物', () => {
    const text = fullText(unwrap(renderSceneDraft({ description: '当铺里，掌柜与落魄书生讨价还价。' })));
    expect(text).toContain('作者对局面的描述：\n当铺里，掌柜与落魄书生讨价还价。');
    expect(text).toContain('默认两个人物');
    expect(text).not.toContain('出场人物');
  });

  it('按章节计划建场景（B39 补充）：角色就是出场人物、名字照用，带上各人知道的、在场与不在场的章、关系、事实、地点、要揭晓与不得说破的；描述是补充', () => {
    const text = fullText(
      unwrap(
        renderSceneDraft({
          description: '让钱四先开口。',
          chapter: {
            title: '当铺夜谈',
            genre: '古代市井',
            chapterTitle: '第二章 夜雨',
            goal: '林舟再访当铺',
            beats: ['叩门', '压价'],
            treatment: '对峙展开',
            volumeSummary: '林舟当玉，引出旧主。',
            cast: [
              {
                name: '林舟',
                description: '落魄书生',
                state: '玉还在手里',
                knows: [
                  { text: '玉是父亲留下的', kind: 'belief', modality: 'observed', confidence: 1 },
                  { text: '钱四认得这块玉', kind: 'belief', modality: 'inferred', confidence: 0.6 },
                  { text: '玉是捡来的', kind: 'claim', modality: 'claimed', confidence: null },
                ],
                present: ['第一章 夜叩（林舟当玉被压价）'],
                absent: [],
              },
              { name: '钱四', description: '', state: '', knows: [], present: [], absent: ['第一章 夜叩（林舟当玉被压价）'] },
            ],
            relations: [{ from: '钱四', to: '林舟', label: '债主', mutual: false, description: '', secret: true }],
            worldFacts: ['当铺后院有口井'],
            memories: [{ title: '第一章 夜叩', summary: '林舟当玉被压价' }],
            openThreads: ['钱四约他三日后再来'],
            locations: [{ name: '当铺', description: '城南的老铺子' }],
            toPayoff: [{ title: '玉佩的来历', reveal: '玉佩是父亲的遗物' }],
            mustNotReveal: ['债主是钱四的表兄'],
          },
        }),
      ),
    );
    for (const part of [
      '名字一字不差照用',
      '作者对局面的补充描述：\n让钱四先开口。',
      '本卷梗概：林舟当玉，引出旧主。',
      '本章：第二章 夜雨\n本章目标：林舟再访当铺\n详略：对峙展开',
      '- 叩门\n- 压价',
      '- 林舟：落魄书生（最近的状态：玉还在手里）\n  知道或相信的：亲身经历：玉是父亲留下的；推测：钱四认得这块玉（相信程度 0.6）；说过：玉是捡来的；\n  最近出场：第一章 夜叩（林舟当玉被压价）',
      '- 钱四\n  不在场、前文没写他得知：第一章 夜叩（林舟当玉被压价）',
      '- 钱四是林舟的债主〔隐秘〕',
      '已确认的世界事实：\n- 当铺后院有口井',
      '上一章结尾留下的事：\n- 钱四约他三日后再来',
      '地点设定：\n- 当铺：城南的老铺子',
      '本章要揭晓的：\n- 玉佩的来历：玉佩是父亲的遗物',
      '不得说破：\n- 债主是钱四的表兄',
    ]) {
      expect(text).toContain(part);
    }
    expect(text).not.toContain('默认两个人物');
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

  it('导演提示词只含全局局面与张力曲线，不含任何角色的认知、角色卡、秘密与场景元信息', () => {
    const state = { ...initialState(canary, 1), round: 3 };
    const text = fullText(
      unwrap(renderDirectorProposal({ scene: canary, state, recent: [], tensionCurve: '前三轮蓄势，第五轮爆发', maxRounds: 8 })),
    );
    expect(text).toContain('前三轮蓄势，第五轮爆发');
    expect(text).toContain('office_open（现在为 false）');
    // 场景有标记时须写明 setFlags 每项的格式（M0-13 第二轮中导演连续写错格式而暂停）。
    expect(text).toContain('每项形如 {"flag": "标记", "value": true}');
    // 物品位置属于全局局面，导演可以看到；角色卡与认知、秘密、场景元信息不可以。
    expect(text).toContain(`${CANARY}-ITEM-letter`);
    for (const marker of [`${CANARY}-CARD-`, `${CANARY}-SECRET-`, `${CANARY}-META-`]) expect(text).not.toContain(marker);
  });

  it('导演看不到耳语的内容：只知道有人耳语，免得写进外部事件、经感知进入别人的认知', () => {
    const state = { ...initialState(canary, 1), round: 3 };
    const [a, b] = canary.actors.map((x) => x.id);
    const zone = canary.zones[0]!.id;
    const speak = (id: string, volume: 'whisper' | 'normal', text: string) => ({
      id,
      kind: 'speak' as const,
      actor: a!,
      participants: [a!],
      zones: [zone],
      visible: true,
      loudness: 1,
      target: b!,
      speech: { sentences: [text], volume },
    });
    const text = fullText(
      unwrap(
        renderDirectorProposal({
          scene: canary,
          state,
          recent: [{ round: 3, occurrences: [speak('3:0', 'whisper', `${CANARY}-WHISPER`), speak('3:1', 'normal', '大家都听得见')] }],
          tensionCurve: '平稳',
          maxRounds: 8,
        }),
      ),
    );
    expect(text).not.toContain(`${CANARY}-WHISPER`);
    expect(text).toContain('大家都听得见');
  });

  it('僵局判断只含各人的当前目标，不含角色卡的其他内容、认知与秘密', () => {
    const text = fullText(unwrap(renderStalemateJudgement(canary, [])));
    for (const a of canary.actors) expect(text).toContain(`${CANARY}-CARD-${a.id}-goal`);
    expect(text).not.toMatch(/CANARY-CARD-[a-z_]+-(bottomLine|trait|risk|emotion|lossOfControl|speech|k\d)/);
    expect(text).not.toContain(`${CANARY}-SECRET-`);
    expect(text).not.toContain(`${CANARY}-META-`);
  });

  it('僵局判断说明目标互相冲突不算目标无法达成，同样的话来回说算反复拉锯', () => {
    const text = fullText(unwrap(renderStalemateJudgement(canary, [])));
    expect(text).toContain('人物的目标互相冲突是推演的前提，不是“目标已无法达成”');
    expect(text).toContain('只有局面中的事实排除了目标时，才判为 goal_unreachable');
    expect(text).toContain('同样的话来回说、没有任何新东西时，判为 circling');
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

describe('章节计划草稿（B65）', () => {
  it('写出作品大纲、人物、已有章节与伏笔、章数与字数；可选部分没有时省略', () => {
    const text = fullText(
      unwrap(
        renderPlanDraft({
          title: '当铺夜谈',
          genre: '古代市井',
          synopsis: '',
          outline: '林舟深夜当玉，掌柜起疑；三章后真相揭晓。',
          characters: [
            { name: '林舟', description: '落魄书生，急需用钱' },
            { name: '钱四', description: '' },
          ],
          skills: [],
          chapters: ['第一章 夜叩'],
          foreshadows: [{ title: '玉佩的来历', content: '掌柜多看了一眼', reveal: '玉佩是仿品' }],
          chapterCount: 5,
          wordsPerChapter: 3000,
        }),
      ),
    );
    expect(text).toContain('拆成 5 章');
    expect(text).toContain('约 3000 字');
    expect(text).toContain('作品：当铺夜谈（古代市井）');
    expect(text).not.toContain('简介：');
    expect(text).toContain('人物：\n- 林舟：落魄书生，急需用钱\n- 钱四\n');
    expect(text).not.toContain('规划技能');
    expect(text).toContain('已有的章节：第一章 夜叩；');
    expect(text).toContain('- 玉佩的来历：掌柜多看了一眼（揭晓：玉佩是仿品）');
    const empty = fullText(
      unwrap(renderPlanDraft({ title: 't', genre: '', synopsis: '', outline: 'o', characters: [], skills: [], chapters: [], foreshadows: [], chapterCount: 1, wordsPerChapter: 2000 })),
    );
    expect(empty).toContain('还没有人物设定');
    expect(empty).not.toContain('已有的章节：');
    expect(empty).not.toContain('已有的伏笔：');
    expect(empty).not.toContain('已有的卷：');
  });

  it('分卷（B68）：要求 10 章及以上时按故事的大段落分卷并列出各卷梗概；已有的卷沿用卷名', () => {
    const text = fullText(
      unwrap(renderPlanDraft({ title: 't', genre: '', synopsis: '', outline: 'o', characters: [], skills: [], chapters: [], volumes: ['第一卷 雨夜'], foreshadows: [], chapterCount: 30, wordsPerChapter: 3000 })),
    );
    expect(text).toContain('30 章在 10 章及以上时');
    expect(text).toContain('每章的 volume 写它所在的卷名');
    expect(text).toContain('已有的卷：第一卷 雨夜；');
    expect(text).toContain('作品已有卷时沿用已有的卷名');
  });

  it('续写一卷（B82）：只给新的一卷拆章，列出本卷要回收的伏笔并要求各安排到本卷的某一章；没有时不出现', () => {
    const base = { title: 't', genre: '', synopsis: '', outline: 'o', characters: [], skills: [], chapters: ['第一章 夜叩'], foreshadows: [], chapterCount: 2, wordsPerChapter: 2000 } as const;
    const recent = [{ title: '第一章 夜叩', summary: '林舟当玉。' }];
    const text = fullText(unwrap(renderPlanDraft({ ...base, appendVolume: { title: '第二卷 归乡', summary: '回乡寻亲。', recent, payoffs: ['玉佩的来历', '父亲的信'] } })));
    expect(text).toContain('只给新的一卷“第二卷 归乡”拆 2 章');
    expect(text).toContain('已有的章节（最后几章）：第一章 夜叩；');
    expect(text).toContain('本卷要回收的伏笔：玉佩的来历；父亲的信；');
    expect(text).toContain('卷纲定下本卷要回收的伏笔，每一条都要在本卷的某一章回收');
    const bare = fullText(unwrap(renderPlanDraft({ ...base, appendVolume: { title: '第二卷 归乡', summary: '回乡寻亲。', recent } })));
    expect(bare).toContain('只给新的一卷“第二卷 归乡”拆 2 章');
    expect(bare).not.toContain('本卷要回收的伏笔');
    expect(bare).not.toContain('卷纲定下本卷要回收的伏笔');
    const empty = fullText(unwrap(renderPlanDraft({ ...base, appendVolume: { title: '第二卷 归乡', summary: '回乡寻亲。', recent, payoffs: [] } })));
    expect(empty).not.toContain('本卷要回收的伏笔');
  });

  it('分卷方式（B78）：不分卷、指定卷数、自动三种写法；逐卷拆章时带上全书分卷与本卷之后有没有卷', () => {
    const base = { title: 't', genre: '', synopsis: '', outline: 'o', characters: [], skills: [], chapters: [], foreshadows: [], chapterCount: 8, wordsPerChapter: 2000 } as const;
    const none = fullText(unwrap(renderPlanDraft({ ...base, volumeMode: 'none' })));
    expect(none).toContain('分卷：不分卷');
    expect(none).not.toContain('10 章及以上时');
    const fixed = fullText(unwrap(renderPlanDraft({ ...base, chapterCount: 25, volumeMode: 'fixed', volumeCount: 3, volumeChapters: 9 })));
    expect(fixed).toContain('把 25 章分成 3 卷（前面各卷 9 章');
    expect(fixed).not.toContain('10 章及以上时');
    const auto = fullText(unwrap(renderPlanDraft({ ...base, chapterCount: 25 })));
    expect(auto).toContain('25 章在 10 章及以上时');
    const bookVolumes = [
      { title: '第一卷 当铺', summary: '当铺的事。' },
      { title: '第二卷 归乡', summary: '回乡。' },
    ];
    const middle = fullText(unwrap(renderPlanDraft({ ...base, chapterCount: 20, appendVolume: { title: '第一卷 当铺', summary: '当铺的事。', recent: [], bookVolumes, laterVolumes: true } })));
    expect(middle).toContain('全书分卷：\n- 第一卷 当铺：当铺的事。\n- 第二卷 归乡：回乡。');
    expect(middle).toContain('本卷之后还有卷：结尾要给下一卷留下钩子');
    expect(middle).not.toContain('本卷是最后一卷');
    const last = fullText(unwrap(renderPlanDraft({ ...base, appendVolume: { title: '第二卷 归乡', summary: '回乡。', recent: [], bookVolumes, laterVolumes: false } })));
    expect(last).toContain('本卷是最后一卷，要写到大纲的结局');
    const plain = fullText(unwrap(renderPlanDraft({ ...base, appendVolume: { title: '第二卷 归乡', summary: '回乡。', recent: [] } })));
    expect(plain).not.toContain('全书分卷');
  });

  it('规划技能（B75）：列出启用的技能与适用说明，视角人物写在详略说明的开头', () => {
    const skill = { name: '雪花写作法', description: '雪花写作法：从一句话的故事逐层展开。生成章节计划时使用。', text: '每章写明视角人物。' };
    const text = fullText(
      unwrap(renderPlanDraft({ title: 't', genre: '', synopsis: '', outline: 'o', characters: [], skills: [skill], chapters: [], foreshadows: [], chapterCount: 3, wordsPerChapter: 3000 })),
    );
    expect(text).toContain('规划技能（作者选用的方法');
    expect(text).toContain('【雪花写作法】适用：从一句话的故事逐层展开。生成章节计划时使用。\n每章写明视角人物。');
    expect(text).toContain('写在详略说明（treatment）的开头');
  });
});

describe('作品骨架（B67 快速成书）', () => {
  it('写出作者的想法、类型、作品名、已有人物、章数与字数，要求带结构化输出；可选部分没有时省略', () => {
    const prompt = unwrap(renderBookSeed({ idea: '落魄书生当铺夜遇旧主', genre: '古风悬疑', title: '当铺夜谈', characters: ['林舟'], skills: [], chapterCount: 12, wordsPerChapter: 3000 }));
    expect(prompt).toMatchObject({ template: { id: 'book_seed' }, task: 'plan_draft', output: { name: 'BookSeedOutput' } });
    const text = fullText(prompt);
    for (const part of ['作者的想法：落魄书生当铺夜遇旧主', '类型：古风悬疑', '作品名：当铺夜谈', '已有的人物：林舟；', '约 12 章、每章约 3000 字', '计划写 12 章']) expect(text).toContain(part);
    const bare = fullText(unwrap(renderBookSeed({ idea: '雨夜道歉', genre: '', title: '', characters: [], skills: [], chapterCount: 5, wordsPerChapter: 2000 })));
    for (const part of ['类型：', '作品名：', '已有的人物：', '规划技能']) expect(bare).not.toContain(part);
  });

  it('规划技能（B75）：启用的技能写在系统提示里，输出要求优先', () => {
    const skill = { name: '雪花写作法', description: '雪花写作法：生成作品骨架时使用。', text: '用一句话说清整个故事。' };
    const prompt = unwrap(renderBookSeed({ idea: '雨夜道歉', genre: '', title: '', characters: [], skills: [skill], chapterCount: 5, wordsPerChapter: 2000 }));
    const system = prompt.system.map((s) => s.text).join('\n');
    expect(system).toContain('与上面的输出要求冲突时，以输出要求为准');
    expect(system).toContain('【雪花写作法】适用：生成作品骨架时使用。\n用一句话说清整个故事。');
  });
});

describe('写手成章（B59）', () => {
  const base = {
    title: '当铺夜谈',
    genre: '古代市井',
    chapterTitle: '第二章 夜雨',
    goal: '林舟另寻门路',
    treatment: '奔走略写，对峙展开',
    skills: [
      { name: '章末钩子', description: '章末钩子：写每一章的结尾时使用。', text: '结尾停在未解的问题上。' },
      { name: '对话', description: '', text: '每人一种腔调。' },
    ],
    avoidPhrases: ['不禁', '仿佛'],
    cast: [
      { name: '林舟', description: '落魄书生', state: '玉还在手里，欠着三天后到期的赌债' },
      { name: '钱四', description: '', state: '' },
    ],
    facts: ['林舟欠下赌债'],
    memories: [{ title: '第一章 夜叩', summary: '林舟当玉被压价' }],
    toPlant: [{ title: '债主', content: '巷口有人盯梢' }],
    toPayoff: [{ title: '玉佩的来历', content: '掌柜多看了一眼', reveal: '玉佩是父亲的遗物', progress: ['第一章 夜叩：钱四盯着玉佩的缺口看了很久'] }],
    mustNotReveal: ['债主是钱四的表兄'],
    beatsBefore: ['雨中奔走'],
    beatsNow: ['再访当铺', '对峙'],
    beatsAfter: ['离开'],
    previousEnding: '门在他身后合上了。',
    written: '雨下了一夜。',
    words: 1500,
    isLast: false,
  };

  it('写出技能、规避词、人物、事实、前文、伏笔、不得说破的内容与情节点的进度', () => {
    const prompt = unwrap(renderWriterChapter(base));
    expect(prompt.task).toBe('writer');
    expect(prompt.output).toBeUndefined();
    const text = fullText(prompt);
    for (const part of [
      // 适用说明开头的“名称：”去掉；没有说明的技能只写名称与指令。
      '【章末钩子】适用：写每一章的结尾时使用。\n结尾停在未解的问题上。',
      '【对话】\n每人一种腔调。',
      '不要使用这些说法：“不禁”“仿佛”',
      '- 林舟：落魄书生（最近的状态：玉还在手里，欠着三天后到期的赌债）',
      '- 钱四\n',
      '  前文中的进展：第一章 夜叩：钱四盯着玉佩的缺口看了很久；',
      '- 林舟欠下赌债',
      '- 第一章 夜叩：林舟当玉被压价',
      '- 债主：巷口有人盯梢',
      '- 玉佩的来历：前文埋下的是“掌柜多看了一眼”，本章揭晓：玉佩是父亲的遗物',
      '不得说破：\n- 债主是钱四的表兄',
      '- （已写）雨中奔走\n- （这次写）再访当铺\n- （这次写）对峙\n- （以后写）离开',
      '上一章的结尾：\n门在他身后合上了。',
      '本章已经写到这里：\n雨下了一夜。',
      '请接着写标为“这次写”的情节点，约 1500 字。这不是本章的结尾',
    ]) {
      expect(text).toContain(part);
    }
  });

  it('没有的部分整段省略；最后一段要求写到本章结束；没有情节点时按本章目标写', () => {
    const text = fullText(
      unwrap(
        renderWriterChapter({ ...base, skills: [], avoidPhrases: [], cast: [], facts: [], memories: [], toPlant: [], toPayoff: [], mustNotReveal: [], beatsBefore: [], beatsNow: [], beatsAfter: [], previousEnding: '', written: '', isLast: true }),
      ),
    );
    for (const absent of ['写作技能：', '不要使用这些说法', '出场人物：', '已确认的事实：', '前文梗概：', '要埋的伏笔', '要回收的伏笔', '不得说破', '本章的情节点：', '上一章的结尾', '本章已经写到这里', '本卷']) {
      expect(text).not.toContain(absent);
    }
    expect(text).toContain('请接着写本章的正文，达成本章目标，约 1500 字。这是本章的最后一段，写到本章结束。');
  });

  it('本章在某一卷里时写出卷名与本卷梗概（B68）；卷没有梗概时只写卷名', () => {
    const text = fullText(unwrap(renderWriterChapter({ ...base, volume: { title: '第一卷 雨夜', summary: ' 林舟当玉，引出旧主。 ' } })));
    expect(text).toContain('本卷：第一卷 雨夜\n本卷梗概：林舟当玉，引出旧主。\n本章：');
    const bare = fullText(unwrap(renderWriterChapter({ ...base, volume: { title: '第一卷 雨夜', summary: '' } })));
    expect(bare).toContain('本卷：第一卷 雨夜\n本章：');
    expect(bare).not.toContain('本卷梗概');
  });

  it('认知层（B59 补充）：各人知道或相信的写在人物下面，不在场的章合成一句；有认知层时要求人物只依据自己知道的说话与行动；都没有时省略', () => {
    const text = fullText(
      unwrap(
        renderWriterChapter({
          ...base,
          cast: [
            {
              name: '林舟',
              description: '落魄书生',
              state: '',
              knows: [
                { text: '钱四认得这块玉', kind: 'belief', modality: 'inferred', confidence: 0.6 },
                { text: '玉是父亲留下的', kind: 'belief', modality: 'observed', confidence: 1 },
                { text: '玉是捡来的', kind: 'claim', modality: 'claimed', confidence: null },
              ],
              absent: [],
            },
            { name: '钱四', description: '', state: '', knows: [], absent: ['第一章 夜叩（林舟当玉被压价）', '第三章 天明（林舟中举）'] },
          ],
        }),
      ),
    );
    expect(text).toContain('- 林舟：落魄书生\n  知道或相信的：推测：钱四认得这块玉（相信程度 0.6）；亲身经历：玉是父亲留下的；说过：玉是捡来的；\n- 钱四\n  不在场、前文没写他得知：第一章 夜叩（林舟当玉被压价）、第三章 天明（林舟中举）\n');
    expect(text).toContain('- 人物只依据自己知道的说话与行动');
    const plain = fullText(unwrap(renderWriterChapter(base)));
    expect(plain).not.toContain('知道或相信的');
    expect(plain).not.toContain('人物只依据自己知道的说话与行动');
  });

  it('人物关系（B73）写在出场人物之后；单向读作“甲是乙的…”，双向读作“甲与乙：…”；有隐秘关系时要求不要点明；没有关系时省略', () => {
    const text = fullText(
      unwrap(
        renderWriterChapter({
          ...base,
          relations: [
            { from: '钱四', to: '林舟', label: '债主', mutual: false, description: ' 林舟欠他三百两 ', secret: false },
            { from: '林舟', to: '阿青', label: '旧识', mutual: true, description: '', secret: false },
            { from: '钱四', to: '阿青', label: '生父', mutual: false, description: '', secret: true },
          ],
        }),
      ),
    );
    expect(text).toContain('人物关系：\n- 钱四是林舟的债主（林舟欠他三百两）\n- 林舟与阿青：旧识\n- 钱四是阿青的生父〔隐秘〕\n');
    expect(text.indexOf('出场人物：')).toBeLessThan(text.indexOf('人物关系：'));
    expect(text).toContain('标为“隐秘”的人物关系读者还不知道');
    const plain = fullText(unwrap(renderWriterChapter({ ...base, relations: [{ from: '林舟', to: '阿青', label: '旧识', mutual: true, description: '', secret: false }] })));
    expect(plain).not.toContain('隐秘');
    const none = fullText(unwrap(renderWriterChapter(base)));
    expect(none).not.toContain('人物关系');
  });
});

describe('长篇记忆（B66）', () => {
  it('写出正文、人物与伏笔，要求结构化输出；没有人物与伏笔时省略', () => {
    const prompt = unwrap(
      renderChapterMemory({
        title: '当铺夜谈',
        chapterTitle: '第一章 夜叩',
        characters: ['林舟', '钱四'],
        foreshadows: [
          { title: '玉佩的来历', content: '掌柜多看了一眼', reveal: '玉佩是父亲的遗物' },
          { title: '巷口的人', content: '有人盯梢', reveal: '' },
        ],
        text: '林舟叩响了当铺的门。',
      }),
    );
    expect(prompt.task).toBe('memory');
    expect(prompt.output?.name).toBe('ChapterMemoryOutput');
    const text = fullText(prompt);
    for (const part of ['300 字以内', '作品：《当铺夜谈》', '章节：第一章 夜叩', '人物：林舟；钱四；', '- 玉佩的来历：掌柜多看了一眼（揭晓的内容：玉佩是父亲的遗物）', '- 巷口的人：有人盯梢\n', '正文：\n林舟叩响了当铺的门。']) {
      expect(text).toContain(part);
    }
    const bare = fullText(unwrap(renderChapterMemory({ title: 't', chapterTitle: 'c', characters: [], foreshadows: [], text: '正文。' })));
    expect(bare).not.toContain('人物：');
    expect(bare).not.toContain('伏笔：\n');
  });
});

describe('审核（B64）', () => {
  const base = {
    title: '当铺夜谈',
    chapterTitle: '第二章 夜雨',
    entities: [
      { label: 'E1', name: '林舟', kind: '人物', locked: true, description: '落魄书生，左手有伤', state: '玉还在手里' },
      { label: 'E2', name: '当铺', kind: '地点', locked: false, description: '', state: '' },
    ],
    facts: [{ label: 'F1', content: '林舟欠下赌债' }],
    memories: [{ title: '第一章 夜叩', summary: '林舟当玉被压价' }],
    plan: { goal: '林舟再访当铺', treatment: '全章用林舟的视角', cast: ['林舟', '钱四'], beats: ['叩门', '对峙'] },
    foreshadows: [
      { label: 'S1', title: '玉佩的来历', role: '不得说破', content: '掌柜多看了一眼', reveal: '玉佩是父亲的遗物' },
      { label: 'S2', title: '巷口的人', role: '本章要埋', content: '有人盯梢', reveal: '' },
    ],
    paragraphs: [
      { label: 'P1', text: '林舟又叩响了门。' },
      { label: 'P2', text: '钱四没有抬头。' },
    ],
  };

  it('列出带标签的设定、事实、伏笔、章节计划与正文段落，要求结构化输出', () => {
    const prompt = unwrap(renderChapterReview(base));
    expect(prompt.task).toBe('review');
    expect(prompt.output?.name).toBe('ChapterReviewOutput');
    const text = fullText(prompt);
    for (const part of [
      '- [E1] 林舟（人物，锁定）：落魄书生，左手有伤（前文中最近的状态：玉还在手里）',
      '- [E2] 当铺（地点）\n',
      '- [F1] 林舟欠下赌债',
      '- 第一章 夜叩：林舟当玉被压价',
      '章节计划 [plan]：\n本章目标：林舟再访当铺\n详略与写法：全章用林舟的视角\n出场人物：林舟；钱四；\n情节点：\n- 叩门\n- 对峙',
      '- [S1] 玉佩的来历（不得说破）：掌柜多看了一眼；揭晓的内容：玉佩是父亲的遗物',
      '- [S2] 巷口的人（本章要埋）：有人盯梢\n',
      '正文：\n[P1] 林舟又叩响了门。\n[P2] 钱四没有抬头。',
    ]) {
      expect(text).toContain(part);
    }
  });

  it('没有计划、设定、事实、伏笔与前文时整段省略', () => {
    const text = fullText(unwrap(renderChapterReview({ ...base, entities: [], facts: [], memories: [], plan: null, foreshadows: [] })));
    for (const absent of ['设定：\n', '已确认的事实：', '前文梗概：', '章节计划 [plan]', '伏笔：\n']) expect(text).not.toContain(absent);
    expect(text).toContain('[P1] 林舟又叩响了门。');
  });
});

describe('写手修订（B64）', () => {
  it('写出要修订的段落、前后段、问题、依据、规避词与不得说破的内容；输出纯文本', () => {
    const prompt = unwrap(
      renderWriterRevise({
        title: '当铺夜谈',
        chapterTitle: '第二章 夜雨',
        avoidPhrases: ['不禁'],
        evidence: ['设定 林舟：落魄书生，左手有伤'],
        mustNotReveal: ['玉佩是父亲的遗物'],
        before: '林舟又叩响了门。',
        paragraph: '他用左手稳稳接过茶盏，不禁笑了。',
        after: '钱四没有抬头。',
        issues: [
          { quote: '左手稳稳接过茶盏', description: '林舟左手有伤，接不稳茶盏', suggestion: '改用右手' },
          { quote: '', description: '这一段没有推进情节', suggestion: '' },
        ],
      }),
    );
    expect(prompt.task).toBe('writer');
    expect(prompt.output).toBeUndefined();
    const text = fullText(prompt);
    for (const part of [
      '不要使用这些说法：“不禁”',
      '依据：\n- 设定 林舟：落魄书生，左手有伤',
      '不得说破：\n- 玉佩是父亲的遗物',
      '前一段：\n林舟又叩响了门。',
      '要修订的段落：\n他用左手稳稳接过茶盏，不禁笑了。',
      '后一段：\n钱四没有抬头。',
      '- “左手稳稳接过茶盏”：林舟左手有伤，接不稳茶盏（建议：改用右手）',
      '- 这一段没有推进情节\n',
    ]) {
      expect(text).toContain(part);
    }
    const bare = fullText(
      unwrap(renderWriterRevise({ title: 't', chapterTitle: 'c', avoidPhrases: [], evidence: [], mustNotReveal: [], before: '', paragraph: '一段。', after: '', issues: [{ quote: '', description: '问题', suggestion: '' }] })),
    );
    for (const absent of ['不要使用这些说法', '依据：', '不得说破', '前一段：', '后一段：']) expect(bare).not.toContain(absent);
  });
});


describe('全书体检的模板（B80）', () => {
  it('book_audit：设定、关系、事实是不变的部分，各章要点按标签列出，输出疑点', () => {
    const prompt = unwrap(
      renderBookAudit({
        title: '当铺夜谈',
        entities: [{ name: '钱四', kind: '人物', locked: true, description: '当铺掌柜' }],
        relations: ['钱四是林舟的债主'],
        facts: ['玉佩是林舟父亲的遗物'],
        chapters: [
          { label: 'C1', title: '第一章 夜叩', summary: '林舟当玉。', cast: [{ name: '钱四', state: '被官差带走' }], threads: ['玉佩的来历'] },
          { label: 'C2', title: '第二章 夜雨', summary: '', cast: [], threads: [] },
        ],
      }),
    );
    expect(prompt.output?.name).toBe('BookAuditOutput');
    expect(prompt.task).toBe('review');
    expect(prompt.system.some((b) => b.cache === true && b.text.includes('- 钱四（人物，锁定）：当铺掌柜') && b.text.includes('- 钱四是林舟的债主') && b.text.includes('- 玉佩是林舟父亲的遗物'))).toBe(true);
    const text = fullText(prompt);
    for (const part of ['最多 20 条', '[C1] 第一章 夜叩\n梗概：林舟当玉。\n人物在章末：钱四：被官差带走；\n章尾留下：玉佩的来历；', '[C2] 第二章 夜雨\n梗概：（没有梗概）']) expect(text).toContain(part);
  });

  it('continuity_check：只核对一处疑点，前一章的段落用 A 标签、后一章用 P 标签，较长的注明只给了开头与结尾', () => {
    const prompt = unwrap(
      renderContinuityCheck({
        title: '当铺夜谈',
        about: 'C1 钱四被带走，C2 他却在柜台后',
        entities: [{ label: 'E1', name: '钱四', kind: '人物', locked: false, description: '' }],
        earlierTitle: '第一章 夜叩',
        earlier: [{ label: 'A1', text: '官差把钱四押走了。' }],
        earlierClipped: true,
        laterTitle: '第二章 夜雨',
        later: [{ label: 'P1', text: '钱四在柜台后拨着算盘。' }],
        laterClipped: false,
      }),
    );
    expect(prompt.output?.name).toBe('ChapterReviewOutput');
    const text = fullText(prompt);
    for (const part of ['只核对这一处疑点：C1 钱四被带走，C2 他却在柜台后', '- [E1] 钱四（人物）', '前一章：第一章 夜叩（较长，只给出开头与结尾）\n[A1] 官差把钱四押走了。', '后一章：第二章 夜雨\n[P1] 钱四在柜台后拨着算盘。']) {
      expect(text).toContain(part);
    }
    expect(text).not.toContain('本章：');
  });

  it('continuity_check：同一章之内的疑点只给出这一章，依据是这一章前文的段落', () => {
    const prompt = unwrap(
      renderContinuityCheck({
        title: '当铺夜谈',
        about: '玉压在枕头底下出了门，后面又从怀里摸出玉',
        entities: [],
        same: true,
        earlierTitle: '第二章 夜雨',
        earlier: [],
        earlierClipped: false,
        laterTitle: '第二章 夜雨',
        later: [
          { label: 'P1', text: '林舟把玉压在枕头底下，出了门。' },
          { label: 'P2', text: '他摸了摸怀里的玉。' },
        ],
        laterClipped: false,
      }),
    );
    const text = fullText(prompt);
    for (const part of ['一章之内的一处疑点', '这一章前文里与之矛盾的段落（P1、P2……，不能是 paragraph 那一段）', '本章：第二章 夜雨\n[P1] 林舟把玉压在枕头底下，出了门。\n[P2] 他摸了摸怀里的玉。']) expect(text).toContain(part);
    for (const part of ['前一章：', '后一章：', 'A1、A2']) expect(text).not.toContain(part);
  });
});

describe('开篇诊断的模板（B81）', () => {
  it('opening_review：写明诊断第几章、主角与程序算出的数字，正文带段落标签；主角没出现时照实写', () => {
    const base = {
      title: '当铺夜谈',
      genre: '古风悬疑',
      synopsis: '落魄书生当玉。',
      protagonist: '林舟',
      openingCount: 3,
      index: 1,
      chapterTitle: '第一章 夜叩',
      goal: '林舟当玉',
      earlier: [],
      metrics: { words: 3200, protagonistAt: 1800, dialogueRatio: 0.123, namesInOpening: 14, longestParagraph: 420 },
      paragraphs: [{ label: 'P1', text: '雨下了一夜。' }],
    };
    const prompt = unwrap(renderOpeningReview(base));
    expect(prompt.output?.name).toBe('ChapterReviewOutput');
    const text = fullText(prompt);
    for (const part of ['前 3 章', '现在诊断第 1 章', '主角（按前几章里出现的次数推断）：林舟', '本章计划的目标：林舟当玉', '本章 3,200 字；主角第一次出现在第 1,800 字之后；对白约占 12%；前一千字里出现设定名 14 次；最长的一段 420 字。', '[P1] 雨下了一夜。']) {
      expect(text).toContain(part);
    }
    const absent = fullText(unwrap(renderOpeningReview({ ...base, protagonist: '', metrics: { ...base.metrics, protagonistAt: null } })));
    expect(absent).toContain('主角在本章没有出现');
    expect(absent).not.toContain('主角（按前几章');
  });
});

describe('人物补全的模板（B83）', () => {
  it('cast_completion：人物带别名、说明与缺口，已有关系与各章梗概带标签与出场人物', () => {
    const prompt = unwrap(
      renderCastCompletion({
        title: '当铺夜谈',
        genre: '',
        characters: [{ name: '钱四', aliases: ['四爷'], description: '', gap: '说明为空' }],
        relations: ['钱四是林舟的债主'],
        chapters: [{ label: 'C1', title: '第一章', summary: '林舟当玉。', cast: ['钱四'] }],
      }),
    );
    expect(prompt.output?.name).toBe('CastCompletionOutput');
    const text = fullText(prompt);
    for (const part of ['最多列 20 个人物', '- 钱四（又名四爷）〔缺口：说明为空〕', '- 钱四是林舟的债主', '[C1] 第一章：林舟当玉。（出场：钱四）']) expect(text).toContain(part);
    expect(fullText(unwrap(renderCastCompletion({ title: 't', genre: '', characters: [], relations: [], chapters: [] })))).toContain('人物：还没有人物卡片');
  });
});

describe('人物关系变化的模板（B73 补充）', () => {
  it('relation_changes：人物带别名、说明与退场情况，现在的关系带标签，各章梗概带章末的人物状态', () => {
    const prompt = unwrap(
      renderRelationChanges({
        title: '长夜问刀',
        genre: '武侠',
        characters: [
          { name: '沈孤舟', aliases: ['沈三'], description: '刀客', status: '' },
          { name: '顾寒衣', aliases: [], description: '', status: '第 50 章退场：坠崖' },
        ],
        relations: [{ label: 'R1', text: '沈孤舟与顾寒衣：灭门仇敌', description: '顾家灭了沈家满门' }],
        chapters: [{ label: 'C1', title: '雪夜', summary: '两人约定暂时联手。', cast: ['沈孤舟：负伤'] }],
      }),
    );
    expect(prompt.output?.name).toBe('RelationChangesOutput');
    expect(prompt.task).toBe('relation_changes');
    const text = fullText(prompt);
    for (const part of ['最多列 20 条关系变化', '- 沈孤舟（又名沈三）：刀客', '- 顾寒衣〔第 50 章退场：坠崖〕', '[R1] 沈孤舟与顾寒衣：灭门仇敌：顾家灭了沈家满门', '[C1] 雪夜：两人约定暂时联手。\n  沈孤舟：负伤']) expect(text).toContain(part);
    const empty = fullText(unwrap(renderRelationChanges({ title: 't', genre: '', characters: [], relations: [], chapters: [] })));
    expect(empty).toContain('人物：还没有人物卡片');
    expect(empty).toContain('现在的关系：还没有');
  });
});

describe('扫榜拆书的模板（B79）', () => {
  it('benchmark_book：写明只写结构与技法、引文的上限，带上榜单信息与样章', () => {
    const prompt = unwrap(renderBenchmarkBook({ title: '夜当', author: '某甲', tags: '古风', words: '120 万', blurb: '落魄书生当玉。', text: '第一章 夜叩\n林舟推门。', clipped: true }));
    expect(prompt.output?.name).toBe('BenchmarkBookOutput');
    const text = fullText(prompt);
    for (const part of ['只写结构与技法', '每处引文不超过 30 字', '书名：夜当', '作者：某甲', '标签：古风', '简介：落魄书生当玉。', '样章（较长，只给出开头与结尾）：\n第一章 夜叩']) expect(text).toContain(part);
  });

  it('benchmark_compare：榜单只有书名、标签与字数，拆解一本一段，作者的想法写进要求', () => {
    const book = { title: '夜当', genre: '古风悬疑', sellingPoints: '身份反差', hook: '雨夜当玉', pacing: '第一章：亮出困境', cast: '主角：书生', conflict: '身世之谜', chapterHooks: '章末留疑问', techniques: '先抑后扬' };
    const prompt = unwrap(renderBenchmarkCompare({ rank: [{ title: '夜当', tags: '古风', words: '120 万' }], books: [book], idea: '女掌柜收旧物' }));
    expect(prompt.output?.name).toBe('BenchmarkCompareOutput');
    const text = fullText(prompt);
    for (const part of ['- 夜当（古风），120 万', '【夜当】\n题材：古风悬疑\n卖点：身份反差', '作者自己的想法：女掌柜收旧物']) expect(text).toContain(part);
  });
});

describe('全书卷纲（一键成书的长篇规划）', () => {
  it('写出卷数与各卷章数、大纲、人物与已有伏笔；要求最后一卷写到结局', () => {
    const text = fullText(
      unwrap(
        renderBookVolumes({
          title: '当铺夜谈',
          genre: '古代市井',
          synopsis: '',
          outline: '林舟当玉；真相揭晓。',
          characters: [{ name: '林舟', description: '书生' }],
          skills: [],
          foreshadows: [{ title: '玉佩', content: '多看一眼', reveal: '遗物' }],
          volumes: [20, 20, 10],
        }),
      ),
    );
    expect(text).toContain('一共 3 卷');
    expect(text).toContain('第 1 卷 20 章；第 2 卷 20 章；第 3 卷 10 章；');
    expect(text).toContain('最后一卷写到大纲的结局');
    expect(text).toContain('- 林舟：书生');
    expect(text).toContain('- 玉佩：多看一眼（揭晓：遗物）');
    expect(text).toContain('请规划全书的 3 卷');
    expect(text).not.toContain('规划技能');
  });
});
