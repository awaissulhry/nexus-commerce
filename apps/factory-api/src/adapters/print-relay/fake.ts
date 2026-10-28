import type { FactoryEnv } from '../../env'
import { RelayError, type PrintRelayAdapter, type RelayJob } from './port'

/**
 * The FAKE print relay (local and test runs only): it records every job it is given and sends nothing anywhere — no
 * socket, no file, no printer. It keeps the port's promise of idempotency (a job submitted again answers the same relay
 * id and is recorded once), and a test can make the next submissions fail, to see the retries, or report a job as
 * printed, the way a real relay will. Refused with FACTORY_ENV staging or production, where a printer needs a real
 * relay (the Owner's choice, A1 §9 question 5).
 */

export interface RecordedPrintJob {
  readonly relayJobId: string
  readonly job: RelayJob
}

export interface FakePrintRelay extends PrintRelayAdapter {
  /** Every job taken, once each, in order. */
  readonly jobs: readonly RecordedPrintJob[]
  /** Every submit call, the refused and repeated ones included. */
  readonly attempts: readonly string[]
  /** The next `count` submissions fail with this message (retryable unless said otherwise). */
  failNext(count: number, options?: { readonly message?: string; readonly retryable?: boolean }): void
}

export function fakePrintRelay(options: { readonly environment: FactoryEnv['FACTORY_ENV'] }): FakePrintRelay {
  if (options.environment !== 'local' && options.environment !== 'test') {
    throw new Error(`The fake print relay is for local and test runs only; with FACTORY_ENV=${options.environment} a printer needs a real relay.`)
  }
  const jobs: RecordedPrintJob[] = []
  const attempts: string[] = []
  const failures: { message: string; retryable: boolean }[] = []
  return {
    kind: 'FAKE',
    jobs,
    attempts,
    failNext(count, failure = {}) {
      for (let index = 0; index < count; index++) failures.push({ message: failure.message ?? 'The fake relay did not answer.', retryable: failure.retryable ?? true })
    },
    async submit(job) {
      attempts.push(job.jobId)
      const failure = failures.shift()
      if (failure) throw new RelayError(failure.message, failure.retryable)
      const known = jobs.find((entry) => entry.job.jobId === job.jobId)
      if (known) return { relayJobId: known.relayJobId }
      const relayJobId = `fake-${jobs.length + 1}`
      jobs.push({ relayJobId, job })
      return { relayJobId }
    },
  }
}
