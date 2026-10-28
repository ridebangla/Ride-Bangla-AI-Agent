/**
 * models.ts — TypeScript interfaces for every Firestore document model.
 *
 * These replace the Prisma-generated types (`@/generated/prisma/client`),
 * which no longer exist. Field types mirror the old Prisma schema:
 * `DateTime` -> `Date`, `Json` -> `JsonValue`, `String[]` -> `string[]`.
 */

/** Any JSON-serializable value (mirrors Prisma's JsonValue). */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** JSON value accepted as write input (mirrors Prisma.InputJsonValue). */
export type InputJsonValue = JsonValue;

/** One website on a business's website list (owner directive 2026-10-21:
 * a business can add ALL its websites — no one-site limit — and the agent
 * learns the business from every one of them). Stored as a JSON array on
 * the business doc (`Business.websites`). `status` is honest by
 * construction: "indexed" is only ever written after a real fetch-and-
 * index run saved knowledge entries; a failed fetch lands in "failed"
 * with the reason, never in a fake "trained" state. */
export interface BusinessWebsite {
  id: string;
  /** Canonical URL (see src/lib/website-url.ts). */
  url: string;
  host: string;
  status: "pending" | "indexed" | "failed";
  /** Human-readable failure reason when status is "failed". */
  statusReason?: string;
  /** Public pages fetched on the last successful index run. */
  pageCount?: number;
  /** Knowledge entries the last successful index run saved. */
  entryCount?: number;
  /** ISO timestamp. */
  addedAt: string;
  /** ISO timestamp of the last index attempt (success or failure). */
  lastIndexedAt?: string | null;
}

export interface Business {

