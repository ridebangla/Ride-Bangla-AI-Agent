/**
 * Internal owner comp — AI Agent platform (owner rule 2026-10-21).
 *
 * Grants the internal comp to the company's OWN business on THIS
 * platform: the "Ride Bangla" business (the one that powers the main
 * website's Help Center). The comp is the `isInternalAccount` flag on
 * the business doc itself — enforcement (src/lib/subscription.ts,
 * src/lib/billing-usage.ts) reads it from the doc keyed by business id,
 * never from an email, and no client request path can write it.
 * Effect: permanently active, no message limit, no trial expiry, never
 * billed. Usage is still metered (aiMessagesUsed), never blocked.
 *
 * FAIL-CLOSED: the script writes ONLY when the target doc's name AND
 * siteKey match the expected Ride Bangla identity below — the same
 * identity the Help Center seed script verifies. Any mismatch aborts
 * before any write.
 *
 * Run (with the production env of THIS platform):
 *   npx tsx scripts/apply-internal-comp.ts
 * Requires FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and
 * FIREBASE_PRIVATE_KEY (see OPERATIONS.md §1). Idempotent: safe to
 * re-run. Revoke from the Admin Console → AI Management → Internal
 * Accounts (Super Admin, audit-logged), not from here.
 */
import { getUnscopedPrisma, closeDb } from "../src/lib/firestore";

const prisma = getUnscopedPrisma();

const BUSINESS_ID = "55fb1c96-d273-4695-b47d-b77ed6c2ad87";
const EXPECTED_NAME = "Ride Bangla";
const EXPECTED_SITE_KEY = "rbsite-00f37b79c72f4e678febbd82d43bb46c";
const GRANTED_BY = "owner-order-2026-10-21";
const GRANT_REASON =
  "Owner rule 2026-10-21: company accounts are free forever — no plan, no limits, no trial expiry.";

async function main() {
  const biz = (await prisma.business.findUnique({
    where: { id: BUSINESS_ID },
  })) as Record<string, unknown> | null;

  if (!biz) {
    throw new Error(`Business ${BUSINESS_ID} not found — aborting, no write made.`);
  }
  if (biz.name !== EXPECTED_NAME || biz.siteKey !== EXPECTED_SITE_KEY) {
    throw new Error(
      `Identity mismatch — expected name "${EXPECTED_NAME}" + siteKey "${EXPECTED_SITE_KEY}", ` +
        `found name "${String(biz.name)}" + siteKey "${String(biz.siteKey)}". Aborting, no write made.`
    );
  }

  console.log(
    `Verified target: "${String(biz.name)}" (${BUSINESS_ID}) — plan=${String(biz.plan)}, ` +
      `status=${String(biz.subscriptionStatus)}, isInternalAccount=${String(biz.isInternalAccount)}`
  );

  await prisma.business.update({
    where: { id: BUSINESS_ID },
    data: {
      isInternalAccount: true,
      internalGrantedBy: GRANTED_BY,
      internalGrantedAt: new Date(),
      internalGrantReason: GRANT_REASON,
    },
  });

  const after = (await prisma.business.findUnique({
    where: { id: BUSINESS_ID },
  })) as Record<string, unknown> | null;
  console.log(
    `Applied: isInternalAccount=${String(after?.isInternalAccount)}, ` +
      `internalGrantedBy=${String(after?.internalGrantedBy)}, ` +
      `internalGrantedAt=${String(after?.internalGrantedAt)}`
  );
  console.log(
    "The account is now permanently active with no message limit and no trial expiry. " +
      "Its plan/status fields were NOT changed — the flag overrides them at every enforcement point."
  );
}

main()
  .then(async () => {
    await closeDb();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(err);
    await closeDb().catch(() => {});
    process.exit(1);
  });
