-- M-53: JWT revocation list + persistent per-account login lockout.
-- Access tokens are now 1h (was 7d) with 7d refresh tokens; logout and
-- refresh rotation revoke by jti in RevokedToken.
ALTER TABLE "Admin" ADD COLUMN "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Admin" ADD COLUMN "lockedUntil" TIMESTAMP(3);

-- CreateTable: RevokedToken
CREATE TABLE "RevokedToken" (
    "jti" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RevokedToken_pkey" PRIMARY KEY ("jti")
);

-- CreateIndex
CREATE INDEX "RevokedToken_expiresAt_idx" ON "RevokedToken"("expiresAt");
