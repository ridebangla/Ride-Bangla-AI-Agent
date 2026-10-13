import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { createRequest, parseJsonResponse } from "../helpers/request";
import {
  hashApiKey,
  keySuffixOf,
  maskApiKeySuffix,
  publicApiKey,
  validateScopes,
  DEFAULT_API_KEY_SCOPES,
} from "@/lib/api-keys";

const mockPrisma = prisma as unknown as Record<
  string,
  Record<string, ReturnType<typeof vi.fn>>
>;

describe("API key hashing + scopes (H-15)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("hashes deterministically and never equals the plaintext", () => {
    const key = "owly_test_key_123";
    expect(hashApiKey(key)).toBe(
      crypto.createHash("sha256").update(key, "utf8").digest("hex")
    );
    expect(hashApiKey(key)).not.toBe(key);
    expect(hashApiKey(key)).toBe(hashApiKey(key));
    expect(hashApiKey(key)).not.toBe(hashApiKey(key + "x"));
  });

  it("derives the display suffix and masks it", () => {
    expect(keySuffixOf("owly_abcdefgh12345678")).toBe("12345678");
    expect(maskApiKeySuffix("12345678")).toBe("********12345678");
    expect(publicApiKey({
      id: "1",
      name: "K",
      keyHash: "deadbeef",
      keySuffix: "12345678",
      scopes: [],
    }).key).toBe("********12345678");
  });

  it("publicApiKey strips the stored hash", () => {
    const pub = publicApiKey({
      id: "1",
      name: "K",
      keyHash: "deadbeef",
      keySuffix: "12345678",
      scopes: [],
    });
    expect("keyHash" in pub).toBe(false);
  });

  it("validates scope lists", () => {
    expect(validateScopes(["conversations:read"])).toBeNull();
    expect(validateScopes([])).not.toBeNull();
    expect(validateScopes(["admin:read"])).toBeNull();
    expect(validateScopes(["not:a:permission"])).not.toBeNull();
    expect(validateScopes("conversations:read")).not.toBeNull();
    // Default scopes are real permissions and exclude admin powers.
    expect(DEFAULT_API_KEY_SCOPES.length).toBeGreaterThan(0);
    expect(DEFAULT_API_KEY_SCOPES).not.toContain("admin:read");
    expect(DEFAULT_API_KEY_SCOPES).not.toContain("settings:update");
  });

  it("POST /api/admin/api-keys stores only the hash, returns full key once", async () => {
    const created = {
      id: "key-new",
      name: "Test Key",
      keyHash: "stored-hash",
      keySuffix: "suffix88",
      scopes: ["conversations:read"],
      isActive: true,
      lastUsed: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockPrisma.apiKey.create.mockResolvedValue(created);

    const { POST } = await import("@/app/api/admin/api-keys/route");
    const response = await POST(
      createRequest("/api/admin/api-keys", {
        method: "POST",
        body: { name: "Test Key", scopes: ["conversations:read"] },
      })
    );
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(201);
    // Full key returned once, hash never returned.
    expect(typeof data.key).toBe("string");
    expect(data.key.startsWith("owly_")).toBe(true);
    expect("keyHash" in data).toBe(false);
    // What was stored is the hash of the returned key — not the key itself.
    const stored = mockPrisma.apiKey.create.mock.calls[0][0].data;
    expect(stored.keyHash).toBe(hashApiKey(data.key));
    expect(stored.keyHash).not.toBe(data.key);
    expect("key" in stored).toBe(false);
    expect(stored.scopes).toEqual(["conversations:read"]);
  });

  it("POST /api/admin/api-keys rejects unknown scopes", async () => {
    const { POST } = await import("@/app/api/admin/api-keys/route");
    const response = await POST(
      createRequest("/api/admin/api-keys", {
        method: "POST",
        body: { name: "Bad Key", scopes: ["pwn:everything"] },
      })
    );
    expect(response.status).toBe(400);
    expect(mockPrisma.apiKey.create).not.toHaveBeenCalled();
  });

  it("GET /api/admin/api-keys never exposes hashes", async () => {
    mockPrisma.apiKey.findMany.mockResolvedValue([
      {
        id: "key-1",
        name: "K",
        keyHash: "deadbeef",
        keySuffix: "12345678",
        scopes: ["conversations:read"],
        isActive: true,
        lastUsed: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    mockPrisma.apiKey.count.mockResolvedValue(1);

    const { GET } = await import("@/app/api/admin/api-keys/route");
    const response = await GET(createRequest("/api/admin/api-keys"));
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(JSON.stringify(data)).not.toContain("deadbeef");
    expect(data.data[0].key).toBe("********12345678");
  });
});
