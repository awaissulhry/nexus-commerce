// EV.1 — the consumer helper.
//
// Wraps a raw broker subscription with the two things every consumer needs and
// would otherwise each reimplement slightly differently:
//
//   - type filtering, so a consumer states what it cares about rather than
//     switching on `type` inside its own handler;
//   - correlation propagation. A handler runs inside the incoming event's
//     correlation, with that event as its causationId — so anything it
//     publishes is automatically linked to what caused it. Without this the
//     causal chain breaks at the first hop and the fields are decorative.
//
// Idempotency is deliberately NOT handled here. Delivery is at-least-once, so
// every consumer must be safe to run twice on the same `envelope.id` — but
// what "safe" means is domain-specific (an SSE fan-out is naturally idempotent;
// a stock decrement is emphatically not). A generic dedupe cache here would
// look like a guarantee while silently failing across replicas and restarts.

import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import { logger } from '../../utils/logger.js'
import { isEventType, type EventEnvelope, type EventType } from '@nexus/events'
import type { BrokerMessage, EventBroker } from './broker.js'
import { withCorrelation } from './correlation.js'

export interface EventSubscription {
  /**
   * Durable consumer group. Each group sees every event independently — a new
   * consumer means a NEW group name. Reusing another consumer's group splits
   * the stream between them, which looks like random event loss.
   */
  group: string
  /** Event types to receive. Omit for all of them. */
  types?: readonly EventType[]
  handler: (envelope: EventEnvelope, context: { shard: number }) => Promise<void> | void
  onError?: (error: unknown, envelope: EventEnvelope) => void
}

/** Unique per process — two replicas must not share a consumer name. */
function consumerName(group: string): string {
  return `${group}@${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`
}

export async function subscribeEvents(
  broker: EventBroker,
  subscription: EventSubscription,
): Promise<() => Promise<void>> {
  const wanted = subscription.types ? new Set<string>(subscription.types) : null

  // A typo in a subscriber's type list is silent — it just never fires. Catch
  // it at registration, where it is obvious, rather than in production as an
  // absence nobody notices.
  for (const type of subscription.types ?? []) {
    if (!isEventType(type)) {
      throw new Error(
        `Subscription "${subscription.group}" asked for unknown event type "${type}". ` +
          `It is not in packages/events/catalog.ts, so it would never fire.`,
      )
    }
  }

  const stop = await broker.subscribe({
    group: subscription.group,
    consumer: consumerName(subscription.group),
    handler: async (message: BrokerMessage) => {
      const { envelope } = message
      if (wanted && !wanted.has(envelope.type)) return
      await withCorrelation({ correlationId: envelope.correlationId, causationId: envelope.id }, async () =>
        subscription.handler(envelope, { shard: message.shard }),
      )
    },
    onError: (error, message) => {
      subscription.onError?.(error, message.envelope)
    },
  })

  logger.info('event subscriber: registered', {
    group: subscription.group,
    broker: broker.name,
    types: subscription.types ? subscription.types.length : 'all',
  })
  return stop
}

export interface BroadcastSubscription {
  /** A label for logs only — broadcast has no group. */
  name: string
  types?: readonly EventType[]
  handler: (envelope: EventEnvelope, context: { shard: number }) => Promise<void> | void
  onError?: (error: unknown, envelope: EventEnvelope) => void
}

/**
 * Attach a broadcast listener: this process sees every event published from
 * now on, independently of every other replica. No group, no acks, no state
 * left in the broker.
 *
 * Use for per-replica fan-out (SSE, cache invalidation). Use `subscribeEvents`
 * when the work must actually happen — a broadcast listener that is detached
 * when an event passes never learns about it.
 */
export async function subscribeBroadcastEvents(
  broker: EventBroker,
  subscription: BroadcastSubscription,
): Promise<() => Promise<void>> {
  const wanted = subscription.types ? new Set<string>(subscription.types) : null

  for (const type of subscription.types ?? []) {
    if (!isEventType(type)) {
      throw new Error(
        `Broadcast listener "${subscription.name}" asked for unknown event type "${type}". ` +
          `It is not in packages/events/catalog.ts, so it would never fire.`,
      )
    }
  }

  const stop = await broker.subscribeBroadcast({
    handler: async (message: BrokerMessage) => {
      const { envelope } = message
      if (wanted && !wanted.has(envelope.type)) return
      await withCorrelation({ correlationId: envelope.correlationId, causationId: envelope.id }, async () =>
        subscription.handler(envelope, { shard: message.shard }),
      )
    },
    onError: (error, message) => subscription.onError?.(error, message.envelope),
  })

  logger.info('event broadcast listener: attached', {
    name: subscription.name,
    broker: broker.name,
    types: subscription.types ? subscription.types.length : 'all',
  })
  return stop
}
