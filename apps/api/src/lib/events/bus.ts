// EV.3 — the cross-replica bus factory.
//
// Nine in-process buses existed, written independently, each ~50-280 lines of
// the same thing: a Set of listeners, a publish that loops it, a listener
// count, and — in four of them — a replay ring buffer. Every one was invisible
// to a second replica, which is the ceiling that stopped this platform running
// more than one API instance.
//
// EV.1 rewired ONE of them (listing-events) by hand. Doing the other eight the
// same way would have produced eight more near-copies of the same forty lines,
// and the next person to add a bus would have copied a ninth. This is that
// logic once.
//
// What a bus gets from here:
//   - local delivery, synchronously, in the publishing tick (unchanged)
//   - fan-out to other replicas over the broker's EPHEMERAL lane
//   - intake of other replicas' events, delivered to local listeners
//   - self-echo suppression, so the publisher does not see its own event twice
//   - an optional replay buffer, for a tab that reconnects
//
// These are REFRESH HINTS, deliberately: a dropped one costs a subscriber a
// few seconds until its next poll. Domain facts go through publishEvent(tx, …)
// and the outbox, where they survive a crash. See ephemeral.ts for the split.

import { logger } from '../../utils/logger.js'
import { isEventType, type EventEnvelope, type EventType } from '@nexus/events'
import { isSelfPublished, publishEphemeralDynamic } from './ephemeral.js'
import { subscribeBroadcastEvents } from './subscribe.js'
import { getBroker } from './index.js'

/** Every bus event is a tagged union member carrying its own emit time. */
export interface BusEvent {
  type: string
  ts: number
}

export interface ReplayOptions {
  /** Maximum buffered events. */
  max: number
  /** Drop anything older than this. */
  ttlMs: number
}

export interface CrossReplicaBusOptions<T extends BusEvent> {
  /** Used in logs and as the broadcast listener's label. */
  name: string
  /**
   * The catalogue types this bus carries. A remote event outside this set
   * belongs to another bus and must NOT be delivered here — otherwise an SSE
   * client subscribed to listings would start receiving purchase orders.
   */
  types: readonly EventType[]
  replay?: ReplayOptions
  /**
   * Extra side effect on LOCAL publish only — e.g. po-events persisting to
   * PoEventLog. Never blocks listeners, never runs for a remote event (the
   * replica that published it already did it once).
   */
  onPublish?: (event: T) => void
}

export interface CrossReplicaBus<T extends BusEvent> {
  publish(event: T): void
  subscribe(listener: (event: T) => void): () => void
  listenerCount(): number
  /** Events buffered since a timestamp. Empty when no replay is configured. */
  replaySince(sinceMs: number): T[]
  bufferDepth(): number
  /** Attach to other replicas' events. Idempotent; call once at boot. */
  startIntake(): Promise<void>
  stopIntake(): Promise<void>
}

export function createCrossReplicaBus<T extends BusEvent>(
  options: CrossReplicaBusOptions<T>,
): CrossReplicaBus<T> {
  const listeners = new Set<(event: T) => void>()
  const buffer: T[] = []
  let stopRemote: (() => Promise<void>) | null = null

  function trim(): void {
    if (!options.replay) return
    const cutoff = Date.now() - options.replay.ttlMs
    while (buffer.length > 0 && buffer[0]!.ts < cutoff) buffer.shift()
    while (buffer.length > options.replay.max) buffer.shift()
  }

  /** Deliver to this process's listeners. A misbehaving one must not break the bus. */
  function deliverLocally(event: T): void {
    if (options.replay && event.type !== 'ping') {
      buffer.push(event)
      trim()
    }
    for (const listener of listeners) {
      try {
        listener(event)
      } catch {
        // Swallowed on purpose: one bad subscriber cannot silence the rest.
      }
    }
  }

  function toEnvelopePayload(event: T): { type: string; payload: Record<string, unknown>; ts: number } | null {
    const { type, ts, ...payload } = event as T & Record<string, unknown>
    // `ping` is an SSE keepalive, not a domain fact. It stays local — putting a
    // per-connection heartbeat on a shared bus multiplies it by every replica.
    if (type === 'ping' || !isEventType(type)) return null
    return { type, payload: payload as Record<string, unknown>, ts }
  }

  function fromEnvelope(envelope: EventEnvelope): T {
    // No type check here: subscribeBroadcastEvents already filters on the same
    // `types` list before this runs. A second copy of that filter was in place
    // and NEITHER was individually exercised — removing either one left the
    // test green, so a regression in one would have gone unnoticed behind the
    // other. One filter, in the helper, where every consumer benefits.
    return {
      type: envelope.type,
      ...(envelope.payload as Record<string, unknown>),
      ts: Date.parse(envelope.occurredAt),
    } as unknown as T
  }

  return {
    publish(event: T): void {
      // Local first and synchronously — a subscriber in this process must not
      // wait on a network round trip to learn about a mutation it just made.
      deliverLocally(event)

      if (options.onPublish && event.type !== 'ping') {
        try {
          options.onPublish(event)
        } catch (error) {
          logger.warn(`${options.name} bus: onPublish hook failed`, {
            type: event.type,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }

      const mapped = toEnvelopePayload(event)
      if (!mapped) return
      publishEphemeralDynamic(mapped.type as EventType, mapped.payload, { occurredAt: new Date(mapped.ts) })
    },

    subscribe(listener: (event: T) => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    listenerCount: () => listeners.size,

    replaySince(sinceMs: number): T[] {
      if (!options.replay) return []
      trim()
      return buffer.filter((event) => event.ts > sinceMs)
    },

    bufferDepth: () => buffer.length,

    async startIntake(): Promise<void> {
      if (stopRemote) return
      try {
        stopRemote = await subscribeBroadcastEvents(getBroker(), {
          // BROADCAST, not a consumer group. Every replica needs its OWN copy
          // because each holds different SSE connections; a shared group would
          // split the stream and each browser would see a random half of the
          // mutations. A group PER replica would fix that and leak a group into
          // Redis on every restart.
          name: options.name,
          types: options.types,
          handler: (envelope) => {
            // Our own publish already reached the local listeners synchronously.
            if (isSelfPublished(envelope)) return
            // Remote events do NOT re-run onPublish: the publishing replica
            // already did it, and repeating it would duplicate the side effect
            // once per instance.
            deliverLocally(fromEnvelope(envelope))
          },
        })
      } catch (error) {
        logger.warn(`${options.name} bus: remote intake unavailable, staying single-process`, {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },

    async stopIntake(): Promise<void> {
      await stopRemote?.()
      stopRemote = null
    },
  }
}
