import { vi } from "vitest";

// Set test environment variables
process.env.JWT_SECRET = "test-secret-key-for-testing-only";
process.env.FIREBASE_PROJECT_ID = "test-project";
process.env.FIREBASE_CLIENT_EMAIL = "test@test-project.iam.gserviceaccount.com";
process.env.FIREBASE_PRIVATE_KEY = "test-private-key";
process.env.NODE_ENV = "test";

// Mock Prisma globally
vi.mock("@/lib/prisma", () => {
  const mockClient = createMockPrismaClient();
  const TEST_BUSINESS_ID = "test-business";
  class TenantContextError extends Error {
    constructor(model: string, operation: string) {
      super(`Tenant context missing for ${model}.${operation}`);
      this.name = "TenantContextError";
    }
  }
  return {
    prisma: mockClient,
    getUnscopedPrisma: () => mockClient,
    runWithBusiness: (_id: string | null, fn: () => unknown) => fn(),
    enterBusinessContext: () => {},
    getBusinessId: () => TEST_BUSINESS_ID,
    withBusinessId: <T extends object>(data: T) => ({ ...data, businessId: TEST_BUSINESS_ID }),
    withBusinessIdMany: <T extends object>(rows: T[]) =>
      rows.map((r) => ({ ...r, businessId: TEST_BUSINESS_ID })),
    TenantContextError,
  };
});

// Mock route-auth to always authenticate as admin in tests (scoped to the
// test business, mirroring requireAuth's effective-business resolution).
vi.mock("@/lib/route-auth", () => ({
  requireAuth: vi.fn().mockResolvedValue({
    userId: "test-admin-id",
    role: "admin",
    username: "admin",
    name: "Test Admin",
    authMethod: "cookie",
    scopes: [],
    businessId: "test-business",
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
    "business",
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
    "followUp",
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
    "socialAccount",
    "scheduledPost",
    "socialInteraction",
    "audienceProfile",
    "agentCommand",
    "productCategory",
    "product",
    "order",
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

