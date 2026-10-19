/**
 * /p/[slug] — Phase 2: public auto-generated landing page for businesses
 * WITHOUT their own website (user decision 8).
 *
 * Renders server-side from the business doc + its catalog + knowledge base
 * + business hours. Sections: hero (name, tagline, "Chat with us" CTA),
 * products/services grid, about, contact + hours, footer. The business's
 * own chat widget is embedded via its siteKey.
 *
 * Visibility rule (fail-closed): only `landingPublished` pages render —
 * anything else is a 404.
 */

import { notFound } from "next/navigation";
import { headers } from "next/headers";
import type { Metadata } from "next";
import { getLandingData, type PublicLandingData } from "@/lib/landing";
import { ChatCtaButton } from "./chat-cta";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ slug: string }>;
}

async function load(slug: string): Promise<PublicLandingData> {
  const data = await getLandingData(slug);
  if (!data || !data.business.landingPublished) notFound();
  return data;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const data = await getLandingData(slug);
  if (!data || !data.business.landingPublished) return { title: "Page not found" };
  return {
    title: `${data.business.name} — ${data.copy.tagline}`,
    description: data.copy.tagline,
    openGraph: {
      title: data.business.name,
      description: data.copy.tagline,
      ...(data.business.logoUrl ? { images: [data.business.logoUrl] } : {}),
    },
  };
}

/** Darken/lighten a #rrggbb hex by `amount` (-1..1). */
function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const f = (v: number) =>
    amount >= 0 ? v + (255 - v) * amount : v * (1 + amount);
  const r = clamp(f((n >> 16) & 255));
  const g = clamp(f((n >> 8) & 255));
  const b = clamp(f(n & 255));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0").toUpperCase()}`;
}

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

function Logo({ name, logoUrl, brandColor }: { name: string; logoUrl: string | null; brandColor: string }) {
  const initial = (name.trim()[0] || "?").toUpperCase();
  if (logoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={logoUrl}
        alt={`${name} logo`}
        style={{
          width: 44,
          height: 44,
          borderRadius: 12,
          objectFit: "cover",
          background: "#fff",
          boxShadow: "0 2px 8px rgba(0,0,0,0.18)",
        }}
      />
    );
  }
  return (
    <div
      aria-hidden
      style={{
        width: 44,
        height: 44,
        borderRadius: 12,
        background: "#ffffff",
        color: brandColor,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 22,
        fontWeight: 800,
        boxShadow: "0 2px 8px rgba(0,0,0,0.18)",
      }}
    >
      {initial}
    </div>
  );
}

