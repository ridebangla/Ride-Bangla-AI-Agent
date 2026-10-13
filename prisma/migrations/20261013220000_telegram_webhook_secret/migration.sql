-- H-16: store the Telegram webhook secret (secret_token) in Settings.
-- Operator action: after deploying, set telegramWebhookSecret via the
-- Settings API and re-register the webhook with the same secret_token.
-- Until then, inbound Telegram updates are rejected (fail-closed).
ALTER TABLE "Settings" ADD COLUMN "telegramWebhookSecret" TEXT NOT NULL DEFAULT '';
