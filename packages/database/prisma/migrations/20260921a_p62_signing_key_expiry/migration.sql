-- P6.2 — when the eBay signing key expires.
--
-- eBay's Key Management API returns `expirationTime` on both createSigningKey and
-- getSigningKey. We read it, logged it into a connection event, and dropped it:
-- `storeSigningKey` had no expiry parameter and ChannelApp had no column for one.
--
-- Measured 2026-09-21: the EBAY/production row carries a real signing key
-- (signingKeyEnc + signingKeyId set), and nothing anywhere knows when it dies. When
-- it does, every signed eBay call — refunds (P0.3) and finances — fails with a 215xxx
-- signature error, which `EbayApiError.isSignatureError` already recognises and
-- nothing anticipates.
--
-- Additive and nullable: no backfill, no default, nothing reads it until P6.2's code
-- does. `secretExpiresAt` beside it is the CLIENT SECRET's date (P6.1) and stays a
-- separate fact — two different credentials with two different lifetimes.
ALTER TABLE "ChannelApp" ADD COLUMN IF NOT EXISTS "signingKeyExpiresAt" TIMESTAMP(3);

-- The last time we asked eBay for the key's metadata. Distinguishes "the key has no
-- expiry" from "we have never looked" — P3.6's rule: no_data is never a pass.
ALTER TABLE "ChannelApp" ADD COLUMN IF NOT EXISTS "signingKeyCheckedAt" TIMESTAMP(3);
