// 把推演里的结构化内容写成作者看得懂的话（施工文档 M4-05）：裁决的效果、发生的事、可以分支的时点。
// 只做展示与格式转换，不改变任何状态。
import type { Effect, RuledOccurrence, SemanticRuling } from '@fudiao/domain';
import type { RunEvent } from '@fudiao/engine';
import type { SemanticRulingOutput } from '@fudiao/prompts';

type Name = (id: string) => string;

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
