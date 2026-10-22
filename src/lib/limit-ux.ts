/**
 * limit-ux.ts — Limit-exhausted popup/bar copy + reset-line rendering.
 *
 * Owner-approved working texts (2026-10-22 13:14, owner's own dictated
 * phrases — used VERBATIM, never paraphrased). Dashboards default to
 * English; the English equivalents live in the delivery report for the
 * owner's review, not invented here.
 *
 * CLIENT-SAFE: no server-only imports — the dashboard popup/bar are
 * client components and the unit tests import this directly.
 */

/** How the exhausted limit resets. */
export type LimitReset =
  | { kind: "daily" }
  | { kind: "hourly"; resetAtMs: number }
  | { kind: "period"; resetAtMs: number };

/** Owner's exact working texts (2026-10-22). */
export const LIMIT_UX_TEXTS = {
  /** Popup headline. */
  headline: "আপনার সীমা শেষ হয়ে গেছে",
  /**
   * Popup body template — `{slot}` is filled by resetSlotPhrase().
   * Verbatim: "আপনার বর্তমান প্ল্যানের সীমা শেষ। আবার ব্যবহার করতে
   * পারবেন [পরের দিন / আর X ঘণ্টা পরে]। এখনই চালিয়ে যেতে চাইলে
   * প্ল্যান আপগ্রেড করুন।"
   */
  bodyTemplate: "আপনার বর্তমান প্ল্যানের সীমা শেষ। আবার ব্যবহার করতে পারবেন {slot}। এখনই চালিয়ে যেতে চাইলে প্ল্যান আপগ্রেড করুন।",
  /** Slim bar button — opens the full popup with the plans. */
  viewPlans: "প্ল্যানগুলো দেখুন",
  /** Primary CTA (owner's own wording, verbatim) — goes to /billing. */
  cta: "Update your package",
} as const;

/** Whole hours from nowMs until resetAtMs, minimum 1. */
export function hoursUntil(resetAtMs: number, nowMs: number): number {
  return Math.max(1, Math.ceil((resetAtMs - nowMs) / (60 * 60 * 1000)));
}

/**
 * Neutral, locale-stable rendering of a period reset moment. This is
 * data (the actual reset instant), not copy — it fills the same {slot}
 * the owner's daily/hourly phrases fill.
 */
export function formatResetDateTime(resetAtMs: number): string {
  return new Date(resetAtMs).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/**
 * The {slot} phrase for the body template:
 * - daily  → "পরের দিন"            (owner's exact phrase)
 * - hourly → "আর X ঘণ্টা পরে"       (owner's exact phrase, live countdown X)
 * - period → the reset date (e.g. the 30-day usage-period reset)
 */
export function resetSlotPhrase(reset: LimitReset, nowMs: number = Date.now()): string {
  switch (reset.kind) {
    case "daily":
      return "পরের দিন";
    case "hourly":
      return `আর ${hoursUntil(reset.resetAtMs, nowMs)} ঘণ্টা পরে`;
    case "period":
      return formatResetDateTime(reset.resetAtMs);
  }
}

/** Full popup body with the reset slot filled in. */
export function buildLimitBody(reset: LimitReset, nowMs: number = Date.now()): string {
  return LIMIT_UX_TEXTS.bodyTemplate.replace("{slot}", resetSlotPhrase(reset, nowMs));
}
