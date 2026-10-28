/**
 * STORE SEAM — Leg E (owner offer + reply control batch).
 *
 * Real repo path: src/lib/owner-controls/owner-controls-store.ts (NEW).
 * This file contains NO Firestore import and NO real database call:
 * it defines the adapter interfaces the merger wires to the repo's
 * existing Admin SDK access, plus the two write patterns. Keeping the
 * seam adapter-shaped (instead of importing ./firestore directly)
 * is deliberate: this leg stages no diff to firestore.ts, so it
 * cannot collide with Legs B/C/D or the rbac/firestore merge passes.
 *
 * PATTERN 1 — writeMutationWithTrail (REQUIRED for every owner/staff
 * mutation through Legs B/C/D controls): the mutation and its trail
 * entry are written inside ONE transaction. If the trail write
 * throws, the transaction aborts and the mutation FAILS — no entry,
 * no mutation, ever. There is no fallback path that writes the
 * mutation without the trail.
 *
 * PATTERN 2 — appendTrailEntry standalone: ONLY for system entries
 * the platform writes on its own (e.g. a timed pause lapsing into a
 * resume entry). NEVER for an owner/staff mutation — a mutation
 * that appends its trail entry in a separate call can land the
 * mutation and lose the entry, which this doctrine forbids.
 *
 * FIRESTORE LIMITS, stated honestly (merger must confirm against
 * the repo's Admin SDK usage at apply time):
 *  - A transaction / write batch caps at 500 document writes. This
 *    pattern uses 1 (mutation) + 1 (trail) writes in the common case,
 *    so it fits — but a mutation touching many documents must still
 *    fit in one transaction WITH its trail entry. If it cannot fit,
 *    the mutation must FAIL, not split into a trailless write.
 *  - Transactions retry on contention; the mutate() callback must
 *    therefore be idempotent (no side effects outside the tx).
 *  - Admin SDK calls bypass firestore.rules, so rules alone do NOT
 *    enforce append-only for server code. Append-only holds for the
 *    server path because this seam exports no update/delete for
 *    trail entries at all — there is simply no function to call.
 *    The rules proposal (rules/) denies direct-client writes, which
 *    covers the client path.
 *
 * READS are tenant-scoped and role-gated in this seam, before any
 * document is returned: cross-tenant reads are refused with an error
 * (never an empty list), and roles outside TRAIL_READ_ROLES are
 * refused. A null-business caller (e.g. Super Admin without a
 * business context) is refused, matching every other tenant route.
 */

import {
  OWNER_CONTROL_BLOCK_LOG_COLLECTION,
  OWNER_CONTROL_TRAIL_COLLECTION,
  buildTrailEntry,
  canReadTrail,
  validateTrailEntryForTenant,
  type BuildTrailEntryInput,
  type OwnerControlTrailEntry,
} from "./audit-trail";
import type {
  SendGateBlockLogEntry,
  SendGateBlockLogSink,
} from "./send-gate";

// Re-exported so callers import the seam only.
export {
  OWNER_CONTROL_BLOCK_LOG_COLLECTION,
  OWNER_CONTROL_TRAIL_COLLECTION,
};

/** Minimal transaction handle: set = buffered write, get = read. */
export interface TrailTransaction {
  set(
    collection: string,
    docId: string,
    data: Record<string, unknown>,
  ): void;
  get(
    collection: string,
    docId: string,
  ): Promise<Record<string, unknown> | null>;
}

/** Minimal store adapter, wired by the merger to the Admin SDK. */
export interface OwnerControlsStoreAdapter {
  runTransaction<T>(fn: (tx: TrailTransaction) => Promise<T>): Promise<T>;
  /** Direct (non-transactional) single-document write. */
  setDoc(
    collection: string,
    docId: string,
    data: Record<string, unknown>,
  ): Promise<void>;
  /** Tenant-scoped list, newest first, capped by the caller. */
  listDocs(
    collection: string,
    filters: { businessId: string },
    limit: number,
  ): Promise<Array<Record<string, unknown> & { id: string }>>;
}

