import type { Prisma } from '@nexus/factory-db'
import { EVENT_CATALOGUE, EventPayloadError, UndeclaredEventError, type EventCatalogue } from '@nexus/factory-domain/events/catalogue'
import type { EventWriter, PendingEvent } from '../../core/command'
import { ApiError } from '../../core/errors'

/**
 * The outbox writer (plan A1 §3.2 step 4, §3.4; feature PLT-191): command()'s EventWriter. Inside the command's
 * transaction, after its audit rows and before its receipt, it checks every emitted event against the catalogue and
 * writes one OutboxEvent row each. A type or version the catalogue does not declare, or a payload its strict schema
 * refuses, throws: the whole command rolls back (Commerce hard rule 8, for the factory). An event either commits with
 * its change or does not exist.
 *
 * The row's scope is the writer's: a floor write carries the device's site and a partner or link write the session's
 * party, which the policies check (WITH CHECK); an event naming another site fails there and rolls back too.
 */
export function outboxWriter(catalogue: EventCatalogue = EVENT_CATALOGUE): EventWriter {
  return async (tx, events) => {
    if (events.length === 0) return
    const rows = events.map((event) => outboxRow(catalogue, event))
    await tx.outboxEvent.createMany({ data: rows })
  }
}

function outboxRow(catalogue: EventCatalogue, event: PendingEvent): Prisma.OutboxEventCreateManyInput {
  let payload: unknown
  let context: string
  try {
    context = catalogue.get(event.type, event.version).context
    payload = catalogue.parse(event.type, event.version, event.payload)
  } catch (error) {
    if (error instanceof UndeclaredEventError || error instanceof EventPayloadError) throw new ApiError('internal_error', error.message)
    throw error
  }
  return {
    id: event.eventId,
    companyId: event.companyId,
    siteId: event.siteId,
    partyId: event.partyId,
    type: event.type,
    version: event.version,
    context,
    subject: event.subject,
    correlationId: event.correlationId,
    causationId: event.causationId,
    source: event.source,
    occurredAt: event.occurredAt,
    payload: JSON.parse(JSON.stringify(payload)) as Prisma.InputJsonValue,
  }
}
