import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { prisma } from "@/lib/prisma";
import { resolveCustomer } from "@/lib/customer-resolver";
import {
  recordInteraction,
  likedTopics,
  channelsUsed,
  memoryLineForPrompt,
  atRiskConversations,
  type CustomerMemory,
} from "@/lib/ai/customer-memory";
import {
  decideVoiceTurn,
  validateVoiceAudio,
  detectVoiceReplyLang,
  extractMetaAudioAttachment,
  extractCloudAudioMessage,
  isConfirmAction,
} from "@/lib/ai/voice-input";

const mockPrisma = prisma as unknown as Record<
  string,
  Record<string, ReturnType<typeof vi.fn>>
>;

// Team C (2026-11-03): targeted tests for the files this team owns.
// No live browser, no full-suite run — coordinator runs full gates.

describe("Team C — customer-resolver: SMS is a phone channel", () => {
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
      return (where.OR as Record<string, unknown>[]).some((w) =>
        matchesWhere(row, w)
      );
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
    vi.restoreAllMocks();
    rows = [];
    seq = 0;
    mockPrisma.customer.findFirst.mockImplementation(
      async ({ where }: { where: Record<string, unknown> }) =>
        rows.find((r) => matchesWhere(r, where)) ?? null
    );
    mockPrisma.customer.create.mockImplementation(
      async ({ data }: { data: Row }) => {
        const row: Row = {
          email: "",
          phone: "",
          whatsapp: "",
          ...data,
          id: `cust-${++seq}`,
        };
        rows.push(row);
        return row;
      }
    );
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

  it("sms spaced form, then whatsapp trunk-zero → ONE record, phone canonical", async () => {
    const a = await resolveCustomer("sms", "+880 1711-111111", "Rahim");
    const b = await resolveCustomer("whatsapp", "01711111111", "Rahim");
    expect(b).toBe(a);
    expect(rows).toHaveLength(1);
    expect(rows[0].phone).toBe("+8801711111111");
    expect(rows[0].whatsapp).toBe("+8801711111111");
  });

  it("whatsapp first, then sms bare-digits → ONE record", async () => {
    const a = await resolveCustomer("whatsapp", "8801711111111@c.us", "Karim");
    const b = await resolveCustomer("sms", "8801711111111", "Karim");
    expect(b).toBe(a);
    expect(rows).toHaveLength(1);
  });

  it("a different sms number still creates a second record (no guessing)", async () => {
    const a = await resolveCustomer("sms", "+8801711111111", "One");
    const b = await resolveCustomer("sms", "+8801912222222", "Two");
    expect(b).not.toBe(a);
    expect(rows).toHaveLength(2);
  });
});

describe("Team C — customer-memory pure contract", () => {
  const mem: CustomerMemory = {
    customerRef: "cust-1",
    interactions: [
      { channel: "instagram", kind: "like", topic: "Cake" },
      { channel: "whatsapp", kind: "comment", topic: "cake" },
      { channel: "whatsapp", kind: "message", topic: "delivery" },
      { channel: "instagram", kind: "like", topic: "Bread" },
    ],
  };

  it("recordInteraction appends without mutating", () => {
    const next = recordInteraction(mem, {
      channel: "whatsapp",
      kind: "like",
      topic: "Pie",
    });
    expect(next.interactions).toHaveLength(5);
    expect(mem.interactions).toHaveLength(4);
  });

  it("likedTopics is recent-first and case-deduped; messages excluded", () => {
    expect(likedTopics(mem)).toEqual(["Bread", "cake"]);
  });

  it("channelsUsed is first-seen order", () => {
    expect(channelsUsed(mem)).toEqual(["instagram", "whatsapp"]);
  });

  it("memoryLineForPrompt is one line, empty when nothing liked", () => {
    expect(memoryLineForPrompt(mem, "en")).toContain("Bread");
    expect(
      memoryLineForPrompt({ customerRef: "x", interactions: [] }, "en")
    ).toBe("");
    expect(memoryLineForPrompt(mem, "bn")).toContain("Bread");
  });

  it("atRiskConversations flags only unreplied past-window threads", () => {
    expect(
      atRiskConversations(
        [
          { id: "a", hasAssistantReply: false, ageMinutes: 61 },
          { id: "b", hasAssistantReply: true, ageMinutes: 999 },
          { id: "c", hasAssistantReply: false, ageMinutes: 10 },
        ],
        60
      )
    ).toEqual(["a"]);
  });
});

