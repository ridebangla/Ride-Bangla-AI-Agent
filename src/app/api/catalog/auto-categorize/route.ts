import { NextRequest, NextResponse } from "next/server";
import { prisma, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { autoCategorizeProducts } from "@/lib/catalog";

/**
 * POST /api/catalog/auto-categorize — Phase 3 refinement (a).
 *
 * Builds beautiful categories automatically from the business's product
 * list — no manual category creation required. Rule-based grouping
 * (product-type keywords, shared tags, price/service signals); when the
 * business has an OpenAI key, category display names are AI-refined,
 * otherwise the rule-based names stand (graceful, no crash, no spend).
 *
 * Body: { mode?: "fill" | "rebuild" }
 *   "fill"    (default): categorize only currently-uncategorized products;
 *             never touches the owner's manual assignments.
 *   "rebuild": re-plan and re-assign everything (explicit owner choice).
 *
 * Tenant-scoped via runWithBusiness (fail-closed). Writes real
 * productCategory rows + product.categoryId — no new collections.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, "knowledge:update");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {
    try {
      const body = (await request.json().catch(() => ({}))) as {
        mode?: string;
      };
      const mode = body.mode === "rebuild" ? "rebuild" : "fill";

      // The business's own AI key (if configured) refines category names.
      // Absent key -> pure rule-based, still fully functional.
      const settings = await prisma.settings.findFirst();
      const aiApiKey =
        typeof (settings as { aiApiKey?: unknown } | null)?.aiApiKey === "string"
          ? ((settings as { aiApiKey: string }).aiApiKey ?? "")
          : "";
      const aiModel =
        typeof (settings as { aiModel?: unknown } | null)?.aiModel === "string"
          ? (settings as { aiModel: string }).aiModel
          : "gpt-4o-mini";

      const result = await autoCategorizeProducts({
        mode,
        aiApiKey: aiApiKey || undefined,
        aiModel,
      });

      logger.info(
        `[catalog] auto-categorize (${mode}) for business ${auth.businessId}: ` +
          `${result.created.length} created, ${result.reused.length} reused, ${result.assigned} assigned`
      );

      return NextResponse.json(result);
    } catch (error) {
      logger.error("Auto-categorize failed:", error);
      return NextResponse.json(
        { error: "Failed to auto-build categories" },
        { status: 500 }
      );
    }
  });
}
