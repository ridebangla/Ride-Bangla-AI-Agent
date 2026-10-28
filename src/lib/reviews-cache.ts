/**
 * Public-reviews payload cache (moved out of the route file 2026-10-28:
 * Next 16 route modules may not export non-handler symbols — the
 * validator fails the build. Behaviour unchanged; the route and its
 * tests import this module now).
 */

export type ReviewsPayload = {
  ok: true;
  average: number;
  count: number;
  reviews: Array<{
    name: string;
    rating: number;
    text: string;
    createdAt: unknown;
    photoURL: string;
    verifiedGoogle: boolean;
  }>;
};
export const reviewsCache = new Map<string, { at: number; payload: ReviewsPayload }>();

/** Test-only: clear the reviews payload cache between cases. */
export function __resetReviewsCache(): void {
  reviewsCache.clear();
}

