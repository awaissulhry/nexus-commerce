/**
 * AX2.3 — one source of truth per grain.
 *
 * Amazon Marketing Stream used to upsert BOTH the daily and the hourly
 * performance tables. The daily grain is already owned by the report pipeline
 * (authoritative, reconciled at 72 h), so the stream's daily rows were a second,
 * parallel set for the same campaign-days — written under `profileId: 'ams'`
 * with `localEntityId` left null.
 *
 * That null is what made it dangerous. Every daily aggregate in the console
 * matches `localEntityId = <campaign>` OR `entityId = <externalCampaignId>`,
 * on the assumption that a `localEntityId: null` row is a campaign we could not
 * link. AMS rows ARE linked — so they matched the second arm and were summed on
 * top of the report figures, inflating spend, sales, impressions, clicks and
 * orders (and therefore ACoS and ROAS) on the Ad Manager grid, campaign detail,
 * and the trends chart.
 *
 * Ingestion no longer writes daily rows. This marker excludes the ~659 already
 * in the table, so the arithmetic is correct without deleting audit data.
 */

/** `reportRunId` stamped on rows the stream wrote to the DAILY table. */
export const AMS_DAILY_MARKER = 'ams-stream'

/**
 * Spread into any `amazonAdsDailyPerformance` where-clause that aggregates.
 * Safe to apply everywhere: report rows carry a real report-run id, so this
 * only ever removes stream-written duplicates.
 */
export const EXCLUDE_AMS_DAILY = { reportRunId: { not: AMS_DAILY_MARKER } } as const

/**
 * The same exclusion for a RAW-SQL aggregate, given the table's alias.
 *
 * 🔴 `IS DISTINCT FROM`, never `<>`. `reportRunId` is nullable in the schema, and
 * `NULL <> 'ams-stream'` is NULL, not true — a plain `<>` would silently drop every row
 * without a run id. (Measured 2026-08-26: no row on this table currently carries a null
 * run id, so the two forms happen to agree today. That is a fact about the data, not about
 * the SQL, and it can stop being true the moment an ingest path writes one.)
 *
 * Lives here rather than in a caller so the marker string has ONE definition across the
 * Prisma and SQL forms. Before checking a new aggregate over this table, run
 * `grep -rl EXCLUDE_AMS_DAILY apps/api/src` — every consumer that forgot it has over-reported.
 */
export const excludeAmsDailySql = (alias: string): string =>
  `${alias}."reportRunId" IS DISTINCT FROM '${AMS_DAILY_MARKER}'`
