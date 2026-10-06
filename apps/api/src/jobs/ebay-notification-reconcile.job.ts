/**
 * P2.3 — nightly reconcile of the eBay notification destination and subscriptions.
 *
 * The Amazon side (P2.2) learned that a boot-only setup leaves the gap between two
 * deploys unwatched, and that this failure is silent: notifications just stop, which
 * looks like a quiet day. eBay is worse, because eBay ACTS on silence — an endpoint
 * that fails the ownership challenge is marked down after 24 hours and every topic
 * goes with it.
 *
 * So this runs nightly and says what it found. It is idempotent: a destination that
 * already points at our endpoint is reused, an existing subscription is left alone, and
 * a disabled one is enabled rather than recreated. Nothing is ever deleted.
 *
 * Provisioning requires the Owner's arming (`ebayNotificationSetupGate`): exact
 * NEXUS_ENABLE_EBAY_NOTIFICATION_SETUP=1 AND NEXUS_EBAY_NOTIFICATION_ARMED_TOPICS naming
 * each ready topic (AUTHORIZATION_REVOCATION, ORDER_CONFIRMATION), plus a configured
 * endpoint/token. The old switch alone schedules nothing: a scheduler may still hold it
 * from before it became opt-in, and a deploy must never start live subscriptions. The
 * setup service and the admin route enforce the same gate independently.
 *
 * GAP2 phase 2: after the app-level setup, when ORDER_CONFIRMATION is armed, every active
 * business is visited and each of its own active eBay accounts is subscribed with that
 * seller's own token (`seller-subscriptions.ts`). An account whose sign-in lacks the
 * permission is reported "reconnect needed" and gets no call.
 *
 * Cadence: 03:55 UTC, after the Amazon reconcile at 03:40 so the two do not interleave
 * in the logs.
 */

import cron, { schedulePlatform } from '../lib/cron/clustered.js'
import { logger } from '../utils/logger.js'
import { ebayNotificationSetupGate } from '../services/cx/connectors/ebay/notifications.js'
import { recordCronRun } from '../utils/cron-observability.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

/** The app-level setup, then each seller's own subscription. */
export async function runEbayNotificationReconcile() {
  const result = await runAppLevelReconcile()
  const { reconcileEbaySellersForSetup, summariseSellerReport } = await import('../services/cx/connectors/ebay/seller-subscriptions.js')
  const sellers = await reconcileEbaySellersForSetup(result, 'every_business')
  const reconnect = sellers.accounts.filter(account => account.status === 'reconnect_needed').length
  if (sellers.accounts.some(account => account.status === 'failed' || account.status === 'not_offered')) {
    logger.error('[ebay-notification-reconcile] a seller order subscription failed', {
      failures: sellers.accounts.filter(account => account.status === 'failed' || account.status === 'not_offered')
        .map(account => ({ connectionId: account.connectionId, status: account.status, reason: account.reason })),
    })
  } else if (reconnect) {
    logger.warn('[ebay-notification-reconcile] eBay accounts need Reconnect before they can receive order notices', { accounts: reconnect })
  } else if (!sellers.skipped) {
    logger.info('[ebay-notification-reconcile] seller order subscriptions reconciled', { summary: summariseSellerReport(sellers) })
  }
  return { ...result, sellers }
}

async function runAppLevelReconcile() {
  const { setupEbayNotifications, ebayNotificationSetupSucceeded } = await import('../services/cx/connectors/ebay/notifications.js')
  const result = await setupEbayNotifications({ skipTopicsWithoutHandlers: true })

  if (!result.configured) {
    // Not an error: an installation with no eBay notification endpoint configured is a
    // valid state, and a nightly stack trace about it would train everyone to ignore
    // this job's output.
    logger.info('[ebay-notification-reconcile] not configured — no call made', { reason: result.error })
    return result
  }
  if (!result.armed) {
    logger.info('[ebay-notification-reconcile] not armed — no call made', { reason: result.error })
    return result
  }
  if (result.notOffered.length) {
    logger.error('[ebay-notification-reconcile] topic ids eBay does not offer', { notOffered: result.notOffered })
  }
  if (!ebayNotificationSetupSucceeded(result)) {
    logger.error('[ebay-notification-reconcile] reconciliation failed', {
      destinationId: result.destinationId, error: result.error,
      failures: result.perTopic.filter(topic => !['created', 'enabled', 'already_exists'].includes(topic.status)),
    })
    return result
  }
  const changed = result.perTopic.filter((r) => r.status === 'created' || r.status === 'enabled')
  if (changed.length) {
    logger.warn('[ebay-notification-reconcile] subscriptions had drifted', {
      destinationId: result.destinationId,
      changed: changed.map((r) => `${r.topicId}=${r.status}`).join(' '),
    })
  } else {
    logger.info('[ebay-notification-reconcile] supported subscriptions reconciled; topics without handlers remain excluded', {
      destinationId: result.destinationId,
      topics: result.perTopic.length,
    })
  }
  return result
}

export function startEbayNotificationReconcileCron(): void {
  if (scheduledTask) {
    logger.warn('ebay-notification-reconcile cron already started — skipping')
    return
  }
  const gate = ebayNotificationSetupGate()
  if (!gate.armed) {
    logger.info('ebay-notification-reconcile cron not armed — nothing scheduled, no eBay call', { reason: gate.reason })
    return
  }
  const schedule = process.env.NEXUS_EBAY_NOTIFICATION_RECONCILE_SCHEDULE ?? '55 3 * * *'
  if (!cron.validate(schedule)) {
    logger.error('ebay-notification-reconcile cron: invalid schedule', { schedule })
    return
  }
  // schedulePlatform: there is ONE application-level destination and one set of
  // subscriptions for the whole installation, not one per business profile.
  scheduledTask = schedulePlatform(schedule, async () => {
    await recordCronRun('ebay-notification-reconcile', async () => {
      const result = await runEbayNotificationReconcile()
      if (!result.configured) return 'not configured'
      if (!result.armed) return 'not armed — no call made'
      const { ebayNotificationSetupSucceeded } = await import('../services/cx/connectors/ebay/notifications.js')
      const { sellerReportFailed, summariseSellerReport } = await import('../services/cx/connectors/ebay/seller-subscriptions.js')
      if (!ebayNotificationSetupSucceeded(result)) {
        throw new Error(result.error ?? `eBay notification reconciliation failed: ${[
          ...result.perTopic.map(topic => `${topic.topicId}:${topic.status}`), ...result.notOffered.map(topicId => `${topicId}:not_offered`),
        ].join(' ') || 'no supported subscriptions'}`)
      }
      // "Reconnect needed" is the Owner's step, reported in the summary; a failed seller call fails the run.
      if (sellerReportFailed(result.sellers)) throw new Error(`eBay seller order subscriptions failed: ${summariseSellerReport(result.sellers)}`)
      return `destination=${result.destinationId} topics=${result.perTopic.map((r) => `${r.topicId}:${r.status}`).join(' ')} ${summariseSellerReport(result.sellers)}`
    }).catch((err) => {
      logger.error('ebay-notification-reconcile cron: failure', {
        error: err instanceof Error ? err.message : String(err),
      })
    })
  })
  logger.info('ebay-notification-reconcile cron started', { schedule, topics: gate.topics.join(',') })
}
