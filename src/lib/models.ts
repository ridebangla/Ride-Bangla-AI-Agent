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
      (keyed by business id) — never from an email string. Usage is
      still metered (aiMessagesUsed) but never blocked or billed. */
  isInternalAccount?: boolean;
  internalGrantedBy?: string;
  internalGrantedAt?: Date | null;
  internalGrantReason?: string;
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
  createdAt: Date;
  updatedAt: Date;
  conversation: Conversation;
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
  /** 1–5. */
  rating: number;
  /** Review text (1–1000 chars). */
  text: string;
  /** "published" — reserved for future moderation states. */
  status: string;
  createdAt: Date;
}
