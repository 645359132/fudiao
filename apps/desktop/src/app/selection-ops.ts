// 选区操作（需求 B16）：续写、改写、扩写、缩写、润色。上下文来自上下文清单（B18），结果流式返回，可取消与重试；
// 结果先作为候选稿交给作者（M2-06），不直接写入正文（硬性规则 21）。
import type { ContextManifest } from '@fudiao/context';
import type { SelectionOperation } from '@fudiao/prompts';

export const OPERATION_LABELS: Readonly<Record<SelectionOperation, string>> = {
  continue: '续写',
  rewrite: '改写',
  expand: '扩写',
  shorten: '缩写',
  polish: '润色',
};

export const OPERATIONS = Object.keys(OPERATION_LABELS) as SelectionOperation[];

/** 候选稿的来历：选区操作，或由推演的节拍表写成的正文（B29）。 */
export const CANDIDATE_LABELS: Readonly<Record<SelectionOperation | 'narrate', string>> = { ...OPERATION_LABELS, narrate: '推演写成正文' };

/** 续写的默认字数。 */
export const CONTINUE_LENGTH = 300;

/** 目标字数：续写固定；扩写约两倍；缩写约一半；改写与润色与原文相当。 */
export function targetLength(operation: SelectionOperation, selection: string): number {
  const n = [...selection].length;
  switch (operation) {
    case 'continue':
      return CONTINUE_LENGTH;
    case 'expand':
      return Math.max(n * 2, n + 100);
    case 'shorten':
      return Math.max(Math.round(n / 2), 20);
    case 'rewrite':
    case 'polish':
      return Math.max(n, 20);
  }
}

/** 输出上限：目标字数的两倍再留出思考与余量，不超过模型的最大输出（由调用器再按模型截取）。 */
export const maxOutputTokens = (length: number): number => length * 2 + 1_024;

/** 除续写外都需要先选中文字。 */
export const needsSelection = (operation: SelectionOperation): boolean => operation !== 'continue';

/** 从上下文清单取出提示词的各部分：材料（不含前后文与选中的文字）、前文、选中的文字、后文。 */
export function promptParts(manifest: ContextManifest): {
  materials: { title: string; text: string }[];
  before: string;
  selection: string;
  after: string;
} {
  const text = (kind: 'before' | 'selection' | 'after') => manifest.included.find((e) => e.item.kind === kind)?.item.text ?? '';
  return {
    materials: manifest.included
      .filter((e) => e.item.kind !== 'before' && e.item.kind !== 'selection' && e.item.kind !== 'after')
      .map((e) => ({ title: e.item.title, text: e.item.text })),
    before: text('before'),
    selection: text('selection'),
    after: text('after'),
  };
}
