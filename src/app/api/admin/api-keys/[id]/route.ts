import { NextRequest, NextResponse } from "next/server";
import { prisma, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { publicApiKey, validateScopes } from "@/lib/api-keys";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(request, "admin:read");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {

    try {
      const { id } = await params;
      const body = await request.json();
      const { name, isActive, scopes } = body;

      const existing = await prisma.apiKey.findUnique({ where: { id } });
      if (!existing) {
        return NextResponse.json(
          { error: "API key not found" },
          { status: 404 }
        );
      }

      const updateData: Record<string, unknown> = {};

      if (name !== undefined && typeof name === "string") {
        updateData.name = name.trim();
      }

      if (isActive !== undefined && typeof isActive === "boolean") {
        updateData.isActive = isActive;
      }

      if (scopes !== undefined) {
        const scopeError = validateScopes(scopes);
        if (scopeError) {
          return NextResponse.json({ error: scopeError }, { status: 400 });
        }
        updateData.scopes = scopes;
      }

      const apiKey = await prisma.apiKey.update({
        where: { id },
        data: updateData,
      });

      // Never return the stored hash; the `key` field is the masked display form.
      return NextResponse.json(publicApiKey(apiKey));
    } catch (error) {
      logger.error("Failed to update API key:", error);
      return NextResponse.json(
        { error: "Failed to update API key" },
        { status: 500 }
      );
    }

  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(request, "admin:delete");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {

    try {
      const { id } = await params;

      const existing = await prisma.apiKey.findUnique({ where: { id } });
      if (!existing) {
        return NextResponse.json(
          { error: "API key not found" },
          { status: 404 }
        );
      }

      await prisma.apiKey.delete({ where: { id } });

      return NextResponse.json({ success: true });
    } catch (error) {
      logger.error("Failed to delete API key:", error);
      return NextResponse.json(
        { error: "Failed to delete API key" },
        { status: 500 }
      );
    }

  });
}
