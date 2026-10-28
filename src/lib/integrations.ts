/**
 * integrations.ts — Integrations Hub status derivation (STAGED, Leg F).
 *
 * DISPLAY ONLY. This module wires no new connector, stores no credential,
 * and never claims a connection it cannot evidence. It turns RECORDED
 * per-tenant state (already collected by the route) into one status per
 * integration, using exactly three states:
 *
 * - "connected"     — a tenant-scoped record evidences the connection.
 * - "not_connected" — the tenant-scoped record evidences absence
 *                     (no record, a disconnected record, or a required
 *                     tenant field that is empty), AND absence genuinely
 *                     means "not connected" for that integration.
 * - "unknown"       — absence of a record does NOT genuinely mean
 *                     disconnected (platform-level configuration with no
 *                     per-tenant record, or a key issued but an install
 *                     never verified). The hub shows this honestly and
 *                     the leg report flags each unknown as a follow-up
 *                     gap; it is never rendered as Connected.
 *
 * STATUS RULES (each rule cites the HEAD evidence in the leg report):
 *
 * Channel records (`prisma.channel`, tenant-scoped, status field):
 *   connected iff status === "connected" AND isActive === true. A record
 *   whose status is "connected" but whose switch is off is NOT shown as
 *   connected: the tenant switched it off. A missing record is
 *   "not_connected": the channel connect action itself refuses to
 *   connect without configuration, so nothing unrecorded can be live.
 *
 * Social accounts (`prisma.socialAccount`, tenant-scoped, encrypted
 * tokens never leave storage): Facebook / Messenger / Instagram are
 * connected iff an ACTIVE account row exists for that platform.
 * Messenger shares the Facebook Page account, so it follows Facebook.
 * The route selects only { platform, isActive } — no label, no ref,
 * no token material of any kind reaches this module or the page.
 *
 * WhatsApp Cloud and X: their send paths read PLATFORM environment
 * variables (WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID, X_* keys),
 * not a per-tenant record, and no per-tenant WhatsApp-Cloud or X
 * connection record exists. So: platform configured -> "unknown"
 * (the platform can serve the channel, but this tenant's connection
 * is not recorded anywhere); platform not configured -> "not_connected".
 * This deliberately does NOT copy the Channels overview grid, which
 * treats platform configuration as connected for every tenant.
 * (X social-account rows exist, but the X send path does not read
 * them, so they are not evidence of an X connection.)
 *
 * YouTube / LinkedIn: no connection code path exists at HEAD; the
 * Channels overview marks them team-managed. Always "not_connected",
 * action "Request setup" -> the done-for-you application page.
 *
 * Website widget: a siteKey is issued to every business at creation,
 * so key presence proves nothing about installation, and no install
 * verification exists. Key present -> "unknown"; key absent ->
 * "not_connected".
 *
 * Websites: connected iff at least one website row has status
 * "indexed". A merely "pending" website never counts as connected
 * (it has been submitted, not indexed). "failed" rows are counted
 * in the detail so a failed index is never hidden behind a bare
 * "not connected".
 *
 * Ride Bangla courier: connected iff a Partner ID is set AND the
 * courier-delivery switch is on (both are tenant fields on the
 * business record). Delivery itself still only happens inside a
 * served area — the detail says so on every courier row, because
 * the connection alone never promises a delivery.
 *
 * Outbound webhooks: connected iff at least one ACTIVE tenant webhook
 * row exists. Counts only; URLs, headers and delivery payloads are
 * never returned by the route and never enter this module.
 *
 * Stripe billing: connected iff a Stripe customer id is recorded on
 * the business (set on first checkout). The route reduces this to a
 * boolean; the id value itself is never returned.
 *
 * Stores (Shopify / WooCommerce): no store-connection code, record,
 * or OAuth surface exists at HEAD. Always "not_connected", and the
 * action is a flagged follow-up, not a button to a surface that
 * does not exist. (The staged bulk-import batch from the earlier
 * round is CSV/JSON intake only, is not in HEAD, and is not claimed
 * here as a live store connection.)
 *
 * No money figure appears anywhere in this
 * module. No demo or fixture value is a default: every input field
 * is required, and a missing input fails closed to "unknown" via
 * `deriveIntegrationStatuses` treating undefined as absent evidence
 * only where the rule says absence means not_connected (see above).
 * All user-facing detail strings below are PROPOSAL wording for
 * owner approval, not settled copy.
 */

