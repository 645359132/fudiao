// @vitest-environment jsdom
// 用真实的用例与作品库（Node 的 SqlPort）驱动界面，覆盖 B01、B02 的主要流程。
import { readFileSync, rmSync } from 'node:fs';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { warehouseSpec } from '@fudiao/domain/testing';
import { fakeModel } from '@fudiao/engine/testing';
import type { LlmPort } from '@fudiao/llm';
import { anthropicChunks, openaiChunks } from '@fudiao/llm/testing';
import { renderConnectionTest, SELF_TEST_EXPECTED } from '@fudiao/prompts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { createAppService } from '../app/service';
import { createAppStore } from '../state/store';
import { fsDeps, type TestDeps } from '../testing/fs-deps';
import { addTestedModel, reply } from '../testing/models';
import { dramaPolicy, sceneDraftFixture } from '../testing/scenes';

// jsdom 不做排版，ProseMirror 把选区滚入视野时要用到的几何接口给空实现。
const noRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
const zeroRect = () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0, toJSON: () => ({}) }) as DOMRect;
Element.prototype.getClientRects = noRects;
Range.prototype.getClientRects = noRects;
Range.prototype.getBoundingClientRect = zeroRect;
document.elementFromPoint = () => null;
// 界面测试在 jsdom 里驱动整个应用，整套测试并行时较慢：单个测试的上限放宽到 20 秒。
vi.setConfig({ testTimeout: 20_000 });
// Radix 的菜单与气泡用 ResizeObserver 量尺寸；jsdom 没有，给一个空实现。
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const all: TestDeps[] = [];
afterEach(async () => {
  cleanup();
  for (const d of all.splice(0)) {
    await d.dispose();
    rmSync(d.root, { recursive: true, force: true });
  }
});

function start() {
  const deps = fsDeps();
  all.push(deps);
  const service = createAppService(deps);
  const store = createAppStore(service);
  render(<App store={store} />);
  return { deps, service, store, user: userEvent.setup() };
}

const chapterTitles = () =>
  within(screen.getByRole('navigation', { name: '章节目录' }))
    .queryAllByRole('listitem')
    .map((li) => li.querySelector('.chapter-title')?.textContent);

/** 目录从上到下的各行：卷（“卷：卷名”）、章节名，或空卷的提示。 */
const tocOutline = () =>
  [...screen.getByRole('navigation', { name: '章节目录' }).querySelectorAll('.chapter-list > li')].map(
    (li) => li.querySelector('.chapter-title')?.textContent ?? li.querySelector('.volume-head')?.getAttribute('aria-label') ?? li.textContent,
  );

async function createWork(user: ReturnType<typeof userEvent.setup>, title: string) {
  await user.click(await screen.findByRole('button', { name: '新建作品' }));
  await user.type(screen.getByRole('textbox', { name: '作品名' }), `${title}{Enter}`);
  await screen.findByRole('navigation', { name: '章节目录' });
}

async function addChapter(user: ReturnType<typeof userEvent.setup>, title: string) {
  await user.click(screen.getByRole('button', { name: '新建章节' }));
  await user.type(screen.getByRole('textbox', { name: '新章节名' }), `${title}{Enter}`);
  await waitFor(() => expect(chapterTitles()).toContain(title));
}

describe('作品与章节界面', () => {
  it('新建作品后进入作品界面；章节新建、重命名、排序、回收站与恢复', async () => {
    const { user } = start();
    expect(await screen.findByText('还没有作品。新建一部，或打开已有的作品文件夹。')).toBeTruthy();
    await createWork(user, '雨夜');
    expect(screen.getByRole('button', { name: '雨夜' })).toBeTruthy();

    // 新章节插在所选章节之后，并成为所选。
    await addChapter(user, '第一章');
    await addChapter(user, '第二章');
    await addChapter(user, '第三章');
    expect(chapterTitles()).toEqual(['第一章', '第二章', '第三章']);

    await user.click(screen.getByRole('button', { name: '重命名 第二章' }));
    const input = screen.getByRole('textbox', { name: '章节名' });
    await user.clear(input);
    await user.type(input, '第二章 当铺{Enter}');
    await waitFor(() => expect(chapterTitles()).toEqual(['第一章', '第二章 当铺', '第三章']));

    await user.click(screen.getByRole('button', { name: '上移 第三章' }));
    await waitFor(() => expect(chapterTitles()).toEqual(['第一章', '第三章', '第二章 当铺']));
    await user.click(screen.getByRole('button', { name: '下移 第一章' }));
    await waitFor(() => expect(chapterTitles()).toEqual(['第三章', '第一章', '第二章 当铺']));

    await user.click(screen.getByRole('button', { name: '移入回收站 第一章' }));
    await waitFor(() => expect(chapterTitles()).toEqual(['第三章', '第二章 当铺']));
    await user.click(screen.getByRole('button', { name: '回收站（1）' }));
    await user.click(screen.getByRole('button', { name: '恢复 第一章' }));
    await waitFor(() => expect(chapterTitles()).toEqual(['第三章', '第二章 当铺', '第一章']));
  });

  it('章节梗概与写作备注；作品信息与写作目标', async () => {
    const { user } = start();
    await createWork(user, '雨夜');
    await addChapter(user, '第一章');
    await user.type(screen.getByRole('textbox', { name: '章节梗概' }), '两人在当铺重逢');
    await user.click(screen.getByRole('button', { name: '保存梗概与备注' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '保存梗概与备注' }).hasAttribute('disabled')).toBe(true));
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '章节梗概' }).value).toBe('两人在当铺重逢');

    await user.click(screen.getByRole('button', { name: '雨夜' }));
    const title = screen.getByRole('textbox', { name: '作品名' });
    await user.clear(title);
    await user.type(title, '雨夜行');
    await user.type(screen.getByRole('textbox', { name: '题材' }), '武侠');
    await user.type(screen.getByRole('textbox', { name: '目标字数' }), '三十万');
    expect(screen.getByText('目标字数须为正整数，或留空')).toBeTruthy();
    await user.clear(screen.getByRole('textbox', { name: '目标字数' }));
    await user.type(screen.getByRole('textbox', { name: '目标字数' }), '300000');
    await user.click(screen.getByRole('button', { name: '保存作品信息' }));
    await screen.findByRole('button', { name: '雨夜行' });
  });

  it('返回作品列表；归档与取消归档；重新打开作品', async () => {
    const { user } = start();
    await createWork(user, '旧作');
    await addChapter(user, '第一章');
    await user.click(screen.getByRole('button', { name: '作品列表' }));
    await user.click(await screen.findByRole('button', { name: '归档 旧作' }));
    const archived = await screen.findByText('已归档（1）');
    expect(screen.getByText('还没有作品。新建一部，或打开已有的作品文件夹。')).toBeTruthy();
    await user.click(archived);
    await user.click(screen.getByRole('button', { name: '取消归档 旧作' }));
    await waitFor(() => expect(screen.queryByText('已归档（1）')).toBeNull());
    await user.click(screen.getByRole('button', { name: '旧作' }));
    await waitFor(() => expect(chapterTitles()).toEqual(['第一章']));
  });

  it('打开的文件夹不是作品时提示，提示可以关闭', async () => {
    const { deps, user } = start();
    deps.picks.push(deps.root);
    await user.click(await screen.findByRole('button', { name: '打开作品文件夹' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('这个文件夹里没有作品');
    await user.click(screen.getByRole('button', { name: '关闭提示' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('正文编辑', () => {
  const editorText = () => screen.getByRole('textbox', { name: '正文' }).textContent;

  async function chapterWithText(user: ReturnType<typeof userEvent.setup>, text: string) {
    await createWork(user, '雨夜');
    await addChapter(user, '第一章');
    const body = await screen.findByRole('textbox', { name: '正文' });
    await user.click(body);
    await user.keyboard(text);
    await waitFor(() => expect(editorText()).toBe(text));
    await waitForSaved();
  }

  /** 先等到出现未保存状态，再等到保存完成；避免一开始的“已保存”让等待直接通过。 */
  async function waitForSaved() {
    await waitFor(() => expect(screen.getByRole('status').textContent).not.toBe('已保存'));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('已保存'), { timeout: 3_000 });
  }

  it('输入后自动保存；切换章节再回来，正文一致；字数随之更新', async () => {
    const { user } = start();
    await chapterWithText(user, '雨下得更紧了。');
    expect(screen.getByText('本章 7 字')).toBeTruthy();
    await addChapter(user, '第二章');
    await waitFor(() => expect(editorText()).toBe(''));
    await user.click(screen.getByRole('button', { name: '第一章' }));
    await waitFor(() => expect(editorText()).toBe('雨下得更紧了。'));
  });

  it('作品封面（B76）：作品信息里先是文字封面；上传图片后显示图片，作品列表的卡片也换上；去掉后回到文字封面', async () => {
    const { user } = start();
    await createWork(user, '雨夜');
    await user.click(screen.getByRole('button', { name: '雨夜' }));
    const info = await screen.findByRole('region', { name: '作品信息' });
    const cover = within(info).getByRole('region', { name: '封面' });
    expect(await within(cover).findByRole('img', { name: '《雨夜》的文字封面' })).toBeTruthy();
    await user.upload(within(cover).getByLabelText('选择封面图片'), new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9])], 'cover.jpg', { type: 'image/jpeg' }));
    const image = await within(cover).findByRole('img', { name: '《雨夜》的封面' });
    expect(image.getAttribute('src')).toMatch(/^data:image\/jpeg;base64,/);
    expect(within(cover).getByText('600 × 800 像素')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '作品列表' }));
    const card = (await screen.findByRole('button', { name: '雨夜' })).closest('li');
    const thumbnail = card?.querySelector<HTMLImageElement>('img.book-cover');
    expect(thumbnail?.getAttribute('src')).toMatch(/^data:image\/jpeg;base64,/);

    // 点封面直接打开作品。
    if (thumbnail === null || thumbnail === undefined) throw new Error('卡片上应有封面');
    await user.click(thumbnail);
    await screen.findByRole('navigation', { name: '章节目录' });
    expect(screen.queryByRole('region', { name: '作品信息' })).toBeNull();

    // 卡片上的“更换封面”：打开作品并进入作品信息。
    await user.click(screen.getByRole('button', { name: '作品列表' }));
    await user.click(await screen.findByRole('button', { name: '更换 雨夜 的封面' }));
    const again = within(await screen.findByRole('region', { name: '作品信息' })).getByRole('region', { name: '封面' });
    await user.click(await within(again).findByRole('button', { name: '去掉封面' }));
    expect(await within(again).findByRole('img', { name: '《雨夜》的文字封面' })).toBeTruthy();
    expect(within(again).getByRole('button', { name: '上传封面…' })).toBeTruthy();
  });

  it('去作品信息再回到本章：显示最新保存的正文，接着写也不会留下多余段落', async () => {
    const { store, user } = start();
    await chapterWithText(user, '第一句。');
    await user.click(screen.getByRole('button', { name: '雨夜' }));
    await screen.findByRole('region', { name: '作品信息' });
    await user.click(screen.getByRole('button', { name: '第一章' }));
    await waitFor(() => expect(editorText()).toBe('第一句。'));
    await user.click(screen.getByRole('textbox', { name: '正文' }));
    await user.keyboard('第二句。');
    await waitFor(() => expect(editorText()).toBe('第二句。第一句。'));
    await waitForSaved();
    await user.click(screen.getByRole('button', { name: '作品列表' }));
    await user.click(await screen.findByRole('button', { name: '雨夜' }));
    await waitFor(() => expect(editorText()).toBe('第二句。第一句。'));
    expect(store.getState().chapterContent?.saved.map((p) => p.text)).toEqual(['第二句。第一句。']);
  });

  it('关闭作品后重新打开，正文从库中读回', async () => {
    const { user } = start();
    await chapterWithText(user, '他没有回头。');
    await user.click(screen.getByRole('button', { name: '作品列表' }));
    await user.click(await screen.findByRole('button', { name: '雨夜' }));
    await waitFor(() => expect(editorText()).toBe('他没有回头。'));
  });

  it('意外退出后重新打开：提示未保存的编辑，可以恢复', async () => {
    const { deps, store, user } = start();
    await chapterWithText(user, '已保存的一句。');
    const chapterId = store.getState().selectedChapterId ?? '';
    const path = store.getState().work?.entry.path ?? '';
    const savedId = screen.getByRole('textbox', { name: '正文' }).querySelector('p')?.getAttribute('data-id') ?? '';
    const saved = [{ id: savedId, text: '已保存的一句。', source: 'handwritten' }];
    // 模拟崩溃前留下的草稿：比库中多一段。
    await deps.drafts.write(
      path,
      chapterId,
      JSON.stringify({ version: 1, chapterId, writtenAt: '2026-10-08T01:02:03.000Z', paragraphs: [...saved, { id: 'unsaved', text: '没来得及保存的一句。', source: 'handwritten' }] }),
    );
    await user.click(screen.getByRole('button', { name: '作品列表' }));
    await user.click(await screen.findByRole('button', { name: '雨夜' }));
    expect((await screen.findByText(/未保存的编辑/)).textContent).toContain('发现');
    await user.click(screen.getByRole('button', { name: '恢复这些编辑' }));
    await waitFor(() => expect(editorText()).toBe('已保存的一句。没来得及保存的一句。'));
    await waitForSaved();
    // 恢复的内容已存入库中，草稿已删除：重新打开作品时不再提示。
    await user.click(screen.getByRole('button', { name: '作品列表' }));
    await user.click(await screen.findByRole('button', { name: '雨夜' }));
    await waitFor(() => expect(editorText()).toBe('已保存的一句。没来得及保存的一句。'));
    expect(screen.queryByText(/未保存的编辑/)).toBeNull();
  });

  it('保存失败时显示原因，可以复制全文与导出本章，内容留在编辑器中', async () => {
    const { deps, user } = start();
    await chapterWithText(user, '第一句。');
    // 让后续保存失败：关闭作品库连接。
    await deps.opener.close();
    await user.keyboard('第二句。');
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('保存失败'), { timeout: 3_000 });
    expect(editorText()).toBe('第一句。第二句。');
    await user.click(screen.getByRole('button', { name: '复制全文' }));
    expect(deps.copied).toEqual(['第一句。第二句。']);
    await user.click(screen.getByRole('button', { name: '导出本章' }));
    expect(deps.exported).toEqual([{ name: '第一章.txt', content: '第一句。第二句。' }]);
    // 保存失败时不能离开本章。
    await user.click(screen.getByRole('button', { name: '作品列表' }));
    expect((await screen.findByRole('alert')).textContent).toContain('没有保存成功');
    expect(screen.getByRole('textbox', { name: '正文' })).toBeTruthy();
  });
});

describe('章节快照', () => {
  const editorText = () => screen.getByRole('textbox', { name: '正文' }).textContent;

  async function typeAndSave(user: ReturnType<typeof userEvent.setup>, text: string, expected: string) {
    await user.click(screen.getByRole('textbox', { name: '正文' }));
    await user.keyboard(text);
    await waitFor(() => expect(editorText()).toBe(expected));
  }

  it('保存快照、继续写、预览并恢复；恢复前的现稿成为快照，可以再恢复回来', async () => {
    const { user } = start();
    await createWork(user, '雨夜');
    await addChapter(user, '第一章');
    await typeAndSave(user, '初稿。', '初稿。');
    // “保存快照”先保存正文再建快照，不必等自动保存。
    await user.click(screen.getByRole('button', { name: '保存快照' }));
    // jsdom 不排版，点击后光标在段首。
    await typeAndSave(user, '加一句。', '加一句。初稿。');

    await user.click(screen.getByRole('button', { name: '版本快照' }));
    const list = await screen.findByRole('list', { name: '快照列表' });
    const entries = within(list).getAllByRole('button');
    expect(entries).toHaveLength(1);
    await user.click(entries[0] as HTMLElement);
    const preview = await screen.findByRole('region', { name: '快照内容' });
    expect(within(preview).getByText('初稿。')).toBeTruthy();
    expect(within(preview).getByText(/手动保存/)).toBeTruthy();

    await user.click(within(preview).getByRole('button', { name: '恢复到这个版本' }));
    await user.click(within(preview).getByRole('button', { name: '确定恢复' }));
    await waitFor(() => expect(editorText()).toBe('初稿。'));

    // 恢复前的现稿存成了快照。
    await user.click(screen.getByRole('button', { name: '版本快照' }));
    const after = within(await screen.findByRole('list', { name: '快照列表' })).getAllByRole('button');
    expect(after.map((b) => b.textContent)).toEqual([expect.stringContaining('恢复前自动保存'), expect.stringContaining('手动保存')]);
    await user.click(after[0] as HTMLElement);
    await user.click(await screen.findByRole('button', { name: '恢复到这个版本' }));
    await user.click(screen.getByRole('button', { name: '确定恢复' }));
    await waitFor(() => expect(editorText()).toBe('加一句。初稿。'));
  });

  it('取消恢复时什么也不变；返回正文', async () => {
    const { user } = start();
    await createWork(user, '雨夜');
    await addChapter(user, '第一章');
    await typeAndSave(user, '一句。', '一句。');
    await user.click(screen.getByRole('button', { name: '保存快照' }));
    await user.click(screen.getByRole('button', { name: '版本快照' }));
    await user.click(within(await screen.findByRole('list', { name: '快照列表' })).getAllByRole('button')[0] as HTMLElement);
    await user.click(await screen.findByRole('button', { name: '恢复到这个版本' }));
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.getByRole('button', { name: '恢复到这个版本' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '返回正文' }));
    await waitFor(() => expect(editorText()).toBe('一句。'));
  });
});

