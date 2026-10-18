import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { analyzeAudience } from "@/lib/social/audience";

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, "automation:create");
  if (!isAuthenticated(auth)) return auth;

  try {
    const result = await analyzeAudience();
    return NextResponse.json(result);
  } catch (error) {
    logger.error("Audience analysis failed:", error);
    return NextResponse.json(
      { error: "Failed to analyze audience" },
      { status: 500 }
    );
  }
}
