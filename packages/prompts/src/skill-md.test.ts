import { describe, expect, it } from 'vitest';
import { formatSkillMd, parseSkillMd } from './skill-md';

const value = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

describe('SKILL.md 的读写', () => {
  it('读常见写法：单行值、带引号的值、多行的 description、文件头里的其他键（license、allowed-tools 列表）', () => {
    const doc = value(
      parseSkillMd(
        [
          '---',
          'name: webnovel-pacing',
          'description: >',
          '  网文节奏：每章至少一个爽点，',
          '  三章一个小高潮。写连载章节时使用。',
          'license: MIT',
          'allowed-tools:',
          '  - Read',
          '---',
          '',
          '# 节奏',
          '',
          '- 开篇三百字内进入冲突',
          '',
        ].join('\n'),
      ),
    );
    expect(doc).toEqual({ name: 'webnovel-pacing', description: '网文节奏：每章至少一个爽点， 三章一个小高潮。写连载章节时使用。', metadata: {}, body: '# 节奏\n\n- 开篇三百字内进入冲突' });

    const literal = value(parseSkillMd('---\nname: "对话"\ndescription: |\n  第一行\n  第二行\n---\n正文'));
    expect(literal).toMatchObject({ name: '对话', description: '第一行\n第二行', body: '正文' });
    expect(value(parseSkillMd("---\nname: x\ndescription: 'it''s'\n---\n正文")).description).toBe("it's");
  });

  it('Windows 换行、开头的 BOM 与 metadata', () => {
    const doc = value(parseSkillMd('﻿---\r\nname: hook\r\ndescription: "章末：写结尾时用"\r\nmetadata:\r\n  title: "章末钩子"\r\n  version: "2"\r\n---\r\n\r\n停在悬念上。\r\n'));
    expect(doc).toEqual({ name: 'hook', description: '章末：写结尾时用', metadata: { title: '章末钩子', version: '2' }, body: '停在悬念上。' });
  });

  it('写出的文件能原样读回；名字含特殊字符、说明含引号与冒号时加引号', () => {
    const doc = { name: '人物声音', description: '说话方式：“各有各的腔调”，写对话时用', metadata: { title: '对话', version: '' }, body: '# 要求\n\n每人一种腔调。' };
    const text = formatSkillMd(doc);
    expect(text).toMatch(/^---\nname: "人物声音"\ndescription: "说话方式：“各有各的腔调”，写对话时用"\nmetadata:\n {2}title: "对话"\n---\n\n# 要求/);
    expect(value(parseSkillMd(text))).toEqual({ ...doc, metadata: { title: '对话' } });
    expect(formatSkillMd({ name: 'plain-name', description: 'd', metadata: {}, body: 'b' })).toBe('---\nname: plain-name\ndescription: "d"\n---\n\nb\n');
  });

  it('缺文件头、缺 name、缺 description、没有指令时说明原因', () => {
    expect(parseSkillMd('只是一段文字')).toMatchObject({ ok: false, error: expect.stringContaining('不是 SKILL.md') });
    expect(parseSkillMd('---\ndescription: d\n---\n正文')).toMatchObject({ ok: false, error: expect.stringContaining('缺少 name') });
    expect(parseSkillMd('---\nname: n\n---\n正文')).toMatchObject({ ok: false, error: expect.stringContaining('缺少 description') });
    expect(parseSkillMd('---\nname: n\ndescription: d\n---\n')).toMatchObject({ ok: false, error: expect.stringContaining('没有指令') });
  });
});
