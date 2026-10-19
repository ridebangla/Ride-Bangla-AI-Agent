import { NextRequest, NextResponse } from "next/server";
import { prisma, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { preSendGateCheck } from "@/lib/lead-engine";

/**
 * Human approval gate for a single outreach draft.
 *
 * action=approve: re-runs the deterministic pre-send gate. If the gate
 * FAILS, approval is refused with the exact reasons (400) — a bad draft
 * can never be armed for sending. If it passes, status -> 'approved' and
 * the sidecar may send it (the sidecar re-verifies the gate at send time).
 * action=reject: status -> 'rejected'. Terminal states (sent/failed)
 * cannot be changed.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(request, "leads:write");
  if (!isAuthenticated(auth)) return auth;
  const { id } = await params;

  return runWithBusiness(auth.businessId, async () => {
    try {
      const body = await request.json();
      const action = body.action;
      if (action !== "approve" && action !== "reject") {
        return NextResponse.json({ error: "action must be 'approve' or 'reject'" }, { status: 400 });
      }

      const draft = await prisma.leadDraft.findFirst({ where: { id } as never });
      if (!draft) {
        return NextResponse.json({ error: "Draft not found" }, { status: 404 });
      }
      const d = draft as unknown as Record<string, unknown>;
      if (d.status === "sent" || d.status === "failed") {
        return NextResponse.json(
          { error: `Draft is already ${d.status} and cannot be changed` },
          { status: 409 }
        );
      }

      if (action === "reject") {
        const updated = await prisma.leadDraft.update({
          where: { id },
          data: { status: "rejected" } as never,
        });
        return NextResponse.json(updated);
      }

      // Approve: run the deterministic gate NOW, using the lead's verified
      // contact email status. Refuse on failure.
      const lead = d.leadId
        ? await prisma.lead.findFirst({ where: { id: String(d.leadId) } as never })
        : null;
      const leadEmailStatus = lead
        ? String((lead as unknown as Record<string, unknown>).contactEmailStatus ?? "guess")
        : "guess";
      const finalGate = preSendGateCheck(
        String(d.toEmail ?? ""),
        String(d.subject ?? ""),
        String(d.body ?? ""),
        String(d.toEmail ?? ""),
        leadEmailStatus
      );
      if (!finalGate.ok) {
        return NextResponse.json(
          {
            error: "Draft failed the pre-send gate and cannot be approved",
            reasons: finalGate.reasons,
          },
          { status: 400 }
        );
      }

      const updated = await prisma.leadDraft.update({
        where: { id },
        data: {
          status: "approved",
          gateCheck: finalGate,
          approvedBy: auth.userId ?? "dashboard",
          approvedAt: new Date(),
        } as never,
      });
      return NextResponse.json(updated);
    } catch (error) {
      logger.error("Failed to review lead draft:", error);
      return NextResponse.json({ error: "Failed to review lead draft" }, { status: 500 });
    }
  });
}
