/**
 * setup-application.test.ts — Done-for-You Setup application route.
 *
 * The customer fills this AFTER signup; our team then sets everything up.
 * Tests use the globally mocked prisma + route-auth (tests/setup.ts):
 * the caller is an admin of "test-business".
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/setup-application/route";
import { prisma } from "@/lib/prisma";

type MockFn = ReturnType<typeof vi.fn>;
const db = prisma as unknown as Record<
  string,
  Record<string, MockFn>
>;

let ipCounter = 0;
function post(body: unknown): NextRequest {
  ipCounter += 1;
  return new NextRequest("http://localhost/api/setup-application", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": `10.9.0.${ipCounter}`,
    },
    body: JSON.stringify(body),
  });
}

function get(): NextRequest {
  return new NextRequest("http://localhost/api/setup-application", {
    method: "GET",
  });
}

const sampleApp = {
  id: "app-1",
  businessId: "test-business",
  businessName: "Dhaka Cake House",
  contactName: "Rahim Uddin",
  contactPhone: "01712345678",
  contactEmail: "rahim@example.com",
  channelsWanted: ["facebook", "whatsapp"],
  preferredContact: "whatsapp",
  notes: "",
  status: "pending",
  createdAt: new Date("2026-10-20T00:00:00Z"),
  updatedAt: new Date("2026-10-20T00:00:00Z"),
};

const validBody = {
  businessName: "Dhaka Cake House",
  contactName: "Rahim Uddin",
  contactPhone: "01712345678",
  contactEmail: "rahim@example.com",
  channelsWanted: ["facebook", "whatsapp"],
  preferredContact: "whatsapp",
  notes: "",
};

beforeEach(() => {
  vi.clearAllMocks();
  db.setupApplication.findMany.mockResolvedValue([]);
  db.setupApplication.create.mockResolvedValue(sampleApp);
  db.setupApplication.update.mockResolvedValue(sampleApp);
  db.business.update.mockResolvedValue({});
  db.settings.upsert.mockResolvedValue({});
});

describe("GET /api/setup-application", () => {
  it("returns null when no application exists", async () => {
    const res = await GET(get());
    expect(res.status).toBe(200);
    expect((await res.json()).application).toBeNull();
  });

  it("returns the latest application serialized to ISO dates", async () => {
    db.setupApplication.findMany.mockResolvedValue([sampleApp]);
    const res = await GET(get());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.application.id).toBe("app-1");
    expect(data.application.channelsWanted).toEqual(["facebook", "whatsapp"]);
    expect(data.application.createdAt).toBe("2026-10-20T00:00:00.000Z");
  });
});

describe("POST /api/setup-application", () => {
  it("rejects a too-short business name", async () => {
    const res = await POST(post({ ...validBody, businessName: "x" }));
    expect(res.status).toBe(400);
    expect(db.setupApplication.create).not.toHaveBeenCalled();
  });

  it("rejects an unknown channel id", async () => {
    const res = await POST(post({ ...validBody, channelsWanted: ["myspace"] }));
    expect(res.status).toBe(400);
    expect(db.setupApplication.create).not.toHaveBeenCalled();
  });

  it("requires a reachable phone when WhatsApp contact is preferred", async () => {
    const res = await POST(post({ ...validBody, contactPhone: "" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/WhatsApp number/i);
  });

  it("requires a valid email when email contact is preferred", async () => {
    const res = await POST(
      post({ ...validBody, preferredContact: "email", contactEmail: "nope" })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/valid email/i);
  });

  it("creates a pending application and syncs the business name", async () => {
    const res = await POST(post(validBody));
    expect(res.status).toBe(200);
    expect(db.setupApplication.create).toHaveBeenCalledTimes(1);
    const createArg = db.setupApplication.create.mock.calls[0][0];
    expect(createArg.data.businessName).toBe("Dhaka Cake House");
    expect(createArg.data.status).toBeUndefined(); // shim default applies
    expect(db.business.update).toHaveBeenCalledTimes(1);
    const data = await res.json();
    expect(data.application.status).toBe("pending");
  });

  it("updates the existing pending application instead of duplicating", async () => {
    db.setupApplication.findMany.mockResolvedValue([sampleApp]);
    const res = await POST(post(validBody));
    expect(res.status).toBe(200);
    expect(db.setupApplication.update).toHaveBeenCalledTimes(1);
    expect(db.setupApplication.create).not.toHaveBeenCalled();
  });
});
