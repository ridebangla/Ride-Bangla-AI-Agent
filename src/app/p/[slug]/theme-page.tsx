/**
 * theme-page.tsx — premium themed renderer for public landing pages.
 *
 * Server component. Picks one of the four hand-crafted themes from
 * `src/lib/landing-themes.ts` (via `data.theme`, resolved in
 * `getLandingData()`) and renders the full page: sticky nav, hero, category
 * showcase, product grid, about, testimonials (only from REAL knowledge-base
 * entries tagged review/testimonial — never invented), contact + hours,
 * footer, and the business's embedded chat widget.
 *
 * Design notes:
 * - Typography comes from self-hosted next/font families (see fonts.ts);
 *   Bengali glyphs fall back to system fonts gracefully.
 * - Scroll reveal is a tiny IntersectionObserver wrapper (reveal.tsx) —
 *   no animation libraries, no heavy deps.
 * - A `<!--lp-theme:<id>-->` HTML comment + `data-theme` attribute mark
 *   the active theme for verification tooling.
 */

import { ChatCtaButton } from "./chat-cta";
import { Reveal } from "./reveal";
import { lpFontVariables } from "./fonts";
import {
  getLandingThemeMeta,
  themePalette,
  type LandingThemeId,
  type ThemePalette,
} from "@/lib/landing-themes";
import type { PublicLandingData } from "@/lib/landing";
import type { LandingProduct } from "@/lib/landing-copy";

/* ------------------------------------------------------------------ */
/* Small shared primitives                                             */
/* ------------------------------------------------------------------ */

function formatPrice(p: { price?: number | null; currency?: string | null }): string | null {
  if (p.price === null || p.price === undefined) return null;
  const cur = p.currency || "BDT";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: cur,
      maximumFractionDigits: 2,
    }).format(p.price);
  } catch {
    return `${cur} ${p.price}`;
  }
}

function Monogram({
  name,
  className = "",
  label,
}: {
  name: string;
  className?: string;
  label?: string;
}) {
  const initial = (name.trim()[0] || "?").toUpperCase();
  return (
    <div className={`lp-monogram ${className}`} aria-label={label ?? `${name} logo`}>
      {initial}
    </div>
  );
}

function Logo({
  name,
  logoUrl,
  className = "",
}: {
  name: string;
  logoUrl: string | null;
  className?: string;
}) {
  if (logoUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={logoUrl} alt={`${name} logo`} className={`lp-logo ${className}`} />;
  }
  return <Monogram name={name} className={className} />;
}

