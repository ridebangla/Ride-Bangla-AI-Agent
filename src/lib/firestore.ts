/**
 * firestore.ts — Firestore data-access layer (Firebase Admin SDK).
 *
 * This module replaces the Prisma/Postgres data layer. It exposes the SAME
 * interface the rest of the app was built against (`prisma.<model>.<op>()`
 * with Prisma-style `where`/`include`/`select`/`orderBy`/`take`/`skip`,
 * plus `withBusinessId`, `TenantContextError`, `runWithBusiness`,
 * `enterBusinessContext`, `getBusinessId`, `getUnscopedPrisma`), so every
 * existing route, lib module, and test keeps working unchanged.
 *
 * Multi-tenancy is fail-closed exactly as before: every tenant-model query
 * is auto-scoped to the ambient business (AsyncLocalStorage); access with
 * no context throws `TenantContextError`; the Super Admin (businessId null)
 * is unscoped.
 *
 * Firestore mapping notes (see OPERATIONS.md §"Data layer"):
 * - One Firestore collection per model; the Prisma UUID `id` is the
 *   Firestore document ID (so findUnique-by-id is a direct document get).
 * - `DateTime` fields are stored as Firestore Timestamps and decoded back
 *   to `Date` on read.
 * - Filtering/sorting beyond a `businessId` (or `id`) server-side prefilter
 *   is evaluated in memory — Firestore has no case-insensitive `contains`
 *   and composite indexes are not assumed.
 */

import * as admin from "firebase-admin";
import { randomUUID } from "crypto";
import { AsyncLocalStorage } from "async_hooks";
import {
  Row,
  Where,
  toMillis,
  valuesEqual,
  compareValues,
  matchesScalarWhere,
  sortRows,
  projectSelect,
  stripUndefined,
  applyFieldUpdate,
  extractEquality,
} from "./firestore-query";
import type {
  Business,
  Settings,
  Admin,
  RevokedToken,
  Category,
  KnowledgeEntry,
  Department,
  TeamMember,
  Conversation,
  Message,
  Ticket,
  Tag,
  ConversationTag,
  CallLog,
  Channel,
  Schedule,
  Webhook,
  WebhookDelivery,
  ActivityLog,
  SLARule,
  CannedResponse,
  Customer,
  CustomerNote,
  AutomationRule,
  BusinessHours,
  ApiKey,
  InternalNote,
  Campaign,
  Flow,
  FollowUp,
  SocialAccount,
  ScheduledPost,
  SocialInteraction,
  AudienceProfile,
  AgentCommand,
  ProductCategory,
  Product,
  Order,
  LeadScan,
  Lead,
  LeadDraft,
  LeadSettings,
} from "./models";

// ---------------------------------------------------------------------------
// Firebase Admin initialization (lazy — importing this module never connects)
// ---------------------------------------------------------------------------

let adminDb: admin.firestore.Firestore | null = null;

function getDb(): admin.firestore.Firestore {
  if (adminDb) return adminDb;
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY;
  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      "Firestore is not configured: set FIREBASE_PROJECT_ID, " +
        "FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY (see OPERATIONS.md §1)."
    );
  }
  // Service-account private keys are usually stored with escaped newlines.
  privateKey = privateKey.replace(/\\n/g, "\n");
  const app =
    admin.apps.length > 0
      ? admin.apps[0]!
      : admin.initializeApp({
          credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
          projectId,
        });
  adminDb = admin.firestore(app);
  return adminDb;
}

/**
 * Raw Firebase Admin SDK Firestore for PLATFORM-level (non-tenant)
 * collections (e.g. `support_tickets`, `site_contacts`, `payment_claims`).
 * Bypasses all Firestore rules — the caller is responsible for authorization
 * (public endpoints validate everything themselves; service layer only).
 */
export function getAdminDb(): admin.firestore.Firestore {
  return getDb();
}

/** Close the Admin SDK (scripts/tests). */
export async function closeDb(): Promise<void> {
  if (admin.apps.length > 0) {
    await Promise.all(admin.apps.map((a) => a?.delete()));
  }
  adminDb = null;
}

// ---------------------------------------------------------------------------
// Model metadata
// ---------------------------------------------------------------------------

interface ModelMeta {
  collection: string;
  /** false for Business and RevokedToken (no businessId column). */
  tenantScoped: boolean;
  /** Prisma @default() values applied on create when the key is absent. */
  defaults: Row;
  /** Whether the model has an @updatedAt field (refreshed on update). */
  hasUpdatedAt: boolean;
  /** Unique fields for P2002-style conflict errors: string = single field,
   *  string[] = compound. */
  uniques: (string | string[])[];
  /** Compound-unique where keys (e.g. businessId_type) -> field list. */
  compoundKeys: Record<string, string[]>;
}

const M = (
  collection: string,
  opts: Partial<ModelMeta> & { defaults?: Row } = {}
): ModelMeta => ({
  collection,
  tenantScoped: true,
  defaults: {},
  hasUpdatedAt: false,
  uniques: [],
  compoundKeys: {},
  ...opts,
});

