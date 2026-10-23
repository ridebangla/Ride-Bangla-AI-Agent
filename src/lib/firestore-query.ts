/**
 * firestore-query.ts — pure (I/O-free) Prisma-`where`/`orderBy`/`select`
 * evaluation engine used by the Firestore data layer (`./firestore`).
 *
 * Kept free of `firebase-admin` imports so it can be unit-tested in
 * isolation. All Firestore Timestamp/Date handling goes through `toMillis`.
 */

/** Loose record type for rows flowing through the engine. */
export type Row = Record<string, unknown>;
export type Where = Record<string, unknown> | undefined | null;

/** Convert Date / Firestore-Timestamp-like / number / ISO string to millis. */
export function toMillis(v: unknown): number | null {
  if (v == null) return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    // Firestore Timestamp shape { seconds, nanoseconds } (also covers the
    // admin SDK class, which exposes toMillis()).
    if (typeof (o as { toMillis?: unknown }).toMillis === "function") {
      return (o as { toMillis: () => number }).toMillis();
    }
    if (typeof o.seconds === "number") {
      return o.seconds * 1000 + Math.floor(Number(o.nanoseconds ?? 0) / 1e6);
    }
  }
  return null;
}

function isDateLike(v: unknown): boolean {
  return v instanceof Date || toMillis(v) !== null;
}

/** Loose equality mirroring Prisma scalar semantics (dates by instant). */
export function valuesEqual(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return a == b;
  const am = toMillis(a);
  const bm = toMillis(b);
  if (am !== null && bm !== null && (a instanceof Date || b instanceof Date || typeof a === "object" || typeof b === "object")) {
    // Only treat as dates when at least one side is genuinely date-like;
    // plain numbers/strings fall through to strict equality below.
    if (a instanceof Date || b instanceof Date) return am === bm;
  }
  if (typeof a === "number" && typeof b === "number") return a === b;
  return a === b;
}

