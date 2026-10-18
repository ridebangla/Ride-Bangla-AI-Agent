/**
 * Backfill Script: Link existing conversations to Customer records.
 *
 * Run: npx tsx scripts/backfill-customer-ids.ts
 *
 * This script finds conversations with customerId=null and attempts
 * to match them to existing Customer records by contact info.
 */

import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const connectionString = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/ride-bangla-ai-agent?schema=public";
const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

async function backfill() {
  console.log("Starting customer-conversation backfill...\n");

  const orphans = await prisma.conversation.findMany({
    where: {
      customerId: null,
      customerContact: { not: "" },
    },
    select: { id: true, customerContact: true, channel: true },
  });

  console.log(`Found ${orphans.length} conversations without customerId.\n`);

  let linked = 0;
  let skipped = 0;

  for (const conv of orphans) {
    const contact = conv.customerContact;

    // Try to find a matching customer
    const customer = await prisma.customer.findFirst({
      where: {
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

  await prisma.$disconnect();
}

backfill().catch((error) => {
  console.error("Backfill failed:", error);
  process.exit(1);
});
