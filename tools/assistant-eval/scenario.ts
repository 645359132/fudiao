// AI 助手的真实模型试用（M5-15 之后作者要求“试一下”）：按一串作者会说的话依次和助手对话，
// 记下每一步助手说了什么、给了哪些动作、结果如何，写成报告由人阅读判断。只经应用服务层的用例。
// 须确认的动作按每句话的设定同意或拒绝；写作、审核与修订交给这里实现的后台，和桌面端一样立即返回。
import type { AssistantItem } from '../../apps/desktop/src/app/assistant';
import type { AssistantSelection, BackgroundJobs } from '../../apps/desktop/src/app/assistant-tools';
import type { AppService } from '../../apps/desktop/src/app/service';

type Tool = Extract<AssistantItem, { role: 'assistant' }>['output']['actions'][number]['tool'];

/** 作者的一句话：期望助手用到的动作（只用于报告里的提示，不判定对错）；须确认时是否同意；说之前是否等后台做完。 */
export type Turn = {
  readonly say: string;
  readonly expect?: readonly Tool[];
  readonly approve?: boolean;
  readonly waitBackground?: boolean;
  /** 说这句话时作者在正文里选中的文字（这一章里第一处与它相同的地方）。 */
  readonly select?: { readonly chapter: string; readonly text: string };
};

/** 默认的一串话：开新书、建人物与关系、计划、写一章、审核与处理问题、问前文与伏笔、偏好与技能、后台写作与停下、删除须确认。 */
export const DEFAULT_TURNS: readonly Turn[] = [
  { say: '帮我开一本新书，古风悬疑，讲一个小当铺的掌柜被卷进二十年前的一桩旧案。先把三个主要人物建起来，再把他们之间的关系理清楚。', expect: ['create_work', 'create_entity', 'add_relationship'] },
  { say: '给这本书写个简短的大纲，然后做 3 章的章节计划，每章 1500 字左右。', expect: ['update_work', 'plan_chapters'] },
  { say: '记一条伏笔：掌柜收下的那块玉佩其实是旧案死者的遗物，第一章埋下，第三章揭开。', expect: ['add_foreshadow'] },
  { say: '让写手把第一章写出来。', expect: ['write_chapter'] },
  { say: '审核一下第一章。', expect: ['review_chapter'], waitBackground: true },
  { say: '审核出来的问题里，挑最要紧的一条交给写手改掉，其余的你看着办，确实不用改的就忽略。', expect: ['list_review_issues', 'revise_review_issue'], waitBackground: true },
  { say: '第一章到底写了什么？玉佩那条伏笔埋下了吗？', expect: ['get_chapter_memory', 'list_foreshadows'], waitBackground: true },
  { say: '以后对白短一点，别让人物长篇大论。另外规划时别用雪花写作法了。', expect: ['remember_preference', 'set_skill'] },
  { say: '剩下的两章交给后台写完，写完都审核一下。', expect: ['write_chapters'] },
  { say: '现在进度怎么样了？', expect: [] },
  { say: '先停一下，别写了。', expect: ['stop_background'] },
  { say: '那接着写吧，把没写完的写完，不用审核。', expect: ['write_chapters'], waitBackground: false },
  { say: '全书写完了吗？每章大概多少字？', expect: [], waitBackground: true },
  { say: '新建一章叫“番外 旧账”，然后把它删掉吧，我改主意了。', expect: ['create_chapter', 'trash_chapter'], approve: true },
];

export type TurnRecord = {
  readonly say: string;
  readonly expect: readonly string[];
  /** 这句话之后对话里新增的条目。 */
  readonly items: readonly AssistantItem[];
  readonly used: readonly string[];
  readonly missing: readonly string[];
  readonly error: string | null;
  readonly ms: number;
};

export type Hooks = { readonly log: (line: string) => void; readonly now: () => number };

