-- Rollback for W4.1 — drop ProductTierPrice + CustomerGroup.
-- Order: child first (CASCADE handles its FKs), then parent.

DROP TABLE IF EXISTS "ProductTierPrice" CASCADE;
DROP TABLE IF EXISTS "CustomerGroup" CASCADE;
