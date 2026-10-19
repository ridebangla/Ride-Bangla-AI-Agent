/**
 * claim-input.ts — shared validation for payment-claim submissions.
 *
 * Firebase Storage is unavailable until Blaze billing is paid, so payment
 * screenshots are stored as client-compressed base64 data URLs in the
 * claim doc (must stay under Firestore's 1MB doc limit — 400KB cap here).
 * TODO post-Blaze: upload to Firebase Storage and store the download URL.
 */

export const MAX_SCREENSHOT_BYTES = 400 * 1024;

export type ScreenshotCheck =
  | { ok: true; bytes: number }
  | { ok: false; error: "invalid_screenshot" | "screenshot_too_large" };

/** Validate a screenshot data URL. Returns the decoded byte size. */
export function checkScreenshot(dataUrl: string): ScreenshotCheck {
  const m = /^data:image\/[a-zA-Z+]+;base64,([A-Za-z0-9+/=]+)$/.exec(
    (dataUrl || "").trim()
  );
  if (!m) return { ok: false, error: "invalid_screenshot" };
  const b64 = m[1];
  const padding = (b64.match(/=+$/) || [""])[0].length;
  const bytes = Math.floor((b64.length * 3) / 4) - padding;
  if (bytes > MAX_SCREENSHOT_BYTES) {
    return { ok: false, error: "screenshot_too_large" };
  }
  return { ok: true, bytes };
}

export const SCREENSHOT_ERROR_MESSAGES: Record<
  "invalid_screenshot" | "screenshot_too_large",
  string
> = {
  invalid_screenshot: "A valid payment screenshot image is required.",
  screenshot_too_large:
    "That screenshot is still larger than 400 KB after compression. Please submit a smaller or clearer screenshot — a cropped image of just the payment confirmation works best.",
};
