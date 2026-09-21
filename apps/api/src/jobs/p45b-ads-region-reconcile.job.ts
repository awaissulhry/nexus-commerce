/**
 * P4.5b — the advertising profiles the money path cannot see.
 *
 * ## What was measured (development database, 2026-09-21)
 *
 * The CX connector's `discoverScopes` sweeps all three Amazon Ads regions on every
 * successful heartbeat and records what it finds as `ConnectionScope` rows. It has
 * found **14 profiles**: 9 EU, 3 NA (US, CA, MX), 2 FE (AU, JP).
 *
 * `AmazonAdsConnection` — the table **25+ jobs, routes and services read** to answer
 * "which profiles do we have" — holds the **9 EU ones**. Five real advertising
 * profiles are invisible to every ads job.
 *
 * 🔴 The two answers come from two builders. `ads-profile-resolver.listAdsProfiles()`
 * reads the scopes and so already returns all 14 — and it has **zero callers**. The
 * accessor that would have made this visible exists, is referenced by nothing, and has
 * never run. The legacy table stays the system of record until CX.3c.
 *
 * ## What this job does, and what it deliberately does not
 *
 * Two different things, with two different risk profiles, so they are gated
 * differently:
 *
 * 1. **The region correction runs always.** `region` is not a label: the Ads client
 *    picks its API host from it (`ads-api-client.ts` → `REGION_ENDPOINT[ctx.region]`)
 *    and the connect callback wrote `'EU'` for every row. Today all nine rows really
 *    are EU so this corrects nothing — which is the point of running it now rather
 *    than after the first NA row exists.
 *
 * 2. **Creating the missing rows is OFF behind `NEXUS_ADS_ALL_REGIONS=1`,** and that
 *    is about spend, not doubt. A row with `isActive: true` is picked up by every read
 *    job that filters on it, so five new rows means five more profiles' worth of
 *    report and metrics calls against the Ads quota, for markets nothing in Nexus is
 *    set up for. New rows are therefore created **inactive** (`isActive` already
 *    defaults to `false` in the schema) and `mode: 'sandbox'`: the operator can see
 *    them on the Channels page and switch one on, which is a decision, not a default.
 *
 * `credentialsEncrypted` is left NULL on a new row on purpose. The nine existing rows
 * carry one identical credential blob between them (measured on prod 2026-08-29), and
 * `resolveCredentials` asks the connection core first, so a new row does not need its
 * own copy — and copying a secret to five more rows is the opposite of what P4.5e is
 * about to do.
 *
 * Idempotent and safe to re-run. **Scheduled** (daily) as well as registry-triggered:
 * P4.2d shipped a sweep into `CRON_REGISTRY` alone, called it drift detection, and
 * nothing ever called it.
 */
import cron from '../lib/cron/clustered.js'
import { workspaceKey } from '@nexus/database/workspace-context'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { asAdsRegion, type AdsRegion } from '../services/ads-core/ads-regions.js'

const JOB = 'p45b-ads-region-reconcile'

export interface AdsRegionReconcileReport {
  scopes: number
  created: number
  regionCorrected: number
  /** P4.5h — rows whose stored market disagreed with what Amazon reports. */
  marketCorrected: number
  unchanged: number
  createsSkippedOff: number
}

const createsEnabled = () => process.env.NEXUS_ADS_ALL_REGIONS === '1'

