-- O.2 rollback. Run manually — Prisma doesn't auto-execute rollback files.
-- Both tables are append-only and consumers land in later commits, so
-- a clean drop is safe before O.7+ ship. After O.7 lands, rolling back
-- is destructive — operator confirmation required.

DROP TABLE IF EXISTS "TrackingEvent" CASCADE;
DROP TABLE IF EXISTS "TrackingMessageLog" CASCADE;
DROP TYPE IF EXISTS "TrackingMessageStatus";