describe('导入、导出与备份', () => {
  const novel = '第一章 雨夜\n　　雨下得更紧了。\n第二章 当铺\n　　掌柜抬起头。';

  it('导入 TXT 为新作品：预览拆分结果，可改拆分方式与编码，确认后打开作品', async () => {
    const { deps, user } = start();
    deps.textPicks.push({ fileName: '雨夜.txt', text: novel });
    await user.click(await screen.findByRole('button', { name: '导入 TXT/Markdown' }));
    const dialog = await screen.findByRole('dialog', { name: '导入预览' });
    expect(within(dialog).getByText('共 2 章，13 字')).toBeTruthy();
    await user.click(within(dialog).getByRole('radio', { name: '不拆分，整篇为一章' }));
    expect(within(dialog).getByText('共 1 章，23 字')).toBeTruthy();
    await user.click(within(dialog).getByRole('radio', { name: /自动识别章节标题/ }));
    await user.selectOptions(within(dialog).getByRole('combobox', { name: '编码' }), 'GB18030');
    expect(await within(dialog).findByText(/无法按这种编码识别/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: '导入' }));
    await waitFor(() => expect(chapterTitles()).toEqual(['第一章 雨夜', '第二章 当铺']));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: '雨夜' })).toBeTruthy();
  });

  it('作品中导入章节，追加到目录末尾；取消导入什么也不写', async () => {
    const { deps, user } = start();
    await createWork(user, '雨夜');
    await addChapter(user, '楔子');
    deps.textPicks.push({ fileName: '续写.txt', text: novel }, { fileName: '不要.txt', text: novel });
    await user.click(screen.getByText('更多'));
    await user.click(screen.getByRole('menuitem', { name: '导入章节（TXT/Markdown）' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '导入' }));
    await waitFor(() => expect(chapterTitles()).toEqual(['楔子', '第一章 雨夜', '第二章 当铺']));
    // 菜单选过一项后就收起，再打开一次。
    await user.click(screen.getByText('更多'));
    await user.click(screen.getByRole('menuitem', { name: '导入章节（TXT/Markdown）' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '取消' }));
    expect(chapterTitles()).toEqual(['楔子', '第一章 雨夜', '第二章 当铺']);
  });

  it('导出整本、本章与作品包', async () => {
    const { deps, user } = start();
    deps.textPicks.push({ fileName: '雨夜.txt', text: novel });
    await user.click(await screen.findByRole('button', { name: '导入 TXT/Markdown' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '导入' }));
    await waitFor(() => expect(chapterTitles()).toHaveLength(2));
    await user.click(screen.getByText('更多'));
    await user.click(screen.getByRole('menuitem', { name: '导出整本 TXT' }));
    await user.click(screen.getByText('更多'));
    await user.click(screen.getByRole('menuitem', { name: '导出作品包' }));
    await user.click(await screen.findByRole('button', { name: '导出 TXT' }));
    await waitFor(() => expect(deps.exported.map((e) => e.name)).toEqual(['雨夜.txt', '第一章 雨夜.txt']));
    expect(deps.exportedPackages[0]?.files.map((f) => f.path)).toContain('chapters/0002-第二章 当铺.md');
  });

  it('备份与恢复：立即备份，修改后恢复，目录与设定回到备份时', async () => {
    const { user, store } = start();
    await createWork(user, '雨夜');
    await addChapter(user, '第一章');
    await user.click(screen.getByText('更多'));
    await user.click(screen.getByRole('menuitem', { name: '备份与恢复' }));
    await user.click(await screen.findByRole('button', { name: '立即备份' }));
    const list = await screen.findByRole('list', { name: '备份列表' });
    expect(within(list).getByText('手动备份')).toBeTruthy();
    await addChapter(user, '第二章');
    expect(chapterTitles()).toEqual(['第一章', '第二章']);
    await store.getState().createEntity('character', '林舟');
    expect(store.getState().entities.map((e) => e.name)).toEqual(['林舟']);
    await user.click(screen.getByText('更多'));
    await user.click(screen.getByRole('menuitem', { name: '备份与恢复' }));
    await user.click(await screen.findByRole('button', { name: /恢复到 .* 的备份/ }));
    await user.click(screen.getByRole('button', { name: '确定恢复' }));
    await waitFor(() => expect(chapterTitles()).toEqual(['第一章']));
    // 设定列表也回到备份时（备份之后建的人物不在了）。
    await waitFor(() => expect(store.getState().entities).toEqual([]));
    expect(within(screen.getByRole('list', { name: '备份列表' })).getByText('恢复前自动备份')).toBeTruthy();
  });

  it('打开已有作品时自动备份一次', async () => {
    const { user } = start();
    await createWork(user, '雨夜');
    await user.click(screen.getByRole('button', { name: '作品列表' }));
    await user.click(await screen.findByRole('button', { name: '雨夜' }));
    await screen.findByRole('navigation', { name: '章节目录' });
    await user.click(screen.getByText('更多'));
    await user.click(screen.getByRole('menuitem', { name: '备份与恢复' }));
    const list = await screen.findByRole('list', { name: '备份列表' });
    expect(within(list).getAllByText('自动备份')).toHaveLength(1);
  });
});

describe('设定', () => {
  const editorText = () => screen.getByRole('textbox', { name: '正文' }).textContent;

  async function newEntity(user: ReturnType<typeof userEvent.setup>, kind: string, name: string) {
    await user.click(screen.getByRole('button', { name: '新建设定' }));
    await user.selectOptions(screen.getByRole('combobox', { name: '新设定的种类' }), kind);
    await user.type(screen.getByRole('textbox', { name: '新设定的名字' }), `${name}{Enter}`);
    await screen.findByRole('form', { name: '设定内容' });
  }

  it('新建人物与地点，填写别名与属性；正文中高亮名字与别名；设定卡片显示内容', async () => {
    const { store, user } = start();
    await createWork(user, '雨夜');
    await addChapter(user, '第一章');
    await user.click(screen.getByRole('button', { name: '设定' }));
    await newEntity(user, '人物', '沈砚');
    const form = screen.getByRole('form', { name: '设定内容' });
    await user.type(within(form).getByRole('textbox', { name: '别名（用顿号分隔）' }), '沈先生');
    await user.type(within(form).getByRole('textbox', { name: '说明' }), '当铺常客');
    await user.click(within(form).getByRole('button', { name: '添加属性' }));
    await user.type(within(form).getByRole('textbox', { name: '属性名 1' }), '年龄');
    await user.type(within(form).getByRole('textbox', { name: '属性值 1' }), '二十八');
    await user.click(within(form).getByRole('button', { name: '保存设定' }));
    await waitFor(() => expect(store.getState().entities[0]).toMatchObject({ aliases: ['沈先生'], attributes: [{ label: '年龄', value: '二十八' }] }));
    await newEntity(user, '地点', '当铺');
    expect(within(screen.getByRole('list', { name: '设定列表' })).getAllByRole('button').map((b) => b.textContent)).toEqual(['沈砚人物', '当铺地点']);

    await user.click(screen.getByRole('button', { name: '返回正文' }));
    await user.click(await screen.findByRole('textbox', { name: '正文' }));
    await user.keyboard('沈先生走进当铺。');
    await waitFor(() => expect(editorText()).toBe('沈先生走进当铺。'));
    const body = screen.getByRole('textbox', { name: '正文' });
    await waitFor(() => expect([...body.querySelectorAll('[data-entity-id]')].map((e) => e.textContent)).toEqual(['沈先生', '当铺']));

    // Ctrl + 点击由编辑器扩展调用 openEntityDrawer（扩展测试已覆盖点击判断）。
    store.getState().openEntityDrawer(store.getState().entities[0]?.id ?? null);
    const card = await screen.findByRole('complementary', { name: '设定卡片' });
    expect(within(card).getByText('当铺常客')).toBeTruthy();
    expect(within(card).getByText('别名：沈先生')).toBeTruthy();
    await user.click(within(card).getByRole('button', { name: '在设定中编辑' }));
    expect(await screen.findByRole('form', { name: '设定内容' })).toBeTruthy();
  });

  it('锁定后字段只读，解锁后才能修改；按种类筛选与查找', async () => {
    const { store, user } = start();
    await createWork(user, '雨夜');
    await user.click(screen.getByRole('button', { name: '设定' }));
    await newEntity(user, '世界规则', '城中宵禁');
    await user.click(screen.getByRole('button', { name: '锁定' }));
    const form = await screen.findByRole('form', { name: '设定内容' });
    await waitFor(() => expect(within(form).getByText('已锁定')).toBeTruthy());
    // 由外层 fieldset 禁用的控件 .disabled 仍为 false，要看 :disabled。
    expect(within(form).getByRole('textbox', { name: '说明' }).matches(':disabled')).toBe(true);
    await user.click(within(form).getByRole('button', { name: '解锁' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: '说明' }).matches(':disabled')).toBe(false));
    await user.type(screen.getByRole('textbox', { name: '说明' }), '子时起宵禁');
    await user.click(screen.getByRole('button', { name: '保存设定' }));
    await waitFor(() => expect(store.getState().entities[0]?.description).toBe('子时起宵禁'));

    await newEntity(user, '物品', '玉佩');
    await user.click(screen.getByRole('tab', { name: '物品' }));
    expect(within(screen.getByRole('list', { name: '设定列表' })).getAllByRole('button')).toHaveLength(1);
    await user.click(screen.getByRole('tab', { name: '全部' }));
    await user.type(screen.getByRole('textbox', { name: '查找设定' }), '宵禁');
    expect(within(screen.getByRole('list', { name: '设定列表' })).getAllByRole('button').map((b) => b.textContent)).toEqual(['城中宵禁世界规则']);
  });

  it('删除设定需要确认', async () => {
    const { store, user } = start();
    await createWork(user, '雨夜');
    await user.click(screen.getByRole('button', { name: '设定' }));
    await newEntity(user, '物品', '玉佩');
    await user.click(screen.getByRole('button', { name: '删除设定' }));
    await user.click(screen.getByRole('button', { name: '确定删除' }));
    await waitFor(() => expect(store.getState().entities).toEqual([]));
    expect(screen.getByText('还没有设定。')).toBeTruthy();
  });
});

describe('事实', () => {
  it('记录人物认知（持有者、来源方式、相信程度、依据）；确认；依据的设定修改后待复核，复核后重新确认', async () => {
    const { store, user } = start();
    await createWork(user, '雨夜');
    await user.click(screen.getByRole('button', { name: '设定' }));
    await user.click(screen.getByRole('button', { name: '新建设定' }));
    await user.type(screen.getByRole('textbox', { name: '新设定的名字' }), '沈砚{Enter}');
    await screen.findByRole('form', { name: '设定内容' });
    await user.click(screen.getByRole('button', { name: '新建设定' }));
    await user.selectOptions(screen.getByRole('combobox', { name: '新设定的种类' }), '地点');
    await user.type(screen.getByRole('textbox', { name: '新设定的名字' }), '当铺{Enter}');
    await waitFor(() => expect(store.getState().entities).toHaveLength(2));

    await user.click(screen.getByRole('button', { name: '事实' }));
    await user.click(await screen.findByRole('button', { name: '记录新事实' }));
    const form = await screen.findByRole('form', { name: '事实内容' });
    await user.selectOptions(within(form).getByRole('combobox', { name: '种类' }), '人物认知');
    await user.selectOptions(within(form).getByRole('combobox', { name: '持有者' }), '沈砚');
    await user.type(within(form).getByRole('textbox', { name: '内容' }), '掌柜认得那块玉');
    await user.selectOptions(within(form).getByRole('combobox', { name: '来源方式' }), '推测');
    await user.type(within(form).getByRole('textbox', { name: '相信程度（0 至 100）' }), '60');
    const basis = within(form).getByRole('group', { name: '依据的设定（修改后本事实需要复核）' });
    await user.click(within(basis).getByRole('checkbox', { name: '当铺' }));
    await user.click(within(form).getByRole('button', { name: '记录事实' }));
    await waitFor(() => expect(store.getState().facts).toHaveLength(1));
    expect(store.getState().facts[0]).toMatchObject({ kind: 'belief', modality: 'inferred', confidence: 0.6, status: 'candidate', basis: [{ type: 'entity' }] });

    await user.click(await screen.findByRole('button', { name: '确认' }));
    await waitFor(() => expect(store.getState().facts[0]?.status).toBe('confirmed'));

    // 修改依据的设定：事实变为待复核，顶栏提示。
    await user.click(screen.getByRole('button', { name: '设定' }));
    await user.click(within(await screen.findByRole('list', { name: '设定列表' })).getByRole('button', { name: /当铺/ }));
    await user.type(screen.getByRole('textbox', { name: '说明' }), '城北的老当铺');
    await user.click(screen.getByRole('button', { name: '保存设定' }));
    expect(await screen.findByRole('button', { name: '事实（待复核 1）' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '事实（待复核 1）' }));
    expect(await screen.findByText('设定“当铺”已修改')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '复核后确认' }));
    await waitFor(() => expect(store.getState().facts[0]?.status).toBe('confirmed'));
    expect(screen.queryByRole('button', { name: /待复核/ })).toBeNull();
  });

  it('表单校验：故事时间的排序值须为数字；按种类与状态筛选', async () => {
    const { store, user } = start();
    await createWork(user, '雨夜');
    await user.click(screen.getByRole('button', { name: '事实' }));
    await user.click(await screen.findByRole('button', { name: '记录新事实' }));
    await user.type(screen.getByRole('textbox', { name: '内容' }), '城中宵禁');
    await user.type(screen.getByRole('textbox', { name: '故事时间起' }), '第三年春');
    await user.type(screen.getByRole('textbox', { name: '起始排序值' }), '三');
    await user.click(screen.getByRole('button', { name: '记录事实' }));
    expect(screen.getByText('故事时间的排序值须为数字')).toBeTruthy();
    await user.clear(screen.getByRole('textbox', { name: '起始排序值' }));
    await user.type(screen.getByRole('textbox', { name: '起始排序值' }), '3');
    await user.click(screen.getByRole('button', { name: '记录事实' }));
    await waitFor(() => expect(store.getState().facts[0]?.validFrom).toEqual({ label: '第三年春', order: 3 }));
    await user.click(screen.getByRole('tab', { name: '人物说法' }));
    expect(screen.getByText('没有符合的事实。')).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: '世界事实' }));
    expect(within(screen.getByRole('list', { name: '事实列表' })).getAllByRole('button')).toHaveLength(1);
  });
});

describe('段落来源', () => {
  it('统计每章与全书的 AI 参与比例；正文中 AI 段落有来源色条，可在段落来源页关闭', async () => {
    const { deps, service, store, user } = start();
    await createWork(user, '雨夜');
    await addChapter(user, '第一章');
    await user.click(await screen.findByRole('textbox', { name: '正文' }));
    await user.keyboard('雨夜。');
    await waitFor(() => expect(store.getState().chapterContent?.saved.map((p) => p.text)).toEqual(['雨夜。']));
    const chapterId = store.getState().selectedChapterId ?? '';

    await user.click(screen.getByText('更多'));
    await user.click(screen.getByRole('menuitem', { name: '段落来源' }));
    await screen.findByRole('table', { name: '来源统计' });
    // M2 接受候选稿之前，用保存用例写入一段 AI 生成的段落。
    const opened = await service.openChapter(chapterId);
    if (!opened.ok) throw new Error('无法读取本章');
    const saved = await service.saveChapter(chapterId, opened.value.saved, [...opened.value.saved, { id: 'ai-1', text: '雨很大。', source: 'ai_generated' }], {
      splits: [],
      merges: [],
    });
    expect(saved.ok).toBe(true);

    await user.click(screen.getByText('更多'));
    await user.click(screen.getByRole('menuitem', { name: '段落来源' }));
    const table = await screen.findByRole('table', { name: '来源统计' });
    await waitFor(() => expect(within(table).getByRole('row', { name: /第一章/ }).textContent).toContain('57.1%'));
    expect(within(table).getByRole('row', { name: /全书/ }).textContent).toBe('全书757.1%3400');

    await user.click(screen.getByRole('button', { name: '第一章' }));
    await waitFor(() => expect(document.querySelector('.chapter-text p.source-ai_generated')?.textContent).toBe('雨很大。'));
    expect(document.querySelectorAll('.chapter-text p.source')).toHaveLength(1);

    await user.click(screen.getByText('更多'));
    await user.click(screen.getByRole('menuitem', { name: '段落来源' }));
    await user.click(await screen.findByRole('checkbox', { name: /显示来源色条/ }));
    await waitFor(() => expect((JSON.parse(readFileSync(deps.libraryFile, 'utf8')) as { preferences: unknown }).preferences).toMatchObject({ showParagraphSource: false, theme: 'system' }));
    await user.click(screen.getByRole('button', { name: '第一章' }));
    await screen.findByRole('textbox', { name: '正文' });
    expect(document.querySelectorAll('.chapter-text p.source')).toHaveLength(0);
  });
});

describe('全文查找', () => {
  it('Ctrl+F 打开查找页；按章节列出结果；点击结果打开章节并选中该处；回到查找页结果仍在', async () => {
    const { store, user } = start();
    await createWork(user, '雨夜');
    await addChapter(user, '第一章');
    await user.click(await screen.findByRole('textbox', { name: '正文' }));
    await user.keyboard('雨下得更紧了。{Enter}当铺的门半掩着。');
    await addChapter(user, '第二章');
    await user.click(await screen.findByRole('textbox', { name: '正文' }));
    // 未保存的正文也能查到：打开查找页前先保存。
    await user.keyboard('掌柜说当铺不收这个。');
    await user.keyboard('{Control>}f{/Control}');
    await screen.findByRole('region', { name: '全文查找' });
    await user.type(screen.getByRole('searchbox', { name: '查找内容' }), '当铺{Enter}');
    expect((await screen.findByRole('status')).textContent).toBe('共 2 处。');
    expect(screen.getByRole('region', { name: '第一章（1 处）' })).toBeTruthy();
    const second = screen.getByRole('region', { name: '第二章（1 处）' });

    await user.click(within(second).getByRole('button', { name: '掌柜说当铺不收这个。' }));
    await waitFor(() => expect(store.getState().selectedChapterId).toBe(store.getState().work?.chapters[1]?.id));
    await waitFor(() => expect(document.getSelection()?.toString()).toBe('当铺'));
    expect(store.getState().reveal).toBeNull();

    await user.click(screen.getByRole('button', { name: '查找' }));
    expect((await screen.findByRole('status')).textContent).toBe('共 2 处。');
    expect(screen.getByRole('searchbox', { name: '查找内容' })).toHaveProperty('value', '当铺');

    await user.clear(screen.getByRole('searchbox', { name: '查找内容' }));
    await user.type(screen.getByRole('searchbox', { name: '查找内容' }), '没有的词{Enter}');
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('没有找到“没有的词”。'));
  });
});

describe('模型服务', () => {
  it('添加服务并填写 API Key；添加模型成为默认；连接测试显示结果；API Key 不出现在界面上', async () => {
    const { deps, user } = start();
    await user.click(await screen.findByRole('button', { name: '模型服务' }));
    expect(await screen.findByText('还没有模型服务。')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '添加服务' }));
    const form = screen.getByRole('form', { name: '添加服务' });
    expect(within(form).getByRole('textbox', { name: '服务地址' })).toHaveProperty('value', 'https://api.anthropic.com');
    await user.type(within(form).getByLabelText('API Key'), 'sk-ant-secret-123');
    await user.click(within(form).getByRole('button', { name: '保存' }));

    const card = await screen.findByRole('region', { name: 'Anthropic' });
    expect(within(card).getByText(/API Key 已保存在系统凭据管理器/)).toBeTruthy();
    expect(document.body.innerHTML).not.toContain('sk-ant-secret-123');
    expect(deps.secrets.size).toBe(1);

    await user.type(within(card).getByRole('textbox', { name: 'Anthropic 的模型名称' }), 'model-a{Enter}');
    expect(await within(card).findByText('默认模型')).toBeTruthy();

    deps.llmResponses.push({ chunks: anthropicChunks('model-a', { text: ['好'], end: 'stop', usage: { input: 9, output: 1, cacheRead: 0 } }) });
    await user.click(within(card).getByRole('button', { name: '连接测试' }));
    await waitFor(() => expect(within(card).getByRole('status', { name: 'model-a 的连接测试' }).textContent).toMatch(/^连接正常：[\d,]+ 毫秒，模型 model-a$/));

    // 编辑时地址改了却没填 API Key：提示须重新填写，服务不变。
    await user.click(within(card).getByRole('button', { name: '编辑' }));
    const edit = screen.getByRole('form', { name: '编辑 Anthropic' });
    expect(within(edit).getByLabelText('API Key')).toHaveProperty('placeholder', '已保存；不更改请留空');
    const url = within(edit).getByRole('textbox', { name: '服务地址' });
    await user.clear(url);
    await user.type(url, 'https://proxy.example.test');
    await user.click(within(edit).getByRole('button', { name: '保存' }));
    expect(await screen.findByText('更改服务地址后须重新填写 API Key')).toBeTruthy();

    await user.click(within(edit).getByRole('button', { name: '取消' }));
    await user.click(screen.getByRole('button', { name: '返回' }));
    expect(await screen.findByRole('button', { name: '新建作品' })).toBeTruthy();
  });

  it('获取模型列表并添加；能力自检通过后显示结果', async () => {
    const { deps, user } = start();
    await user.click(await screen.findByRole('button', { name: '模型服务' }));
    await user.click(await screen.findByRole('button', { name: '添加服务' }));
    const form = screen.getByRole('form', { name: '添加服务' });
    await user.type(within(form).getByLabelText('API Key'), 'sk-ant-secret-123');
    await user.click(within(form).getByRole('button', { name: '保存' }));
    const card = await screen.findByRole('region', { name: 'Anthropic' });

    const listed = { type: 'model', id: 'model-y', display_name: '模型 Y', created_at: '2026-01-01T00:00:00Z', max_input_tokens: 100_000, max_tokens: 8_000, capabilities: null };
    deps.llmResponses.push({ body: JSON.stringify({ data: [listed], has_more: false, first_id: 'model-y', last_id: 'model-y' }) });
    await user.click(within(card).getByRole('button', { name: '获取模型列表' }));
    await user.click(await within(card).findByRole('button', { name: '添加 model-y' }));
    expect(await within(card).findByText('默认模型')).toBeTruthy();
    expect(within(card).getByText('没有可添加的模型。')).toBeTruthy();
    expect(within(card).getByRole('note', { name: '模型 Y 的能力' }).textContent).toContain('未自检');

    const good = JSON.stringify(SELF_TEST_EXPECTED);
    for (let i = 0; i < 3; i++) deps.llmResponses.push({ chunks: anthropicChunks('model-y', { text: [good], end: 'stop' }) });
    await user.click(within(card).getByRole('button', { name: '能力自检' }));
    await waitFor(() => expect(within(card).getByRole('note', { name: '模型 Y 的能力' }).textContent).toContain('自检通过'));
  });
});

