/**
 * P3.2 (FINAL-PLAN section 6, row P3.2) — the scheduled job the plan row asks for:
 * *"…and suppression (add a scheduled job)"*.
 *
 * Amazon suppression already had an ingest (`ingestAmazonSuppressionAllMarketplaces`)
 * and a table (`AmazonSuppression`), but nothing ran it on a schedule and nothing put a
 * suppression on the listing's issue list. So a suppressed listing looked healthy on the
 * one screen an operator reads — the flat-file grid's health chip reads `ListingIssue`,
 * not `AmazonSuppression`.
 *
 * Two halves, and the second is the one that matters:
 *
 *  1. pull the current suppression state from Amazon, and
 *  2. mirror it onto the listings — including the listings that are NO LONGER
 *     suppressed, whose issue must be resolved. A job that only ever adds rows turns
 *     into a wall of stale red within a week. `amazon-suppression` is a 'replace'
 *     source precisely so silence resolves.
 *
 * Self-guards: no Amazon credentials, or no Amazon listings, and it does nothing. A
 * non-platform `cron.schedule` already visits every active business profile and runs
 * the handler inside each one, so this reads only its own profile's rows.
 *
 * ## Why the Amazon pull is OFF by default
 *
 * The mirror is local and cheap, so it runs on every tick. The PULL is not: it asks
 * SP-API for a `GET_MERCHANT_LISTINGS_DEFECT_DATA` **report**, once per marketplace,
 * and reports are a scarce, slow, quota-limited resource. Five EU marketplaces on an
 * hourly schedule would be 120 report requests a day, in every business profile, on
 * every clone of this database.
 *
 * `amazon-returns-poll.job.ts` sets the precedent in as many words — default-OFF
 * because "we don't want a fresh dev clone burning the operator's report quota" — and
 * this job follows it. Set `NEXUS_ENABLE_AMAZON_SUPPRESSION_PULL=true` in production to
 * turn the pull on; the mirror half needs no switch.
 *
 * The schedule is DAILY, not hourly, for the same reason. Suppression is a slow-moving
 * state Amazon reports in a batch file; the fast path for a rejection is the feed report
 * and the issues notification, both of which land within a minute.
 */

import cron from '../lib/cron/clustered.js'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { amazonCredsConfigured } from '../lib/amazon-sp-client.js'
import { recordSuppressionIssues } from '../services/listing-issue-recorder.service.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

export interface SuppressionSweepResult {
  /** Listings looked at. */
  scanned: number
  /** Listings that now carry a suppression issue. */
  listings: number
  /** Issue rows opened or bumped. */
  issues: number
  /** Issues closed because the listing is no longer suppressed. */
  resolved: number
  /** Whether the Amazon pull ran; false means we mirrored what we already had. */
  ingested: boolean
}

/** Chunk size for the mirror — a business can hold thousands of Amazon listings. */
const CHUNK = 200

/** The Amazon report pull is an Owner switch, like P1.8's contract run and P6.1. */
export function suppressionPullEnabled(): boolean {
  return process.env.NEXUS_ENABLE_AMAZON_SUPPRESSION_PULL === 'true'
}

export async function runSuppressionIssueSweep(opts: { ingest?: boolean } = {}): Promise<SuppressionSweepResult> {
  const empty: SuppressionSweepResult = { scanned: 0, listings: 0, issues: 0, resolved: 0, ingested: false }
  if (!(await amazonCredsConfigured())) return empty

  // 1. Refresh from Amazon — a REPORT request per marketplace, so it is off unless the
  //    Owner turns it on. A failure here is not fatal: mirroring the suppression rows we
  //    already hold is still better than a grid that shows nothing, and the next tick
  //    tries again. Reporting a stale mirror as fresh would be the worse error, so the
  //    result says which happened.
  let ingested = false
  if (opts.ingest === true || (opts.ingest !== false && suppressionPullEnabled())) {
    try {
      const { ingestAmazonSuppressionAllMarketplaces } = await import(
        '../services/amazon-suppression-ingest.service.js'
      )
      await ingestAmazonSuppressionAllMarketplaces({})
      ingested = true
    } catch (e: any) {
      logger.warn('[suppression-issues] Amazon pull failed — mirroring what we hold', { error: e?.message })
    }
  }

  // 2. Mirror onto EVERY Amazon listing, not only the suppressed ones. A listing that
  //    came off suppression has no row to drive its own resolve, so scoping this to the
  //    suppressed set would leave its issue open for ever.
  const listings = await prisma.channelListing.findMany({
    where: { channel: 'AMAZON' },
    select: { id: true },
  })
  if (listings.length === 0) return { ...empty, ingested }

  let total = { listings: 0, issues: 0, resolved: 0 }
  for (let i = 0; i < listings.length; i += CHUNK) {
    const batch = listings.slice(i, i + CHUNK).map((l) => l.id)
    const r = await recordSuppressionIssues({ listingIds: batch })
    total.listings += r.listings
    total.issues += r.issues
    total.resolved += r.resolved
  }

  logger.info('[suppression-issues] sweep', { scanned: listings.length, ...total, ingested })
  return { scanned: listings.length, ...total, ingested }
}

export function startSuppressionIssueCron(): void {
  if (scheduledTask) {
    logger.warn('suppression-issues cron already started')
    return
  }
  // Daily. See the header: the pull costs an SP-API report per marketplace, and the
  // fast path for a rejection is the feed report and the issues notification.
  const schedule = process.env.NEXUS_SUPPRESSION_ISSUE_SCHEDULE ?? '25 4 * * *'
  if (!cron.validate(schedule)) {
    logger.error('suppression-issues cron: invalid schedule', { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, async () => {
    await recordCronRun('suppression-issues', async () => {
      const r = await runSuppressionIssueSweep()
      return `scanned=${r.scanned} listings=${r.listings} issues=${r.issues} resolved=${r.resolved} ingested=${r.ingested} pull=${suppressionPullEnabled() ? 'on' : 'off'}`
    })
  })
  logger.info('suppression-issues cron: scheduled', { schedule, amazonPull: suppressionPullEnabled() ? 'on' : 'off' })
}

export function stopSuppressionIssueCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}
