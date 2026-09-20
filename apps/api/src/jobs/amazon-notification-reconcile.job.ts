/**
 * P2.2 — nightly reconcile of the Amazon notification subscriptions.
 *
 * `ensureAmazonNotificationSubscription()` runs once, at boot, fire-and-forget. That
 * was the only thing keeping the subscriptions alive, which means the window between
 * two deploys was a window in which nobody was checking. A subscription deleted in
 * Seller Central, a destination recycled by Amazon, or one boot run that failed while
 * the API was warming up would all go unnoticed until the next deploy — and the
 * failure is silent by nature: notifications simply stop arriving, which looks exactly
 * like a quiet day.
 *
 * So this runs nightly and reports what it found. The underlying setup is idempotent
 * and already heals a subscription pointed at a foreign destination (RT.3), so a
 * reconcile that finds nothing wrong costs six GETs.
 *
 * It does not CREATE anything new on its own: `sqsNotificationSpecs()` gives it the
 * types that are live today unless the Owner has turned on
 * NEXUS_AMAZON_SUBSCRIBE_NEW_TYPES, because creating a subscription is a live channel
 * call and a production write.
 *
 * Cadence: 03:40 UTC, away from the 02:00 financial sync and the top of the hour.
 * Gated behind NEXUS_ENABLE_AMAZON_NOTIFICATION_RECONCILE, default ON.
 */

import cron, { schedulePlatform } from '../lib/cron/clustered.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

export interface ReconcileStats {
  destinationId: string | null
  checked: number
  alreadyActive: number
  createdOrHealed: number
  failed: number
  detail: string
}

/** One reconcile. Exported so a test can run it without a scheduler. */
export async function runAmazonNotificationReconcile(): Promise<ReconcileStats> {
  const { setupAllAmazonNotifications } = await import('../services/amazon-notifications-boot.service.js')
  const result = await setupAllAmazonNotifications()
  const stats: ReconcileStats = {
    destinationId: result.destinationId,
    checked: result.perType.length,
    alreadyActive: result.perType.filter((r) => r.status === 'already_exists').length,
    createdOrHealed: result.perType.filter((r) => r.status === 'created' || r.status === 'healed').length,
    failed: result.perType.filter((r) => r.status === 'failed').length,
    detail: result.perType.map((r) => `${r.type}=${r.status}`).join(' '),
  }

  // A reconcile that CHANGED something is the interesting case: it means the
  // subscriptions had drifted since the last deploy, which is the thing nobody was
  // watching for. Say so loudly rather than burying it in an info line.
  if (stats.createdOrHealed > 0 || stats.failed > 0) {
    logger.warn('[amazon-notification-reconcile] subscriptions had drifted', stats)
  } else {
    logger.info('[amazon-notification-reconcile] all subscriptions healthy', {
      destinationId: stats.destinationId,
      checked: stats.checked,
    })
  }
  return stats
}

export function startAmazonNotificationReconcileCron(): void {
  if (scheduledTask) {
    logger.warn('amazon-notification-reconcile cron already started — skipping')
    return
  }
  if (process.env.NEXUS_ENABLE_AMAZON_NOTIFICATION_RECONCILE === '0') {
    logger.info('amazon-notification-reconcile cron disabled via env')
    return
  }
  const schedule = process.env.NEXUS_AMAZON_NOTIFICATION_RECONCILE_SCHEDULE ?? '40 3 * * *'
  if (!cron.validate(schedule)) {
    logger.error('amazon-notification-reconcile cron: invalid schedule', { schedule })
    return
  }
  // schedulePlatform, not schedule: there is ONE Amazon SQS destination and one set of
  // subscriptions for the whole installation. Running this per business profile would
  // repeat the same six SP-API calls once per profile and race itself on the heal path.
  scheduledTask = schedulePlatform(schedule, async () => {
    await recordCronRun('amazon-notification-reconcile', async () => {
      const stats = await runAmazonNotificationReconcile()
      return `checked=${stats.checked} active=${stats.alreadyActive} fixed=${stats.createdOrHealed} failed=${stats.failed}`
    }).catch((err) => {
      logger.error('amazon-notification-reconcile cron: failure', {
        error: err instanceof Error ? err.message : String(err),
      })
    })
  })
  logger.info('amazon-notification-reconcile cron started', { schedule })
}
