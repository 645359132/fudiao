import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fsDeps, type TestDeps } from '../testing/fs-deps';
import { DEFAULT_PREFERENCES, folderName } from './library';
import { createAppService, type WorkView } from './service';

const roots: TestDeps[] = [];
afterEach(async () => {
  for (const d of roots.splice(0)) {
    await d.dispose();
    rmSync(d.root, { recursive: true, force: true });
  }
});

function setup() {
  const deps = fsDeps();
  roots.push(deps);
  return { deps, app: createAppService(deps) };
}

function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

const titles = (view: WorkView) => view.chapters.map((c) => c.title);

describe('作品列表', () => {
  it('首次启动时作品列表为空，作品库为文档下的“复调”', async () => {
    const { deps, app } = setup();
    expect(value(await app.loadLibrary())).toEqual({ libraryDir: join(deps.root, 'Documents', '复调'), works: [], preferences: DEFAULT_PREFERENCES });
  });

  it('偏好：旧的作品列表文件没有偏好时用默认值；修改后写入文件', async () => {
    const { deps, app } = setup();
    mkdirSync(dirname(deps.libraryFile), { recursive: true });
    writeFileSync(deps.libraryFile, JSON.stringify({ version: 1, libraryDir: null, works: [] }));
    expect(value(await app.loadLibrary()).preferences).toEqual(DEFAULT_PREFERENCES);
    expect(value(await app.setPreferences({ showParagraphSource: false })).preferences).toEqual({ ...DEFAULT_PREFERENCES, showParagraphSource: false });
    const layout = { sidebar: 300, assistant: 420, sidebarHidden: true };
    expect(value(await app.setPreferences({ theme: 'dark', layout })).preferences).toEqual({ showParagraphSource: false, theme: 'dark', layout });
    expect((JSON.parse(readFileSync(deps.libraryFile, 'utf8')) as { preferences: unknown }).preferences).toEqual({ showParagraphSource: false, theme: 'dark', layout });
  });

  it('新建作品：在作品库下建文件夹与作品库，加入列表并成为当前作品', async () => {
    const { deps, app } = setup();
    await app.loadLibrary();
    const view = value(await app.createWork('  雨夜 '));
    expect(view.project.title).toBe('雨夜');
    expect(view.entry.path).toBe(join(deps.root, 'Documents', '复调', '雨夜'));
    expect(existsSync(join(view.entry.path, 'project.sqlite'))).toBe(true);
    const stored = JSON.parse(readFileSync(deps.libraryFile, 'utf8')) as { works: { id: string; title: string }[] };
    expect(stored.works).toEqual([expect.objectContaining({ id: view.project.id, title: '雨夜', archived: false })]);
  });

  it('重名时文件夹加序号；标题中不允许的字符被去掉', async () => {
    const { app } = setup();
    await app.loadLibrary();
    const a = value(await app.createWork('雨夜'));
    const b = value(await app.createWork('雨夜'));
    expect(b.entry.path).toBe(`${a.entry.path}（2）`);
    expect(folderName('第一卷：雨夜?')).toBe('第一卷：雨夜');
    expect(folderName('a/b:c')).toBe('abc');
    expect(folderName('CON')).toBe('CON_');
    expect(folderName('...')).toBe('未命名作品');
    expect(value(await app.loadLibrary()).works).toHaveLength(2);
  });

  it('关闭后重新打开，最近打开的排在前面', async () => {
    const { app } = setup();
    await app.loadLibrary();
    const first = value(await app.createWork('甲'));
    value(await app.createWork('乙'));
    await app.closeWork();
    value(await app.openWork(first.project.id));
    expect(value(await app.loadLibrary()).works.map((w) => w.title)).toEqual(['甲', '乙']);
  });

  it('打开其他位置的已有作品；选择的文件夹不是作品时拒绝，取消时什么也不做', async () => {
    const { deps, app } = setup();
    await app.loadLibrary();
    const work = value(await app.createWork('外部作品'));
    await app.closeWork();
    // 把作品文件夹挪到作品库以外，并从列表中移除。
    const moved = join(deps.root, 'elsewhere');
    renameSync(work.entry.path, moved);
    value(await app.removeMissingWork(work.project.id));

    const plain = join(deps.root, 'plain');
    mkdirSync(plain);
    deps.picks.push(plain, null, moved);
    expect(await app.addWorkFromFolder()).toEqual({ ok: false, error: { code: 'not_a_work', path: plain } });
    expect(existsSync(join(plain, 'project.sqlite'))).toBe(false);
    expect(await app.addWorkFromFolder()).toEqual({ ok: true, value: null });
    const added = value(await app.addWorkFromFolder());
    expect(added?.project.id).toBe(work.project.id);
    expect(value(await app.loadLibrary()).works.map((w) => w.path)).toEqual([moved]);
  });

  it('归档与取消归档：文件不动，可以打开', async () => {
    const { app } = setup();
    await app.loadLibrary();
    const work = value(await app.createWork('旧作'));
    await app.closeWork();
    const archived = value(await app.setArchived(work.project.id, true));
    expect(archived.works[0]).toMatchObject({ archived: true, missing: false });
    value(await app.openWork(work.project.id));
    await app.closeWork();
    expect(value(await app.setArchived(work.project.id, false)).works[0]?.archived).toBe(false);
  });

  it('文件夹丢失时标出，打开报错；只有丢失的作品可以从列表移除', async () => {
    const { app } = setup();
    await app.loadLibrary();
    const work = value(await app.createWork('丢失'));
    await app.closeWork();
    expect(await app.removeMissingWork(work.project.id)).toMatchObject({ ok: false, error: { code: 'library' } });
    rmSync(work.entry.path, { recursive: true });
    expect(value(await app.loadLibrary()).works[0]?.missing).toBe(true);
    expect(await app.openWork(work.project.id)).toEqual({ ok: false, error: { code: 'missing', path: work.entry.path } });
    expect(value(await app.removeMissingWork(work.project.id)).works).toEqual([]);
  });

  it('作品列表文件损坏时报错，不覆盖', async () => {
    const { deps, app } = setup();
    await deps.library.write('{坏的');
    expect(await app.loadLibrary()).toEqual({ ok: false, error: { code: 'library', detail: '作品列表文件已损坏' } });
    expect(readFileSync(deps.libraryFile, 'utf8')).toBe('{坏的');
  });

  it('更改作品库位置后，新作品建在新位置', async () => {
    const { deps, app } = setup();
    await app.loadLibrary();
    const dir = join(deps.root, 'D盘作品');
    deps.picks.push(dir);
    expect(value(await app.chooseLibraryDir())?.libraryDir).toBe(dir);
    expect(value(await app.createWork('新作')).entry.path).toBe(join(dir, '新作'));
  });
});