export interface MutationWithTrailInput {
  /** Tenant that owns both the record and the trail entry. */
  businessId: string;
  /** Mutation description for the trail entry (actor/action/target). */
  trail: Omit<BuildTrailEntryInput, "businessId" | "before" | "after"> & {
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
  };
  /**
   * The mutation itself, expressed as transaction writes. Receives
   * the transaction handle AND the trail entry id so the mutation
   * may reference it if needed. Must be side-effect-free outside tx.
   * @param trailEntryId id the trail entry will be stored under.
   */
  mutate: (tx: TrailTransaction, trailEntryId: string) => Promise<void>;
  /** Server-generated trail entry id (opaque; never client input). */
  trailEntryId: string;
}

/**
 * Runs mutate() + the trail write in ONE transaction. Any throw —
 * from the mutation or from the trail build/write — aborts both.
 * Returns the stored trail entry on success.
 */
export async function writeMutationWithTrail(
  store: OwnerControlsStoreAdapter,
  input: MutationWithTrailInput,
): Promise<OwnerControlTrailEntry> {
  // Build FIRST, outside the transaction: an invalid entry fails
  // before any mutation write is even attempted.
  const entry = buildTrailEntry({
    ...input.trail,
    businessId: input.businessId,
  });
  await store.runTransaction(async (tx) => {
    await input.mutate(tx, entry.id);
    tx.set(OWNER_CONTROL_TRAIL_COLLECTION, entry.id, {
      ...entry,
    } as unknown as Record<string, unknown>);
  });
  return entry;
}

export interface AppendSystemTrailEntryInput {
  businessId: string;
  trail: Omit<BuildTrailEntryInput, "businessId" | "before" | "after"> & {
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
  };
  trailEntryId: string;
}

/**
 * Standalone append — SYSTEM entries only (see header). Owner/staff
 * mutations must use writeMutationWithTrail instead.
 */
export async function appendSystemTrailEntry(
  store: OwnerControlsStoreAdapter,
  input: AppendSystemTrailEntryInput,
): Promise<OwnerControlTrailEntry> {
  const entry = buildTrailEntry({
    ...input.trail,
    businessId: input.businessId,
  });
  await store.setDoc(OWNER_CONTROL_TRAIL_COLLECTION, entry.id, {
    ...entry,
  } as unknown as Record<string, unknown>);
  return entry;
}

export interface ReadTrailInput {
  /** Tenant making the request (from auth, never from the query). */
  businessId: string | null;
  role: string;
  limit?: number;
}

/**
 * Tenant-scoped, role-gated trail read. Throws on null business,
 * on a disallowed role, or on any cross-tenant entry found in the
 * result set (defence in depth — the query itself is tenant-filtered).
 */
export async function readTrailEntries(
  store: OwnerControlsStoreAdapter,
  input: ReadTrailInput,
): Promise<OwnerControlTrailEntry[]> {
  if (input.businessId === null || input.businessId.trim().length === 0) {
    throw new Error("owner_control_trail_read_refused: missing_business");
  }
  if (!canReadTrail(input.role)) {
    throw new Error("owner_control_trail_read_refused: role_not_allowed");
  }
  const limit = input.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("owner_control_trail_read_refused: limit_invalid");
  }
  const docs = await store.listDocs(
    OWNER_CONTROL_TRAIL_COLLECTION,
    { businessId: input.businessId },
    limit,
  );
  const entries: OwnerControlTrailEntry[] = [];
  for (const doc of docs) {
    const entry = doc as unknown as OwnerControlTrailEntry;
    const problem = validateTrailEntryForTenant(entry, input.businessId);
    if (problem !== null) {
      throw new Error(`owner_control_trail_read_refused: ${problem}`);
    }
    entries.push(entry);
  }
  return entries;
}

/**
 * Block-log sink for canSendOffer (send-gate.ts). Best-effort by
 * design: the block stands whether this write succeeds or not.
 */
export function makeBlockLogSink(
  store: OwnerControlsStoreAdapter,
): SendGateBlockLogSink {
  return {
    async write(entry: SendGateBlockLogEntry): Promise<void> {
      await store.setDoc(
        OWNER_CONTROL_BLOCK_LOG_COLLECTION,
        `${entry.businessId}_${entry.sendType}_${entry.blockedAtMs}`,
        { ...entry } as unknown as Record<string, unknown>,
      );
    },
  };
}
