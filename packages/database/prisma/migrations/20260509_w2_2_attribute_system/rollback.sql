-- Rollback for W2.2 — drop AttributeOption + CustomAttribute +
-- AttributeGroup. Order matters: child → parent because of FK
-- constraints. CASCADE drops the FKs implicitly.

DROP TABLE IF EXISTS "AttributeOption" CASCADE;
DROP TABLE IF EXISTS "CustomAttribute" CASCADE;
DROP TABLE IF EXISTS "AttributeGroup" CASCADE;
