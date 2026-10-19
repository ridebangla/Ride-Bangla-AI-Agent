/**
 * landing-themes.ts — Premium design system foundation for auto-generated
 * landing pages (`/p/[slug]`).
 *
 * Four hand-crafted theme variants (modern-minimal, bold-color,
 * elegant-serif, dark-premium) so tenant pages never look identical. Each
 * theme defines its own typography pairing, palette derivation from the
 * business's brand color, and section styling; the themed page itself lives
 * in `src/app/p/[slug]/theme-page.tsx`.
 *
 * The business's choice is stored as `businesses.landingTheme` (validated
 * on write by the API; sanitized on read here — fail-closed to
 * `modern-minimal`).
 *
 * Also home to the color utilities shared by the renderer and the quality
 * gate (`src/lib/landing-quality.ts`): shade(), relativeLuminance(),
 * contrastRatio(), bestTextOn().
 */

export const LANDING_THEME_IDS = [
  "modern-minimal",
  "bold-color",
  "elegant-serif",
  "dark-premium",
] as const;

export type LandingThemeId = (typeof LANDING_THEME_IDS)[number];

export const DEFAULT_LANDING_THEME: LandingThemeId = "modern-minimal";

export interface LandingThemeMeta {
  id: LandingThemeId;
  /** Short display name for the dashboard theme picker. */
  name: string;
  /** One-line description for the dashboard theme picker. */
  description: string;
  /** Representative colors for the picker's visual swatch. */
  swatch: { bg: string; fg: string; accent: string };
  /**
   * Font CSS-variable references (defined by next/font in
   * `src/app/p/[slug]/fonts.ts`). Kept as strings so this module stays
   * importable from API routes and tests without pulling in next/font.
   */
  fonts: { display: string; body: string };
}

export const LANDING_THEMES: LandingThemeMeta[] = [
  {
    id: "modern-minimal",
    name: "Minimal",
    description: "Airy, light, and refined — generous whitespace, quiet typography.",
    swatch: { bg: "#FFFFFF", fg: "#14181D", accent: "#0B7A55" },
    fonts: { display: "var(--lp-f-inter)", body: "var(--lp-f-inter)" },
  },
  {
    id: "bold-color",
    name: "Bold",
    description: "High-energy brand color, big display type, playful shapes.",
    swatch: { bg: "#0B7A55", fg: "#FFFFFF", accent: "#14181D" },
    fonts: { display: "var(--lp-f-grotesk)", body: "var(--lp-f-inter)" },
  },
  {
    id: "elegant-serif",
    name: "Elegant",
    description: "Classic serif luxury — ivory tones, hairline rules, italic accents.",
    swatch: { bg: "#FDFCF9", fg: "#23201A", accent: "#8A6D3B" },
    fonts: { display: "var(--lp-f-playfair)", body: "var(--lp-f-lora)" },
  },
  {
    id: "dark-premium",
    name: "Noir",
    description: "Dark, cinematic, premium — glowing accents on near-black.",
    swatch: { bg: "#0C0E12", fg: "#F4F6F8", accent: "#0B7A55" },
    fonts: { display: "var(--lp-f-sora)", body: "var(--lp-f-inter)" },
  },
];

/** Fail-closed theme parsing: unknown/empty values become the default. */
export function sanitizeLandingTheme(input: unknown): LandingThemeId {
  if (typeof input === "string") {
    const v = input.trim() as LandingThemeId;
    if ((LANDING_THEME_IDS as readonly string[]).includes(v)) return v;
  }
  return DEFAULT_LANDING_THEME;
}

export function getLandingThemeMeta(id: LandingThemeId): LandingThemeMeta {
  return LANDING_THEMES.find((t) => t.id === id) ?? LANDING_THEMES[0];
}

/* ------------------------------------------------------------------ */
/* Color utilities                                                     */
/* ------------------------------------------------------------------ */

/** Normalize to a 6-digit uppercase #rrggbb (no validation — use sanitizeBrandColor first). */
function norm(hex: string): string {
  let h = hex.trim();
  if (h.length === 4) h = "#" + h.slice(1).split("").map((c) => c + c).join("");
  return h.toUpperCase();
}

