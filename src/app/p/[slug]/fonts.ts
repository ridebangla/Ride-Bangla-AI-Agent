/**
 * fonts.ts — self-hosted display fonts for the premium landing themes.
 *
 * Loaded via next/font/google (same mechanism the app shell already uses),
 * so there is zero runtime font-fetch cost beyond the subsetted woff2
 * files. Each theme references these through CSS variables declared in
 * `src/lib/landing-themes.ts` (e.g. `var(--lp-f-playfair)`).
 *
 * Bengali business names/descriptions fall back gracefully to system
 * fonts for glyphs outside the latin subset.
 */
import { Inter, Space_Grotesk, Playfair_Display, Lora, Sora } from "next/font/google";

export const lpFontInter = Inter({
  subsets: ["latin"],
  variable: "--lp-f-inter",
  display: "swap",
});

export const lpFontGrotesk = Space_Grotesk({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--lp-f-grotesk",
  display: "swap",
});

export const lpFontPlayfair = Playfair_Display({
  subsets: ["latin"],
  weight: ["600", "700", "800"],
  style: ["normal", "italic"],
  variable: "--lp-f-playfair",
  display: "swap",
});

export const lpFontLora = Lora({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
  variable: "--lp-f-lora",
  display: "swap",
});

export const lpFontSora = Sora({
  subsets: ["latin"],
  weight: ["400", "600", "700", "800"],
  variable: "--lp-f-sora",
  display: "swap",
});

/** All font variables, applied once on the landing page root element. */
export const lpFontVariables = [
  lpFontInter.variable,
  lpFontGrotesk.variable,
  lpFontPlayfair.variable,
  lpFontLora.variable,
  lpFontSora.variable,
].join(" ");
