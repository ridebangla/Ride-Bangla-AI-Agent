/**
 * SETTINGS-DOC OWNER-CONTROL ADAPTER — staged wiring (replaces the
 * routes' throwing getAdapter()).
 *
 * Real repo path (NEW file):
 *   src/lib/owner-controls/settings-owner-control-adapter.ts
 *
 * HEAD anchor (re-checked 2026-10-28 via the GitHub connector, not
 * trusted blindly): ridebangla/Ride-Bangla-AI-Agent HEAD is still
 * 706df0fdf26f58fffc3630626497124768327c53 ("Re-audit #3 fixes:
 * honest signup 503 + courier gating doctrine (R3-ai-1, R3-ai-2)").
 *
 * STORAGE — no new collection, no new model, no rules fragment
 * needed for storage (see below):
 * - HEAD's existing per-business settings document: Firestore
 *   collection "settings" (src/lib/firestore.ts MODEL_META.settings,
 *   unique businessId, one doc per business), reached through the
 *   repo's own Prisma-compatible client (`prisma.settings`) exactly
 *   as src/app/api/settings/route.ts already reads/writes it.
 * - Owner-controls state lives in ONE namespaced field on that doc,
 *   `ownerControls: { channelControls, commentMode, audit }`. It is
 *   the only field this adapter ever writes, so every other settings
 *   field — including secrets such as aiKeys / smtpPass, which the
 *   settings route masks on read — is never touched by this adapter.
 * - The adapter deliberately does NOT go through the generic
 *   settings PUT validation (src/lib/validations.ts
 *   updateSettingsSchema, .strict()): that schema does not list
 *   ownerControls, and adding it there would expose owner-controls
 *   state to generic settings writes. This adapter writes via
 *   prisma.settings.upsert directly, the same client the settings
 *   route uses.
 *
 * TENANCY — fail-closed, same as the settings route:
 * - Every call is wrapped in runWithBusiness(businessId, ...) (the
 *   route-auth helper does NOT propagate tenant context across the
 *   await boundary, so the adapter establishes it itself).
 * - The scoped client stamps the ambient businessId on create and
 *   guards update by a scoped findFirst first, so a write can never
 *   land in another business's doc. getDoc additionally refuses a
 *   row whose businessId differs from the requested one.
 * - Permissions are unchanged: the routes still require HEAD's
 *   settings:read (GET) / settings:update (POST), admin role only.
 *   No new permission is invented here.
 *
 * ATOMICITY — stated precisely, not overstated:
 * - putDoc is ONE settings upsert. Under the hood the Firestore
 *   shim's update path runs a transaction that sets the merged doc
 *   (src/lib/firestore.ts updateRaw), so channelControls +
 *   commentMode + audit land together or not at all: a trail-write
 *   failure fails the whole control change, never a trailless
 *   change. The nested ownerControls object is replaced wholesale
 *   (applyFieldUpdate returns a plain-object update as-is), and
 *   all other top-level settings fields are carried over untouched.
 * - What this does NOT provide: the staged store's read-modify-write
 *   cycle (getDoc, then putDoc) is not a cross-call transaction, so
 *   two concurrent channel writes could interleave and the later
 *   write could drop the earlier one's channel change
 *   (last-write-wins on the doc). Dashboard writes are human-paced
 *   and single-owner, so the practical risk is low, but it is real:
 *   a truly transactional write needs a transaction hook in the
 *   store interface, which is a merger decision, not something this
 *   adapter can fake through getDoc/putDoc. Do not claim otherwise.
 *
 * DEFAULTS + CORRUPTION — settled model, applied to stored data:
 * - ABSENT field (the normal case for every existing tenant, whose
 *   settings doc predates this feature) = the settled missing-record
 *   defaults: channelControls {}, commentMode "auto" (the staged
 *   emptyDoc default), audit []. Absent therefore never silences
 *   an existing tenant's AI — deploying this adapter changes no
 *   existing tenant's behaviour until its owner flips a control.
 * - PRESENT-BUT-INVALID field = throw. The routes map a throw to
 *   503, and a send-path caller must treat a throw as "block the AI
 *   send" (fail-closed). Silently defaulting corrupt data would
 *   misrepresent the owner's intent — e.g. a damaged owner-held
 *   entry reading back as AI would re-enable AI on a channel the
 *   owner holds. These fields are written only by this adapter's
 *   validated writer, so invalid stored shape means tampering or a
 *   bad migration, and refusing to guess is the safe behaviour.
 * - Nullable metadata (changedBy / reason) may be absent on read
 *   and is normalised to null; identity/mode/timestamp fields have
 *   no safe default and are strict.
 *
 * AUDIT CAP: latest 200 entries, the single cap named in the prior
 * staged snippets (Leg C's trail cap). The merger confirms it at
 * apply time; it is a retention choice, not an owner policy pick.
 * The cap is applied on WRITE (putDoc slices to the last 200), so
 * reads never silently truncate history.
 *
 * RULES: the server uses the Firebase Admin SDK, which bypasses
 * Firestore rules, and the field lives inside the existing
 * `settings` collection already covered by HEAD's firestore.rules
 * (match /settings/{docId}, tenantRead/tenantUpdate). No new
 * collection means no new rules fragment is required for this
 * storage. Whether the final rules package wants field-level
 * constraints on ownerControls is a rules-team decision, not a
 * blocker for this adapter.
 *
 * FAIL-CLOSED SEMANTICS PRESERVED (settled 2026-10-28 model):
 * per-channel independent control (one channel's write carries the
 * rest untouched, via the staged store's spread), one unified
 * dashboard (this adapter serves every channel identically —
 * Facebook / Instagram / Messenger / WhatsApp / any channel string),
 * AI silent on an owner-held channel while the owner talks, AI
 * resumes on hand-back (the store's transitions, unchanged), and
 * offer sends still blocked when the offer control is
 * missing/paused/disabled/unconfigured (channel-send-gate, unchanged
 * — this adapter stores channel + comment state only and never
 * supplies offer content).
 */