function rgb(hex: string): [number, number, number] {
  const h = norm(hex);
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Darken/lighten a #rrggbb hex by `amount` (-1..1). */
export function shade(hex: string, amount: number): string {
  const [r, g, b] = rgb(hex);
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const f = (v: number) => (amount >= 0 ? v + (255 - v) * amount : v * (1 + amount));
  const out = (clamp(f(r)) << 16) | (clamp(f(g)) << 8) | clamp(f(b));
  return `#${out.toString(16).padStart(6, "0").toUpperCase()}`;
}

/**
 * WCAG relative luminance of a #rrggbb color (0 = black, 1 = white).
 * https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
 */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two #rrggbb colors (1..21). */
export function contrastRatio(fgHex: string, bgHex: string): number {
  const l1 = relativeLuminance(fgHex);
  const l2 = relativeLuminance(bgHex);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Pick the readable text color for a brand-colored background: white or
 * near-black, whichever has the better contrast ratio.
 */
export function bestTextOn(bgHex: string): "#FFFFFF" | "#101418" {
  const white = contrastRatio("#FFFFFF", bgHex);
  const dark = contrastRatio("#101418", bgHex);
  return white >= dark ? "#FFFFFF" : "#101418";
}

/* ------------------------------------------------------------------ */
/* Per-theme palettes (derived from the business brand color)          */
/* ------------------------------------------------------------------ */

export interface ThemePalette {
  brand: string;
  brandDark: string;
  brandLight: string;
  /** Readable text color on a solid brand background. */
  onBrand: string;
  /** Page background / alt section background. */
  bg: string;
  bgAlt: string;
  /** Card surface. */
  surface: string;
  /** Primary / secondary text. */
  ink: string;
  muted: string;
  /** Borders / hairlines. */
  line: string;
  /** Hero background (CSS value) and hero text color. */
  heroBg: string;
  heroInk: string;
  heroMuted: string;
  /** Primary CTA colors. */
  ctaBg: string;
  ctaInk: string;
}

/**
 * Build the full concrete palette for a theme from the (sanitized) brand
 * color. Every color the themed page renders comes from here, so the
 * quality gate can evaluate the exact pairs a visitor sees.
 */
export function themePalette(theme: LandingThemeId, brandColor: string): ThemePalette {
  const brand = norm(brandColor);
  const brandDark = shade(brand, -0.3);
  const brandLight = shade(brand, 0.88);
  const onBrand = bestTextOn(brand);

  switch (theme) {
    case "bold-color":
      return {
        brand, brandDark, brandLight, onBrand,
        bg: "#FFFFFF",
        bgAlt: shade(brand, 0.94),
        surface: "#FFFFFF",
        ink: "#14181D",
        muted: "#5B6470",
        line: "#E8EAED",
        heroBg: `radial-gradient(1100px 480px at 85% -10%, ${shade(brand, 0.25)} 0%, transparent 60%), radial-gradient(900px 520px at 8% 110%, ${brandDark} 0%, transparent 55%), linear-gradient(135deg, ${brandDark} 0%, ${brand} 55%, ${shade(brand, 0.18)} 100%)`,
        heroInk: bestTextOn(brandDark),
        heroMuted: bestTextOn(brandDark) === "#FFFFFF" ? "rgba(255,255,255,0.82)" : "rgba(16,20,24,0.72)",
        ctaBg: "#14181D",
        ctaInk: "#FFFFFF",
      };
    case "elegant-serif":
      return {
        brand, brandDark, brandLight, onBrand,
        bg: "#FDFCF9",
        bgAlt: "#F6F1E7",
        surface: "#FFFFFF",
        ink: "#23201A",
        muted: "#6E675C",
        line: "#E7DFD0",
        heroBg: `radial-gradient(1000px 420px at 50% -10%, ${shade(brand, 0.72)} 0%, transparent 55%), #FDFCF9`,
        heroInk: "#23201A",
        heroMuted: "#6E675C",
        ctaBg: brandDark,
        ctaInk: bestTextOn(brandDark),
      };
    case "dark-premium":
      return {
        brand, brandDark, brandLight, onBrand,
        bg: "#0C0E12",
        bgAlt: "#11141A",
        surface: "#161A21",
        ink: "#F4F6F8",
        muted: "#9AA3AF",
        line: "#232833",
        heroBg: `radial-gradient(1000px 500px at 50% -12%, ${shade(brand, -0.05)} 0%, transparent 62%), radial-gradient(700px 380px at 88% 108%, ${shade(brand, -0.35)} 0%, transparent 60%), #0C0E12`,
        heroInk: "#F4F6F8",
        heroMuted: "#B7BEC9",
        ctaBg: brand,
        ctaInk: onBrand,
      };
    case "modern-minimal":
    default:
      return {
        brand, brandDark, brandLight, onBrand,
        bg: "#FFFFFF",
        bgAlt: "#F7F8F7",
        surface: "#FFFFFF",
        ink: "#14181D",
        muted: "#5B6470",
        line: "#E8EAED",
        heroBg: `radial-gradient(900px 420px at 50% -8%, ${shade(brand, 0.82)} 0%, transparent 58%), #FFFFFF`,
        heroInk: "#14181D",
        heroMuted: "#5B6470",
        ctaBg: brand,
        ctaInk: onBrand,
      };
  }
}

export interface ContrastPair {
  /** Stable id used by the quality gate (e.g. "contrast.hero"). */
  id: string;
  label: string;
  fg: string;
  bg: string;
}

/**
 * The exact foreground/background pairs a visitor reads, per theme.
 * Consumed by `checkLandingQuality()` — keep in sync with theme-page.tsx.
 * For gradient heroes the darkest brand stop is used as the solid
 * approximation (worst case for light text).
 */
export function themeContrastPairs(theme: LandingThemeId, brandColor: string): ContrastPair[] {
  const p = themePalette(theme, brandColor);
  const heroSolid =
    theme === "bold-color" ? p.brandDark : theme === "dark-premium" ? "#0C0E12" : p.bg;
  return [
    { id: "contrast.hero", label: "Hero text on hero background", fg: p.heroInk, bg: heroSolid },
    { id: "contrast.body", label: "Body text on page background", fg: p.ink, bg: p.bg },
    { id: "contrast.cta", label: "CTA text on CTA button", fg: p.ctaInk, bg: p.ctaBg },
    { id: "contrast.muted", label: "Secondary text on page background", fg: p.muted, bg: p.bg },
  ];
}