describe('用量与费用', () => {
  it('列出本作品的模型调用：合计、按任务、最近的调用；没有价格时费用标为未知', async () => {
    const { deps, service, user } = start();
    await createWork(user, '雨夜');
    const saved = await service.saveProvider(null, { kind: 'openai_compatible', name: 'S', baseUrl: 'https://s.example.test/v1', authMethod: 'api_key', apiKey: 'sk' });
    if (!saved.ok) throw new Error('服务');
    await service.addModel(saved.value.providers[0]?.id ?? '', 'm');
    deps.llmResponses.push({ chunks: openaiChunks('m', { text: ['好'], end: 'stop', usage: { input: 10, output: 2, cacheRead: 0 } }) });
    const prompt = renderConnectionTest();
    if (!prompt.ok) throw new Error('模板');
    await service.runner.text({ prompt: prompt.value, maxOutputTokens: 64 });

    await user.click(screen.getByText('更多'));
    await user.click(screen.getByRole('menuitem', { name: '用量与费用' }));
    const totals = await screen.findByRole('table', { name: '用量合计' });
    expect(within(totals).getByRole('row', { name: /本作品/ }).textContent).toBe('本作品11002未知');
    expect(within(totals).getByRole('row', { name: /连接测试/ })).toBeTruthy();
    const recent = screen.getByRole('table', { name: '最近的调用' });
    expect(within(recent).getAllByRole('row')[1]?.textContent).toMatch(/连接测试mconnection_test v1完成10 \/ 2未知$/);
  });
});

describe('AI 上下文', () => {
  it('打开清单：列出前后文与出现的设定；作者移除后列入“没有用到”，再加入回来', async () => {
    const { service, store, user } = start();
    await createWork(user, '雨夜');
    await addChapter(user, '第一章');
    await user.click(await screen.findByRole('textbox', { name: '正文' }));
    await user.keyboard('沈砚走进当铺。');
    await waitFor(() => expect(store.getState().chapterContent?.saved.map((p) => p.text)).toEqual(['沈砚走进当铺。']));
    const created = await service.createEntity('character', '沈砚');
    if (!created.ok) throw new Error('设定');
    await service.updateEntity(created.value.created, { description: '当铺掌柜的旧友' });

    await user.click(screen.getByRole('button', { name: 'AI 上下文' }));
    const drawer = await screen.findByRole('complementary', { name: 'AI 上下文' });
    const used = within(drawer).getByRole('list', { name: '会用到的上下文' });
    expect(within(used).getByText('设定：沈砚')).toBeTruthy();
    expect(within(used).getByText('前文')).toBeTruthy();
    expect(within(drawer).getByRole('status').textContent).toMatch(/^已用 [\d,]+ \/ 预算 8,000 Token$/);

    await user.click(within(drawer).getByRole('button', { name: '移除 设定：沈砚' }));
    const unused = await within(drawer).findByRole('list', { name: '没有用到的上下文' });
    expect(within(unused).getByText(/作者移除/)).toBeTruthy();
    await user.click(within(unused).getByRole('button', { name: '加入 设定：沈砚' }));
    await waitFor(() => expect(within(within(drawer).getByRole('list', { name: '会用到的上下文' })).getByText(/作者加入/)).toBeTruthy());

    await user.click(within(drawer).getByRole('button', { name: '关闭 AI 上下文' }));
    expect(screen.queryByRole('complementary', { name: 'AI 上下文' })).toBeNull();
  });
});

describe('AI 写作', () => {
  async function ready() {
    const ctx = start();
    const { service, store, user } = ctx;
    await createWork(user, '雨夜');
    await addChapter(user, '第一章');
    await user.click(await screen.findByRole('textbox', { name: '正文' }));
    await user.keyboard('沈砚推开当铺的门。');
    await waitFor(() => expect(store.getState().chapterContent?.saved.map((p) => p.text)).toEqual(['沈砚推开当铺的门。']));
    const saved = await service.saveProvider(null, { kind: 'openai_compatible', name: 'S', baseUrl: 'https://s.example.test/v1', authMethod: 'api_key', apiKey: 'sk' });
    if (!saved.ok) throw new Error('服务');
    await service.addModel(saved.value.providers[0]?.id ?? '', 'm');
    return ctx;
  }

  it('没有选中文字时只能续写；完成的结果成为候选稿，可以复制、重试、接受与放弃', async () => {
    const { deps, store, user } = await ready();
    await user.click(screen.getByRole('button', { name: 'AI 写作' }));
    const drawer = await screen.findByRole('complementary', { name: 'AI 写作' });
    expect(within(drawer).getByText('没有选中文字：只能续写，从光标处接着写。')).toBeTruthy();
    expect(within(drawer).getByRole('button', { name: '改写' }).matches(':disabled')).toBe(true);

    deps.llmResponses.push({ chunks: openaiChunks('m', { text: ['柜台后', '没有人。'], end: 'stop' }) });
    await user.click(within(drawer).getByRole('button', { name: '续写' }));
    const result = await within(drawer).findByRole('region', { name: '生成结果' });
    await waitFor(() => expect(within(result).getByRole('status').textContent).toBe('续写：已完成'));
    const pending = await within(drawer).findByRole('region', { name: '本章待处理的候选稿' });
    expect(within(pending).getByRole('region', { name: '续写的候选稿' }).textContent).toContain('柜台后没有人。');
    await user.click(within(result).getByRole('button', { name: '复制' }));
    expect(deps.copied.at(-1)).toBe('柜台后没有人。');
    // 候选稿不会自动写入正文。
    expect(screen.getByRole('textbox', { name: '正文' }).textContent).toBe('沈砚推开当铺的门。');

    deps.llmResponses.push({ chunks: openaiChunks('m', { text: ['雨还在下。'], end: 'stop' }) });
    await user.click(within(result).getByRole('button', { name: '重试' }));
    await waitFor(() => expect(within(pending).getAllByRole('region', { name: '续写的候选稿' })).toHaveLength(2));

    // 接受较早的一份：另起一段写入正文，编辑器重新载入。
    const [newer, older] = within(pending).getAllByRole('region', { name: '续写的候选稿' });
    if (newer === undefined || older === undefined) throw new Error('候选稿');
    await user.click(within(older).getByRole('button', { name: '接受' }));
    await waitFor(() => expect(store.getState().chapterContent?.saved.map((p) => [p.text, p.source])).toEqual([
      ['沈砚推开当铺的门。', 'handwritten'],
      ['柜台后没有人。', 'ai_generated'],
    ]));
    await waitFor(() => expect(screen.getByRole('textbox', { name: '正文' }).textContent).toBe('沈砚推开当铺的门。柜台后没有人。'));

    // 另一份生成时的原文已经改变：接受时提示过期，不再列出。
    await user.click(within(newer).getByRole('button', { name: '接受' }));
    expect(await screen.findByText(/候选稿已过期/)).toBeTruthy();
    await waitFor(() => expect(within(drawer).queryByRole('region', { name: '本章待处理的候选稿' })).toBeNull());
  });

  it('修改候选稿后接受；放弃的候选稿不再列出', async () => {
    const { deps, store, user } = await ready();
    await user.click(screen.getByRole('button', { name: 'AI 写作' }));
    const drawer = await screen.findByRole('complementary', { name: 'AI 写作' });
    deps.llmResponses.push({ chunks: openaiChunks('m', { text: ['柜台后没有人。'], end: 'stop' }) }, { chunks: openaiChunks('m', { text: ['雨停了。'], end: 'stop' }) });
    await user.click(within(drawer).getByRole('button', { name: '续写' }));
    const pending = await within(drawer).findByRole('region', { name: '本章待处理的候选稿' });
    await user.click(within(drawer).getByRole('button', { name: '重试' }));
    await waitFor(() => expect(within(pending).getAllByRole('region', { name: '续写的候选稿' })).toHaveLength(2));

    const [second, first] = within(pending).getAllByRole('region', { name: '续写的候选稿' });
    if (second === undefined || first === undefined) throw new Error('候选稿');
    await user.click(within(second).getByRole('button', { name: '放弃' }));
    await waitFor(() => expect(within(pending).getAllByRole('region', { name: /候选稿/ })).toHaveLength(1));

    const card = within(pending).getByRole('region', { name: '续写的候选稿' });
    await user.click(within(card).getByRole('button', { name: '修改' }));
    const box = within(card).getByRole('textbox', { name: '修改候选稿' });
    await user.clear(box);
    await user.type(box, '柜台后没有人，只有一盏灯。');
    await user.click(within(card).getByRole('button', { name: '保存修改' }));
    await waitFor(() => expect(within(pending).getByText(/已修改/)).toBeTruthy());
    await user.click(within(within(pending).getByRole('region', { name: '续写的候选稿' })).getByRole('button', { name: '接受' }));
    await waitFor(() => expect(store.getState().chapterContent?.saved[1]).toMatchObject({ text: '柜台后没有人，只有一盏灯。', source: 'mixed' }));
  });

  it('生成中可以取消，保留已生成的部分', async () => {
    const { deps, user } = await ready();
    await user.click(screen.getByRole('button', { name: 'AI 写作' }));
    const drawer = await screen.findByRole('complementary', { name: 'AI 写作' });
    deps.llmResponses.push({ chunks: openaiChunks('m', { text: ['柜台后'], end: 'stop' }, { stopAfterText: true }), hang: true });
    await user.click(within(drawer).getByRole('button', { name: '续写' }));
    const result = await within(drawer).findByRole('region', { name: '生成结果' });
    await waitFor(() => expect(result.querySelector('.ai-text')?.textContent).toBe('柜台后'));
    await user.click(within(result).getByRole('button', { name: '取消' }));
    await waitFor(() => expect(within(result).getByRole('status').textContent).toBe('续写：已取消，保留已生成的部分'));
    expect(result.querySelector('.ai-text')?.textContent).toBe('柜台后');
  });
});

describe('任务中心', () => {
  it('选区操作登记为任务：进行中可在任务页取消并复制部分结果；完成的任务显示用量，没有价格时费用未知', async () => {
    const { deps, service, store, user } = start();
    await createWork(user, '雨夜');
    await addChapter(user, '第一章');
    await user.click(await screen.findByRole('textbox', { name: '正文' }));
    await user.keyboard('沈砚推开当铺的门。');
    await waitFor(() => expect(store.getState().chapterContent?.saved.map((p) => p.text)).toEqual(['沈砚推开当铺的门。']));
    const saved = await service.saveProvider(null, { kind: 'openai_compatible', name: 'S', baseUrl: 'https://s.example.test/v1', authMethod: 'api_key', apiKey: 'sk' });
    if (!saved.ok) throw new Error('服务');
    await service.addModel(saved.value.providers[0]?.id ?? '', 'm');

    await user.click(screen.getByRole('button', { name: 'AI 写作' }));
    const drawer = await screen.findByRole('complementary', { name: 'AI 写作' });
    deps.llmResponses.push({ chunks: openaiChunks('m', { text: ['柜台后'], end: 'stop' }, { stopAfterText: true }), hang: true });
    await user.click(within(drawer).getByRole('button', { name: '续写' }));
    await waitFor(() => expect(store.getState().tasks[0]?.text).toBe('柜台后'));

    await user.click(screen.getByRole('button', { name: '任务（1 进行中）' }));
    const list = await screen.findByRole('list', { name: '任务列表' });
    const item = within(list).getByRole('listitem', { name: '续写 · 第一章' });
    expect(item.textContent).toContain('进行中');
    await user.click(within(item).getByRole('button', { name: '取消 续写 · 第一章' }));
    await waitFor(() => expect(item.textContent).toContain('已取消'));
    expect(item.textContent).toContain('已收到 3 字');
    await user.click(within(item).getByRole('button', { name: '复制 续写 · 第一章 的结果' }));
    expect(deps.copied.at(-1)).toBe('柜台后');
    expect(screen.getByRole('button', { name: '任务' })).toBeTruthy();

    // 完成的任务：用量来自服务，费用未知（没有配置价格）。
    await user.click(screen.getByRole('button', { name: '第一章' }));
    await user.click(await screen.findByRole('button', { name: 'AI 写作' }));
    deps.llmResponses.push({ chunks: openaiChunks('m', { text: ['雨还在下。'], end: 'stop', usage: { input: 120, output: 6, cacheRead: 0 } }) });
    await user.click(within(await screen.findByRole('complementary', { name: 'AI 写作' })).getByRole('button', { name: '续写' }));
    await waitFor(() => expect(store.getState().tasks[0]?.status).toBe('done'));
    await user.click(screen.getByRole('button', { name: '任务' }));
    const done = within(await screen.findByRole('list', { name: '任务列表' })).getAllByRole('listitem')[0];
    expect(done?.textContent).toContain('已完成');
    expect(done?.textContent).toContain('输入 120、输出 6 Token，费用未知');
    await user.click(screen.getByRole('button', { name: '清除已结束的任务' }));
    expect(await screen.findByText('还没有任务。')).toBeTruthy();
  });
});


describe('写作技能界面（B61、B37）', () => {
  it('停用技能、改写并恢复指令、添加、导出、导入与删除自己的技能、编辑规避词表', async () => {
    const { user, service, deps } = start();
    await createWork(user, '雨夜');
    await user.click(screen.getByText('更多'));
    await user.click(screen.getByRole('menuitem', { name: '写作技能' }));
    const hook = await screen.findByRole('listitem', { name: '章末钩子' });

    await user.click(within(hook).getByRole('checkbox', { name: '章末钩子' }));
    await waitFor(() => expect(within(screen.getByRole('listitem', { name: '章末钩子' })).getByRole('checkbox')).toHaveProperty('checked', false));

    const box = within(screen.getByRole('listitem', { name: '章末钩子' })).getByRole('textbox');
    await user.clear(box);
    await user.type(box, '停在悬念上，不要总结。');
    await user.click(within(screen.getByRole('listitem', { name: '章末钩子' })).getByRole('button', { name: '保存' }));
    expect(await within(screen.getByRole('listitem', { name: '章末钩子' })).findByText('内置（已修改）')).toBeTruthy();
    await user.click(within(screen.getByRole('listitem', { name: '章末钩子' })).getByRole('button', { name: '恢复内置指令' }));
    expect(await within(screen.getByRole('listitem', { name: '章末钩子' })).findByText('内置')).toBeTruthy();

    // 逐项填写：字段与 SKILL.md 对应，适用说明（description）必填。
    const add = screen.getByRole('form', { name: '逐项填写技能' });
    await user.type(within(add).getByRole('textbox', { name: '名称' }), '对话节奏');
    await user.type(within(add).getByRole('textbox', { name: '标识（SKILL.md 的 name，可不填）' }), 'dialogue-rhythm');
    await user.type(within(add).getByRole('textbox', { name: '指令（可以用 Markdown）' }), '对话三句内要有动作。');
    expect(within(add).getByRole('button', { name: '添加' }).matches(':disabled')).toBe(true);
    await user.type(within(add).getByRole('textbox', { name: '适用说明（description：做什么、什么时候用）' }), '写对话时使用。');
    await user.click(within(add).getByRole('button', { name: '添加' }));
    const mine = await screen.findByRole('listitem', { name: '对话节奏' });
    expect(within(mine).getByText('自定义')).toBeTruthy();
    expect(within(mine).getByRole('textbox', { name: '对话节奏的适用说明' })).toHaveProperty('value', '写对话时使用。');
    // 内置技能显示模板里的适用说明。
    expect(within(screen.getByRole('listitem', { name: '章末钩子' })).getByText(/写每一章的结尾时使用/)).toBeTruthy();

    // 阶段（B75）：内置技能显示用在哪个阶段；自定义技能默认写章节，可以改为规划，至少留一个。
    expect(within(screen.getByRole('listitem', { name: '雪花写作法' })).getByText('用在规划')).toBeTruthy();
    expect(within(screen.getByRole('listitem', { name: '章末钩子' })).getByText('用在写章节')).toBeTruthy();
    const stages = within(screen.getByRole('listitem', { name: '对话节奏' })).getByRole('group', { name: '对话节奏用在' });
    expect(within(stages).getByRole('checkbox', { name: '写章节' })).toHaveProperty('checked', true);
    expect(within(stages).getByRole('checkbox', { name: '写章节' }).matches(':disabled')).toBe(true);
    await user.click(within(stages).getByRole('checkbox', { name: '规划' }));
    await waitFor(async () => {
      const view = await service.listWritingSkills();
      expect(view.ok && view.value.skills.find((s) => s.skill.key === 'dialogue-rhythm')?.skill.stages).toEqual(['planning', 'writing']);
    });
    await user.click(within(screen.getByRole('group', { name: '对话节奏用在' })).getByRole('checkbox', { name: '写章节' }));
    await waitFor(async () => {
      const view = await service.listWritingSkills();
      expect(view.ok && view.value.skills.find((s) => s.skill.key === 'dialogue-rhythm')?.skill.stages).toEqual(['planning']);
    });

    // 导出为 SKILL.md；导入别处的 SKILL.md。
    // 改阶段后这一项重新渲染，按名称重新取。
    await user.click(within(screen.getByRole('listitem', { name: '对话节奏' })).getByRole('button', { name: '导出 SKILL.md' }));
    await waitFor(() => expect(deps.exported.at(-1)?.content).toMatch(/^---\nname: dialogue-rhythm\ndescription: "写对话时使用。"\nmetadata:\n {2}title: "对话节奏"\n {2}stages: "planning"\n---\n\n对话三句内要有动作。\n$/));
    deps.textPicks.push({ fileName: 'SKILL.md', text: '---\nname: webnovel-pacing\ndescription: 写连载章节时使用。\n---\n\n开篇三百字内进入冲突。\n' });
    await user.click(screen.getByRole('button', { name: '导入 SKILL.md' }));
    const imported = await screen.findByRole('listitem', { name: 'webnovel-pacing' });
    expect(within(imported).getByRole('textbox', { name: 'webnovel-pacing的指令' })).toHaveProperty('value', '开篇三百字内进入冲突。');
    expect(await screen.findByText('已导入技能“webnovel-pacing”')).toBeTruthy();

    // 粘贴一份 SKILL.md 导入；标识重复时用粘贴的内容更新那项技能。
    await user.click(screen.getByRole('tab', { name: '粘贴 SKILL.md' }));
    const paste = screen.getByRole('form', { name: '粘贴技能' });
    await user.click(within(paste).getByRole('textbox', { name: 'SKILL.md 的内容' }));
    await user.paste('---\nname: scene-senses\ndescription: 开场与换场时使用。\nmetadata:\n  title: "场景五感"\n---\n\n写听见、摸到、闻到的。\n');
    await user.click(within(paste).getByRole('button', { name: '导入' }));
    const pastedSkill = await screen.findByRole('listitem', { name: '场景五感' });
    expect(within(pastedSkill).getByText('scene-senses')).toBeTruthy();
    expect(within(screen.getByRole('form', { name: '粘贴技能' })).getByRole('textbox', { name: 'SKILL.md 的内容' })).toHaveProperty('value', '');
    await user.click(within(screen.getByRole('form', { name: '粘贴技能' })).getByRole('textbox', { name: 'SKILL.md 的内容' }));
    await user.paste('这不是 SKILL.md');
    await user.click(within(screen.getByRole('form', { name: '粘贴技能' })).getByRole('button', { name: '导入' }));
    expect((await screen.findByRole('alert')).textContent).toContain('不是 SKILL.md：文件开头应是');

    // 逐项填写时标识不能与已有技能重复。
    await user.click(screen.getByRole('tab', { name: '逐项填写' }));
    const again = screen.getByRole('form', { name: '逐项填写技能' });
    await user.type(within(again).getByRole('textbox', { name: '名称' }), '另一个');
    await user.type(within(again).getByRole('textbox', { name: '标识（SKILL.md 的 name，可不填）' }), 'scene-senses');
    await user.type(within(again).getByRole('textbox', { name: '适用说明（description：做什么、什么时候用）' }), '说明');
    await user.type(within(again).getByRole('textbox', { name: '指令（可以用 Markdown）' }), '指令');
    await user.click(within(again).getByRole('button', { name: '添加' }));
    expect(await screen.findByText(/标识“scene-senses”已被“场景五感”使用/)).toBeTruthy();

    await user.click(within(screen.getByRole('listitem', { name: '对话节奏' })).getByRole('button', { name: '删除' }));
    await waitFor(() => expect(screen.queryByRole('listitem', { name: '对话节奏' })).toBeNull());

    const avoid = screen.getByRole('textbox', { name: '规避表达词表' });
    await user.clear(avoid);
    await user.type(avoid, '不禁{Enter}一抹');
    await user.click(screen.getByRole('button', { name: '保存词表' }));
    await waitFor(async () => {
      const view = await service.listWritingSkills();
      expect(view.ok && view.value.avoidPhrases).toEqual(['不禁', '一抹']);
    });
    await user.click(await screen.findByRole('button', { name: '恢复默认词表' }));
    expect(await screen.findByText(/现在用的是默认词表/)).toBeTruthy();
  });
});

