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
