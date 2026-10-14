import { useEffect, useState, type ReactNode } from 'react';
import { randomIdea } from '../app/idea-seeds';
import type { BookSeed } from '../app/quick-book';
import { PipelineBoard } from './PipelineBoard';
import { useApp } from './store-context';

function Step({ n, title, done, children }: { readonly n: number; readonly title: string; readonly done: boolean; readonly children: ReactNode }) {
  return (
    <section className={`book-step${done ? ' done' : ''}`} aria-label={`第 ${n} 步：${title}`}>
      <h3>
        <span className="book-step-n">{done ? '✓' : n}</span>
        {title}
      </h3>
      {children}
    </section>
  );
}

/** 作品骨架的编辑：作品名、类型、简介、大纲与人物都可以改，采用后才写入作品。 */
function SeedEditor({ seed }: { readonly seed: BookSeed }) {
  const edit = useApp((s) => s.editBookSeed);
  const apply = useApp((s) => s.applyBookSeed);
  const discard = useApp((s) => s.discardBookSeed);
  const busy = useApp((s) => s.busy);
  const patch = (p: Partial<BookSeed>) => edit({ ...seed, ...p });
  const setCharacter = (i: number, p: Partial<BookSeed['characters'][number]>) => patch({ characters: seed.characters.map((c, j) => (j === i ? { ...c, ...p } : c)) });
  return (
    <div className="panel-form" role="form" aria-label="作品骨架">
      <p className="muted">这是根据你的想法生成的骨架，改到满意再采用。采用后写入作品信息，人物加进“设定”。</p>
      <label>
        作品名
        <input value={seed.title} onChange={(e) => patch({ title: e.currentTarget.value })} />
      </label>
      <label>
        类型
        <input value={seed.genre} onChange={(e) => patch({ genre: e.currentTarget.value })} />
      </label>
      <label>
        简介
        <textarea rows={2} value={seed.synopsis} onChange={(e) => patch({ synopsis: e.currentTarget.value })} />
      </label>
      <label>
        大纲
        <textarea rows={10} value={seed.outline} onChange={(e) => patch({ outline: e.currentTarget.value })} />
      </label>
      <fieldset>
        <legend>主要人物</legend>
        {seed.characters.map((c, i) => (
          <div key={i} className="book-character">
            <input aria-label={`人物 ${i + 1} 的名字`} value={c.name} onChange={(e) => setCharacter(i, { name: e.currentTarget.value })} />
            <input aria-label={`人物 ${i + 1} 的说明`} value={c.description} onChange={(e) => setCharacter(i, { description: e.currentTarget.value })} />
            <button type="button" aria-label={`删去人物 ${c.name}`} onClick={() => patch({ characters: seed.characters.filter((_, j) => j !== i) })}>
              删去
            </button>
          </div>
        ))}
        <button type="button" onClick={() => patch({ characters: [...seed.characters, { name: '', description: '' }] })}>
          添加人物
        </button>
      </fieldset>
      <div className="form-actions">
        <button type="button" disabled={busy || seed.outline.trim() === ''} onClick={() => void apply()}>
          采用骨架
        </button>
        <button type="button" onClick={discard}>
          放弃
        </button>
      </div>
    </div>
  );
}

/**
 * 快速成书（B67）：把出一本书串成一页——连接模型、由一句话的想法生成大纲与人物、拆出章节计划、
 * 写手依次写完并审核、导出。每一步的状态由作品里已有的数据得出；计划、写作与审核写入的是计划页的同一份数据。
 */
