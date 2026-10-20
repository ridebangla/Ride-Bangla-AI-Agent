/**
 * data-url.ts — server-side validation for uploaded images stored as
 * data URLs (profile photos and business logos).
 *
 * There is no image-upload endpoint in the app and Firebase Storage is
 * billing-gated, so small cropped images are persisted directly in
 * Firestore as data URL strings — the same proven pattern the catalog
 * uses for product images (see the image-cropper wiring in catalog).
 *
 * Firestore documents hard-cap at 1 MiB, so the stored string must stay
 * well under that once the rest of the document is counted: 950,000
 * chars ≈ 0.95 MB. The dashboard cropper also caps output at 1024px,
 * which keeps real uploads far below this bound.
 */

export const MAX_IMAGE_DATA_URL_CHARS = 950_000;

const IMAGE_DATA_URL_RE =
  /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=\s]+$/;

export type ImageDataUrlCheck =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Validate a user-supplied image data URL. Empty string is valid
 * (means "clear the image"). The returned error is plain-language and
 * safe to show to the end user.
 */
export function checkImageDataUrl(value: string): ImageDataUrlCheck {
  if (!value) return { ok: true };
  if (value.length > MAX_IMAGE_DATA_URL_CHARS) {
    return {
      ok: false,
      error:
        "That image is too large after cropping. Please try a smaller or simpler image.",
    };
  }
  if (!IMAGE_DATA_URL_RE.test(value)) {
    return {
      ok: false,
      error: "That image could not be accepted. Please upload a PNG, JPG or WebP photo.",
    };
  }
  return { ok: true };
}

/** True when the string is an inline image data URL (vs an http(s) URL). */
export function isImageDataUrl(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith("data:image/");
}