describe('成书计划界面（B63、B65）', () => {
  it('由大纲生成计划草稿并采用；修改一章的计划；在账本中加一条伏笔', async () => {
    const { user, service, deps } = start();
    await createWork(user, '当铺夜谈');
    expect((await service.updateWorkInfo({ outline: '林舟深夜当玉，掌柜起疑；第二章真相揭晓。' })).ok).toBe(true);
    expect((await service.createEntity('character', '林舟')).ok).toBe(true);
    await addTestedModel(service, deps);
    const draft = {
      chapters: [
        { title: '第一章 夜叩', goal: '林舟当玉被压价', cast: ['林舟'], beats: ['叩门', '压价'], plant: ['玉佩的来历'], payoff: [], treatment: '', targetWords: 3000 },
        { title: '第二章 揭晓', goal: '真相揭晓', cast: ['林舟'], beats: ['对质'], plant: [], payoff: ['玉佩的来历'], treatment: '', targetWords: 3000 },
      ],
      foreshadows: [{ title: '玉佩的来历', content: '掌柜多看了一眼', reveal: '玉佩是父亲的遗物' }],
    };
    deps.llmResponses.push(reply(JSON.stringify(draft)));

    await user.click(screen.getByRole('button', { name: '计划' }));
    await user.click(await screen.findByRole('button', { name: '生成计划草稿' }));
    const preview = await screen.findByLabelText('草稿内容');
    expect(within(preview).getByText('第二章 揭晓')).toBeTruthy();
    await user.click(within(preview).getByRole('button', { name: '采用草稿' }));
    await waitFor(() => expect(chapterTitles()).toEqual(['第一章 夜叩', '第二章 揭晓']));

    const first = await screen.findByRole('listitem', { name: '第一章 夜叩' });
    await user.click(within(first).getByText('第一章 夜叩'));
    const form = within(first).getByRole('form', { name: '第一章 夜叩的计划' });
    const goal = within(form).getByRole('textbox', { name: '本章目标' });
    await user.clear(goal);
    await user.type(goal, '林舟当玉未成');
    await user.click(within(form).getByRole('button', { name: '保存计划' }));
    expect(await screen.findByText('：林舟当玉未成')).toBeTruthy();

    const ledger = screen.getByRole('region', { name: '伏笔账本' });
    expect(within(ledger).getByText('玉佩的来历')).toBeTruthy();
    await user.click(within(ledger).getByRole('button', { name: '新伏笔' }));
    const create = within(ledger).getByRole('form', { name: '新伏笔' });
    await user.type(within(create).getByRole('textbox', { name: '名称' }), '债主是谁');
    await user.click(within(create).getByRole('button', { name: '加入账本' }));
    expect(await within(ledger).findByText('债主是谁')).toBeTruthy();
  });
});

describe('写手成章界面（B59、B60）', () => {
  it('让写手写这一章：写作期间正文只读并显示进度；停下后可在计划中接着写；回退到写手写入前', async () => {
    const { user, service, store, deps } = start();
    await createWork(user, '当铺夜谈');
    await addChapter(user, '第一章 夜叩');
    await user.click(await screen.findByRole('textbox', { name: '正文' }));
    await user.keyboard('作者写的开头。');
    await waitFor(() => expect(store.getState().chapterContent?.saved.map((p) => p.text)).toEqual(['作者写的开头。']));
    const chapterId = store.getState().selectedChapterId ?? '';
    // 四个情节点、三千字：分两段写。
    expect((await service.savePlan(chapterId, { goal: '林舟当玉', castIds: [], beats: ['叩门', '压价', '起疑', '离开'], foreshadowPlant: [], foreshadowPayoff: [], treatment: '', targetWords: 3000 })).ok).toBe(true);
    await addTestedModel(service, deps);

    // 第一段写完，第二段的调用挂起。
    deps.llmResponses.push(reply('林舟又叩响了门。'), { chunks: openaiChunks('m', { text: ['钱四'], end: 'stop' }, { stopAfterText: true }), hang: true });
    await user.click(screen.getByRole('button', { name: '让写手写这一章' }));
    const banner = await screen.findByRole('status', { name: '写手进度' });
    await waitFor(() => expect(banner.textContent).toContain('已写 1 / 2 段'));
    expect(screen.queryByRole('textbox', { name: '正文' })).toBeNull();
    await waitFor(() => expect(screen.getByLabelText('正文（只读）').textContent).toBe('作者写的开头。林舟又叩响了门。'));

    await user.click(within(banner).getByRole('button', { name: '停下' }));
    expect(await screen.findByText(/已取消：“第一章 夜叩”写了 1 \/ 2 段，可以接着写/)).toBeTruthy();
    // 停下后正文可以编辑，没写完的那一段没有写入。
    await waitFor(() => expect(screen.getByRole('textbox', { name: '正文' }).textContent).toBe('作者写的开头。林舟又叩响了门。'));

    await user.click(screen.getByRole('button', { name: '计划' }));
    const actions = await screen.findByRole('group', { name: '第一章 夜叩的写作' });
    expect(actions.textContent).toContain('写作中（已写 1 / 2 段）');
    // 写完后接着整理这一章的长篇记忆。
    deps.llmResponses.push(reply('林舟转身走进雨里。'), reply(JSON.stringify({ summary: '林舟再访当铺，没有谈成，冒雨离开。', cast: [], foreshadows: [] })));
    await user.click(within(actions).getByRole('button', { name: '接着写' }));
    await waitFor(() => expect(screen.getByRole('group', { name: '第一章 夜叩的写作' }).textContent).toContain('已写'));
    await waitFor(() => expect(store.getState().writerJob).toBeNull());
    const written = await service.openChapter(chapterId);
    expect(written.ok && written.value.saved.map((p) => [p.text, p.source])).toEqual([
      ['作者写的开头。', 'handwritten'],
      ['林舟又叩响了门。', 'ai_generated'],
      ['林舟转身走进雨里。', 'ai_generated'],
    ]);
    // 写完的章节不再有“写这一章”，只能回退。
    const done = screen.getByRole('group', { name: '第一章 夜叩的写作' });
    expect(within(done).queryByRole('button', { name: /写这一章|接着写/ })).toBeNull();

    await user.click(within(done).getByRole('button', { name: '回退到写手写入前' }));
    await user.click(within(screen.getByRole('group', { name: '第一章 夜叩的写作' })).getByRole('button', { name: '确定回退' }));
    await waitFor(() => expect(screen.getByRole('group', { name: '第一章 夜叩的写作' }).textContent).toContain('待写'));
    const back = await service.openChapter(chapterId);
    expect(back.ok && back.value.saved.map((p) => p.text)).toEqual(['作者写的开头。']);
  });

  it('长篇记忆（B66）：写完一章自动生成，可以查看；正文变了标为待复核，可以重建', async () => {
    const { user, service, store, deps } = start();
    await createWork(user, '当铺夜谈');
    await addChapter(user, '第一章 夜叩');
    const chapterId = store.getState().selectedChapterId ?? '';
    const lin = await service.createEntity('character', '林舟');
    if (!lin.ok) throw new Error('设定');
    expect((await service.savePlan(chapterId, { goal: '林舟当玉', castIds: [lin.value.created.id], beats: ['叩门'], foreshadowPlant: [], foreshadowPayoff: [], treatment: '', targetWords: 1500 })).ok).toBe(true);
    await addTestedModel(service, deps);

    await user.click(screen.getByRole('button', { name: '计划' }));
    // 还没有正文的章节不显示长篇记忆。
    await screen.findByRole('group', { name: '第一章 夜叩的写作' });
    expect(screen.queryByRole('group', { name: '第一章 夜叩的长篇记忆' })).toBeNull();

    deps.llmResponses.push(reply('林舟叩响了门。'), reply(JSON.stringify({ summary: '林舟深夜叩响当铺的门。', cast: [{ name: '林舟', state: '站在当铺门外' }], foreshadows: [] })));
    await user.click(screen.getByRole('button', { name: '写下一章' }));
    const memory = await screen.findByRole('group', { name: '第一章 夜叩的长篇记忆' });
    await waitFor(() => expect(memory.textContent).toContain('长篇记忆：有效'));
    expect(memory.textContent).toContain('林舟深夜叩响当铺的门。');
    expect(within(within(memory).getByRole('list', { name: '人物状态' })).getByText('林舟：站在当铺门外')).toBeTruthy();
    expect(store.getState().tasks.map((t) => [t.kind, t.status])).toEqual(expect.arrayContaining([['writer', 'done'], ['memory', 'done']]));

    // 回退后正文变了：记忆待复核；这一章没有正文，不能重建。
    await user.click(screen.getByRole('button', { name: '回退到写手写入前' }));
    await user.click(screen.getByRole('button', { name: '确定回退' }));
    await waitFor(() => expect(screen.getByRole('group', { name: '第一章 夜叩的长篇记忆' }).textContent).toContain('待复核'));
    expect(within(screen.getByRole('group', { name: '第一章 夜叩的长篇记忆' })).getByRole('button', { name: '重建记忆' }).matches(':disabled')).toBe(true);

    // 重写后重建。
    deps.llmResponses.push(reply('门没有开。'), reply(JSON.stringify({ summary: '林舟叩门，门没有开。', cast: [], foreshadows: [] })));
    await user.click(screen.getByRole('button', { name: '写下一章' }));
    await waitFor(() => expect(screen.getByRole('group', { name: '第一章 夜叩的长篇记忆' }).textContent).toContain('林舟叩门，门没有开。'));
    expect(screen.getByRole('group', { name: '第一章 夜叩的长篇记忆' }).textContent).toContain('长篇记忆：有效');
  });

  it('长篇记忆没有生成时说明原因，不接着写后面的章节；之后可以单独生成', async () => {
    const { user, service, store, deps } = start();
    await createWork(user, '当铺夜谈');
    await addChapter(user, '第一章');
    await addChapter(user, '第二章');
    const [c1, c2] = store.getState().work?.chapters.map((c) => c.id) ?? [];
    if (c1 === undefined || c2 === undefined) throw new Error('章节');
    for (const id of [c1, c2]) {
      expect((await service.savePlan(id, { goal: '目标', castIds: [], beats: ['一'], foreshadowPlant: [], foreshadowPayoff: [], treatment: '', targetWords: 1500 })).ok).toBe(true);
    }
    await addTestedModel(service, deps);
    await user.click(screen.getByRole('button', { name: '计划' }));
    // 第一章写完，记忆的回复连续不符合格式。
    deps.llmResponses.push(reply('第一章的正文。'), reply('不是 JSON'), reply('不是 JSON'), reply('不是 JSON'));
    await user.click(await screen.findByRole('button', { name: '依次写完待写的 2 章' }));
    expect(await screen.findByText(/“第一章”已写完，但长篇记忆没有生成.*后面的 1 章没有接着写/)).toBeTruthy();
    await waitFor(() => expect(store.getState().writerJob).toBeNull());
    expect(screen.getByRole('group', { name: '第二章的写作' }).textContent).toContain('待写');
    expect(screen.getByRole('group', { name: '第一章的长篇记忆' }).textContent).toContain('长篇记忆：还没有');

    deps.llmResponses.push(reply(JSON.stringify({ summary: '第一章的梗概。', cast: [], foreshadows: [] })));
    await user.click(within(screen.getByRole('group', { name: '第一章的长篇记忆' })).getByRole('button', { name: '生成记忆' }));
    await waitFor(() => expect(screen.getByRole('group', { name: '第一章的长篇记忆' }).textContent).toContain('长篇记忆：有效'));
  });
});

describe('审核界面（B64）', () => {
  const conflict = { paragraph: 'P1', quote: '用左手稳稳接过茶盏', kind: 'setting_conflict', severity: 'high', evidence: ['E1'], description: '林舟左手有伤，接不稳茶盏', suggestion: '改用右手' };

  async function ready() {
    const ctx = start();
    const { service, store, user, deps } = ctx;
    await createWork(user, '当铺夜谈');
    await addChapter(user, '第一章');
    await user.click(await screen.findByRole('textbox', { name: '正文' }));
    await user.keyboard('林舟不禁叹了口气，用左手稳稳接过茶盏。');
    await waitFor(() => expect(store.getState().chapterContent?.saved.map((p) => p.text)).toEqual(['林舟不禁叹了口气，用左手稳稳接过茶盏。']));
    const lin = await service.createEntity('character', '林舟');
    if (!lin.ok) throw new Error('设定');
    expect((await service.updateEntity(lin.value.created, { description: '落魄书生，左手有伤' })).ok).toBe(true);
    await addTestedModel(service, deps);
    await user.click(screen.getByRole('button', { name: '审核' }));
    const drawer = await screen.findByRole('complementary', { name: '审核' });
    expect(within(drawer).getByRole('status').textContent).toContain('待处理的问题 0 条');
    return { ...ctx, drawer };
  }

  it('审核本章：列出问题、引文、依据与建议；点引文在正文中定位；忽略；交给写手修订后正文更新', async () => {
    const { deps, store, user, drawer } = await ready();
    deps.llmResponses.push(reply(JSON.stringify({ issues: [conflict, { ...conflict, quote: '正文里没有的话' }] })));
    await user.click(within(drawer).getByRole('button', { name: '审核本章' }));
    const issue = await within(drawer).findByRole('listitem', { name: '设定冲突问题' });
    expect(within(drawer).getByRole('status').textContent).toContain('模型提出的 1 条问题定位不到原文或依据，没有列出');
    expect(issue.textContent).toContain('严重 · 模型审核');
    expect(issue.textContent).toContain('林舟左手有伤，接不稳茶盏');
    expect(issue.textContent).toContain('建议：改用右手');
    expect(within(within(issue).getByRole('list', { name: '依据' })).getByText('设定 林舟：落魄书生，左手有伤')).toBeTruthy();

    await user.click(within(issue).getByRole('button', { name: '“用左手稳稳接过茶盏”' }));
    await waitFor(() => expect(document.getSelection()?.toString()).toBe('用左手稳稳接过茶盏'));

    // 程序检查的规避词问题：忽略后不再列出。
    const tone = within(drawer).getByRole('listitem', { name: 'AI 腔问题' });
    expect(tone.textContent).toContain('轻微 · 程序检查');
    await user.click(within(tone).getByRole('button', { name: '忽略' }));
    await waitFor(() => expect(within(drawer).queryByRole('listitem', { name: 'AI 腔问题' })).toBeNull());

    deps.llmResponses.push(reply('林舟叹了口气，用右手接过茶盏。'));
    await user.click(within(within(drawer).getByRole('listitem', { name: '设定冲突问题' })).getByRole('button', { name: '交给写手修订' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: '正文' }).textContent).toBe('林舟叹了口气，用右手接过茶盏。'));
    expect(store.getState().chapterContent?.saved.map((p) => p.source)).toEqual(['ai_generated']);
    await waitFor(() => expect(within(drawer).queryByRole('listitem', { name: '设定冲突问题' })).toBeNull());
    expect(within(drawer).getByRole('status').textContent).toContain('写手已修订这一段');
    expect(store.getState().tasks.map((t) => [t.kind, t.status])).toEqual(expect.arrayContaining([['review', 'done'], ['writer', 'done']]));
  });

  it('作者自己改了这一段：保存后它上面的问题不再列出', async () => {
    const { deps, store, user, drawer } = await ready();
    deps.llmResponses.push(reply(JSON.stringify({ issues: [conflict] })));
    await user.click(within(drawer).getByRole('button', { name: '审核本章' }));
    await within(drawer).findByRole('listitem', { name: '设定冲突问题' });
    await user.click(screen.getByRole('textbox', { name: '正文' }));
    await user.keyboard('他');
    await waitFor(() => expect(store.getState().chapterContent?.saved[0]?.text).toContain('他'));
    await waitFor(() => expect(within(drawer).queryAllByRole('listitem')).toHaveLength(0));
  });

  it('没有模型时只做程序检查，并说明模型审核没有完成的原因', async () => {
    const ctx = start();
    const { store, user } = ctx;
    await createWork(user, '当铺夜谈');
    await addChapter(user, '第一章');
    await user.click(await screen.findByRole('textbox', { name: '正文' }));
    await user.keyboard('林舟不禁叹了口气。');
    await waitFor(() => expect(store.getState().chapterContent?.saved).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: '审核' }));
    const drawer = await screen.findByRole('complementary', { name: '审核' });
    await user.click(within(drawer).getByRole('button', { name: '审核本章' }));
    expect(await within(drawer).findByRole('listitem', { name: 'AI 腔问题' })).toBeTruthy();
    expect(within(drawer).getByRole('status').textContent).toContain('只做了程序检查，模型审核没有完成：还没有设置默认模型');
  });
});

