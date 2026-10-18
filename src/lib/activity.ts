import { prisma, withBusinessId } from "@/lib/prisma";
import { logger } from "@/lib/logger";

export async function logActivity(
  action: string,
  entity: string,
  entityId: string | null,
  description: string,
  userName?: string
): Promise<void> {
  try {
    await prisma.activityLog.create({
      data: withBusinessId({
        action,
        entity,
        entityId,
        description,
        userName: userName || "System",
      }),
    });
  } catch (error) {
    logger.error("Failed to log activity", error);
  }
}
