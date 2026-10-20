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

  // Step 2: Normalized phone match (for phone/whatsapp channels)
  if (channel === "phone" || channel === "whatsapp") {
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
  const normalizedContact =
    channel === "phone" || channel === "whatsapp"
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
      return prisma.customer.findFirst({
        where: { phone: normalizePhone(contact) },
      });
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
      // Phone/WhatsApp contacts are stored ONLY in normalized form (M-1):
      // verbatim storage of "+880 1711-111111" / "…@c.us" values is what
      // fragmented one person into duplicate Customer records.
      ...(channel === "whatsapp" ? { whatsapp: normalizePhone(contact) } : {}),
      ...(channel === "phone" ? { phone: normalizePhone(contact) } : {}),
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
    select: { name: true, email: true, phone: true, whatsapp: true },
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
  if (channel === "phone") {
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

  // Update name if current is "Unknown" and we have a better one
  if (customer.name === "Unknown" && name && name !== "Unknown") {
    update.name = name;
  }

  await prisma.customer.update({
    where: { id: customerId },
    data: update,
  });
}