const MODEL_META: Record<string, ModelMeta> = {
  business: M("businesses", {
    tenantScoped: false,
    hasUpdatedAt: true,
    defaults: { isActive: true },
    uniques: ["slug", "siteKey"],
  }),
  settings: M("settings", {
    hasUpdatedAt: true,
    defaults: {
      id: "default",
      businessName: "My Business",
      businessDesc: "",
      welcomeMessage: "Hello! How can I help you today?",
      tone: "friendly",
      language: "auto",
      // Per-business AI behavior instructions, injected into the system
      // prompt as "Business Behavior Instructions" ("" = none).
      agentBehavior: "",
      aiProvider: "openai",
      aiModel: "gpt-4o-mini",
      aiApiKey: "",
      maxTokens: 2048,
      temperature: 0.7,
      elevenLabsKey: "",
      elevenLabsVoice: "",
      twilioSid: "",
      twilioToken: "",
      twilioPhone: "",
      smtpHost: "",
      smtpPort: 587,
      smtpUser: "",
      smtpPass: "",
      smtpFrom: "",
      imapHost: "",
      imapPort: 993,
      imapUser: "",
      imapPass: "",
      whatsappMode: "web",
      whatsappApiKey: "",
      whatsappPhone: "",
      telegramBotToken: "",
      telegramWebhookSecret: "",
    },
    uniques: ["businessId"],
  }),
  admin: M("admins", {
    hasUpdatedAt: true,
    defaults: { name: "Admin", role: "admin", failedLoginAttempts: 0 },
    uniques: ["username"],
  }),
  revokedToken: M("revokedTokens", { tenantScoped: false }),
  category: M("categories", {
    hasUpdatedAt: true,
    defaults: { description: "", icon: "folder", color: "#4A7C9B", sortOrder: 0 },
  }),
  knowledgeEntry: M("knowledgeEntries", {
    hasUpdatedAt: true,
    defaults: { priority: 0, isActive: true, version: 1, metadata: {} },
  }),
  department: M("departments", {
    hasUpdatedAt: true,
    defaults: { description: "", email: "" },
  }),
  teamMember: M("teamMembers", {
    hasUpdatedAt: true,
    defaults: { phone: "", role: "member", expertise: "", isAvailable: true },
  }),
  conversation: M("conversations", {
    hasUpdatedAt: true,
    defaults: {
      customerName: "Unknown",
      customerContact: "",
      status: "active",
      summary: "",
      metadata: {},
      // Phase 3 (user decision 17): AI replies ON by default; the Phase 5
      // dashboard switch flips this to false for human takeover.
      aiEnabled: true,
    },
  }),
  message: M("messages"),
  ticket: M("tickets", {
    hasUpdatedAt: true,
    defaults: { status: "open", priority: "medium", resolution: "" },
  }),
  tag: M("tags", {
    defaults: { color: "#4A7C9B" },
    uniques: [["businessId", "name"]],
    compoundKeys: { businessId_name: ["businessId", "name"] },
  }),
  conversationTag: M("conversationTags", {
    uniques: [["conversationId", "tagId"]],
    compoundKeys: { conversationId_tagId: ["conversationId", "tagId"] },
  }),
  callLog: M("callLogs", {
    hasUpdatedAt: true,
    defaults: { duration: 0, status: "initiated" },
    uniques: ["callSid"],
  }),
  channel: M("channels", {
    hasUpdatedAt: true,
    defaults: { isActive: false, config: {}, status: "disconnected" },
    uniques: [["businessId", "type"]],
    compoundKeys: { businessId_type: ["businessId", "type"] },
  }),
  schedule: M("schedules"),
  webhook: M("webhooks", {
    hasUpdatedAt: true,
    defaults: { description: "", method: "POST", headers: {}, isActive: true },
  }),
  webhookDelivery: M("webhookDeliveries", {
    hasUpdatedAt: true,
    defaults: { status: "pending", attempts: 0 },
  }),
  activityLog: M("activityLogs", {
    defaults: { userName: "System", metadata: {} },
  }),
  sLARule: M("slaRules", {
    hasUpdatedAt: true,
    defaults: {
      description: "",
      channel: "all",
      priority: "all",
      firstResponseMins: 30,
      resolutionMins: 480,
      isActive: true,
    },
  }),
  cannedResponse: M("cannedResponses", {
    hasUpdatedAt: true,
    defaults: { category: "General", shortcut: "", isActive: true, usageCount: 0 },
  }),
  customer: M("customers", {
    hasUpdatedAt: true,
    defaults: { email: "", phone: "", whatsapp: "", tags: "", isBlocked: false, metadata: {} },
  }),
  customerNote: M("customerNotes", { defaults: { authorName: "Admin" } }),
  automationRule: M("automationRules", {
    hasUpdatedAt: true,
    defaults: {
      description: "",
      isActive: true,
      conditions: [],
      actions: [],
      priority: 0,
      triggerCount: 0,
    },
  }),
  businessHours: M("businessHours", {
    defaults: {
      enabled: false,
      timezone: "UTC",
      monday: "09:00-18:00",
      tuesday: "09:00-18:00",
      wednesday: "09:00-18:00",
      thursday: "09:00-18:00",
      friday: "09:00-18:00",
      saturday: "",
      sunday: "",
      offlineMessage:
        "We are currently offline. We will get back to you during business hours.",
    },
    uniques: ["businessId"],
  }),
  // Harvey Lead Engine (outbound) — tenant-scoped. The sidecar writes;
  // the dashboard reads; humans approve drafts. See src/lib/lead-engine.ts.
  leadScan: M("leadScans", {
    hasUpdatedAt: true,
    defaults: { status: "draft", stats: {}, error: "" },
  }),
  lead: M("leads", {
    hasUpdatedAt: true,
    defaults: {
      scanId: null, description: "", industry: "", companySize: "",
      location: "", phone: "", contactName: "", contactTitle: "",
      contactEmail: "", contactEmailStatus: "guess", icpScore: 0,
      signals: [], techStack: [], source: "", sourceUrl: "",
      externalId: "", personalizationNotes: "", status: "new",
    },
    uniques: [["businessId", "externalId"]],
    compoundKeys: { businessId_externalId: ["businessId", "externalId"] },
  }),
  leadDraft: M("leadDrafts", {
    hasUpdatedAt: true,
    defaults: {
      scanId: null, channel: "email", step: 1, delayDays: 0,
      gateCheck: {}, status: "draft", approvedBy: "",
      approvedAt: null, sentAt: null, sendError: "",
    },
  }),
  leadSettings: M("leadSettings", {
    hasUpdatedAt: true,
    defaults: {
      icp: {}, mailboxProvider: "none", mailboxConnected: false,
      mailboxUser: "", mailboxSecret: "", aiBackend: "none",
      aiBackendConnected: false, maxDailySends: 50, requireApproval: true,
    },
    uniques: ["businessId"],
  }),
  apiKey: M("apiKeys", {
    hasUpdatedAt: true,
    defaults: { keySuffix: "", scopes: [], isActive: true },
    uniques: ["keyHash"],
  }),
  internalNote: M("internalNotes", { defaults: { authorName: "Admin" } }),
  campaign: M("campaigns", {
    hasUpdatedAt: true,
    defaults: {
      description: "",
      channel: "email",
      subject: "",
      segments: [],
      status: "draft",
      sentCount: 0,
    },
  }),
  flow: M("flows", {
    hasUpdatedAt: true,
    defaults: { description: "", startNodeId: "", nodes: [], isActive: false, triggerCount: 0 },
  }),
  followUp: M("followUps", {
    hasUpdatedAt: true,
    defaults: { status: "pending" },
  }),
  socialAccount: M("socialAccounts", {
    hasUpdatedAt: true,
    defaults: { label: "", accountRef: "", tokenEnc: "", tokenIv: "", isActive: true },
    uniques: [["businessId", "platform", "accountRef"]],
    compoundKeys: { businessId_platform_accountRef: ["businessId", "platform", "accountRef"] },
  }),
  scheduledPost: M("scheduledPosts", {
    hasUpdatedAt: true,
    defaults: {
      postType: "promo",
      textContent: "",
      topic: "",
      imagePrompt: "",
      imageUrl: "",
      status: "scheduled",
      resultRef: "",
      error: "",
      createdBy: "admin",
    },
  }),
  socialInteraction: M("socialInteractions", {
    defaults: { parentRef: "", customerRef: "", content: "", likes: 0, replied: false },
    uniques: [["businessId", "platform", "externalId"]],
    compoundKeys: {
      businessId_platform_externalId: ["businessId", "platform", "externalId"],
    },
  }),
  audienceProfile: M("audienceProfiles", {
    hasUpdatedAt: true,
    defaults: { data: {} },
    uniques: [["businessId", "platform"]],
    compoundKeys: { businessId_platform: ["businessId", "platform"] },
  }),
  agentCommand: M("agentCommands", {
    hasUpdatedAt: true,
    defaults: { status: "queued", result: "", createdBy: "admin" },
  }),
  productCategory: M("productCategories", {
    hasUpdatedAt: true,
    defaults: { description: "" },
    uniques: [["businessId", "name"]],
    compoundKeys: { businessId_name: ["businessId", "name"] },
  }),
  product: M("products", {
    hasUpdatedAt: true,
    defaults: {
      description: "",
      currency: "BDT",
      imageUrl: "",
      tags: "",
      isAvailable: true,
      metadata: {},
    },
  }),
  // Phase 2: tenant orders (dashboard + AI order capture).
  order: M("orders", {
    hasUpdatedAt: true,
    defaults: {
      conversationId: null,
      customerId: null,
      items: [],
      customFields: {},
      summary: "",
      status: "pending",
      total: null,
    },
  }),
};

