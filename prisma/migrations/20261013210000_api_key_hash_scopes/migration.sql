-- H-15: store only the SHA-256 hash of API keys + per-key scopes.
-- The old `key` column held full keys in plaintext. It is dropped.
-- Existing keys are INVALIDATED by this migration: their plaintext values are
-- never converted to hashes (doing so would require reading them out), and
-- placeholder hashes that can never match a real key are stored instead.
-- Operator action (rotation): after deploying, delete the legacy keys and
-- create new ones; copy each new full key at creation time — it is shown once.
ALTER TABLE "ApiKey" ADD COLUMN "keyHash" TEXT;
ALTER TABLE "ApiKey" ADD COLUMN "scopes" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "ApiKey" ADD COLUMN "keySuffix" TEXT NOT NULL DEFAULT '';
UPDATE "ApiKey" SET "keyHash" = 'revoked-legacy-' || gen_random_uuid()::text;
ALTER TABLE "ApiKey" ALTER COLUMN "keyHash" SET NOT NULL;
ALTER TABLE "ApiKey" DROP COLUMN "key";
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_keyHash_key" UNIQUE ("keyHash");
