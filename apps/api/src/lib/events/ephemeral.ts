// EV.1 — the ephemeral lane.
//
// Two lanes exist on purpose, and which one an event belongs in is a real
// decision, not a convenience:
//
//   DURABLE   publishEvent(tx, …) → EventOutbox → relay → broker
//             For domain FACTS. Survives a crash. Costs one row inside the
//             caller's transaction. Anything stock, money or state-machine
//             shaped belongs here.
//
//   EPHEMERAL publishEphemeral(…) → broker, directly. No row, no durability.
//             For refresh HINTS — "this grid is stale, refetch". Losing one
//             costs a subscriber a few seconds until its next poll, and
//             nothing else.
//
// The listing bus is the second kind. Putting `bulk.progress` through the
// outbox would mean a database write per progress tick to tell a grid to
// refresh itself — paying durability's cost for a message whose entire value
// expires in seconds.
//
// Getting this backwards in either direction is a real defect: a lost fact is
// corruption, and a durable refresh hint is a self-inflicted write storm.

import { logger } from '../../utils/logger.js'
import type { EventEnvelope, EventPayload, EventType } from '@nexus/events'
import { buildEnvelope, type PublishOptions } from './publish.js'
import { getBroker } from './index.js'

/**
 * Ids this process published, so the broker echo of our own event is not
 * delivered locally a second time (we already delivered it synchronously).
 * Bounded — an unbounded dedupe set is just a slow leak.
 */
const MAX_SELF_IDS = 5_000
const selfPublished = new Set<string>()

function rememberSelf(id: string): void {
  selfPublished.add(id)
  if (selfPublished.size > MAX_SELF_IDS) {
    // Sets iterate in insertion order, so this drops the oldest.
    const oldest = selfPublished.values().next().value
    if (oldest) selfPublished.delete(oldest)
  }
}

/** True if this process published the event — the local listeners already saw it. */
export function isSelfPublished(envelope: EventEnvelope): boolean {
  return selfPublished.has(envelope.id)
}

/**
 * Fire-and-forget publish straight to the broker. Synchronous by design: the
 * callers are synchronous `publish*Event()` functions with a dozen call sites
 * each, and making them async to await a refresh hint would be a worse trade
 * than dropping one on a broker hiccup.
 */
export function publishEphemeral<T extends EventType>(
  type: T,
  payload: EventPayload<T>,
  options: PublishOptions = {},
): EventEnvelope<EventPayload<T>> | null {
  let envelope: EventEnvelope<EventPayload<T>>
  try {
    envelope = buildEnvelope(type, payload, options)
  } catch (error) {
    // A malformed payload is a programming error; it must be loud, but it must
    // not take down the mutation that triggered it.
    logger.error('ephemeral publish: invalid payload, event dropped', {
      type,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }

  rememberSelf(envelope.id)
  void getBroker()
    .publish([envelope])
    .catch((error) => {
      logger.debug('ephemeral publish: broker unavailable, hint dropped', {
        type,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  return envelope
}

/**
 * Same, for a caller holding a type it only knows at runtime — a bus adapter
 * mapping its own union onto the catalogue, say.
 *
 * The payload cast is contained here rather than repeated at call sites, and
 * it is not a hole: buildEnvelope runs the catalogue's strict schema over the
 * payload, so a mismatch fails loudly at publish time. Static correlation of
 * type-to-payload is simply not available when the type is a variable.
 */
export function publishEphemeralDynamic(
  type: EventType,
  payload: unknown,
  options: PublishOptions = {},
): EventEnvelope | null {
  return publishEphemeral(type, payload as EventPayload<EventType>, options) as EventEnvelope | null
}
