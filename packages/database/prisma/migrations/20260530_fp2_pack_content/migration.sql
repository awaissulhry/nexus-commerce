-- FP.2 — factory-pack content (additive nullable/defaulted columns).
ALTER TABLE "DevelopmentProject" ADD COLUMN "sizeChart" JSONB;
ALTER TABLE "DevelopmentProject" ADD COLUMN "materials" JSONB;
ALTER TABLE "DevelopmentProject" ADD COLUMN "colorways" JSONB;
ALTER TABLE "DevelopmentProject" ADD COLUMN "specNotes" TEXT;
ALTER TABLE "DevelopmentProject" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "DevelopmentAttachment" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "DevelopmentAttachment" ADD COLUMN "caption" TEXT;
ALTER TABLE "DevelopmentAttachment" ADD COLUMN "includeInPack" BOOLEAN NOT NULL DEFAULT true;
