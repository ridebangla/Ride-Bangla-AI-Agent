import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { logger } from "@/lib/logger";
import { getWallet, getWalletTransactions } from "@/lib/wallet";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/wallet — the tenant's SaaS wallet.
 *
 * Success: 200 { balanceCents, currency, updatedAt, transactions[] }.
 * Wallets are server-side (Admin SDK, firestore.rules denies all client
 * writes); this route is the tenant's only read path.
 *
 * Honest failures: 401/403 auth; 400 for the Super Admin (never billed).
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!isAuthenticated(auth)) return auth;

  if (!auth.businessId) {
    return NextResponse.json(
      {
        error: "no_billing_account",
        message: "Platform administrators are never billed.",
      },
      { status: 400 }
    );
  }

  try {
    const [wallet, transactions] = await Promise.all([
      getWallet(auth.businessId),
      getWalletTransactions(auth.businessId),
    ]);
    return NextResponse.json({
      balanceCents: wallet.balanceCents,
      currency: wallet.currency,
      updatedAt: wallet.updatedAt ? wallet.updatedAt.toISOString() : null,
      transactions: transactions.map((t) => ({
        id: t.id,
        type: t.type,
        amountCents: t.amountCents,
        method: t.method ?? null,
        claimId: t.claimId ?? null,
        plan: t.plan ?? null,
        interval: t.interval ?? null,
        balanceAfterCents: t.balanceAfterCents,
        createdAt: t.createdAt ? t.createdAt.toISOString() : null,
        note: t.note ?? null,
      })),
    });
  } catch (err) {
    logger.error("wallet read failed", {
      businessId: auth.businessId,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      {
        error: "wallet_unavailable",
        message: "We could not load your wallet right now. Please try again.",
      },
      { status: 500 }
    );
  }
}