import { prisma, runWithBusiness } from "@/lib/prisma";
import {
  type OwnerControlDoc,
  type OwnerControlDocAdapter,
} from "./channel-control-store";
import type {
  ChannelControlMap,
  ChannelControlState,
  ChannelControlAuditEntry,
  ChannelMode,
} from "./channel-controls";
import {
  type CommentMode,
  type CommentModeAuditEntry,
  isCommentMode,
} from "./comment-controls";

/** The single namespaced field on the HEAD settings document. */
export const OWNER_CONTROLS_FIELD = "ownerControls";

/** Retention cap for the owner-control audit trail (see header). */
export const OWNER_CONTROL_AUDIT_CAP = 200;

/** The stored shape of the ownerControls field (plain JSON only). */
interface StoredOwnerControls {
  channelControls: ChannelControlMap;
  commentMode: CommentMode;
  audit: Array<ChannelControlAuditEntry | CommentModeAuditEntry>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function corrupt(message: string): Error {
  return new Error(`owner-controls stored doc corrupt: ${message}`);
}

function asChannelMode(value: unknown): ChannelMode | null {
  return value === "ai" || value === "owner" ? value : null;
}

function asFiniteMs(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Nullable metadata: absent normalises to null; other types throw. */
function asNullableString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  throw corrupt(`${field} must be a string or null`);
}

function parseChannelControls(
  raw: unknown,
  businessId: string
): ChannelControlMap {
  if (raw === undefined) return {};
  if (!isRecord(raw)) throw corrupt("channelControls must be an object");
  const out: ChannelControlMap = {};
  for (const [channel, entry] of Object.entries(raw)) {
    if (channel === "") throw corrupt("channelControls has an empty channel key");
    if (!isRecord(entry)) throw corrupt(`channelControls.${channel} must be an object`);
    const mode = asChannelMode(entry.mode);
    if (!mode) throw corrupt(`channelControls.${channel}.mode must be ai or owner`);
    const changedAtMs = asFiniteMs(entry.changedAtMs);
    if (changedAtMs === null) {
      throw corrupt(`channelControls.${channel}.changedAtMs must be a finite number`);
    }
    if (entry.businessId !== undefined && entry.businessId !== businessId) {
      throw corrupt(`channelControls.${channel}.businessId belongs to another business`);
    }
    if (entry.channel !== undefined && entry.channel !== channel) {
      throw corrupt(`channelControls.${channel}.channel does not match its map key`);
    }
    const state: ChannelControlState = {
      businessId,
      channel,
      mode,
      changedAtMs,
      changedBy: asNullableString(entry.changedBy, `channelControls.${channel}.changedBy`),
      reason: asNullableString(entry.reason, `channelControls.${channel}.reason`),
    };
    out[channel] = state;
  }
  return out;
}

function parseCommentMode(raw: unknown): CommentMode {
  if (raw === undefined) return "auto";
  if (isCommentMode(raw)) return raw;
  throw corrupt("commentMode must be auto, approval, or owner");
}

function parseAudit(
  raw: unknown,
  businessId: string
): Array<ChannelControlAuditEntry | CommentModeAuditEntry> {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw corrupt("audit must be an array");
  const out: Array<ChannelControlAuditEntry | CommentModeAuditEntry> = [];
  for (const entry of raw) {
    if (!isRecord(entry)) throw corrupt("audit entries must be objects");
    if (entry.businessId !== businessId) {
      throw corrupt("audit entry belongs to another business");
    }
    const changedAtMs = asFiniteMs(entry.changedAtMs);
    if (changedAtMs === null) throw corrupt("audit entry changedAtMs must be a finite number");
    const changedBy = asNullableString(entry.changedBy, "audit entry changedBy");
    if (entry.action === "channel_takeover" || entry.action === "channel_handback") {
      if (typeof entry.channel !== "string" || entry.channel === "") {
        throw corrupt("channel audit entry must name a channel");
      }
      const beforeMode = asChannelMode(entry.beforeMode);
      const afterMode = asChannelMode(entry.afterMode);
      if (!beforeMode || !afterMode) {
        throw corrupt("channel audit entry modes must be ai or owner");
      }
      out.push({
        businessId,
        channel: entry.channel,
        action: entry.action,
        beforeMode,
        afterMode,
        changedAtMs,
        changedBy,
        reason: asNullableString(entry.reason, "channel audit entry reason"),
      } satisfies ChannelControlAuditEntry);
    } else if (entry.action === "comment_mode_change") {
      if (!isCommentMode(entry.beforeMode) || !isCommentMode(entry.afterMode)) {
        throw corrupt("comment audit entry modes must be auto, approval, or owner");
      }
      out.push({
        businessId,
        action: "comment_mode_change",
        beforeMode: entry.beforeMode,
        afterMode: entry.afterMode,
        changedAtMs,
        changedBy,
      } satisfies CommentModeAuditEntry);
    } else {
      throw corrupt("audit entry has an unknown action");
    }
  }
  return out;
}

/** Validate + normalise a stored (or to-be-stored) ownerControls value. */
function parseStoredOwnerControls(
  raw: unknown,
  businessId: string
): StoredOwnerControls {
  if (!isRecord(raw)) throw corrupt("ownerControls must be an object");
  return {
    channelControls: parseChannelControls(raw.channelControls, businessId),
    commentMode: parseCommentMode(raw.commentMode),
    audit: parseAudit(raw.audit, businessId),
  };
}

/**
 * Settings-doc adapter for owner controls. Stateless and safe to
 * share as a singleton: every method establishes its own tenant
 * context from its businessId argument.
 */
export class SettingsOwnerControlAdapter implements OwnerControlDocAdapter {
  async getDoc(businessId: string): Promise<OwnerControlDoc | null> {
    if (typeof businessId !== "string" || businessId.trim() === "") {
      throw new Error("owner-controls adapter: businessId is required");
    }
    return runWithBusiness(businessId, async () => {
      const settings = await prisma.settings.findUnique({
        where: { businessId },
      });
      // No settings doc yet: the routes fall back to emptyDoc, and
      // this read creates nothing (reads must not create a business
      // settings doc as a side effect).
      if (!settings) return null;
      if (settings.businessId !== businessId) {
        throw new Error("owner-controls adapter: settings doc belongs to another business");
      }
      const raw = (settings as unknown as Record<string, unknown>)[OWNER_CONTROLS_FIELD];
      // Existing tenant whose settings doc predates this feature:
      // settled missing-record defaults (AI keeps working).
      if (raw === undefined || raw === null) {
        return {
          businessId,
          channelControls: {},
          commentMode: "auto",
          audit: [],
        } satisfies OwnerControlDoc;
      }
      return { businessId, ...parseStoredOwnerControls(raw, businessId) };
    });
  }