// ---------------------------------------------------------------------------
// Relations (for include/select resolution)
// ---------------------------------------------------------------------------

interface Relation {
  model: string;
  kind: "one" | "many";
  /** FK field: on the PARENT for kind=one (e.g. customerId), on the CHILD for
   *  kind=many (e.g. conversationId on Message). */
  fk: string;
}

const RELATIONS: Record<string, Record<string, Relation>> = {
  conversation: {
    messages: { model: "message", kind: "many", fk: "conversationId" },
    customer: { model: "customer", kind: "one", fk: "customerId" },
    tickets: { model: "ticket", kind: "many", fk: "conversationId" },
    tags: { model: "conversationTag", kind: "many", fk: "conversationId" },
    notes: { model: "internalNote", kind: "many", fk: "conversationId" },
    followUps: { model: "followUp", kind: "many", fk: "conversationId" },
    orders: { model: "order", kind: "many", fk: "conversationId" },
  },
  message: {
    conversation: { model: "conversation", kind: "one", fk: "conversationId" },
  },
  ticket: {
    conversation: { model: "conversation", kind: "one", fk: "conversationId" },
    department: { model: "department", kind: "one", fk: "departmentId" },
    assignedTo: { model: "teamMember", kind: "one", fk: "assignedToId" },
  },
  teamMember: {
    department: { model: "department", kind: "one", fk: "departmentId" },
    tickets: { model: "ticket", kind: "many", fk: "assignedToId" },
  },
  department: {
    members: { model: "teamMember", kind: "many", fk: "departmentId" },
    tickets: { model: "ticket", kind: "many", fk: "departmentId" },
  },
  category: {
    entries: { model: "knowledgeEntry", kind: "many", fk: "categoryId" },
  },
  knowledgeEntry: {
    category: { model: "category", kind: "one", fk: "categoryId" },
  },
  customer: {
    notes: { model: "customerNote", kind: "many", fk: "customerId" },
    conversations: { model: "conversation", kind: "many", fk: "customerId" },
  },
  customerNote: {
    customer: { model: "customer", kind: "one", fk: "customerId" },
  },
  internalNote: {
    conversation: { model: "conversation", kind: "one", fk: "conversationId" },
  },
  followUp: {
    conversation: { model: "conversation", kind: "one", fk: "conversationId" },
  },
  webhook: {
    deliveries: { model: "webhookDelivery", kind: "many", fk: "webhookId" },
  },
  webhookDelivery: {
    webhook: { model: "webhook", kind: "one", fk: "webhookId" },
  },
  conversationTag: {
    conversation: { model: "conversation", kind: "one", fk: "conversationId" },
    tag: { model: "tag", kind: "one", fk: "tagId" },
  },
  tag: {
    conversations: { model: "conversationTag", kind: "many", fk: "tagId" },
  },
  product: {
    category: { model: "productCategory", kind: "one", fk: "categoryId" },
  },
  productCategory: {
    products: { model: "product", kind: "many", fk: "categoryId" },
  },
  order: {
    conversation: { model: "conversation", kind: "one", fk: "conversationId" },
    customer: { model: "customer", kind: "one", fk: "customerId" },
  },
};

// ---------------------------------------------------------------------------
// Value encoding (Date <-> Firestore Timestamp)
// ---------------------------------------------------------------------------

function isTimestamp(v: unknown): v is admin.firestore.Timestamp {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { toMillis?: unknown }).toMillis === "function"
  );
}

function encodeValues(v: unknown): unknown {
  if (v === undefined) return undefined;
  if (v instanceof Date) return admin.firestore.Timestamp.fromDate(v);
  if (Array.isArray(v)) return v.map(encodeValues);
  if (typeof v === "object" && v !== null && !isTimestamp(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val === undefined) continue;
      out[k] = encodeValues(val);
    }
    return out;
  }
  return v;
}

function decodeValues(v: unknown): unknown {
  if (isTimestamp(v)) return v.toDate();
  if (Array.isArray(v)) return v.map(decodeValues);
  if (typeof v === "object" && v !== null && !(v instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = decodeValues(val);
    }
    return out;
  }
  return v;
}

function decodeDoc(
  snap: admin.firestore.QueryDocumentSnapshot | admin.firestore.DocumentSnapshot
): Row {
  return { id: snap.id, ...(decodeValues(snap.data() ?? {}) as Row) };
}

// ---------------------------------------------------------------------------
// Errors (Prisma-compatible codes)
// ---------------------------------------------------------------------------

function p2002(model: string, fields: string[]): Error {
  const err = new Error(
    `Unique constraint failed on the fields: (${fields.join(", ")}) (${model})`
  );
  (err as unknown as { code: string }).code = "P2002";
  return err;
}

function p2025(model: string): Error {
  const err = new Error(
    `An operation failed because it depends on one or more records that were required but not found. (${model})`
  );
  (err as unknown as { code: string }).code = "P2025";
  return err;
}

// ---------------------------------------------------------------------------
// Where normalization (compound-unique keys -> plain field equalities)
// ---------------------------------------------------------------------------

