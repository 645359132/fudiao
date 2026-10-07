import { err, ok, type Result } from '@novel-writer/shared';

/**
 * 极简的模板渲染：{{变量}}、{{#区块}}…{{/区块}}、{{^反向区块}}…{{/区块}}、{{> 局部模板}}。
 * 提示词的全部文字都在模板文件里，代码只提供数据（硬性规则 12）。数据原样输出，不再当作模板解释。
 */
export type RenderValue = string | number | boolean | null | readonly RenderValue[] | { readonly [key: string]: RenderValue };
export type RenderContext = { readonly [key: string]: RenderValue };

type Node =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'var'; readonly path: string }
  | { readonly type: 'partial'; readonly name: string }
  | { readonly type: 'section'; readonly path: string; readonly inverted: boolean; readonly children: readonly Node[] };

const TAG = /{{\s*([#^/>]?)\s*([^}]*?)\s*}}/g;

// 独占一行的区块标签连同换行一起去掉，避免留下空行。
const standalone = (source: string) => source.replace(/^[ \t]*({{\s*[#^/][^}]*}})[ \t]*\r?\n/gm, '$1');

function parse(raw: string): Result<Node[], string> {
  const source = standalone(raw);
  const root: Node[] = [];
  const stack: { path: string; inverted: boolean; children: Node[] }[] = [];
  const top = () => stack.at(-1)?.children ?? root;
  let last = 0;
  for (const match of source.matchAll(TAG)) {
    const [whole, sigil = '', name = ''] = match;
    const index = match.index;
    if (index > last) top().push({ type: 'text', text: source.slice(last, index) });
    last = index + whole.length;
    if (sigil === '#' || sigil === '^') {
      stack.push({ path: name, inverted: sigil === '^', children: [] });
    } else if (sigil === '/') {
      const open = stack.pop();
      if (open?.path !== name) return err(`区块 ${name} 的结束标签不匹配`);
      top().push({ type: 'section', path: open.path, inverted: open.inverted, children: open.children });
    } else if (sigil === '>') {
      top().push({ type: 'partial', name });
    } else {
      top().push({ type: 'var', path: name });
    }
  }
  const tail = source.slice(last);
  if (tail !== '') top().push({ type: 'text', text: tail });
  if (stack.length > 0) return err(`区块 ${stack.at(-1)?.path ?? ''} 没有结束标签`);
  return ok(root);
}

const MISSING = Symbol('missing');

function lookup(stack: readonly RenderValue[], path: string): RenderValue | typeof MISSING {
  if (path === '.') return stack.at(-1) ?? MISSING;
  const [head = '', ...rest] = path.split('.');
  for (let i = stack.length - 1; i >= 0; i--) {
    const frame = stack[i];
    if (frame !== null && typeof frame === 'object' && !Array.isArray(frame) && head in frame) {
      let value: RenderValue | undefined = (frame as RenderContext)[head];
      for (const key of rest) {
        value = value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as RenderContext)[key] : undefined;
        if (value === undefined) return MISSING;
      }
      return value === undefined ? MISSING : value;
    }
  }
  return MISSING;
}

const truthy = (v: RenderValue) => (Array.isArray(v) ? v.length > 0 : v !== null && v !== false && v !== '');

function emit(
  nodes: readonly Node[],
  stack: readonly RenderValue[],
  partials: Readonly<Record<string, string>>,
  depth: number,
): Result<string, string> {
  let out = '';
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        out += node.text;
        break;
      case 'var': {
        const value = lookup(stack, node.path);
        if (value === MISSING) return err(`变量 ${node.path} 不存在`);
        if (value !== null && typeof value === 'object') return err(`变量 ${node.path} 不是文字`);
        out += value === null ? '' : String(value);
        break;
      }
      case 'partial': {
        const source = partials[node.name];
        if (source === undefined) return err(`局部模板 ${node.name} 不存在`);
        if (depth > 8) return err(`局部模板 ${node.name} 嵌套过深`);
        const parsed = parse(source);
        if (!parsed.ok) return parsed;
        const rendered = emit(parsed.value, stack, partials, depth + 1);
        if (!rendered.ok) return rendered;
        out += rendered.value;
        break;
      }
      case 'section': {
        const found = lookup(stack, node.path);
        const value: RenderValue = found === MISSING ? null : found;
        if (node.inverted) {
          if (!truthy(value)) {
            const rendered = emit(node.children, stack, partials, depth);
            if (!rendered.ok) return rendered;
            out += rendered.value;
          }
          break;
        }
        if (!truthy(value)) break;
        const frames = Array.isArray(value) ? value : [value];
        for (const frame of frames) {
          const rendered = emit(node.children, frame === true ? stack : [...stack, frame], partials, depth);
          if (!rendered.ok) return rendered;
          out += rendered.value;
        }
        break;
      }
    }
  }
  return ok(out);
}

export function render(
  template: string,
  context: RenderContext,
  partials: Readonly<Record<string, string>> = {},
): Result<string, string> {
  const parsed = parse(template);
  if (!parsed.ok) return parsed;
  return emit(parsed.value, [context], partials, 0);
}

export type TemplateMeta = {
  readonly id: string;
  readonly version: string;
  readonly task: string;
  readonly output?: string;
};

export type Segment = { readonly kind: 'system' | 'user'; readonly cache: boolean; readonly body: string };

export type ParsedTemplate = { readonly meta: TemplateMeta; readonly segments: readonly Segment[] };

/**
 * 模板文件：文件头声明 id、版本、任务与输出 schema；正文以 `@@system`、`@@system cache`、
 * `@@user` 分段。`cache` 表示在这一段之后设置缓存断点。
 */
export function parseTemplate(source: string): Result<ParsedTemplate, string> {
  const head = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(source);
  if (head?.[1] === undefined) return err('缺少文件头');
  const fields: Record<string, string> = {};
  for (const line of head[1].split(/\r?\n/)) {
    const m = /^(\w+):\s*(.*)$/.exec(line.trim());
    if (m?.[1] !== undefined && m[2] !== undefined) fields[m[1]] = m[2];
  }
  const { id, version, task, output } = fields;
  if (id === undefined || version === undefined || task === undefined) return err('文件头缺少 id、version 或 task');

  const segments: Segment[] = [];
  let current: { kind: Segment['kind']; cache: boolean; lines: string[] } | undefined;
  const flush = () => {
    if (current) segments.push({ kind: current.kind, cache: current.cache, body: current.lines.join('\n').trim() });
  };
  for (const line of source.slice(head[0].length).split(/\r?\n/)) {
    const directive = /^@@(system|user)(\s+cache)?\s*$/.exec(line);
    if (directive) {
      flush();
      current = { kind: directive[1] as Segment['kind'], cache: directive[2] !== undefined, lines: [] };
    } else if (current) {
      current.lines.push(line);
    } else if (line.trim() !== '') {
      return err('正文必须以 @@system 或 @@user 开始');
    }
  }
  flush();
  return ok({ meta: { id, version, task, ...(output !== undefined && { output }) }, segments });
}
