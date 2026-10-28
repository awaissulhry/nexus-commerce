import type { EventHandler } from '../outbox/dispatch'
import { defineHandler } from '../outbox/dispatch'
import { processFiles } from '../files/service'
import type { FilesRuntime } from '../files/service'
import { dispatchJob } from './jobs'
import { MAX_PRINT_ATTEMPTS } from './rules'
import { processPrintRelays, type PrintRelays } from './service'

/**
 * The worker's print.dispatch handler (plan A1 §3.3, §3.9): on `print.job_queued` it hands the job to its printer's
 * relay (jobs.ts dispatchJob), as the event's tenant's system caller. A retryable refusal throws, so the queue tries
 * again with exponential backoff; the job counts its tries and is FAILED at the last one (MAX_PRINT_ATTEMPTS, also the
 * handler's attempts), so a refused job never reaches the dead-letter queue. A repeated event finds the job no longer
 * QUEUED and does nothing; the relay itself dedupes by job id.
 *
 * Listed in background.ts HANDLERS for the worker: printDispatchHandler().
 */
export function printDispatchHandler(options: { readonly relays?: () => PrintRelays; readonly files?: () => FilesRuntime } = {}): EventHandler {
  return defineHandler({
    name: 'print.dispatch',
    events: ['print.job_queued'],
    attempts: MAX_PRINT_ATTEMPTS,
    async handle(event, { caller }) {
      const { jobId } = event.payload as { jobId: string }
      await dispatchJob({ relays: (options.relays ?? processPrintRelays)(), files: options.files ?? processFiles, causationId: event.eventId }, caller, jobId)
    },
  })
}
