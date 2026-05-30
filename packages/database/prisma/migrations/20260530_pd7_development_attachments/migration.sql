-- PD.7 — development attachments (additive: new table only).
CREATE TABLE "DevelopmentAttachment" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'TECH_PACK',
  "url" TEXT NOT NULL,
  "filename" TEXT,
  "sizeBytes" INTEGER,
  "uploadedBy" TEXT,
  "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DevelopmentAttachment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DevelopmentAttachment_projectId_idx" ON "DevelopmentAttachment"("projectId");
ALTER TABLE "DevelopmentAttachment" ADD CONSTRAINT "DevelopmentAttachment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "DevelopmentProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