describe("Team C — voice-input pure decisions", () => {
  it("fail-closed order: download > audio validity > key > transcript", () => {
    expect(
      decideVoiceTurn({
        audioDownloaded: false,
        providerKeyPresent: false,
        transcript: null,
      })
    ).toMatchObject({ kind: "fallback", reason: "download_failed" });
    expect(
      decideVoiceTurn({
        audioDownloaded: true,
        providerKeyPresent: false,
        transcript: "hello",
        audioValidation: { ok: false, error: "audio_too_large" },
      })
    ).toMatchObject({ kind: "fallback", reason: "unsupported_audio" });
    expect(
      decideVoiceTurn({
        audioDownloaded: true,
        providerKeyPresent: false,
        transcript: "hello",
      })
    ).toMatchObject({ kind: "fallback", reason: "no_key" });
    expect(
      decideVoiceTurn({
        audioDownloaded: true,
        providerKeyPresent: true,
        transcript: "   ",
      })
    ).toMatchObject({ kind: "fallback", reason: "unintelligible" });
  });

  it("routes the verbatim trimmed transcript, never an edited one", () => {
    const d = decideVoiceTurn({
      audioDownloaded: true,
      providerKeyPresent: true,
      transcript: "  hello world  ",
    });
    expect(d).toEqual({
      kind: "route",
      transcript: "hello world",
      replyLang: "en",
    });
  });

  it("validateVoiceAudio refuses missing / non-audio / oversize", () => {
    expect(validateVoiceAudio("audio/webm", 0)).toEqual({
      ok: false,
      error: "audio_missing",
    });
    expect(validateVoiceAudio("image/png", 100)).toEqual({
      ok: false,
      error: "unsupported_audio",
    });
    expect(validateVoiceAudio("audio/webm", 10 * 1024 * 1024 + 1)).toEqual({
      ok: false,
      error: "audio_too_large",
    });
    expect(validateVoiceAudio("audio/webm", 100)).toEqual({ ok: true });
  });

  it("language mirror: setting wins, else Bengali script", () => {
    expect(detectVoiceReplyLang("bn", "hello")).toBe("bn");
    expect(detectVoiceReplyLang("en", "হ্যালো")).toBe("en");
    expect(detectVoiceReplyLang(undefined, "হ্যালো")).toBe("bn");
    expect(detectVoiceReplyLang(undefined, "hello")).toBe("en");
  });

  it("channel classifiers fire on audio only", () => {
    expect(
      extractMetaAudioAttachment({
        attachments: [{ type: "image", payload: { url: "x" } }],
      })
    ).toBeNull();
    expect(
      extractMetaAudioAttachment({
        attachments: [{ type: "audio", payload: { url: "u" } }],
      })
    ).toEqual({ url: "u" });
    expect(
      extractCloudAudioMessage({ type: "text", text: { body: "hi" } })
    ).toBeNull();
    expect(
      extractCloudAudioMessage({
        type: "audio",
        audio: { id: "m1", mime_type: "audio/ogg" },
      })
    ).toEqual({ mediaId: "m1", mimeType: "audio/ogg" });
  });

  it("voice turns can never name a confirm action", () => {
    expect(isConfirmAction("confirm_order")).toBe(true);
    expect(isConfirmAction("chat")).toBe(false);
  });
});

describe("Team C — widget embed source shape (drag persistence + brand)", () => {
  const src = readFileSync(
    path.resolve(__dirname, "../../public/widget/ride-bangla-chat.js"),
    "utf8"
  );
  const brandSrc = readFileSync(
    path.resolve(__dirname, "../../src/app/api/widget/brand/route.ts"),
    "utf8"
  );

  it("bubble position persists in localStorage, not sessionStorage-only", () => {
    expect(src).toContain("window.localStorage.getItem(BUBBLE_POS_KEY)");
    expect(src).toContain("window.localStorage.setItem(BUBBLE_POS_KEY");
    // The only sessionStorage reads/writes left for the bubble key are
    // the legacy-migration path inside bubblePosGet/bubblePosSet.
    expect(src).not.toContain(
      "window.sessionStorage.setItem(BUBBLE_POS_KEY, JSON.stringify(bubblePos))"
    );
    expect(src).not.toContain(
      "window.sessionStorage.getItem(BUBBLE_POS_KEY);\n    } catch (e) {}\n    if (!raw) return;"
    );
  });

  it("brand route answers the public record to any origin (tenant embeds)", () => {
    expect(brandSrc).toContain('"Access-Control-Allow-Origin": "*"');
    expect(brandSrc).not.toContain("ALLOWED_ORIGINS");
    expect(brandSrc).not.toContain("Origin not allowed");
  });

  it("widget still carries the single typing + auto-grow + mascot contracts", () => {
    // One typing bubble per send site; retract never re-adds it.
    expect(src).toContain('addMessage(t("typing"), "bot typing")');
    expect(src).toContain("Math.floor(panel.clientHeight * 0.45)");
    expect(src).toContain('class="rbai-vid rbai-vid-idle active"');
    expect(src).toContain("rbai-vid-working");
    expect(src).not.toContain("wa.me");
  });
});
