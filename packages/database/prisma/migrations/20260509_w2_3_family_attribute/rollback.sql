-- Rollback for W2.3 — drop FamilyAttribute. CASCADE removes the
-- two FKs implicitly.
DROP TABLE IF EXISTS "FamilyAttribute" CASCADE;
