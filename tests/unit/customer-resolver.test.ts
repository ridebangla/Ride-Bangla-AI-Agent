import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { resolveCustomer, normalizePhone } from "@/lib/customer-resolver";

const mockPrisma = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;

describe("Customer Resolver", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockPrisma.customer.findFirst.mockResolvedValue(null);
    mockPrisma.customer.findUnique.mockResolvedValue(null);
    mockPrisma.customer.create.mockResolvedValue({ id: "new-cust-1" });
    mockPrisma.customer.update.mockResolvedValue({});
  });

  describe("normalizePhone", () => {
    it("should strip @c.us suffix", () => {
      expect(normalizePhone("5551234567@c.us")).toBe("5551234567");
    });

    it("should strip @s.whatsapp.net suffix", () => {
      expect(normalizePhone("5551234567@s.whatsapp.net")).toBe("5551234567");
    });

    it("should keep leading + and strip other non-digits", () => {
      expect(normalizePhone("+1 (555) 123-4567")).toBe("+15551234567");
    });

    it("should handle already clean numbers", () => {
      expect(normalizePhone("+15551234567")).toBe("+15551234567");
    });
  });

  describe("resolveCustomer", () => {
    it("should find customer by email (direct match)", async () => {
      mockPrisma.customer.findFirst.mockResolvedValueOnce({
        id: "cust-1",
        name: "John",
        email: "john@test.com",
        phone: "",
        whatsapp: "",
      });
      mockPrisma.customer.findUnique.mockResolvedValue({
        name: "John",
        email: "john@test.com",
        phone: "",
        whatsapp: "",
      });

      const result = await resolveCustomer("email", "john@test.com", "John");
      expect(result).toBe("cust-1");
    });

    it("should find customer by whatsapp number", async () => {
      mockPrisma.customer.findFirst.mockResolvedValueOnce({
        id: "cust-2",
        name: "Jane",
        whatsapp: "5551234567@c.us",
      });
      mockPrisma.customer.findUnique.mockResolvedValue({
        name: "Jane",
        email: "",
        phone: "",
        whatsapp: "5551234567@c.us",
      });

      const result = await resolveCustomer("whatsapp", "5551234567@c.us", "Jane");
      expect(result).toBe("cust-2");
    });

    it("should auto-create customer when not found", async () => {
      // All findFirst calls return null
      mockPrisma.customer.findFirst.mockResolvedValue(null);
      mockPrisma.customer.create.mockResolvedValue({ id: "new-cust" });

      const result = await resolveCustomer("email", "new@test.com", "New User");

      expect(result).toBe("new-cust");
      expect(mockPrisma.customer.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          name: "New User",
          email: "new@test.com",
        }),
      });
    });

    it("should create customer with phone field for phone channel", async () => {
      mockPrisma.customer.findFirst.mockResolvedValue(null);
      mockPrisma.customer.create.mockResolvedValue({ id: "phone-cust" });

      await resolveCustomer("phone", "+15551234567", "Phone Caller");

      expect(mockPrisma.customer.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          phone: "+15551234567",
        }),
      });
    });

    it("should update lastContact on existing customer", async () => {
      mockPrisma.customer.findFirst.mockResolvedValueOnce({
        id: "existing-1",
        name: "Existing User",
      });
      mockPrisma.customer.findUnique.mockResolvedValue({
        name: "Existing User",
        email: "existing@test.com",
        phone: "",
        whatsapp: "",
      });

      await resolveCustomer("email", "existing@test.com", "Existing User");

      expect(mockPrisma.customer.update).toHaveBeenCalledWith({
        where: { id: "existing-1" },
        data: expect.objectContaining({
          lastContact: expect.any(Date),
        }),
      });
    });

    it("should handle empty customerContact", async () => {
      mockPrisma.customer.create.mockResolvedValue({ id: "empty-contact" });

      const result = await resolveCustomer("api", "", "API User");
      expect(result).toBe("empty-contact");
    });
  });

  describe("normalizePhone — Bangladeshi canonical form (M-1)", () => {
    it("canonicalizes the spaced international form", () => {
      expect(normalizePhone("+880 1711-111111")).toBe("+8801711111111");
    });

    it("canonicalizes the @c.us form and strips the suffix", () => {
      expect(normalizePhone("8801711111111@c.us")).toBe("+8801711111111");
    });

    it("canonicalizes the trunk-zero form", () => {
      expect(normalizePhone("01711111111")).toBe("+8801711111111");
    });

    it("canonicalizes the bare national form", () => {
      expect(normalizePhone("1711111111")).toBe("+8801711111111");
    });

    it("leaves non-BD numbers on the legacy form", () => {
      expect(normalizePhone("+1 (555) 123-4567")).toBe("+15551234567");
      expect(normalizePhone("5551234567")).toBe("5551234567");
    });
  });

  describe("cross-format dedupe (M-1) — one person, one record", () => {
    type Row = {
      id: string;
      name: string;
      email: string;
      phone: string;
      whatsapp: string;
      [k: string]: unknown;
    };
    let rows: Row[];
    let seq: number;

    function matchesWhere(row: Row, where: Record<string, unknown>): boolean {
      if (!where) return true;
      if (Array.isArray(where.OR)) {
        return (where.OR as Record<string, unknown>[]).some((w) => matchesWhere(row, w));
      }
      return Object.entries(where).every(([field, cond]) => {
        const val = String(row[field] ?? "");
        if (typeof cond === "string") return val === cond;
        if (cond && typeof cond === "object") {
          const c = cond as { contains?: string; equals?: string; mode?: string };
          if (c.contains !== undefined) return val.includes(c.contains);
          if (c.equals !== undefined) {
            return c.mode === "insensitive"
              ? val.toLowerCase() === c.equals.toLowerCase()
              : val === c.equals;
          }
        }
        return false;
      });
    }

    beforeEach(() => {
      rows = [];
      seq = 0;
      mockPrisma.customer.findFirst.mockImplementation(
        async ({ where }: { where: Record<string, unknown> }) =>
          rows.find((r) => matchesWhere(r, where)) ?? null
      );
      mockPrisma.customer.create.mockImplementation(async ({ data }: { data: Row }) => {
        const row: Row = {
          email: "",
          phone: "",
          whatsapp: "",
          ...data,
          id: `cust-${++seq}`,
        };
        rows.push(row);
        return row;
      });
      mockPrisma.customer.findUnique.mockImplementation(
        async ({ where }: { where: { id: string } }) =>
          rows.find((r) => r.id === where.id) ?? null
      );
      mockPrisma.customer.update.mockImplementation(
        async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
          const row = rows.find((r) => r.id === where.id);
          if (row) Object.assign(row, data);
          return row ?? {};
        }
      );
    });

    it("whatsapp spaced format, then plain phone → ONE record, both fields canonical", async () => {
      const a = await resolveCustomer("whatsapp", "+880 1711-111111", "Rahim");
      const b = await resolveCustomer("phone", "+8801711111111", "Rahim");

      expect(b).toBe(a);
      expect(rows).toHaveLength(1);
      expect(rows[0].whatsapp).toBe("+8801711111111");
      expect(rows[0].phone).toBe("+8801711111111");
    });

    it("whatsapp @c.us, then trunk-zero phone → ONE record, no suffix stored", async () => {
      const a = await resolveCustomer("whatsapp", "8801711111111@c.us", "Karim");
      const b = await resolveCustomer("phone", "01711111111", "Karim");

      expect(b).toBe(a);
      expect(rows).toHaveLength(1);
      expect(rows[0].whatsapp).toBe("+8801711111111");
      expect(rows[0].whatsapp).not.toContain("@c.us");
      expect(rows[0].phone).toBe("+8801711111111");
    });

    it("trunk-zero phone first, then spaced whatsapp → ONE record (reverse order)", async () => {
      const a = await resolveCustomer("phone", "01711111111", "Jamal");
      const b = await resolveCustomer("whatsapp", "+880 1711-111111", "Jamal");

      expect(b).toBe(a);
      expect(rows).toHaveLength(1);
      expect(rows[0].phone).toBe("+8801711111111");
      expect(rows[0].whatsapp).toBe("+8801711111111");
    });

    it("repeat of the identical whatsapp contact → same record", async () => {
      const a = await resolveCustomer("whatsapp", "8801711111111@c.us", "Selim");
      const b = await resolveCustomer("whatsapp", "8801711111111@c.us", "Selim");

      expect(b).toBe(a);
      expect(rows).toHaveLength(1);
    });

    it("a different number still creates a second record", async () => {
      const a = await resolveCustomer("whatsapp", "8801711111111@c.us", "One");
      const b = await resolveCustomer("whatsapp", "8801912222222@c.us", "Two");

      expect(b).not.toBe(a);
      expect(rows).toHaveLength(2);
    });
  });
});
