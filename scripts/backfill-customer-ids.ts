/**
 * Backfill Script: Link existing conversations to Customer records.
 *
 * Run: npx tsx scripts/backfill-customer-ids.ts
 *
 * This script finds conversations with customerId=null and attempts
 * to match them to existing Customer records by contact info (matched
 * within the same business — never across businesses).
 *
 * Requires FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and
 * FIREBASE_PRIVATE_KEY (see OPERATIONS.md §1).
 */

import { getUnscopedPrisma, closeDb } from "../src/lib/firestore";

// Unscoped on purpose: this is a maintenance script that iterates every
// business. Customer matching is still done per-business (fail-closed:
// a conversation is only ever linked to a customer of the same business).
const prisma = getUnscopedPrisma();

async function backfill() {
  console.log("Starting customer-conversation backfill...\n");

  const orphans = await prisma.conversation.findMany({
    where: {
      customerId: null,
      customerContact: { not: "" },
    },
    select: { id: true, businessId: true, customerContact: true, channel: true },
  });

  console.log(`Found ${orphans.length} conversations without customerId.\n`);

  let linked = 0;
  let skipped = 0;

  for (const conv of orphans) {
    const contact = conv.customerContact;

    // Try to find a matching customer (same business only)
    const customer = await prisma.customer.findFirst({
      where: {
        businessId: conv.businessId,
        OR: [
          { email: { equals: contact, mode: "insensitive" } },
          { phone: contact },
          { whatsapp: contact },
        ],
      },
      select: { id: true, name: true },
    });

    if (customer) {
      await prisma.conversation.update({
        where: { id: conv.id },
        data: { customerId: customer.id },
      });
      linked++;
      if (linked % 100 === 0) {
        console.log(`  Linked ${linked} conversations...`);
      }
    } else {
      skipped++;
    }
  }

  console.log(`\nBackfill complete:`);
  console.log(`  Linked: ${linked}`);
  console.log(`  Skipped (no matching customer): ${skipped}`);
  console.log(`  Total processed: ${orphans.length}`);

  await closeDb();
}

backfill().catch((error) => {
  console.error("Backfill failed:", error);
  process.exit(1);
});