describe('作品信息与章节', () => {
  it('更新作品信息；改名同步到作品列表', async () => {
    const { app } = setup();
    await app.loadLibrary();
    value(await app.createWork('雨夜'));
    const view = value(await app.updateWorkInfo({ title: '雨夜行', genre: '武侠', synopsis: '两人在当铺重逢', goals: { totalWords: 300_000, note: '' } }));
    expect(view.project).toMatchObject({ title: '雨夜行', genre: '武侠', goals: { totalWords: 300_000 } });
    expect(value(await app.loadLibrary()).works[0]?.title).toBe('雨夜行');
  });

  it('作品封面（B76）：上传图片后有封面，作品列表带缩略图；不是图片时说明原因；去掉后回到文字封面；重新打开时按作品库更新列表', async () => {
    const { deps, app } = setup();
    await app.loadLibrary();
    const work = value(await app.createWork('雨夜'));
    expect(value(await app.workCover())).toBeNull();
    expect(value(await app.loadLibrary()).works[0]?.cover).toBeNull();
    expect(await app.setWorkCover(new Blob(['文字'], { type: 'text/plain' }))).toMatchObject({ ok: false, error: { code: 'settings', detail: expect.stringContaining('图片') } });
    const cover = value(await app.setWorkCover(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7])], { type: 'image/jpeg' })));
    expect(cover).toMatchObject({ projectId: work.project.id, width: 600, height: 800, image: expect.stringMatching(/^data:image\/jpeg;base64,/) });
    const listed = value(await app.loadLibrary()).works[0]?.cover ?? '';
    expect(listed).toMatch(/^data:image\/jpeg;base64,/);
    expect(JSON.parse(readFileSync(deps.libraryFile, 'utf8'))).toMatchObject({ works: [{ cover: listed }] });

    // 列表里的缩略图只是缓存：被别处改掉时，重新打开作品按作品库更新。
    const file = JSON.parse(readFileSync(deps.libraryFile, 'utf8')) as { works: { cover: string | null }[] };
    writeFileSync(deps.libraryFile, JSON.stringify({ ...file, works: file.works.map((w) => ({ ...w, cover: null })) }));
    value(await app.loadLibrary());
    value(await app.openWork(work.project.id));
    expect(value(await app.loadLibrary()).works[0]?.cover).toBe(listed);

    value(await app.removeWorkCover());
    expect(value(await app.workCover())).toBeNull();
    expect(value(await app.loadLibrary()).works[0]?.cover).toBeNull();
  });

  it('章节的新建、重命名、排序、回收站与恢复', async () => {
    const { app } = setup();
    await app.loadLibrary();
    value(await app.createWork('雨夜'));
    value(await app.createChapter('第一章'));
    value(await app.createChapter('第二章'));
    let view = value(await app.createChapter('第三章'));
    const [c1, c2, c3] = view.chapters;
    if (!c1 || !c2 || !c3) throw new Error();
    view = value(await app.createChapter('楔子', undefined));
    view = value(await app.moveChapter(view.chapters[3] ?? c1, { volumeId: null, after: null }));
    expect(titles(view)).toEqual(['楔子', '第一章', '第二章', '第三章']);
    view = value(await app.renameChapter(c2, '第二章 当铺'));
    view = value(await app.trashChapter(view.chapters.find((c) => c.id === c3.id) ?? c3));
    expect(titles(view)).toEqual(['楔子', '第一章', '第二章 当铺']);
    expect(view.trashed.map((c) => c.title)).toEqual(['第三章']);
    view = value(await app.restoreChapter(view.trashed[0] ?? c3));
    expect(titles(view)).toEqual(['楔子', '第一章', '第二章 当铺', '第三章']);
  });

  it('分卷（B68）：新建卷与卷里的章节、调整卷的顺序、卷里还有章节时不能删除；整本导出带卷名，导回时分卷照旧', async () => {
    const { app, deps } = setup();
    await app.loadLibrary();
    value(await app.createWork('雨夜'));
    value(await app.createChapter('楔子'));
    let view = value(await app.createVolume('第一卷 雨夜'));
    view = value(await app.createVolume('第二卷 天明'));
    const [v1, v2] = view.volumes;
    if (!v1 || !v2) throw new Error();
    view = value(await app.createChapter('第一章', undefined, v1.id));
    // 不指定位置的新章节接在全书末尾，也就是最后一卷的末尾。
    view = value(await app.createChapter('第二章'));
    expect(view.chapters.map((c) => [c.title, view.volumes.find((v) => v.id === c.volumeId)?.title ?? null])).toEqual([
      ['楔子', null],
      ['第一章', '第一卷 雨夜'],
      ['第二章', '第二卷 天明'],
    ]);
    expect(await app.deleteVolume(v2)).toMatchObject({ ok: false, error: { code: 'settings', detail: expect.stringContaining('里还有章节') } });
    view = value(await app.updateVolume(v2, { title: '第二卷 天明', summary: '旧主现身' }));
    view = value(await app.moveVolume(view.volumes[1]!, null));
    expect(titles(view)).toEqual(['楔子', '第二章', '第一章']);

    value(await app.exportText('txt'));
    const txt = deps.exported.at(-1)?.content ?? '';
    expect(txt.indexOf('第二卷 天明')).toBeLessThan(txt.indexOf('第二章'));
    expect(txt.indexOf('第一卷 雨夜')).toBeLessThan(txt.indexOf('第一章'));

    view = value(await app.importChaptersIntoWork([{ title: '第三章', paragraphs: ['甲。'], volume: '第一卷 雨夜' }, { title: '第四章', paragraphs: ['乙。'], volume: '第三卷 归途' }]));
    expect(view.volumes.map((v) => v.title)).toEqual(['第二卷 天明', '第一卷 雨夜', '第三卷 归途']);
    expect(titles(view)).toEqual(['楔子', '第二章', '第一章', '第三章', '第四章']);
  });

  it('用过期的版本修改时返回冲突', async () => {
    const { app } = setup();
    await app.loadLibrary();
    value(await app.createWork('雨夜'));
    const stale = value(await app.createChapter('第一章')).chapters[0];
    if (!stale) throw new Error();
    value(await app.renameChapter(stale, '序章'));
    expect(await app.renameChapter(stale, '又改')).toEqual({ ok: false, error: { code: 'repo', error: { code: 'conflict' } } });
  });

  it('没有打开作品时章节操作报错', async () => {
    const { app } = setup();
    expect(await app.createChapter('第一章')).toEqual({ ok: false, error: { code: 'no_work' } });
  });
});