describe('成书流程看板（B65）', () => {
  const plan = { goal: '目标', castIds: [], beats: ['一'], foreshadowPlant: [], foreshadowPayoff: [], treatment: '', targetWords: 1500 };
  const memory = (summary: string) => reply(JSON.stringify({ summary, cast: [], foreshadows: [] }));
  const cells = (title: string) => within(screen.getByRole('row', { name: title })).getAllByRole('cell').map((c) => c.textContent);

  async function ready(titles: readonly string[]) {
    const ctx = start();
    const { service, store, user, deps } = ctx;
    await createWork(user, '当铺夜谈');
    for (const title of titles) await addChapter(user, title);
    const ids = store.getState().work?.chapters.map((c) => c.id) ?? [];
    for (const id of ids) expect((await service.savePlan(id, plan)).ok).toBe(true);
    await addTestedModel(service, deps);
    await user.click(screen.getByRole('button', { name: '计划' }));
    await screen.findByRole('table', { name: '各章进度' });
    return { ...ctx, ids };
  }

  it('按章显示计划、写作、长篇记忆与审核；排定一段章节并在写完后审核；从看板打开一章的问题', async () => {
    const { deps, store, user } = await ready(['第一章', '第二章', '第三章']);
    const board = screen.getByRole('region', { name: '成书进度' });
    expect(within(board).getByRole('status').textContent).toBe('共 3 章：有计划 3 章，已写 0 章，已审核 0 章；待处理的审核问题 0 条。');
    expect(cells('第一章').slice(0, 4)).toEqual(['有', '待写', '—', '—']);

    await user.selectOptions(within(board).getByRole('combobox', { name: '写到哪一章' }), '第二章');
    await user.click(within(board).getByRole('checkbox', { name: '写完后审核' }));
    deps.llmResponses.push(
      reply('林舟叩响了门。'),
      memory('林舟叩门。'),
      reply(JSON.stringify({ issues: [{ paragraph: 'P1', quote: '叩响了门', kind: 'pacing', severity: 'low', evidence: [], description: '开头太平', suggestion: '从门里的声音写起' }] })),
      reply('门开了。'),
      memory('门开了。'),
      reply(JSON.stringify({ issues: [] })),
    );
    await user.click(within(board).getByRole('button', { name: '排定这 2 章' }));
    await waitFor(() => expect(cells('第二章').slice(0, 4)).toEqual(['有', '已写', '有效', '已审核']));
    await waitFor(() => expect(store.getState().writerJob).toBeNull());
    expect(cells('第一章').slice(0, 4)).toEqual(['有', '已写', '有效', '待处理 1 条']);
    expect(cells('第三章').slice(0, 4)).toEqual(['有', '待写', '—', '—']);
    expect(within(board).getByRole('status').textContent).toBe('共 3 章：有计划 3 章，已写 2 章，已审核 2 章；待处理的审核问题 1 条。');
    expect(store.getState().tasks.filter((t) => t.status === 'done').map((t) => t.kind).sort()).toEqual(['memory', 'memory', 'review', 'review', 'writer', 'writer']);
    // 只剩一章待写：不再显示范围选择。
    expect(within(board).queryByRole('combobox', { name: '写到哪一章' })).toBeNull();

    await user.click(within(board).getByRole('button', { name: '查看第一章的问题' }));
    const drawer = await screen.findByRole('complementary', { name: '审核' });
    expect(within(drawer).getByRole('listitem', { name: '重复与节奏问题' }).textContent).toContain('开头太平');
    expect(screen.getByRole('textbox', { name: '正文' }).textContent).toBe('林舟叩响了门。');
  });

  it('审核没有完成时说明原因，不接着写后面的章节', async () => {
    const { deps, store, user } = await ready(['第一章', '第二章']);
    await user.click(screen.getByRole('checkbox', { name: '写完后审核' }));
    deps.llmResponses.push(reply('第一章的正文。'), memory('梗概。'), reply('不是 JSON'), reply('不是 JSON'), reply('不是 JSON'));
    await user.click(screen.getByRole('button', { name: '依次写完待写的 2 章' }));
    expect(await screen.findByText(/“第一章”已写完，但审核没有完成.*后面的 1 章没有接着写/)).toBeTruthy();
    await waitFor(() => expect(store.getState().writerJob).toBeNull());
    expect(cells('第一章').slice(0, 4)).toEqual(['有', '已写', '有效', '未审核']);
    expect(cells('第二章').slice(0, 4)).toEqual(['有', '待写', '—', '—']);
  });

  it('在看板上审核一章手写的正文：没有模型时只做程序检查，并说明原因', async () => {
    const { store, user } = start();
    await createWork(user, '当铺夜谈');
    await addChapter(user, '第一章');
    await user.click(await screen.findByRole('textbox', { name: '正文' }));
    await user.keyboard('林舟不禁叹了口气。');
    await waitFor(() => expect(store.getState().chapterContent?.saved).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: '计划' }));
    await screen.findByRole('table', { name: '各章进度' });
    expect(cells('第一章').slice(0, 4)).toEqual(['没有', '有正文', '没有', '未审核']);
    await user.click(screen.getByRole('button', { name: '审核第一章' }));
    await waitFor(() => expect(cells('第一章')[3]).toBe('待处理 1 条'));
    expect(await screen.findByText(/只做了程序检查，模型审核没有完成：还没有设置默认模型/)).toBeTruthy();
  });
});

describe('伏笔账本的状态建议（B63）', () => {
  it('埋设的章节写完后，账本提示“标为已埋”；确认后状态更新，提示消失', async () => {
    const { user, service, store, deps } = start();
    await createWork(user, '当铺夜谈');
    await addChapter(user, '第一章');
    const chapterId = store.getState().selectedChapterId ?? '';
    const added = await service.addForeshadow({ title: '玉佩的缺口', content: '钱四多看了一眼', reveal: '玉佩是钱四师父的遗作', plantChapterId: chapterId, plantAnchor: null, payoffChapterId: null, payoffAnchor: null, status: 'planned' });
    if (!added.ok) throw new Error('伏笔');
    const jade = added.value.foreshadows[0]?.id ?? '';
    expect((await service.savePlan(chapterId, { goal: '林舟当玉', castIds: [], beats: ['叩门'], foreshadowPlant: [jade], foreshadowPayoff: [], treatment: '', targetWords: 1500 })).ok).toBe(true);
    await addTestedModel(service, deps);

    await user.click(screen.getByRole('button', { name: '计划' }));
    const ledger = await screen.findByRole('region', { name: '伏笔账本' });
    expect(within(ledger).queryByRole('group', { name: '账本状态的建议' })).toBeNull();

    deps.llmResponses.push(reply('钱四多看了玉佩一眼。'), reply(JSON.stringify({ summary: '林舟当玉。', cast: [], foreshadows: [{ title: '玉佩的缺口', progress: '钱四对着缺口多看了一眼' }] })));
    await user.click(screen.getByRole('button', { name: '写下一章' }));
    const hint = await within(ledger).findByRole('group', { name: '账本状态的建议' });
    await waitFor(() => expect(hint.textContent).toContain('“第一章”已经写完，长篇记忆里的进展：钱四对着缺口多看了一眼'));
    await waitFor(() => expect(store.getState().writerJob).toBeNull());

    await user.click(within(screen.getByRole('region', { name: '伏笔账本' })).getByRole('button', { name: '标为已埋' }));
    await waitFor(() => expect(within(screen.getByRole('region', { name: '伏笔账本' })).queryByRole('group', { name: '账本状态的建议' })).toBeNull());
    expect(within(screen.getByRole('region', { name: '伏笔账本' })).getByRole('listitem', { name: '玉佩的缺口' }).textContent).toContain('已埋');
  });
});

describe('推演场景的编辑（B22、B23、B39）', () => {
  async function open() {
    const ctx = start();
    await createWork(ctx.user, '当铺夜谈');
    await ctx.user.click(screen.getByRole('button', { name: '推演' }));
    await screen.findByRole('region', { name: '角色推演' });
    return ctx;
  }

  it('从空白开始：填写角色卡、初始认知、秘密与物品；有不对的地方时列出来、不能保存；保存后再打开内容还在', async () => {
    const { user, service } = await open();
    expect(screen.getByText('还没有推演场景。')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '新建场景' }));
    await user.click(screen.getByRole('button', { name: '从空白开始' }));
    const form = await screen.findByRole('form', { name: '新场景' });
    const title = within(form).getByRole('textbox', { name: '场景名' });
    await user.clear(title);
    await user.type(title, '当铺谈判');

    // 角色卡。
    const actor = within(form).getByRole('listitem', { name: '角色 角色一' });
    await user.click(within(actor).getByText('角色一'));
    const name = within(actor).getByRole('textbox', { name: '名字' });
    await user.clear(name);
    await user.type(name, '林舟');
    const lin = within(form).getByRole('listitem', { name: '角色 林舟' });
    await user.type(within(lin).getByRole('textbox', { name: '目标' }), '把玉当个好价钱');
    await user.type(within(lin).getByRole('textbox', { name: '失控条件' }), '被当面质疑出身');
    await user.type(within(lin).getByRole('textbox', { name: '性格倾向（每行一条）' }), '好面子{Enter}嘴硬');

    // 初始认知：内容没填时是一处问题，不能保存。
    await user.click(within(lin).getByRole('button', { name: '添加初始认知' }));
    expect(within(form).getByRole('list', { name: '还不对的地方' }).textContent).toContain('角色 第 1 项 › 角色卡 › 初始认知 第 1 项 › 内容：没有填写');
    expect(within(form).getByRole('button', { name: '保存场景' }).matches(':disabled')).toBe(true);
    await user.type(within(lin).getByRole('textbox', { name: '内容' }), '玉是父亲留下的');
    await user.selectOptions(within(lin).getByRole('combobox', { name: '来源方式' }), '听说');

    // 物品与秘密。
    await user.click(within(form).getByRole('button', { name: '添加物品' }));
    const item = within(form).getByRole('listitem', { name: '物品 新物品' });
    const itemKey = within(item).getByRole('textbox', { name: '键' });
    await user.clear(itemKey);
    await user.type(itemKey, 'jade');
    await user.selectOptions(within(item).getByRole('combobox', { name: '位置' }), '在林舟身上');
    await user.click(within(item).getByRole('checkbox', { name: /藏着/ }));

    await user.click(within(form).getByRole('button', { name: '添加秘密' }));
    const secret = within(form).getByRole('listitem', { name: '秘密 secret_1' });
    await user.type(within(secret).getByRole('textbox', { name: /秘密的内容/ }), '玉佩是钱四师父的遗作');
    expect(within(form).getByRole('list', { name: '还不对的地方' }).textContent).toContain('秘密 第 1 项 › 涉及的对象');
    await user.type(within(secret).getByRole('textbox', { name: /涉及的对象/ }), 'jade');
    await user.click(within(secret).getByRole('checkbox', { name: '林舟' }));
    await waitFor(() => expect(within(form).queryByRole('list', { name: '还不对的地方' })).toBeNull());

    await user.click(within(form).getByRole('button', { name: '保存场景' }));
    const saved = await screen.findByRole('form', { name: '场景 当铺谈判' });
    expect(within(screen.getByRole('navigation', { name: '推演场景' })).getByRole('button', { name: /当铺谈判/ }).textContent).toContain('同时行动 · 8 回合');
    // 刚保存、没有改动时不用再保存。
    expect(within(saved).getByRole('button', { name: '保存场景' }).matches(':disabled')).toBe(true);

    const scenes = await service.listSimScenes();
    if (!scenes.ok) throw new Error('场景');
    expect(scenes.value[0]?.config).toMatchObject({
      actors: [
        {
          id: 'actor_1',
          name: '林舟',
          zone: 'room',
          card: { goal: '把玉当个好价钱', lossOfControl: '被当面质疑出身', traits: ['好面子', '嘴硬'], initialKnowledge: [{ text: '玉是父亲留下的', modality: 'heard' }] },
        },
      ],
      items: [{ id: 'jade', location: { kind: 'actor', actor: 'actor_1' }, concealed: true }],
      secrets: [{ id: 'secret_1', text: '玉佩是钱四师父的遗作', subjects: ['jade'], knownBy: ['actor_1'] }],
    });

    // 修改后保存：只改了协议，配置版本不变，记录版本加一。
    await user.selectOptions(within(saved).getByRole('combobox', { name: '回合协议' }), '轮流对话');
    await user.selectOptions(within(saved).getByRole('combobox', { name: '第一个开口的角色' }), '林舟');
    await user.click(within(saved).getByRole('button', { name: '保存场景' }));
    await waitFor(async () => {
      const again = await service.listSimScenes();
      expect(again.ok && again.value[0]).toMatchObject({ protocol: 'turn_based', firstSpeaker: 'actor_1', configVersion: 1, version: 2 });
    });
  });

  it('用一段话生成场景配置草稿：草稿里不对的地方列出来，改好后保存；也可以放弃草稿', async () => {
    const { user, service, deps, store } = await open();
    await addTestedModel(service, deps);
    await user.click(screen.getByRole('button', { name: '新建场景' }));
    const fresh = screen.getByRole('form', { name: '新建场景' });
    expect(within(fresh).getByRole('button', { name: '生成场景配置草稿' }).matches(':disabled')).toBe(true);
    await user.type(within(fresh).getByRole('textbox'), '雨夜，林舟到钱四的当铺当玉。');

    // 草稿里钱四所在的区域不存在。
    const draft = sceneDraftFixture();
    deps.llmResponses.push(reply(JSON.stringify({ ...draft, actors: draft.actors.map((a) => (a.id === 'qian_si' ? { ...a, zone: 'cellar' } : a)) })));
    await user.click(within(fresh).getByRole('button', { name: '生成场景配置草稿' }));
    const form = await screen.findByRole('form', { name: '新场景' });
    expect(within(form).getByRole('note').textContent).toContain('草稿里有 1 处需要你改一下才能保存');
    expect(within(form).getByRole('list', { name: '还不对的地方' }).textContent).toContain('角色 第 2 项 › 所在区域：引用了场景里没有的“cellar”');
    // 两个角色：默认轮流对话。
    expect(within(form).getByRole('combobox', { name: '回合协议' })).toHaveProperty('value', 'turn_based');
    expect(store.getState().tasks.map((t) => [t.kind, t.status])).toEqual(expect.arrayContaining([['scene_draft', 'done']]));

    const qian = within(form).getByRole('listitem', { name: '角色 钱四' });
    await user.click(within(qian).getByText('钱四'));
    expect(within(qian).getByRole('combobox', { name: /二阶认知/ })).toHaveProperty('value', 'lin_zhou');
    await user.selectOptions(within(qian).getByRole('combobox', { name: '所在区域' }), '后院');
    await waitFor(() => expect(within(form).queryByRole('list', { name: '还不对的地方' })).toBeNull());

    // 高级：整份配置可以直接看和改；不是合法的 JSON 时说明原因，表单不变。
    await user.click(within(form).getByText('高级：直接编辑整份场景配置'));
    const json = within(form).getByRole('textbox', { name: '场景配置（JSON）' });
    const config = JSON.parse((json as HTMLTextAreaElement).value) as { exits: string[] };
    expect(config.exits).toEqual(['yard']);
    await user.clear(json);
    await user.click(within(form).getByRole('button', { name: '应用到表单' }));
    expect(within(form).getByText(/不是合法的 JSON/)).toBeTruthy();

    const title = within(form).getByRole('textbox', { name: '场景名' });
    await user.clear(title);
    await user.type(title, '当铺');
    await user.click(within(form).getByRole('button', { name: '保存场景' }));
    await screen.findByRole('form', { name: '场景 当铺' });
    const scenes = await service.listSimScenes();
    expect(scenes.ok && scenes.value[0]?.config).toMatchObject({ actors: [{ id: 'lin_zhou' }, { id: 'qian_si', zone: 'yard' }], secrets: [{ id: 'origin' }], rules: { narrativeRules: ['当铺里不许动手'] } });

    // 再新建一个，从空白开始后放弃：回到描述局面的输入框，场景列表不变。
    await user.click(screen.getByRole('button', { name: '新建场景' }));
    await user.click(screen.getByRole('button', { name: '从空白开始' }));
    await user.click(screen.getByRole('button', { name: '放弃草稿' }));
    expect(screen.getByRole('form', { name: '新建场景' })).toBeTruthy();
    expect(within(screen.getByRole('navigation', { name: '推演场景' })).getAllByRole('listitem')).toHaveLength(1);
  });
});

describe('区域图的编辑（B41）', () => {
  it('添加区域、设置区域之间的关系与出口；改区域的键时角色的位置跟着改；保存后配置正确', async () => {
    const { user, service } = start();
    await createWork(user, '当铺夜谈');
    await user.click(screen.getByRole('button', { name: '推演' }));
    await user.click(await screen.findByRole('button', { name: '新建场景' }));
    await user.click(screen.getByRole('button', { name: '从空白开始' }));
    const form = await screen.findByRole('form', { name: '新场景' });
    const zones = within(form).getByRole('region', { name: '区域' });
    // 只有一个区域时没有关系表，也不能删。
    expect(within(zones).queryByRole('table', { name: '区域之间的关系' })).toBeNull();
    expect(within(zones).getByRole('button', { name: '删除区域 场地' }).matches(':disabled')).toBe(true);
    expect(within(zones).getByText('没有指定出口：角色可以从任何区域撤离。')).toBeTruthy();

    await user.click(within(zones).getByRole('button', { name: '添加区域' }));
    const added = within(zones).getByRole('row', { name: '区域 新区域' });
    const name = within(added).getByRole('textbox', { name: '区域的名字' });
    await user.clear(name);
    await user.type(name, '后院');
    const key = within(within(zones).getByRole('row', { name: '区域 后院' })).getByRole('textbox', { name: '区域的键' });
    await user.clear(key);
    await user.type(key, 'yard');

    const relation = within(within(zones).getByRole('table', { name: '区域之间的关系' })).getByRole('row', { name: '场地与后院' });
    await user.click(within(relation).getByRole('checkbox', { name: '场地与后院相邻' }));
    await user.selectOptions(within(relation).getByRole('combobox', { name: '场地与后院之间的声音' }), '减弱 1');
    await user.type(within(relation).getByRole('textbox', { name: '场地与后院通行所需的标记' }), 'door_open');
    await user.click(within(zones).getByRole('checkbox', { name: '可以从后院撤离' }));
    expect(within(zones).getByText('只能从勾选的区域撤离。')).toBeTruthy();

    // 改“场地”的键：角色所在的区域跟着改，没有出现引用不存在的区域的提示。
    const roomKey = within(within(zones).getByRole('row', { name: '区域 场地' })).getByRole('textbox', { name: '区域的键' });
    await user.clear(roomKey);
    await user.type(roomKey, 'shop{Enter}');
    // 改名之后角色的位置与关系的两端都跟着改了；剩下的一处是关系里用到的标记还没有定义。
    const problems = within(form).getByRole('list', { name: '还不对的地方' });
    expect(within(problems).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['区域之间的关系 第 1 项 › 通行所需的标记：引用了场景里没有的“door_open”']);

    // 标记在“高级”里定义：应用后表单随之更新，问题消失。

    await user.click(within(form).getByText('高级：直接编辑整份场景配置'));
    const json = within(form).getByRole('textbox', { name: '场景配置（JSON）' });
    const config = JSON.parse((json as HTMLTextAreaElement).value) as Record<string, unknown>;
    await user.clear(json);
    await user.click(json);
    await user.paste(JSON.stringify({ ...config, flags: { door_open: false } }));
    await user.click(within(form).getByRole('button', { name: '应用到表单' }));
    await waitFor(() => expect(within(form).queryByRole('list', { name: '还不对的地方' })).toBeNull());

    await user.click(within(form).getByRole('button', { name: '保存场景' }));
    await screen.findByRole('form', { name: '场景 新场景' });
    const scenes = await service.listSimScenes();
    expect(scenes.ok && scenes.value[0]?.config).toMatchObject({
      zones: [
        { id: 'shop', name: '场地' },
        { id: 'yard', name: '后院' },
      ],
      edges: [{ between: ['shop', 'yard'], adjacent: true, visible: false, sound: 1, requiresFlag: 'door_open' }],
      exits: ['yard'],
      flags: { door_open: false },
      actors: [{ id: 'actor_1', zone: 'shop' }],
    });

    // 取消相邻、声音与通行条件后，这条关系不再保存；删除后院，出口随之去掉。
    const saved = screen.getByRole('form', { name: '场景 新场景' });
    const row = within(saved).getByRole('row', { name: '场地与后院' });
    await user.click(within(row).getByRole('checkbox', { name: '场地与后院相邻' }));
    await user.selectOptions(within(row).getByRole('combobox', { name: '场地与后院之间的声音' }), '传不过去');
    await user.clear(within(row).getByRole('textbox', { name: '场地与后院通行所需的标记' }));
    await user.click(within(saved).getByRole('button', { name: '删除区域 后院' }));
    await user.click(within(saved).getByRole('button', { name: '保存场景' }));
    await waitFor(async () => {
      const again = await service.listSimScenes();
      expect(again.ok && again.value[0]).toMatchObject({ configVersion: 2, config: { zones: [{ id: 'shop' }], edges: [], exits: [] } });
    });
  });
});

/** 打开作品、配好默认模型（之后由测试模型应答）、存好废仓库场景，进入这个场景的“推演”。 */
/** 推演与写成正文的任务由测试模型应答；AI 助手等其余调用照常按排好的回复。 */
const SIMULATED: ReadonlySet<string> = new Set(['character_action', 'semantic_ruling', 'belief_update', 'judgement', 'beat_sheet', 'candidate_text', 'director']);

