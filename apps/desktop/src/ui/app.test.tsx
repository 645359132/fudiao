// @vitest-environment jsdom
// 用真实的用例与作品库（Node 的 SqlPort）驱动界面，覆盖 B01、B02 的主要流程。
import { rmSync } from 'node:fs';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../App';
import { createAppService } from '../app/service';
import { createAppStore } from '../state/store';
import { fsDeps, type TestDeps } from '../testing/fs-deps';

// jsdom 不做排版，ProseMirror 把选区滚入视野时要用到的几何接口给空实现。
const noRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
const zeroRect = () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0, toJSON: () => ({}) }) as DOMRect;
Element.prototype.getClientRects = noRects;
Range.prototype.getClientRects = noRects;
Range.prototype.getBoundingClientRect = zeroRect;
document.elementFromPoint = () => null;

const all: TestDeps[] = [];
afterEach(async () => {
  cleanup();
  for (const d of all.splice(0)) {
    await d.opener.close();
    rmSync(d.root, { recursive: true, force: true });
  }
});

function start() {
  const deps = fsDeps();
  all.push(deps);
  const store = createAppStore(createAppService(deps));
  render(<App store={store} />);
  return { deps, store, user: userEvent.setup() };
}

const chapterTitles = () =>
  within(screen.getByRole('navigation', { name: '章节目录' }))
    .queryAllByRole('listitem')
    .map((li) => li.querySelector('.chapter-title')?.textContent);

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
