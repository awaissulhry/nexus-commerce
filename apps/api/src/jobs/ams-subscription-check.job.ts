/**
 * P2.7 — check the Amazon Marketing Stream subscriptions, per profile and per dataset.
 *
 * Nothing checked them. `POST /advertising/ams/subscribe` exists and is idempotent, but
 * it only runs when an operator presses it, and this failure is silent by nature: a
 * subscription that was never created, or that Amazon dropped, produces no error
 * anywhere — just an hour of advertising data that never arrives. The plan's own row
 * says it: *"not checked today"*.
 *
 * It REPORTS by default and creates nothing. Creating a subscription is a live channel
 * call, and the existing operator route already does that deliberately.
 *
 * The one thing this does differently from that route is the part that matters most:
 *
 *   `POST /advertising/ams/subscribe` swallows a failed list —
 *   `catch { /* list best-effort *\/ }` — leaving `have` empty and then attempting to
 *   create EVERY dataset. A list that could not be read is treated as a list that came
 *   back empty, which are opposite facts. Here a failed list is reported as `unknown`
 *   and nothing is inferred from it.
 */

import cron, { schedulePlatform } from '../lib/cron/clustered.js'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

export interface ProfileSubscriptionState {
  marketplace: string
  profileId: string
  /** `unknown` when Amazon could not be asked — never confused with "none subscribed". */
  status: 'checked' | 'unknown'
  subscribed: string[]
  missing: string[]
  error?: string
}

export interface AmsSubscriptionCheckResult {
  profiles: number
  fullySubscribed: number
  withGaps: number
  unreadable: number
  detail: ProfileSubscriptionState[]
}

/** One sweep. Exported so a test can run it without a scheduler. */
export async function runAmsSubscriptionCheck(): Promise<AmsSubscriptionCheckResult> {
  const { listAmsSubscriptions, AMS_DATASETS, amsRegionFor } = await import('../services/advertising/ads-marketing-stream.service.js')

  const connections = await prisma.amazonAdsConnection.findMany({
    where: { isActive: true, mode: 'production' },
    select: { marketplace: true, profileId: true },
  })

  const detail: ProfileSubscriptionState[] = []
  for (const connection of connections) {
    const region = amsRegionFor(connection.marketplace)
    try {
      const listed = (await listAmsSubscriptions(connection.profileId, region)) as {
        subscriptions?: Array<{ dataSetId?: string; status?: string }>
      }
      // Only an ACTIVE subscription counts. One Amazon has archived or suspended is
      // present in the list and delivers nothing, which is the most misleading state
      // of the three.
      const live = new Set(
        (listed?.subscriptions ?? [])
          .filter((s) => !s.status || /active/i.test(s.status))
          .map((s) => s.dataSetId ?? ''),
      )
      const missing = [...AMS_DATASETS].filter((dataset) => !live.has(dataset))
      detail.push({
        marketplace: connection.marketplace, profileId: connection.profileId,
        status: 'checked', subscribed: [...live].filter(Boolean), missing,
      })
    } catch (error) {
      // NOT "missing". A list we could not read and a list that came back empty are
      // opposite facts, and reporting the first as the second would send someone
      // creating subscriptions that already exist.
      detail.push({
        marketplace: connection.marketplace, profileId: connection.profileId,
        status: 'unknown', subscribed: [], missing: [],
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const result: AmsSubscriptionCheckResult = {
    profiles: detail.length,
    fullySubscribed: detail.filter((d) => d.status === 'checked' && d.missing.length === 0).length,
    withGaps: detail.filter((d) => d.status === 'checked' && d.missing.length > 0).length,
    unreadable: detail.filter((d) => d.status === 'unknown').length,
    detail,
  }

  if (result.withGaps > 0) {
    logger.error('[ams-subscription-check] profiles are missing AMS datasets — hourly data will not arrive for them', {
      gaps: detail.filter((d) => d.missing.length).map((d) => `${d.marketplace}/${d.profileId}: ${d.missing.join(',')}`).join(' | '),
    })
  }
  if (result.unreadable > 0) {
    logger.warn('[ams-subscription-check] some profiles could not be asked — this is NOT the same as having no subscriptions', {
      unreadable: detail.filter((d) => d.status === 'unknown').map((d) => `${d.marketplace}/${d.profileId}: ${d.error}`).join(' | '),
    })
  }
  if (result.profiles === 0) {
    // A sweep with nothing to look at is not a healthy sweep, and a green with an
    // empty denominator is the most reassuring wrong answer there is.
    logger.warn('[ams-subscription-check] no active production Amazon Ads connections — nothing was checked')
  }
  return result
}

export function startAmsSubscriptionCheckCron(): void {
  if (scheduledTask) {
    logger.warn('ams-subscription-check cron already started — skipping')
    return
  }
  if (process.env.NEXUS_ENABLE_AMS_SUBSCRIPTION_CHECK === '0') {
    logger.info('ams-subscription-check cron disabled via env')
    return
  }
  const schedule = process.env.NEXUS_AMS_SUBSCRIPTION_CHECK_SCHEDULE ?? '10 4 * * *'
  if (!cron.validate(schedule)) {
    logger.error('ams-subscription-check cron: invalid schedule', { schedule })
    return
  }
  // schedulePlatform: the Ads connections are read once for the whole installation, and
  // the check makes no business-scoped write.
  scheduledTask = schedulePlatform(schedule, async () => {
    await recordCronRun('ams-subscription-check', async () => {
      const result = await runAmsSubscriptionCheck()
      return `profiles=${result.profiles} complete=${result.fullySubscribed} gaps=${result.withGaps} unreadable=${result.unreadable}`
    }).catch((err) => {
      logger.error('ams-subscription-check cron: failure', { error: err instanceof Error ? err.message : String(err) })
    })
  })
  logger.info('ams-subscription-check cron started', { schedule })
}