async function simReady(maxRounds = 3) {
  const base = fsDeps();
  let model: LlmPort | null = null;
  const deps: TestDeps = {
    ...base,
    llm: {
      forProvider: (provider) => ({
        complete: (request, options) => (model !== null && SIMULATED.has(request.task) ? model : base.llm.forProvider(provider)).complete(request, options),
      }),
    },
  };
  all.push(deps);
  const service = createAppService(deps);
  const store = createAppStore(service);
  render(<App store={store} />);
  const user = userEvent.setup();
  await createWork(user, '当铺夜谈');
  await addTestedModel(service, deps);
  const fake = fakeModel(dramaPolicy);
  model = fake.port;
  const saved = await service.saveSimScene(null, { chapterId: null, title: '废仓库', config: warehouseSpec(), protocol: 'simultaneous', maxRounds, firstSpeaker: null });
  if (!saved.ok) throw new Error('场景');
  await user.click(screen.getByRole('button', { name: '推演' }));
  await user.click(await screen.findByRole('button', { name: /废仓库/ }));
  await user.click(screen.getByRole('tab', { name: '推演' }));
  const runs = await screen.findByRole('region', { name: '推演运行' });
  return { deps, service, store, user, fake, runs };
}
const simStatus = () => screen.getByRole('region', { name: '推演工作区' }).querySelector('[role="status"]')?.textContent ?? '';

describe('推演工作区（B28）', () => {
  it('开始推演并继续到结束：时间线按回合显示全局局面与各角色所见；结束后不能再推进；列出等待时间', async () => {
    const { user, runs } = await simReady();
    expect(within(runs).getByText('这个场景还没有推演过。')).toBeTruthy();
    await user.click(within(runs).getByRole('button', { name: '开始新的推演' }));
    const workspace = await screen.findByRole('region', { name: '推演工作区' });
    expect(simStatus()).toContain('第 0 回合 · 可以继续 · 准备角色所见');
    expect(within(workspace).getByText('还没有完成的回合。')).toBeTruthy();

    await user.click(within(workspace).getByRole('button', { name: '继续' }));
    await waitFor(() => expect(simStatus()).toContain('已结束：到达回合上限'), { timeout: 10_000 });
    expect(simStatus()).toContain('已用 $0.0000');
    for (const name of ['单步', '继续', '暂停', '停止']) expect(within(workspace).getByRole('button', { name }).matches(':disabled')).toBe(true);
    expect(within(runs).getByRole('button', { name: /第 1 次 · 已结束/ })).toBeTruthy();

    // 默认跟着最新的一回合；点第一回合看当时的行动、内心片段与裁决。
    const rounds = within(workspace).getByRole('group', { name: '回合' });
    expect(within(rounds).getByRole('button', { name: '第 3 回合' }).getAttribute('aria-pressed')).toBe('true');
    await user.click(within(rounds).getByRole('button', { name: '第 1 回合' }));
    const global = within(workspace).getByLabelText('全局局面');
    const attack = within(global).getByRole('listitem', { name: '对手的行动' });
    expect(attack.textContent).toContain('攻击');
    expect(attack.textContent).toContain('内心：');
    expect(global.textContent).toContain('弩箭擦过');
    expect(global.textContent).toContain('自动接受');
    expect(within(global).getByRole('list', { name: '提示' }).textContent).toContain('缺少证据链');
    expect(within(within(global).getByRole('table', { name: '回合结束时的局面' })).getByRole('row', { name: /主角/ }).textContent).toContain('重伤');

    // 换成主角所见：只有他自己的处境与认知。
    await user.click(within(workspace).getByRole('tab', { name: '主角所见' }));
    const mine = within(workspace).getByLabelText('主角所见');
    expect(mine.textContent).toContain('重伤');
    expect(within(mine).getByRole('list', { name: '认知' }).querySelectorAll('li').length).toBeGreaterThan(0);
    expect(within(workspace).queryByLabelText('全局局面')).toBeNull();

    await user.click(within(workspace).getByText('等待时间'));
    expect(within(within(workspace).getByRole('table', { name: '等待时间' })).getAllByRole('row')).toHaveLength(4);

    // 校验回放：只读记录重算，与结束时记下的快照一致。
    await user.click(within(workspace).getByRole('button', { name: '校验回放' }));
    expect((await within(workspace).findByRole('note')).textContent).toBe('回放一致：1 个快照处重算的状态都与当时记下的相同。');
  });

  it('单步、暂停、继续与停止；可以开始第二次推演并在两次之间切换', async () => {
    const { user, runs, service, store } = await simReady();
    await user.click(within(runs).getByRole('button', { name: '开始新的推演' }));
    const workspace = await screen.findByRole('region', { name: '推演工作区' });
    await user.click(within(workspace).getByRole('button', { name: '单步' }));
    await waitFor(() => expect(store.getState().simRun?.view.run.lastSeq ?? 0).toBeGreaterThan(1));
    expect(simStatus()).toContain('可以继续');

    await user.click(within(workspace).getByRole('button', { name: '暂停' }));
    await waitFor(() => expect(simStatus()).toContain('已暂停：作者暂停'));
    expect(within(workspace).getByRole('button', { name: '暂停' }).matches(':disabled')).toBe(true);
    // 暂停后“继续”先恢复再推进。
    await user.click(within(workspace).getByRole('button', { name: '继续' }));
    await waitFor(() => expect(simStatus()).toContain('已结束：到达回合上限'), { timeout: 10_000 });
    const first = store.getState().simRunId ?? '';
    const events = await service.simRunEvents(first);
    expect(events.ok && events.value.map((e) => (e.payload as { type: string }).type).filter((t) => t === 'RunPaused' || t === 'RunResumed')).toEqual(['RunPaused', 'RunResumed']);

    // 第二次：走一步后停止，需要确认。
    await user.click(within(runs).getByRole('button', { name: '开始新的推演' }));
    await waitFor(() => expect(simStatus()).toContain('第 0 回合'));
    const again = screen.getByRole('region', { name: '推演工作区' });
    await user.click(within(again).getByRole('button', { name: '停止' }));
    expect(simStatus()).toContain('可以继续');
    await user.click(within(again).getByRole('button', { name: '确定停止' }));
    await waitFor(() => expect(simStatus()).toContain('已结束：作者停止'));
    expect(within(runs).getByRole('button', { name: /第 2 次 · 已结束/ })).toBeTruthy();

    // 切回第一次。
    await user.click(within(runs).getByRole('button', { name: /第 1 次 · 已结束/ }));
    await waitFor(() => expect(simStatus()).toContain('已结束：到达回合上限'));
    expect(store.getState().simRunId).toBe(first);
  });

  it('交互模式停在待核实的裁决上；没有价格时设预算会说明原因', async () => {
    const { user, runs } = await simReady();
    await user.type(within(runs).getByRole('spinbutton', { name: /预算上限/ }), '1');
    await user.click(within(runs).getByRole('button', { name: '开始新的推演' }));
    expect(await screen.findByText(/默认模型没有配置价格，预算上限无法生效/)).toBeTruthy();
    expect(screen.queryByRole('region', { name: '推演工作区' })).toBeNull();

    await user.clear(within(runs).getByRole('spinbutton', { name: /预算上限/ }));
    await user.selectOptions(within(runs).getByRole('combobox', { name: '模式' }), 'interactive');
    await user.click(within(runs).getByRole('button', { name: '开始新的推演' }));
    const workspace = await screen.findByRole('region', { name: '推演工作区' });
    await user.click(within(workspace).getByRole('button', { name: '继续' }));
    expect(await within(workspace).findByText('有 1 条待核实的裁决等你确认。', undefined, { timeout: 10_000 })).toBeTruthy();
    expect(simStatus()).toContain('等待作者');
    expect(within(workspace).getByRole('button', { name: '继续' }).matches(':disabled')).toBe(true);
  });
});

describe('待核实裁决、作者介入与分支的界面（B26、B30）', () => {
  it('交互模式：列出待核实的裁决，接受后继续；修改后的裁决不合规则时说明原因', async () => {
    const { user, runs, store } = await simReady();
    await user.selectOptions(within(runs).getByRole('combobox', { name: '模式' }), 'interactive');
    await user.click(within(runs).getByRole('button', { name: '开始新的推演' }));
    const workspace = await screen.findByRole('region', { name: '推演工作区' });
    await user.click(within(workspace).getByRole('button', { name: '继续' }));
    const pending = await within(workspace).findByRole('region', { name: '等你处理' }, { timeout: 10_000 });
    const card = within(pending).getByRole('listitem', { name: '待核实的裁决' });
    expect(card.textContent).toContain('弩箭擦过');
    expect(within(card).getByRole('list', { name: '效果' }).textContent).toContain('主角的伤势变为“重伤”');

    // 改成不合规则的内容：说明原因，仍在等待。
    await user.click(within(card).getByText('修改后确认'));
    const box = within(card).getByRole('textbox', { name: '裁决内容（JSON）' });
    await user.clear(box);
    await user.click(box);
    await user.paste('{"rationale":"x"}');
    await user.click(within(card).getByRole('button', { name: '按修改后的内容确认' }));
    expect(await screen.findByText(/改过的裁决格式不对/)).toBeTruthy();
    expect(simStatus()).toContain('等待作者');

    await user.click(within(screen.getByRole('listitem', { name: '待核实的裁决' })).getByRole('button', { name: '接受这条裁决' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: '等你处理' })).toBeNull());
    expect(simStatus()).toContain('可以继续');
    await user.click(within(workspace).getByRole('button', { name: '继续' }));
    await waitFor(() => expect(simStatus()).toContain('已结束：到达回合上限'), { timeout: 10_000 });
    expect(store.getState().simRun?.data?.rounds[0]?.rulings[0]).toMatchObject({ by: 'author' });
  });

  it('作者介入：给角色加一条认知并写明原因；介入前的局面成为可以分支的时点，从那里分出新的推演', async () => {
    const { user, runs, store, service } = await simReady();
    await user.click(within(runs).getByRole('button', { name: '开始新的推演' }));
    const workspace = await screen.findByRole('region', { name: '推演工作区' });
    await user.click(within(workspace).getByText('作者介入'));
    const form = within(workspace).getByRole('form', { name: '作者介入' });
    // 没有写原因时不能介入。
    expect(within(form).getByRole('button', { name: '介入' }).matches(':disabled')).toBe(true);
    await user.selectOptions(within(form).getByRole('combobox', { name: '角色' }), '主角');
    await user.type(within(form).getByRole('textbox', { name: /让他多知道一件事/ }), '有人在南门埋了绊线');
    await user.type(within(form).getByRole('textbox', { name: /涉及的对象/ }), 'south_gate');
    await user.type(within(form).getByRole('textbox', { name: /介入的原因/ }), '让他提前听到风声');
    await user.click(within(form).getByRole('button', { name: '介入' }));
    await waitFor(() => expect(store.getState().simRun?.knowledge['protagonist']?.map((k) => k.text)).toContain('有人在南门埋了绊线'));
    // 加上的认知出现在“撤回”的选项里；原因清空，可以接着做下一次介入。
    expect(within(form).getByRole('checkbox', { name: '有人在南门埋了绊线' })).toBeTruthy();
    expect(within(form).getByRole('textbox', { name: /介入的原因/ })).toHaveProperty('value', '');
    const original = store.getState().simRunId ?? '';

    // 回合进行中不能加外部事件：说明原因。
    await user.click(within(workspace).getByRole('button', { name: '单步' }));
    await user.click(within(workspace).getByRole('button', { name: '单步' }));
    await waitFor(() => expect(store.getState().simAdvancing).toBe(false));
    await user.selectOptions(within(form).getByRole('combobox', { name: '介入方式' }), 'external_event');
    await user.type(within(form).getByRole('textbox', { name: '看到的是什么' }), '灯笼掉了下来');
    await user.type(within(form).getByRole('textbox', { name: /介入的原因/ }), '试试');
    await user.click(within(form).getByRole('button', { name: '介入' }));
    expect(await screen.findByText(/外部事件只能加在两个回合之间/)).toBeTruthy();

    // 从介入前分出新的推演。
    await user.click(within(workspace).getByText('分支'));
    await user.click(within(workspace).getByRole('button', { name: '从第 0 回合作者介入之前分出新的推演' }));
    await waitFor(() => expect(store.getState().simRunId).not.toBe(original));
    expect(within(runs).getByRole('button', { name: /第 2 次 · 进行中 · 第 0 回合 · 分支/ })).toBeTruthy();
    const forked = store.getState().simRunId ?? '';
    const events = await service.simRunEvents(forked);
    expect(events.ok && events.value.map((e) => (e.payload as { type: string }).type)).toEqual(['RunStarted']);
    // 分支上没有那次介入。
    expect(store.getState().simRun?.knowledge['protagonist']?.map((k) => k.text)).not.toContain('有人在南门埋了绊线');
    await user.click(within(screen.getByRole('region', { name: '推演工作区' })).getByRole('button', { name: '继续' }));
    await waitFor(() => expect(simStatus()).toContain('已结束：到达回合上限'), { timeout: 10_000 });
  });
});

describe('推演写成正文的界面（B29、B45）', () => {
  it('生成节拍表、修改处理方式与文风、写成正文：结果是这一章的候选稿，在“AI 写作”里复核裁决、选定事件后采纳', async () => {
    const { user, runs, store } = await simReady();
    await user.click(within(runs).getByRole('button', { name: '开始新的推演' }));
    const workspace = await screen.findByRole('region', { name: '推演工作区' });
    await user.click(within(workspace).getByRole('button', { name: '继续' }));
    await waitFor(() => expect(simStatus()).toContain('已结束'), { timeout: 10_000 });

    // 先建一章：推演写成的正文要接在某一章末尾。
    await addChapter(user, '第一章 夜雨');
    await user.click(screen.getByRole('button', { name: '推演' }));
    await user.click(await screen.findByRole('button', { name: /废仓库/ }));
    await user.click(screen.getByRole('tab', { name: '推演' }));
    const again = await screen.findByRole('region', { name: '推演工作区' });

    await user.click(within(again).getByText('写成正文'));
    const form = within(again).getByRole('form', { name: '生成节拍表' });
    await user.selectOptions(within(form).getByRole('combobox', { name: '视角角色' }), '主角');
    await user.selectOptions(within(form).getByRole('combobox', { name: '从第几回合' }), '1');
    await user.selectOptions(within(form).getByRole('combobox', { name: '到第几回合' }), '2');
    await user.click(within(form).getByRole('button', { name: '生成节拍表' }));
    const sheet = await within(again).findByRole('form', { name: '主角视角的节拍表' });
    const rows = within(within(sheet).getByRole('table', { name: '节拍' })).getAllByRole('row').slice(1);
    expect(rows.length).toBeGreaterThan(0);
    expect(store.getState().tasks.map((t) => [t.kind, t.status])).toEqual(expect.arrayContaining([['beat_sheet', 'done']]));

    // 改了没保存时不能写。
    await user.selectOptions(within(rows[0]!).getByRole('combobox', { name: '处理' }), '展开');
    await user.type(within(sheet).getByRole('textbox', { name: /文风/ }), '冷峻');
    expect(within(sheet).getByRole('button', { name: '按节拍表写成正文' }).matches(':disabled')).toBe(true);
    await user.click(within(sheet).getByRole('button', { name: '保存节拍表' }));
    await waitFor(() => expect(store.getState().beatSheets[0]?.sheet).toMatchObject({ style: '冷峻', version: 2 }));
    expect(store.getState().beatSheets[0]?.beats[0]?.treatment).toBe('expand');

    const saved = within(screen.getByRole('region', { name: '推演工作区' })).getByRole('form', { name: '主角视角的节拍表' });
    await user.click(within(saved).getByRole('button', { name: '按节拍表写成正文' }));
    const note = await within(screen.getByRole('region', { name: '推演工作区' })).findByRole('note');
    expect(note.textContent).toContain('已在“第一章 夜雨”末尾生成候选稿，采纳后才写入正文。');

    await user.click(within(note).getByRole('button', { name: '打开这一章看候选稿' }));
    const drawer = await screen.findByRole('complementary', { name: 'AI 写作' });
    const card = await within(drawer).findByRole('region', { name: '推演写成正文的候选稿' });
    expect(card.textContent).toContain('雨下得更紧了。他没有回头。');
    // 推演写成的正文没有“接受”，要经采纳。
    expect(within(card).queryByRole('button', { name: '接受' })).toBeNull();
    await user.click(within(card).getByRole('button', { name: '采纳…' }));
    const adoption = await within(card).findByRole('form', { name: '采纳推演草案' });
    // 自动模式自动接受的裁决逐条复核之前不能采纳。
    const adopt = within(adoption).getByRole('button', { name: '采纳' });
    expect(adopt.matches(':disabled')).toBe(true);
    const reviews = within(adoption).getAllByRole('checkbox', { name: /^已复核/ });
    expect(reviews.length).toBeGreaterThan(0);
    for (const box of reviews) await user.click(box);
    // 视角角色察觉到的事默认选中；作品里还没有“主角”这个人物，不能记他的认知。
    const shot = within(adoption).getByRole('checkbox', { name: /^第 1 回合 · 裁决结果/ });
    expect((shot as HTMLInputElement).checked).toBe(true);
    expect(adoption.textContent).toContain('没有对应的人物设定');
    await user.click(within(adoption).getByRole('checkbox', { name: '记为世界事实：裁决结果（仓库中央）：弩箭擦过主角肩头' }));
    await user.click(adopt);
    await waitFor(() => expect(store.getState().chapterContent?.saved.map((p) => [p.text, p.source])).toEqual([['雨下得更紧了。他没有回头。', 'ai_generated']]));
    expect(store.getState().candidates).toEqual([]);
    expect(store.getState().facts.map((f) => [f.kind, f.status, f.content, f.eventIds.length])).toEqual([['world', 'confirmed', '裁决结果（仓库中央）：弩箭擦过主角肩头', 1]]);
  });
});

describe('AI 助手操作推演的界面（M5-19）', () => {
  it('助手开始推演后在后台推进到结束：推演页列出新的运行，现状里写着正在推进；推完后可以看概要', async () => {
    const { user, store, deps, runs } = await simReady();
    deps.llmResponses.push(reply(JSON.stringify({ message: '已开始推演。', actions: [{ tool: 'start_simulation', scene: '废仓库', budgetUsd: null }], done: true })));
    await user.type(screen.getByRole('textbox', { name: '给助手的话' }), '推演一下仓库这场戏{Enter}');
    expect(await screen.findByText('已开始推演。')).toBeTruthy();
    expect(await within(runs).findByRole('button', { name: /第 1 次/ })).toBeTruthy();
    await waitFor(() => expect(simStatus()).toContain('已结束：到达回合上限'), { timeout: 10_000 });
    await waitFor(() => expect(store.getState().simAdvancing).toBe(false));
    expect(store.getState().backgroundWork()).toEqual([]);

    deps.llmResponses.push(
      reply(JSON.stringify({ message: '', actions: [{ tool: 'get_simulation', run: '废仓库' }], done: false })),
      reply(JSON.stringify({ message: '推完了：三个回合。', actions: [], done: true })),
    );
    await user.type(screen.getByRole('textbox', { name: '给助手的话' }), '推得怎么样{Enter}');
    expect(await screen.findByText('推完了：三个回合。')).toBeTruthy();
    const results = store.getState().assistantItems.filter((i) => i.role === 'results').at(-1);
    expect(results).toMatchObject({ results: [{ tool: 'get_simulation', ok: true, detail: expect.stringContaining('已结束（到达回合上限），第 3 回合') }] });
  });
});

