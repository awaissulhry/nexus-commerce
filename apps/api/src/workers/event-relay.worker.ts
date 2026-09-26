// API replicas attach browser event intake; workers own relay and durable consumers.
import { logger } from '../utils/logger.js'
import { getBroker, isRedisConfigured, startRelay, stopRelay, outboxStats } from '../lib/events/index.js'
import { startListingEventIntake, stopListingEventIntake } from '../services/listing-events.service.js'
import { startInboundEventIntake, stopInboundEventIntake } from '../services/inbound-events.service.js'
import { startOutboundEventIntake, stopOutboundEventIntake } from '../services/outbound-events.service.js'
import { startSyncLogEventIntake, stopSyncLogEventIntake } from '../services/sync-logs-events.service.js'
import { startPoEventIntake, stopPoEventIntake } from '../services/po-events.service.js'
import { startOrderEventIntake, stopOrderEventIntake } from '../services/order-events.service.js'
import { startMarketingEventIntake, stopMarketingEventIntake } from '../services/marketing-events.service.js'
import { startReviewEventIntake, stopReviewEventIntake } from '../services/review-events.service.js'
import { startAdsExecutionEventIntake, stopAdsExecutionEventIntake } from '../services/ads-execution-events.service.js'
import { startOversellWatchdog } from '../services/inventory-oversell-watchdog.service.js'

type Stop = () => Promise<void>
const intakes: Array<[() => Promise<void>, Stop]> = [
  [startListingEventIntake, stopListingEventIntake],
  [startInboundEventIntake, stopInboundEventIntake],
  [startOutboundEventIntake, stopOutboundEventIntake],
  [startSyncLogEventIntake, stopSyncLogEventIntake],
  [startPoEventIntake, stopPoEventIntake],
  [startOrderEventIntake, stopOrderEventIntake],
  [startMarketingEventIntake, stopMarketingEventIntake],
  [startReviewEventIntake, stopReviewEventIntake],
  [startAdsExecutionEventIntake, stopAdsExecutionEventIntake],
]
let started = false
let starting: Promise<void> | null = null
let relayStarted = false
const stops: Stop[] = []

async function cleanup(): Promise<void> {
  if (relayStarted) await stopRelay()
  relayStarted = false
  const results = await Promise.allSettled(stops.splice(0).map(stop => stop()))
  started = false
  if (results.some(result => result.status === 'rejected')) logger.error('Event infrastructure cleanup failed')
}

export async function startEventInfrastructure(options: { relay?: boolean; intake?: boolean; watchdog?: boolean } = {}): Promise<void> {
  if (started) return
  if (starting) return starting
  starting = (async () => {
    if (!isRedisConfigured()) {
      logger.warn('Event infrastructure idle: Redis is not configured; durable events remain in PostgreSQL')
      return
    }
    const broker = getBroker()
    try {
      if (options.relay !== false) { startRelay(broker); relayStarted = true }
      if (options.intake !== false) {
        // Wait for every attachment before cleaning up a partial failure. Otherwise
        // a slow attachment can finish after shutdown and leak its subscription.
        const results = await Promise.allSettled(intakes.map(async ([start, stop]) => { await start(); stops.push(stop) }))
        const failed = results.find(result => result.status === 'rejected')
        if (failed?.status === 'rejected') throw failed.reason
      }
      if (options.watchdog !== false && process.env.NEXUS_DISABLE_OVERSELL_WATCHDOG !== '1') {
        stops.push(await startOversellWatchdog(broker))
      }
      started = true
      const stats = await outboxStats().catch(() => null)
      logger.info('Event infrastructure started', { broker: broker.name, relay: relayStarted,
        busesAttached: options.intake === false ? 0 : 9, pending: stats?.pending ?? 'unknown' })
    } catch (error) { await cleanup(); throw error }
  })()
  try { await starting } finally { starting = null }
}

export async function stopEventInfrastructure(): Promise<void> {
  await starting?.catch(() => {})
  await cleanup()
}
