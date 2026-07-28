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