describe('推演评价的界面（B46）', () => {
  it('推演结束后出现评价：列出调用与费用，按 M0 的评分项打分，保存后再改', async () => {
    const { user, runs, store } = await simReady();
    await user.click(within(runs).getByRole('button', { name: '开始新的推演' }));
    const workspace = await screen.findByRole('region', { name: '推演工作区' });
    expect(within(workspace).queryByText('推演评价')).toBeNull();
    await user.click(within(workspace).getByRole('button', { name: '继续' }));
    await waitFor(() => expect(simStatus()).toContain('已结束'), { timeout: 10_000 });

    const ended = screen.getByRole('region', { name: '推演工作区' });
    await user.click(within(ended).getByText('推演评价'));
    const form = await within(ended).findByRole('form', { name: '推演评价' });
    expect(form.textContent).toMatch(/调用 \d+ 次，费用 \$/);
    expect(form.textContent).toContain('还没有采纳进作品的事件。');
    await user.selectOptions(within(form).getByRole('combobox', { name: '人物可信且可区分' }), '4');
    await user.selectOptions(within(form).getByRole('combobox', { name: /采纳前修改量/ }), '1');
    await user.type(within(form).getByRole('textbox', { name: /可采用的转折/ }), '弩箭那一下');
    await user.click(within(form).getByRole('button', { name: '保存评价' }));
    await waitFor(() => expect(store.getState().simEvaluation?.evaluation?.version).toBe(1));
    expect(store.getState().simEvaluation?.evaluation?.answers).toMatchObject({ scores: { characters: 4, intel: null, edits: 1 }, twistNote: '弩箭那一下' });

    const saved = within(screen.getByRole('region', { name: '推演工作区' })).getByRole('form', { name: '推演评价' });
    expect(saved.textContent).toContain('已保存（第 1 版）');
    expect(within(saved).getByRole<HTMLSelectElement>('combobox', { name: '人物可信且可区分' }).value).toBe('4');
    await user.selectOptions(within(saved).getByRole('combobox', { name: '意外但合理的转折' }), '5');
    await user.click(within(saved).getByRole('button', { name: '保存评价' }));
    await waitFor(() => expect(store.getState().simEvaluation?.evaluation).toMatchObject({ version: 2, answers: { scores: { characters: 4, twist: 5 } } }));
  });
});

describe('快速成书的界面（B67）', () => {
  it('新作品从成书页开始：先连模型，再由一句想法生成大纲与人物、改过后采用，拆出章节计划，写作看板出现', async () => {
    const { deps, service, store, user } = start();
    await createWork(user, '新作品');
    const page = await screen.findByRole('region', { name: '快速成书' });
    const step = (n: number) => within(page).getByRole('region', { name: new RegExp(`^第 ${n} 步`) });
    await waitFor(() => expect(step(1).textContent).toContain('还没有设置默认模型'));
    expect(within(step(2)).getByRole('button', { name: '生成大纲与人物' }).matches(':disabled')).toBe(true);

    // 在“模型服务”里配好模型后回到成书页：第一步完成。
    await addTestedModel(service, deps);
    await user.click(screen.getByRole('button', { name: '成书' }));
    await waitFor(() => expect(step(1).textContent).toContain('已连接'));

    const seed = {
      title: '当铺夜谈',
      genre: '古风悬疑',
      synopsis: '落魄书生深夜当玉。',
      outline: '开端：林舟当玉。结局：林舟得知身世。',
      characters: [
        { name: '林舟', description: '落魄书生' },
        { name: '路人', description: '多余的人' },
      ],
    };
    // 没有想法时随机生成一句（不调用模型），类型一并填上；之后可以改。
    const ideaBox = within(step(2)).getByRole('textbox', { name: '一句话的想法' });
    expect(ideaBox.getAttribute('placeholder')).toBe('没有想法？随机生成一个');
    const calls = deps.llmRequests.length;
    await user.click(within(step(2)).getByRole('button', { name: '随机生成' }));
    expect((ideaBox as HTMLTextAreaElement).value).not.toBe('');
    expect(within(step(2)).getByRole<HTMLInputElement>('textbox', { name: '类型（可不填）' }).value).not.toBe('');
    expect(deps.llmRequests).toHaveLength(calls);
    await user.clear(ideaBox);
    deps.llmResponses.push(reply(JSON.stringify(seed)));
    await user.type(ideaBox, '落魄书生当铺夜遇旧主');
    const chapters = within(step(2)).getByRole('spinbutton', { name: '章数' });
    await user.clear(chapters);
    await user.type(chapters, '2');
    await user.click(within(step(2)).getByRole('button', { name: '生成大纲与人物' }));
    const skeleton = await within(step(2)).findByRole('form', { name: '作品骨架' });
    expect(within(skeleton).getByRole('textbox', { name: '大纲' })).toHaveProperty('value', seed.outline);
    await user.click(within(skeleton).getByRole('button', { name: '删去人物 路人' }));
    await user.click(within(skeleton).getByRole('button', { name: '采用骨架' }));
    await waitFor(() => expect(step(2).textContent).toContain('大纲已写好，人物 1 个'));
    expect(store.getState().work?.project).toMatchObject({ title: '当铺夜谈', outline: seed.outline });
    expect(store.getState().entities.map((e) => e.name)).toEqual(['林舟']);

    // 草稿自动分卷（B68）：每卷第一章之前列出卷名与梗概，采用后目录按卷分组。
    const plan = {
      volumes: [
        { title: '第一卷 当玉', summary: '林舟当玉被压价' },
        { title: '第二卷 身世', summary: '旧主现身' },
      ],
      chapters: [
        { volume: '第一卷 当玉', title: '第一章 夜叩', goal: '林舟当玉', cast: ['林舟'], beats: ['叩门', '压价'], plant: [], payoff: [], treatment: '', targetWords: 3000 },
        { volume: '第二卷 身世', title: '第二章 身世', goal: '真相揭开', cast: ['林舟'], beats: ['旧主现身'], plant: [], payoff: [], treatment: '', targetWords: 3000 },
      ],
      foreshadows: [],
    };
    deps.llmResponses.push(reply(JSON.stringify(plan)));
    await user.click(within(step(3)).getByRole('button', { name: '生成章节计划' }));
    await within(step(3)).findByText('第一章 夜叩');
    expect(step(3).textContent).toContain('共 2 章，分 2 卷。');
    expect(step(3).textContent).toContain('第一卷 当玉：林舟当玉被压价');
    await user.click(within(step(3)).getByRole('button', { name: '采用计划' }));
    await waitFor(() => expect(step(3).textContent).toContain('2 章，2 章有计划'));
    expect(chapterTitles()).toEqual(['第一章 夜叩', '第二章 身世']);
    expect(tocOutline()).toEqual(['卷：第一卷 当玉', '第一章 夜叩', '卷：第二卷 身世', '第二章 身世']);
    expect(within(step(4)).getByRole('region', { name: '成书进度' })).toBeTruthy();
    expect(within(step(4)).getByRole('button', { name: '依次写完待写的 2 章' })).toBeTruthy();
  });

  it('已有章节的作品打开第一章；常用功能在左侧导航，导入导出等在顶栏的“更多”里', async () => {
    const { user } = start();
    await createWork(user, '旧作');
    await addChapter(user, '第一章');
    const nav = screen.getByRole('navigation', { name: '作品导航' });
    for (const name of ['成书', '计划', '设定', '事实', '推演', '查找']) expect(within(nav).getByRole('button', { name })).toBeTruthy();
    await user.click(screen.getByText('更多'));
    for (const name of ['导出整本 TXT', '写作技能', '模型服务']) expect(screen.getByRole('menuitem', { name })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '作品列表' }));
    await user.click(await screen.findByRole('button', { name: '旧作' }));
    await screen.findByRole('navigation', { name: '章节目录' });
    await waitFor(() => expect(screen.queryByRole('region', { name: '快速成书' })).toBeNull());
  });

});

describe('分卷的界面（B68）', () => {
  it('新建卷后目录按卷分组；在卷里新建章节；上移越过卷的边界时移到上一卷；编辑卷名与简介；卷里还有章节时不能删除', async () => {
    const { user, store } = start();
    await createWork(user, '雨夜');
    await addChapter(user, '楔子');
    const nav = () => screen.getByRole('navigation', { name: '章节目录' });
    // 没有分卷时与以前相同：一个章节列表。
    expect(within(nav()).queryByLabelText('卷：未分卷')).toBeNull();

    for (const name of ['第一卷', '第二卷']) {
      await user.click(within(nav()).getByRole('button', { name: '新建卷' }));
      await user.type(within(nav()).getByRole('textbox', { name: '新卷名' }), `${name}{Enter}`);
      await within(nav()).findByLabelText(`卷：${name}`);
    }
    expect(tocOutline()).toEqual(['卷：未分卷', '楔子', '卷：第一卷', '这一卷还没有章节', '卷：第二卷', '这一卷还没有章节']);

    // 在第二卷里新建章节。
    await user.click(within(nav()).getByRole('button', { name: '在 第二卷 末尾新建章节' }));
    await user.type(within(nav()).getByRole('textbox', { name: '新章节名' }), '第一章{Enter}');
    await waitFor(() => expect(tocOutline()).toEqual(['卷：未分卷', '楔子', '卷：第一卷', '这一卷还没有章节', '卷：第二卷', '第一章']));

    // 上移：第一章是第二卷的第一章，上一章是未分卷的楔子，于是移到未分卷末尾（第一卷是空的，跳过）。
    await user.click(within(nav()).getByRole('button', { name: '上移 第一章' }));
    await waitFor(() => expect(tocOutline()).toEqual(['卷：未分卷', '楔子', '第一章', '卷：第一卷', '这一卷还没有章节', '卷：第二卷', '这一卷还没有章节']));
    // 拖到第一卷的标题上：移入第一卷。
    const chapterId = store.getState().work?.chapters.find((c) => c.title === '第一章')?.id ?? '';
    const volumeId = store.getState().work?.volumes.find((v) => v.title === '第一卷')?.id ?? null;
    await store.getState().dropChapterOnVolume(chapterId, volumeId);
    await waitFor(() => expect(tocOutline()).toEqual(['卷：未分卷', '楔子', '卷：第一卷', '第一章', '卷：第二卷', '这一卷还没有章节']));

    await user.click(within(nav()).getByRole('button', { name: '编辑 第一卷' }));
    const editor = within(nav()).getByRole('form', { name: '编辑 第一卷' });
    await user.clear(within(editor).getByRole('textbox', { name: '卷名' }));
    await user.type(within(editor).getByRole('textbox', { name: '卷名' }), '第一卷 雨夜');
    await user.type(within(editor).getByRole('textbox', { name: '本卷简介' }), '林舟当玉');
    await user.click(within(editor).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(store.getState().work?.volumes[0]).toMatchObject({ title: '第一卷 雨夜', summary: '林舟当玉' }));

    await user.click(within(nav()).getByRole('button', { name: '删除 第一卷 雨夜' }));
    expect((await screen.findByRole('alert')).textContent).toContain('“第一卷 雨夜”里还有章节');
    await user.click(within(nav()).getByRole('button', { name: '删除 第二卷' }));
    await waitFor(() => expect(store.getState().work?.volumes.map((v) => v.title)).toEqual(['第一卷 雨夜']));
  });
});

