-- PD.9 — development certifications (additive: new table only).
CREATE TABLE "DevelopmentCertification" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "required" BOOLEAN NOT NULL DEFAULT true,
  "certNumber" TEXT,
  "issuer" TEXT,
  "issuedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "documentUrl" TEXT,
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DevelopmentCertification_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DevelopmentCertification_projectId_idx" ON "DevelopmentCertification"("projectId");
ALTER TABLE "DevelopmentCertification" ADD CONSTRAINT "DevelopmentCertification_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "DevelopmentProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
