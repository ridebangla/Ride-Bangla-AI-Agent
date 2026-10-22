/**
 * /api/comp-request — tenant entry point for complimentary-access
 * requests (B4, non-payment review queue).
 *
 * POST -> create one pending request in Firestore `comp_requests`
 *         { platform: "ai", accountId, accountEmail, accountName,
 *           requestedPlanId?, note?, status: "pending",
 *           createdAt: serverTimestamp }.
 *         If a pending request already exists for the business, it is
 *         returned instead of creating a second one (dedupe).
 * GET  -> the business's own latest request (any status), or null.
 *
 * Auth: authenticated business session only (tenant admin). The
 * business id comes from auth — never from the body. Reads/writes go
 * through the Admin SDK (getAdminDb, the widget-brand pattern), so
 * Firestore rules never gate this server path.
 *
 * The Admin Console works the queue: Approve creates a comp grant
 * (see src/lib/comp.ts), Reject records a reason. This route never
 * grants anything itself.
 */
import { NextRequest, NextResponse } from "next/server";
import admin from "firebase-admin";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { getUnscopedPrisma } from "@/lib/prisma";
import { getAdminDb } from "@/lib/admin-db";
import { getPlanCatalog } from "@/lib/plan-catalog";
import { checkRateLimit } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const COLLECTION = "comp_requests";
const PLATFORM = "ai";
const MAX_NOTE_LENGTH = 500;

interface CompRequestView {
  id: string;
  platform: string;
  accountId: string;
  accountEmail: string;
  accountName: string;
  requestedPlanId: string | null;
  note: string | null;
  status: string;
  createdAt: string | null;
}

function toDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof (value as { toDate?: unknown }).toDate === "function") {
    try {
      const d = (value as { toDate: () => Date }).toDate();
      return d instanceof Date && !Number.isNaN(d.getTime()) ? d : null;
    } catch {
      return null;
    }
  }
  const d = new Date(value as string);
  return Number.isNaN(d.getTime()) ? null : d;
}

function serialize(id: string, data: Record<string, unknown>): CompRequestView {
  const created = toDate(data.createdAt);
  return {
    id,
    platform: typeof data.platform === "string" ? data.platform : PLATFORM,
    accountId: typeof data.accountId === "string" ? data.accountId : "",
    accountEmail: typeof data.accountEmail === "string" ? data.accountEmail : "",
    accountName: typeof data.accountName === "string" ? data.accountName : "",
    requestedPlanId:
      typeof data.requestedPlanId === "string" && data.requestedPlanId
        ? data.requestedPlanId
        : null,
    note: typeof data.note === "string" && data.note ? data.note : null,
    status: typeof data.status === "string" ? data.status : "pending",
    createdAt: created ? created.toISOString() : null,
  };
}

function createdMs(data: Record<string, unknown>): number {
  return toDate(data.createdAt)?.getTime() ?? 0;
}

/** All of this business's AI-platform requests, newest first. */
async function listOwnRequests(
  businessId: string
): Promise<CompRequestView[]> {
  const snap = await getAdminDb()
    .collection(COLLECTION)
    .where("accountId", "==", businessId)
    .get();
  const rows: Array<{ view: CompRequestView; ms: number }> = [];
  snap.forEach((doc) => {
    const data = doc.data() as Record<string, unknown>;
    if (data.platform !== undefined && data.platform !== PLATFORM) return;
    rows.push({ view: serialize(doc.id, data), ms: createdMs(data) });
  });
  rows.sort((a, b) => b.ms - a.ms);
  return rows.map((r) => r.view);
}

async function tenantAuth(request: NextRequest, permission: "settings:read" | "settings:update") {
  const auth = await requireAuth(request, permission);
  if (!isAuthenticated(auth)) return auth;
  if (!auth.businessId) {
    return NextResponse.json({ error: "no_billing_account" }, { status: 400 });
  }
  return auth;
}

export async function GET(request: NextRequest) {
  const auth = await tenantAuth(request, "settings:read");
  if (auth instanceof NextResponse) return auth;
  try {
    const own = await listOwnRequests(auth.businessId as string);
    return NextResponse.json({ request: own.length > 0 ? own[0] : null });
  } catch (err) {
    logger.error("[comp-request] GET failed:", err);
    return NextResponse.json({ error: "comp_request_failed" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const auth = await tenantAuth(request, "settings:update");
  if (auth instanceof NextResponse) return auth;
  const businessId = auth.businessId as string;

  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";
  const rl = checkRateLimit(`comp-request:${businessId}:${ip}`, {
    maxRequests: 10,
    windowMs: 60 * 60 * 1000,
  });
  if (!rl.allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  let body: { requestedPlanId?: unknown; note?: unknown };
  try {
    body = (await request.json().catch(() => ({}))) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  let requestedPlanId: string | null = null;
  if (body.requestedPlanId !== undefined && body.requestedPlanId !== null && body.requestedPlanId !== "") {
    if (typeof body.requestedPlanId !== "string") {
      return NextResponse.json({ error: "invalid_plan" }, { status: 400 });
    }
    requestedPlanId = body.requestedPlanId.trim();
    const catalog = await getPlanCatalog();
    const entry = catalog.find((p) => p.id === requestedPlanId);
    if (!entry || !entry.active) {
      return NextResponse.json({ error: "invalid_plan" }, { status: 400 });
    }
  }

  let note: string | null = null;
  if (body.note !== undefined && body.note !== null && body.note !== "") {
    if (typeof body.note !== "string") {
      return NextResponse.json({ error: "invalid_note" }, { status: 400 });
    }
    note = body.note.trim();
    if (note.length > MAX_NOTE_LENGTH) {
      return NextResponse.json({ error: "note_too_long" }, { status: 400 });
    }
    if (!note) note = null;
  }

  try {
    // Dedupe: one pending request per business — return the existing
    // one instead of creating a second.
    const own = await listOwnRequests(businessId);
    const pending = own.find((r) => r.status === "pending");
    if (pending) {
      return NextResponse.json({ request: pending });
    }

    // Identity from the server-side records, never from the body.
    let accountEmail = "";
    let accountName = typeof auth.name === "string" ? auth.name : "";
    try {
      const db = getUnscopedPrisma();
      const adminRow = (await db.admin.findUnique({
        where: { id: auth.userId },
        select: { email: true, name: true },
      })) as unknown as { email?: unknown; name?: unknown } | null;
      if (adminRow && typeof adminRow.email === "string") {
        accountEmail = adminRow.email;
      }
      const bizRow = (await db.business.findUnique({
        where: { id: businessId },
        select: { name: true },
      })) as unknown as { name?: unknown } | null;
      if (bizRow && typeof bizRow.name === "string" && bizRow.name) {
        accountName = bizRow.name;
      }
    } catch {
      // Identity enrichment is best-effort; the request itself matters.
    }

    const data: Record<string, unknown> = {
      platform: PLATFORM,
      accountId: businessId,
      accountEmail,
      accountName,
      status: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (requestedPlanId) data.requestedPlanId = requestedPlanId;
    if (note) data.note = note;

    const ref = getAdminDb().collection(COLLECTION).doc();
    await ref.set(data);

    return NextResponse.json({
      request: serialize(ref.id, { ...data, createdAt: null }),
    });
  } catch (err) {
    logger.error("[comp-request] POST failed:", err);
    return NextResponse.json({ error: "comp_request_failed" }, { status: 500 });
  }
}
