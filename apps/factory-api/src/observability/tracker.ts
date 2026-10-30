import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { errorReportOf, type ErrorReport, type ReportContext, type ReportSource } from '@nexus/factory-domain/observability/report'
import { serverClock, type Clock } from '../core/time'
import { FactoryEnvError, readFactoryVariables } from '../env'
import { memorySink } from './fake'

/**
 * Error tracking with redaction (PLT-218; B-W2a-42): the port the API's unexpected errors go through, and its
 * runtime. Every report is made by factory-domain `observability/report` (allow-listed context, scrubbed text: no
 * person, no secret, no money) BEFORE a sink sees it; a sink only stores or forwards what it is given.
 *
 *   reported   an HTTP answer 500 (core/errors.ts), a worker job that failed its last attempt (platform/outbox/
 *              dispatch.ts), a cron tick that failed (core/cron.ts). Domain refusals (4xx) and retried jobs are not.
 *   sinks      `fake` (local and test): the last 200 reports in this process's memory (memorySink) — what a test or a
 *              live check reads; `off`: nothing is kept. A LIVE sink (an EU error-tracking service, or one we host)
 *              needs the Owner's spend yes and a processor agreement (GDPR art. 28, GATE-SPEND + GATE-PRIVACY):
 *              no vendor is chosen and no vendor SDK is installed; staging and production accept only `off` until then.
 *
 * Configuration (apps/factory-api/.env or the process): FACTORY_ERROR_TRACKING = off | fake (default: fake with
 * FACTORY_ENV local or test, off otherwise). Capturing never throws and never slows the answer: a failing sink is
 * ignored.
 */

/** Where reports go. `send` may be async; its failure is swallowed (a report never breaks what it reports). */
export interface ErrorSink {
  readonly kind: 'fake' | 'off'
  send(report: ErrorReport): void | Promise<void>
}

export interface ErrorTracker {
  readonly sink: ErrorSink
  /** Makes the redacted report and hands it to the sink; returns it (null when tracking is off). */
  capture(error: unknown, context?: ReportContext): ErrorReport | null
}

export interface ErrorTrackerOptions {
  readonly sink: ErrorSink
  readonly source: ReportSource
  readonly clock?: Clock
  readonly release?: string | null
  readonly environment?: string
}

export const offSink: ErrorSink = Object.freeze({ kind: 'off' as const, send: () => undefined })

export function createErrorTracker(options: ErrorTrackerOptions): ErrorTracker {
  const clock = options.clock ?? serverClock
  return {
    sink: options.sink,
    capture(error, context = {}) {
      if (options.sink.kind === 'off') return null
      const report = errorReportOf(error, {
        id: newId(),
        at: toUtcIso(clock.now()),
        source: options.source,
        context: { ...(options.release ? { release: options.release } : {}), ...(options.environment ? { environment: options.environment } : {}), ...context },
      })
      try {
        const sent = options.sink.send(report)
        if (sent && typeof (sent as Promise<void>).catch === 'function') void (sent as Promise<void>).catch(() => undefined)
      } catch {
        // A sink that fails loses this report; what it reports goes on.
      }
      return report
    },
  }
}

export const ERROR_TRACKING_MODES = ['off', 'fake'] as const
export type ErrorTrackingMode = (typeof ERROR_TRACKING_MODES)[number]

/** The mode from the variables: default fake in local and test, off elsewhere; fake is refused in staging and production. */
export function errorTrackingMode(environment: string, value: string | undefined): ErrorTrackingMode {
  const local = environment === 'local' || environment === 'test'
  if (value === undefined || value === '') return local ? 'fake' : 'off'
  if (!(ERROR_TRACKING_MODES as readonly string[]).includes(value)) throw new FactoryEnvError(`FACTORY_ERROR_TRACKING must be off or fake, not ${value}`)
  if (value === 'fake' && !local) {
    throw new FactoryEnvError(`FACTORY_ERROR_TRACKING=fake is for local and test runs; with FACTORY_ENV=${environment} it is off until a live error-tracking service is agreed (GATE-SPEND, GDPR art. 28)`)
  }
  return value as ErrorTrackingMode
}

let configured: ErrorTracker | undefined
let fromEnv: ErrorTracker | undefined
let processSource: ReportSource = 'api'

/** Tests and the background entry point set their own (useErrorTracker(undefined) goes back to the process's). */
export function useErrorTracker(tracker: ErrorTracker | undefined): void {
  configured = tracker
}

/** The source of this process's reports: `api`, or `worker` / `scheduler` (background.ts says which before anything runs). */
export function setReportSource(source: ReportSource): void {
  processSource = source
  fromEnv = undefined
}

/** The process's tracker, made on first use from the env. A broken configuration turns tracking off (the boot does not fail on it). */
export function processErrorTracker(): ErrorTracker {
  if (configured) return configured
  if (!fromEnv) {
    let sink: ErrorSink = offSink
    let environment = ''
    try {
      const variables = readFactoryVariables()
      environment = variables.FACTORY_ENV ?? ''
      sink = errorTrackingMode(environment, variables.FACTORY_ERROR_TRACKING) === 'fake' ? memorySink() : offSink
    } catch {
      sink = offSink
    }
    fromEnv = createErrorTracker({ sink, source: processSource, environment })
  }
  return fromEnv
}

/** Reports an unexpected error through the process's tracker. Never throws. */
export function reportError(error: unknown, context?: ReportContext): ErrorReport | null {
  try {
    return processErrorTracker().capture(error, context)
  } catch {
    return null
  }
}
