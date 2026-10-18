import { NextRequest, NextResponse } from "next/server";
import { prisma, withBusinessId } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "automation:read");
  if (!isAuthenticated(auth)) return auth;

  try {
    const commands = await prisma.agentCommand.findMany({
      orderBy: { createdAt: "desc" },
      take: 30,
    });
    return NextResponse.json(commands);
  } catch (error) {
    logger.error("Failed to list agent commands:", error);
    return NextResponse.json(
      { error: "Failed to list agent commands" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, "automation:create");
  if (!isAuthenticated(auth)) return auth;

  try {
    const body = await request.json();
    const { command } = body;

    if (!command || typeof command !== "string" || !command.trim()) {
      return NextResponse.json(
        { error: "command text is required" },
        { status: 400 }
      );
    }

    const row = await prisma.agentCommand.create({
      data: withBusinessId({
        command: command.trim().slice(0, 4000),
        status: "queued",
        createdBy: "admin",
      }),
    });

    return NextResponse.json(row, { status: 201 });
  } catch (error) {
    logger.error("Failed to queue agent command:", error);
    return NextResponse.json(
      { error: "Failed to queue agent command" },
      { status: 500 }
    );
  }
}
