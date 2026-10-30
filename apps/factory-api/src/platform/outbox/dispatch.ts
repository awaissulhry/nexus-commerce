import type { Job, Worker } from 'bullmq'
import type { Redis } from 'ioredis'
import type { FactoryDatabase } from '@nexus/factory-db'
import { isPermission } from '@nexus/factory-domain/core/permissions'
import { EVENT_CATALOGUE, type EventCatalogue } from '@nexus/factory-domain/events/catalogue'
import { eventEnvelope, type EventEnvelope } from '@nexus/factory-domain/events/envelope'
import { liveMessageFor } from '@nexus/factory-domain/events/live'
import { callerFor, type CommandCaller } from '../../core/command'
import { JOB_DEFAULTS, type Log, type QueueKit } from '../../core/queue'
import { publishLive } from '../../core/sse'
import { reportError } from '../../observability/tracker'
import { systemContext } from './system'

/**
 * What happens to a published event (plan A1 §3.3, §3.4, §3.5), in the worker:
 *
 *   events queue (job id = event id)   the dispatcher: adds one job per handler that subscribed to its type, then
 *                                      publishes the event's live message (Redis pub/sub, for the SSE endpoint) when its
 *                                      definition has a live rule;
 *   event-handlers queue               one job per event and handler, job id `<handler>.<event id>`: retried with
 *                                      exponential backoff, and after its last attempt copied to the dead-letter queue
 *                                      (core/queue.ts). One failing handler never re-runs the others.
 *
 * A handler gets the envelope and a system caller for the event's tenant: its writes go through command() with
 * `causationId: event.eventId`, so they are audited and their own events chain to this one. Handlers are idempotent by
 * event id (a lease is not exactly-once, A1 §3.4).
 */

export interface HandlerTools {
  /** command() as the system context of the event's tenant (request id = the event's correlation id). */
  readonly caller: CommandCaller
  /** 1 on the first try. */
  readonly attempt: number
}

export interface EventHandler {
  /** `<module>.<handler>`, unique: the handler job's name and the first part of its id. */
  readonly name: string
  /** The event types it handles. */
  readonly events: readonly string[]
  /** Tries before the dead-letter queue. Default 5. */
  readonly attempts: number
  handle(event: EventEnvelope, tools: HandlerTools): Promise<void>
}

export class HandlerConfigError extends Error {
  override name = 'HandlerConfigError'
}

/** Declares a handler. A bad name, no event type or a bad attempt count throws at once. */
export function defineHandler(spec: Omit<EventHandler, 'attempts'> & { readonly attempts?: number }): EventHandler {
  if (!isPermission(spec?.name)) throw new HandlerConfigError(`Handler name ${JSON.stringify(spec?.name)} is not <module>.<handler>`)
  if (!Array.isArray(spec.events) || spec.events.length === 0) throw new HandlerConfigError(`Handler ${spec.name} handles no event type`)
  const attempts = spec.attempts ?? 5
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 25) throw new HandlerConfigError(`Handler ${spec.name}: attempts must be 1 to 25`)
  return Object.freeze({ name: spec.name, events: Object.freeze([...spec.events]), attempts, handle: spec.handle })
}

export interface DispatchSettings {
  readonly kit: QueueKit
  readonly handlers: readonly EventHandler[]
  readonly catalogue?: EventCatalogue
  /** Publishes live messages (a Redis connection); without it, events reach no screen. */
  readonly live?: Redis
  /** The first retry delay of a handler job (doubled each try). Default 1 s. */
  readonly handlerBackoffMs?: number
  readonly log?: Log
}

/** The handler job of one event: its data is the envelope. */
export const handlerJobId = (handler: EventHandler, event: EventEnvelope): string => `${handler.name}.${event.eventId}`

/**
 * The dispatcher's work for one event. Safe to repeat: the handler job ids dedupe. The handler jobs come first; the live
 * message is a hint (a screen refetches anyway), so a failed publish is logged, never retried into a second fan-out.
 */
export async function dispatchEvent(event: EventEnvelope, settings: DispatchSettings): Promise<void> {
  for (const handler of settings.handlers.filter((entry) => entry.events.includes(event.type))) {
    await settings.kit.add('event-handlers', handler.name, event, {
      jobId: handlerJobId(handler, event),
      attempts: handler.attempts,
      backoff: { type: 'exponential', delay: settings.handlerBackoffMs ?? 1_000 },
    })
  }
  const catalogue = settings.catalogue ?? EVENT_CATALOGUE
  const definition = catalogue.find(event.type, event.version)
  const message = definition ? liveMessageFor(event, definition) : null
  if (message && settings.live) {
    try {
      await publishLive(settings.live, settings.kit.prefix, message)
    } catch (error) {
      settings.log?.warn({ eventId: event.eventId, err: error }, 'live message not published')
    }
  }
}

/** Runs one handler job. */
export async function runHandler(job: Job<EventEnvelope>, handlers: readonly EventHandler[], database: FactoryDatabase): Promise<void> {
  const handler = handlers.find((entry) => entry.name === job.name)
  if (!handler) throw new HandlerConfigError(`No handler ${job.name} in this worker`)
  const event = eventEnvelope.parse(job.data)
  const caller = callerFor(database, systemContext(event.tenantId, event.correlationId))
  await handler.handle(event, { caller, attempt: job.attemptsMade + 1 })
}

export interface EventWorkers {
  close(): Promise<void>
}

/** The worker's consumers of the events and event-handlers queues. Two handlers with one name are refused. */
export function startEventWorkers(options: DispatchSettings & { readonly database: FactoryDatabase; readonly log: Log; readonly concurrency?: number }): EventWorkers {
  const names = new Set<string>()
  for (const handler of options.handlers) {
    if (names.has(handler.name)) throw new HandlerConfigError(`Handler ${handler.name} is registered twice`)
    names.add(handler.name)
  }
  const concurrency = options.concurrency ?? 4
  const workers: Worker[] = [
    options.kit.work<EventEnvelope>('events', (job) => dispatchEvent(eventEnvelope.parse(job.data), options), { concurrency }),
    options.kit.work<EventEnvelope>('event-handlers', (job) => runHandler(job, options.handlers, options.database), { concurrency }),
  ]
  for (const worker of workers) {
    worker.on('failed', (job, error) => {
      const attempts = job?.opts.attempts ?? JOB_DEFAULTS.attempts ?? 1
      const final = (job?.attemptsMade ?? 0) >= attempts
      options.log[final ? 'error' : 'warn'](
        { queue: worker.name, job: job?.name, jobId: job?.id, attemptsMade: job?.attemptsMade, err: error },
        final ? 'job failed its last attempt (copied to the dead-letter queue)' : 'job failed; it will be retried',
      )
      if (final) reportError(error, { queue: worker.name, job: job?.name ?? null, attempt: job?.attemptsMade ?? null, final: true }) // B-W2a-42 (PLT-218)
    })
    worker.on('error', (error) => options.log.error({ queue: worker.name, err: error }, 'queue worker error'))
  }
  return {
    async close() {
      await Promise.allSettled(workers.map((worker) => worker.close()))
    },
  }
}
