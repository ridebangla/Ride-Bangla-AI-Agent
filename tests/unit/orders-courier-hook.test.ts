/**
 * orders-courier-hook.test.ts — the setOrderStatus funnel.
 *
 * setOrderStatus (src/lib/orders.ts) is the ONLY writer of order
 * status in the platform (dashboard PATCH /api/orders/[id]), so the
 * courier bridge hangs off it: confirmed → booking, cancelled →
 * cancel mirror, anything else → untouched. The bridge must also
 * NEVER break the status update itself when it fails.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/courier-bridge", () => ({
  handleOrderConfirmed: vi.fn(),
  handleOrderCancelled: vi.fn(),
}));

import { prisma } from "@/lib/prisma";
import { setOrderStatus } from "@/lib/orders";
import {
  handleOrderConfirmed,
  handleOrderCancelled,
} from "@/lib/courier-bridge";

const mockPrisma = prisma as unknown as {
  order: { update: Mock; findUnique: Mock };
};
const mockConfirmed = handleOrderConfirmed as unknown as Mock;
const mockCancelled = handleOrderCancelled as unknown as Mock;

const UPDATED = { id: "order-1", status: "confirmed" };
const FRESH = { id: "order-1", status: "confirmed", courierBooking: { state: "booked" } };

describe("setOrderStatus → courier bridge hook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.order.update.mockResolvedValue(UPDATED);
    mockPrisma.order.findUnique.mockResolvedValue(FRESH);
    mockConfirmed.mockResolvedValue({ state: "booked" });
    mockCancelled.mockResolvedValue({ state: "none" });
  });

  it("confirming an order invokes the bridge and returns the re-read order", async () => {
    const result = await setOrderStatus("order-1", "confirmed");
    expect(mockConfirmed).toHaveBeenCalledTimes(1);
    expect(mockConfirmed).toHaveBeenCalledWith("order-1");
    expect(mockCancelled).not.toHaveBeenCalled();
    expect(result).toEqual(FRESH);
  });

  it("cancelling an order invokes the cancel mirror", async () => {
    mockPrisma.order.update.mockResolvedValue({ id: "order-1", status: "cancelled" });
    await setOrderStatus("order-1", "cancelled");
    expect(mockCancelled).toHaveBeenCalledTimes(1);
    expect(mockCancelled).toHaveBeenCalledWith("order-1");
    expect(mockConfirmed).not.toHaveBeenCalled();
  });

  it("moving an order back to pending does not touch the bridge", async () => {
    mockPrisma.order.update.mockResolvedValue({ id: "order-1", status: "pending" });
    const result = await setOrderStatus("order-1", "pending");
    expect(mockConfirmed).not.toHaveBeenCalled();
    expect(mockCancelled).not.toHaveBeenCalled();
    expect(result).toEqual({ id: "order-1", status: "pending" });
  });

  it("a bridge failure never fails the status update", async () => {
    mockConfirmed.mockRejectedValue(new Error("bridge exploded"));
    const result = await setOrderStatus("order-1", "confirmed");
    expect(result).toEqual(UPDATED);
  });

  it("invalid status still throws before any bridge call", async () => {
    await expect(
      setOrderStatus("order-1", "delivered" as never)
    ).rejects.toThrow("Invalid status");
    expect(mockConfirmed).not.toHaveBeenCalled();
  });
});
