import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('应用外壳', () => {
  it('渲染章节目录与正文区域', () => {
    const html = renderToString(<App />);
    expect(html).toContain('章节目录');
    expect(html).toContain('还没有打开作品');
  });
});
