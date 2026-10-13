// M3 评估（施工文档 M3-09）的输入：一部短篇的材料、要植入的问题，以及模型服务的配置。
// 评估在本机用 Node 运行，只供作者手动执行；API Key 从环境变量读取，不写入任何文件（硬性规则 14、15、18）。
// 根目录的工具不依赖 zod（它不是根包的依赖），这里手写校验。

const ISSUE_KINDS = ['setting_conflict', 'timeline', 'pov_leak', 'foreshadow', 'character', 'off_plan', 'pacing', 'ai_tone'] as const;
const PLANT_TYPES = ['setting_conflict', 'pov_leak', 'foreshadow', 'timeline', 'character'] as const;
const ENTITY_KINDS = ['character', 'location', 'organization', 'item', 'rule'] as const;
const PROVIDER_KINDS = ['anthropic', 'openai', 'gemini', 'openai_compatible', 'local'] as const;

/** 植入的问题：在写好的一章中间插入一段有问题的文字，看审核能不能指出来。 */
export type EvalPlant = {
  readonly id: string;
  /** 问题的种类，报告按它分组。 */
  readonly type: (typeof PLANT_TYPES)[number];
  /** 第几章（从 1 起）。 */
  readonly chapter: number;
  readonly text: string;
  /** 审核把它归为这些类型之一时算“类型也对”。 */
  readonly expect: readonly (typeof ISSUE_KINDS)[number][];
  readonly note: string;
};

export type EvalBook = {
  readonly title: string;
  readonly genre: string;
  readonly synopsis: string;
  readonly outline: string;
  readonly chapterCount: number;
  readonly wordsPerChapter: number;
  readonly entities: readonly {
    readonly kind: (typeof ENTITY_KINDS)[number];
    readonly name: string;
    readonly aliases: readonly string[];
    readonly description: string;
    readonly locked: boolean;
  }[];
  readonly foreshadows: readonly { readonly title: string; readonly content: string; readonly reveal: string }[];
  readonly plants: readonly EvalPlant[];
};

export type EvalPrices = { readonly input: number; readonly output: number; readonly cacheRead?: number; readonly cacheWrite?: number };

export type EvalConfig = {
  readonly provider: {
    readonly kind: (typeof PROVIDER_KINDS)[number];
    readonly name: string;
    readonly baseUrl: string;
    /** 保存 API Key 的环境变量名；本地端点不需要时为 null。 */
    readonly apiKeyEnv: string | null;
  };
  readonly model: {
    readonly id: string;
    readonly capabilities: {
      readonly structuredOutput: 'native' | 'json_object' | 'prompt';
      readonly promptCaching: boolean;
      readonly reasoningControl: 'effort' | 'none';
      readonly refusalFallback: 'server_default' | 'none';
      readonly contextWindow: number;
      readonly maxOutputTokens: number;
    };
    /** 美元 / 百万 Token；为 null 时费用显示为未知。 */
    readonly prices: EvalPrices | null;
  };
};

export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

/** 读取时收集不对的地方，最后一并报告。 */
class Reader {
  readonly problems: string[] = [];
  private bad<T>(path: string, expected: string, fallback: T): T {
    this.problems.push(`${path} 应为${expected}`);
    return fallback;
  }
  object(value: unknown, path: string): Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : this.bad(path, '对象', {});
  }
  list(value: unknown, path: string, optional = false): readonly unknown[] {
    if (value === undefined && optional) return [];
    return Array.isArray(value) ? (value as unknown[]) : this.bad(path, '数组', []);
  }
  text(value: unknown, path: string, fallback?: string): string {
    if (value === undefined && fallback !== undefined) return fallback;
    if (typeof value !== 'string') return this.bad(path, '文字', '');
    return fallback === undefined && value.trim() === '' ? this.bad(path, '非空的文字', '') : value;
  }
  flag(value: unknown, path: string, fallback: boolean): boolean {
    if (value === undefined) return fallback;
    return typeof value === 'boolean' ? value : this.bad(path, ' true 或 false', fallback);
  }
  integer(value: unknown, path: string, min: number, max: number): number {
    return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : this.bad(path, ` ${min} 到 ${max} 之间的整数`, min);
  }
  amount(value: unknown, path: string): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : this.bad(path, '不小于 0 的数', 0);
  }
  oneOf<T extends string>(value: unknown, path: string, options: readonly T[], fallback?: T): T {
    if (value === undefined && fallback !== undefined) return fallback;
    return typeof value === 'string' && (options as readonly string[]).includes(value) ? (value as T) : this.bad(path, `${options.join('、')}之一`, options[0] as T);
  }
}

function parse<T>(text: string, what: string, read: (r: Reader, raw: unknown) => T): Parsed<T> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `${what}不是合法的 JSON：${e instanceof Error ? e.message : String(e)}` };
  }
  const reader = new Reader();
  const value = read(reader, raw);
  return reader.problems.length === 0 ? { ok: true, value } : { ok: false, error: `${what}的内容不对：${reader.problems.slice(0, 5).join('；')}` };
}