function ProductCard({ p, pal }: { p: LandingProduct; pal: ThemePalette }) {
  return (
    <div className="lp-card">
      {p.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={p.imageUrl} alt={p.name} loading="lazy" className="lp-card-img" />
      ) : (
        <div className="lp-card-ph" aria-hidden>
          <span>{(p.name.trim()[0] || "?").toUpperCase()}</span>
        </div>
      )}
      <div className="lp-card-body">
        <h3 className="lp-card-name">{p.name}</h3>
        {p.description && (
          <p className="lp-card-desc">
            {p.description.slice(0, 140)}
            {p.description.length > 140 ? "…" : ""}
          </p>
        )}
        <div className="lp-card-foot">
          {formatPrice(p) ? (
            <span className="lp-price">{formatPrice(p)}</span>
          ) : (
            <span className="lp-price-na">Contact for price</span>
          )}
          <ChatCtaButton label="Order" background={pal.ctaBg} color={pal.ctaInk} small />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Theme CSS — one <style> block, scoped per theme class                */
/* ------------------------------------------------------------------ */

function themeCss(pal: ThemePalette, theme: LandingThemeId): string {
  const meta = getLandingThemeMeta(theme);
  const root = `
    .lp-${theme} {
      --lp-brand: ${pal.brand}; --lp-brand-dark: ${pal.brandDark}; --lp-brand-light: ${pal.brandLight};
      --lp-on-brand: ${pal.onBrand}; --lp-bg: ${pal.bg}; --lp-bg-alt: ${pal.bgAlt};
      --lp-surface: ${pal.surface}; --lp-ink: ${pal.ink}; --lp-muted: ${pal.muted};
      --lp-line: ${pal.line}; --lp-hero-bg: ${pal.heroBg}; --lp-hero-ink: ${pal.heroInk};
      --lp-hero-muted: ${pal.heroMuted}; --lp-cta-bg: ${pal.ctaBg}; --lp-cta-ink: ${pal.ctaInk};
      --lp-f-display: ${meta.fonts.display}; --lp-f-body: ${meta.fonts.body};
    }`;
  return root + BASE_CSS + PER_THEME_CSS[theme];
}

const BASE_CSS = `
  .lp { font-family: var(--lp-f-body); background: var(--lp-bg); color: var(--lp-ink); -webkit-font-smoothing: antialiased; }
  .lp * { box-sizing: border-box; }
  .lp-wrap { max-width: 1120px; margin: 0 auto; padding: 0 24px; }
  .lp-d { font-family: var(--lp-f-display); }
  /* reveal on scroll */
  .lp-reveal { opacity: 0; transform: translateY(22px); transition: opacity .7s ease, transform .7s cubic-bezier(.22,.61,.36,1); }
  .lp-reveal-on { opacity: 1; transform: none; }
  @media (prefers-reduced-motion: reduce) { .lp-reveal { opacity: 1; transform: none; transition: none; } }
  /* nav */
  .lp-nav { position: sticky; top: 0; z-index: 50; backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); }
  .lp-nav-inner { max-width: 1120px; margin: 0 auto; padding: 14px 24px; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  .lp-brand { display: flex; align-items: center; gap: 12px; font-weight: 700; font-size: 17px; text-decoration: none; color: inherit; }
  .lp-logo { width: 42px; height: 42px; border-radius: 12px; object-fit: cover; background: #fff; }
  .lp-monogram { width: 42px; height: 42px; border-radius: 12px; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 20px; background: var(--lp-brand); color: var(--lp-on-brand); flex-shrink: 0; }
  .lp-nav-links { display: flex; gap: 26px; font-size: 14px; font-weight: 600; }
  .lp-nav-links a { color: var(--lp-muted); text-decoration: none; transition: color .15s; }
  .lp-nav-links a:hover { color: var(--lp-ink); }
  /* CTA buttons (ChatCtaButton renders .lp-cta) */
  .lp-cta { display: inline-block; border: none; cursor: pointer; font-family: var(--lp-f-body); font-weight: 700; font-size: 16px; padding: 15px 34px; border-radius: 999px; box-shadow: 0 8px 24px rgba(0,0,0,.18); transition: transform .16s ease, box-shadow .16s ease, filter .16s ease; text-decoration: none; }
  .lp-cta:hover { transform: translateY(-2px); box-shadow: 0 12px 30px rgba(0,0,0,.22); filter: brightness(1.04); }
  .lp-cta:active { transform: translateY(0); }
  .lp-btn-ghost { display: inline-block; font-weight: 700; font-size: 16px; padding: 14px 32px; border-radius: 999px; text-decoration: none; transition: transform .16s ease, background .16s ease; border: 1.5px solid; }
  .lp-btn-ghost:hover { transform: translateY(-2px); }
  /* hero */
  .lp-hero { position: relative; overflow: hidden; background: var(--lp-hero-bg); color: var(--lp-hero-ink); }
  .lp-hero-inner { position: relative; z-index: 1; max-width: 1120px; margin: 0 auto; padding: 96px 24px 88px; text-align: center; }
  .lp-eyebrow { display: inline-block; font-size: 12.5px; font-weight: 800; letter-spacing: 2.2px; text-transform: uppercase; margin-bottom: 20px; }
  .lp-h1 { font-family: var(--lp-f-display); margin: 0 0 18px; line-height: 1.08; letter-spacing: -0.02em; }
  .lp-tagline { margin: 0 auto 14px; font-size: 20px; line-height: 1.5; max-width: 660px; }
  .lp-sub { margin: 0 auto 34px; font-size: 15.5px; line-height: 1.65; max-width: 580px; color: var(--lp-hero-muted); }
  .lp-hero-ctas { display: flex; gap: 14px; justify-content: center; flex-wrap: wrap; align-items: center; }
  .lp-cat-chips { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; margin-top: 38px; }
  .lp-cat-chip { font-size: 13px; font-weight: 700; padding: 8px 18px; border-radius: 999px; text-decoration: none; transition: transform .15s ease; }
  .lp-cat-chip:hover { transform: translateY(-2px); }
  /* sections */
  .lp-section { padding: 88px 0; }
  .lp-sec-head { margin-bottom: 44px; }
  .lp-sec-title { font-family: var(--lp-f-display); margin: 0 0 10px; font-size: 34px; letter-spacing: -0.015em; line-height: 1.2; }
  .lp-lede { margin: 0; color: var(--lp-muted); font-size: 16.5px; line-height: 1.65; max-width: 640px; }
  .lp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 22px; }
  .lp-card { border-radius: 20px; overflow: hidden; background: var(--lp-surface); transition: transform .18s ease, box-shadow .18s ease, border-color .18s ease; display: flex; flex-direction: column; }
  .lp-card:hover { transform: translateY(-4px); }
  .lp-card-img { width: 100%; height: 180px; object-fit: cover; display: block; background: var(--lp-bg-alt); }
  .lp-card-ph { width: 100%; height: 180px; display: flex; align-items: center; justify-content: center; background: var(--lp-brand-light); }
  .lp-card-ph span { font-family: var(--lp-f-display); font-size: 56px; font-weight: 800; color: var(--lp-brand-dark); opacity: .55; }
  .lp-card-body { padding: 20px; display: flex; flex-direction: column; gap: 8px; flex: 1; }
  .lp-card-name { margin: 0; font-size: 17px; font-weight: 700; line-height: 1.35; }
  .lp-card-desc { margin: 0; font-size: 14px; color: var(--lp-muted); line-height: 1.6; flex: 1; }
  .lp-card-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 6px; }
  .lp-price { font-weight: 800; font-size: 17px; color: var(--lp-brand-dark); }
  .lp-price-na { font-size: 13px; color: var(--lp-muted); font-weight: 600; }
  .lp-group { margin-bottom: 52px; }
  .lp-group:last-child { margin-bottom: 0; }
  .lp-group-head { display: flex; align-items: center; gap: 14px; margin-bottom: 24px; }
  .lp-group-title { font-family: var(--lp-f-display); margin: 0; font-size: 23px; letter-spacing: -0.01em; white-space: nowrap; }
  .lp-count { font-size: 12px; font-weight: 800; padding: 4px 12px; border-radius: 999px; white-space: nowrap; background: var(--lp-brand-light); color: var(--lp-brand-dark); }
  .lp-rule { flex: 1; height: 1px; background: var(--lp-line); }
  /* about */
  .lp-about-card { border-radius: 24px; padding: 48px; font-size: 17px; line-height: 1.8; background: var(--lp-bg-alt); }
  .lp-kb-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 18px; margin-top: 26px; }
  .lp-kb-card { border-radius: 18px; padding: 24px; background: var(--lp-surface); border: 1px solid var(--lp-line); }
  .lp-kb-card h4 { margin: 0 0 8px; font-size: 15.5px; }
  .lp-kb-card p { margin: 0; font-size: 14px; color: var(--lp-muted); line-height: 1.65; }
  /* testimonials */
  .lp-quote-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 20px; }
  .lp-quote { border-radius: 20px; padding: 30px; background: var(--lp-surface); border: 1px solid var(--lp-line); display: flex; flex-direction: column; gap: 14px; }
  .lp-quote-mark { font-family: var(--lp-f-display); font-size: 44px; line-height: 1; color: var(--lp-brand); }
  .lp-quote p { margin: 0; font-size: 15.5px; line-height: 1.7; flex: 1; }
  .lp-quote cite { font-style: normal; font-size: 13.5px; font-weight: 700; color: var(--lp-muted); }
  /* contact */
  .lp-contact-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 22px; }
  .lp-panel { border-radius: 22px; padding: 34px; background: var(--lp-surface); border: 1px solid var(--lp-line); }
  .lp-panel h3 { margin: 0 0 12px; font-size: 19px; font-family: var(--lp-f-display); }
  .lp-panel p { font-size: 14.5px; color: var(--lp-muted); line-height: 1.7; margin: 0 0 18px; }
  .lp-hours-row { display: flex; justify-content: space-between; gap: 12px; padding: 10px 0; border-bottom: 1px dashed var(--lp-line); font-size: 14px; }
  .lp-hours-row:last-child { border-bottom: none; }
  .lp-hours-row .day { font-weight: 700; text-transform: capitalize; }
  .lp-wa { display: inline-block; margin-top: 16px; text-decoration: none; font-weight: 700; font-size: 15px; padding: 13px 28px; border-radius: 999px; color: #fff; background: #1FA855; transition: transform .15s ease, filter .15s ease; }
  .lp-wa:hover { transform: translateY(-2px); filter: brightness(1.06); }
  .lp-mail { color: var(--lp-brand-dark); font-weight: 600; }
  /* footer */
  .lp-footer { border-top: 1px solid var(--lp-line); padding: 40px 24px 46px; text-align: center; }
  .lp-footer-name { font-weight: 800; font-size: 16px; margin-bottom: 8px; display: flex; align-items: center; justify-content: center; gap: 10px; }
  .lp-footer-line { color: var(--lp-muted); font-size: 13.5px; }
  .lp-powered { margin-top: 10px; font-size: 12px; color: var(--lp-muted); opacity: .8; }
  @media (max-width: 720px) {
    .lp-nav-links { display: none; }
    .lp-hero-inner { padding: 68px 20px 64px; }
    .lp-section { padding: 60px 0; }
    .lp-contact-grid { grid-template-columns: 1fr; }
    .lp-about-card { padding: 30px 24px; }
    .lp-h1 { font-size: 38px !important; }
    .lp-sec-title { font-size: 27px; }
  }
`;

const PER_THEME_CSS: Record<LandingThemeId, string> = {
  "modern-minimal": `
    .lp-modern-minimal .lp-nav { background: rgba(255,255,255,.86); border-bottom: 1px solid var(--lp-line); }
    .lp-modern-minimal .lp-eyebrow { color: var(--lp-brand-dark); }
    .lp-modern-minimal .lp-h1 { font-size: 58px; font-weight: 800; }
    .lp-modern-minimal .lp-h1 .lp-accent { color: var(--lp-brand); }
    .lp-modern-minimal .lp-tagline { color: var(--lp-ink); font-weight: 500; }
    .lp-modern-minimal .lp-btn-ghost { border-color: var(--lp-line); color: var(--lp-ink); background: #fff; }
    .lp-modern-minimal .lp-btn-ghost:hover { border-color: var(--lp-brand); color: var(--lp-brand-dark); }
    .lp-modern-minimal .lp-cat-chip { background: #fff; border: 1px solid var(--lp-line); color: var(--lp-muted); }
    .lp-modern-minimal .lp-cat-chip:hover { border-color: var(--lp-brand); color: var(--lp-brand-dark); }
    .lp-modern-minimal .lp-sec-title::after { content: ""; display: block; width: 44px; height: 3px; border-radius: 2px; background: var(--lp-brand); margin-top: 12px; }
    .lp-modern-minimal .lp-card { border: 1px solid var(--lp-line); box-shadow: 0 2px 10px rgba(20,24,29,.04); }
    .lp-modern-minimal .lp-card:hover { box-shadow: 0 16px 38px rgba(20,24,29,.10); }
    .lp-modern-minimal .lp-alt { background: var(--lp-bg-alt); }
  `,
  "bold-color": `
    .lp-bold-color .lp-nav { background: rgba(255,255,255,.9); border-bottom: 2px solid #14181D; }
    .lp-bold-color .lp-hero-blob { position: absolute; border-radius: 50%; filter: blur(2px); opacity: .5; pointer-events: none; }
    .lp-bold-color .lp-eyebrow { color: var(--lp-hero-ink); background: rgba(0,0,0,.22); padding: 8px 18px; border-radius: 999px; border: 1px solid rgba(255,255,255,.35); }
    .lp-bold-color .lp-h1 { font-size: 64px; font-weight: 700; text-shadow: 0 3px 0 rgba(0,0,0,.18); }
    .lp-bold-color .lp-tagline { font-weight: 600; }
    .lp-bold-color .lp-hero .lp-cta { box-shadow: 0 10px 28px rgba(0,0,0,.35); }
    .lp-bold-color .lp-btn-ghost { border-color: rgba(255,255,255,.7); color: #fff; }
    .lp-bold-color .lp-btn-ghost:hover { background: rgba(255,255,255,.14); }
    .lp-bold-color .lp-cat-chip { background: rgba(0,0,0,.25); color: #fff; border: 1px solid rgba(255,255,255,.4); }
    .lp-bold-color .lp-cat-chip:hover { background: rgba(0,0,0,.4); }
    .lp-bold-color .lp-sec-title .lp-hl { background: linear-gradient(transparent 62%, var(--lp-brand-light) 62%); padding: 0 4px; }
    .lp-bold-color .lp-card { border: 2px solid #14181D; box-shadow: 5px 5px 0 #14181D; }
    .lp-bold-color .lp-card:hover { transform: translate(-2px,-4px); box-shadow: 8px 9px 0 #14181D; }
    .lp-bold-color .lp-group-title { font-weight: 700; }
    .lp-bold-color .lp-about-card { background: #14181D; color: #F4F6F8; }
    .lp-bold-color .lp-about-card .lp-lede { color: #B7BEC9; }
    .lp-bold-color .lp-footer { background: #14181D; color: #B7BEC9; border-top: none; }
    .lp-bold-color .lp-footer-name { color: #fff; }
  `,
  "elegant-serif": `
    .lp-elegant-serif .lp-nav { background: rgba(253,252,249,.9); border-bottom: 1px solid var(--lp-line); }
    .lp-elegant-serif .lp-brand { font-family: var(--lp-f-display); letter-spacing: .02em; }
    .lp-elegant-serif .lp-eyebrow { font-family: var(--lp-f-body); font-style: italic; text-transform: none; letter-spacing: 1px; font-size: 15px; color: var(--lp-brand-dark); font-weight: 500; }
    .lp-elegant-serif .lp-h1 { font-size: 60px; font-weight: 700; }
    .lp-elegant-serif .lp-hero-rule { display: flex; align-items: center; justify-content: center; gap: 14px; margin: 26px auto; max-width: 320px; }
    .lp-elegant-serif .lp-hero-rule::before, .lp-elegant-serif .lp-hero-rule::after { content: ""; flex: 1; height: 1px; background: var(--lp-line); }
    .lp-elegant-serif .lp-hero-rule span { width: 7px; height: 7px; transform: rotate(45deg); background: var(--lp-brand); display: block; }
    .lp-elegant-serif .lp-tagline { font-family: var(--lp-f-display); font-style: italic; font-size: 22px; }
    .lp-elegant-serif .lp-cta { border-radius: 6px; letter-spacing: .04em; }
    .lp-elegant-serif .lp-btn-ghost { border-radius: 6px; border-color: var(--lp-brand-dark); color: var(--lp-brand-dark); letter-spacing: .04em; }
    .lp-elegant-serif .lp-btn-ghost:hover { background: var(--lp-brand-dark); color: #fff; }
    .lp-elegant-serif .lp-cat-chip { background: transparent; border: 1px solid var(--lp-line); color: var(--lp-muted); border-radius: 6px; font-family: var(--lp-f-body); }
    .lp-elegant-serif .lp-cat-chip:hover { border-color: var(--lp-brand-dark); color: var(--lp-brand-dark); }
    .lp-elegant-serif .lp-sec-head { text-align: center; }
    .lp-elegant-serif .lp-sec-head .lp-lede { margin: 0 auto; }
    .lp-elegant-serif .lp-sec-title { font-weight: 700; }
    .lp-elegant-serif .lp-sec-title::after { content: ""; display: block; width: 52px; height: 1px; background: var(--lp-brand); margin: 16px auto 0; }
    .lp-elegant-serif .lp-group-head { justify-content: center; }
    .lp-elegant-serif .lp-group-head .lp-rule { display: none; }
    .lp-elegant-serif .lp-group-title { font-style: italic; }
    .lp-elegant-serif .lp-card { border: 1px solid var(--lp-line); border-radius: 10px; }
    .lp-elegant-serif .lp-card:hover { box-shadow: 0 18px 44px rgba(35,32,26,.10); }
    .lp-elegant-serif .lp-card-name { font-family: var(--lp-f-display); font-size: 19px; }
    .lp-elegant-serif .lp-price { font-family: var(--lp-f-display); font-style: italic; }
    .lp-elegant-serif .lp-about-card { background: transparent; border-top: 1px solid var(--lp-line); border-bottom: 1px solid var(--lp-line); border-radius: 0; text-align: center; max-width: 760px; margin: 0 auto; font-size: 19px; }
    .lp-elegant-serif .lp-quote { border-radius: 10px; text-align: center; }
    .lp-elegant-serif .lp-quote p { font-style: italic; font-size: 17px; }
    .lp-elegant-serif .lp-panel { border-radius: 10px; }
    .lp-elegant-serif .lp-footer { font-family: var(--lp-f-body); }
  `,
  "dark-premium": `
    .lp-dark-premium .lp-nav { background: rgba(12,14,18,.72); border-bottom: 1px solid var(--lp-line); }
    .lp-dark-premium .lp-nav-links a:hover { color: #fff; }
    .lp-dark-premium .lp-eyebrow { color: var(--lp-brand-light); }
    .lp-dark-premium .lp-h1 { font-size: 60px; font-weight: 800; background: linear-gradient(120deg, #FFFFFF 30%, var(--lp-brand-light) 100%); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; }
    .lp-dark-premium .lp-tagline { color: var(--lp-ink); font-weight: 500; }
    .lp-dark-premium .lp-hero .lp-cta { box-shadow: 0 8px 32px rgba(0,0,0,.5), 0 0 24px var(--lp-brand); }
    .lp-dark-premium .lp-btn-ghost { border-color: rgba(255,255,255,.25); color: #fff; background: rgba(255,255,255,.06); backdrop-filter: blur(8px); }
    .lp-dark-premium .lp-btn-ghost:hover { border-color: var(--lp-brand-light); background: rgba(255,255,255,.1); }
    .lp-dark-premium .lp-cat-chip { background: rgba(255,255,255,.06); border: 1px solid var(--lp-line); color: var(--lp-muted); backdrop-filter: blur(8px); }
    .lp-dark-premium .lp-cat-chip:hover { border-color: var(--lp-brand); color: #fff; }
    .lp-dark-premium .lp-sec-title { color: #fff; }
    .lp-dark-premium .lp-card { background: var(--lp-surface); border: 1px solid var(--lp-line); }
    .lp-dark-premium .lp-card:hover { border-color: var(--lp-brand); box-shadow: 0 14px 40px rgba(0,0,0,.5), 0 0 18px rgba(0,0,0,.35); }
    .lp-dark-premium .lp-card-img { opacity: .94; }
    .lp-dark-premium .lp-price { color: var(--lp-brand-light); }
    .lp-dark-premium .lp-count { background: rgba(255,255,255,.08); color: var(--lp-brand-light); }
    .lp-dark-premium .lp-about-card { background: var(--lp-surface); border: 1px solid var(--lp-line); }
    .lp-dark-premium .lp-kb-card { background: var(--lp-surface); }
    .lp-dark-premium .lp-quote { background: var(--lp-surface); }
    .lp-dark-premium .lp-panel { background: var(--lp-surface); }
    .lp-dark-premium .lp-cta { color: var(--lp-cta-ink); }
  `,
};

/* ------------------------------------------------------------------ */
/* Section renderers (per-theme variations)                             */
/* ------------------------------------------------------------------ */

interface Ctx {
  data: PublicLandingData;
  pal: ThemePalette;
  theme: LandingThemeId;
  origin: string;
  widgetSrc: string;
}

function Nav({ data, pal, theme }: Ctx) {
  const { business } = data;
  return (
    <div className="lp-nav">
      <div className="lp-nav-inner">
        <a className="lp-brand" href="#top">
          <Logo name={business.name} logoUrl={business.logoUrl} />
          <span>{business.name}</span>
        </a>
        <nav className="lp-nav-links" aria-label="Sections">
          {data.products.length > 0 && <a href="#products">Products</a>}
          <a href="#about">About</a>
          <a href="#contact">Contact</a>
        </nav>
        <ChatCtaButton label="Chat with us" background={pal.ctaBg} color={pal.ctaInk} small />
      </div>
    </div>
  );
}

function Hero({ data, pal, theme }: Ctx) {
  const { business, copy, products, productGroups, contact } = data;
  const waHref = contact.whatsappPhone
    ? `https://wa.me/${contact.whatsappPhone.replace(/[^0-9]/g, "")}`
    : null;
  const eyebrow =
    productGroups.length > 0
      ? `${productGroups.length} collection${productGroups.length === 1 ? "" : "s"} · ${products.length} item${products.length === 1 ? "" : "s"}`
      : "Welcome";
  return (
    <div className="lp-hero">
      {theme === "bold-color" && (
        <>
          <div className="lp-hero-blob" style={{ width: 340, height: 340, left: "-90px", top: "-70px", background: pal.brandLight, opacity: 0.35 }} />
          <div className="lp-hero-blob" style={{ width: 220, height: 220, right: "6%", bottom: "-60px", background: "#FFFFFF", opacity: 0.16 }} />
        </>
      )}
      <div className="lp-hero-inner">
        <Reveal>
          <span className="lp-eyebrow">{eyebrow}</span>
          <h1 className="lp-h1">
            {theme === "modern-minimal" ? (
              <>
                {business.name.split(" ").slice(0, -1).join(" ")}{" "}
                <span className="lp-accent">{business.name.split(" ").slice(-1)}</span>
              </>
            ) : (
              business.name
            )}
          </h1>
        </Reveal>
        {theme === "elegant-serif" && (
          <div className="lp-hero-rule" aria-hidden>
            <span />
          </div>
        )}
        <Reveal delay={90}>
          <p className="lp-tagline">{copy.tagline}</p>
          <p className="lp-sub">{copy.heroSubtext}</p>
        </Reveal>
        <Reveal delay={170}>
          <div className="lp-hero-ctas">
            <ChatCtaButton label="Chat with us" background={pal.ctaBg} color={pal.ctaInk} />
            {data.products.length > 0 && (
              <a className="lp-btn-ghost" href="#products">
                Browse products
              </a>
            )}
            {waHref && (
              <a className="lp-btn-ghost" href={waHref} target="_blank" rel="noopener noreferrer">
                WhatsApp
              </a>
            )}
          </div>
        </Reveal>
        {productGroups.length > 1 && (
          <Reveal delay={240}>
            <div className="lp-cat-chips">
              {productGroups.map((g, i) => (
                <a key={i} className="lp-cat-chip" href={`#cat-${i}`}>
                  {g.categoryName}
                </a>
              ))}
            </div>
          </Reveal>
        )}
      </div>
    </div>
  );
}

function Products({ data, pal, theme }: Ctx) {
  const { copy, products, productGroups } = data;
  if (products.length === 0) return null;
  const title =
    theme === "bold-color" ? (
      <>
        Our <span className="lp-hl">Products</span> & Services
      </>
    ) : (
      copy.productsHeading
    );
  return (
    <div className={`lp-section${theme === "modern-minimal" ? " lp-alt" : ""}`} id="products">
      <div className="lp-wrap">
        <Reveal>
          <div className="lp-sec-head">
            <h2 className="lp-sec-title">{title}</h2>
            <p className="lp-lede">
              Everything we offer right now — tap &ldquo;Order&rdquo; on any item to start a chat about it.
            </p>
          </div>
        </Reveal>
        {(productGroups.length > 0 ? productGroups : [{ categoryName: "", products }]).map((g, gi) => (
          <div className="lp-group" key={gi} id={`cat-${gi}`}>
            {g.categoryName && (
              <Reveal>
                <div className="lp-group-head">
                  <h3 className="lp-group-title">{g.categoryName}</h3>
                  <span className="lp-count">
                    {g.products.length} {g.products.length === 1 ? "item" : "items"}
                  </span>
                  <span className="lp-rule" />
                </div>
              </Reveal>
            )}
            <div className="lp-grid">
              {g.products.map((p, i) => (
                <Reveal key={`${gi}-${i}`} delay={Math.min(i, 5) * 60}>
                  <ProductCard p={p} pal={pal} />
                </Reveal>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Testimonials come ONLY from real knowledge-base entries tagged as reviews. */
function Testimonials({ data }: Ctx) {
  const quotes = data.aboutEntries
    .filter((e) => /testimonial|review/i.test(`${e.category ?? ""} ${e.title}`))
    .slice(0, 3);
  if (quotes.length === 0) return null;
  return (
    <div className="lp-section" id="reviews" style={{ paddingTop: 0 }}>
      <div className="lp-wrap">
        <Reveal>
          <div className="lp-sec-head">
            <h2 className="lp-sec-title">What customers say</h2>
            <p className="lp-lede">Real words from our customers.</p>
          </div>
        </Reveal>
        <div className="lp-quote-grid">
          {quotes.map((q, i) => (
            <Reveal key={i} delay={i * 80}>
              <div className="lp-quote">
                <div className="lp-quote-mark" aria-hidden>
                  &ldquo;
                </div>
                <p>{q.content.slice(0, 300)}</p>
                <cite>— {q.title}</cite>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </div>
  );
}

function About({ data, theme }: Ctx) {
  const { copy, aboutEntries } = data;
  const extras = aboutEntries
    .filter((e) => !/testimonial|review/i.test(`${e.category ?? ""} ${e.title}`))
    .slice(0, 3);
  return (
    <div className="lp-section" id="about" style={theme === "elegant-serif" ? { paddingTop: 88 } : undefined}>
      <div className="lp-wrap">
        <Reveal>
          <div className="lp-sec-head">
            <h2 className="lp-sec-title">{copy.aboutHeading}</h2>
          </div>
        </Reveal>
        <Reveal delay={80}>
          <div className="lp-about-card">{copy.aboutText}</div>
        </Reveal>
        {extras.length > 0 && (
          <div className="lp-kb-grid">
            {extras.map((e, i) => (
              <Reveal key={i} delay={i * 70}>
                <div className="lp-kb-card">
                  <h4>{e.title}</h4>
                  <p>
                    {e.content.slice(0, 220)}
                    {e.content.length > 220 ? "…" : ""}
                  </p>
                </div>
              </Reveal>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Contact({ data, pal }: Ctx) {
  const { copy, contact, hours, business } = data;
  return (
    <div className="lp-section" id="contact" style={{ paddingTop: 0 }}>
      <div className="lp-wrap">
        <Reveal>
          <div className="lp-sec-head">
            <h2 className="lp-sec-title">{copy.contactHeading}</h2>
            <p className="lp-lede">We reply instantly in chat — or reach us directly.</p>
          </div>
        </Reveal>
        <div className="lp-contact-grid">
          <Reveal>
            <div className="lp-panel">
              <h3>Chat with our AI assistant</h3>
              <p>{contact.welcomeMessage}</p>
              <ChatCtaButton label="Start chatting" background={pal.ctaBg} color={pal.ctaInk} small />
              {contact.whatsappPhone && (
                <div>
                  <a
                    className="lp-wa"
                    href={`https://wa.me/${contact.whatsappPhone.replace(/[^0-9]/g, "")}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    WhatsApp us
                  </a>
                </div>
              )}
              {contact.email && (
                <p style={{ marginTop: 16, marginBottom: 0 }}>
                  Email:{" "}
                  <a className="lp-mail" href={`mailto:${contact.email}`}>
                    {contact.email}
                  </a>
                </p>
              )}
              {business.websiteUrl && (
                <p style={{ marginTop: 10, marginBottom: 0 }}>
                  Website:{" "}
                  <a className="lp-mail" href={business.websiteUrl} target="_blank" rel="noopener noreferrer">
                    {business.websiteUrl.replace(/^https?:\/\//, "")}
                  </a>
                </p>
              )}
            </div>
          </Reveal>
          <Reveal delay={100}>
            <div className="lp-panel">
              <h3>Opening hours</h3>
              {hours ? (
                <div>
                  {Object.entries(hours).map(([day, range]) => (
                    <div className="lp-hours-row" key={day}>
                      <span className="day">{day}</span>
                      <span>{range}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p style={{ marginBottom: 0 }}>
                  Our chat assistant is available 24/7 — message us anytime.
                </p>
              )}
            </div>
          </Reveal>
        </div>
      </div>
    </div>
  );
}

function Footer({ data }: Ctx) {
  const { business, copy } = data;
  return (
    <div className="lp-footer">
      <div className="lp-wrap">
        <div className="lp-footer-name">
          <Logo name={business.name} logoUrl={business.logoUrl} />
          {business.name}
        </div>
        <div className="lp-footer-line">{copy.footerLine}</div>
        <div className="lp-powered">Powered by Ride Bangla AI Agent</div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Page root                                                           */
/* ------------------------------------------------------------------ */

export function ThemeLandingPage({
  data,
  origin,
  widgetSrc,
}: {
  data: PublicLandingData;
  origin: string;
  widgetSrc: string;
}) {
  const theme: LandingThemeId = data.theme;
  const pal = themePalette(theme, data.business.brandColor);
  const ctx: Ctx = { data, pal, theme, origin, widgetSrc };

  return (
    <>
      {/* Theme marker for verification tooling (renders as an HTML comment). */}
      <span hidden dangerouslySetInnerHTML={{ __html: `<!--lp-theme:${theme}-->` }} />
      <style>{themeCss(pal, theme)}</style>
      <div id="top" data-theme={theme} className={`${lpFontVariables} lp lp-${theme}`}>
        <Nav {...ctx} />
        <Hero {...ctx} />
        <Products {...ctx} />
        <About {...ctx} />
        <Testimonials {...ctx} />
        <Contact {...ctx} />
        <Footer {...ctx} />
        {/* Embedded chat widget (business's own siteKey) */}
        <script
          src={widgetSrc}
          data-server={origin}
          data-site-key={data.business.siteKey}
          data-color={data.business.brandColor}
          data-title={data.business.name}
          data-greeting={data.contact.welcomeMessage}
          data-position="right"
        />
      </div>
    </>
  );
}
