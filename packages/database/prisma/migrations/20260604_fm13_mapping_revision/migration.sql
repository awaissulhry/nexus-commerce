-- FM.13 — MappingRevision: version history for Marketplace.schemaMapping (additive).

-- CreateTable
CREATE TABLE "MappingRevision" (
  "id" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "snapshot" JSONB NOT NULL,
  "changedBy" TEXT,
  "reason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MappingRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MappingRevision_channel_code_version_key" ON "MappingRevision"("channel", "code", "version");

-- CreateIndex
CREATE INDEX "MappingRevision_channel_code_idx" ON "MappingRevision"("channel", "code");