export type IntegrationStatus = "connected" | "not_connected" | "unknown";

export type IntegrationGroup =
  | "channels"
  | "websites"
  | "stores"
  | "services";

export type IntegrationAction =
  | { kind: "link"; href: string; label: string }
  | { kind: "follow_up"; note: string };

export interface IntegrationItem {
  id: string;
  group: IntegrationGroup;
  /** PROPOSAL display name (owner approval required). */
  name: string;
  status: IntegrationStatus;
  /** PROPOSAL detail line (owner approval required). Counts only. */
  detail: string;
  action: IntegrationAction;
}

export interface ChannelRecordInput {
  status: string;
  isActive: boolean;
}

export interface HubEvidence {
  /** Tenant channel rows, keyed by CHANNEL_TYPES type. Missing = no row. */
  channels: Partial<Record<string, ChannelRecordInput>>;
  /** Active social-account platforms only (route pre-filters isActive). */
  activeSocialPlatforms: string[];
  /** Platform env: Meta WhatsApp Cloud keys present (route-computed). */
  whatsappCloudConfigured: boolean;
  /** Platform env: any X key material present (route-computed). */
  xConfigured: boolean;
  /** Business.siteKey non-empty. */
  hasSiteKey: boolean;
  /** Website rows by status (route counts; URLs never enter here). */
  websiteIndexedCount: number;
  websitePendingCount: number;
  websiteFailedCount: number;
  /** Business.partnerId non-empty. */
  partnerIdSet: boolean;
  /** Business.courierDeliveryEnabled === true. */
  courierDeliveryEnabled: boolean;
  /** Active tenant outbound webhook rows. */
  activeWebhookCount: number;
  /** Business.stripeCustomerId non-empty. */
  stripeCustomerIdSet: boolean;
}

/** Channel-record rule shared by whatsapp/email/phone/sms/telegram. */
export function deriveChannelStatus(
  record: ChannelRecordInput | null | undefined,
): IntegrationStatus {
  if (!record) return "not_connected";
  if (record.status === "connected" && record.isActive === true) {
    return "connected";
  }
  return "not_connected";
}

function socialConnected(
  platforms: string[],
  platform: string,
): IntegrationStatus {
  return platforms.includes(platform) ? "connected" : "not_connected";
}

/** Platform-configured but tenant-unrecorded -> unknown, never connected. */
function platformOnlyStatus(configured: boolean): IntegrationStatus {
  return configured ? "unknown" : "not_connected";
}

const link = (href: string, label: string): IntegrationAction => ({
  kind: "link",
  href,
  label,
});

export const INTEGRATION_IDS = [
  "website-widget",
  "facebook",
  "messenger",
  "instagram",
  "whatsapp-legacy",
  "whatsapp-cloud",
  "x",
  "youtube",
  "linkedin",
  "email",
  "phone",
  "sms",
  "telegram",
  "websites",
  "shopify",
  "woocommerce",
  "courier",
  "outbound-webhooks",
  "stripe-billing",
] as const;

export type IntegrationId = (typeof INTEGRATION_IDS)[number];

