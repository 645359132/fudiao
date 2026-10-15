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
    columns: ['id', 'singleton', 'title', 'genre', 'synopsis', 'outline', 'goals', ...VERSIONED, 'avoid_phrases'],
    primaryKey: ['id'],
    json: ['goals', 'avoid_phrases'],
  },
  {
    // 章节引用卷（迁移 0010），导入时须排在章节之前。
    name: 'volume',
    columns: ['id', 'order_key', 'title', 'summary', ...VERSIONED],
    primaryKey: ['id'],
    json: [],
  },
  {
    name: 'chapter',
    // volume_id 由迁移 0010 追加在末尾。
    columns: ['id', 'order_key', 'title', 'summary', 'notes', 'status', 'trashed_at', ...VERSIONED, 'volume_id'],
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
  {
    name: 'llm_call',
    columns: [
      'id',
      'step_key',
      'task_kind',
      'provider',
      'model',
      'served_model',
      'params',
      'template_id',
      'template_version',
      'request_hash',
      'status',
      'input_tokens',
      'output_tokens',
      'cache_read_tokens',
      'cache_write_tokens',
      'cost',
      'response',
      'error',
      'started_at',
      'finished_at',
    ],
    primaryKey: ['id'],
    json: ['params', 'response', 'error'],
  },
  {
    name: 'foreshadow',
    columns: ['id', 'title', 'content', 'reveal', 'plant_chapter_id', 'plant_anchor', 'payoff_chapter_id', 'payoff_anchor', 'status', ...VERSIONED],
    primaryKey: ['id'],
    json: ['plant_anchor', 'payoff_anchor'],
  },
  {
    name: 'chapter_plan',
    columns: ['chapter_id', 'goal', 'cast_ids', 'beats', 'foreshadow_plant', 'foreshadow_payoff', 'treatment', 'target_words', 'status', 'progress', ...VERSIONED],
    primaryKey: ['chapter_id'],
    json: ['cast_ids', 'beats', 'foreshadow_plant', 'foreshadow_payoff', 'progress'],
  },
  {
    name: 'writing_skill',
    // description 由迁移 0009 追加在末尾。
    columns: ['id', 'key', 'name', 'instruction', 'enabled', 'builtin_version', ...VERSIONED, 'description'],
    primaryKey: ['id'],
    json: [],
  },
  {
    name: 'chapter_memory',
    // open_threads 由迁移 0013 追加在末尾。
    columns: ['chapter_id', 'summary', 'cast_state', 'foreshadow_progress', 'based_on', 'status', 'llm_call_id', ...VERSIONED, 'open_threads'],
    primaryKey: ['chapter_id'],
    json: ['cast_state', 'foreshadow_progress', 'based_on', 'open_threads'],
  },
  {
    name: 'review_issue',
    columns: ['id', 'chapter_id', 'kind', 'severity', 'anchor', 'evidence', 'description', 'suggestion', 'status', 'source', 'llm_call_id', ...VERSIONED],
    primaryKey: ['id'],
    json: ['anchor', 'evidence'],
  },
  {
    name: 'sim_scene',
    columns: ['id', 'chapter_id', 'title', 'config', 'config_version', 'protocol', 'max_rounds', 'first_speaker', ...VERSIONED],
    primaryKey: ['id'],
    json: ['config'],
  },
  {
    // 分支的运行在它的来源之后建立，标识（ULID）也在其后，按主键导出时来源在前。
    name: 'sim_run',
    columns: [
      'id',
      'scene_id',
      'scene_config',
      'scene_config_version',
      'mode',
      'batch_id',
      'parent_run_id',
      'branch_from_seq',
      'budget_usd',
      'status',
      'end_reason',
      'pause_reason',
      'round',
      'last_seq',
      'created_at',
      'updated_at',
    ],
    primaryKey: ['id'],
    json: ['scene_config'],
  },
  {
    name: 'sim_event',
    columns: ['run_id', 'seq', 'batch_first', 'batch_index', 'batch_size', 'type', 'actor', 'payload', 'created_at'],
    primaryKey: ['run_id', 'seq'],
    json: ['payload'],
  },
  {
    name: 'sim_snapshot',
    columns: ['run_id', 'seq', 'state', 'state_hash', 'created_at'],
    primaryKey: ['run_id', 'seq'],
    json: ['state'],
  },
  {
    name: 'evaluation',
    columns: ['id', 'run_id', 'batch_id', 'answers', ...VERSIONED],
    primaryKey: ['id'],
    json: ['answers'],
  },
  {
    name: 'beat_sheet',
    columns: ['id', 'run_id', 'pov_actor', 'from_round', 'to_round', 'up_to_seq', 'beats', 'style', 'llm_call_id', ...VERSIONED],
    primaryKey: ['id'],
    json: ['beats'],
  },
  {
    // 候选稿引用节拍表，节拍表引用推演的运行与事件，导入时须排在它们之后。
    name: 'candidate',
    columns: [
      'id',
      'chapter_id',
      'operation',
      'target',
      'base_text',
      'base_versions',
      'generated',
      'content',
      'status',
      'status_reason',
      'llm_call_id',
      ...VERSIONED,
      'beat_sheet_id',
    ],
    primaryKey: ['id'],
    json: ['target', 'base_versions'],
  },
  {
    name: 'assistant_message',
    columns: ['id', 'seq', 'role', 'payload', 'created_at'],
    primaryKey: ['id'],
    json: ['payload'],
  },
  {
    // 人物关系网（迁移 0012）：引用设定与章节，排在它们之后。
    name: 'relationship',
    columns: ['id', 'from_id', 'to_id', 'category', 'label', 'mutual', 'description', 'secret', 'valid_from_chapter_id', 'valid_to_chapter_id', ...VERSIONED],
    primaryKey: ['id'],
    json: [],
  },
  {
    name: 'relation_position',
    columns: ['entity_id', 'x', 'y', 'updated_at'],
    primaryKey: ['entity_id'],
    json: [],
  },
];

/**
 * 派生的表：由触发器维护的索引（全文查找），不导出，导入数据时随之重建。
 * 含 FTS5 自动建立的影子表。表结构清单的测试据此确认库中没有遗漏的表。
 */
export const DERIVED_TABLES: readonly string[] = [
  'paragraph_search_key',
  'paragraph_fts',
  'paragraph_fts_config',
  'paragraph_fts_content',
  'paragraph_fts_data',
  'paragraph_fts_docsize',
  'paragraph_fts_idx',
];
