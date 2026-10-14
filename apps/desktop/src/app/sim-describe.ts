// 把推演里的结构化内容写成作者看得懂的话（施工文档 M4-05）：裁决的效果、发生的事、可以分支的时点。
// 只做展示与格式转换，不改变任何状态。
import type { Effect, Observation, RuledOccurrence, SemanticRuling } from '@fudiao/domain';
import type { RunEvent } from '@fudiao/engine';
import type { SemanticRulingOutput } from '@fudiao/prompts';

type Name = (id: string) => string;

/** 行动与发生的事的种类。 */
export const ACTION_LABELS: Readonly<Record<string, string>> = {
  observe: '观察',
  move: '移动',
  probe: '试探',
  attack: '攻击',
  defend: '防御',
  use_item: '使用物品',
  take: '拾取',
  drop: '放下',
  speak: '说话',
  withdraw: '撤离',
  wait: '等待',
  other: '其他',
  failed_attempt: '失败的尝试',
  trap_triggered: '触发机关',
  discovered: '发现',
  ruled: '裁决结果',
  external: '外部事件',
};

const INJURY: Readonly<Record<string, string>> = { none: '没有受伤', light: '轻伤', severe: '重伤', incapacitated: '失去行动能力' };

export function describeEffect(effect: Effect, name: Name): string {
  switch (effect.type) {
    case 'moveActor':
      return `${name(effect.actor)}移动到${name(effect.to)}`;
    case 'transferItem':
      return effect.to.kind === 'actor' ? `${name(effect.item)}到了${name(effect.to.actor)}手里` : `${name(effect.item)}落在${name(effect.to.zone)}`;
    case 'adjustCounter':
      return `${name(effect.item)}的${effect.counter}${effect.delta >= 0 ? '增加' : '减少'} ${Math.abs(effect.delta)}`;
    case 'setInjury':
      return `${name(effect.actor)}的伤势变为“${INJURY[effect.level] ?? effect.level}”`;
    case 'setActorStatus':
      return `${name(effect.actor)}${effect.status === 'present' ? '回到现场' : '离开现场'}`;
    case 'disarmMechanism':
      return `${name(effect.mechanism)}被触发或拆除`;
    case 'setFlag':
      return `标记 ${effect.flag} 变为${effect.value ? '成立' : '不成立'}`;
    case 'advanceRng':
      return '抽取了随机数';
  }
}

export function describeOccurrence(o: RuledOccurrence, name: Name): string {
  const who = o.participants.length === 0 ? '' : `${o.participants.map(name).join('、')}：`;
  const seen = o.description.visual === undefined ? '' : o.description.visual;
  const heard = o.description.sound === undefined ? '' : `（声音：${o.description.sound}）`;
  return `${who}${seen}${heard}；发生在${o.zones.map(name).join('、')}，${o.visible ? '看得见' : '看不见'}，响度 ${o.loudness}`;
}

/** 裁决写成与裁决模型的输出相同的形式，供作者修改；修改后的内容经同一条转换与校验进入引擎。 */
export function rulingToOutput(ruling: SemanticRuling, rationale: string, uncertainties: readonly string[]): SemanticRulingOutput {
  return {
    rationale,
    effects: ruling.effects.flatMap((e): SemanticRulingOutput['effects'] => {
      switch (e.type) {
        case 'transferItem':
          return [{ type: 'transferItem', item: e.item, toActor: e.to.kind === 'actor' ? e.to.actor : null, toZone: e.to.kind === 'zone' ? e.to.zone : null }];
        case 'moveActor':
        case 'adjustCounter':
        case 'setInjury':
        case 'setActorStatus':
        case 'setFlag':
          return [e];
        // 裁决不能拆除机关或推进随机数，这两种不会出现在待核实的裁决里。
        case 'disarmMechanism':
        case 'advanceRng':
          return [];
      }
    }),
    occurrences: ruling.occurrences.map((o) => ({
      participants: [...o.participants],
      zones: [...o.zones],
      visible: o.visible,
      loudness: o.loudness,
      visual: o.description.visual ?? null,
      sound: o.description.sound ?? null,
    })),
    uncertainties: [...uncertainties],
  };
}

/** 可以分出新推演的时点：快照所在的序号。label 说明当时停在哪里。 */
export type ForkPoint = { readonly seq: number; readonly round: number; readonly label: string };

/** 快照处的说明：看它之后紧跟着的事件（介入），或它自己的最后一条事件（暂停、等待确认、结束）。 */
export function forkLabel(last: RunEvent | undefined, next: RunEvent | undefined): string {
  if (next?.type === 'AuthorIntervened') return '作者介入之前';
  const labels: Partial<Record<RunEvent['type'], string>> = {
    RunPaused: '暂停时',
    RunEnded: '结束时',
    AdjudicationProposed: '等待确认裁决时',
    DirectorProposed: '等待决定导演提议时',
  };
  return (last === undefined ? undefined : labels[last.type]) ?? '停下时';
}

/** 一条观察写成文字：谁做了什么、在哪里、看见或听见了什么。 */
export function describeObservation(o: Observation, name: Name): string {
  if (o.channel === 'sound') {
    return `从${name(o.zones[0] ?? '')}传来声响${o.sound === undefined ? '' : `（${o.sound}）`}${o.item === undefined ? '' : `，听得出是${name(o.item)}`}${o.speech?.clarity === 'full' ? `：“${o.speech.sentences.join('')}”` : ''}${o.description?.sound === undefined ? '' : `：${o.description.sound}`}`;
  }
  const parts = [o.actor === undefined ? '' : name(o.actor), o.kind === undefined ? '' : (ACTION_LABELS[o.kind] ?? o.kind)];
  if (o.item !== undefined) parts.push(name(o.item));
  if (o.target !== undefined) parts.push(`→ ${name(o.target)}`);
  if (o.zones.length > 0) parts.push(`（${o.zones.map(name).join(' → ')}）`);
  if (o.speech?.clarity === 'full') parts.push(`“${o.speech.sentences.join('')}”`);
  if (o.speech?.clarity === 'muffled') parts.push('（听不清）');
  if (o.failed === true) parts.push(`（没有成功${o.violation === undefined ? '' : `：${o.violation.code}`}）`);
  if (o.description?.visual !== undefined) parts.push(`：${o.description.visual}`);
  if (o.content !== undefined) parts.push(`，读到：“${o.content}”`);
  return parts.filter((p) => p !== '').join(' ');
}