export function deriveIntegrationStatuses(
  evidence: HubEvidence,
): IntegrationItem[] {
  const ch = evidence.channels;
  const fb = socialConnected(evidence.activeSocialPlatforms, "facebook");
  const ig = socialConnected(evidence.activeSocialPlatforms, "instagram");

  const waLegacy = deriveChannelStatus(ch["whatsapp"]);
  const waCloud = platformOnlyStatus(evidence.whatsappCloudConfigured);
  const xStatus = platformOnlyStatus(evidence.xConfigured);

  const websiteTotal =
    evidence.websiteIndexedCount +
    evidence.websitePendingCount +
    evidence.websiteFailedCount;
  const websitesStatus: IntegrationStatus =
    evidence.websiteIndexedCount > 0 ? "connected" : "not_connected";
  const websitesDetail =
    evidence.websiteIndexedCount > 0
      ? `${evidence.websiteIndexedCount} website(s) indexed.`
      : websiteTotal === 0
        ? "No website added yet."
        : evidence.websitePendingCount > 0
          ? `${evidence.websitePendingCount} website(s) submitted, not indexed yet.`
          : `${evidence.websiteFailedCount} website(s) failed to index.`;

  const courierStatus: IntegrationStatus =
    evidence.partnerIdSet && evidence.courierDeliveryEnabled
      ? "connected"
      : "not_connected";
  const courierDetail = evidence.partnerIdSet
    ? evidence.courierDeliveryEnabled
      ? "Partner ID set and delivery switched on. Orders reach riders only inside a served area."
      : "Partner ID set, but delivery is switched off."
    : "No Partner ID set, so orders are notified to the shop owner instead of riders.";

  const items: IntegrationItem[] = [
    {
      id: "website-widget",
      group: "channels",
      name: "Website widget",
      status: evidence.hasSiteKey ? "unknown" : "not_connected",
      detail: evidence.hasSiteKey
        ? "Embed key issued. Installation on your website is not verified by the platform."
        : "No embed key found for this workspace.",
      action: link("/channels", "Manage"),
    },
    {
      id: "facebook",
      group: "channels",
      name: "Facebook",
      status: fb,
      detail:
        fb === "connected"
          ? "A Facebook Page account is connected."
          : "No Facebook Page account connected.",
      action: link(
        "/channels",
        fb === "connected" ? "Manage" : "Set up",
      ),
    },
    {
      id: "messenger",
      group: "channels",
      name: "Messenger",
      status: fb,
      detail:
        fb === "connected"
          ? "Messenger runs through your connected Facebook Page."
          : "No Facebook Page account connected, so Messenger is not connected.",
      action: link(
        "/channels",
        fb === "connected" ? "Manage" : "Set up",
      ),
    },
    {
      id: "instagram",
      group: "channels",
      name: "Instagram",
      status: ig,
      detail:
        ig === "connected"
          ? "An Instagram account is connected."
          : "No Instagram account connected.",
      action: link(
        "/channels",
        ig === "connected" ? "Manage" : "Set up",
      ),
    },
    {
      id: "whatsapp-legacy",
      group: "channels",
      name: "WhatsApp (QR / API)",
      status: waLegacy,
      detail:
        waLegacy === "connected"
          ? "WhatsApp channel is connected and switched on."
          : "WhatsApp channel is not connected.",
      action: link(
        "/channels",
        waLegacy === "connected" ? "Manage" : "Set up",
      ),
    },
    {
      id: "whatsapp-cloud",
      group: "channels",
      name: "WhatsApp Cloud (Meta official)",
      status: waCloud,
      detail:
        waCloud === "unknown"
          ? "The platform WhatsApp service is configured, but this workspace has no recorded WhatsApp Cloud connection. Verify before treating it as connected."
          : "The platform WhatsApp service is not configured.",
      action: link("/channels", "Manage"),
    },
    {
      id: "x",
      group: "channels",
      name: "X",
      status: xStatus,
      detail:
        xStatus === "unknown"
          ? "The platform X service is configured, but this workspace has no recorded X connection. Verify before treating it as connected."
          : "The platform X service is not configured.",
      action: link("/channels", "Manage"),
    },
    {
      id: "youtube",
      group: "channels",
      name: "YouTube",
      status: "not_connected",
      detail:
        "No self-serve YouTube connection exists. Our team connects it for you.",
      action: link("/setup-application", "Request setup"),
    },
    {
      id: "linkedin",
      group: "channels",
      name: "LinkedIn",
      status: "not_connected",
      detail:
        "No self-serve LinkedIn connection exists. Our team connects it for you.",
      action: link("/setup-application", "Request setup"),
    },
    {
      id: "email",
      group: "channels",
      name: "Email",
      status: deriveChannelStatus(ch["email"]),
      detail:
        deriveChannelStatus(ch["email"]) === "connected"
          ? "Email channel is connected and switched on."
          : "Email channel is not connected.",
      action: link(
        "/channels",
        deriveChannelStatus(ch["email"]) === "connected" ? "Manage" : "Set up",
      ),
    },
    {
      id: "phone",
      group: "channels",
      name: "Phone (voice)",
      status: deriveChannelStatus(ch["phone"]),
      detail:
        deriveChannelStatus(ch["phone"]) === "connected"
          ? "Phone channel is connected and switched on."
          : "Phone channel is not connected.",
      action: link(
        "/channels",
        deriveChannelStatus(ch["phone"]) === "connected" ? "Manage" : "Set up",
      ),
    },
    {
      id: "sms",
      group: "channels",
      name: "SMS",
      status: deriveChannelStatus(ch["sms"]),
      detail:
        deriveChannelStatus(ch["sms"]) === "connected"
          ? "SMS channel is connected and switched on."
          : "SMS channel is not connected. Twilio credentials live in Settings.",
      action: link(
        "/settings",
        deriveChannelStatus(ch["sms"]) === "connected" ? "Manage" : "Set up",
      ),
    },
    {
      id: "telegram",
      group: "channels",
      name: "Telegram",
      status: deriveChannelStatus(ch["telegram"]),
      detail:
        deriveChannelStatus(ch["telegram"]) === "connected"
          ? "Telegram channel is connected and switched on."
          : "Telegram channel is not connected.",
      action: {
        kind: "follow_up",
        note: "No setup screen exists yet for the Telegram bot token. Follow-up: build a Telegram setup surface before this can be set up from here.",
      },
    },
    {
      id: "websites",
      group: "websites",
      name: "Websites",
      status: websitesStatus,
      detail: websitesDetail,
      action: link(
        "/settings",
        websitesStatus === "connected" ? "Manage" : "Set up",
      ),
    },
    {
      id: "shopify",
      group: "stores",
      name: "Shopify",
      status: "not_connected",
      detail: "No live Shopify connection exists in this release.",
      action: {
        kind: "follow_up",
        note: "Follow-up: live store connection not built. Catalog import today is file upload only (staged separately, not live).",
      },
    },
    {
      id: "woocommerce",
      group: "stores",
      name: "WooCommerce",
      status: "not_connected",
      detail: "No live WooCommerce connection exists in this release.",
      action: {
        kind: "follow_up",
        note: "Follow-up: live store connection not built. Catalog import today is file upload only (staged separately, not live).",
      },
    },
    {
      id: "courier",
      group: "services",
      name: "Ride Bangla courier",
      status: courierStatus,
      detail: courierDetail,
      action: link(
        "/orders",
        courierStatus === "connected" ? "Manage" : "Set up",
      ),
    },
    {
      id: "outbound-webhooks",
      group: "services",
      name: "Outbound webhooks",
      status:
        evidence.activeWebhookCount > 0 ? "connected" : "not_connected",
      detail:
        evidence.activeWebhookCount > 0
          ? `${evidence.activeWebhookCount} active webhook(s) configured.`
          : "No active outbound webhook configured.",
      action: link(
        "/webhooks",
        evidence.activeWebhookCount > 0 ? "Manage" : "Set up",
      ),
    },
    {
      id: "stripe-billing",
      group: "services",
      name: "Stripe billing",
      status: evidence.stripeCustomerIdSet ? "connected" : "not_connected",
      detail: evidence.stripeCustomerIdSet
        ? "A Stripe billing customer is on file for this workspace."
        : "No Stripe billing customer on file for this workspace.",
      action: link(
        "/billing",
        evidence.stripeCustomerIdSet ? "Manage" : "Set up",
      ),
    },
  ];

  return items;
}