function normalizeWhere(model: string, where: Where): Where {
  if (!where) return where;
  const compoundKeys = MODEL_META[model]?.compoundKeys ?? {};
  if (Object.keys(compoundKeys).length === 0) {
    // Still recurse into AND/OR/NOT (nested compound keys are not used, but
    // the recursion is harmless).
  }
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(where)) {
    if (key === "AND" || key === "OR" || key === "NOT") {
      const parts = Array.isArray(val) ? val : [val];
      out[key] = (parts as Where[]).map((p) => normalizeWhere(model, p));
      continue;
    }
    const fields = compoundKeys[key];
    if (fields && typeof val === "object" && val !== null) {
      for (const f of fields) {
        out[f] = (val as Record<string, unknown>)[f];
      }
      continue;
    }
    out[key] = val;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Raw (unscoped) model queries — the tenant proxy wraps these
// ---------------------------------------------------------------------------

type Ctx = { businessId?: string | null };

async function fetchCandidates(
  model: string,
  where: Where,
  ctx: Ctx
): Promise<Row[]> {
  const meta = MODEL_META[model];
  const db = getDb();
  const collection = db.collection(meta.collection);

  // Fast path: equality on the document id.
  const idEq = extractEquality(where, "id");
  if (typeof idEq === "string" && idEq) {
    const snap = await collection.doc(idEq).get();
    if (!snap.exists) return [];
    return [decodeDoc(snap)];
  }

  let q: admin.firestore.Query = collection;
  if (meta.tenantScoped) {
    const bEq = extractEquality(where, "businessId");
    const businessId = bEq !== undefined ? bEq : ctx.businessId;
    if (typeof businessId === "string" && businessId) {
      // Single-field equality: no composite index required.
      q = q.where("businessId", "==", businessId);
    }
  }
  const snap = await q.get();
  return snap.docs.map(decodeDoc);
}

/** Relation-filter keys ({ some, none, every }) present in a where clause. */
function relationFilterKeys(where: Where): string[] {
  if (!where) return [];
  return Object.entries(where)
    .filter(
      ([k, v]) =>
        k !== "AND" &&
        k !== "OR" &&
        k !== "NOT" &&
        typeof v === "object" &&
        v !== null &&
        ("some" in (v as object) || "none" in (v as object) || "every" in (v as object))
    )
    .map(([k]) => k);
}

async function loadRelated(
  parentModel: string,
  relName: string,
  parent: Row,
  ctx: Ctx
): Promise<Row[]> {
  const rel = RELATIONS[parentModel]?.[relName];
  if (!rel) return [];
  const childMeta = MODEL_META[rel.model];
  if (rel.kind === "many") {
    const childBusinessId =
      childMeta.tenantScoped && typeof parent.businessId === "string"
        ? parent.businessId
        : ctx.businessId;
    const rows = await fetchCandidates(
      rel.model,
      { [rel.fk]: parent.id } as Where,
      { businessId: childBusinessId ?? undefined }
    );
    // fetchCandidates only prefilters businessId server-side; the FK filter
    // must be applied in memory (Phase 3 fix: without this, "many" includes
    // returned every row of the business for every parent).
    const fkWhere = { [rel.fk]: parent.id } as Where;
    return rows.filter(
      (r) =>
        matchesScalarWhere(r, fkWhere) &&
        (childMeta.tenantScoped && typeof childBusinessId === "string"
          ? r.businessId === childBusinessId
          : true)
    );
  }
  const fkVal = parent[rel.fk];
  if (typeof fkVal !== "string" || !fkVal) return [];
  const rows = await fetchCandidates(rel.model, { id: fkVal } as Where, ctx);
  const row = rows[0];
  if (!row) return [];
  if (
    childMeta.tenantScoped &&
    typeof parent.businessId === "string" &&
    row.businessId !== parent.businessId
  ) {
    return [];
  }
  return [row];
}

async function applyRelationFilters(
  model: string,
  rows: Row[],
  where: Where,
  ctx: Ctx
): Promise<Row[]> {
  const keys = relationFilterKeys(where);
  if (keys.length === 0) return rows;
  const out: Row[] = [];
  for (const row of rows) {
    let keep = true;
    for (const key of keys) {
      const spec = (where as Record<string, unknown>)[key] as Record<string, unknown>;
      const related = await loadRelated(model, key, row, ctx);
      if ("some" in spec) {
        if (!related.some((r) => matchesScalarWhere(r, spec.some as Where))) {
          keep = false;
          break;
        }
      } else if ("none" in spec) {
        if (related.some((r) => matchesScalarWhere(r, spec.none as Where))) {
          keep = false;
          break;
        }
      } else if ("every" in spec) {
        if (!related.every((r) => matchesScalarWhere(r, spec.every as Where))) {
          keep = false;
          break;
        }
      }
    }
    if (keep) out.push(row);
  }
  return out;
}

/** Count children for relation-count orderBy / _count resolution. */
async function countRelated(
  parentModel: string,
  relName: string,
  parent: Row,
  relWhere: Where,
  ctx: Ctx
): Promise<number> {
  const related = await loadRelated(parentModel, relName, parent, ctx);
  if (!relWhere) return related.length;
  return related.filter((r) => matchesScalarWhere(r, relWhere)).length;
}

async function resolveCount(
  model: string,
  row: Row,
  countSpec: unknown,
  ctx: Ctx
): Promise<Row> {
  const out: Row = {};
  const select =
    typeof countSpec === "object" && countSpec !== null && "select" in (countSpec as object)
      ? ((countSpec as Record<string, unknown>).select as Record<string, unknown>)
      : (countSpec as Record<string, unknown>);
  for (const [relName, relArg] of Object.entries(select ?? {})) {
    if (!relArg) continue;
    const relWhere =
      typeof relArg === "object" && relArg !== null
        ? ((relArg as Record<string, unknown>).where as Where)
        : undefined;
    out[relName] = await countRelated(model, relName, row, relWhere, ctx);
  }
  return out;
}

async function resolveInclude(
  model: string,
  row: Row,
  include: Record<string, unknown>,
  ctx: Ctx
): Promise<Row> {
  const out: Row = { ...row };
  for (const [relName, rawSpec] of Object.entries(include)) {
    if (relName === "_count") {
      out._count = await resolveCount(model, row, rawSpec, ctx);
      continue;
    }
    const rel = RELATIONS[model]?.[relName];
    if (!rel) continue; // unknown relation: ignore (mirrors "no such field" being a dev-time error in Prisma, but never occurs in this codebase)
    const args =
      rawSpec === true ? {} : ((rawSpec ?? {}) as Record<string, unknown>);
    if (rel.kind === "many") {
      let children = await loadRelated(model, relName, row, ctx);
      if (args.where) {
        children = children.filter((r) =>
          matchesScalarWhere(r, args.where as Where)
        );
      }
      // Relation-count ordering inside includes is not used; scalar only.
      children = sortRows(children, args.orderBy);
      if (typeof args.skip === "number") children = children.slice(args.skip);
      if (typeof args.take === "number") {
        children =
          args.take >= 0 ? children.slice(0, args.take) : children.slice(args.take);
      }
      const resolved: Row[] = [];
      for (const child of children) {
        let c: Row = args.select
          ? projectSelect(child, args.select as Record<string, unknown>)
          : { ...child };
        if (args.select) {
          // Resolve relation keys nested inside select (e.g. select with
          // a relation set to true).
          c = await resolveSelectRelations(rel.model, child, args.select as Record<string, unknown>, ctx, c);
        }
        if (args.include) {
          c = await resolveInclude(rel.model, c, args.include as Record<string, unknown>, ctx);
        }
        resolved.push(c);
      }
      out[relName] = resolved;
    } else {
      const related = await loadRelated(model, relName, row, ctx);
      const child = related[0] ?? null;
      if (!child) {
        out[relName] = null;
        continue;
      }
      let c: Row = args.select
        ? projectSelect(child, args.select as Record<string, unknown>)
        : { ...child };
      if (args.select) {
        c = await resolveSelectRelations(rel.model, child, args.select as Record<string, unknown>, ctx, c);
      }
      if (args.include) {
        c = await resolveInclude(rel.model, c, args.include as Record<string, unknown>, ctx);
      }
      out[relName] = c;
    }
  }
  return out;
}

/**
 * Resolve relation keys inside a `select` object (e.g.
 * `select: { entries: true }` or `select: { category: { select: {...} } }`).
 * `projected` is the scalar-projected row being built; `full` is the source.
 */
async function resolveSelectRelations(
  model: string,
  full: Row,
  select: Record<string, unknown>,
  ctx: Ctx,
  projected: Row
): Promise<Row> {
  const out = { ...projected };
  for (const [key, val] of Object.entries(select)) {
    if (key === "_count") {
      out._count = await resolveCount(model, full, val, ctx);
      continue;
    }
    const rel = RELATIONS[model]?.[key];
    if (!rel) continue;
    if (val === true) {
      const inc: Record<string, unknown> = {};
      inc[key] = true;
      const r = await resolveInclude(model, full, inc, ctx);
      out[key] = r[key];
    } else if (typeof val === "object" && val !== null) {
      const nested = val as Record<string, unknown>;
      const inc: Record<string, unknown> = {};
      inc[key] = nested.select ? { select: nested.select } : true;
      const r = await resolveInclude(model, full, inc, ctx);
      out[key] = r[key];
    }
  }
  return out;
}

/** Apply `select`/`include` to a row (select wins when both present). */
async function applySelectInclude(
  model: string,
  row: Row,
  args: { select?: unknown; include?: unknown },
  ctx: Ctx
): Promise<Row> {
  if (args.select && typeof args.select === "object") {
    const select = args.select as Record<string, unknown>;
    const projected = projectSelect(row, select);
    return resolveSelectRelations(model, row, select, ctx, projected);
  }
  if (args.include && typeof args.include === "object") {
    return resolveInclude(model, row, args.include as Record<string, unknown>, ctx);
  }
  return { ...row };
}

/** Order by relation-count specs like `{ entries: { _count: "desc" } }`. */
async function applyRelationCountOrder(
  model: string,
  rows: Row[],
  orderBy: unknown,
  ctx: Ctx
): Promise<Row[]> {
  if (!orderBy) return rows;
  const specs = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Record<
    string,
    unknown
  >[];
  const relSpecs = specs.filter(
    (s) =>
      s &&
      Object.entries(s).some(
        ([, v]) =>
          typeof v === "object" && v !== null && "_count" in (v as object)
      )
  );
  if (relSpecs.length === 0) return rows;
  const counts = new Map<string, Map<string, number>>();
  for (const spec of relSpecs) {
    for (const [relName, v] of Object.entries(spec)) {
      const dir = (v as Record<string, string>)._count;
      if (dir !== "asc" && dir !== "desc") continue;
      if (!counts.has(relName)) {
        const m = new Map<string, number>();
        for (const row of rows) {
          m.set(String(row.id), await countRelated(model, relName, row, undefined, ctx));
        }
        counts.set(relName, m);
      }
    }
  }
  const out = [...rows];
  out.sort((a, b) => {
    for (const spec of relSpecs) {
      for (const [relName, v] of Object.entries(spec)) {
        const dir = (v as Record<string, string>)._count;
        if (dir !== "asc" && dir !== "desc") continue;
        const m = counts.get(relName)!;
        const ca = m.get(String(a.id)) ?? 0;
        const cb = m.get(String(b.id)) ?? 0;
        if (ca !== cb) return dir === "asc" ? ca - cb : cb - ca;
      }
    }
    return 0;
  });
  return out;
}

// ---------------------------------------------------------------------------
// Delegate factory — one per model, Prisma-compatible operation surface
// ---------------------------------------------------------------------------

export interface ModelDelegate<T = Row> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  findUnique(args?: any): Promise<T | null>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  findUniqueOrThrow(args?: any): Promise<T>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  findFirst(args?: any): Promise<T | null>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  findFirstOrThrow(args?: any): Promise<T>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  findMany(args?: any): Promise<T[]>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  create(args: any): Promise<T>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createMany(args: any): Promise<{ count: number }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  update(args: any): Promise<T>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  updateMany(args: any): Promise<{ count: number }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  upsert(args: any): Promise<T>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete(args: any): Promise<T>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  deleteMany(args?: any): Promise<{ count: number }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  count(args?: any): Promise<number>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  aggregate(args?: any): Promise<Record<string, any>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  groupBy(args: any): Promise<Array<Record<string, any>>>;
}