  [key: string]: unknown;  id: string;
  name: string;
  slug: string;
  siteKey: string;
  isActive: boolean;
  /** SaaS subscription (Phase 1). Absent on businesses created before Phase 1. */
  plan?: string; // 'trial' | 'starter' | 'growth' | 'pro'
  subscriptionStatus?: string; // 'trialing' | 'active' | 'past_due' | 'canceled' | 'expired'
  trialEndsAt?: Date | null;
  websiteUrl?: string;
  /** ALL of the business's websites (owner directive 2026-10-21). The
      legacy single `websiteUrl` above predates this list: it is kept in
      sync with the FIRST list entry (the landing page links to it) and,
      for businesses that have no list yet, it is presented as a single
      "pending" entry until they manage the list in Settings. */
  websites?: BusinessWebsite[];
  /** Phase 4: Stripe billing — set on first checkout; used by webhooks + the
      customer portal to resolve tenancy without trusting client input. */
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  /** Phase 4 (yearly billing): 'monthly' | 'yearly' — set by the Stripe
      webhook on checkout.session.completed. Absent = 'monthly'. */
  billingInterval?: string;
  /** Manual override (Admin Console, Super Admin only, audit-logged):
      keep this tenant ACTIVE even without payment. */
  manualActiveOverride?: boolean;
  manualActiveOverrideBy?: string;
  manualActiveOverrideAt?: Date | null;
  manualActiveOverrideReason?: string;
  /** Internal owner comp (owner rule 2026-10-21): the company's OWN
      account — completely free forever: no plan, no message limits, no
      trial expiry, never billed. Set ONLY server-side or by the Admin
      Console Super Admin (audit-logged there); no client request path
      can write these fields, and enforcement reads them from THIS doc
      (keyed by business id) — never from an email string. B7
      (2026-10-22): the account sits OUTSIDE the machinery — usage is
      not metered (recordAiMessage skips it), platform keys serve it,
      and the public-route rate limiters exempt it. */
  isInternalAccount?: boolean;
  internalGrantedBy?: string;
  internalGrantedAt?: Date | null;
  internalGrantReason?: string;
  /** Feature scope for an internal grant (B6): { features: [...] } —
   *  absent = unscoped (all features). See scopeAllows in ./comp. */
  grantScope?: { features?: string[] } | Record<string, boolean> | null;
  /** Complimentary grant (comp) — canonical contract, identical across
      the AI platform, Studio and the Admin Console (see ./comp):
      { active, planId, startsAt, endsAt, reason, grantedBy, grantedAt,
        source: "panel" | "referral" | "review" | "offer", referredBy?,
        requestId?, scope?: { features?: string[] },
        snapshot: { exists, plan, subscriptionStatus, billingInterval,
                    subscriptionEndsAt, trialEndsAt, isActive },
        revokedAt?, revokedBy?, revokeReason? }.
      Written ONLY by the Admin Console Super Admin, which also writes
      the real activation fields; resolvers here read comp directly
      as a belt-and-braces. Auto-expires by endsAt comparison. */
  comp?: {
    active: boolean;
    planId: string;
    startsAt?: Date | null;
    endsAt?: Date | null;
    reason?: string;
    grantedBy?: string;
    grantedAt?: Date | null;
    source?: string;
    referredBy?: string;
    requestId?: string;
    scope?: { features?: string[] };
    snapshot?: {
      exists: boolean;
      plan?: string;
      subscriptionStatus?: string;
      billingInterval?: string;
      subscriptionEndsAt?: Date | null;
      trialEndsAt?: Date | null;
      isActive?: boolean;
    };
    revokedAt?: Date | null;
    revokedBy?: string;
    revokeReason?: string;
  } | null;
  /** Billing Phase 2: AI-message metering — count of finalized AI replies
      in the current 30-day usage period (see usagePeriodStart). */
  aiMessagesUsed?: number;
  /** Billing Phase 2: start of the current 30-day usage period. */
  usagePeriodStart?: Date | null;
  /** Billing Phase 2: when the current paid subscription ends (set by
      Stripe webhooks, wallet purchases, and claim approvals). */
  subscriptionEndsAt?: Date | null;
  /** Billing Phase 2: team-posted notice shown on the dashboard banner. */
  adminNotice?: {
    message: string;
    createdAt?: Date | null;
    createdBy?: string;
  } | null;
  /** Phase 2: auto landing page (hosted at /p/[slug]). */
  tagline?: string;
  brandColor?: string;
  logoUrl?: string;
  /** Profile photo: cropped 1:1 photo data URL (set from the dashboard
      Profile page; the same data-URL-in-Firestore pattern the catalog
      uses for product images — no upload endpoint exists). */
  profilePhoto?: string;
  /** Contact details shown to customers, editable from the dashboard
      Profile page (contact email is the admin's sign-in email instead). */
  contactName?: string;
  contactPhone?: string;
  contactAddress?: string;
  landingPublished?: boolean;
  /** Premium polish: visual theme id for /p/[slug] (see src/lib/landing-themes.ts). */
  landingTheme?: string;
  /** Premium polish: AI-refined copy overrides + suggested theme ("Enhance with AI"). */
  landingAiCopy?: JsonValue;
  /** Premium polish: last recorded landing quality-gate summary (see src/lib/landing-quality.ts). */
  landingQuality?: JsonValue;
  /** Phase 2: per-business custom order fields (Order Settings). */
  orderFields?: JsonValue;
  /**
   * Leg A (booking): per-business booking questions (Booking Settings).
   * Separate from orderFields on purpose — bookings are a separate record
   * type, not orders. The agent must collect every REQUIRED booking
   * question before request_booking creates the request.
   */
  bookingQuestions?: JsonValue;
  /** Courier bridge (owner directive 2026-10-21): when true, confirming
      an order automatically creates a courier booking in Ride Bangla's
      own courier system (Rider app dispatch). Absent = platform default
      (ON for the platform's own Ride Bangla business only, OFF for every
      other tenant). Edited in Orders → Order Settings; the effective
      value is resolved server-side by resolveCourierDeliveryEnabled.
      NOTE: the switch alone never dispatches a TENANT order — the
      dispatch gate (resolveCourierGate, re-audit #3 R3-ai-2) also
      requires a Partner ID (below) and a served area. */
  courierDeliveryEnabled?: boolean;
  /** Ride Bangla Partner ID for this tenant (re-audit #3, R3-ai-2):
      the tenant's own partner identity in the Ride Bangla courier
      system. Tenant orders reach riders ONLY when this is set AND the
      delivery is inside a served area; otherwise the confirmed order is
      notified directly to the shop owner. Edited in Orders → Order
      Settings (same save as courierDeliveryEnabled). No Partner-ID
      field existed before this fix. */
  partnerId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Settings {

  [key: string]: unknown;  id: string;
  businessId: string;
  businessName: string;
  businessDesc: string;
  welcomeMessage: string;
  tone: string;
  language: string;
  aiProvider: string;
  aiModel: string;
  aiApiKey: string;
  maxTokens: number;
  temperature: number;
  elevenLabsKey: string;
  elevenLabsVoice: string;
  twilioSid: string;
  twilioToken: string;
  twilioPhone: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  smtpFrom: string;
  imapHost: string;
  imapPort: number;
  imapUser: string;
  imapPass: string;
  whatsappMode: string;
  whatsappApiKey: string;
  whatsappPhone: string;
  telegramBotToken: string;
  telegramWebhookSecret: string;
  /**
   * Phase 5 (user decision 17): GLOBAL AI kill-switch. false = the AI stays
   * silent across EVERY conversation (website, channels, social) — the
   * human team handles everything. true (default) = per-conversation
   * `conversations.aiEnabled` decides. Flipped from Settings > AI.
   */
  aiEnabled: boolean;
  /**
   * Leg J: per-channel / per-page AI toggles (see
   * src/lib/channel-toggles.ts for precedence). Missing/empty = all
   * ON; only an explicit false switches a surface off. Stored on the
   * tenant's own settings doc, never on a conversation.
   */
  channelAiToggles?: Record<string, boolean>;
  pageAiToggles?: Record<string, { messages?: boolean; comments?: boolean }>;
  /**
   * Behaviour package (owner directive 2026-10-21): per-business agent
   * behaviour switches, normalised by getBehaviourSettings() in
   * src/lib/ai/behaviour.ts. Absent = platform defaults (review asks ON,
   * follow-ups ON, order check-in 24h, dropped-conversation revival 48h,
   * review link = primary website).
   */
  reviewRequestsEnabled?: boolean;
  followUpsEnabled?: boolean;
  /** The business's own review link (e.g. its Google review link). */
  reviewUrl?: string;
  followUpOrderCheckInHours?: number;
  followUpDroppedHours?: number;
  /**
   * Leg D (video round 2) — reply approval mode, tenant-scoped, OPT-IN.
   * replyApprovalEnabled absent/false = direct send (the default).
   * replyApprovalWaitSeconds = seconds a draft waits for review before
   * auto-send; the pure module clamps it to 30..86400 at read time.
   */
  replyApprovalEnabled?: boolean;
  replyApprovalWaitSeconds?: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Leg D (video round 2) — a held agent reply. TEXT ONLY: a draft never
 * creates, confirms, prices, or otherwise changes an order, booking,
 * ticket, or courier state. Sending a draft writes one assistant
 * message row (plus the channel send attempt for non-widget channels).
 * Status lifecycle: pending -> sending -> sent | pending -> rejected |
 * pending -> superseded (new customer message) | pending -> cancelled
 * (thread closed). `sending` is the at-most-once claim state.
 */
export interface ReplyDraft {

  [key: string]: unknown;  id: string;
  businessId: string;
  conversationId: string;
  /** First 500 chars of the customer message this draft answers. */
  customerMessage: string;
  /** Agent-generated text (verbatim). */
  draftText: string;
  /** Team-edited text; wins over draftText at send time. Null = unedited. */
  editedText: string | null;
  status: string;
  /** ISO timestamp at which the sweep auto-sends (snapshot at creation / edit). */
  autoSendAt: string;
  /** Wait seconds snapshotted when the draft (or its edit) was created. */
  waitSecondsSnapshot: number;
  supersedeReason: string | null;
  supersededAt: string | null;
  editedBy: string | null;
  editedByName: string | null;
  editedAt: string | null;
  rejectedBy: string | null;
  rejectedByName: string | null;
  rejectedAt: string | null;
  sentAt: string | null;
  sentBy: string | null;
  sentByName: string | null;
  /** "manual" (team send-now) or "auto" (timer sweep). */
  sentVia: string | null;
  sentMessageId: string | null;
  deliveryNote: string | null;
  cancelReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * LEG G (staged): one tenant's supplementary business rules.
 * One document per business (collection `businessRules`, unique
 * businessId). Every field is optional: absent/null/empty = unset.
 * deliveryCharge / minimumOrder are structured (amount + currency)
 * because only a saved tenant figure may ever be quoted; the text
 * fields are the tenant's own words. overridesWebsite records a
 * tenant-confirmed answer that stands beside a website/details
 * entry — the entry itself is never edited by this leg.
 */
export interface BusinessRules {
  [key: string]: unknown;
  id: string;
  businessId: string;
  deliveryCharge?: { amount: number; currency: string; note?: string } | null;
  deliveryAreas?: string | null;
  deliveryTime?: string | null;
  returnPolicy?: string | null;
  exchangePolicy?: string | null;
  refundPolicy?: string | null;
  paymentMethods?: string | null;
  minimumOrder?: { amount: number; currency: string; note?: string } | null;
  overridesWebsite?: {
    [field: string]: { entryId?: string; excerpt: string; confirmedAt: string };
  };
  createdAt: Date;
  updatedAt: Date;
}

export interface Admin {

  [key: string]: unknown;  id: string;
  username: string;
  password: string;
  name: string;
  role: string;
  businessId: string | null;
  failedLoginAttempts: number;
  lockedUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RevokedToken {

  [key: string]: unknown;  jti: string;
  expiresAt: Date;
  createdAt: Date;
}

export interface Category {

  [key: string]: unknown;  id: string;
  businessId: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
  entries: KnowledgeEntry[];
  _count: { [key: string]: number };
}

export interface KnowledgeEntry {

  [key: string]: unknown;  id: string;
  businessId: string;
  categoryId: string;
  title: string;
  content: string;
  priority: number;
  isActive: boolean;
  version: number;
  metadata: JsonValue;
  /** Set on entries created by website ingestion (src/lib/business-
      websites.ts): the BusinessWebsite.id they came from, so re-indexing
      or removing that one website replaces exactly its own entries. */
  sourceWebsiteId?: string;
  createdAt: Date;
  updatedAt: Date;
  category: Category;
}

export interface Department {

  [key: string]: unknown;  id: string;
  businessId: string;
  name: string;
  description: string;
  email: string;
  createdAt: Date;
  updatedAt: Date;
  members: TeamMember[];
  tickets: Ticket[];
  _count: { [key: string]: number };
}

export interface TeamMember {

  [key: string]: unknown;  _count: { [key: string]: number };
  id: string;
  businessId: string;
  name: string;
  email: string;
  phone: string;
  role: string;
  expertise: string;
  departmentId: string;
  isAvailable: boolean;
  createdAt: Date;
  updatedAt: Date;
  department: Department;
  tickets: Ticket[];
}

export interface Conversation {

  [key: string]: unknown;  id: string;
  businessId: string;
  channel: string;
  customerName: string;
  customerContact: string;
  customerId: string | null;
  status: string;
  satisfaction: number | null;
  summary: string;
  metadata: JsonValue;
  /**
   * Phase 3 (user decision 17): human-takeover switch. true (default) = the
   * AI replies; false = pipeline stores customer messages in pure silence.
   * Flipped by the Phase 5 dashboard switch + live-chat view.
   */
  aiEnabled: boolean;
  /**
   * Leg D (video round 2) — per-chat approval pause. true = this chat's
   * draft auto-send timer is held (drafts stay pending, manual-only)
   * until the team unpauses it. Independent of aiEnabled (takeover).
   */
  approvalPaused?: boolean;
  createdAt: Date;
  updatedAt: Date;
  messages: Message[];
  customer: Customer | null;
  tickets: Ticket[];
  tags: ConversationTag[];
  notes: InternalNote[];
  followUps: FollowUp[];
  _count: { [key: string]: number };
}

export interface Message {

  [key: string]: unknown;  id: string;
  businessId: string;
  conversationId: string;
  role: string;
  content: string;
  mediaType: string | null;
  mediaUrl: string | null;
  toolCalls: JsonValue | null;
  /**
   * Phase 5: honest delivery record for owner replies sent from the inbox
   * live-chat view. "delivered via whatsapp" / "delivered via telegram" /
   * "dashboard-only reply (channel not connected)", etc.
   */
  deliveryNote?: string | null;
  createdAt: Date;
  conversation: Conversation;
}

/**
 * Test-chat sandbox leg — a staff test session. TEST ONLY: a
 * session is never a conversation, never appears in the inbox or
 * any real-conversation count, and never becomes a live
 * conversation (going live flips settings only). isTest is always
 * true; startedWhileLive records the global switch state at
 * creation (missing = ON, as the engine reads it) for display
 * only — it is never a gate and never written back to settings.
 */
export interface TestChatSession {

  [key: string]: unknown;  id: string;
  businessId: string;
  isTest: boolean;
  /** "open" | "closed" (closed = ended test; rows are never deleted). */
  status: string;
  title: string;
  createdBy: string;
  createdByName: string;
  startedWhileLive: boolean;
  messageCount: number;
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
}

/**
 * Test-chat sandbox leg — one turn inside a test session. TEST
 * ONLY: role is "tester" (never "customer") or "assistant" inside
 * a test row; channel is always "test-chat" (a dashboard label,
 * not a real channel). No row here is ever read by inbox,
 * conversation, analytics, or usage code, which query the real
 * collections.
 */
export interface TestChatMessage {

  [key: string]: unknown;  id: string;
  businessId: string;
  sessionId: string;
  isTest: boolean;
  /** "tester" | "assistant" */
  role: string;
  content: string;
  /** Always "test-chat". */
  channel: string;
  /** Provider model for assistant rows; "" for tester rows. */
  model: string;
  createdAt: Date;
}

export interface Ticket {

  [key: string]: unknown;  id: string;
  businessId: string;
  conversationId: string | null;
  departmentId: string | null;
  assignedToId: string | null;
  title: string;
  description: string;
  status: string;
  priority: string;
  resolution: string;
  createdAt: Date;
  updatedAt: Date;
  conversation: Conversation | null;
  department: Department | null;
  assignedTo: TeamMember | null;
}

export interface Tag {

  [key: string]: unknown;  id: string;
  businessId: string;
  name: string;
  color: string;
  createdAt: Date;
  conversations: ConversationTag[];
}

export interface ConversationTag {

  [key: string]: unknown;  id: string;
  businessId: string;
  conversationId: string;
  tagId: string;
  conversation: Conversation;
  tag: Tag;
}

export interface CallLog {

  [key: string]: unknown;  id: string;
  businessId: string;
  callSid: string;
  from: string;
  to: string;
  duration: number;
  status: string;
  recording: string | null;
  summary: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Channel {

  [key: string]: unknown;  id: string;
  businessId: string;
  type: string;
  isActive: boolean;
  config: JsonValue;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Schedule {

  [key: string]: unknown;  id: string;
  businessId: string;
  teamMemberId: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

export interface Webhook {

  [key: string]: unknown;  id: string;
  businessId: string;
  name: string;
  description: string;
  url: string;
  method: string;
  headers: JsonValue;
  isActive: boolean;
  triggerOn: string;
  createdAt: Date;
  updatedAt: Date;
  deliveries: WebhookDelivery[];
}

export interface WebhookDelivery {

  [key: string]: unknown;  id: string;
  businessId: string;
  webhookId: string;
  event: string;
  payload: JsonValue;
  status: string;
  statusCode: number | null;
  attempts: number;
  lastError: string | null;
  nextRetryAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  webhook: Webhook;
}

export interface ActivityLog {

  [key: string]: unknown;  id: string;
  businessId: string;
  action: string;
  entity: string;
  entityId: string | null;
  description: string;
  userId: string | null;
  userName: string;
  metadata: JsonValue;
  requestId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
}

export interface SLARule {

  [key: string]: unknown;  id: string;
  businessId: string;
  name: string;
  description: string;
  channel: string;
  priority: string;
  firstResponseMins: number;
  resolutionMins: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CannedResponse {

  [key: string]: unknown;  id: string;
  businessId: string;
  title: string;
  content: string;
  category: string;
  shortcut: string;
  isActive: boolean;
  usageCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface Customer {

  [key: string]: unknown;  id: string;
  businessId: string;
  name: string;
  email: string;
  phone: string;
  whatsapp: string;
  tags: string;
  isBlocked: boolean;
  metadata: JsonValue;
  firstContact: Date;
  lastContact: Date;
  createdAt: Date;
  updatedAt: Date;
  notes: CustomerNote[];
  conversations: Conversation[];
  _count: { [key: string]: number };
}

export interface CustomerNote {

  [key: string]: unknown;  id: string;
  businessId: string;
  customerId: string;
  content: string;
  authorName: string;
  createdAt: Date;
  customer: Customer;
}

export interface AutomationRule {

  [key: string]: unknown;  id: string;
  businessId: string;
  name: string;
  description: string;
  type: string;
  isActive: boolean;
  conditions: JsonValue;
  actions: JsonValue;
  priority: number;
  triggerCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface BusinessHours {

  [key: string]: unknown;  id: string;
  businessId: string;
  enabled: boolean;
  timezone: string;
  monday: string;
  tuesday: string;
  wednesday: string;
  thursday: string;
  friday: string;
  saturday: string;
  sunday: string;
  offlineMessage: string;
}

export interface ApiKey {

  [key: string]: unknown;  id: string;
  businessId: string;
  name: string;
  keyHash: string;
  keySuffix: string;
  scopes: string[];
  isActive: boolean;
  lastUsed: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface InternalNote {

  [key: string]: unknown;  id: string;
  businessId: string;
  conversationId: string;
  content: string;
  authorName: string;
  createdAt: Date;
  conversation: Conversation;
}

export interface Campaign {

  [key: string]: unknown;  id: string;
  businessId: string;
  name: string;
  description: string;
  channel: string;
  message: string;
  subject: string;
  segments: JsonValue;
  status: string;
  scheduledAt: Date | null;
  sentCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface Flow {

  [key: string]: unknown;  id: string;
  businessId: string;
  name: string;
  description: string;
  startNodeId: string;
  nodes: JsonValue;
  isActive: boolean;
  triggerCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface FollowUp {

  [key: string]: unknown;  id: string;
  businessId: string;
  conversationId: string;
  message: string;
  dueAt: Date;
  status: string;
  /**
   * Behaviour package (2026-10-21): what created this follow-up —
   * "order_checkin" (engine, when an order was taken) or
   * "dropped_revival" (follow-up processor, quiet conversation),
   * "order_rating_request" (Leg I: queued from setOrderStatus when
   * an agent-taken order is confirmed) or "order_review_request"
   * (Leg I: queued by the delivered-order scan, due 24h after
   * delivery is first observed).
   * Absent/null = a customer-requested reminder (schedule_followup tool)
   * or a pre-package record.
   */
  kind?: string | null;
  createdAt: Date;
  updatedAt: Date;
  conversation: Conversation;
}

/**
 * Behaviour package (2026-10-21): one recorded review ask. Written by
 * the chat engine at the moment it appends the polite review request to
 * a reply, and read back to enforce the per-customer cap (at most one
 * ask per REVIEW_ASK_MIN_INTERVAL_DAYS across ALL of the customer's
 * conversations with this business). Tenant-scoped like every other
 * customer-facing record — one business's asks never affect another's.
 */
export interface ReviewAsk {

  [key: string]: unknown;  id: string;
  businessId: string;
  /** `cust:<customerId>` or `contact:<normalised contact>` — see
   *  customerKeyFor() in src/lib/ai/behaviour.ts. */
  customerKey: string;
  conversationId: string;
  /** "order_completed" | "positive_closing" | "high_satisfaction" */
  trigger: string;
  askedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface SocialAccount {

  [key: string]: unknown;  id: string;
  businessId: string;
  platform: string;
  label: string;
  accountRef: string;
  tokenEnc: string;
  tokenIv: string;
  isActive: boolean;
  /**
   * Phase 5 (user decision 6): comment auto-reply switch. true = the AI may
   * reply to comments automatically; false (default) = the AI only DRAFTS
   * replies for the business to approve in the inbox. Never auto-post
   * without this setting.
   */
  autoReply: boolean;
  lastSyncAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ScheduledPost {

  [key: string]: unknown;  id: string;
  businessId: string;
  platform: string;
  postType: string;
  textContent: string;
  topic: string;
  imagePrompt: string;
  imageUrl: string;
  scheduledAt: Date;
  status: string;
  resultRef: string;
  error: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface SocialInteraction {

  [key: string]: unknown;  id: string;
  businessId: string;
  platform: string;
  kind: string;
  externalId: string;
  parentRef: string;
  customerRef: string;
  content: string;
  likes: number;
  replied: boolean;
  repliedAt: Date | null;
  replyRef: string;
  /**
   * Phase 5 (user decision 6): the AI-drafted reply for a comment, stored
   * for the business to approve in the inbox. Set whether or not the
   * account has autoReply on (when autoReply is on the draft was also sent).
   */
  draftReply?: string | null;
  /** Phase 5: id of the socialAccount that produced this interaction. */
  socialAccountId?: string | null;
  /**
   * Leg C: author + text stored separately (new rows only). Legacy rows
   * carry only `content` ("<author>: <text>"); the unified-inbox normaliser
   * prefers these fields and falls back to parsing `content`. Optional so
   * legacy rows need no migration (same collection, same tenant scoping).
   */
  authorName?: string | null;
  commentText?: string | null;
  createdAt: Date;
}

export interface AudienceProfile {

  [key: string]: unknown;  id: string;
  businessId: string;
  platform: string;
  data: JsonValue;
  updatedAt: Date;
}

export interface AgentCommand {

  [key: string]: unknown;  id: string;
  businessId: string;
  command: string;
  status: string;
  result: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProductCategory {

  [key: string]: unknown;  id: string;
  businessId: string;
  name: string;
  description: string;
  createdAt: Date;
  updatedAt: Date;
  products: Product[];
}

export interface Product {

  [key: string]: unknown;  id: string;
  businessId: string;
  categoryId: string | null;
  name: string;
  description: string;
  price: number | null;
  currency: string;
  imageUrl: string;
  tags: string;
  isAvailable: boolean;
  metadata: JsonValue;
  createdAt: Date;
  updatedAt: Date;
  category: ProductCategory | null;
}

export interface StockLevel {

  [key: string]: unknown;  id: string;
  businessId: string;
  productId: string;
  /** "" = the product itself; otherwise an opaque variant key. */
  variantKey: string;
  /** Whole units on hand; never negative. */
  quantityOnHand: number;
  /** Null = no threshold set = never low. */
  lowStockThreshold: number | null;
  /** Id of the most recent stockMovements entry applied, or null. */
  lastMovementId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface StockLedgerEntry {

  [key: string]: unknown;  id: string;
  businessId: string;
  productId: string;
  variantKey: string;
  type: "sales_out" | "purchase_in" | "return_in" | "transfer" | "adjustment";
  direction: "in" | "out";
  quantity: number;
  previousStock: number;
  newStock: number;
  /** Selling-value or supplied-cost impact; null amount = unknown (see ledger.ts). */
  valueImpact: JsonValue;
  referenceType: "order" | "return" | "adjustment" | "transfer" | null;
  referenceId: string | null;
  updatedBy: string;
  reason: string | null;
  reversesMovementId: string | null;
  transferGroupId: string | null;
  createdAt: Date;
}

export interface Order {

  [key: string]: unknown;  id: string;
  businessId: string;
  conversationId: string | null;
  customerId: string | null;
  /** Line items: [{ productId?, name, qty, price? }]. */
  items: JsonValue;
  /** Business-defined custom fields: { key: value }. */
  customFields: JsonValue;
  /** Short human summary for dashboard lists. */
  summary: string;
  status: string; // 'pending' | 'confirmed' | 'cancelled'
  total: number | null;
  /**
   * LEG E field spec (orders dashboard). ALL OPTIONAL, NO WRITER in
   * this leg — these fields are read only when present:
   *  - channel: the order's recorded channel ("messenger", "instagram",
   *    "whatsapp", "shopify", "woocommerce", "widget", ...). At HEAD no
   *    writer stamps this; the dashboard resolves channel from the
   *    linked conversation instead (see order-dashboard.ts). A future
   *    store-integration writer may stamp it directly.
   *  - currency: recorded currency code for the order's total (e.g.
   *    "BDT"). At HEAD no order records a currency; sales are grouped
   *    by this value when present and never converted.
   *  - deliveryCharge: recorded delivery charge for this order (see the
   *    Presswayy Leg H coupon writer, which stamps it on the coupon
   *    path). No tenant delivery-charge configuration exists at HEAD.
   *  - paymentMethod: recorded payment method; exactly "cod" means
   *    cash on delivery. Absence means "not recorded", never "COD".
   *  - priceBreakdown: recorded breakdown lines (Leg H coupon path).
   */
  channel?: string | null;
  currency?: string | null;
  deliveryCharge?: number | null;
  paymentMethod?: string | null;
  priceBreakdown?: JsonValue;
  /** Leg I: star rating recorded from the customer's own chat reply
   *  (1–5), or null when unrated. Written ONLY by the deterministic
   *  rating capture — never by the model, never a review text. */
  rating?: number | null;
  /** Leg I: when the rating was recorded. */
  ratingAt?: Date | null;
  /** Courier bridge link (owner directive 2026-10-21), written
      server-side by src/lib/courier-bridge.ts when the order is
      confirmed/cancelled. Shape: CourierBookingLink —
      { state: 'booked' | 'needs_info' | 'cancelled' |
        'cancel_requested' | 'failed' | 'owner_notified', courierOrderId?,
        missing?, opsStatus?, bookedAt?, updatedAt, error?, reason?,
        ownerNotification? }. Absent = the bridge
      has not processed this order (not confirmed, or delivery disabled
      for the business). */
  courierBooking?: JsonValue;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Leg A (booking): a booking REQUEST record — a separate record type from
 * Order, stored in its own `bookings` collection (see firestore.ts).
 * It is never an order with a flag. Statuses are the booking state
 * machine (see booking-state.ts); `confirmed` is the lock point owned
 * by Leg B. `availabilityChecked` is always false in this batch: no
 * calendar exists, so no slot is ever recorded as free, busy, or booked.
 */
export interface Booking {

  [key: string]: unknown;  id: string;
  businessId: string;
  conversationId: string | null;
  customerId: string | null;
  /** What is being booked, e.g. "Haircut", "Studio session". */
  service: string;
  /** The customer's requested slot, verbatim — a REQUEST, never a booking. */
  requestedSlot: string;
  /** Date as STATED by the customer (YYYY-MM-DD shape only, never verified). */
  requestedDate: string | null;
  /** Time as STATED by the customer (HH:MM shape only, never verified). */
  requestedTime: string | null;
  /** Where the booking takes place, if given. */
  place: string | null;
  /** What the customer should bring, if the business stated it. */
  whatToBring: string | null;
  /** The business's own questions + the customer's answers. */
  questions: JsonValue;
  customerName: string | null;
  customerPhone: string | null;
  /** Advance/deposit ONLY when explicitly stated; null = not stated. */
  advanceAmount: number | null;
  /** Currency code ONLY when explicitly stated alongside the amount. */
  advanceCurrency: string | null;
  /** Free-text reminder preferences. No reminder sender exists in this leg. */
  reminders: JsonValue;
  /** Human-proposed alternative slot (only when status is/was `proposed`). */
  proposedSlot: string | null;
  proposedDate: string | null;
  proposedTime: string | null;
  /** Human note / return reason / cancellation reason. */
  humanNote: string | null;
  /** 'requested' | 'proposed' | 'confirmed' | 'declined' |
      'cancelled_by_customer' | 'cancelled_by_business' */
  status: string;
  /** Doc-level state history (NOT the Leg B audit trail). */
  statusHistory: JsonValue;
  /** Always false in this leg: no calendar, no availability check. */
  availabilityChecked: boolean;
  /** Short human summary for dashboard lists. */
  summary: string;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Harvey Lead Engine (outbound) — tenant-scoped collections.
// The Harvey sidecar writes these; the dashboard reads them; humans approve
// drafts. See src/lib/lead-engine.ts for the architecture contract.
// ---------------------------------------------------------------------------

export interface LeadScan {
  [key: string]: unknown;
  id: string;
  businessId: string;
  /** Human label for the scan, e.g. "Dhaka restaurants — Jan 2027". */
  name: string;
  /** ICP snapshot used for this scan. */
  icp: JsonValue;
  status: string; // 'draft' | 'requested' | 'running' | 'completed' | 'failed'
  requestedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  stats: JsonValue; // { discovered, profiled, scored }
  error: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Lead {
  [key: string]: unknown;
  id: string;
  businessId: string;
  scanId: string | null;
  /** Business (Harvey Company model). */
  name: string;
  domain: string;
  website: string;
  description: string;
  industry: string;
  companySize: string;
  location: string;
  phone: string;
  /** Contact (Harvey Prospect model, flattened). */
  contactName: string;
  contactTitle: string;
  contactEmail: string;
  /** 'verified' | 'risky' | 'guess' | 'invalid' — only 'verified' may be sent to. */
  contactEmailStatus: string;
  /** 0–100 ICP score from the scout pass. */
  icpScore: number;
  /** Buying signals: [{ type, detail, foundAt }]. */
  signals: JsonValue;
  techStack: JsonValue;
  source: string;
  sourceUrl: string;
  /** Provider-stable dedup key (e.g. "osm:node/123"). */
  externalId: string;
  personalizationNotes: string;
  status: string; // 'new' | 'contacted' | 'replied' | 'meeting' | 'closed' | 'lost'
  createdAt: Date;
  updatedAt: Date;
}

/**
 * InboundLead — INBOUND pipeline only (customers of this business who
 * showed buying/booking interest). Deliberately NOT the outbound Harvey
 * Lead model above: different collection (`inboundLeads`), different
 * stages, different writer (the sales agent / the team — never the
 * outbound sidecar). A lead is interest, never an order or confirmation.
 */
export interface InboundLead {
  [key: string]: unknown;
  id: string;
  businessId: string;
  /** Customer name as given (may be empty when only a phone is known). */
  name: string;
  /** Phone as given. Matching uses a digits-only key (see inbound-leads.ts). */
  phone: string;
  /** What the customer wants, in their words (product / service / booking). */
  interest: string;
  /** Team/agent notes, appended as dated lines (history kept). */
  note: string;
  /** Follow-up date, YYYY-MM-DD, or null. UTC day (no tenant timezone). */
  followUpDate: string | null;
  /** 'agent' (create_inbound_lead tool) | 'manual' (dashboard form). */
  source: string;
  /** Channel the interest arrived on (widget, whatsapp, ...), if known. */
  channel: string;
  conversationId: string | null;
  customerId: string | null;
  /** 'new' | 'contacted' | 'interested' | 'quoted' | 'won' | 'lost'. */
  stage: string;
  /** Teammate working this lead (teamMember id), or null. */
  assignedToId: string | null;
  /** Denormalised teammate name at assign time (display only). */
  assignedToName: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface LeadDraft {
  [key: string]: unknown;
  id: string;
  businessId: string;
  leadId: string;
  scanId: string | null;
  channel: string; // 'email'
  step: number;
  delayDays: number;
  toEmail: string;
  subject: string;
  body: string;
  /** Result of preSendGateCheck() at draft/approve time. */
  gateCheck: JsonValue; // { ok, reasons[] }
  status: string; // 'draft' | 'approved' | 'rejected' | 'sent' | 'failed'
  approvedBy: string;
  approvedAt: Date | null;
  sentAt: Date | null;
  sendError: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface LeadSettings {
  [key: string]: unknown;
  id: string;
  businessId: string;
  /** ICP the tenant confirmed for discovery. */
  icp: JsonValue;
  /** Mailbox used by the sidecar sender. */
  mailboxProvider: string; // 'gmail' | 'microsoft' | 'smtp' | 'none'
  mailboxConnected: boolean;
  mailboxUser: string;
  /** Secret — same storage pattern as settings.smtpPass (see note there). */
  mailboxSecret: string;
  /** AI backend subscription the sidecar runs on. */
  aiBackend: string; // 'claude' | 'codex' | 'none'
  aiBackendConnected: boolean;
  maxDailySends: number;
  requireApproval: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentRuleVersion {
  [key: string]: unknown;
  id: string;
  businessId: string;
  /** 1-based per business, monotonic; never reused. */
  versionNumber: number;
  /** 'DRAFT' | 'LIVE' | 'SUPERSEDED' | 'DISCARDED' */
  status: string;
  /** Owner's verbatim plain-language rules. */
  plainText: string;
  /** Owner's own words on what changed ("" = none given). */
  changeNote: string;
  /** Auth userId of the actor ("api-key:<id>" for key auth). */
  createdBy: string;
  createdByName: string;
  createdAt: Date;
  updatedAt: Date;
  publishedAt: Date | null;
  publishedBy: string | null;
  /** 'draft' | 'rollback' */
  origin: string;
  /** versionNumber restored by a rollback row; null otherwise. */
  restoresVersion: number | null;
}

/**
 * Done-for-you setup application. Submitted by the customer from the
 * dashboard after signup; the Ride Bangla team contacts them and connects
 * everything (channels, integrations) — the customer never touches keys.
 */
export interface SetupApplication {

  [key: string]: unknown;  id: string;
  businessId: string;
  businessName: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
  /** Channel ids the customer wants connected (e.g. "facebook", "whatsapp", "youtube"). */
  channelsWanted: string[];
  /** "whatsapp" | "phone" | "email" */
  preferredContact: string;
  notes: string;
  /** "pending" | "contacted" | "in_progress" | "completed" | "cancelled" */
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Website-creation application (owner directive 2026-10-21). A business
 * WITHOUT a website applies from Settings > Websites; the Ride Bangla IT
 * Team builds the site as a SEPARATE service track ("আলাদা হিসাব") — this
 * record is deliberately unrelated to subscription/billing. The team
 * works the queue from the platform admin (Super Admin); the business
 * sees only its own request and its status.
 */
export interface WebsiteCreationRequest {

  [key: string]: unknown;  id: string;
  businessId: string;
  businessName: string;
  contactName: string;
  /** Phone / WhatsApp number the IT team can reach them on. */
  contactPhone: string;
  /** "business" | "ecommerce" | "portfolio" | "restaurant" | "other" */
  siteType: string;
  notes: string;
  /** "new" | "contacted" | "in_progress" | "delivered" | "closed" */
  status: string;
  /** Who/when audit of every status change (append-only). */
  statusHistory: Array<{
    status: string;
    by: string;
    at: string;
  }>;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Public site review. Written by a logged-in customer from the marketing
 * landing page of one of our public sites (AI agent site, Tools, Studio).
 * Only `status: "published"` reviews are ever returned by the public API —
 * nothing seeded, nothing fake.
 */
export interface SiteReview {
  [key: string]: unknown;
  id: string;
  /** "tools" | "ai" | "studio" — which public site this review is about. */
  site: string;
  /** Firebase uid of the reviewer (one review per uid per site per 24h). */
  uid: string;
  /** Display name chosen by the reviewer (1–80 chars). */
  name: string;
  photoURL: string;
  /** True only when the review was submitted with a Firebase ID
   * token whose sign-in provider is Google (google.com), as
   * captured at submission. Anything else — and records stored
   * before this field existed — reads back as false. */
  verifiedGoogle: boolean;
  /** 1–5. */
  rating: number;
  /** Review text (1–1000 chars). */
  text: string;
  /** "published" — reserved for future moderation states. */
  status: string;
  createdAt: Date;
}

/**
 * Agent Desk pause row (LEG D, owner controls). Separate from Leg G's
 * AgentRuleVersion rows, which are never edited by pause/resume:
 * a pause pins a LIVE version (versionId) and carries NO text copy,
 * so resume restores the LIVE row's text byte-identically.
 */
export interface AgentRulePause {
  [key: string]: unknown;
  id: string;
  businessId: string;
  versionId: string;
  versionNumber: number;
  /** 'active' | 'released' — released rows are history, never deleted. */
  status: string;
  pausedAt: Date;
  pausedBy: string;
  pausedByName: string;
  reason: string;
  releasedAt: Date | null;
  releasedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Owner-editable order-status message template (LEG D). One row per
 * business per push key ('confirmed:rider' | 'confirmed:own_delivery'
 * | 'confirmed:unrouted' | 'cancelled'). Paused rows send nothing.
 */
export interface OrderStatusTemplate {
  [key: string]: unknown;
  id: string;
  businessId: string;
  key: string;
  /** Owner's verbatim text; the only placeholder is {orderRef}. */
  text: string;
  /** 'active' | 'paused' */
  status: string;
  createdBy: string;
  createdByName: string;
  createdAt: Date;
  updatedAt: Date;
  pausedAt: Date | null;
  pausedBy: string | null;
}

/**
 * Owner-control audit entry (LEG D, INTERIM — see
 * src/lib/owner-controls/owner-control-audit.ts header for the Leg E
 * reconciliation flag: exactly one trail is the system of record
 * at go-live; this collection is deleted or adopted by Leg E).
 */
export interface OwnerControlAuditEntry {
  [key: string]: unknown;
  id: string;
  businessId: string;
  auditVersion: number;
  objectType: string;
  objectId: string;
  objectKey: string;
  action: string;
  actorId: string;
  actorName: string;
  actorType: string;
  occurredAt: string;
  beforeSummary: string;
  afterSummary: string;
  detail: string;
  blockedReason: string | null;
  createdAt: Date;
}