/** 和桌面端状态层一样的后台：同一时间只有一批写作、一批审核；停下时说明停了什么。 */
export function backgroundFor(app: AppService, log: (line: string) => void) {
  let writing: { abort: AbortController; current: string; done: number; total: number; queued: string[] } | null = null;
  let reviewing: { abort: AbortController; current: string; done: number; total: number } | null = null;
  let simulating: { abort: AbortController; runId: string } | null = null;
  /** 单章的写作、审核与修订（M5-23）。 */
  const single = new Set<{ readonly kind: 'writing' | 'review' | 'revise'; readonly chapterId: string; readonly title: string; readonly abort: AbortController }>();
  const pending: Promise<void>[] = [];
  const title = async (id: string) => {
    const w = await app.reloadWork();
    return w.ok ? (w.value.chapters.find((c) => c.id === id)?.title ?? id) : id;
  };

  const jobs: BackgroundJobs = {
    writeChapters(ids, review) {
      if (writing !== null) return '写手正在写，等这一批写完或停下以后再排';
      const abort = new AbortController();
      const job = { abort, current: ids[0] ?? '', done: 0, total: ids.length, queued: [...ids] };
      writing = job;
      pending.push(
        (async () => {
          for (const id of ids) {
            if (abort.signal.aborted) break;
            job.current = id;
            job.queued = ids.slice(ids.indexOf(id) + 1);
            log(`  [后台] 写《${await title(id)}》`);
            const written = await app.writeChapter(id, { signal: abort.signal });
            if (!written.ok || written.value.status !== 'written') {
              log(`  [后台] 停下：${written.ok ? written.value.status : JSON.stringify(written.error)}`);
              break;
            }
            const memory = await app.buildMemory(id, { signal: abort.signal });
            if (!memory.ok) log(`  [后台] 长篇记忆没有生成：${JSON.stringify(memory.error)}`);
            if (review) {
              const reviewed = await app.reviewChapter(id, { signal: abort.signal });
              log(`  [后台] 审核：${reviewed.ok ? `${reviewed.value.issues.length} 条问题` : JSON.stringify(reviewed.error)}`);
            }
            job.done++;
          }
          writing = null;
        })(),
      );
      return null;
    },
    writing: () => [...(writing === null ? [] : [writing.current, ...writing.queued]), ...[...single].flatMap((j) => (j.kind === 'review' ? [] : [j.chapterId]))],
    run(job) {
      const entry = { kind: job.kind, chapterId: job.chapterId, title: job.title, abort: new AbortController() };
      single.add(entry);
      pending.push(
        (async () => {
          log(`  [后台] ${job.title}`);
          const outcome = await job.work({ signal: entry.abort.signal });
          log(`  [后台] ${job.title}：${outcome.ok ? '做完了' : outcome.detail}`);
          single.delete(entry);
        })(),
      );
      return Promise.resolve(null);
    },
    reviewChapters(ids) {
      if (reviewing !== null) return '已经有一批在依次审核';
      const abort = new AbortController();
      const job = { abort, current: ids[0] ?? '', done: 0, total: ids.length };
      reviewing = job;
      pending.push(
        (async () => {
          for (const id of ids) {
            if (abort.signal.aborted) break;
            job.current = id;
            const reviewed = await app.reviewChapter(id, { signal: abort.signal });
            log(`  [后台] 审核《${await title(id)}》：${reviewed.ok ? `${reviewed.value.issues.length} 条问题` : JSON.stringify(reviewed.error)}`);
            job.done++;
          }
          reviewing = null;
        })(),
      );
      return null;
    },
    simulating: () => simulating !== null,
    simulate(runId) {
      if (simulating !== null) return '已经有一次推演在推进，等它推完或停下以后再推';
      const abort = new AbortController();
      simulating = { abort, runId };
      pending.push(
        (async () => {
          log(`  [后台] 推演 ${runId}`);
          const view = await app.continueSimRun(runId, { signal: abort.signal });
          log(`  [后台] 推演停下：${view.ok ? `${view.value.phase}，第 ${view.value.round} 回合，$${view.value.spentUsd.toFixed(4)}` : JSON.stringify(view.error)}`);
          simulating = null;
        })(),
      );
      return null;
    },
    stop(what) {
      const stopped: string[] = [];
      if ((what === 'writing' || what === 'all') && writing !== null) {
        writing.abort.abort();
        stopped.push(`写手停下（已写完的段落保留），后面排着的 ${writing.queued.length} 章不再写`);
      }
      for (const j of single) {
        if (what === 'simulation' || (what === 'writing' && j.kind === 'review') || (what === 'review' && j.kind !== 'review')) continue;
        j.abort.abort();
        stopped.push(`${j.title}停下`);
      }
      if ((what === 'review' || what === 'all') && reviewing !== null) {
        reviewing.abort.abort();
        stopped.push('依次审核停下');
      }
      if ((what === 'simulation' || what === 'all') && simulating !== null) {
        simulating.abort.abort();
        stopped.push('推演停在当前这一步之后（可以继续）');
      }
      return stopped.length > 0 ? `已停下：${stopped.join('；')}。` : '后台没有在进行的写作、审核或推演。';
    },
  };

  return {
    jobs,
    async running(): Promise<string[]> {
      // 先取下当前的批次：取章名要等，这期间批次可能结束、变成 null。
      const w = writing;
      const r = reviewing;
      const sim = simulating;
      const out: string[] = [];
      if (w !== null) out.push(`写手正在写《${await title(w.current)}》（这一批第 ${w.done + 1} / ${w.total} 章${w.queued.length > 0 ? `，后面还有 ${w.queued.length} 章` : ''}）`);
      if (r !== null) out.push(`正在依次审核：第 ${r.done + 1} / ${r.total} 章《${await title(r.current)}》`);
      if (sim !== null) out.push(`角色推演正在推进（推演 [${sim.runId}]）`);
      for (const j of single) out.push(j.title);
      return out;
    },
    /** 等后台全部做完。 */
    async settle(): Promise<void> {
      while (pending.length > 0) await pending.shift();
    },
  };
}

const describe = (error: unknown): string => {
  const e = error as { code?: string; detail?: string };
  return e.detail ?? e.code ?? JSON.stringify(error);
};

