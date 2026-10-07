import { err, ok, type Result } from '@novel-writer/shared';
import { SceneSpec } from './schema';

declare const validated: unique symbol;

/** 经过结构与引用完整性校验的推演场景。只能由 parseScene 得到。 */
export type Scene = SceneSpec & { readonly [validated]: true };

export type SceneError = {
  readonly code:
    | 'schema'
    | 'duplicate_id'
    | 'unknown_ref'
    | 'self_loop'
    | 'duplicate_edge'
    /** 二阶认知必须指向另一个角色，一阶认知不能指定 concerning。 */
    | 'invalid_order';
  readonly path: readonly (string | number)[];
  readonly ref?: string;
};

export function parseScene(input: unknown): Result<Scene, readonly SceneError[]> {
  const parsed = SceneSpec.safeParse(input);
  if (!parsed.success) {
    return err(
      parsed.error.issues.map((issue) => ({
        code: 'schema',
        path: issue.path.filter((p): p is string | number => typeof p !== 'symbol'),
      })),
    );
  }
  const errors = checkReferences(parsed.data);
  return errors.length > 0 ? err(errors) : ok(parsed.data as Scene);
}

function checkReferences(spec: SceneSpec): SceneError[] {
  const errors: SceneError[] = [];
  const unknown = (path: SceneError['path'], ref: string) => errors.push({ code: 'unknown_ref', path, ref });

  const ids = (section: 'zones' | 'actors' | 'items' | 'mechanisms' | 'secrets', list: readonly { id: string }[]) => {
    const seen = new Set<string>();
    list.forEach(({ id }, i) => {
      if (seen.has(id)) errors.push({ code: 'duplicate_id', path: [section, i, 'id'], ref: id });
      seen.add(id);
    });
    return seen;
  };
  const zones = ids('zones', spec.zones);
  const actors = ids('actors', spec.actors);
  const items = ids('items', spec.items);
  const mechanisms = ids('mechanisms', spec.mechanisms);
  ids('secrets', spec.secrets);
  const flags = new Set(Object.keys(spec.flags));
  const anyId = new Set([...zones, ...actors, ...items, ...mechanisms]);

  const edgeKeys = new Set<string>();
  spec.edges.forEach((edge, i) => {
    const [a, b] = edge.between;
    if (!zones.has(a)) unknown(['edges', i, 'between', 0], a);
    if (!zones.has(b)) unknown(['edges', i, 'between', 1], b);
    if (edge.requiresFlag !== undefined && !flags.has(edge.requiresFlag)) {
      unknown(['edges', i, 'requiresFlag'], edge.requiresFlag);
    }
    if (a === b) {
      errors.push({ code: 'self_loop', path: ['edges', i], ref: a });
      return;
    }
    const key = [a, b].sort().join('|');
    if (edgeKeys.has(key)) errors.push({ code: 'duplicate_edge', path: ['edges', i], ref: key });
    edgeKeys.add(key);
  });

  spec.actors.forEach((a, i) => {
    if (!zones.has(a.zone)) unknown(['actors', i, 'zone'], a.zone);
    a.card.initialKnowledge.forEach((k, j) => {
      const path = ['actors', i, 'card', 'initialKnowledge', j] as const;
      k.about.forEach((ref, n) => {
        if (!anyId.has(ref)) unknown([...path, 'about', n], ref);
      });
      if (k.concerning !== undefined && !actors.has(k.concerning)) {
        unknown([...path, 'concerning'], k.concerning);
      } else if (k.order === 2 ? k.concerning === undefined || k.concerning === a.id : k.concerning !== undefined) {
        errors.push({ code: 'invalid_order', path });
      }
    });
  });

  spec.secrets.forEach((s, i) => {
    s.subjects.forEach((ref, j) => {
      if (!anyId.has(ref)) unknown(['secrets', i, 'subjects', j], ref);
    });
    s.knownBy.forEach((a, j) => {
      if (!actors.has(a)) unknown(['secrets', i, 'knownBy', j], a);
    });
  });

  spec.items.forEach((item, i) => {
    const loc = item.location;
    if (loc.kind === 'actor' && !actors.has(loc.actor)) unknown(['items', i, 'location', 'actor'], loc.actor);
    if (loc.kind === 'zone' && !zones.has(loc.zone)) unknown(['items', i, 'location', 'zone'], loc.zone);
  });

  spec.mechanisms.forEach((m, i) => {
    if (!zones.has(m.zone)) unknown(['mechanisms', i, 'zone'], m.zone);
    m.exempt.forEach((a, j) => {
      if (!actors.has(a)) unknown(['mechanisms', i, 'exempt', j], a);
    });
  });

  spec.exits.forEach((z, i) => {
    if (!zones.has(z)) unknown(['exits', i], z);
  });

  spec.rules.consumption.forEach((rule, i) => {
    const item = spec.items.find((it) => it.id === rule.item);
    if (item === undefined) unknown(['rules', 'consumption', i, 'item'], rule.item);
    else if (!(rule.counter in item.counters)) unknown(['rules', 'consumption', i, 'counter'], rule.counter);
  });

  spec.rules.injuryLimits.forEach((limit, i) => {
    if (limit.actor !== undefined && !actors.has(limit.actor)) unknown(['rules', 'injuryLimits', i, 'actor'], limit.actor);
    limit.forbidItems.forEach((it, j) => {
      if (!items.has(it)) unknown(['rules', 'injuryLimits', i, 'forbidItems', j], it);
    });
  });

  spec.rules.requirements.forEach((req, i) => {
    if (!anyId.has(req.target)) unknown(['rules', 'requirements', i, 'target'], req.target);
    if (!items.has(req.requiresHolding)) unknown(['rules', 'requirements', i, 'requiresHolding'], req.requiresHolding);
    if (req.onSuccess !== undefined && !flags.has(req.onSuccess.setFlag)) {
      unknown(['rules', 'requirements', i, 'onSuccess', 'setFlag'], req.onSuccess.setFlag);
    }
  });

  return errors;
}
