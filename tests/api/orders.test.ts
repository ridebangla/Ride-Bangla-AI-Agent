import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { createRequest, parseJsonResponse } from "../helpers/request";

const mockPrisma = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;

/**
 * PATCH /api/orders/[id] — defect O-1: an unknown id used to return 500
 * because the route mapped every setOrderStatus throw to 500. The data
 * layer's tenant-scoped update throws a Prisma-style P2025 for a missing
 * (or another tenant's) order; the route must map that to 404.
 */
describe("PATCH /api/orders/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function patchRequest(id: string, status: string) {
    return createRequest(`/api/orders/${id}`, {
      method: "PATCH",
      body: { status },
    });
  }

  it("returns 404 (not 500) for an unknown order id", async () => {
    const notFound = Object.assign(
      new Error("An operation failed because it depends on one or more records that were required but not found. (order)"),
      { code: "P2025" }
    );
    mockPrisma.order.update.mockRejectedValue(notFound);

    const { PATCH } = await import("@/app/api/orders/[id]/route");
    const response = await PATCH(patchRequest("no-such-order", "confirmed"), {
      params: Promise.resolve({ id: "no-such-order" }),
    });
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(404);
    expect(data.error).toBe("Order not found");
  });

  it("still returns 500 for a genuine data-layer failure", async () => {
    mockPrisma.order.update.mockRejectedValue(new Error("connection lost"));

    const { PATCH } = await import("@/app/api/orders/[id]/route");
    const response = await PATCH(patchRequest("order-1", "confirmed"), {
      params: Promise.resolve({ id: "order-1" }),
    });

    expect(response.status).toBe(500);
  });

  it("updates a real order and returns 200", async () => {
    mockPrisma.order.update.mockResolvedValue({ id: "order-1", status: "confirmed" });

    const { PATCH } = await import("@/app/api/orders/[id]/route");
    const response = await PATCH(patchRequest("order-1", "confirmed"), {
      params: Promise.resolve({ id: "order-1" }),
    });
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.order.status).toBe("confirmed");
    expect(mockPrisma.order.update).toHaveBeenCalledWith({
      where: { id: "order-1" },
      data: { status: "confirmed" },
    });
  });

  it("rejects an invalid status with 400 without touching the data layer", async () => {
    const { PATCH } = await import("@/app/api/orders/[id]/route");
    const response = await PATCH(patchRequest("order-1", "shipped"), {
      params: Promise.resolve({ id: "order-1" }),
    });

    expect(response.status).toBe(400);
    expect(mockPrisma.order.update).not.toHaveBeenCalled();
  });
});
