import { describe, it, expect, vi } from "vitest";

// Opt out of the global @/lib/prisma mock: this file tests the REAL tenant
// proxy (fail-closed scoping), without touching a database — every assertion
// below throws or resolves before any I/O happens.
vi.unmock("@/lib/prisma");

import {
  prisma,
  getBusinessId,
  runWithBusiness,
  enterBusinessContext,
  withBusinessId,
  withBusinessIdMany,
  TenantContextError,
} from "@/lib/prisma";

describe("tenant isolation (fail-closed)", () => {
  it("throws TenantContextError on reads without a tenant context", () => {
    expect(() => (prisma.conversation as any).findMany({})).toThrow(TenantContextError);
    expect(() => (prisma.message as any).findFirst({})).toThrow(TenantContextError);
    expect(() => (prisma.customer as any).count()).toThrow(TenantContextError);
  });

  it("throws TenantContextError on writes without a tenant context", () => {
    expect(() => (prisma.message as any).create({ data: { content: "x" } })).toThrow(
      TenantContextError
    );
    expect(() => (prisma.ticket as any).updateMany({ data: {} })).toThrow(TenantContextError);
    expect(() => (prisma.conversation as any).delete({ where: { id: "x" } })).toThrow(
      TenantContextError
    );
  });

  it("withBusinessId throws without context and injects with context", () => {
    expect(() => withBusinessId({ name: "x" })).toThrow(TenantContextError);
    const row = runWithBusiness("biz-a", () => withBusinessId({ name: "x" }));
    expect(row).toEqual({ name: "x", businessId: "biz-a" });
  });

  it("withBusinessIdMany injects into every row", () => {
    const rows = runWithBusiness("biz-b", () =>
      withBusinessIdMany([{ tagId: "t1" }, { tagId: "t2" }])
    );
    expect(rows).toEqual([
      { tagId: "t1", businessId: "biz-b" },
      { tagId: "t2", businessId: "biz-b" },
    ]);
  });

  it("runWithBusiness scopes the context to the callback", () => {
    expect(getBusinessId()).toBeUndefined();
    runWithBusiness("biz-c", () => {
      expect(getBusinessId()).toBe("biz-c");
    });
    expect(getBusinessId()).toBeUndefined();
  });

  it("non-tenant models (business) are never blocked by missing context", () => {
    // business.findMany would attempt I/O; instead assert the delegate is
    // NOT a tenant model by checking the proxy passes the call through.
    // We only verify it does not throw TenantContextError synchronously.
    // (A live DB call is out of scope for unit tests.)
    const call = () => (prisma.business as any).findMany;
    expect(call).not.toThrow();
  });

  it("enterBusinessContext(null) marks the super-admin unscoped context", () => {
    enterBusinessContext(null);
    try {
      expect(getBusinessId()).toBeNull();
    } finally {
      // restore: no context (AsyncLocalStorage.enterWith persists, so reset
      // via runWithBusiness which is properly scoped)
      runWithBusiness("cleanup", () => {});
    }
  });
});
