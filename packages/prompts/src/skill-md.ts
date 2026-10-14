// 写作技能的标准文件格式 SKILL.md（与 Claude 等工具通用的技能格式）：文件头是 YAML，
// name 是技能的标识，description 说明它做什么、什么时候用；文件头之后是给写手的指令（Markdown）。
// 本应用自己的字段放在 metadata 里：title（界面上显示的名称）、version 与 order（内置技能的版本与顺序）。
// 只读取文件头里用得到的这一小部分 YAML（单行值、带引号的值、> 与 | 多行值、一层 metadata），不引入 YAML 库。
import { err, ok, type Result } from '@fudiao/shared';

export type SkillDocument = {
  readonly name: string;
  readonly description: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly body: string;
};

/** 去掉成对的引号；双引号按 YAML 的转义读（\n、\"、\\ 等）。 */
function scalar(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\(["\\/nt])/g, (_, ch: string) => (ch === 'n' ? '\n' : ch === 't' ? '\t' : ch));
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

const indentOf = (line: string) => line.length - line.trimStart().length;

/** 读 SKILL.md：文件头须有 name 与 description，文件头之后须有指令。 */
export function parseSkillMd(text: string): Result<SkillDocument, string> {
  // 去掉开头的 BOM（记事本另存的 UTF-8 文件常带），统一换行。
  const source = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n?/g, '\n');
  const match = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n([\s\S]*))?$/.exec(source);
  if (match === null) return err('不是 SKILL.md：文件开头应是以 --- 包起来的文件头（name 与 description）');
  const lines = (match[1] ?? '').split('\n');
  const top: Record<string, string> = {};
  const metadata: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '' || line.trimStart().startsWith('#') || indentOf(line) > 0) continue;
    const kv = /^([\w-]+):[ \t]*(.*)$/.exec(line);
    if (kv === null) continue;
    const key = kv[1]!;
    const rest = kv[2]!.trim();
    // 缩进的后续行：多行值或下一层的键值。
    const block: string[] = [];
    while (i + 1 < lines.length && (lines[i + 1]!.trim() === '' || indentOf(lines[i + 1]!) > 0)) block.push(lines[++i]!);
    if (/^[>|][+-]?$/.test(rest)) {
      const indent = Math.min(...block.filter((l) => l.trim() !== '').map(indentOf));
      const content = block.map((l) => l.slice(Number.isFinite(indent) ? indent : 0));
      top[key] = (rest.startsWith('>') ? content.join('\n').replace(/([^\n])\n(?=[^\n])/g, '$1 ') : content.join('\n')).trim();
    } else if (rest === '' && key === 'metadata') {
      for (const l of block) {
        const inner = /^\s+([\w-]+):[ \t]*(.*)$/.exec(l);
        if (inner !== null) metadata[inner[1]!] = scalar(inner[2]!);
      }
    } else if (rest !== '') {
      top[key] = scalar(rest);
    }
  }
  const name = (top['name'] ?? '').trim();
  const description = (top['description'] ?? '').trim();
  const body = (match[2] ?? '').trim();
  if (name === '') return err('SKILL.md 的文件头缺少 name（技能的标识）');
  if (description === '') return err('SKILL.md 的文件头缺少 description（这项技能做什么、什么时候用）');
  if (body === '') return err('SKILL.md 的文件头之后没有指令');
  return ok({ name, description, metadata, body });
}

const quoted = (value: string) => JSON.stringify(value);

/** 写 SKILL.md：name 与 description 在前，本应用的字段在 metadata 里。 */
export function formatSkillMd(doc: SkillDocument): string {
  const meta = Object.entries(doc.metadata).filter(([, v]) => v !== '');
  return [
    '---',
    `name: ${/^[\w-]+$/.test(doc.name) ? doc.name : quoted(doc.name)}`,
    `description: ${quoted(doc.description)}`,
    ...(meta.length === 0 ? [] : ['metadata:', ...meta.map(([k, v]) => `  ${k}: ${quoted(v)}`)]),
    '---',
    '',
    doc.body.trim(),
    '',
  ].join('\n');
}
