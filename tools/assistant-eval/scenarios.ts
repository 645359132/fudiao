// AI 助手试用的几组对话（M5-24，ASSISTANT_REVIEW.md 第五节第 10 项）：默认的一串之外，覆盖打开已有的大部头作品、
// 分卷、选区修改、续写、导出、拒绝确认、撤销，以及网络中断与模型输出不合格时的重试与修正。
// 作品由 prepare 直接经应用服务层建好（不调用模型）；故障在模型端口上注入，与服务种类无关。
import { err, ok, type Result } from '@fudiao/shared';
import type { AppDeps } from '../../apps/desktop/src/app/ports';
import type { AppService } from '../../apps/desktop/src/app/service';
import { DEFAULT_TURNS, type Turn } from './scenario';

type LlmPort = ReturnType<AppDeps['llm']['forProvider']>;

/** 在第几次助手请求上注入故障（从 1 数起）：network 为连接中断（调用器会整次重试），invalid 为一次不合格的输出（结构化管线会请求修正）。 */
export type FaultPlan = Readonly<Record<number, 'network' | 'invalid'>>;

export type Scenario = {
  readonly key: string;
  readonly title: string;
  readonly turns: readonly Turn[];
  /** 对话之前建好作品（不调用模型）；没有时从空的作品库开始。 */
  readonly prepare?: (app: AppService) => Promise<Result<void, string>>;
  readonly faults?: FaultPlan;
  /** 偏高的用量估计（Token），运行前据此显示预计费用。 */
  readonly estimate: { readonly input: number; readonly output: number };
};

const value = <T>(r: Result<T, unknown>, what: string): Result<T, string> => (r.ok ? r : err(`${what}：${JSON.stringify(r.error)}`));

/** 一部写到一半的大部头：两卷、120 章（每章一小段正文）、60 个人物与若干关系、很长的大纲。 */
async function longWork(app: AppService): Promise<Result<void, string>> {
  const created = value(await app.createWork('长河夜渡'), '作品没有建好');
  if (!created.ok) return created;
  const outline = Array.from({ length: 40 }, (_, i) => `第${i + 1}段：渡口的第${i + 1}个夜晚，船夫与查案的捕快各怀心事，旧账一笔笔翻出来。`).join('\n');
  const info = value(await app.updateWorkInfo({ genre: '古风悬疑', synopsis: '渡口船夫卷进十年前的沉船旧案。', outline }), '作品信息没有保存');
  if (!info.ok) return info;
  for (const title of ['第一卷 渡口', '第二卷 沉船']) {
    const v = value(await app.createVolume(title), '卷没有建好');
    if (!v.ok) return v;
  }
  const work = value(await app.reloadWork(), '作品没有载入');
  if (!work.ok) return work;
  const [first, second] = work.value.volumes;
  for (let i = 1; i <= 120; i++) {
    const made = value(await app.createChapter(`第${i}章 夜渡其${i}`, undefined, (i <= 60 ? first : second)?.id ?? null), '章节没有建好');
    if (!made.ok) return made;
    const chapter = made.value.chapters.find((c) => c.title === `第${i}章 夜渡其${i}`);
    if (chapter === undefined) return err('章节没有建好');
    const opened = value(await app.openChapter(chapter.id), '章节没有打开');
    if (!opened.ok) return opened;
    const saved = value(await app.saveChapter(chapter.id, opened.value.saved, [{ id: `p${i}`, text: `第${i}夜，船夫老周把灯挂上桅杆，雾很大。`, source: 'handwritten' }], { splits: [], merges: [] }), '正文没有保存');
    if (!saved.ok) return saved;
  }
  const ids: string[] = [];
  for (let i = 1; i <= 60; i++) {
    const e = value(await app.createEntity('character', i === 1 ? '老周' : i === 2 ? '沈捕快' : `渡客${i}号`), '人物没有建好');
    if (!e.ok) return e;
    ids.push(e.value.created.id);
  }
  for (let i = 2; i < 30; i++) {
    const r = value(
      await app.addRelationship({ fromId: ids[0]!, toId: ids[i]!, category: i === 2 ? 'enemy' : 'other', label: i === 2 ? '宿敌' : '熟客', mutual: i === 2, description: '', secret: false, validFromChapterId: null, validToChapterId: null }),
      '关系没有建好',
    );
    if (!r.ok) return r;
  }
  return ok(undefined);
}

