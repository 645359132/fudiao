// 浏览器预览的演示模型：不联网。能力自检给出合格的结果；AI 助手按作者的话里几个关键词给出演示动作，
// 逐段流式输出，模拟真实服务的节奏。只在开发时用。
import type { CallOptions, LlmError, LlmPort, LlmRequest, LlmResult } from '@fudiao/llm';
import { SELF_TEST_EXPECTED } from '@fudiao/prompts';
import { ok, type Result } from '@fudiao/shared';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 最后一条消息里作者的话；没有时（这一步是动作结果）为 null。 */
function request(r: LlmRequest): string | null {
  const last = r.messages.at(-1)?.content ?? '';
  const i = last.lastIndexOf('【作者】');
  return i < 0 ? null : last.slice(i + 4).trim();
}

function assistantReply(r: LlmRequest): string {
  const said = request(r);
  if (said === null) return JSON.stringify({ message: '好了，都办完了。还需要什么？', actions: [], done: true });
  if (/人物|角色/.test(said)) {
    return JSON.stringify({
      message: '我给你建了一张人物卡片，名字和说明都可以再改。',
      actions: [{ tool: 'create_entity', kind: 'character', name: '苏晚', description: '药铺的女掌柜，二十五岁，表面温和，暗中替旧主保管一本账册；说话慢，从不正面回答问题。', aliases: ['苏掌柜'] }],
      done: true,
    });
  }
  if (/选中|润色|扩写|缩写|改写/.test(said)) {
    const operation = /扩写/.test(said) ? 'expand' : /缩/.test(said) ? 'shorten' : /改写/.test(said) ? 'rewrite' : 'polish';
    return JSON.stringify({ message: '好，我来改选中的这段，改好的放在章节旁的“AI 写作”里，你对照着看。', actions: [{ tool: 'edit_selection', operation, instruction: null }], done: true });
  }
  if (/审核|检查/.test(said)) {
    return JSON.stringify({ message: '我来审核这一章。', actions: [{ tool: 'review_chapter', chapter: '第一章 下山' }], done: true });
  }
  if (/卷/.test(said)) {
    return JSON.stringify({ message: '加了一卷，放在最后。', actions: [{ tool: 'create_volume', title: '第三卷 归途', summary: '沈砚带着账册回到起点，旧案真相揭开。', after: null }], done: true });
  }
  return JSON.stringify({
    message: `（预览中的演示回复）你说的是：“${said}”。接上真实的模型后，我会按你的意思去新建卷与章节、写人物卡片、做章节计划或续写。`,
    actions: [],
    done: true,
  });
}

export function demoLlm(): LlmPort {
  return {
    async complete(r: LlmRequest, options: CallOptions = {}): Promise<Result<LlmResult, LlmError>> {
      const text =
        r.template.id === 'self_test'
          ? JSON.stringify(SELF_TEST_EXPECTED)
          : r.template.id === 'assistant_turn'
            ? assistantReply(r)
            : r.template.id === 'chapter_review'
              ? JSON.stringify({ issues: [] })
              : r.template.id === 'selection_edit'
                ? '石阶上的冰还没有化尽，他一步一步踩稳了才往下走。竹篓很轻，里面只有两件换洗的衣裳，和师父留下的那封信。'
                : '演示';
      // 逐段输出，像真实服务那样流式到达。
      for (let i = 0; i < text.length; i += 12) {
        if (options.signal?.aborted === true) break;
        options.onEvent?.({ type: 'text', delta: text.slice(i, i + 12) });
        if (r.template.id === 'assistant_turn' || r.template.id === 'selection_edit') await sleep(25);
      }
      return ok({
        outcome: options.signal?.aborted === true ? 'cancelled' : 'completed',
        text,
        usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 900, cacheWriteTokens: 0 },
        provider: r.model.provider,
        servedModel: r.model.model,
        stopReason: 'stop',
        fallbackUsed: false,
        requestHash: `demo-${r.template.id}-${r.messages.length}`,
      });
    },
  };
}
