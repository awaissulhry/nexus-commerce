-- DO.40 / W15 — rollback for ScheduledReport.
--
-- Drops the table + indexes. Cron job stops finding work and
-- becomes a no-op; outbound emails halt.

DROP INDEX IF EXISTS "ScheduledReport_isActive_frequency_idx";
DROP INDEX IF EXISTS "ScheduledReport_userId_idx";
DROP TABLE IF EXISTS "ScheduledReport";
