/** 参与匹配的设定条目。 */
export type MatchableEntity = {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly aliases: readonly string[];
};

export type EntityMatch = { readonly from: number; readonly to: number; readonly entityId: string; readonly kind: string; readonly name: string };

/** 中文没有词间空格，单字的名字与别名匹配会大量误中，不参与高亮。 */
export const MIN_MATCH_LENGTH = 2;

/**
 * 按名字与别名在文字中找出设定条目。从左到右扫描，同一位置取最长的匹配，匹配之间不重叠；
 * 同名时先登记的条目优先。位置是 JavaScript 字符串下标，与 ProseMirror 的位置单位一致。
 */
export function createEntityMatcher(entities: readonly MatchableEntity[]) {
  // 按首字分组，组内按长度从长到短，同一位置先试最长的名字。
  const byFirst = new Map<string, { text: string; entity: MatchableEntity }[]>();
  const seen = new Set<string>();
  for (const entity of entities) {
    for (const text of [entity.name, ...entity.aliases]) {
      if (text.length < MIN_MATCH_LENGTH || seen.has(text)) continue;
      seen.add(text);
      const first = text.charAt(0);
      byFirst.set(first, [...(byFirst.get(first) ?? []), { text, entity }]);
    }
  }
  for (const list of byFirst.values()) list.sort((a, b) => b.text.length - a.text.length);

  return {
    find(text: string): EntityMatch[] {
      const out: EntityMatch[] = [];
      if (byFirst.size === 0) return out;
      for (let i = 0; i < text.length; ) {
        const hit = byFirst.get(text.charAt(i))?.find((c) => text.startsWith(c.text, i));
        if (hit === undefined) {
          i++;
          continue;
        }
        out.push({ from: i, to: i + hit.text.length, entityId: hit.entity.id, kind: hit.entity.kind, name: hit.entity.name });
        i += hit.text.length;
      }
      return out;
    },
  };
}
