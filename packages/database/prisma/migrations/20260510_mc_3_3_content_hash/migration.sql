-- MC.3.3: content-hash dedup column on DigitalAsset.
-- SHA-256 (64-hex-char) of the uploaded bytes. NULL allowed because
-- legacy rows pre-date this commit; new uploads always populate it.

ALTER TABLE "DigitalAsset" ADD COLUMN IF NOT EXISTS "contentHash" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "DigitalAsset_contentHash_key"
  ON "DigitalAsset"("contentHash");
