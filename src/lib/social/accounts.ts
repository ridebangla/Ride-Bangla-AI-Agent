/**
 * Social account token encryption + ambient-context account helpers.
 *
 * Platform access tokens are stored AES-256-GCM encrypted. The encryption
 * key comes from the `SOCIAL_TOKEN_KEY` environment variable, which must be
 * a 64-character hex string (32 bytes). A clear error is thrown whenever
 * encrypt/decrypt is attempted without it — never a silent failure.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";
import type { SocialAccount } from "@/lib/models";

const ALGORITHM = "aes-256-gcm";

function getKey(): Buffer {
  const raw = process.env.SOCIAL_TOKEN_KEY;
  if (!raw) {
    throw new Error(
      "SOCIAL_TOKEN_KEY is not set. Set it to a 64-character hex string (32 bytes) before storing or reading social account tokens."
    );
  }
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(
      "SOCIAL_TOKEN_KEY must be a 64-character hex string (32 bytes)."
    );
  }
  return Buffer.from(raw, "hex");
}

export interface EncryptedToken {
  tokenEnc: string;
  tokenIv: string;
}

/** Encrypt a plaintext platform token. Never log the plaintext. */
export function encryptToken(plaintext: string): EncryptedToken {
  if (!plaintext) throw new Error("Cannot encrypt an empty token.");
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    tokenEnc: Buffer.concat([tag, enc]).toString("base64"),
    tokenIv: iv.toString("base64"),
  };
}

/** Decrypt a stored token back to plaintext (in-memory only — never log it). */
export function decryptToken(tokenEnc: string, tokenIv: string): string {
  const key = getKey();
  const combined = Buffer.from(tokenEnc, "base64");
  const iv = Buffer.from(tokenIv, "base64");
  const tag = combined.subarray(0, 16);
  const enc = combined.subarray(16);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString(
    "utf8"
  );
}

export type SocialPlatform = "facebook" | "instagram" | "x";
export const SOCIAL_PLATFORMS: SocialPlatform[] = ["facebook", "instagram", "x"];

export function isSupportedPlatform(p: unknown): p is SocialPlatform {
  return (
    typeof p === "string" && SOCIAL_PLATFORMS.includes(p as SocialPlatform)
  );
}

/**
 * All active social accounts in the ambient business context.
 * Throws TenantContextError if no business context was entered (fail-closed).
 */
export async function getActiveAccounts(): Promise<SocialAccount[]> {
  return prisma.socialAccount.findMany({
    where: { isActive: true },
    orderBy: { createdAt: "asc" },
  });
}

/** Decrypt the access token for an account row. */
export function getDecryptedToken(account: SocialAccount): string {
  if (!account.tokenEnc || !account.tokenIv) {
    throw new Error(
      `Social account "${account.label || account.id}" (${account.platform}) has no stored token.`
    );
  }
  return decryptToken(account.tokenEnc, account.tokenIv);
}

/** Redacted token display for API responses — never expose tokenEnc. */
export function maskToken(account: Pick<SocialAccount, "accountRef">): string {
  const ref = account.accountRef || "";
  const tail = ref.length > 4 ? ref.slice(-4) : ref;
  return `••••${tail}`;
}
