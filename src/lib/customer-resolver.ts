import { prisma, withBusinessId } from "@/lib/prisma";
import { logger } from "@/lib/logger";

/**
 * Normalize a phone number for consistent matching AND storage.
 * Strips WhatsApp suffixes (@c.us, @s.whatsapp.net) and non-digit chars (except leading +).
 *
 * Bangladeshi mobile numbers are canonicalized to "+880" + the 10-digit
 * national number, so every written form of the same subscriber —
 * "+880 1711-111111", "+8801711111111", "8801711111111",
 * "8801711111111@c.us", "01711111111", "1711111111" — collapses to ONE
 * value. Without this, storing contacts verbatim fragments one person
 * into multiple Customer records whenever channels report different
 * formats (defect M-1). Non-BD numbers keep the legacy normalization.
 */
export function normalizePhone(input: string): string {
  const cleaned = input.replace(/@(c\.us|s\.whatsapp\.net)$/, "");
  const legacy = cleaned.replace(/[^\d+]/g, "").replace(/(?!^)\+/g, "");
  const digits = legacy.replace(/\D/g, "");
  let national: string | null = null;
  if (/^8801\d{9}$/.test(digits)) national = digits.slice(3);
  else if (/^01\d{9}$/.test(digits)) national = digits.slice(1);
  else if (/^1\d{9}$/.test(digits)) national = digits;
  if (national) return `+880${national}`;
  return legacy;
}

/** Channels whose contact IS a phone number (Twilio SMS `from` is a
 * phone number, exactly like `phone`/`whatsapp`). SMS was previously
 * excluded here, so an SMS number in any non-canonical form
 * ("+880 1711-111111", "01711111111") never matched the canonical
 * phone/whatsapp field and silently created a second Customer for
 * the same person (Team C fix 2026-11-03). */
const PHONE_CHANNELS = new Set(["phone", "whatsapp", "sms"]);

/**
 * Channels whose contact is an opaque platform identifier stored in its
 * OWN scalar Customer field (Team H, 2026-11-03). Before this, these
 * channels fell through findByChannelField (default: null) and
 * createCustomer dropped the contact entirely, so the same telegram
 * user / Meta PSID / website visitor got a NEW Customer row on every
 * message — conversation reuse hid it, but anything keyed by
 * customerId fragmented. Field names match the existing
 * email/phone/whatsapp convention (one scalar field per contact);
 * `widget` maps to `widgetVisitorId` because a browser visitor token
 * is not a contact address. A metadata.channelIds design was rejected:
 * the query engine has no array-`has`/nested-path operator, so it
 * could only be resolved by scanning the tenant's whole customer set.
 */
const CHANNEL_ID_FIELD: Record<string, string> = {
  telegram: "telegram",
  messenger: "messenger",
  instagram: "instagram",
  widget: "widgetVisitorId",
};

/** Canonical form of a channel-identifier contact for storage + lookup.
 * Telegram usernames are case-insensitive, so they are lowercased (a
 * numeric chat id is unaffected); every other identifier is matched
 * exactly as supplied — never normalized, guessed, or merged across
 * channels. */
export function normalizeChannelContact(channel: string, contact: string): string {
  const trimmed = contact.trim();
  return channel === "telegram" ? trimmed.toLowerCase() : trimmed;
}

/**
 * Lookup-only identity resolution (Team H, 2026-11-03): returns the id
 * of the Customer that already carries this channel identifier, or
 * null. It NEVER creates or updates a row — callers that must not
 * invent an identity from weak evidence (e.g. social-comment authors,
 * who have never chatted) use this instead of resolveCustomer.
 * Per-tenant scoping holds via the tenant-scoped prisma proxy, exactly
 * as for resolveCustomer: a lookup can only return this tenant's row.
 */
export async function findCustomerByChannelContact(
  channel: string,
  contact: string
): Promise<string | null> {
  const field = CHANNEL_ID_FIELD[channel];
  if (!field || !contact) return null;
  const match = await findByChannelField(channel, contact);
  return match ? match.id : null;
}

/**
 * Resolve a customer identity across channels.
 * Finds or creates a Customer record based on contact info.
 * Returns the customerId for linking to conversations.
 */
export async function resolveCustomer(
  channel: string,
  customerContact: string,
  customerName: string
): Promise<string> {
  if (!customerContact) {
    return createCustomer(customerName, channel, customerContact);
  }

  // Step 1: Direct field match by channel
  const directMatch = await findByChannelField(channel, customerContact);
  if (directMatch) {
    await updateExistingCustomer(directMatch.id, channel, customerContact, customerName);
    return directMatch.id;
  }

  // Step 2: Normalized phone match (for phone/whatsapp/sms channels)
  if (PHONE_CHANNELS.has(channel)) {
    const normalized = normalizePhone(customerContact);
    if (normalized.length >= 7) {
      const phoneMatch = await prisma.customer.findFirst({
        where: {
          OR: [
            { phone: { contains: normalized } },
            { whatsapp: { contains: normalized } },
          ],
        },
      });
      if (phoneMatch) {
        await updateExistingCustomer(phoneMatch.id, channel, customerContact, customerName);
        return phoneMatch.id;
      }
      // Legacy rows written before write-normalization may hold the same
      // number without the leading "+" (e.g. "8801711111111@c.us"): retry
      // with the bare-digits form so those rows still resolve to one person.
      const digits = normalized.replace(/\D/g, "");
      if (digits.length >= 10 && digits !== normalized) {
        const legacyMatch = await prisma.customer.findFirst({
          where: {
            OR: [
              { phone: { contains: digits } },
              { whatsapp: { contains: digits } },
            ],
          },
        });
        if (legacyMatch) {
          await updateExistingCustomer(legacyMatch.id, channel, customerContact, customerName);
          return legacyMatch.id;
        }
      }
    }
  }

  // Step 3: Cross-field fallback (search all contact fields)
  const normalizedContact = PHONE_CHANNELS.has(channel)
    ? normalizePhone(customerContact)
    : customerContact;
  const crossMatch = await prisma.customer.findFirst({
    where: {
      OR: [
        { email: { equals: customerContact, mode: "insensitive" } },
        { phone: normalizedContact },
        { whatsapp: normalizedContact },
      ],
    },
  });
  if (crossMatch) {
    await updateExistingCustomer(crossMatch.id, channel, customerContact, customerName);
    return crossMatch.id;
  }

  // Step 4: Auto-create new customer
  return createCustomer(customerName, channel, customerContact);
}