async function checkUniques(
  model: string,
  row: Row,
  tx: admin.firestore.Transaction,
  db: admin.firestore.Firestore,
  ignoreId?: string
): Promise<void> {
  const meta = MODEL_META[model];
  for (const u of meta.uniques) {
    const fields = Array.isArray(u) ? u : [u];
    if (fields.some((f) => row[f] === undefined)) continue;
    // Single-field equality needs no composite index; compound uniques are
    // checked by scanning the businessId-prefiltered set in memory.
    const firstField = fields[0];
    let q: admin.firestore.Query = db.collection(meta.collection);
    if (meta.tenantScoped && fields.includes("businessId") && typeof row.businessId === "string") {
      q = q.where("businessId", "==", row.businessId);
    } else {
      q = q.where(firstField, "==", encodeValues(row[firstField]));
    }
    const snap = await tx.get(q);
    const conflict = snap.docs.some((d) => {
      if (d.id === ignoreId) return false;
      const data = d.data();
      return fields.every((f) => valuesEqual(decodeValues(data[f]), row[f]));
    });
    if (conflict) throw p2002(model, fields);
  }
}

function makeDelegate(model: string): ModelDelegate {
  const meta = MODEL_META[model];
  const ctx: Ctx = {};

  async function findManyRaw(args: Record<string, unknown> = {}): Promise<Row[]> {
    const where = normalizeWhere(model, (args.where as Where) ?? undefined);
    let rows = await fetchCandidates(model, where, ctx);
    rows = rows.filter((r) => matchesScalarWhere(r, where));
    rows = await applyRelationFilters(model, rows, where, ctx);
    rows = await applyRelationCountOrder(model, rows, args.orderBy, ctx);
    rows = sortRows(rows, args.orderBy);
    if (args.distinct) {
      const fields = (Array.isArray(args.distinct) ? args.distinct : [args.distinct]) as string[];
      const seen = new Set<string>();
      rows = rows.filter((r) => {
        const key = fields.map((f) => JSON.stringify(r[f] ?? null)).join("|");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    if (typeof args.skip === "number") rows = rows.slice(args.skip);
    if (typeof args.take === "number") {
      rows = args.take >= 0 ? rows.slice(0, args.take) : rows.slice(args.take);
    }
    const out: Row[] = [];
    for (const row of rows) {
      out.push(await applySelectInclude(model, row, args, ctx));
    }
    return out;
  }

  async function findFirstRaw(args: Record<string, unknown> = {}): Promise<Row | null> {
    const rows = await findManyRaw({ ...args, take: 1 });
    return rows[0] ?? null;
  }

  async function createRaw(args: Record<string, unknown>): Promise<Row> {
    const db = getDb();
    const data = stripUndefined((args.data ?? {}) as Row);
    const now = new Date();
    const row: Row = {
      ...meta.defaults,
      ...data,
      id:
        typeof data.id === "string" && data.id
          ? data.id
          : randomUUID(),
      createdAt: data.createdAt ?? now,
    };
    if (meta.hasUpdatedAt && row.updatedAt === undefined) row.updatedAt = now;
    await db.runTransaction(async (tx) => {
      const ref = db.collection(meta.collection).doc(String(row.id));
      const existing = await tx.get(ref);
      if (existing.exists) throw p2002(model, ["id"]);
      await checkUniques(model, row, tx, db);
      tx.set(ref, encodeValues(row) as Record<string, unknown>);
    });
    const created = await findFirstRaw({ where: { id: row.id } });
    if (!created) throw p2025(model);
    return applySelectInclude(model, created, args, ctx);
  }

  async function updateRaw(args: Record<string, unknown>): Promise<Row> {
    const db = getDb();
    const where = normalizeWhere(model, (args.where as Where) ?? undefined);
    const data = stripUndefined((args.data ?? {}) as Row);
    const now = new Date();
    const updateData: Row = {};
    for (const [k, v] of Object.entries(data)) updateData[k] = v;
    if (meta.hasUpdatedAt && updateData.updatedAt === undefined) {
      updateData.updatedAt = now;
    }
    const idEq = extractEquality(where, "id");
    let targetId: string | null = typeof idEq === "string" ? idEq : null;
    if (!targetId) {
      const first = await findFirstRaw({ where });
      if (!first) throw p2025(model);
      targetId = String(first.id);
    }
    const ref = db.collection(meta.collection).doc(targetId);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw p2025(model);
      const current = decodeDoc(snap);
      // Guard: when the caller filtered by more than the id (e.g. tenant
      // scoping), re-verify the row still matches.
      if (!matchesScalarWhere(current, where)) throw p2025(model);
      const merged: Row = { ...current };
      for (const [k, v] of Object.entries(updateData)) {
        merged[k] = applyFieldUpdate(current[k], v);
      }
      await checkUniques(model, merged, tx, db, targetId as string);
      tx.set(ref, encodeValues(merged) as Record<string, unknown>);
    });
    const updated = await findFirstRaw({ where: { id: targetId } });
    if (!updated) throw p2025(model);
    return applySelectInclude(model, updated, args, ctx);
  }

  async function deleteRaw(args: Record<string, unknown>): Promise<Row> {
    const db = getDb();
    const where = normalizeWhere(model, (args.where as Where) ?? undefined);
    const idEq = extractEquality(where, "id");
    let targetId: string | null = typeof idEq === "string" ? idEq : null;
    if (!targetId) {
      const first = await findFirstRaw({ where });
      if (!first) throw p2025(model);
      targetId = String(first.id);
    }
    const ref = db.collection(meta.collection).doc(targetId);
    const deleted = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw p2025(model);
      const current = decodeDoc(snap);
      if (!matchesScalarWhere(current, where)) throw p2025(model);
      tx.delete(ref);
      return current;
    });
    return applySelectInclude(model, deleted, args, ctx);
  }

  async function updateManyRaw(args: Record<string, unknown>): Promise<{ count: number }> {
    const where = normalizeWhere(model, (args.where as Where) ?? undefined);
    const data = stripUndefined((args.data ?? {}) as Row);
    const rows = await findManyRaw({ where, select: { id: true } });
    // Per-document updates (not a blind batch): field operators like
    // { increment } need the current value, and @updatedAt must refresh.
    for (const r of rows) {
      await updateRaw({ where: { id: r.id }, data });
    }
    return { count: rows.length };
  }

  async function deleteManyRaw(args: Record<string, unknown> = {}): Promise<{ count: number }> {
    const db = getDb();
    const where = normalizeWhere(model, (args.where as Where) ?? undefined);
    const rows = await findManyRaw({ where, select: { id: true } });
    let n = 0;
    for (let i = 0; i < rows.length; i += 400) {
      const batch = db.batch();
      for (const r of rows.slice(i, i + 400)) {
        batch.delete(db.collection(meta.collection).doc(String(r.id)));
        n++;
      }
      await batch.commit();
    }
    return { count: n };
  }

  return {
    findUnique: (args = {}) => findFirstRaw(args),
    findUniqueOrThrow: async (args = {}) => {
      const r = await findFirstRaw(args);
      if (!r) throw p2025(model);
      return r;
    },
    findFirst: (args = {}) => findFirstRaw(args),
    findFirstOrThrow: async (args = {}) => {
      const r = await findFirstRaw(args);
      if (!r) throw p2025(model);
      return r;
    },
    findMany: (args = {}) => findManyRaw(args),

    create: (args) => createRaw(args),

    createMany: async (args) => {
      const rows = (args.data ?? []) as Row[];
      for (const d of rows) {
        await createRaw({ ...args, data: d });
      }
      return { count: rows.length };
    },

    update: (args) => updateRaw(args),
    updateMany: (args) => updateManyRaw(args),

    upsert: async (args) => {
      const where = normalizeWhere(model, (args.where as Where) ?? undefined);
      const existing = await findFirstRaw({ where, select: { id: true } });
      if (existing) {
        return updateRaw({ ...args, where: { id: existing.id }, data: args.data });
      }
      return createRaw({ ...args, data: args.create });
    },

    delete: (args) => deleteRaw(args),
    deleteMany: (args = {}) => deleteManyRaw(args),

    count: async (args = {}) => {
      const rows = await findManyRaw({ where: args.where, select: { id: true } });
      return rows.length;
    },

    aggregate: async (args = {}) => {
      const rows = await findManyRaw({ where: args.where });
      const out: Row = {};
      const countSpec = args._count as unknown;
      if (countSpec) {
        if (countSpec === true) {
          out._count = rows.length;
        } else {
          const c: Row = {};
          for (const [field] of Object.entries(countSpec as Record<string, unknown>)) {
            if (field === "_all") c._all = rows.length;
            else c[field] = rows.filter((r) => r[field] != null).length;
          }
          out._count = c;
        }
      }
      for (const fn of ["_sum", "_avg", "_min", "_max"] as const) {
        const spec = args[fn] as Record<string, unknown> | undefined;
        if (!spec) continue;
        const r: Row = {};
        for (const [field] of Object.entries(spec)) {
          const vals = rows
            .map((row) => row[field])
            .filter((v): v is number => typeof v === "number");
          if (fn === "_sum") r[field] = vals.reduce((a, b) => a + b, 0);
          else if (fn === "_avg")
            r[field] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
          else if (fn === "_min")
            r[field] = vals.length ? Math.min(...vals) : null;
          else r[field] = vals.length ? Math.max(...vals) : null;
        }
        out[fn] = r;
      }
      return out;
    },

    groupBy: async (args) => {
      const by = (args.by ?? []) as string[];
      const rows = await findManyRaw({ where: args.where });
      const groups = new Map<string, Row[]>();
      for (const row of rows) {
        const key = by.map((f) => JSON.stringify(row[f] ?? null)).join("|");
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(row);
      }
      const out: Row[] = [];
      for (const [, grows] of groups) {
        const g: Row = {};
        for (const f of by) g[f] = grows[0][f] ?? null;
        const countSpec = args._count as unknown;
        if (countSpec) {
          if (countSpec === true) g._count = grows.length;
          else {
            const c: Row = {};
            for (const [field] of Object.entries(countSpec as Record<string, unknown>)) {
              if (field === "_all") c._all = grows.length;
              else c[field] = grows.filter((r) => r[field] != null).length;
            }
            g._count = c;
          }
        }
        for (const fn of ["_sum", "_avg", "_min", "_max"] as const) {
          const spec = args[fn] as Record<string, unknown> | undefined;
          if (!spec) continue;
          const r: Row = {};
          for (const [field] of Object.entries(spec)) {
            const vals = grows
              .map((row) => row[field])
              .filter((v): v is number => typeof v === "number");
            if (fn === "_sum") r[field] = vals.reduce((a, b) => a + b, 0);
            else if (fn === "_avg")
              r[field] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
            else if (fn === "_min") r[field] = vals.length ? Math.min(...vals) : null;
            else r[field] = vals.length ? Math.max(...vals) : null;
          }
          g[fn] = r;
        }
        out.push(g);
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Raw (unscoped) client assembly
// ---------------------------------------------------------------------------

export interface DbClient {
  business: ModelDelegate<Business>;
  settings: ModelDelegate<Settings>;
  admin: ModelDelegate<Admin>;
  revokedToken: ModelDelegate<RevokedToken>;
  category: ModelDelegate<Category>;
  knowledgeEntry: ModelDelegate<KnowledgeEntry>;
  department: ModelDelegate<Department>;
  teamMember: ModelDelegate<TeamMember>;
  conversation: ModelDelegate<Conversation>;
  message: ModelDelegate<Message>;
  ticket: ModelDelegate<Ticket>;
  tag: ModelDelegate<Tag>;
  conversationTag: ModelDelegate<ConversationTag>;
  callLog: ModelDelegate<CallLog>;
  channel: ModelDelegate<Channel>;
  schedule: ModelDelegate<Schedule>;
  webhook: ModelDelegate<Webhook>;
  webhookDelivery: ModelDelegate<WebhookDelivery>;
  activityLog: ModelDelegate<ActivityLog>;
  sLARule: ModelDelegate<SLARule>;
  cannedResponse: ModelDelegate<CannedResponse>;
  customer: ModelDelegate<Customer>;
  customerNote: ModelDelegate<CustomerNote>;
  automationRule: ModelDelegate<AutomationRule>;
  businessHours: ModelDelegate<BusinessHours>;
  apiKey: ModelDelegate<ApiKey>;
  internalNote: ModelDelegate<InternalNote>;
  campaign: ModelDelegate<Campaign>;
  flow: ModelDelegate<Flow>;
  followUp: ModelDelegate<FollowUp>;
  socialAccount: ModelDelegate<SocialAccount>;
  scheduledPost: ModelDelegate<ScheduledPost>;
  socialInteraction: ModelDelegate<SocialInteraction>;
  audienceProfile: ModelDelegate<AudienceProfile>;
  agentCommand: ModelDelegate<AgentCommand>;
  productCategory: ModelDelegate<ProductCategory>;
  product: ModelDelegate<Product>;
  order: ModelDelegate<Order>;
  leadScan: ModelDelegate<LeadScan>;
  lead: ModelDelegate<Lead>;
  leadDraft: ModelDelegate<LeadDraft>;
  leadSettings: ModelDelegate<LeadSettings>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $queryRaw(...args: any[]): Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $executeRaw(...args: any[]): Promise<any>;
  $transaction<T>(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    arg: Promise<T>[] | ((tx: DbClient) => Promise<T>)
  ): Promise<T[] | T>;
  $connect(): Promise<void>;
  $disconnect(): Promise<void>;
}

const MODEL_NAMES = Object.keys(MODEL_META);

function createRawClient(): DbClient {
  const client: Record<string, unknown> = {};
  for (const name of MODEL_NAMES) {
    client[name] = makeDelegate(name);
  }
  // `$queryRaw` was only ever a connectivity probe (`SELECT 1` in
  // /api/health). The SQL text is ignored; we probe Firestore instead.
  client.$queryRaw = async (..._args: unknown[]) => {
    await getDb().listCollections();
    return [{ "?column?": 1 }];
  };
  client.$executeRaw = async (..._args: unknown[]) => {
    await getDb().listCollections();
    return { count: 0 };
  };
  // The codebase never uses $transaction; provide a sequential fallback.
  // NOTE: unlike Postgres this is NOT atomic across documents — see
  // OPERATIONS.md "Firestore behavior differences".
  client.$transaction = (async <T>(arg: Promise<T>[] | ((tx: DbClient) => Promise<T>)) => {
    if (typeof arg === "function") {
      return arg(rawDb);
    }
    const out: T[] = [];
    for (const p of arg) {
      out.push(await p);
    }
    return out;
  }) as DbClient["$transaction"];
  client.$connect = async () => {
    getDb();
  };
  client.$disconnect = async () => {
    await closeDb();
  };
  return client as unknown as DbClient;
}

// ---------------------------------------------------------------------------
// Multi-tenancy (fail-closed) — same contract as the previous Prisma layer
// ---------------------------------------------------------------------------

const TENANT_MODELS = new Set([
  "settings",
  "admin",
  "category",
  "knowledgeEntry",
  "department",
  "teamMember",
  "conversation",
  "message",
  "ticket",
  "tag",
  "conversationTag",
  "callLog",
  "channel",
  "webhook",
  "webhookDelivery",
  "activityLog",
  "sLARule", // NOTE: was "slaRule" (wrong case — never matched) in the Prisma layer; fixed here so SLA rules are actually tenant-scoped.
  "cannedResponse",
  "customer",
  "customerNote",
  "automationRule",
  "businessHours",
  "apiKey",
  "internalNote",
  "campaign",
  "flow",
  "schedule",
  "followUp",
  "productCategory",
  "product",
  "order",
  "socialAccount",
  "scheduledPost",
  "socialInteraction",
  "audienceProfile",
  "agentCommand",
  "leadScan",
  "lead",
  "leadDraft",
  "leadSettings",
]);

export class TenantContextError extends Error {
  constructor(model: string, operation: string) {
    super(
      `Tenant context missing for ${model}.${operation}: ` +
        `call enterBusinessContext()/runWithBusiness() first, or use getUnscopedPrisma() in scripts.`
    );
    this.name = "TenantContextError";
  }
}

type TenantStore = { businessId: string | null };
const tenantStore = new AsyncLocalStorage<TenantStore>();

/** Run `fn` with an explicit business context (workers, scripts, tests). */
export function runWithBusiness<T>(businessId: string | null, fn: () => T): T {
  return tenantStore.run({ businessId }, fn);
}

/**
 * Enter a business context for the REMAINDER of the current async execution.
 *
 * WARNING: this uses AsyncLocalStorage.enterWith(), which does NOT propagate
 * across an `await` boundary back into the CALLER. It only works when called
 * directly in the same async function that performs the subsequent awaits
 * (e.g. at the top of a webhook handler or channel event callback). It must
 * NOT be relied upon inside helpers like requireAuth()/cronAuth() — the
 * route handler that awaited the helper will NOT see the context and scoped
 * prisma calls there will throw TenantContextError. Helpers must return the
 * businessId and the caller must wrap its work in runWithBusiness().
 */
export function enterBusinessContext(businessId: string | null): void {
  tenantStore.enterWith({ businessId });
}

/** Current business id, or null (super admin), or undefined (no context). */
export function getBusinessId(): string | null | undefined {
  return tenantStore.getStore()?.businessId;
}

/**
 * Attach the ambient business id to a create payload. Fail-closed: throws
 * when no tenant context is active.
 */
export function withBusinessId<T extends object>(data: T): T & { businessId: string } {
  const id = getBusinessId();
  if (!id) {
    throw new TenantContextError("create", "withBusinessId");
  }
  return { ...data, businessId: id };
}

/** Array variant of withBusinessId (for createMany). */
export function withBusinessIdMany<T extends object>(
  rows: T[]
): (T & { businessId: string })[] {
  const id = getBusinessId();
  if (!id) {
    throw new TenantContextError("createMany", "withBusinessIdMany");
  }
  return rows.map((r) => ({ ...r, businessId: id }));
}

function scopedWhere(
  where: Record<string, unknown> | undefined,
  businessId: string
): Record<string, unknown> {
  if (!where || Object.keys(where).length === 0) return { businessId };
  return { AND: [where, { businessId }] };
}

const LIST_OPS = new Set([
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "count",
  "aggregate",
  "groupBy",
  "updateMany",
  "deleteMany",
]);

function wrapModel(model: string, delegate: Record<string, unknown>) {
  const cache = new Map<string | symbol, unknown>();
  return new Proxy(delegate, {
    get(target, prop, receiver) {
      if (cache.has(prop)) return cache.get(prop);
      const orig = Reflect.get(target, prop, receiver);
      if (typeof orig !== "function") {
        cache.set(prop, orig);
        return orig;
      }
      const op = String(prop);
      const wrapped = (...args: unknown[]) => {
        const businessId = getBusinessId();
        if (businessId === undefined) {
          throw new TenantContextError(model, op);
        }
        if (businessId === null) {
          // Super Admin: unscoped.
          return (orig as (...a: unknown[]) => unknown)(...args);
        }
        const a = (args[0] ?? {}) as Record<string, unknown>;

        if (LIST_OPS.has(op)) {
          return (orig as (...x: unknown[]) => unknown)(
            {
              ...a,
              where: scopedWhere(
                a.where as Record<string, unknown> | undefined,
                businessId
              ),
            },
            ...args.slice(1)
          );
        }

        if (op === "findUnique" || op === "findUniqueOrThrow") {
          // findUnique cannot take a compound where; use findFirst instead.
          const fn = op === "findUnique" ? "findFirst" : "findFirstOrThrow";
          const { orderBy: _ob, ...rest } = a;
          return (delegate[fn] as (...x: unknown[]) => unknown)({
            ...rest,
            where: scopedWhere(
              a.where as Record<string, unknown> | undefined,
              businessId
            ),
          });
        }

        if (op === "create") {
          const data = a.data as Record<string, unknown>;
          return (orig as (...x: unknown[]) => unknown)({
            ...a,
            data: data.businessId ? data : { ...data, businessId },
          });
        }

        if (op === "createMany") {
          const data = a.data as Record<string, unknown>[];
          return (orig as (...x: unknown[]) => unknown)({
            ...a,
            data: data.map((d) => (d.businessId ? d : { ...d, businessId })),
          });
        }

        if (op === "update" || op === "delete") {
          // Two-step guarded mutation: first prove the row belongs to this
          // business, then mutate by id. Preserves P2025 semantics.
          return (async () => {
            const existing = (await (
              delegate["findFirst"] as (...x: unknown[]) => Promise<{ id: string } | null>
            )({
              where: scopedWhere(
                a.where as Record<string, unknown> | undefined,
                businessId
              ),
              select: { id: true },
            })) as { id: string } | null;
            if (!existing) throw p2025(model);
            return (orig as (...x: unknown[]) => Promise<unknown>)({
              ...a,
              where: { id: existing.id },
            });
          })();
        }

        if (op === "upsert") {
          return (async () => {
            const { where, create, update, ...rest } = a;
            const existing = (await (
              delegate["findFirst"] as (...x: unknown[]) => Promise<{ id: string } | null>
            )({
              where: scopedWhere(
                where as Record<string, unknown> | undefined,
                businessId
              ),
              select: { id: true },
            })) as { id: string } | null;
            if (existing) {
              return (delegate["update"] as (...x: unknown[]) => Promise<unknown>)({
                ...rest,
                where: { id: existing.id },
                data: update,
              });
            }
            const cdata = create as Record<string, unknown>;
            return (delegate["create"] as (...x: unknown[]) => Promise<unknown>)({
              ...rest,
              data: cdata.businessId ? cdata : { ...cdata, businessId },
            });
          })();
        }

        // Unknown op: pass through (fail-open would be wrong, but unknown
        // ops on delegates are vanishingly rare; log loudly).
        // eslint-disable-next-line no-console
        console.warn(
          `[tenant] unscoped passthrough: ${model}.${op} (business ${businessId})`
        );
        return (orig as (...x: unknown[]) => unknown)(...args);
      };
      cache.set(prop, wrapped);
      return wrapped;
    },
  });
}

function createTenantProxy<T extends object>(raw: T): T {
  return new Proxy(raw, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (
        typeof prop === "string" &&
        TENANT_MODELS.has(prop) &&
        value !== null &&
        typeof value === "object"
      ) {
        return wrapModel(prop, value as Record<string, unknown>);
      }
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

const globalForDb = globalThis as unknown as {
  rawDb: DbClient | undefined;
  prisma: DbClient | undefined;
};

const rawDb: DbClient = globalForDb.rawDb ?? createRawClient();

/**
 * The tenant-enforcing client. Import THIS everywhere (`import { prisma }
 * from "@/lib/prisma"`). All tenant-model queries are auto-scoped.
 */
export const prisma: DbClient =
  globalForDb.prisma ?? (createTenantProxy(rawDb) as DbClient);

/** Bypass tenant scoping. ONLY for seed/migration scripts and controlled setup code. */
export function getUnscopedPrisma(): DbClient {
  return rawDb;
}

if (process.env.NODE_ENV !== "production") {
  globalForDb.rawDb = rawDb;
  globalForDb.prisma = prisma;
}