describe('导入导出与备份', () => {
  const chapters = [
    { title: '第一章 雨夜', paragraphs: ['雨下得更紧了。', '他没有回头。'] },
    { title: '第二章 当铺', paragraphs: ['掌柜抬起头。'] },
  ];

  it('导入为新作品；导入章节追加到当前作品末尾', async () => {
    const { app } = setup();
    await app.loadLibrary();
    const work = value(await app.importTextAsWork('雨夜', chapters));
    expect(work.project.title).toBe('雨夜');
    expect(titles(work)).toEqual(['第一章 雨夜', '第二章 当铺']);
    const more = value(await app.importChaptersIntoWork([{ title: '第三章 旧信', paragraphs: ['信纸已经发黄。'] }]));
    expect(titles(more)).toEqual(['第一章 雨夜', '第二章 当铺', '第三章 旧信']);
    const third = more.chapters[2];
    if (!third) throw new Error();
    expect(value(await app.openChapter(third.id)).saved.map((p) => p.text)).toEqual(['信纸已经发黄。']);
  });

  it('导出整本 TXT 与 Markdown，导出一章', async () => {
    const { deps, app } = setup();
    await app.loadLibrary();
    const work = value(await app.importTextAsWork('雨夜', chapters));
    value(await app.exportText('txt'));
    value(await app.exportText('md'));
    value(await app.exportText('md', work.chapters[1]?.id));
    expect(deps.exported).toEqual([
      { name: '雨夜.txt', content: '第一章 雨夜\n\n　　雨下得更紧了。\n　　他没有回头。\n\n第二章 当铺\n\n　　掌柜抬起头。\n' },
      { name: '雨夜.md', content: '# 雨夜\n\n## 第一章 雨夜\n\n雨下得更紧了。\n\n他没有回头。\n\n## 第二章 当铺\n\n掌柜抬起头。\n\n' },
      { name: '第二章 当铺.md', content: '# 第二章 当铺\n\n掌柜抬起头。\n\n' },
    ]);
  });

  it('导出作品包再导入：成为一部新作品，与原作品同标识时换新标识，内容一致', async () => {
    const { deps, app } = setup();
    await app.loadLibrary();
    const original = value(await app.importTextAsWork('雨夜', chapters));
    value(await app.exportProject());
    const pkg = deps.exportedPackages[0];
    expect(pkg?.name).toBe('雨夜.zip');
    deps.projectPicks.push(pkg?.files ?? []);
    const imported = value(await app.importProject());
    if (imported === null) throw new Error('应导入');
    expect(imported.project.id).not.toBe(original.project.id);
    expect(imported.entry.path).toBe(`${original.entry.path}（2）`);
    expect(titles(imported)).toEqual(titles(original));
    expect(value(await app.loadLibrary()).works).toHaveLength(2);
    // 取消选择时什么也不做。
    expect(await app.importProject()).toEqual({ ok: true, value: null });
  });

  it('不是作品包时报错，不建作品', async () => {
    const { deps, app } = setup();
    await app.loadLibrary();
    deps.projectPicks.push([{ path: 'manifest.json', content: '{"format":"other"}' }]);
    expect(await app.importProject()).toEqual({ ok: false, error: { code: 'library', detail: '这不是复调的作品包' } });
    expect(value(await app.loadLibrary()).works).toEqual([]);
  });

  it('自动备份：打开作品时距上次超过 24 小时才备份', async () => {
    const { app } = setup();
    await app.loadLibrary();
    value(await app.createWork('雨夜'));
    expect(value(await app.autoBackupIfDue())).toBe(true);
    expect(value(await app.autoBackupIfDue())).toBe(false);
    expect(value(await app.listBackups()).map((b) => b.kind)).toEqual(['auto']);
  });

  it('立即备份与恢复：恢复后内容回到备份时，现稿成为恢复前备份', async () => {
    const { app } = setup();
    await app.loadLibrary();
    value(await app.importTextAsWork('雨夜', chapters));
    const backup = value(await app.createBackup());
    expect(backup.kind).toBe('manual');
    value(await app.createChapter('第三章'));
    const restored = value(await app.restoreBackup(backup.name));
    expect(titles(restored)).toEqual(['第一章 雨夜', '第二章 当铺']);
    const kinds = value(await app.listBackups()).map((b) => b.kind);
    expect(kinds).toContain('pre-restore');
    // 恢复后作品照常可写。
    expect(titles(value(await app.createChapter('新的第三章')))).toEqual(['第一章 雨夜', '第二章 当铺', '新的第三章']);
  });

  it('恢复后作品列表里的书名与封面按恢复后的作品库更新（列表里的只是缓存）', async () => {
    const { app } = setup();
    await app.loadLibrary();
    value(await app.createWork('雨夜'));
    const backup = value(await app.createBackup());
    value(await app.updateWorkInfo({ title: '雨夜行' }));
    value(await app.setWorkCover(new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])], { type: 'image/png' })));
    expect(value(await app.loadLibrary()).works[0]).toMatchObject({ title: '雨夜行', cover: expect.stringMatching(/^data:image\/png/) });
    expect(value(await app.restoreBackup(backup.name)).project.title).toBe('雨夜');
    expect(value(await app.loadLibrary()).works[0]).toMatchObject({ title: '雨夜', cover: null });
    expect(value(await app.workCover())).toBeNull();
  });
});
