-- F.6 — BrandSettings table for letterhead / company-identity rendering.
--
-- Single-row table; the GET endpoint creates a default row on first read
-- so the rest of the codebase doesn't need to handle the missing-row
-- branch. PostgreSQL doesn't enforce single-row constraints natively;
-- the application layer enforces it via "always upsert by an id stored
-- in app state" rather than a DB constraint, matching how
-- AccountSettings handles the same pattern.

CREATE TABLE "BrandSettings" (
  "id"                 TEXT PRIMARY KEY,

  "companyName"        TEXT,
  "addressLines"       TEXT[] NOT NULL DEFAULT '{}',
  "taxId"              TEXT,
  "contactEmail"       TEXT,
  "contactPhone"       TEXT,
  "websiteUrl"         TEXT,

  "logoUrl"            TEXT,

  "signatureBlockText" TEXT,
  "defaultPoNotes"     TEXT,
  "factoryEmailFrom"   TEXT,

  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
