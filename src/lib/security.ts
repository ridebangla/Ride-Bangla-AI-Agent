/**
 * Mask a sensitive string for safe display.
 * Returns "***" if the value is non-empty, empty string otherwise.
 */
export function maskSecret(value: string | null | undefined): string {
  if (!value || value.trim() === "") return "";
  return "***";
}

/**
 * List of fields in Settings that contain secrets.
 */
export const SECRET_FIELDS = [
  "aiApiKey",
  "smtpPass",
  "imapPass",
  "twilioToken",
  "elevenLabsKey",
  "whatsappApiKey",
  "telegramBotToken",
  "telegramWebhookSecret",
] as const;

/**
 * Remove secret values from a settings object for API responses.
 * Returns a new object with secrets replaced by "***".
 */
export function maskSettingsSecrets<T extends Record<string, unknown>>(
  settings: T
): T {
  const masked = { ...settings };
  for (const field of SECRET_FIELDS) {
    if (field in masked) {
      masked[field as keyof T] = maskSecret(
        masked[field as keyof T] as string
      ) as T[keyof T];
    }
  }
  return masked;
}

/**
 * Escape HTML entities to prevent XSS.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/**
 * Sanitize email subject to prevent CRLF header injection.
 */
export function sanitizeEmailSubject(subject: string): string {
  return subject.replace(/[\r\n]/g, " ").trim();
}
