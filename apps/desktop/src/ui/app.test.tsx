// @vitest-environment jsdom
// 用真实的用例与作品库（Node 的 SqlPort）驱动界面，覆盖 B01、B02 的主要流程。
import { readFileSync, rmSync } from 'node:fs';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { anthropicChunks, openaiChunks } from '@fudiao/llm/testing';
import { renderConnectionTest, SELF_TEST_EXPECTED } from '@fudiao/prompts';
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
    await user.click(screen.getByText('作品'));
    await user.click(screen.getByRole('menuitem', { name: '导入章节（TXT/Markdown）' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '导入' }));
    await waitFor(() => expect(chapterTitles()).toEqual(['楔子', '第一章 雨夜', '第二章 当铺']));
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
    await user.click(screen.getByText('作品'));
    await user.click(screen.getByRole('menuitem', { name: '导出整本 TXT' }));
    await user.click(screen.getByRole('menuitem', { name: '导出作品包' }));
    await user.click(await screen.findByRole('button', { name: '导出 TXT' }));
    await waitFor(() => expect(deps.exported.map((e) => e.name)).toEqual(['雨夜.txt', '第一章 雨夜.txt']));
    expect(deps.exportedPackages[0]?.files.map((f) => f.path)).toContain('chapters/0002-第二章 当铺.md');
  });

  it('备份与恢复：立即备份，修改后恢复，目录回到备份时', async () => {
    const { user } = start();
    await createWork(user, '雨夜');
    await addChapter(user, '第一章');
    await user.click(screen.getByText('作品'));
    await user.click(screen.getByRole('menuitem', { name: '备份与恢复' }));
    await user.click(await screen.findByRole('button', { name: '立即备份' }));
    const list = await screen.findByRole('list', { name: '备份列表' });
    expect(within(list).getByText('手动备份')).toBeTruthy();
    await addChapter(user, '第二章');
    expect(chapterTitles()).toEqual(['第一章', '第二章']);
    await user.click(screen.getByText('作品'));
    await user.click(screen.getByRole('menuitem', { name: '备份与恢复' }));
    await user.click(await screen.findByRole('button', { name: /恢复到 .* 的备份/ }));
    await user.click(screen.getByRole('button', { name: '确定恢复' }));
    await waitFor(() => expect(chapterTitles()).toEqual(['第一章']));
    expect(within(screen.getByRole('list', { name: '备份列表' })).getByText('恢复前自动备份')).toBeTruthy();
  });

  it('打开已有作品时自动备份一次', async () => {
    const { user } = start();
    await createWork(user, '雨夜');
    await user.click(screen.getByRole('button', { name: '作品列表' }));
    await user.click(await screen.findByRole('button', { name: '雨夜' }));
    await screen.findByRole('navigation', { name: '章节目录' });
    await user.click(screen.getByText('作品'));
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
    expect(screen.getByRole('button', { name: '事实' })).toBeTruthy();
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

    await user.click(screen.getByText('作品'));
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

    await user.click(screen.getByText('作品'));
    await user.click(screen.getByRole('menuitem', { name: '段落来源' }));
    const table = await screen.findByRole('table', { name: '来源统计' });
    await waitFor(() => expect(within(table).getByRole('row', { name: /第一章/ }).textContent).toContain('57.1%'));
    expect(within(table).getByRole('row', { name: /全书/ }).textContent).toBe('全书757.1%3400');

    await user.click(screen.getByRole('button', { name: '第一章' }));
    await waitFor(() => expect(document.querySelector('.chapter-text p.source-ai_generated')?.textContent).toBe('雨很大。'));
    expect(document.querySelectorAll('.chapter-text p.source')).toHaveLength(1);

    await user.click(screen.getByText('作品'));
    await user.click(screen.getByRole('menuitem', { name: '段落来源' }));
    await user.click(await screen.findByRole('checkbox', { name: /显示来源色条/ }));
    await waitFor(() => expect((JSON.parse(readFileSync(deps.libraryFile, 'utf8')) as { preferences: unknown }).preferences).toEqual({ showParagraphSource: false }));
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

    await user.click(screen.getByText('作品'));
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
  it('停用技能、改写并恢复说明、添加与删除自己的技能、编辑规避词表', async () => {
    const { user, service } = start();
    await createWork(user, '雨夜');
    await user.click(screen.getByText('作品'));
    await user.click(screen.getByRole('menuitem', { name: '写作技能' }));
    const hook = await screen.findByRole('listitem', { name: '章末钩子' });

    await user.click(within(hook).getByRole('checkbox', { name: '章末钩子' }));
    await waitFor(() => expect(within(screen.getByRole('listitem', { name: '章末钩子' })).getByRole('checkbox')).toHaveProperty('checked', false));

    const box = within(screen.getByRole('listitem', { name: '章末钩子' })).getByRole('textbox');
    await user.clear(box);
    await user.type(box, '停在悬念上，不要总结。');
    await user.click(within(screen.getByRole('listitem', { name: '章末钩子' })).getByRole('button', { name: '保存说明' }));
    expect(await within(screen.getByRole('listitem', { name: '章末钩子' })).findByText('内置（已修改）')).toBeTruthy();
    await user.click(within(screen.getByRole('listitem', { name: '章末钩子' })).getByRole('button', { name: '恢复内置说明' }));
    expect(await within(screen.getByRole('listitem', { name: '章末钩子' })).findByText('内置')).toBeTruthy();

    const add = screen.getByRole('form', { name: '添加技能' });
    await user.type(within(add).getByRole('textbox', { name: '名称' }), '对话节奏');
    await user.type(within(add).getByRole('textbox', { name: '说明（写给写手的要求）' }), '对话三句内要有动作。');
    await user.click(within(add).getByRole('button', { name: '添加' }));
    const mine = await screen.findByRole('listitem', { name: '对话节奏' });
    expect(within(mine).getByText('自定义')).toBeTruthy();
    await user.click(within(mine).getByRole('button', { name: '删除' }));
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
