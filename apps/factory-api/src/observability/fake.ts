import type { ErrorReport } from '@nexus/factory-domain/observability/report'
import type { ErrorSink } from './tracker'

/**
 * The FAKE error-tracking sink (PLT-218; local and test only): the last `limit` reports in this process's memory, oldest
 * dropped first. Nothing leaves the process. A live sink (an EU service) replaces it after the Owner's spend yes and the
 * processor agreement (GDPR art. 28); its adapter will live in `src/adapters/<service>/` and receive the same, already
 * redacted, reports.
 */

export interface MemorySink extends ErrorSink {
  readonly kind: 'fake'
  /** The kept reports, oldest first. */
  reports(): readonly ErrorReport[]
  clear(): void
}

export function memorySink(limit = 200): MemorySink {
  const kept: ErrorReport[] = []
  return {
    kind: 'fake',
    send(report) {
      kept.push(report)
      if (kept.length > limit) kept.splice(0, kept.length - limit)
    },
    reports: () => [...kept],
    clear() {
      kept.length = 0
    },
  }
}
