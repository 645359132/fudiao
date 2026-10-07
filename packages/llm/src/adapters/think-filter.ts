const OPEN = '<think>';
const CLOSE = '</think>';

/**
 * 去掉正文开头的 `<think>…</think>`。部分推理模型经 OpenAI 兼容接口（vLLM、Ollama 等）把思考过程
 * 放在正文里；不去掉会破坏 JSON 解析，也会混进候选稿。流式输入时逐段处理，思考部分不会作为增量发出。
 * 只处理开头的一段：正文中间出现的同名文字照常保留。
 */
export class ThinkFilter {
  private pending = '';
  private state: 'start' | 'thinking' | 'after' | 'text' = 'start';

  /** 送入一段增量，返回可以发出的正文。 */
  push(delta: string): string {
    if (this.state === 'text') return delta;
    this.pending += delta;
    if (this.state === 'start') {
      const head = this.pending.trimStart();
      // 还看不出开头是不是思考标签：继续等。
      if (head.length < OPEN.length && OPEN.startsWith(head)) return '';
      if (!head.startsWith(OPEN)) return this.release();
      this.pending = head.slice(OPEN.length);
      this.state = 'thinking';
    }
    if (this.state === 'thinking') {
      const end = this.pending.indexOf(CLOSE);
      if (end < 0) return '';
      this.pending = this.pending.slice(end + CLOSE.length);
      this.state = 'after';
    }
    // 思考之后的空白不属于正文。
    this.pending = this.pending.trimStart();
    return this.pending === '' ? '' : this.release();
  }

  /** 流结束：开头未完成的部分按正文发出；未闭合的思考整体丢弃。 */
  end(): string {
    if (this.state === 'start') return this.release();
    this.pending = '';
    return '';
  }

  private release(): string {
    const out = this.pending;
    this.pending = '';
    this.state = 'text';
    return out;
  }
}
