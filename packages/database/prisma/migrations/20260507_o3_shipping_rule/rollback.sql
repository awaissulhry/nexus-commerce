-- O.3 rollback. Run manually — Prisma doesn't auto-execute rollback files.
-- Empty until O.16 lands; safe to drop pre-O.16. After O.16 + operator
-- starts saving rules, rolling back is destructive — operator
-- confirmation required.

DROP TABLE IF EXISTS "ShippingRule";