/** Numeric/string/date three-way comparison. Returns null if incomparable. */
export function compareValues(a: unknown, b: unknown): number | null {
  if (a == null || b == null) return null;
  if (a instanceof Date || b instanceof Date) {
    const am = toMillis(a);
    const bm = toMillis(b);
    if (am === null || bm === null) return null;
    return am < bm ? -1 : am > bm ? 1 : 0;
  }
  if (typeof a === "number" && typeof b === "number") {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (typeof a === "string" && typeof b === "string") {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (typeof a === "boolean" && typeof b === "boolean") {
    return a === b ? 0 : a ? 1 : -1;
  }
  return null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

const OPERATOR_KEYS = new Set([
  "equals",
  "not",
  "in",
  "notIn",
  "lt",
  "lte",
  "gt",
  "gte",
  "contains",
  "startsWith",
  "endsWith",
  "mode",
]);

function isOperatorObject(v: unknown): v is Record<string, unknown> {
  if (!isPlainObject(v)) return false;
  return Object.keys(v).some((k) => OPERATOR_KEYS.has(k));
}

function strEquals(a: unknown, b: unknown, insensitive: boolean): boolean {
  if (typeof a !== "string" || typeof b !== "string") return valuesEqual(a, b);
  return insensitive ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function matchCondition(fieldValue: unknown, cond: unknown): boolean {
  if (cond === undefined) return true;
  if (!isOperatorObject(cond)) {
    // Scalar shorthand: { field: value } / { field: null }.
    return valuesEqual(fieldValue, cond);
  }
  const insensitive = (cond as Record<string, unknown>).mode === "insensitive";
  for (const [op, operand] of Object.entries(cond)) {
    if (op === "mode") continue;
    switch (op) {
      case "equals":
        if (!strEquals(fieldValue, operand, insensitive)) return false;
        break;
      case "not": {
        const nv = isOperatorObject(operand)
          ? matchCondition(fieldValue, operand)
          : valuesEqual(fieldValue, operand);
        if (nv) return false;
        break;
      }
      case "in":
        if (!Array.isArray(operand)) return false;
        if (
          !(operand as unknown[]).some((v) =>
            insensitive && typeof fieldValue === "string" && typeof v === "string"
              ? fieldValue.toLowerCase() === v.toLowerCase()
              : valuesEqual(fieldValue, v)
          )
        )
          return false;
        break;
      case "notIn":
        if (!Array.isArray(operand)) return false;
        if (
          (operand as unknown[]).some((v) => valuesEqual(fieldValue, v))
        )
          return false;
        break;
      case "lt":
      case "lte":
      case "gt":
      case "gte": {
        const c = compareValues(fieldValue, operand);
        if (c === null) return false;
        if (op === "lt" && !(c < 0)) return false;
        if (op === "lte" && !(c <= 0)) return false;
        if (op === "gt" && !(c > 0)) return false;
        if (op === "gte" && !(c >= 0)) return false;
        break;
      }
      case "contains":
      case "startsWith":
      case "endsWith": {
        if (typeof fieldValue !== "string" || typeof operand !== "string") return false;
        const hay = insensitive ? fieldValue.toLowerCase() : fieldValue;
        const needle = insensitive ? operand.toLowerCase() : operand;
        if (op === "contains" && !hay.includes(needle)) return false;
        if (op === "startsWith" && !hay.startsWith(needle)) return false;
        if (op === "endsWith" && !hay.endsWith(needle)) return false;
        break;
      }
      default:
        // Unknown operator: fail closed (no match) rather than leaking rows.
        return false;
    }
  }
  return true;
}

/**
 * Scalar `where` matching (AND/OR/NOT + per-field conditions).
 * Relation filters (`some`/`none`/`every`) are NOT handled here — the data
 * layer resolves those separately via `matchRelationFilter`.
 */
export function matchesScalarWhere(row: Row, where: Where): boolean {
  if (!where || Object.keys(where).length === 0) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (key === "AND") {
      const parts = (Array.isArray(cond) ? cond : [cond]) as Where[];
      if (!parts.every((p) => matchesScalarWhere(row, p))) return false;
      continue;
    }
    if (key === "OR") {
      const parts = (Array.isArray(cond) ? cond : [cond]) as Where[];
      if (!parts.some((p) => matchesScalarWhere(row, p))) return false;
      continue;
    }
    if (key === "NOT") {
      const parts = (Array.isArray(cond) ? cond : [cond]) as Where[];
      if (parts.some((p) => matchesScalarWhere(row, p))) return false;
      continue;
    }
    // Skip relation-filter keys here (handled by the data layer).
    if (
      isPlainObject(cond) &&
      ("some" in cond || "none" in cond || "every" in cond)
    ) {
      continue;
    }
    if (!matchCondition(row[key], cond)) return false;
  }
  return true;
}

/** Sort rows by a Prisma `orderBy` object (scalar fields, multi-key). */
export function sortRows(rows: Row[], orderBy: unknown): Row[] {
  if (!orderBy) return rows;
  const specs = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Record<
    string,
    unknown
  >[];
  const scalarSpecs = specs.filter(
    (s) =>
      s &&
      Object.values(s).every((v) => v === "asc" || v === "desc")
  );
  if (scalarSpecs.length === 0) return rows;
  const out = [...rows];
  out.sort((ra, rb) => {
    for (const spec of scalarSpecs) {
      for (const [field, dir] of Object.entries(spec)) {
        const c = compareValues(ra[field], rb[field]);
        // Prisma: NULLs sort first on asc, last on desc (Postgres default).
        if (c === null) {
          const an = ra[field] == null;
          const bn = rb[field] == null;
          if (an && bn) continue;
          const nullFirst = dir === "asc";
          if (an) return nullFirst ? -1 : 1;
          if (bn) return nullFirst ? 1 : -1;
          continue;
        }
        if (c !== 0) return dir === "asc" ? c : -c;
      }
    }
    return 0;
  });
  return out;
}

/** Scalar projection for `select` (relation keys are resolved by the caller). */
export function projectSelect(row: Row, select: Record<string, unknown>): Row {
  const out: Row = {};
  for (const [key, val] of Object.entries(select)) {
    if (key === "_count") continue; // resolved by the data layer
    if (val === true && key in row) {
      out[key] = row[key];
    } else if (val === false) {
      continue;
    }
    // Nested select objects (`{ category: { select: {...} } }`) are resolved
    // by the data layer; scalar-only projection skips them here.
  }
  return out;
}

/** Recursively drop `undefined` values (Prisma treats them as "not set"). */
export function stripUndefined<T>(v: T): T {
  if (Array.isArray(v)) {
    return v.map((x) => stripUndefined(x)) as unknown as T;
  }
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (val === undefined) continue;
      out[k] = stripUndefined(val);
    }
    return out as T;
  }
  return v;
}

/**
 * Apply Prisma numeric field-update operators (`{ increment }`,
 * `{ decrement }`, `{ set }`) to a current value.
 */
export function applyFieldUpdate(current: unknown, update: unknown): unknown {
  if (isPlainObject(update)) {
    if ("increment" in update && typeof update.increment === "number") {
      return (typeof current === "number" ? current : 0) + update.increment;
    }
    if ("decrement" in update && typeof update.decrement === "number") {
      return (typeof current === "number" ? current : 0) - (update.decrement as number);
    }
    if ("set" in update) return update.set;
  }
  return update;
}

/**
 * Extract a top-level equality value for `field` from a (possibly
 * AND-nested) where clause. Used to pick Firestore server-side prefilters.
 */
/**
 * Pick ONE server-side equality prefilter for a where clause
 * (Q-SIGNIN read-burn fix, 2026-10-23).
 *
 * Returns the first field — top-level, then AND-nested — whose condition
 * is a plain scalar equality (string / number / boolean, or an
 * `{ equals: <scalar> }` operator object) with a non-null value, skipping
 * the fields in `exclude` and any relation-filter / range / pattern
 * condition. Returns null when nothing is safely prefilterable.
 *
 * Safety: the caller still applies the FULL where in memory afterwards,
 * so a prefilter can only ever narrow the server result to a superset of
 * the true matches — never change the result set. Null is excluded
 * because Firestore `== null` does not match docs where the field is
 * absent, while the in-memory matcher treats absent as null.
 */
export function pickEqualityPrefilter(
  where: Where,
  exclude: string[]
): { field: string; value: string | number | boolean } | null {
  if (!where) return null;
  for (const key of Object.keys(where)) {
    if (key === "AND" || key === "OR" || key === "NOT") continue;
    if (exclude.includes(key)) continue;
    const v = extractEquality(where, key);
    if (
      (typeof v === "string" && v !== "") ||
      typeof v === "number" ||
      typeof v === "boolean"
    ) {
      return { field: key, value: v };
    }
  }
  const and = where.AND;
  if (and) {
    const parts = (Array.isArray(and) ? and : [and]) as Where[];
    for (const p of parts) {
      const hit = pickEqualityPrefilter(p, exclude);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Fields whose equality values are (near-)unique identifiers — foreign
 * keys, tokens and public keys (Q-QUOTA read-burn fix, 2026-10-23).
 * An equality on one of these is orders of magnitude more selective
 * than the tenant's `businessId`, so when a where carries one it should
 * be the ONE server-side prefilter instead of businessId (the full
 * where, businessId included, is still applied in memory afterwards,
 * so results are identical — only billed reads change). Other
 * enum/boolean fields (isActive, …) are deliberately NOT in this
 * list: they match a large share of every tenant's rows and would make
 * the prefilter WORSE than businessId. (channel / customerKey / status
 * sit at the very END of the list, below every selective field — see
 * the note on those entries.)
 */
export const SELECTIVE_PREFILTER_FIELDS: readonly string[] = [
  "activityToken",
  "siteKey",
  "keyHash",
  "jti",
  "email",
  "slug",
  "uid",
  "conversationId",
  "categoryId",
  "customerId",
  "tagId",
  "departmentId",
  "assignedToId",
  "webhookId",
  "scanId",
  "site",
  // Appended LAST (waste-audit 2026-10-23): an equality prefilter is
  // semantics-preserving — the full where still filters in memory, so
  // results are identical and only billed reads change — and these
  // fields only win when no earlier-listed field is present in the
  // where. They turn reviewAsk-by-customerKey, inbox channel queries
  // and open-ticket (status) queries from whole-business scans into
  // prefiltered reads.
  "channel",
  "customerKey",
  "status",
];

/**
 * Pick the most selective equality prefilter in a where clause: the
 * first SELECTIVE_PREFILTER_FIELDS field (priority order above) that
 * carries a plain scalar equality, top-level or AND-nested. Returns
 * null when the where has no selective equality.
 */
export function pickSelectivePrefilter(
  where: Where
): { field: string; value: string | number | boolean } | null {
  if (!where) return null;
  for (const field of SELECTIVE_PREFILTER_FIELDS) {
    const v = extractEquality(where, field);
    if (
      (typeof v === "string" && v !== "") ||
      typeof v === "number" ||
      typeof v === "boolean"
    ) {
      return { field, value: v };
    }
  }
  return null;
}

/**
 * Flatten a where clause into its equality conditions, or return null
 * when ANY condition is not a plain scalar equality (range / pattern /
 * `in` / OR / NOT / relation filter / null equality / insensitive
 * equals). Used to decide when a query's ENTIRE filter can be pushed
 * server-side (count aggregation, server order+limit): in that case —
 * and only that case — server-side counting/limiting is exactly the
 * in-memory result.
 */
export function flattenEqualityConditions(
  where: Where
): Array<{ field: string; value: string | number | boolean }> | null {
  if (!where) return [];
  const out: Array<{ field: string; value: string | number | boolean }> = [];
  for (const [key, cond] of Object.entries(where)) {
    if (key === "AND") {
      const parts = (Array.isArray(cond) ? cond : [cond]) as Where[];
      for (const p of parts) {
        const sub = flattenEqualityConditions(p);
        if (sub === null) return null;
        out.push(...sub);
      }
      continue;
    }
    if (key === "OR" || key === "NOT") return null;
    if (cond === undefined) continue;
    if (isOperatorObject(cond)) {
      const ops = cond as Record<string, unknown>;
      // Only a bare `{ equals: <scalar> }` (no mode / extra operators).
      if (
        Object.keys(ops).length === 1 &&
        "equals" in ops &&
        ((typeof ops.equals === "string" && ops.equals !== "") ||
          typeof ops.equals === "number" ||
          typeof ops.equals === "boolean")
      ) {
        out.push({
          field: key,
          value: ops.equals as string | number | boolean,
        });
        continue;
      }
      return null;
    }
    if (
      (typeof cond === "string" && cond !== "") ||
      typeof cond === "number" ||
      typeof cond === "boolean"
    ) {
      out.push({ field: key, value: cond });
      continue;
    }
    return null;
  }
  return out;
}

export function extractEquality(where: Where, field: string): unknown {
  if (!where) return undefined;
  if (
    field in where &&
    !isOperatorObject(where[field]) &&
    where[field] !== undefined
  ) {
    return where[field];
  }
  if (field in where && isOperatorObject(where[field])) {
    const cond = where[field] as Record<string, unknown>;
    if ("equals" in cond && Object.keys(cond).length <= 2) {
      return cond.equals;
    }
  }
  const and = where.AND;
  if (and) {
    const parts = (Array.isArray(and) ? and : [and]) as Where[];
    for (const p of parts) {
      const v = extractEquality(p, field);
      if (v !== undefined) return v;
    }
  }
  return undefined;
}