  async putDoc(doc: OwnerControlDoc): Promise<void> {
    if (typeof doc.businessId !== "string" || doc.businessId.trim() === "") {
      throw new Error("owner-controls adapter: businessId is required");
    }
    // Validate + normalise first: nothing is written when the doc is
    // invalid, and the audit trail is capped here, on write.
    const parsed = parseStoredOwnerControls(
      {
        channelControls: doc.channelControls,
        commentMode: doc.commentMode,
        audit: doc.audit,
      },
      doc.businessId
    );
    const stored: StoredOwnerControls = {
      ...parsed,
      audit: parsed.audit.slice(-OWNER_CONTROL_AUDIT_CAP),
    };
    await runWithBusiness(doc.businessId, async () => {
      // Upsert on the EXISTING settings doc: the update branch merges
      // only the ownerControls field into the doc (all other settings
      // fields, including secrets, are carried over untouched); the
      // create branch fills HEAD's settings defaults for a business
      // with no settings doc yet, exactly like the settings route's
      // first-run create. The scoped client stamps/guards businessId.
      await prisma.settings.upsert({
        where: { businessId: doc.businessId },
        update: { [OWNER_CONTROLS_FIELD]: stored },
        create: { businessId: doc.businessId, [OWNER_CONTROLS_FIELD]: stored },
      });
    });
  }
}

let cached: OwnerControlDocAdapter | null = null;

/** The adapter the wired owner-controls routes return from getAdapter(). */
export function getSettingsOwnerControlAdapter(): OwnerControlDocAdapter {
  if (!cached) cached = new SettingsOwnerControlAdapter();
  return cached;
}
