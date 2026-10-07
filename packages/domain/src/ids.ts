import { z } from 'zod';

// 场景内实体使用作者可读的键，在一个场景内唯一；持久记录（运行、事件）才使用 ULID。
const key = z.string().regex(/^[\p{L}\p{N}_-]+$/u, '键只能包含字母、数字、下划线与连字符');

export const ActorId = key.brand<'ActorId'>();
export type ActorId = z.infer<typeof ActorId>;

export const ZoneId = key.brand<'ZoneId'>();
export type ZoneId = z.infer<typeof ZoneId>;

export const ItemId = key.brand<'ItemId'>();
export type ItemId = z.infer<typeof ItemId>;

export const MechanismId = key.brand<'MechanismId'>();
export type MechanismId = z.infer<typeof MechanismId>;

export const FlagKey = key.brand<'FlagKey'>();
export type FlagKey = z.infer<typeof FlagKey>;

export const CounterKey = key.brand<'CounterKey'>();
export type CounterKey = z.infer<typeof CounterKey>;

export const SecretId = key.brand<'SecretId'>();
export type SecretId = z.infer<typeof SecretId>;

// 以下标识由领域内核按事件内容生成，不出现在场景配置中。
export const KnowledgeId = z.string().min(1).brand<'KnowledgeId'>();
export type KnowledgeId = z.infer<typeof KnowledgeId>;

export const ClaimId = z.string().min(1).brand<'ClaimId'>();
export type ClaimId = z.infer<typeof ClaimId>;
