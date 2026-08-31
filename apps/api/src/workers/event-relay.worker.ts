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
  await startListingEventIntake()

  // EV.2 — the first durable consumer. Detection only: it publishes
  // inventory.oversell_risk_detected and writes nothing to any channel.
  // Opt out with NEXUS_DISABLE_OVERSELL_WATCHDOG=1.
  if (process.env.NEXUS_DISABLE_OVERSELL_WATCHDOG !== '1') {
    stopWatchdog = await startOversellWatchdog(broker)
  }

  const stats = await outboxStats().catch(() => null)
  logger.info('event infrastructure: started', {
    broker: broker.name,
    pendingOnBoot: stats?.pending ?? 'unknown',
    // A non-zero blocked count on boot means rows exhausted their retries
    // while this process was down. They are quarantined, not lost.
    blockedOnBoot: stats?.pendingBlocked ?? 'unknown',
  })
}

export async function stopEventInfrastructure(): Promise<void> {
  stopRelay()
  await stopListingEventIntake()
  await stopWatchdog?.()
  stopWatchdog = null
  started = false
}