/** 按章名与文字找出作者的选区（只在一段之内）。 */
export async function selectionFor(app: AppService, select: NonNullable<Turn['select']>): Promise<AssistantSelection | null> {
  const work = await app.reloadWork();
  const chapter = work.ok ? work.value.chapters.find((c) => c.title === select.chapter) : undefined;
  if (chapter === undefined) return null;
  const content = await app.openChapter(chapter.id);
  if (!content.ok) return null;
  for (const p of content.value.saved) {
    const at = p.text.indexOf(select.text);
    if (at >= 0) return { chapterId: chapter.id, text: select.text, range: { from: { paragraphId: p.id, offset: at }, to: { paragraphId: p.id, offset: at + select.text.length } } };
  }
  return null;
}

export async function runScenario(app: AppService, turns: readonly Turn[], hooks: Hooks): Promise<TurnRecord[]> {
  const bg = backgroundFor(app, hooks.log);
  // running 要同步给出：每次发话前算好，助手每一步都读这一份（后台在这一轮里的变化下一句话才看得到）。
  let running: string[] = [];
  const records: TurnRecord[] = [];
  for (const turn of turns) {
    if (turn.waitBackground === true) await bg.settle();
    running = await bg.running();
    const before = await app.assistantItems();
    const start = before.ok ? before.value.length : 0;
    const started = hooks.now();
    hooks.log(`\n【作者】${turn.say}`);
    const selection = turn.select === undefined ? null : await selectionFor(app, turn.select);
    if (turn.select !== undefined && selection === null) hooks.log(`  （没有找到要选中的文字：${turn.select.text.slice(0, 20)}……）`);
    const events = { background: bg.jobs, running: () => running, ...(selection !== null && { selection }) };
    let outcome = await app.sendToAssistant(turn.say, events);
    let error: string | null = null;
    while (outcome.ok && outcome.value.pending) {
      const approve = turn.approve ?? true;
      hooks.log(`  （须确认，${approve ? '同意' : '拒绝'}）`);
      outcome = await app.resolveAssistantPending(approve, events);
    }
    if (!outcome.ok) error = describe(outcome.error);
    const after = await app.assistantItems();
    // 作品换了时对话搬进新作品，从头取这一轮。
    const all = after.ok ? after.value : [];
    const added = all.length >= start && start > 0 ? all.slice(start) : all.slice(Math.max(0, all.map((i) => i.role).lastIndexOf('user')));
    const used = [...new Set(added.flatMap((i) => (i.role === 'assistant' ? i.output.actions.map((a) => a.tool) : [])))];
    for (const item of added) {
      if (item.role === 'assistant') {
        if (item.output.message !== '') hooks.log(`  助手：${item.output.message}`);
        for (const a of item.output.actions) hooks.log(`    → ${a.tool}`);
      } else if (item.role === 'results') {
        for (const r of item.results) hooks.log(`    ${r.ok ? '✓' : '✗'} ${r.tool}：${r.detail.split('\n')[0]?.slice(0, 120) ?? ''}`);
      }
    }
    if (error !== null) hooks.log(`  出错：${error}`);
    const expect = turn.expect ?? [];
    records.push({ say: turn.say, expect, items: added, used, missing: expect.filter((t) => !used.includes(t)), error, ms: hooks.now() - started });
  }
  await bg.settle();
  return records;
}

export function renderReport(records: readonly TurnRecord[], meta: { readonly scenario?: string; readonly model: string; readonly startedAt: string; readonly usage: string; readonly chapters: string }): string {
  const lines = [`# AI 助手试用报告`, '', ...(meta.scenario === undefined ? [] : [`- 场景：${meta.scenario}`]), `- 模型：${meta.model}`, `- 开始：${meta.startedAt}`, `- 用量：${meta.usage}`, '', meta.chapters, ''];
  for (const [i, r] of records.entries()) {
    lines.push(`## ${i + 1}. ${r.say}`, '');
    lines.push(`用时 ${(r.ms / 1000).toFixed(1)} 秒；用到的动作：${r.used.join('、') || '无'}${r.missing.length > 0 ? `；期望而没用到：${r.missing.join('、')}` : ''}${r.error === null ? '' : `；出错：${r.error}`}`, '');
    for (const item of r.items) {
      if (item.role === 'user') lines.push(`> 作者：${item.text}`, '');
      else if (item.role === 'assistant') {
        lines.push(`**助手**（done=${item.output.done}）：${item.output.message || '（没有话）'}`, '');
        for (const a of item.output.actions) lines.push(`- 动作 \`${JSON.stringify(a)}\``);
        if (item.output.actions.length > 0) lines.push('');
      } else if (item.role === 'results') {
        for (const x of item.results) lines.push(`- ${x.ok ? '✓' : '✗'} ${x.tool}：${x.detail.length > 600 ? `${x.detail.slice(0, 600)}……` : x.detail}`.replace(/\n/g, '\n  '));
        lines.push('');
      } else if (item.role === 'pending') lines.push(`- 等待确认：${item.summary}`, '');
      else if (item.role === 'undo') lines.push(`- 撤销：${item.report}`, '');
    }
  }
  return `${lines.join('\n')}\n`;
}
