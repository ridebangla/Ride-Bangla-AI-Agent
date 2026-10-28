/**
 * messenger-template.ts — LEG D (booking batch), STAGED ONLY.
 *
 * OUT-OF-WINDOW MESSENGER FALLBACK — SEAM, NOT A WORKING SENDER.
 *
 * The delivery rule (booking-reminders.ts) says: a Messenger reminder
 * past Meta's 24h customer-service window must NOT go out as a
 * RESPONSE message (Meta rejects it), and must NOT be faked as sent.
 * The fallback is a template/tag send — but building it honestly
 * needs three things this leg deliberately does NOT invent:
 *
 *  1. A tenant-approved Messenger template (or an approved message
 *     tag use-case such as a confirmed-event reminder) — Meta
 *     approval is per-page/per-template and cannot be assumed.
 *  2. The tenant's configured template/tag name, stored on the
 *     Settings doc as `messengerTemplateName` (see the validations
 *     diff) — empty today for every business, so the fallback path
 *     is unreachable until a tenant configures it.
 *  3. Confirmation, at build time, of the current Graph API shape
 *     for that template/tag send (endpoint fields change; asserting
 *     one from memory here would ship an untested sender).
 *
 * Until all three exist, this function logs and returns false, and
 * the processor LEAVES the reminder pending (held) instead of
 * counting it sent. That is the honest state: the rule is enforced,
 * the sender is an open build, and no customer is ever told a
 * message went out that did not.
 *
 * DO NOT "complete" this seam by wiring it to sendMetaMessage's
 * RESPONSE path — that would silently break the 24h rule this leg
 * exists to enforce.
 */

import { logger } from "../logger";

/**
 * Attempt an out-of-window Messenger template/tag send.
 * Today: always false (held). See the header for what must land
 * before this may return true.
 */
export async function sendMessengerTemplateMessage(
  _recipientPageOrIgId: string,
  _recipientPsid: string,
  _text: string,
  _templateName: string
): Promise<boolean> {
  logger.warn(
    "[booking-reminders] messenger template send not built; reminder held",
    { templateName: _templateName }
  );
  return false;
}
