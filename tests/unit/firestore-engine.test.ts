import { describe, it, expect } from "vitest";

import {
  toMillis,
  valuesEqual,
  compareValues,
  matchesScalarWhere,
  sortRows,
  projectSelect,
  stripUndefined,
  applyFieldUpdate,
  extractEquality,
} from "@/lib/firestore-query";

describe("firestore-query engine", () => {
  describe("toMillis", () => {
    it("converts Date, Timestamp-like, number and ISO strings", () => {
      const d = new Date("2026-01-02T03:04:05Z");
      expect(toMillis(d)).toBe(d.getTime());
      expect(toMillis({ seconds: 10, nanoseconds: 5_000_000 })).toBe(10005);
      expect(toMillis({ toMillis: () => 42 })).toBe(42);
      expect(toMillis(123)).toBe(123);
      expect(toMillis("2026-01-02T03:04:05.000Z")).toBe(d.getTime());
      expect(toMillis(null)).toBeNull();
      expect(toMillis(undefined)).toBeNull();
    });
  });

  describe("matchesScalarWhere", () => {
    const row = {
      id: "1",
      status: "active",
      priority: 3,
      name: "Hello World",
      customerId: null,
      createdAt: new Date("2026-05-01T00:00:00Z"),
    };

    it("matches scalar equality and null", () => {
      expect(matchesScalarWhere(row, { status: "active" })).toBe(true);
      expect(matchesScalarWhere(row, { status: "closed" })).toBe(false);
      expect(matchesScalarWhere(row, { customerId: null })).toBe(true);
      expect(matchesScalarWhere(row, { customerId: "x" })).toBe(false);
    });

    it("matches equals/in/notIn/not operators", () => {
      expect(matchesScalarWhere(row, { status: { equals: "active" } })).toBe(true);
      expect(matchesScalarWhere(row, { status: { in: ["a", "active"] } })).toBe(true);
      expect(matchesScalarWhere(row, { status: { in: ["a", "b"] } })).toBe(false);
      expect(matchesScalarWhere(row, { status: { notIn: ["a", "b"] } })).toBe(true);
      expect(matchesScalarWhere(row, { name: { not: "" } })).toBe(true);
      expect(matchesScalarWhere(row, { status: { not: "active" } })).toBe(false);
    });

    it("matches range operators incl. dates", () => {
      expect(matchesScalarWhere(row, { priority: { gte: 3 } })).toBe(true);
      expect(matchesScalarWhere(row, { priority: { gt: 3 } })).toBe(false);
      expect(matchesScalarWhere(row, { priority: { lt: 5, gte: 1 } })).toBe(true);
      expect(
        matchesScalarWhere(row, { createdAt: { gte: new Date("2026-01-01") } })
      ).toBe(true);
      expect(
        matchesScalarWhere(row, { createdAt: { lt: new Date("2026-01-01") } })
      ).toBe(false);
    });

    it("matches contains/startsWith/endsWith with insensitive mode", () => {
      expect(
        matchesScalarWhere(row, { name: { contains: "hello", mode: "insensitive" } })
      ).toBe(true);
      expect(matchesScalarWhere(row, { name: { contains: "hello" } })).toBe(false);
      expect(matchesScalarWhere(row, { name: { startsWith: "Hello" } })).toBe(true);
      expect(matchesScalarWhere(row, { name: { endsWith: "World" } })).toBe(true);
      expect(
        matchesScalarWhere(row, { name: { equals: "HELLO WORLD", mode: "insensitive" } })
      ).toBe(true);
    });

    it("matches AND/OR/NOT nesting", () => {
      expect(
        matchesScalarWhere(row, { AND: [{ status: "active" }, { priority: { gte: 2 } }] })
      ).toBe(true);
      expect(
        matchesScalarWhere(row, { OR: [{ status: "closed" }, { priority: 3 }] })
      ).toBe(true);
      expect(matchesScalarWhere(row, { OR: [{ status: "closed" }] })).toBe(false);
      expect(matchesScalarWhere(row, { NOT: [{ status: "active" }] })).toBe(false);
      expect(matchesScalarWhere(row, { NOT: { status: "closed" } })).toBe(true);
    });

    it("matches empty where and skips relation filters", () => {
      expect(matchesScalarWhere(row, {})).toBe(true);
      expect(matchesScalarWhere(row, undefined)).toBe(true);
      // Relation filters are resolved by the data layer, not here.
      expect(matchesScalarWhere(row, { messages: { none: { role: "x" } } })).toBe(true);
    });
  });

  describe("sortRows", () => {
    const rows = [
      { id: "a", createdAt: new Date("2026-01-03"), name: "b" },
      { id: "b", createdAt: new Date("2026-01-01"), name: "a" },
      { id: "c", createdAt: new Date("2026-01-02"), name: "c" },
    ];
    it("sorts asc/desc on scalar fields", () => {
      expect(sortRows(rows, { createdAt: "asc" }).map((r) => r.id)).toEqual([
        "b",
        "c",
        "a",
      ]);
      expect(sortRows(rows, { createdAt: "desc" }).map((r) => r.id)).toEqual([
        "a",
        "c",
        "b",
      ]);
      expect(sortRows(rows, { name: "asc" }).map((r) => r.id)).toEqual([
        "b",
        "a",
        "c",
      ]);
    });
    it("sorts nulls first on asc (Postgres semantics)", () => {
      const withNull = [...rows, { id: "d", createdAt: null, name: "d" }];
      expect(sortRows(withNull, { createdAt: "asc" })[0].id).toBe("d");
      expect(sortRows(withNull, { createdAt: "desc" })[3].id).toBe("d");
    });
  });

  describe("projectSelect", () => {
    it("picks scalar fields only", () => {
      const row = { id: "1", name: "x", secret: "y" };
      expect(projectSelect(row, { id: true, name: true })).toEqual({
        id: "1",
        name: "x",
      });
      expect(projectSelect(row, { id: true, secret: false })).toEqual({ id: "1" });
    });
  });

  describe("stripUndefined", () => {
    it("drops undefined keys recursively", () => {
      expect(stripUndefined({ a: 1, b: undefined, c: { d: undefined, e: 2 } })).toEqual({
        a: 1,
        c: { e: 2 },
      });
    });
  });

  describe("applyFieldUpdate", () => {
    it("applies increment/decrement/set", () => {
      expect(applyFieldUpdate(5, { increment: 2 })).toBe(7);
      expect(applyFieldUpdate(5, { decrement: 2 })).toBe(3);
      expect(applyFieldUpdate(5, { set: 9 })).toBe(9);
      expect(applyFieldUpdate(5, 9)).toBe(9);
    });
  });

  describe("extractEquality", () => {
    it("finds top-level and AND-nested equalities", () => {
      expect(extractEquality({ id: "x" }, "id")).toBe("x");
      expect(extractEquality({ AND: [{ id: "y" }] }, "id")).toBe("y");
      expect(extractEquality({ AND: [{ a: 1 }, { businessId: "b" }] }, "businessId")).toBe("b");
      expect(extractEquality({ id: { equals: "z" } }, "id")).toBe("z");
      expect(extractEquality({ id: { in: ["z"] } }, "id")).toBeUndefined();
      expect(extractEquality({}, "id")).toBeUndefined();
    });
  });

  describe("valuesEqual / compareValues", () => {
    it("compares dates by instant", () => {
      expect(valuesEqual(new Date("2026-01-01"), new Date("2026-01-01T00:00:00.000Z"))).toBe(true);
      expect(compareValues(new Date("2026-01-02"), new Date("2026-01-01"))).toBe(1);
    });
  });
});