export function QuickBookPanel() {
  const status = useApp((s) => s.quickBook);
  const planning = useApp((s) => s.planning);
  const work = useApp((s) => s.work);
  const seed = useApp((s) => s.bookSeed);
  const seedDrafting = useApp((s) => s.seedDrafting);
  const planDraft = useApp((s) => s.planDraft);
  const planDrafting = useApp((s) => s.planDrafting);
  const unmatched = useApp((s) => s.planUnmatched);
  const modelServicesOpen = useApp((s) => s.modelServicesOpen);
  const busy = useApp((s) => s.busy);
  const refresh = useApp((s) => s.refreshQuickBook);
  const openModelServices = useApp((s) => s.openModelServices);
  const draftSeed = useApp((s) => s.draftBookSeed);
  const draftPlans = useApp((s) => s.draftPlans);
  const applyPlanDraft = useApp((s) => s.applyPlanDraft);
  const discardPlanDraft = useApp((s) => s.discardPlanDraft);
  const openPlanning = useApp((s) => s.openPlanning);
  const showPanel = useApp((s) => s.showPanel);
  const exportBook = useApp((s) => s.exportBook);
  const [idea, setIdea] = useState('');
  const [genre, setGenre] = useState('');
  const [count, setCount] = useState(20);
  const [words, setWords] = useState(3000);
  const [reseed, setReseed] = useState(false);

  // 打开时、从“模型服务”回来时重新读取：模型是否可用只在那里改变。
  useEffect(() => {
    if (!modelServicesOpen) void refresh();
  }, [modelServicesOpen, refresh]);

  const modelReady = status?.model.ready ?? false;
  const outline = (work?.project.outline.trim() ?? '') !== '';
  const chapters = planning?.chapters ?? [];
  const planned = chapters.filter((c) => c.plan !== null).length;
  const written = chapters.filter((c) => c.plan?.status === 'written' || c.plan?.status === 'reviewed').length;
  const characters = planning?.characters.length ?? 0;
  const idle = !busy && !seedDrafting && !planDrafting;

  return (
    <section className="quick-book" aria-label="快速成书">
      <h2>快速成书</h2>
      <p className="muted">按顺序走完五步：一句话的想法 → 大纲与人物 → 章节计划 → 写手写完并审核 → 导出。每一步都可以回头改。</p>

      <Step n={1} title="连接模型" done={modelReady}>
        {status === null ? (
          <p className="muted">正在读取…</p>
        ) : modelReady ? (
          <p>已连接：{status.model.name}</p>
        ) : (
          <>
            <p>
              {status.model.problem}。
              {status.model.name === null
                ? '在“模型服务”里添加服务、填写 API Key、获取模型列表，运行能力自检后设为默认模型。'
                : '打开“模型服务”，对这个模型运行能力自检；通不过时换一个模型设为默认。'}
            </p>
            <button type="button" onClick={() => void openModelServices()}>
              设置模型服务
            </button>
          </>
        )}
      </Step>

      <Step n={2} title="想法、大纲与人物" done={outline && seed === null}>
        {seed !== null ? (
          <SeedEditor seed={seed} />
        ) : outline && !reseed ? (
          <>
            <p>
              大纲已写好，人物 {characters} 个。
              <button type="button" className="link" onClick={() => void showPanel('info')}>
                查看或修改作品信息
              </button>
              <button type="button" className="link" onClick={() => setReseed(true)}>
                用一句想法重新生成
              </button>
            </p>
          </>
        ) : (
          <div className="panel-form" role="form" aria-label="一句话的想法">
            <div className="book-idea-head">
              <label htmlFor="book-idea">一句话的想法</label>
              <button
                type="button"
                className="link"
                title="从人物、处境与转折中随机拼一句，可以接着改；填了类型时按类型挑"
                onClick={() => {
                  // 随机只用来给作者一个起点，不进入推演，不需要可复现。
                  const next = randomIdea(genre, Math.random);
                  setIdea(next.idea);
                  setGenre(next.genre);
                }}
              >
                随机生成
              </button>
            </div>
            <textarea id="book-idea" rows={2} placeholder="没有想法？随机生成一个" value={idea} onChange={(e) => setIdea(e.currentTarget.value)} />
            <div className="skill-actions">
              <label>
                类型（可不填）
                <input value={genre} onChange={(e) => setGenre(e.currentTarget.value)} />
              </label>
              <label>
                章数
                <input type="number" min={1} max={100} value={count} onChange={(e) => setCount(Number(e.currentTarget.value))} />
              </label>
              <label>
                每章字数
                <input type="number" min={500} step={500} value={words} onChange={(e) => setWords(Number(e.currentTarget.value))} />
              </label>
            </div>
            <div className="form-actions">
              <button type="button" disabled={!idle || !modelReady || idea.trim() === '' || count < 1} onClick={() => void draftSeed({ idea, genre, chapterCount: count, wordsPerChapter: words })}>
                {seedDrafting ? '正在生成…' : '生成大纲与人物'}
              </button>
              {reseed ? (
                <button type="button" onClick={() => setReseed(false)}>
                  取消
                </button>
              ) : null}
            </div>
            {!modelReady ? <p className="muted">先完成第 1 步。也可以不用想法，直接在作品信息里写大纲。</p> : null}
          </div>
        )}
      </Step>

      <Step n={3} title="章节计划" done={planned > 0 && planDraft === null}>
        {planDraft !== null ? (
          <div aria-label="章节计划草稿">
            <ol>
              {planDraft.chapters.map((c, i) => (
                <li key={i}>
                  <strong>{c.title}</strong>：{c.goal}
                </li>
              ))}
            </ol>
            {planDraft.foreshadows.length > 0 ? <p>伏笔：{planDraft.foreshadows.map((f) => f.title).join('、')}</p> : null}
            <p className="muted">采用后每章的情节点、出场人物与伏笔都可以在“计划”页细改；已有的计划会被草稿覆盖。</p>
            <div className="form-actions">
              <button type="button" disabled={busy} onClick={() => void applyPlanDraft()}>
                采用计划
              </button>
              <button type="button" onClick={discardPlanDraft}>
                放弃
              </button>
            </div>
          </div>
        ) : planned > 0 ? (
          <p>
            {chapters.length} 章，{planned} 章有计划。
            <button type="button" className="link" onClick={() => void openPlanning()}>
              查看与修改计划
            </button>
          </p>
        ) : (
          <>
            <p className="muted">由大纲拆成 {count} 章，每章约 {words} 字（章数与字数在第 2 步里改）。</p>
            <button type="button" disabled={!idle || !modelReady || !outline || seed !== null} onClick={() => void draftPlans(count, words)}>
              {planDrafting ? '正在生成…' : '生成章节计划'}
            </button>
          </>
        )}
        {unmatched.length > 0 ? <p className="muted">这些人物还没有设定，没有加入出场人物：{unmatched.join('、')}。</p> : null}
      </Step>

      <Step n={4} title="写手写完并审核" done={planned > 0 && written === planned}>
        {planned > 0 ? <PipelineBoard /> : <p className="muted">有了章节计划后，在这里一键依次写完；勾选“写完后审核”，每章写完就检查一遍。</p>}
      </Step>

      <Step n={5} title="导出" done={false}>
        {written > 0 ? (
          <div className="form-actions">
            <button type="button" disabled={busy} onClick={() => void exportBook('txt')}>
              导出整本 TXT
            </button>
            <button type="button" disabled={busy} onClick={() => void exportBook('md')}>
              导出整本 Markdown
            </button>
          </div>
        ) : (
          <p className="muted">写完的章节可以随时导出；章节也可以在左侧目录里打开，直接修改。</p>
        )}
      </Step>
    </section>
  );
}
