import { z } from 'zod'
import { isUuid } from '../core/ids'
import { parseInstant } from '../core/time'

/**
 * The event envelope (plan A1 §3.4): how a committed outbox row travels. The worker's relay publishes it as the data of
 * a BullMQ job whose id is the event id, and every handler receives it. Consumers are idempotent by `eventId` (a lease
 * is not exactly-once: an event may be handed over twice, never lost).
 */

const uuid = () => z.string().refine(isUuid, { message: 'Expected a UUID.' })
const instant = () => z.string().refine((value) => parseInstant(value) !== null, { message: 'Expected an ISO 8601 time with a zone.' })

export const eventEnvelope = z.strictObject({
  /** UUIDv7, the outbox row's id: the idempotency key of every consumer. */
  eventId: uuid(),
  type: z.string().min(1),
  version: z.number().int().min(1),
  /** The module that owns the event. */
  context: z.string().min(1),
  tenantId: uuid(),
  companyId: uuid().nullable(),
  siteId: uuid().nullable(),
  /** The aggregate (usually the record id): the partition key. */
  subject: z.string().min(1),
  /** The request (or job) that wrote it. */
  correlationId: z.string().min(1),
  /** The event a job handled when it wrote this one. */
  causationId: z.string().min(1).nullable(),
  /** The command that emitted it. */
  source: z.string().min(1),
  /** UTC with milliseconds (toUtcIso). */
  occurredAt: instant(),
  /** Checked against the catalogue's strict schema when it was written. */
  payload: z.unknown(),
})
export type EventEnvelope = z.infer<typeof eventEnvelope>

/**
 * A "record changed" message for live screens (A1 §3.5), published by the worker on Redis pub/sub per tenant. It carries
 * the envelope's scope and the definition's live fields only, never the whole payload. The API decides per viewer
 * what to send (`liveViewFor`): it never trusts this message for that decision.
 */
export const liveMessage = z.strictObject({
  tenantId: uuid(),
  eventId: uuid(),
  type: z.string().min(1),
  version: z.number().int().min(1),
  subject: z.string().min(1),
  companyId: uuid().nullable(),
  siteId: uuid().nullable(),
  occurredAt: instant(),
  fields: z.record(z.string(), z.unknown()),
})
export type LiveMessage = z.infer<typeof liveMessage>

/** What one viewer's screen receives: the live message without the tenant (it is the viewer's own). */
export type LiveView = Omit<LiveMessage, 'tenantId'>