export default async function LandingPage({ params }: PageProps) {
  const { slug } = await params;
  const data = await load(slug);
  const { business, copy, products, hours, contact } = data;
  const brand = business.brandColor;
  const brandDark = shade(brand, -0.25);
  const brandLight = shade(brand, 0.88);

  // Absolute origin for the widget assets (works behind Vercel/proxy).
  const headerList = await headers();
  const host =
    headerList.get("x-forwarded-host") ?? headerList.get("host") ?? "ai.ridebangla.bd";
  const proto = headerList.get("x-forwarded-proto") ?? "https";
  const origin = `${proto}://${host}`;
  const widgetSrc = `${origin}/widget/ride-bangla-chat.js`;

  return (
    <>
      <style>{`
          .lp-root { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #1a1a1a; background: #ffffff; }
          .lp-wrap { max-width: 1080px; margin: 0 auto; padding: 0 20px; }
          .lp-nav { position: sticky; top: 0; z-index: 50; backdrop-filter: blur(12px); background: rgba(255,255,255,0.92); border-bottom: 1px solid #eee; }
          .lp-nav-inner { max-width: 1080px; margin: 0 auto; padding: 12px 20px; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
          .lp-brand { display: flex; align-items: center; gap: 12px; font-weight: 700; font-size: 18px; }
          .lp-hero { color: #fff; padding: 84px 20px 72px; text-align: center; }
          .lp-hero h1 { margin: 0 0 14px; font-size: 44px; line-height: 1.15; letter-spacing: -0.5px; }
          .lp-hero p.tagline { margin: 0 auto 10px; font-size: 20px; max-width: 640px; opacity: 0.95; }
          .lp-hero p.sub { margin: 0 auto 30px; font-size: 15px; max-width: 560px; opacity: 0.85; }
          .lp-cta { display: inline-block; border: none; cursor: pointer; font-size: 17px; font-weight: 700; padding: 14px 34px; border-radius: 999px; box-shadow: 0 6px 20px rgba(0,0,0,0.22); transition: transform .15s ease; }
          .lp-cta:hover { transform: translateY(-2px); }
          .lp-section { padding: 64px 0; }
          .lp-section h2 { margin: 0 0 8px; font-size: 30px; letter-spacing: -0.3px; }
          .lp-section .lede { margin: 0 0 32px; color: #555; font-size: 16px; max-width: 640px; }
          .lp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 20px; }
          .lp-card { border: 1px solid #e8e8e8; border-radius: 16px; overflow: hidden; background: #fff; transition: transform .15s ease, box-shadow .15s ease; }
          .lp-card:hover { transform: translateY(-3px); box-shadow: 0 10px 28px rgba(0,0,0,0.10); }
          .lp-card img { width: 100%; height: 170px; object-fit: cover; display: block; background: #f4f4f4; }
          .lp-card-body { padding: 16px; }
          .lp-card-body h3 { margin: 0 0 6px; font-size: 17px; }
          .lp-card-body p { margin: 0 0 10px; font-size: 14px; color: #555; line-height: 1.5; }
          .lp-price { font-weight: 800; font-size: 16px; }
          .lp-cat { display: inline-block; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.6px; padding: 3px 10px; border-radius: 999px; margin-bottom: 8px; }
          .lp-about { border-radius: 20px; padding: 40px; line-height: 1.7; font-size: 16px; color: #333; }
          .lp-contact-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
          .lp-panel { border: 1px solid #e8e8e8; border-radius: 16px; padding: 28px; background: #fff; }
          .lp-panel h3 { margin: 0 0 14px; font-size: 18px; }
          .lp-hours-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px dashed #eee; font-size: 14px; }
          .lp-hours-row:last-child { border-bottom: none; }
          .lp-footer { border-top: 1px solid #eee; padding: 28px 20px; text-align: center; color: #777; font-size: 13px; }
          .lp-wa { display: inline-block; margin-top: 14px; text-decoration: none; font-weight: 700; padding: 12px 26px; border-radius: 999px; color: #fff; }
          @media (max-width: 640px) {
            .lp-hero { padding: 60px 16px 52px; }
            .lp-hero h1 { font-size: 32px; }
            .lp-hero p.tagline { font-size: 17px; }
            .lp-contact-grid { grid-template-columns: 1fr; }
            .lp-about { padding: 26px 20px; }
            .lp-section { padding: 44px 0; }
          }
        `}</style>

        <div className="lp-root">
          {/* Nav */}
          <div className="lp-nav">
            <div className="lp-nav-inner">
              <div className="lp-brand">
                <Logo name={business.name} logoUrl={business.logoUrl} brandColor={brand} />
                <span>{business.name}</span>
              </div>
              <ChatCtaButton label="Chat with us" background={brand} color="#fff" small />
            </div>
          </div>

          {/* Hero */}
          <div className="lp-hero" style={{ background: `linear-gradient(135deg, ${brandDark} 0%, ${brand} 60%, ${shade(brand, 0.15)} 100%)` }}>
            <div className="lp-wrap">
              <h1>{business.name}</h1>
              <p className="tagline">{copy.tagline}</p>
              <p className="sub">{copy.heroSubtext}</p>
              <ChatCtaButton label="Chat with us" background="#fff" color={brandDark} />
            </div>
          </div>

          {/* Products */}
          {products.length > 0 && (
            <div className="lp-section">
              <div className="lp-wrap">
                <h2>{copy.productsHeading}</h2>
                <p className="lede">Everything we offer right now — tap &ldquo;Chat with us&rdquo; to order or ask about any item.</p>
                <div className="lp-grid">
                  {products.map((p, i) => (
                    <div className="lp-card" key={i}>
                      {p.imageUrl && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={p.imageUrl} alt={p.name} loading="lazy" />
                      )}
                      <div className="lp-card-body">
                        {p.categoryName && (
                          <span className="lp-cat" style={{ background: brandLight, color: brandDark }}>
                            {p.categoryName}
                          </span>
                        )}
                        <h3>{p.name}</h3>
                        {p.description && <p>{p.description.slice(0, 140)}{p.description.length > 140 ? "…" : ""}</p>}
                        {formatPrice(p) && (
                          <div className="lp-price" style={{ color: brandDark }}>{formatPrice(p)}</div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* About */}
          <div className="lp-section" style={{ paddingTop: products.length > 0 ? 0 : 64 }}>
            <div className="lp-wrap">
              <h2>{copy.aboutHeading}</h2>
              <p className="lede">A little about who we are.</p>
              <div className="lp-about" style={{ background: brandLight }}>
                {copy.aboutText}
              </div>
            </div>
          </div>

          {/* Contact + hours */}
          <div className="lp-section" style={{ paddingTop: 0 }}>
            <div className="lp-wrap">
              <h2>{copy.contactHeading}</h2>
              <p className="lede">We reply instantly in chat — or reach us directly.</p>
              <div className="lp-contact-grid">
                <div className="lp-panel">
                  <h3>Chat with our AI assistant</h3>
                  <p style={{ fontSize: 14, color: "#555", lineHeight: 1.6, margin: "0 0 6px" }}>
                    {contact.welcomeMessage}
                  </p>
                  <ChatCtaButton label="Start chatting" background={brand} color="#fff" small />
                  {contact.whatsappPhone && (
                    <div>
                      <a
                        className="lp-wa"
                        style={{ background: "#1FA855" }}
                        href={`https://wa.me/${contact.whatsappPhone.replace(/[^0-9]/g, "")}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        WhatsApp us
                      </a>
                    </div>
                  )}
                  {contact.email && (
                    <p style={{ fontSize: 14, color: "#555", marginTop: 14 }}>
                      Email: <a href={`mailto:${contact.email}`} style={{ color: brandDark }}>{contact.email}</a>
                    </p>
                  )}
                </div>
                <div className="lp-panel">
                  <h3>Opening hours</h3>
                  {hours ? (
                    <div>
                      {Object.entries(hours).map(([day, range]) => (
                        <div className="lp-hours-row" key={day}>
                          <span style={{ textTransform: "capitalize", fontWeight: 600 }}>{day}</span>
                          <span style={{ color: "#555" }}>{range}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p style={{ fontSize: 14, color: "#555" }}>Our chat assistant is available 24/7 — message us anytime.</p>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="lp-footer">
            <div className="lp-wrap">
              <div style={{ marginBottom: 8, fontWeight: 700, color: "#333" }}>{business.name}</div>
              <div>{copy.footerLine}</div>
              <div style={{ marginTop: 6, fontSize: 12 }}>
                Powered by Ride Bangla AI Agent
              </div>
            </div>
          </div>

          {/* Embedded chat widget (business's own siteKey) */}
          <script
            src={widgetSrc}
            data-server={origin}
            data-site-key={business.siteKey}
            data-color={brand}
            data-title={business.name}
            data-greeting={contact.welcomeMessage}
            data-position="right"
          />
        </div>
    </>
  );
}
