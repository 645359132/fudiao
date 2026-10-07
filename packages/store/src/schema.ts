/**
 * 作品库的表结构清单，按外键依赖排序（导入时依次插入）。
 * 测试校验它与迁移后的实际结构完全一致：新增迁移时必须同步更新这里，导出导入才不会漏表漏列。
 */
export type TableSpec = {
  readonly name: string;
  readonly columns: readonly string[];
  readonly primaryKey: readonly string[];
  /** 存为 JSON 文本的列；导出时解析为对象，便于阅读。 */
  readonly json: readonly string[];
};

const VERSIONED = ['version', 'created_at', 'updated_at'] as const;

export const TABLES: readonly TableSpec[] = [
  {
    name: 'project',
    columns: ['id', 'singleton', 'title', 'genre', 'synopsis', 'outline', 'goals', ...VERSIONED],
    primaryKey: ['id'],
    json: ['goals'],
  },
  {
    name: 'chapter',
    columns: ['id', 'order_key', 'title', 'summary', 'notes', 'status', 'trashed_at', ...VERSIONED],
    primaryKey: ['id'],
    json: [],
  },
  {
    name: 'paragraph',
    columns: ['id', 'chapter_id', 'order_key', 'text', 'source_kind', 'source_spans', 'ai_origin_text', 'split_from', ...VERSIONED],
    primaryKey: ['id'],
    json: ['source_spans'],
  },
  {
    name: 'chapter_snapshot',
    columns: ['id', 'chapter_id', 'reason', 'title', 'paragraphs', 'created_at'],
    primaryKey: ['id'],
    json: ['paragraphs'],
  },
  {
    name: 'entity',
    columns: ['id', 'kind', 'name', 'aliases', 'data', 'locked', ...VERSIONED],
    primaryKey: ['id'],
    json: ['aliases', 'data'],
  },
  {
    name: 'fact',
    columns: [
      'id',
      'kind',
      'holder_id',
      'subject_ids',
      'content',
      'modality',
      'confidence',
      'valid_from_chapter_id',
      'valid_to_chapter_id',
      'valid_from_label',
      'valid_from_order',
      'valid_to_label',
      'valid_to_order',
      'status',
      'review_reason',
      ...VERSIONED,
    ],
    primaryKey: ['id'],
    json: ['subject_ids'],
  },
  {
    name: 'source_ref',
    columns: ['id', 'from_type', 'from_id', 'to_type', 'to_id', 'to_version', 'anchor', 'created_at'],
    primaryKey: ['id'],
    json: ['anchor'],
  },
  {
    name: 'story_event',
    columns: [
      'id',
      'story_time_label',
      'story_time_order',
      'summary',
      'participants',
      'location_id',
      'perceptions',
      'origin_run_id',
      'origin_seq',
      ...VERSIONED,
    ],
    primaryKey: ['id'],
    json: ['participants', 'perceptions'],
  },
  {
    name: 'event_paragraph_link',
    columns: ['event_id', 'paragraph_id', 'mode', 'created_at'],
    primaryKey: ['event_id', 'paragraph_id'],
    json: [],
  },
];
