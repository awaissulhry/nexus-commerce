// EV.1 — the broker seam.
//
// Everything above this interface is broker-agnostic. The Redis Streams driver
// is the first implementation; a Kafka or EventBridge driver is a new file
// here and nothing else changes. That is deliberate — the decision to start on
// Redis Streams was made on today's scale, and the cost of being wrong about
// it should be one file, not a migration.
//
// Delivery contract every driver must honour:
//   - at-least-once. A consumer WILL occasionally see the same event twice
//     (a crash between handling and ack). Consumers must be idempotent on
//     `envelope.id`; there is no exactly-once to be had here and pretending
//     otherwise is how duplicates become silent corruption.
//   - ordered per `subject`. Two events about the same product arrive in the
//     order they were published. Nothing is promised across subjects — that is
//     what makes parallelism possible at all.

import type { EventEnvelope } from '@nexus/events'

export interface BrokerMessage {
  /** Driver-scoped id used to acknowledge this delivery. Opaque above the driver. */
  readonly ackId: string
  /** Which partition it arrived on — carried for logging and lag attribution. */
  readonly shard: number
  readonly envelope: EventEnvelope
}

export interface SubscribeOptions {
  /**
   * Durable consumer group. Every group receives every event independently, so
   * a new consumer is added by picking a new group name — never by sharing an
   * existing one, which would split the stream between them instead.
   */
  group: string
  /** Identifies this replica within the group. Must be unique per process. */
  consumer: string
  handler: (message: BrokerMessage) => Promise<void>
  /** Called on a handler throw. The message is NOT acked, so it will be redelivered. */
  onError?: (error: unknown, message: BrokerMessage) => void
}

export interface BroadcastOptions {
  handler: (message: BrokerMessage) => Promise<void> | void
  onError?: (error: unknown, message: BrokerMessage) => void
}

export interface EventBroker {
  readonly name: string
  /** Publish a batch. Resolves once the broker has durably accepted them. */
  publish(envelopes: EventEnvelope[]): Promise<void>
  /**
   * Start a DURABLE consumer. Work is divided among the group's members, and
   * an unacked message is redelivered. Use for facts that must be handled.
   */
  subscribe(options: SubscribeOptions): Promise<() => Promise<void>>
  /**
   * Start a BROADCAST listener: every subscriber sees every event from the
   * moment it attaches, with no group, no acks and no pending list.
   *
   * This is the right primitive for a fan-out where each replica needs its own
   * copy (SSE, cache invalidation). The alternative — one consumer group per
   * process — would create a new group on every boot and leave it behind on
   * every ungraceful kill, which is an unbounded leak in Redis dressed up as a
   * subscription. Broadcast has no such state to leak.
   *
   * Missed while detached is missed for good: that is the trade a refresh hint
   * makes, and why facts do not use this.
   */
  subscribeBroadcast(options: BroadcastOptions): Promise<() => Promise<void>>
  close(): Promise<void>
}

// ── partitioning ────────────────────────────────────────────────────────────

/**
 * Shard count. 1 by default, which makes the topology exactly single-stream
 * total ordering — the simplest thing that is correct. Raising it trades
 * cross-subject ordering (which nothing depends on) for parallelism, and
 * per-subject ordering is preserved at any value because a subject always
 * hashes to the same shard.
 *
 * Changing this in production reshards: in-flight events for a subject may
 * briefly be split across two streams. Drain before changing it.
 */
export function shardCount(): number {
  const raw = Number(process.env.EVENT_STREAM_SHARDS ?? '1')
  return Number.isInteger(raw) && raw > 0 && raw <= 64 ? raw : 1
}

/** FNV-1a. Small, stable, and — unlike a JS string hash of convenience — not
 *  dependent on engine internals, so a resharding decision is reproducible. */
export function shardFor(subject: string, shards: number = shardCount()): number {
  if (shards <= 1) return 0
  let h = 0x811c9dc5
  for (let i = 0; i < subject.length; i++) {
    h ^= subject.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h % shards
}

export function streamKey(shard: number): string {
  return `nexus.events.v1.${shard}`
}

export function allStreamKeys(shards: number = shardCount()): string[] {
  return Array.from({ length: shards }, (_, i) => streamKey(i))
}

// ── no-op driver ────────────────────────────────────────────────────────────

/**
 * Used when Redis is not configured. It DROPS events rather than throwing:
 * the outbox row is already committed, so the fact is not lost — it stays
 * pending and the relay publishes it once a broker exists. Throwing here would
 * fail the caller's request for something the caller cannot fix.
 */
export class NoopBroker implements EventBroker {
  readonly name = 'noop'
  async publish(): Promise<void> {}
  async subscribe(): Promise<() => Promise<void>> {
    return async () => {}
  }
  async subscribeBroadcast(): Promise<() => Promise<void>> {
    return async () => {}
  }
  async close(): Promise<void> {}
}

// ── in-memory driver (tests) ────────────────────────────────────────────────

/**
 * Delivers to every registered group, in publish order per subject. Exists so
 * the relay and the subscriber helper can be tested without a Redis, and so a
 * test asserting ordering is asserting the CONTRACT rather than the driver.
 */
export class InMemoryBroker implements EventBroker {
  readonly name = 'in-memory'
  readonly published: EventEnvelope[] = []
  private groups = new Map<string, SubscribeOptions>()
  private broadcasts = new Set<BroadcastOptions>()
  private seq = 0

  async publish(envelopes: EventEnvelope[]): Promise<void> {
    for (const envelope of envelopes) {
      this.published.push(envelope)
      const deliver = async (options: SubscribeOptions | BroadcastOptions) => {
        const message: BrokerMessage = {
          ackId: `mem-${++this.seq}`,
          shard: shardFor(envelope.subject),
          envelope,
        }
        try {
          await options.handler(message)
        } catch (error) {
          options.onError?.(error, message)
        }
      }
      for (const options of this.groups.values()) await deliver(options)
      for (const options of this.broadcasts) await deliver(options)
    }
  }

  async subscribe(options: SubscribeOptions): Promise<() => Promise<void>> {
    this.groups.set(options.group, options)
    return async () => {
      this.groups.delete(options.group)
    }
  }

  async subscribeBroadcast(options: BroadcastOptions): Promise<() => Promise<void>> {
    this.broadcasts.add(options)
    return async () => {
      this.broadcasts.delete(options)
    }
  }

  async close(): Promise<void> {
    this.groups.clear()
    this.broadcasts.clear()
  }
}