export function parseBook(text: string): Parsed<EvalBook> {
  return parse(text, '短篇的材料', (r, raw) => {
    const o = r.object(raw, '材料');
    return {
      title: r.text(o['title'], 'title'),
      genre: r.text(o['genre'], 'genre', ''),
      synopsis: r.text(o['synopsis'], 'synopsis', ''),
      outline: r.text(o['outline'], 'outline'),
      chapterCount: r.integer(o['chapterCount'], 'chapterCount', 1, 20),
      wordsPerChapter: r.integer(o['wordsPerChapter'], 'wordsPerChapter', 500, 8000),
      entities: r.list(o['entities'], 'entities').map((item, i) => {
        const e = r.object(item, `entities[${i}]`);
        return {
          kind: r.oneOf(e['kind'], `entities[${i}].kind`, ENTITY_KINDS),
          name: r.text(e['name'], `entities[${i}].name`),
          aliases: r.list(e['aliases'], `entities[${i}].aliases`, true).map((a, j) => r.text(a, `entities[${i}].aliases[${j}]`)),
          description: r.text(e['description'], `entities[${i}].description`, ''),
          locked: r.flag(e['locked'], `entities[${i}].locked`, false),
        };
      }),
      foreshadows: r.list(o['foreshadows'], 'foreshadows', true).map((item, i) => {
        const f = r.object(item, `foreshadows[${i}]`);
        return { title: r.text(f['title'], `foreshadows[${i}].title`), content: r.text(f['content'], `foreshadows[${i}].content`, ''), reveal: r.text(f['reveal'], `foreshadows[${i}].reveal`, '') };
      }),
      plants: r.list(o['plants'], 'plants', true).map((item, i) => {
        const p = r.object(item, `plants[${i}]`);
        const expect = r.list(p['expect'], `plants[${i}].expect`).map((k, j) => r.oneOf(k, `plants[${i}].expect[${j}]`, ISSUE_KINDS));
        if (expect.length === 0) r.problems.push(`plants[${i}].expect 至少要有一种类型`);
        return {
          id: r.text(p['id'], `plants[${i}].id`),
          type: r.oneOf(p['type'], `plants[${i}].type`, PLANT_TYPES),
          chapter: r.integer(p['chapter'], `plants[${i}].chapter`, 1, 20),
          text: r.text(p['text'], `plants[${i}].text`),
          expect,
          note: r.text(p['note'], `plants[${i}].note`, ''),
        };
      }),
    };
  });
}

export function parseConfig(text: string): Parsed<EvalConfig> {
  return parse(text, '模型配置', (r, raw) => {
    const o = r.object(raw, '配置');
    const p = r.object(o['provider'], 'provider');
    const m = r.object(o['model'], 'model');
    const c = r.object(m['capabilities'], 'model.capabilities');
    const prices = m['prices'] === null || m['prices'] === undefined ? null : r.object(m['prices'], 'model.prices');
    return {
      provider: {
        kind: r.oneOf(p['kind'], 'provider.kind', PROVIDER_KINDS),
        name: r.text(p['name'], 'provider.name'),
        baseUrl: r.text(p['baseUrl'], 'provider.baseUrl'),
        apiKeyEnv: p['apiKeyEnv'] === null ? null : r.text(p['apiKeyEnv'], 'provider.apiKeyEnv'),
      },
      model: {
        id: r.text(m['id'], 'model.id'),
        capabilities: {
          structuredOutput: r.oneOf(c['structuredOutput'], 'model.capabilities.structuredOutput', ['native', 'json_object', 'prompt'] as const),
          promptCaching: r.flag(c['promptCaching'], 'model.capabilities.promptCaching', false),
          reasoningControl: r.oneOf(c['reasoningControl'], 'model.capabilities.reasoningControl', ['effort', 'none'] as const, 'none'),
          refusalFallback: r.oneOf(c['refusalFallback'], 'model.capabilities.refusalFallback', ['server_default', 'none'] as const, 'none'),
          contextWindow: r.integer(c['contextWindow'], 'model.capabilities.contextWindow', 1, 100_000_000),
          maxOutputTokens: r.integer(c['maxOutputTokens'], 'model.capabilities.maxOutputTokens', 1, 100_000_000),
        },
        prices:
          prices === null
            ? null
            : {
                input: r.amount(prices['input'], 'model.prices.input'),
                output: r.amount(prices['output'], 'model.prices.output'),
                ...(prices['cacheRead'] !== undefined && { cacheRead: r.amount(prices['cacheRead'], 'model.prices.cacheRead') }),
                ...(prices['cacheWrite'] !== undefined && { cacheWrite: r.amount(prices['cacheWrite'], 'model.prices.cacheWrite') }),
              },
      },
    };
  });
}

/** 一次评估大约要用的 Token（偏高的估计）：一个汉字按 1.5 Token，每次调用另算 2,000 Token 的思考。 */
export function estimateTokens(book: Pick<EvalBook, 'outline' | 'chapterCount' | 'wordsPerChapter' | 'plants'>): { input: number; output: number; calls: number } {
  const perChar = 1.5;
  const thinking = 2_000;
  const chapters = book.chapterCount;
  const chapterTokens = book.wordsPerChapter * perChar;
  const segments = Math.max(1, Math.ceil(book.wordsPerChapter / 1500));
  const planted = new Set(book.plants.map((p) => p.chapter)).size;
  const reviews = chapters + planted;
  const input =
    3 * 500 + // 能力自检
    (2_000 + book.outline.length * perChar) + // 计划草稿
    chapters * segments * (3_500 + chapterTokens / 2) + // 写手：材料加已写的结尾
    chapters * (800 + chapterTokens) + // 长篇记忆
    reviews * (3_000 + chapterTokens); // 审核
  const output =
    3 * 300 +
    (chapters * 700 + thinking) +
    chapters * segments * (chapterTokens / segments + thinking) +
    chapters * (900 + thinking) +
    reviews * (1_800 + thinking);
  return { input: Math.round(input), output: Math.round(output), calls: 3 + 1 + chapters * segments + chapters + reviews };
}

export function estimateCost(tokens: { input: number; output: number }, prices: EvalPrices | null): number | null {
  return prices === null ? null : (tokens.input * prices.input + tokens.output * prices.output) / 1_000_000;
}