async function findByChannelField(channel: string, contact: string) {
  switch (channel) {
    case "email":
      return prisma.customer.findFirst({
        where: { email: { equals: contact, mode: "insensitive" } },
      });
    case "whatsapp":
      // Stored values are normalized on write — match on the same form.
      return prisma.customer.findFirst({
        where: { whatsapp: normalizePhone(contact) },
      });
    case "phone":
    case "sms":
      // SMS numbers live in the phone field (there is no sms field on
      // the Customer record), so an SMS lookup is a phone lookup.
      return prisma.customer.findFirst({
        where: { phone: normalizePhone(contact) },
      });
    case "telegram":
    case "messenger":
    case "instagram":
    case "widget": {
      // Channel-identifier channels: stored values are normalized on
      // write (see normalizeChannelContact) — match on the same form.
      const field = CHANNEL_ID_FIELD[channel];
      return prisma.customer.findFirst({
        where: { [field]: normalizeChannelContact(channel, contact) },
      });
    }
    default:
      return null;
  }
}

async function createCustomer(
  name: string,
  channel: string,
  contact: string
): Promise<string> {
  const customer = await prisma.customer.create({
    data: withBusinessId({
      name: name || "Unknown",
      firstContact: new Date(),
      lastContact: new Date(),
      ...(channel === "email" ? { email: contact } : {}),
      // Phone/WhatsApp/SMS contacts are stored ONLY in normalized form
      // (M-1): verbatim storage of "+880 1711-111111" / "…@c.us"
      // values is what fragmented one person into duplicate Customer
      // records. SMS has no own field, so it stores into `phone`.
      ...(channel === "whatsapp" ? { whatsapp: normalizePhone(contact) } : {}),
      ...(channel === "phone" || channel === "sms"
        ? { phone: normalizePhone(contact) }
        : {}),
      // Channel-identifier contacts are stored ONLY in normalized form
      // too (telegram lowercased): before this they were dropped here,
      // which is what created a new Customer row per message.
      ...(CHANNEL_ID_FIELD[channel]
        ? { [CHANNEL_ID_FIELD[channel]]: normalizeChannelContact(channel, contact) }
        : {}),
    }),
  });

  logger.info("Auto-created customer from channel contact", {
    customerId: customer.id,
    channel,
  });

  return customer.id;
}

async function updateExistingCustomer(
  customerId: string,
  channel: string,
  contact: string,
  name: string
): Promise<void> {
  const update: Record<string, unknown> = {
    lastContact: new Date(),
  };

  // Backfill empty channel fields
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: {
      name: true,
      email: true,
      phone: true,
      whatsapp: true,
      telegram: true,
      messenger: true,
      instagram: true,
      widgetVisitorId: true,
    },
  });

  if (!customer) return;

  if (channel === "email" && !customer.email) update.email = contact;
  if (channel === "whatsapp") {
    const canonical = normalizePhone(contact);
    if (!customer.whatsapp) {
      update.whatsapp = canonical;
    } else if (
      customer.whatsapp !== canonical &&
      normalizePhone(customer.whatsapp) === canonical
    ) {
      // Self-heal rows written before write-normalization (e.g. a stored
      // "8801711111111@c.us"): same number, rewrite in canonical form.
      update.whatsapp = canonical;
    }
  }
  if (channel === "phone" || channel === "sms") {
    const canonical = normalizePhone(contact);
    if (!customer.phone) {
      update.phone = canonical;
    } else if (
      customer.phone !== canonical &&
      normalizePhone(customer.phone) === canonical
    ) {
      update.phone = canonical;
    }
  }
  // Backfill an empty channel-identifier field. A DIFFERENT stored
  // identifier is never overwritten: that would merge two platform
  // identities onto one row on a guessed link. The only rewrite is the
  // telegram case-only self-heal (same handle, pre-lowercasing row).
  const channelField = CHANNEL_ID_FIELD[channel];
  if (channelField) {
    const canonical = normalizeChannelContact(channel, contact);
    const stored = (customer as Record<string, unknown>)[channelField];
    if (typeof stored !== "string" || !stored) {
      update[channelField] = canonical;
    } else if (
      channel === "telegram" &&
      stored !== canonical &&
      stored.toLowerCase() === canonical
    ) {
      update[channelField] = canonical;
    }
  }

  // Update name if current is "Unknown" and we have a better one
  if (customer.name === "Unknown" && name && name !== "Unknown") {
    update.name = name;
  }

  await prisma.customer.update({
    where: { id: customerId },
    data: update,
  });
}
