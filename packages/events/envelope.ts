// EV.0 — the event envelope.
//
// Every event that crosses a process boundary is wrapped in this shape. The
// envelope is the ONLY part of the wire format that is stable across every
// bounded context; `payload` is validated per-type by the catalogue.
//
// Why each field exists (none of these is decoration):
//
//   id            The idempotency key. A consumer that has already handled
//                 this id must be able to skip it. The outbox writes this
//                 UNIQUE, so a relay retry can never double-publish.
//   type/version  The contract. `type` alone is not enough — a payload shape
//                 change ships as a new version alongside the old one so
//                 consumers migrate independently. That is the whole point of
//                 API-first: nobody is forced to redeploy in lockstep.
//   subject       The aggregate this event is ABOUT (productId, orderId, …).
//                 It doubles as the partition key: ordering is guaranteed per
//                 subject, which is exactly the guarantee stock arithmetic
//                 needs and nothing more. Derived by the catalogue's `subject`
//                 extractor, never hand-passed at a call site.
//   accountId     Tenant scope. Null means platform-wide. Consumers filter on
//                 this before anything else — a cross-tenant leak through the
//                 bus would be invisible at the HTTP layer.
//   correlationId Ties one causal chain together end to end (a webhook and
//                 every channel write it ultimately caused share one).
//   causationId   The id of the event that DIRECTLY caused this one. With
//                 correlationId it reconstructs the full tree, which is the
//                 only practical way to debug a fan-out after the fact.
//   source        Which service emitted it. Populated automatically.
//
// `occurredAt` is when the fact happened in the domain, NOT when it was
// published — the relay can lag, and a consumer that reasons about time must
// use the domain time or it will draw the wrong conclusion.

import { z } from 'zod'

/** Bump ONLY for a breaking change to the envelope itself, never for a payload. */
export const ENVELOPE_VERSION = 1

export const eventEnvelopeSchema = z.strictObject({
  id: z.uuid(),
  type: z.string().min(1),
  version: z.number().int().positive(),
  occurredAt: z.iso.datetime(),
  accountId: z.string().min(1).nullable(),
  subject: z.string().min(1),
  correlationId: z.string().min(1),
  causationId: z.uuid().nullable(),
  source: z.string().min(1),
  payload: z.unknown(),
})

type EnvelopeBase = z.infer<typeof eventEnvelopeSchema>

/** An envelope whose payload has been narrowed to a concrete type. */
export type EventEnvelope<P = unknown> = Omit<EnvelopeBase, 'payload'> & { payload: P }

/**
 * Parse an untrusted envelope (a Redis stream entry, an HTTP body, an outbox
 * row). Returns the envelope with payload still `unknown` — call
 * `parseEventPayload` from the catalogue to narrow it, because only the
 * catalogue knows the per-type schema.
 */
export function parseEventEnvelope(input: unknown): EventEnvelope {
  return eventEnvelopeSchema.parse(input) as EventEnvelope
}

export function safeParseEventEnvelope(
  input: unknown,
): { ok: true; envelope: EventEnvelope } | { ok: false; error: string } {
  const result = eventEnvelopeSchema.safeParse(input)
  if (!result.success) {
    return { ok: false, error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }
  }
  return { ok: true, envelope: result.data as EventEnvelope }
}

/**
 * The Redis stream entry is a flat string map, so the envelope is carried as
 * one JSON field. Kept here (not in the driver) so any future driver — Kafka,
 * EventBridge — serialises identically and a stream written by one is readable
 * by the next.
 */
export function serialiseEnvelope(envelope: EventEnvelope): string {
  return JSON.stringify(envelope)
}

export function deserialiseEnvelope(raw: string): EventEnvelope {
  return parseEventEnvelope(JSON.parse(raw))
}
