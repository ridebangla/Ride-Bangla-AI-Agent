import { NextRequest, NextResponse } from "next/server";
import {
  prisma,
  withBusinessId,
  getUnscopedPrisma,
  runWithBusiness,
} from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { emitConversationUpdate } from "@/lib/realtime";
import {
  isTakeoverExpired,
  autoRevertEventText,
} from "@/lib/takeover-handoff";

/**
 * Leg E — POST /api/takeover/revert-expired (STAGED, not yet live).
 *
 * Sweep for human takeovers whose business-set timer has expired, and
 * hand each one back to the AI. This is the CRON side of auto-revert;
 * the same expiry is also enforced lazily by the takeover route, the
 * messages route, and the engine, so a missed or unconfigured cron
 * run only delays the revert until the next touch — it never leaves
 * an expired takeover silently in force on a live turn.
 *
 * Auth mirrors POST /api/followups/process: `Authorization: Bearer
 * <CRON_SECRET>` alone sweeps every business (the secret has no
 * business of its own), otherwise a staff session with
 * `conversations:takeover` sweeps only the caller's business.
 *
 * Deliberately narrow: this route writes ONLY the takeover fields
 * back to their cleared state plus one auto-revert system record. It
 * imports no ticket, order, or billing code — an auto-revert creates
 * no ticket, confirms no order, and spends nothing. Expiry lifts only
 * the PER-CONVERSATION pause: if the global kill-switch is off, the
 * AI stays silent after the revert until Settings turns it back on
 * (that is Leg D's global-wins rule, unchanged).
 *
 * Expiry values are filtered IN CODE, not in the query: the data
 * layer's query support for string comparisons is not relied on, and
 * an unparseable expiry is never treated as expired (see
 * isTakeoverExpired). The sweep is capped at 200 reverts per run so
 * one run can never churn the whole tenant base; leftovers are
 * reported via `capped: true` and picked up by the next run.
 */
const MAX_REVERTS_PER_RUN = 200;

export async function POST(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const header = request.headers.get("authorization") || "";
  const cronOk = !!secret && header === `Bearer ${secret}`;

  let onlyBusinessId: string | null = null;
  if (!cronOk) {
    const auth = await requireAuth(request, "conversations:takeover");
    if (!isAuthenticated(auth)) return auth;
    if (!auth.businessId) {
      return NextResponse.json(
        { error: "A business must be selected to sweep takeovers" },
        { status: 400 }
      );
    }
    onlyBusinessId = auth.businessId;
  }

  try {
    const db = cronOk ? getUnscopedPrisma() : prisma;
    const paused = await (cronOk
      ? db.conversation.findMany({ where: { aiEnabled: false } })
      : runWithBusiness(onlyBusinessId, () =>
          prisma.conversation.findMany({ where: { aiEnabled: false } })
        ));

    const nowMs = Date.now();
    const expired = paused.filter((c) => {
      const expiresAt =
        typeof (c as { takeoverExpiresAt?: unknown }).takeoverExpiresAt ===
        "string"
          ? (c as unknown as { takeoverExpiresAt: string }).takeoverExpiresAt
          : "";
      return isTakeoverExpired(expiresAt, nowMs);
    });
    expired.sort((a, b) => {
      const aMs = new Date(
        (a as unknown as { takeoverExpiresAt: string }).takeoverExpiresAt
      ).getTime();
      const bMs = new Date(
        (b as unknown as { takeoverExpiresAt: string }).takeoverExpiresAt
      ).getTime();
      return aMs - bMs;
    });

    const capped = expired.length > MAX_REVERTS_PER_RUN;
    const batch = capped ? expired.slice(0, MAX_REVERTS_PER_RUN) : expired;

    // Cron mode only: skip businesses that are missing or inactive.
    // (Admin mode is already scoped to the caller's own business.)
    const businessActive = new Map<string, boolean>();
    const isBusinessActive = async (businessId: string): Promise<boolean> => {
      const cached = businessActive.get(businessId);
      if (cached !== undefined) return cached;
      const biz = await getUnscopedPrisma().business.findUnique({
        where: { id: businessId },
      });
      const active = !!biz && (biz as { isActive?: unknown }).isActive !== false;
      businessActive.set(businessId, active);
      return active;
    };

    let reverted = 0;
    let skipped = 0;
    let errors = 0;
    for (const conv of batch) {
      const businessId = cronOk
        ? typeof (conv as { businessId?: unknown }).businessId === "string"
          ? (conv as { businessId: string }).businessId
          : ""
        : (onlyBusinessId as string);
      if (!businessId) {
        skipped++;
        continue;
      }
      try {
        if (cronOk && !(await isBusinessActive(businessId))) {
          skipped++;
          continue;
        }
        await runWithBusiness(businessId, async () => {
          await prisma.conversation.update({
            where: { id: conv.id },
            data: {
              aiEnabled: true,
              takenOverBy: "",
              takenOverByName: "",
              takenOverAt: "",
              handoffReason: "",
              takeoverExpiresAt: "",
              handoffClaimed: false,
              handoffVia: "",
            },
          });
          await prisma.message.create({
            data: withBusinessId({
              conversationId: conv.id,
              role: "system",
              content: autoRevertEventText(),
            }),
          });
        });
        emitConversationUpdate(conv.id, { aiEnabled: true });
        reverted++;
      } catch (error) {
        errors++;
        logger.error("Failed to auto-revert takeover:", error);
      }
    }

    return NextResponse.json({
      success: true,
      checked: paused.length,
      expired: expired.length,
      reverted,
      skipped,
      errors,
      capped,
    });
  } catch (error) {
    logger.error("Failed to sweep expired takeovers:", error);
    return NextResponse.json(
      { error: "Failed to sweep expired takeovers" },
      { status: 500 }
    );
  }
}