export async function reconcileAdsRegions(): Promise<AdsRegionReconcileReport> {
  const report: AdsRegionReconcileReport = {
    scopes: 0, created: 0, regionCorrected: 0, marketCorrected: 0, unchanged: 0, createsSkippedOff: 0,
  }

  const { tryResolveConnection } = await import('../services/connection-resolver.service.js')
  const conn = await tryResolveConnection({ channel: 'AMAZON_ADS', primary: true })
  if (!conn) return report

  const scopes = await prisma.connectionScope.findMany({
    where: { connectionId: conn.id, kind: 'profile' },
    select: { externalId: true, region: true, label: true, metadata: true },
  })
  report.scopes = scopes.length
  if (!scopes.length) return report

  const rows = new Map(
    (await prisma.amazonAdsConnection.findMany({ select: { profileId: true, region: true, marketplace: true } }))
      .map((r) => [r.profileId, r]),
  )

  for (const scope of scopes) {
    // A scope whose region Amazon did not name is not evidence about any region.
    // Skipping it is the honest answer; guessing EU is how the region became wrong
    // in the first place.
    const region = asAdsRegion(scope.region)
    if (!region) { report.unchanged++; continue }

    const meta = (scope.metadata ?? {}) as Record<string, unknown>
    /**
     * P4.5h — the market Amazon itself reports for this profile.
     *
     * Discovery writes `metadata.marketplace` from the profile's own `countryCode`,
     * so it is the channel's current answer rather than a column last written at
     * connect time. An empty or non-string value is not evidence and corrects nothing.
     */
    const market = typeof meta.marketplace === 'string' && meta.marketplace.trim() ? meta.marketplace.trim() : null

    const row = rows.get(scope.externalId)
    if (row) {
      const data: { region?: AdsRegion; marketplace?: string } = {}
      if (row.region !== region) data.region = region
      if (market && row.marketplace !== market) data.marketplace = market
      // Presence, not truthiness. `!data.marketplace` would also be true for an
      // empty string — so a change that blanked a market would take the
      // "nothing to do" branch and be invisible. (Found by a mutation that survived:
      // the guard was quietly neutralising the very defect the test aimed at.)
      if (Object.keys(data).length === 0) { report.unchanged++; continue }

      await prisma.amazonAdsConnection.update({
        where: { workspace_profileId: workspaceKey({ profileId: scope.externalId }) },
        data,
      })
      if (data.region) {
        report.regionCorrected++
        logger.warn('[p45b-ads-regions] corrected a profile stranded on the wrong API host', {
          profileId: scope.externalId, was: row.region, now: region,
        })
      }
      if (data.marketplace) {
        report.marketCorrected++
        logger.warn('[p45b-ads-regions] corrected a profile stored under the wrong market', {
          profileId: scope.externalId, was: row.marketplace, now: market,
        })
      }
      continue
    }

    if (!createsEnabled()) { report.createsSkippedOff++; continue }

    await prisma.amazonAdsConnection.create({
      data: {
        profileId: scope.externalId,
        // The market as Amazon reports it for this profile, which is what discovery
        // recorded. Never re-derived here: one fact, one source (P4.4a).
        marketplace: market ?? '',
        region,
        accountLabel: typeof meta.accountName === 'string' ? meta.accountName : (scope.label ?? null),
        // Inactive and sandbox: recorded, visible, and doing nothing until an
        // operator decides otherwise.
        isActive: false,
        mode: 'sandbox',
      },
    })
    report.created++
    logger.info('[p45b-ads-regions] recorded a profile the money path could not see', {
      profileId: scope.externalId, region, label: scope.label,
    })
  }

  return report
}

export async function runAdsRegionReconcile(): Promise<string> {
  return recordCronRun(JOB, async () => {
    const r = await reconcileAdsRegions()
    logger.info('[p45b-ads-regions] reconcile complete', r as unknown as Record<string, unknown>)
    return (
      `scopes=${r.scopes} created=${r.created} regionCorrected=${r.regionCorrected} ` +
      `marketCorrected=${r.marketCorrected} unchanged=${r.unchanged} createsSkippedOff=${r.createsSkippedOff}` +
      (r.createsSkippedOff > 0 ? ' (set NEXUS_ADS_ALL_REGIONS=1 to record them)' : '')
    )
  })
}

let scheduledTask: { stop: () => void } | null = null

/**
 * Scheduled, not registry-only.
 *
 * P4.2d's lesson, paid for once already: a job that exists only in `CRON_REGISTRY` is
 * a MANUAL trigger, and shipping one while saying "it now detects drift" was false.
 * Daily is right for this — a profile appears or a region changes at the pace an
 * operator reorganises an Amazon account, not hourly.
 */
export function startAdsRegionReconcileCron(): void {
  if (process.env.NEXUS_ADS_REGION_RECONCILE === '0') {
    logger.info(`${JOB} cron: disabled via NEXUS_ADS_REGION_RECONCILE=0`)
    return
  }
  if (scheduledTask) {
    logger.warn(`${JOB} cron already started — skipping`)
    return
  }
  const schedule = process.env.NEXUS_ADS_REGION_RECONCILE_SCHEDULE ?? '35 4 * * *'
  if (!cron.validate(schedule)) {
    logger.error(`${JOB} cron: invalid schedule, not starting`, { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, async () => {
    await runAdsRegionReconcile()
  })
  logger.info(`${JOB} cron: scheduled`, { schedule, creates: createsEnabled() ? 'on' : 'off' })
}
