// EV.1 — the outbox relay worker.
//
// Starts the drain loop and attaches this replica to the broker for the
// cross-replica listing fan-out. Both are safe to run on every instance:
// the relay claims rows with SKIP LOCKED (two relays never collide), and the
// broadcast listener holds its cursor in-process (nothing to leak).
//
// Fire-and-forget by design, matching tryStartQueueWorkers: an unreachable
// Redis must never block boot. The outbox keeps accumulating rows meanwhile
// and the relay drains them when the broker comes back — that is the entire
// point of writing them down first.

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

let started = false
let stopWatchdog: (() => Promise<void>) | null = null

export async function startEventInfrastructure(): Promise<void> {
  if (started) return
  started = true

  if (!isRedisConfigured()) {
    // Not an error: HTTP works, mutations work, and events queue durably in
    // Postgres. Said out loud because "events are not flowing" should never be
    // something an operator has to deduce.
    const stats = await outboxStats().catch(() => null)
    logger.warn('event infrastructure: Redis not configured — relay idle, events accumulating in the outbox', {
      pending: stats?.pending ?? 'unknown',
    })
    return
  }

  const broker = getBroker()
  startRelay(broker)

  // EV.3 — attach EVERY bus to the broker, not just the listing one.
  //
  // Nine buses each held their own listener Set and were invisible to a second
  // replica; with one attached, eight remained. Running more than one API
  // instance was unsafe until all nine were here, because the failure is
  // silent: a browser attached to instance B simply never hears about a
  // mutation made on instance A.
  await Promise.all([
    startListingEventIntake(),
    startInboundEventIntake(),
    startOutboundEventIntake(),
    startSyncLogEventIntake(),
    startPoEventIntake(),
    startOrderEventIntake(),
    startMarketingEventIntake(),
    startReviewEventIntake(),
    startAdsExecutionEventIntake(),
  ])

  // EV.2 — the first durable consumer. Detection only: it publishes
  // inventory.oversell_risk_detected and writes nothing to any channel.
  // Opt out with NEXUS_DISABLE_OVERSELL_WATCHDOG=1.
  if (process.env.NEXUS_DISABLE_OVERSELL_WATCHDOG !== '1') {
    stopWatchdog = await startOversellWatchdog(broker)
  }

  const stats = await outboxStats().catch(() => null)
  logger.info('event infrastructure: started', {
    broker: broker.name,
    busesAttached: 9,
    pendingOnBoot: stats?.pending ?? 'unknown',
    // A non-zero blocked count on boot means rows exhausted their retries
    // while this process was down. They are quarantined, not lost.
    blockedOnBoot: stats?.pendingBlocked ?? 'unknown',
  })
}

export async function stopEventInfrastructure(): Promise<void> {
  stopRelay()
  await Promise.all([
    stopListingEventIntake(), stopInboundEventIntake(), stopOutboundEventIntake(),
    stopSyncLogEventIntake(), stopPoEventIntake(), stopOrderEventIntake(),
    stopMarketingEventIntake(), stopReviewEventIntake(), stopAdsExecutionEventIntake(),
  ])
  await stopWatchdog?.()
  stopWatchdog = null
  started = false
}
