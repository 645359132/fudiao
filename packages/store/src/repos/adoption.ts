// 采纳推演草案（需求 B29、B55，施工文档 M4-08）：把推演写成的正文、作者选定的事件与事实一次写入作品。
// 这里只生成语句，由调用方与正文替换的语句放进同一个事务：要么全部生效，要么一条也不写。
import type { Statement } from '../sql';
import type { WriteContext } from './common';
import { factInsertStatement, type FactInput } from './fact';

export type AdoptedEvent = {
  readonly id: string;
  readonly summary: string;
  /** 参与者（人物设定的标识）。 */
  readonly participants: readonly string[];
  /** 发生的地点（地点设定的标识）；对不上设定时为 null。 */
  readonly locationId: string | null;
  /** 各角色的感知：人物设定的标识与感知方式（当事人、看见、听见）。 */
  readonly perceptions: readonly { readonly entityId: string; readonly channel: string }[];
  /** 来源：推演运行与事件序号（事实来源验收：采纳的推演事实定位事件记录）。 */
  readonly originRunId: string;
  readonly originSeq: number;
};

export type AdoptedFact = {
  readonly id: string;
  readonly input: FactInput;
  /** 这条事实依据的故事事件（这段正文讲述的事件）。 */
  readonly eventIds: readonly string[];
};

export type AdoptionInput = {
  readonly candidate: { readonly id: string; readonly version: number };
  /** 新建的故事事件。 */
  readonly events: readonly AdoptedEvent[];
  /** 这段正文讲述的全部事件：新建的，加上以前采纳过、这次再次讲述的（同一件事只有一个故事事件，B55）。 */
  readonly linkedEventIds: readonly string[];
  readonly facts: readonly AdoptedFact[];
  /** 写入的正文段落：每一段都关联 linkedEventIds（正面叙述）。 */
  readonly paragraphIds: readonly string[];
};

export function adoptionStatements(input: AdoptionInput, ctx: WriteContext, newId: () => string): Statement[] {
  const statements: Statement[] = [];
  for (const e of input.events) {
    statements.push({
      sql: `INSERT INTO story_event (id, summary, participants, location_id, perceptions, origin_run_id, origin_seq, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        e.id,
        e.summary,
        JSON.stringify(e.participants),
        e.locationId,
        JSON.stringify(e.perceptions.map((p) => ({ entity: p.entityId, channel: p.channel }))),
        e.originRunId,
        e.originSeq,
        ctx.now,
        ctx.now,
      ],
    });
  }
  for (const eventId of input.linkedEventIds) {
    for (const paragraphId of input.paragraphIds) {
      // 撤回采纳（正文由快照恢复）后再采纳到同一段时，这件事与这一段的关联还在：同一对只记一次。
      statements.push({
        sql: "INSERT OR IGNORE INTO event_paragraph_link (event_id, paragraph_id, mode, created_at) VALUES (?, ?, 'direct', ?)",
        params: [eventId, paragraphId, ctx.now],
      });
    }
  }
  for (const f of input.facts) {
    // 作者在采纳时逐条选定，即为接受（硬性规则 21）：状态记为已确认。
    statements.push(factInsertStatement(f.id, f.input, 'confirmed', ctx));
    for (const eventId of f.eventIds) {
      statements.push({
        sql: "INSERT INTO source_ref (id, from_type, from_id, to_type, to_id, to_version, created_at) VALUES (?, 'fact', ?, 'story_event', ?, 1, ?)",
        params: [newId(), f.id, eventId, ctx.now],
      });
    }
  }
  statements.push({
    sql: "UPDATE candidate SET status = 'accepted', status_reason = NULL, version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND status = 'pending'",
    params: [ctx.now, input.candidate.id, input.candidate.version],
    expectChanges: 1,
  });
  return statements;
}
