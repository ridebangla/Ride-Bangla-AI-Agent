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
  /** Phase 2: auto landing page (hosted at /p/[slug]). */
  tagline?: string;
  brandColor?: string;
  logoUrl?: string;
  landingPublished?: boolean;
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

