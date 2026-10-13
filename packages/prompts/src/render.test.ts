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
  renderPlanDraft,
  renderRunSynopsis,
  renderSceneDraft,
  renderSemanticRuling,
  renderStalemateJudgement,
  renderStructuredRepair,
  renderWriterChapter,
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
    expect(prompt.template).toEqual({ id: 'character_action', version: '8' });
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

  it('证据链判断附上秘密与人物已有的线索', () => {
    const planned = planBeliefUpdate(scene, start, P, { add: [{ text: '南门恐怕有埋伏', confidence: 0.5, about: ['south_gate'] }] });
    if (!planned.ok) throw new Error('应当成功');
    const next = applyEvent(scene, start, planned.value);
    if (!next.ok) throw new Error('应当成功');
    const candidates = screenSecretInferences(scene, next.value, P, planned.value.added);
    const text = fullText(
      unwrap(renderEvidenceJudgement(buildCharacterView(scene, next.value, P), candidates, { tripwire_secret: '对手在南门布置了绊索' })),
    );
    expect(text).toContain('推测 [protagonist:1:3] 对照秘密 [tripwire_secret]：南门恐怕有埋伏');
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
          characters: ['林舟', '钱四'],
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
    expect(text).toContain('人物：林舟；钱四；');
    expect(text).toContain('已有的章节：第一章 夜叩；');
    expect(text).toContain('- 玉佩的来历：掌柜多看了一眼（揭晓：玉佩是仿品）');
    const empty = fullText(
      unwrap(renderPlanDraft({ title: 't', genre: '', synopsis: '', outline: 'o', characters: [], chapters: [], foreshadows: [], chapterCount: 1, wordsPerChapter: 2000 })),
    );
    expect(empty).toContain('还没有人物设定');
    expect(empty).not.toContain('已有的章节：');
    expect(empty).not.toContain('已有的伏笔：');
  });
});

describe('写手成章（B59）', () => {
  const base = {
    title: '当铺夜谈',
    genre: '古代市井',
    chapterTitle: '第二章 夜雨',
    goal: '林舟另寻门路',
    treatment: '奔走略写，对峙展开',
    skills: [{ name: '章末钩子', text: '结尾停在未解的问题上。' }],
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
      '【章末钩子】结尾停在未解的问题上。',
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
    for (const absent of ['写作技能：', '不要使用这些说法', '出场人物：', '已确认的事实：', '前文梗概：', '要埋的伏笔', '要回收的伏笔', '不得说破', '本章的情节点：', '上一章的结尾', '本章已经写到这里']) {
      expect(text).not.toContain(absent);
    }
    expect(text).toContain('请接着写本章的正文，达成本章目标，约 1500 字。这是本章的最后一段，写到本章结束。');
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
