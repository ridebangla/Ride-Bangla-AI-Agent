import type { MetadataRoute } from "next";

const SITE_URL = "https://ai.ridebangla.bd";

// NOTE: tenant landing pages (/p/[slug]) are intentionally NOT listed here —
// their slugs are tenant data resolved at request time (fail-closed), not a
// static route set. They are discoverable via each tenant's own site.
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  const routes: Array<{
    path: string;
    changeFrequency: "weekly" | "monthly";
    priority: number;
  }> = [
    { path: "/", changeFrequency: "weekly", priority: 1 },
    { path: "/pricing", changeFrequency: "weekly", priority: 0.9 },
    { path: "/signup", changeFrequency: "monthly", priority: 0.9 },
    { path: "/privacy", changeFrequency: "monthly", priority: 0.4 },
    { path: "/terms", changeFrequency: "monthly", priority: 0.4 },
    { path: "/login", changeFrequency: "monthly", priority: 0.3 },
  ];
  return routes.map((r) => ({
    url: SITE_URL + r.path,
    lastModified: now,
    changeFrequency: r.changeFrequency,
    priority: r.priority,
  }));
}