/** 一部只有一章、已有正文与一个设定的作品（选区修改、续写、导出与删除用）。 */
async function smallWork(app: AppService): Promise<Result<void, string>> {
  const created = value(await app.createWork('当铺夜谈'), '作品没有建好');
  if (!created.ok) return created;
  const made = value(await app.createChapter('第一章 夜叩'), '章节没有建好');
  if (!made.ok) return made;
  const chapter = made.value.chapters[0]!;
  const opened = value(await app.openChapter(chapter.id), '章节没有打开');
  if (!opened.ok) return opened;
  const paragraphs = [
    '雨下得很大，林舟站在当铺门口，犹豫了很久很久，终于还是慢慢地抬起手，轻轻地敲了三下门。',
    '门开了一条缝，掌柜钱四探出半张脸，眯着眼打量他。',
    '“当什么？”钱四问。林舟从怀里摸出一块玉佩，玉上有一道细细的裂纹。',
  ];
  const saved = value(await app.saveChapter(chapter.id, opened.value.saved, paragraphs.map((text, i) => ({ id: `p${i}`, text, source: 'handwritten' as const })), { splits: [], merges: [] }), '正文没有保存');
  if (!saved.ok) return saved;
  const e = value(await app.createEntity('character', '钱四'), '人物没有建好');
  return e.ok ? ok(undefined) : e;
}

export const SCENARIOS: readonly Scenario[] = [
  {
    key: 'default',
    title: '开新书到写完三章（默认）',
    turns: DEFAULT_TURNS,
    estimate: { input: DEFAULT_TURNS.length * 3 * 15_000 + 3 * 40_000, output: DEFAULT_TURNS.length * 3 * 3_000 + 3 * 25_000 },
  },
  {
    key: 'long-work',
    title: '打开已有的大部头：分卷、长目录、长大纲与关系网',
    prepare: longWork,
    turns: [
      { say: '这本书现在写到哪了？一共多少章、多少字？两卷各讲什么？', expect: ['get_work'] },
      { say: '大纲第 37 段讲的是什么？', expect: ['get_work'] },
      { say: '老周的宿敌是谁？', expect: [] },
      { say: '第二卷的简介还空着，按大纲帮我写一段。', expect: ['update_volume'] },
      { say: '把第 75 章改名为“第75章 雾里灯”，再把它移到第一卷的末尾。', expect: ['update_chapter', 'move_chapter'] },
    ],
    estimate: { input: 5 * 3 * 40_000, output: 5 * 3 * 3_000 },
  },
  {
    key: 'edit-and-export',
    title: '选区修改、续写、导出与拒绝确认',
    prepare: smallWork,
    turns: [
      { say: '这段太啰嗦了，帮我改紧凑一点。', expect: ['edit_selection'], select: { chapter: '第一章 夜叩', text: '雨下得很大，林舟站在当铺门口，犹豫了很久很久，终于还是慢慢地抬起手，轻轻地敲了三下门。' } },
      { say: '第一章接着往下写一段，写钱四怎么压价。', expect: ['continue_chapter'] },
      { say: '把第一章导出成 txt。', expect: ['export_book'] },
      { say: '把钱四这个人物删了吧。', expect: ['delete_entity'], approve: false },
      { say: '新建一章“第二章 压价”，再给它存个快照。', expect: ['create_chapter', 'save_snapshot'] },
      { say: '撤销刚才的。', expect: ['undo_last_turn'] },
    ],
    estimate: { input: 6 * 3 * 15_000 + 2 * 10_000, output: 6 * 3 * 3_000 + 2 * 3_000 },
  },
  {
    key: 'faults',
    title: '网络中断与输出不合格：调用器整次重试，结构化管线请求修正',
    prepare: smallWork,
    // 第 1 次助手请求连接中断（自动重试）；第 3 次给出不合格的输出（请求修正）。
    faults: { 1: 'network', 3: 'invalid' },
    turns: [
      { say: '第一章写了什么？', expect: ['read_chapter'] },
      { say: '给钱四写一段人物说明：五十来岁，精明，怕事。', expect: ['update_entity'] },
    ],
    estimate: { input: 6 * 15_000, output: 6 * 3_000 },
  },
];

export const scenarioByKey = (key: string): Scenario | undefined => SCENARIOS.find((s) => s.key === key);

/**
 * 在模型端口上按计划注入故障：只数 AI 助手的请求（task 为 assistant，修正请求不算新的一次），其余照常转发。
 * network 时不发出请求、返回连接中断；invalid 时不发出请求、返回一段不合格的输出（用量记为空）。
 */
export function withFaults(port: LlmPort, plan: FaultPlan, log: (line: string) => void): LlmPort {
  let count = 0;
  /** 刚注入了连接中断：下一次是调用器的重试，仍算同一次请求、不再注入。 */
  let retrying = false;
  return {
    async complete(request, options) {
      if (request.task !== 'assistant' || request.repairOf !== undefined) return port.complete(request, options);
      const fault = retrying ? undefined : plan[++count];
      retrying = fault === 'network';
      if (fault === 'network') {
        log(`  [故障] 第 ${count} 次助手请求：连接中断`);
        return err({ code: 'network' as const, message: '注入的故障：读到一半连接断了' });
      }
      if (fault === 'invalid') {
        log(`  [故障] 第 ${count} 次助手请求：不合格的输出`);
        return ok({ outcome: 'completed', text: '{"message": "好的", "actions": "没有动作"}', usage: null, provider: request.model.provider, servedModel: request.model.model, stopReason: 'stop', fallbackUsed: false, requestHash: 'fault' });
      }
      return port.complete(request, options);
    },
  };
}
