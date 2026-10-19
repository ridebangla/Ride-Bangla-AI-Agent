/**
 * landing-premium.test.ts — unit tests for the premium landing polish:
 * theme registry + color math (landing-themes), AI copy seam
 * (landing-copy), and the quality gate (landing-quality).
 *
 * Pure functions only — no network, no database.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  sanitizeLandingTheme,
  getLandingThemeMeta,
  shade,
  relativeLuminance,
  contrastRatio,
  bestTextOn,
  themePalette,
  themeContrastPairs,
  LANDING_THEME_IDS,
  DEFAULT_LANDING_THEME,
} from "@/lib/landing-themes";
import {
  applyAiCopyOverrides,
  sanitizeAiCopyResult,
  refineCopyWithAI,
  type LandingCopy,
} from "@/lib/landing-copy";
import {
  evaluateQuality,
  checkImageUrl,
  summarizeQualityForRecord,
  type ImageCheckResult,
} from "@/lib/landing-quality";
import type { PublicLandingData } from "@/lib/landing";

const BASE_COPY: LandingCopy = {
  tagline: "Fresh cakes daily",
  heroSubtext: "Browse our products below.",
  aboutHeading: "About Test Bakery",
  aboutText: "We bake fresh cakes every morning in Dhaka.",
  productsHeading: "Our Products & Services",
  contactHeading: "Get in Touch",
  footerLine: "© 2026 Test Bakery. All rights reserved.",
};

function fakeData(overrides: Partial<PublicLandingData> = {}): PublicLandingData {
  return {
    business: {
      name: "Test Bakery",
      slug: "test-bakery",
      siteKey: "rbsite-test123",
      tagline: "Fresh cakes daily",
      brandColor: "#0B7A55",
      logoUrl: "https://example.com/logo.png",
      websiteUrl: null,
      landingPublished: true,
    },
    theme: "modern-minimal",
    aiSuggestedTheme: null,
    copy: { ...BASE_COPY },
    products: [
      {
        name: "Chocolate Cake",
        description: "Rich chocolate sponge",
        price: 850,
        currency: "BDT",
        imageUrl: "https://example.com/cake.jpg",
        categoryName: "Cakes",
      },
    ],
    productGroups: [
      {
        categoryName: "Cakes",
        products: [
          {
            name: "Chocolate Cake",
            description: "Rich chocolate sponge",
            price: 850,
            currency: "BDT",
            imageUrl: "https://example.com/cake.jpg",
            categoryName: "Cakes",
          },
        ],
      },
    ],
    aboutEntries: [],
    hours: { monday: "9am - 9pm" },
    contact: {
      welcomeMessage: "Hi! How can we help?",
      whatsappPhone: "+8801700000000",
      email: "hello@example.com",
    },
    ...overrides,
  };
}

describe("landing themes", () => {
  it("sanitizes theme ids fail-closed", () => {
    for (const id of LANDING_THEME_IDS) expect(sanitizeLandingTheme(id)).toBe(id);
    expect(sanitizeLandingTheme("nope")).toBe(DEFAULT_LANDING_THEME);
    expect(sanitizeLandingTheme("")).toBe(DEFAULT_LANDING_THEME);
    expect(sanitizeLandingTheme(null)).toBe(DEFAULT_LANDING_THEME);
    expect(sanitizeLandingTheme(undefined)).toBe(DEFAULT_LANDING_THEME);
    expect(sanitizeLandingTheme(" Modern-Minimal ")).toBe(DEFAULT_LANDING_THEME); // case-sensitive
  });

  it("exposes 4 distinct theme metas", () => {
    expect(LANDING_THEME_IDS).toHaveLength(4);
    const names = LANDING_THEME_IDS.map((id) => getLandingThemeMeta(id).name);
    expect(new Set(names).size).toBe(4);
  });

  it("shade() darkens and lightens", () => {
    expect(shade("#000000", 1)).toBe("#FFFFFF");
    expect(shade("#FFFFFF", -1)).toBe("#000000");
    expect(shade("#0B7A55", 0)).toBe("#0B7A55");
  });

  it("computes WCAG luminance and contrast", () => {
    expect(relativeLuminance("#000000")).toBeCloseTo(0, 5);
    expect(relativeLuminance("#FFFFFF")).toBeCloseTo(1, 5);
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 1);
    expect(contrastRatio("#0B7A55", "#0B7A55")).toBeCloseTo(1, 5);
  });

  it("picks readable text on brand", () => {
    expect(bestTextOn("#0B7A55")).toBe("#FFFFFF");
    expect(bestTextOn("#F5F5F5")).toBe("#101418");
  });

  it("builds per-theme palettes from the brand color", () => {
    const dark = themePalette("dark-premium", "#0B7A55");
    expect(dark.bg).toBe("#0C0E12");
    expect(dark.brand).toBe("#0B7A55");
    const minimal = themePalette("modern-minimal", "#B3123F");
    expect(minimal.brand).toBe("#B3123F");
    expect(minimal.bg).toBe("#FFFFFF");
    // CTA text must be readable on the CTA background in every theme.
    for (const id of LANDING_THEME_IDS) {
      const p = themePalette(id, "#0B7A55");
      expect(contrastRatio(p.ctaInk, p.ctaBg)).toBeGreaterThanOrEqual(3);
    }
  });

  it("exposes contrast pairs for the quality gate", () => {
    for (const id of LANDING_THEME_IDS) {
      const pairs = themeContrastPairs(id, "#0B7A55");
      expect(pairs.map((p) => p.id)).toEqual([
        "contrast.hero",
        "contrast.body",
        "contrast.cta",
        "contrast.muted",
      ]);
      for (const pair of pairs) {
        expect(pair.fg).toMatch(/^#[0-9A-F]{6}$/);
        expect(pair.bg).toMatch(/^#[0-9A-F]{6}$/);
      }
    }
  });
});

describe("AI copy seam", () => {
  it("merges AI overrides field-by-field (non-empty wins)", () => {
    const merged = applyAiCopyOverrides(BASE_COPY, {
      tagline: "  Baked at dawn, gone by noon  ",
      heroSubtext: "",
      aboutText: null,
    });
    expect(merged.tagline).toBe("Baked at dawn, gone by noon");
    expect(merged.heroSubtext).toBe(BASE_COPY.heroSubtext);
    expect(merged.aboutText).toBe(BASE_COPY.aboutText);
  });

  it("returns rule copy untouched when no AI overrides", () => {
    expect(applyAiCopyOverrides(BASE_COPY, null)).toBe(BASE_COPY);
    expect(applyAiCopyOverrides(BASE_COPY, undefined)).toBe(BASE_COPY);
  });

  it("sanitizes model JSON (caps, valid theme)", () => {
    const sane = sanitizeAiCopyResult(
      {
        tagline: "x".repeat(500),
        heroSubtext: "Lovely hero",
        suggestedTheme: "elegant-serif",
        bogus: 123,
      },
      BASE_COPY
    );
    expect(sane).not.toBeNull();
    expect(sane!.copy.tagline).toHaveLength(160);
    expect(sane!.copy.heroSubtext).toBe("Lovely hero");
    expect(sane!.copy.aboutHeading).toBe(BASE_COPY.aboutHeading);
    expect(sane!.suggestedTheme).toBe("elegant-serif");
  });

  it("rejects invalid theme suggestions and empty payloads", () => {
    const badTheme = sanitizeAiCopyResult({ tagline: "ok", suggestedTheme: "neon" }, BASE_COPY);
    expect(badTheme!.suggestedTheme).toBeNull();
    expect(sanitizeAiCopyResult({ nope: true }, BASE_COPY)).toBeNull();
    expect(sanitizeAiCopyResult(null, BASE_COPY)).toBeNull();
    expect(sanitizeAiCopyResult("string", BASE_COPY)).toBeNull();
  });

  it("falls back gracefully without OPENAI_API_KEY", async () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const result = await refineCopyWithAI(BASE_COPY, "Test Bakery");
      expect(result.aiEnhanced).toBe(false);
      expect(result.note).toBe("no-key");
      expect(result.copy).toBe(BASE_COPY);
      expect(result.suggestedTheme).toBeNull();
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
    }
  });
});

describe("quality gate", () => {
  const okImages: ImageCheckResult[] = [
    { url: "https://example.com/logo.png", label: "logo", ok: true, status: 200 },
    { url: "https://example.com/cake.jpg", label: "Chocolate Cake", ok: true, status: 200 },
  ];

  it("passes on good data and matches the Phase 6 status shape", () => {
    const status = evaluateQuality(fakeData(), okImages, "2026-10-19T12:00:00.000Z");
    expect(status.slug).toBe("test-bakery");
    expect(status.theme).toBe("modern-minimal");
    expect(status.ready).toBe(true);
    expect(status.fails).toBe(0);
    expect(status.checkedAt).toBe("2026-10-19T12:00:00.000Z");
    // Phase 6 contract: every check has a stable id, label, status, detail.
    for (const c of status.checks) {
      expect(typeof c.id).toBe("string");
      expect(typeof c.label).toBe("string");
      expect(["pass", "warn", "fail"]).toContain(c.status);
      expect(typeof c.detail).toBe("string");
    }
    const ids = status.checks.map((c) => c.id);
    for (const required of [
      "seo.title",
      "seo.description",
      "seo.og-image",
      "branding.logo",
      "sections.hero",
      "sections.products",
      "sections.about",
      "sections.widget",
      "contrast.hero",
      "contrast.body",
      "contrast.cta",
    ]) {
      expect(ids).toContain(required);
    }
  });

  it("flags broken product images as fail (not ready)", () => {
    const broken: ImageCheckResult[] = [
      { url: "https://example.com/logo.png", label: "logo", ok: true, status: 200 },
      {
        url: "https://example.com/missing.jpg",
        label: "Chocolate Cake",
        ok: false,
        status: 404,
        error: "HTTP 404",
      },
    ];
    const status = evaluateQuality(fakeData(), broken);
    expect(status.ready).toBe(false);
    expect(status.fails).toBeGreaterThanOrEqual(1);
    const imgCheck = status.checks.find((c) => c.id.startsWith("images.product"));
    expect(imgCheck?.status).toBe("fail");
    expect(imgCheck?.detail).toContain("BROKEN");
  });

  it("warns (not fails) on missing logo, products, hours", () => {
    const data = fakeData({
      business: { ...fakeData().business, logoUrl: null },
      products: [],
      productGroups: [],
      hours: null,
      contact: { welcomeMessage: "Hi", whatsappPhone: null, email: null },
    });
    const status = evaluateQuality(data, []);
    expect(status.ready).toBe(true); // warnings never block
    expect(status.warnings).toBeGreaterThanOrEqual(3);
    expect(status.checks.find((c) => c.id === "branding.logo")?.status).toBe("warn");
    expect(status.checks.find((c) => c.id === "sections.products")?.status).toBe("warn");
  });

  it("never ships unreadable contrast: palette backstop holds across themes and brands", () => {
    // The palettes are constructed for readability (bestTextOn etc.); the
    // gate's contrast checks are a backstop. Assert the backstop never fires
    // "fail" for a spread of real-world brand colors on any theme.
    const brands = ["#0B7A55", "#B3123F", "#1D4ED8", "#F59E0B", "#111111", "#777777", "#FFFFFF"];
    for (const theme of LANDING_THEME_IDS) {
      for (const brandColor of brands) {
        const data = fakeData({
          theme,
          business: { ...fakeData().business, brandColor },
        });
        const status = evaluateQuality(data, []);
        const contrastFails = status.checks.filter(
          (c) => c.id.startsWith("contrast.") && c.status === "fail"
        );
        expect(contrastFails).toEqual([]);
      }
    }
  });

  it("summarizes the record shape for persistence", () => {
    const status = evaluateQuality(fakeData(), okImages);
    expect(summarizeQualityForRecord(status)).toEqual({
      ready: status.ready,
      fails: status.fails,
      warnings: status.warnings,
      checkedAt: status.checkedAt,
    });
  });
});

describe("checkImageUrl", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("treats 2xx/3xx as ok", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    const r = await checkImageUrl("https://example.com/a.png", "logo", 1000, fetchImpl);
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
  });

  it("treats 404 as broken", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
    const r = await checkImageUrl("https://example.com/a.png", "logo", 1000, fetchImpl);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("404");
  });

  it("falls back to ranged GET when HEAD is rejected", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "HEAD") return new Response(null, { status: 405 });
      return new Response(null, { status: 206 });
    }) as unknown as typeof fetch;
    const r = await checkImageUrl("https://example.com/a.png", "logo", 1000, fetchImpl);
    expect(r.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("refuses non-http(s) URLs without fetching", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    const r = await checkImageUrl("ftp://example.com/a.png", "logo", 1000, fetchImpl);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("protocol");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports timeouts instead of throwing", async () => {    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
          );
        })
    ) as unknown as typeof fetch;
    const r = await checkImageUrl("https://example.com/a.png", "logo", 50, fetchImpl);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("timed out");
  });
});
