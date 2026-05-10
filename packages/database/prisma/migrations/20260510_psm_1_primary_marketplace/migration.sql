-- PSM.1 — operator's primary marketplace.
--
-- Adds a single nullable column to AccountSettings so the operator
-- can declare which marketplace matters most (e.g. "IT" for Xavia's
-- Amazon IT focus). Consumers default-select on Step 1 of the
-- list-wizard. Null = no preference.

ALTER TABLE "AccountSettings"
  ADD COLUMN IF NOT EXISTS "primaryMarketplace" TEXT;
