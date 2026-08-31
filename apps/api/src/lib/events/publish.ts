// EV.1 — transactional publish.
//
// The one rule: an event is written in the SAME transaction as the state
// change it describes. Pass the transaction client, not the global prisma:
//
//   await prisma.$transaction(async (tx) => {
//     await tx.product.update(...)
//     await publishEvent(tx, 'product.updated', { productId })
//   })
//
// Publishing outside the transaction — or after it — reintroduces exactly the
// window this exists to close: the update commits, the process dies, and the
// event never happens with nothing anywhere recording that it should have.
//
// This function does NOT touch the broker. It writes one row. The relay moves
// it. That is what makes the publish as durable as the write beside it, and
// what stops a slow or unreachable broker from failing an operator's save.

import { randomUUID } from 'node:crypto'
import {
  deriveSubject,
  getEventDefinition,
  parseEventPayload,
  type EventEnvelope,
  type EventPayload,
  type EventType,
} from '@nexus/events'
import { correlationForPublish } from './correlation.js'
import { notifyPublished } from './relay.js'

/**
 * Structural type so this accepts PrismaClient or a TransactionClient without
 * fighting Prisma's generics — the precedent set by services/outbound-enqueue.ts.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
export interface OutboxWriter {
  eventOutbox: { create: Function; createMany: Function }
}

export interface PublishOptions {
  /** Tenant scope. Null/omitted = platform-wide. */
  accountId?: string | null
  /** Overrides the ambient correlation. Rarely needed. */
  correlationId?: string
  causationId?: string | null
  /** Which service emitted this. Defaults to EVENT_SOURCE, else 'api'. */
  source?: string
  /** Domain time. Defaults to now. Set it when recording a fact that happened earlier. */
  occurredAt?: Date
}

function defaultSource(): string {
  return process.env.EVENT_SOURCE?.trim() || 'api'
}

export function buildEnvelope<T extends EventType>(
  type: T,
  payload: EventPayload<T>,
  options: PublishOptions = {},
): EventEnvelope<EventPayload<T>> {
  // Validate FIRST. A bad payload must fail here, at the boundary, where the
  // stack trace still points at the publisher — not three services downstream
  // in a consumer that cannot do anything about it.
  const validated = parseEventPayload(type, payload)
  const definition = getEventDefinition(type)
  const ambient = correlationForPublish()

  return {
    id: randomUUID(),
    type,
    version: definition.version,
    occurredAt: (options.occurredAt ?? new Date()).toISOString(),
    accountId: options.accountId ?? null,
    subject: deriveSubject(type, validated),
    correlationId: options.correlationId ?? ambient.correlationId,
    causationId: options.causationId ?? ambient.causationId,
    source: options.source ?? defaultSource(),
    payload: validated,
  }
}

function toRow(envelope: EventEnvelope): Record<string, unknown> {
  return {
    eventId: envelope.id,
    type: envelope.type,
    version: envelope.version,
    context: getEventDefinition(envelope.type).context,
    accountId: envelope.accountId,
    subject: envelope.subject,
    correlationId: envelope.correlationId,
    causationId: envelope.causationId,
    source: envelope.source,
    payload: envelope.payload as object,
    occurredAt: new Date(envelope.occurredAt),
  }
}

/** Record one event in the caller's transaction. Returns the envelope it wrote. */
export async function publishEvent<T extends EventType>(
  db: OutboxWriter,
  type: T,
  payload: EventPayload<T>,
  options: PublishOptions = {},
): Promise<EventEnvelope<EventPayload<T>>> {
  const envelope = buildEnvelope(type, payload, options)
  await db.eventOutbox.create({ data: toRow(envelope) })
  // Tell the relay to serve the next few ticks fast. It is still inside the
  // caller's transaction here, so the row is not visible to the relay yet —
  // that is exactly why notifyPublished grants SEVERAL fast ticks rather than
  // triggering one immediate drain.
  notifyPublished()
  return envelope
}

/**
 * Record several events in one round trip. Order is preserved per subject
 * because the relay drains by occurredAt, and these share a transaction.
 */
export async function publishEvents(
  db: OutboxWriter,
  events: Array<{ type: EventType; payload: unknown; options?: PublishOptions }>,
): Promise<EventEnvelope[]> {
  if (events.length === 0) return []
  const envelopes = events.map((e) =>
    buildEnvelope(e.type, e.payload as EventPayload<EventType>, e.options),
  ) as EventEnvelope[]
  await db.eventOutbox.createMany({ data: envelopes.map(toRow) })
  notifyPublished()
  return envelopes
}
