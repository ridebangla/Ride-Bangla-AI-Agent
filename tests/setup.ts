import { vi } from "vitest";

// Set test environment variables
process.env.JWT_SECRET = "test-secret-key-for-testing-only";
process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/owly_test";
process.env.NODE_ENV = "test";

// Mock Prisma globally
vi.mock("@/lib/prisma", () => ({
  prisma: createMockPrismaClient(),
}));

// Mock route-auth to always authenticate as admin in tests
vi.mock("@/lib/route-auth", () => ({
  requireAuth: vi.fn().mockResolvedValue({
    userId: "test-admin-id",
    role: "admin",
    username: "admin",
    name: "Test Admin",
    authMethod: "cookie",
  }),
  isAuthenticated: vi.fn().mockReturnValue(true),
}));

// Mock realtime to prevent side effects in tests
vi.mock("@/lib/realtime", () => ({
  emitNewMessage: vi.fn(),
  emitConversationUpdate: vi.fn(),
  emitTyping: vi.fn(),
  publish: vi.fn(),
  subscribe: vi.fn(),
}));

// Mock next/headers
vi.mock("next/headers", () => ({
  cookies: vi.fn().mockResolvedValue({
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
  }),
  headers: vi.fn().mockResolvedValue(new Map()),
}));

function createMockPrismaClient() {
  const modelMethods = {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    count: vi.fn(),
    aggregate: vi.fn(),
    groupBy: vi.fn(),
  };

  const models = [
    "settings",
    "admin",
    "conversation",
    "message",
    "ticket",
    "knowledgeEntry",
    "category",
    "department",
    "teamMember",
    "tag",
    "conversationTag",
    "callLog",
    "channel",
    "schedule",
    "webhook",
    "webhookDelivery",
    "activityLog",
    "sLARule",
    "cannedResponse",
    "customer",
    "customerNote",
    "automationRule",
    "businessHours",
    "apiKey",
    "internalNote",
    "campaign",
    "flow",
    "revokedToken",
  ];

  const client: Record<string, unknown> = {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    $connect: vi.fn(),
    $disconnect: vi.fn(),
    $transaction: vi.fn(),
  };

  for (const model of models) {
    client[model] = { ...modelMethods };
    // Each model needs its own vi.fn() instances
    for (const method of Object.keys(modelMethods)) {
      (client[model] as Record<string, unknown>)[method] = vi.fn();
    }
  }

  return client;
}