describe('后台任务不被打断', () => {
  it('写手写到一半时和助手说话：写手照常接着写', async () => {
    const { user, service, store, deps } = start();
    await createWork(user, '当铺夜谈');
    await addChapter(user, '第一章 夜叩');
    const chapterId = store.getState().selectedChapterId ?? '';
    expect((await service.savePlan(chapterId, { goal: '林舟当玉', castIds: [], beats: ['叩门', '压价', '起疑', '离开'], foreshadowPlant: [], foreshadowPayoff: [], treatment: '', targetWords: 3000 })).ok).toBe(true);
    await addTestedModel(service, deps);
    deps.llmRequests.length = 0;
    // 第一段写完，第二段的调用挂起；接着排好助手的回复。
    deps.llmResponses.push(reply('林舟又叩响了门。'), { chunks: openaiChunks('m', { text: ['钱四'], end: 'stop' }, { stopAfterText: true }), hang: true });
    await user.click(screen.getByRole('button', { name: '让写手写这一章' }));
    const banner = await screen.findByRole('status', { name: '写手进度' });
    await waitFor(() => expect(banner.textContent).toContain('已写 1 / 2 段'));
    await waitFor(() => expect(deps.llmRequests).toHaveLength(2));
    deps.llmResponses.push(reply(JSON.stringify({ message: '在写第一章。', actions: [], done: true })));
    await user.type(screen.getByRole('textbox', { name: '给助手的话' }), '现在在做什么？{Enter}');
    await waitFor(() => expect(store.getState().assistantRunning).toBe(false));
    await waitFor(() => expect(screen.getByText('在写第一章。')).toBeTruthy());
    expect(store.getState().writerJob).toMatchObject({ chapterId, stage: 'writing', done: 1, total: 2 });
    expect(store.getState().message).toBeNull();
    // 助手的现状里写着写手正在写哪一章，不会再提议写同一章。
    expect(JSON.stringify(deps.llmRequests.at(-1)?.body)).toContain('写手在写《第一章 夜叩》（已写 1 / 2 段）');

    // 写手还在写：回到作品列表前先确认；留在这里时什么也不变。
    await user.click(screen.getByRole('button', { name: '作品列表' }));
    const dialog = await screen.findByRole('alertdialog', { name: '还有任务在进行' });
    expect(dialog.textContent).toContain('写手在写《第一章 夜叩》');
    await user.click(within(dialog).getByRole('button', { name: '留在这里' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(store.getState().writerJob).not.toBeNull();
    expect(screen.getByRole('navigation', { name: '章节目录' })).toBeTruthy();
    // 确认停下：写手停下，回到作品列表。
    await user.click(screen.getByRole('button', { name: '作品列表' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '停下并返回作品列表' }));
    await screen.findByRole('button', { name: '新建作品' });
    await waitFor(() => expect(store.getState().writerJob).toBeNull());

    // 重新打开作品：对话还在，上下文用量取最近一步的调用记录。
    await user.click(screen.getByRole('button', { name: '当铺夜谈' }));
    await screen.findByRole('navigation', { name: '章节目录' });
    expect(await screen.findByRole('img', { name: /^上下文用了/ })).toBeTruthy();
  });

  it('让助手审核全书：动作立即返回，审核在后台依次进行，成书进度显示进度，审完后各章为已审核', async () => {
    const { user, service, store, deps } = start();
    await createWork(user, '当铺夜谈');
    for (const title of ['第一章', '第二章']) {
      await addChapter(user, title);
      await user.click(await screen.findByRole('textbox', { name: '正文' }));
      await user.keyboard(`${title}的正文。`);
      await waitFor(() => expect(store.getState().chapterContent?.saved.map((p) => p.text)).toEqual([`${title}的正文。`]), { timeout: 3_000 });
    }
    await addTestedModel(service, deps);
    deps.llmResponses.push(
      reply(JSON.stringify({ message: '已经排上，在后台依次审核两章。', actions: [{ tool: 'review_chapters', chapters: null }], done: true })),
      reply(JSON.stringify({ issues: [] })),
      reply(JSON.stringify({ issues: [] })),
    );
    await user.type(screen.getByRole('textbox', { name: '给助手的话' }), '审核整本书{Enter}');
    expect(await screen.findByText('已经排上，在后台依次审核两章。')).toBeTruthy();
    await waitFor(() => expect(store.getState().reviewQueue).toBeNull());
    await waitFor(() => expect(store.getState().tasks.filter((t) => t.kind === 'review').map((t) => [t.title, t.status])).toEqual([
      ['审核 · 第二章', 'done'],
      ['审核 · 第一章', 'done'],
    ]));
  });

  it('让助手停下后台写作：写到一半的这一章不写入，后面排着的章不再写，任务记为已取消', async () => {
    const { user, service, store, deps } = start();
    await createWork(user, '当铺夜谈');
    for (const title of ['第一章', '第二章']) await addChapter(user, title);
    for (const c of store.getState().work?.chapters ?? []) {
      expect((await service.savePlan(c.id, { goal: `${c.title}的目标`, castIds: [], beats: ['叩门'], foreshadowPlant: [], foreshadowPayoff: [], treatment: '', targetWords: 1500 })).ok).toBe(true);
    }
    await addTestedModel(service, deps);
    const before = deps.llmRequests.length;
    // 助手排上两章；写手写第一章的调用挂起，直到被停下。
    deps.llmResponses.push(
      reply(JSON.stringify({ message: '已排上，写手在后台依次写两章。', actions: [{ tool: 'write_chapters', chapters: null, review: false }], done: true })),
      { chunks: openaiChunks('m', { text: ['林舟'], end: 'stop' }, { stopAfterText: true }), hang: true },
    );
    await user.type(screen.getByRole('textbox', { name: '给助手的话' }), '把两章写完{Enter}');
    expect(await screen.findByText('已排上，写手在后台依次写两章。')).toBeTruthy();
    await waitFor(() => expect(deps.llmRequests.length).toBe(before + 2));
    expect(store.getState().writerJob).toMatchObject({ stage: 'writing', queued: [expect.any(String)] });
    expect(store.getState().backgroundWork().join('；')).toContain('第一章');

    deps.llmResponses.push(reply(JSON.stringify({ message: '已停下。', actions: [{ tool: 'stop_background', what: 'writing' }], done: true })));
    await waitFor(() => expect(store.getState().assistantRunning).toBe(false));
    await user.type(screen.getByRole('textbox', { name: '给助手的话' }), '先停下{Enter}');
    expect(await screen.findByText('已停下。')).toBeTruthy();
    await waitFor(() => expect(store.getState().writerJob).toBeNull());
    const results = store.getState().assistantItems.filter((i) => i.role === 'results').at(-1);
    expect(results).toMatchObject({ results: [{ tool: 'stop_background', ok: true, detail: expect.stringContaining('后面排着的 1 章不再写') }] });
    // 第一章没写完的那一段没有写入，第二章没有开写；写手的任务记为已取消。
    const [one, two] = store.getState().work?.chapters ?? [];
    for (const c of [one, two]) {
      const content = await service.openChapter(c!.id);
      expect(content.ok && content.value.saved.map((p) => p.text).join('')).toBe('');
    }
    expect(store.getState().tasks.filter((t) => t.kind === 'writer').map((t) => [t.title, t.status])).toEqual([['写手 · 第一章', 'cancelled']]);
    expect(deps.llmRequests.length).toBe(before + 3);
  });

  it('没有任务在进行时，回到作品列表不用确认', async () => {
    const { user } = start();
    await createWork(user, '雨夜');
    await user.click(screen.getByRole('button', { name: '作品列表' }));
    await screen.findByRole('button', { name: '新建作品' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

describe('AI 助手的输入框：模型、思考深度与上下文用量', () => {
  it('列出模型并可切换默认模型；模型不能调节思考时不可选；选了深度后请求带上它；回复后显示上下文用了多少，新对话后清掉', async () => {
    const { user, service, store, deps } = start();
    await createWork(user, '雨夜');
    await addTestedModel(service, deps);
    await store.getState().loadAssistantModels();
    expect(await screen.findByRole('button', { name: '模型：m' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '思考：不可调' }).matches(':disabled')).toBe(true);

    // 模型能调节思考深度、上下文上限十万。
    const services = await service.loadModelServices();
    if (!services.ok) throw new Error('模型服务');
    const model = services.value.models[0]!;
    expect((await service.updateModel(model, { displayName: model.displayName, capabilities: { ...model.capabilities, reasoningControl: 'effort', contextWindow: 100_000 }, prices: model.prices })).ok).toBe(true);
    await store.getState().loadAssistantModels();
    await user.click(await screen.findByRole('button', { name: '思考：中' }));
    await user.click(await screen.findByRole('menuitemradio', { name: /^高/ }));
    await waitFor(() => expect(store.getState().library?.preferences.assistant.effort).toBe('high'));
    expect(screen.getByRole('button', { name: '思考：高' })).toBeTruthy();

    deps.llmRequests.length = 0;
    deps.llmResponses.push(reply(JSON.stringify({ message: '好。', actions: [], done: true }), { input: 25_000, output: 100, cacheRead: 0 }));
    await user.type(screen.getByRole('textbox', { name: '给助手的话' }), '你好{Enter}');
    expect(await screen.findByRole('img', { name: '上下文用了 25%' })).toBeTruthy();
    expect(JSON.stringify(deps.llmRequests.at(-1)?.body)).toContain('"reasoning_effort":"high"');
    await user.click(screen.getByRole('button', { name: '新对话' }));
    await waitFor(() => expect(screen.queryByRole('img', { name: /上下文用了/ })).toBeNull());

    // 再加一个模型（还没自检），在菜单里选中它：成为默认模型。
    expect((await service.addModel(model.providerId, 'm2')).ok).toBe(true);
    await store.getState().loadAssistantModels();
    await user.click(screen.getByRole('button', { name: '模型：m' }));
    const option = await screen.findByRole('menuitemradio', { name: /^m2/ });
    expect(option.textContent).toContain('未通过能力自检');
    await user.click(option);
    await waitFor(() => expect(screen.getByRole('button', { name: '模型：m2' })).toBeTruthy());
    const after = await service.loadModelServices();
    expect(after.ok && after.value.models.find((m) => m.id === after.value.defaultModelId)?.modelId).toBe('m2');
  });
});

describe('长篇的目录（施工文档第七章：虚拟列表）', () => {
  it('行数多时只渲染视野内外的几十行，滚动后换成那里的章节；选中远处的章节时滚到那一章', async () => {
    // jsdom 不排版：目录的滚动区高 600、每行高 32，内容的高度按 300 行算；滚动时更新位置，随后发出 scroll 事件。
    const own = (['offsetHeight', 'clientHeight', 'scrollHeight'] as const).map((name) => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)] as const);
    const isScroller = (el: Element) => el.classList.contains('toc-scroll');
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        if (isScroller(this)) return 600;
        return this.parentElement?.classList.contains('chapter-list') === true ? 32 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return isScroller(this) ? 600 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return isScroller(this) ? 300 * 32 : 0;
      },
    });
    HTMLElement.prototype.scrollTo = function (this: HTMLElement, options?: ScrollToOptions | number) {
      if (typeof options === 'object' && options.top !== undefined) this.scrollTop = options.top;
      // 与浏览器一样，scroll 事件在之后的任务里发出。
      setTimeout(() => this.dispatchEvent(new Event('scroll')), 0);
    };
    try {
      const { user, service, store } = start();
      await createWork(user, '长篇');
      for (let i = 1; i < 300; i++) {
        const created = await service.createChapter(`第${i}章`);
        expect(created.ok).toBe(true);
      }
      // 经界面在末尾新建一章：它成为所选，目录滚到末尾。
      await addChapter(user, '尾声');
      expect(chapterTitles().length).toBeLessThan(60);
      expect(chapterTitles()).not.toContain('第1章');
      expect(screen.getByRole('navigation', { name: '章节目录' }).querySelector('.chapter-item')?.getAttribute('aria-setsize')).toBe('300');

      const scroller = screen.getByRole('navigation', { name: '章节目录' }).querySelector<HTMLElement>('.toc-scroll');
      if (scroller === null) throw new Error('缺少目录的滚动区');
      scroller.scrollTo({ top: 0 });
      await waitFor(() => expect(chapterTitles()).toContain('第1章'));
      expect(chapterTitles()).not.toContain('尾声');

      // 选中第 200 章（例如从查找跳过来）：目录滚到那一章。
      const target = store.getState().work?.chapters.find((c) => c.title === '第200章');
      await store.getState().selectChapter(target?.id ?? '');
      await waitFor(() => expect(chapterTitles()).toContain('第200章'));
      expect(chapterTitles()).not.toContain('第1章');
    } finally {
      for (const [name, descriptor] of own) {
        if (descriptor === undefined) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
        else Object.defineProperty(HTMLElement.prototype, name, descriptor);
      }
      delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTo;
    }
  });
});

describe('人物关系网（B73）', () => {
  it('新建关系：表单预览读法；图上出现人物与关系；点关系修改、点人物看他的关系；按章节查看；删除须先确认', async () => {
    const { store, user } = start();
    await createWork(user, '雨夜');
    await addChapter(user, '第一章');
    await addChapter(user, '第二章');
    await store.getState().createEntity('character', '林舟');
    await store.getState().createEntity('character', '钱四');
    await store.getState().createEntity('organization', '聚宝当铺');
    await user.click(within(screen.getByRole('navigation', { name: '作品导航' })).getByRole('button', { name: '人物关系' }));
    const page = await screen.findByRole('region', { name: '人物关系' });
    expect(within(page).getByText(/还没有关系/)).toBeTruthy();

    await user.click(within(page).getByRole('button', { name: '新建关系' }));
    const form = within(page).getByRole('form', { name: '新建关系' });
    const people = store.getState().relations!.members;
    const idOf = (name: string) => people.find((m) => m.name === name)!.id;
    await user.selectOptions(within(form).getByRole('combobox', { name: '一方' }), idOf('钱四'));
    await user.selectOptions(within(form).getByRole('combobox', { name: '另一方' }), idOf('林舟'));
    await user.selectOptions(within(form).getByRole('combobox', { name: '类别' }), 'enemy');
    await user.type(within(form).getByRole('textbox', { name: '称谓' }), '债主');
    expect(within(form).getByLabelText('读作').textContent).toBe('钱四是林舟的债主');
    await user.click(within(form).getByRole('checkbox', { name: /隐秘/ }));
    const chapters = store.getState().work!.chapters;
    await user.selectOptions(within(form).getByRole('combobox', { name: '从哪一章起' }), chapters[1]!.id);
    await user.click(within(form).getByRole('button', { name: '保存关系' }));
    await waitFor(() => expect(store.getState().relations?.relationships).toHaveLength(1));
    expect(store.getState().relations?.relationships[0]).toMatchObject({ category: 'enemy', label: '债主', secret: true, validFromChapterId: chapters[1]!.id });

    // 图上：三个设定都是节点，关系可以点。
    const graph = within(page).getByRole('img', { name: '人物关系图' });
    for (const name of ['林舟（人物）', '钱四（人物）', '聚宝当铺（组织）']) expect(within(graph).getByRole('button', { name })).toBeTruthy();
    expect(within(page).getByRole('list', { name: '关系列表' }).textContent).toContain('钱四是林舟的债主隐秘');

    // 按章节查看：从第二章起的关系在第一章时不成立。
    await user.selectOptions(within(page).getByRole('combobox', { name: '按章节查看' }), chapters[0]!.id);
    expect(within(graph).queryByRole('button', { name: '钱四是林舟的债主' })).toBeNull();
    await user.selectOptions(within(page).getByRole('combobox', { name: '按章节查看' }), chapters[1]!.id);
    await user.click(within(graph).getByRole('button', { name: '钱四是林舟的债主' }));

    const edit = within(page).getByRole('form', { name: '修改关系' });
    await user.clear(within(edit).getByRole('textbox', { name: '称谓' }));
    await user.type(within(edit).getByRole('textbox', { name: '称谓' }), '旧债主');
    await user.click(within(edit).getByRole('button', { name: '保存关系' }));
    await waitFor(() => expect(store.getState().relations?.relationships[0]?.label).toBe('旧债主'));

    // 点人物：侧栏列出他的关系，可以以他为一方新建。
    await user.click(within(graph).getByRole('button', { name: '林舟（人物）' }));
    expect(within(page).getByRole('list', { name: '林舟的关系' }).textContent).toContain('钱四是林舟的旧债主');
    await user.click(within(page).getByRole('button', { name: '与他人新建关系' }));
    expect(within(page).getByRole<HTMLSelectElement>('combobox', { name: '一方' }).value).toBe(idOf('林舟'));
    await user.click(within(page).getByRole('button', { name: '取消' }));

    await user.click(within(within(page).getByRole('list', { name: '关系列表' })).getByRole('button', { name: /旧债主/ }));
    await user.click(within(page).getByRole('button', { name: '删除关系' }));
    const confirm = within(page).getByRole('group', { name: '确认删除' });
    await user.click(within(confirm).getByRole('button', { name: '确定删除' }));
    await waitFor(() => expect(store.getState().relations?.relationships).toEqual([]));
  });
});

describe('布局与外观（B71）', () => {
  const savedLayout = (deps: TestDeps) => (JSON.parse(readFileSync(deps.libraryFile, 'utf8')) as { preferences: { layout: unknown } }).preferences.layout;
  const shell = () => document.querySelector<HTMLElement>('.app-shell')!;

  it('拖动分隔条调整左栏与助手的宽度，松开后保存；方向键、Home 与双击；宽度在上下限之内', async () => {
    const { deps, user } = start();
    await createWork(user, '雨夜');
    const left = screen.getByRole('separator', { name: '调整左栏的宽度' });
    expect(left.getAttribute('aria-valuenow')).toBe('248');

    fireEvent.pointerDown(left, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(left, { clientX: 160, pointerId: 1 });
    // 拖动中只改 CSS 变量，还没有保存。
    expect(shell().style.getPropertyValue('--sidebar-width')).toBe('308px');
    fireEvent.pointerUp(left, { clientX: 160, pointerId: 1 });
    await waitFor(() => expect(savedLayout(deps)).toMatchObject({ sidebar: 308 }));
    expect(left.getAttribute('aria-valuenow')).toBe('308');

    left.focus();
    await user.keyboard('{ArrowLeft}');
    await waitFor(() => expect(savedLayout(deps)).toMatchObject({ sidebar: 292 }));
    await user.keyboard('{Home}');
    await waitFor(() => expect(savedLayout(deps)).toMatchObject({ sidebar: 180 }));
    await user.keyboard('{ArrowLeft}');
    expect(left.getAttribute('aria-valuenow')).toBe('180');
    await user.dblClick(left);
    await waitFor(() => expect(savedLayout(deps)).toMatchObject({ sidebar: 248 }));

    // 助手在右侧：向左拖变宽，上限 760。
    const right = screen.getByRole('separator', { name: '调整 AI 助手的宽度' });
    fireEvent.pointerDown(right, { button: 0, clientX: 1000, pointerId: 2 });
    fireEvent.pointerMove(right, { clientX: 100, pointerId: 2 });
    fireEvent.pointerUp(right, { clientX: 100, pointerId: 2 });
    await waitFor(() => expect(savedLayout(deps)).toMatchObject({ assistant: 760 }));
    expect(shell().style.getPropertyValue('--assistant-width')).toBe('760px');
  });

  it('收起与显示左栏；空白章节显示提示；“更多”是可以用键盘操作的菜单', async () => {
    const { deps, user } = start();
    await createWork(user, '雨夜');
    await addChapter(user, '第一章');
    const editor = await screen.findByRole('textbox', { name: '正文' });
    expect(editor.querySelector('p')?.getAttribute('data-placeholder')).toContain('从这里开始写');

    await user.click(screen.getByRole('button', { name: '收起左栏' }));
    expect(screen.queryByRole('navigation', { name: '作品导航' })).toBeNull();
    expect(screen.queryByRole('separator', { name: '调整左栏的宽度' })).toBeNull();
    await waitFor(() => expect(savedLayout(deps)).toMatchObject({ sidebarHidden: true }));
    await user.click(screen.getByRole('button', { name: '显示左栏' }));
    expect(screen.getByRole('navigation', { name: '作品导航' })).toBeTruthy();

    await user.click(screen.getByText('更多'));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent)).toEqual([
      '导入章节（TXT/Markdown）',
      '导出整本 TXT',
      '导出整本 Markdown',
      '导出作品包',
      '备份与恢复',
      '写作技能',
      '段落来源',
      '用量与费用',
      '模型服务',
    ]);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });
});

describe('AI 助手的界面（B69）', () => {
  const said = (output: { message: string; actions: unknown[]; done: boolean }) => reply(JSON.stringify(output));

  it('在作品列表页用一句话开新书：作品打开，对话里列出作者的话、执行的动作与助手的回复', async () => {
    const { deps, service, user } = start();
    await screen.findByRole('button', { name: '新建作品' });
    await addTestedModel(service, deps);
    const panel = screen.getByRole('complementary', { name: 'AI 助手' });
    expect(within(panel).getByText('想做什么，直接告诉我。')).toBeTruthy();
    deps.llmResponses.push(
      said({ message: '', actions: [{ tool: 'create_work', title: '江湖狂想', genre: '武侠', synopsis: null, outline: null }], done: false }),
      said({ message: '已经建好《江湖狂想》，要不要接着写大纲？', actions: [], done: true }),
    );
    await user.type(within(panel).getByRole('textbox', { name: '给助手的话' }), '帮我开一本武侠小说，叫江湖狂想{Enter}');
    await screen.findByRole('navigation', { name: '章节目录' });
    const log = within(screen.getByRole('complementary', { name: 'AI 助手' })).getByRole('log', { name: '对话' });
    await within(log).findByText('已经建好《江湖狂想》，要不要接着写大纲？');
    expect(within(log).getByText('帮我开一本武侠小说，叫江湖狂想')).toBeTruthy();
    expect(within(log).getByText('新建作品')).toBeTruthy();
    expect(screen.getByRole('button', { name: '江湖狂想' })).toBeTruthy();
  });

  it('撤销这一轮的改动（M5-20）：按钮出现在最近一轮有改动的对话后面，点了以后改动改回去、对话里写明撤销了什么，按钮消失', async () => {
    const { deps, service, store, user } = start();
    await createWork(user, '雨夜');
    await addTestedModel(service, deps);
    const panel = () => screen.getByRole('complementary', { name: 'AI 助手' });
    deps.llmResponses.push(said({ message: '建好了沈砚。', actions: [{ tool: 'create_entity', kind: 'character', name: '沈砚', description: '捕快', aliases: null }], done: true }));
    await user.type(within(panel()).getByRole('textbox', { name: '给助手的话' }), '建个人物沈砚{Enter}');
    await within(panel()).findByText('建好了沈砚。');
    await waitFor(() => expect(store.getState().entities.map((e) => e.name)).toEqual(['沈砚']));
    const requests = deps.llmRequests.length;
    await user.click(await within(panel()).findByRole('button', { name: '撤销这一轮的改动' }));
    const note = await within(panel()).findByRole('note');
    expect(note.textContent).toContain('已撤销：新建的设定“沈砚”');
    await waitFor(() => expect(store.getState().entities).toEqual([]));
    expect(within(panel()).queryByRole('button', { name: '撤销这一轮的改动' })).toBeNull();
    // 撤销不调用模型，这一次登记在任务里。
    expect(deps.llmRequests.length).toBe(requests);
    expect(store.getState().tasks.filter((t) => t.kind === 'assistant').map((t) => t.title)).toContain('AI 助手 · 撤销改动');
  });

  it('删除类动作在对话里请作者确认；确认后执行。输入法组合中的回车不发送；可以收起再打开', async () => {
    const { deps, service, store, user } = start();
    await createWork(user, '雨夜');
    await addTestedModel(service, deps);
    await store.getState().createEntity('character', '钱四');
    const panel = () => screen.getByRole('complementary', { name: 'AI 助手' });
    const box = () => within(panel()).getByRole('textbox', { name: '给助手的话' });

    deps.llmResponses.push(said({ message: '要删掉钱四。', actions: [{ tool: 'delete_entity', entity: '钱四' }], done: false }));
    await user.type(box(), '把钱四删了{Enter}');
    const confirm = await within(panel()).findByRole('group', { name: '需要确认' });
    expect(confirm.textContent).toContain('删除设定“钱四”');
    expect(store.getState().entities.map((e) => e.name)).toEqual(['钱四']);
    deps.llmResponses.push(said({ message: '已删除。', actions: [], done: true }));
    await user.click(within(confirm).getByRole('button', { name: '确认执行' }));
    await within(panel()).findByText('已删除。');
    await waitFor(() => expect(store.getState().entities).toEqual([]));

    // 输入法组合中按回车是选字，不发送。
    const requests = deps.llmRequests.length;
    fireEvent.change(box(), { target: { value: '你好' } });
    fireEvent.keyDown(box(), { key: 'Enter', isComposing: true });
    expect(deps.llmRequests).toHaveLength(requests);

    await user.click(within(panel()).getByRole('button', { name: '收起助手' }));
    expect(screen.queryByRole('complementary', { name: 'AI 助手' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'AI 助手' }));
    expect(within(panel()).getByText('已删除。')).toBeTruthy();
  });

  it('选中正文后对话框上方显示选中的字数与快捷说法：点“润色”后改好的文字成为候选稿，在章节旁打开；可以不带上这次的选区', async () => {
    const { deps, service, store, user } = start();
    await createWork(user, '雨夜');
    await addChapter(user, '第一章');
    await user.click(await screen.findByRole('textbox', { name: '正文' }));
    await user.keyboard('沈砚推开当铺的门。');
    await waitFor(() => expect(store.getState().chapterContent?.saved.map((p) => p.text)).toEqual(['沈砚推开当铺的门。']));
    await addTestedModel(service, deps);
    const panel = () => screen.getByRole('complementary', { name: 'AI 助手' });
    expect(within(panel()).queryByRole('group', { name: '选中的文字' })).toBeNull();

    await user.keyboard('{Control>}a{/Control}');
    const bar = await within(panel()).findByRole('group', { name: '选中的文字' });
    expect(bar.textContent).toContain('已选中 9 字：「沈砚推开当铺的门。」');
    deps.llmResponses.push(
      said({ message: '润色好了，放在“AI 写作”里。', actions: [{ tool: 'edit_selection', operation: 'polish', instruction: null }], done: true }),
      { chunks: openaiChunks('m', { text: ['沈砚轻轻推开', '当铺的门。'], end: 'stop' }) },
    );
    await user.click(within(bar).getByRole('button', { name: '润色' }));
    const drawer = await screen.findByRole('complementary', { name: 'AI 写作' });
    const pending = await within(drawer).findByRole('region', { name: '本章待处理的候选稿' });
    expect(pending.textContent).toContain('轻轻');
    await within(panel()).findByText('润色好了，放在“AI 写作”里。');
    // 第一步给模型的现状里有选中的文字；候选稿要作者接受，正文没有变。
    expect(JSON.stringify(deps.llmRequests.at(-2)?.body)).toContain('「沈砚推开当铺的门。」');
    expect(screen.getByRole('textbox', { name: '正文' }).textContent).toBe('沈砚推开当铺的门。');

    // 不带上：这次的选区不交给助手。
    await user.click(screen.getByRole('textbox', { name: '正文' }));
    await user.keyboard('{Control>}a{/Control}');
    const again = await within(panel()).findByRole('group', { name: '选中的文字' });
    await user.click(within(again).getByRole('button', { name: '不带上选中的文字' }));
    expect(within(panel()).queryByRole('group', { name: '选中的文字' })).toBeNull();
    deps.llmResponses.push(said({ message: '请先选中要改的文字。', actions: [], done: true }));
    await user.type(within(panel()).getByRole('textbox', { name: '给助手的话' }), '扩写一下{Enter}');
    await within(panel()).findByText('请先选中要改的文字。');
    expect(JSON.stringify(deps.llmRequests.at(-1)?.body)).not.toContain('「沈砚推开当铺的门。」');
  });

  it('模型输出时回复逐字出现；动作结果里不显示内部标识；这一轮登记在任务中心；外观可以在跟随系统、浅色、深色之间切换', async () => {
    const { deps, service, store, user } = start();
    await createWork(user, '雨夜');
    await addTestedModel(service, deps);
    const panel = () => screen.getByRole('complementary', { name: 'AI 助手' });
    const text = JSON.stringify({ message: '建好了第一章。', actions: [{ tool: 'create_chapter', title: '第一章', volume: null, after: null }], done: true });
    deps.llmResponses.push({ chunks: openaiChunks('m', { text: [text.slice(0, 16), text.slice(16)], end: 'stop' }) });
    await user.type(within(panel()).getByRole('textbox', { name: '给助手的话' }), '建第一章{Enter}');
    const log = within(panel()).getByRole('log', { name: '对话' });
    await within(log).findByText('建好了第一章。');
    const step = within(log).getByRole('list', { name: '助手执行的动作' });
    expect(step.textContent).toContain('已新建章节《第一章》。');
    expect(step.textContent).not.toMatch(/\[[0-9A-Z]{26}\]/);
    // 任务中心：这一轮可以在任务页看到；输出是结构化的动作，任务里只记给作者的话与用量。
    expect(store.getState().tasks[0]).toMatchObject({ kind: 'assistant', title: 'AI 助手 · 建第一章', status: 'done', text: '建好了第一章。' });

    expect(document.documentElement.dataset['theme']).toBeUndefined();
    await user.click(screen.getByRole('button', { name: '外观：跟随系统' }));
    await waitFor(() => expect(document.documentElement.dataset['theme']).toBe('light'));
    await user.click(screen.getByRole('button', { name: '外观：浅色' }));
    await waitFor(() => expect(document.documentElement.dataset['theme']).toBe('dark'));
    await user.click(screen.getByRole('button', { name: '外观：深色' }));
    await waitFor(() => expect(document.documentElement.dataset['theme']).toBeUndefined());
  });
});
