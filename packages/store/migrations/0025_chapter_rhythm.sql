-- 章节计划的节奏目标（需求 B87，M8-01）：章节类型、对话多少与章尾方式，JSON 对象 { type, dialogue, ending }，取值见
-- packages/shared 的 CHAPTER_TYPES、DIALOGUE_LEVELS、ENDING_STYLES。写手按它写（对话比例、章尾收法），审核按它量（对话占比低于
-- 目标时提出问题），章节计划草稿按它排布（章尾收法轮换、过渡章）。没有的（旧计划、作者没填）为 NULL：写手按中等对话、章尾不限。
ALTER TABLE chapter_plan ADD COLUMN rhythm TEXT CHECK (rhythm IS NULL OR (json_valid(rhythm) AND json_type(rhythm) = 'object'));
