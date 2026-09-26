-- Resume unfinished receipt scans without repeatedly restarting the overlap window.
ALTER TABLE "EtsyReceiptIngest" ADD COLUMN "scanUpdatedAt" TIMESTAMP(3), ADD COLUMN "scanOffset" INTEGER NOT NULL DEFAULT 0;
