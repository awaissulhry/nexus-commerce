import { errorReportOf, type ErrorReport, type ReportContext, type ReportSource } from '@nexus/factory-domain/observability/report'

/**
 * Error tracking with redaction in the browser (PLT-218; B-W2a-42): an uncaught error or an unhandled rejection on any
 * page (office, floor, links) becomes ONE redacted report — factory-domain `observability/report`: the error's name,
 * code, scrubbed message and frames, and only the page path with its ids replaced and the source; never the URL's query,
 * a person, a secret or money — before any sink sees it.
 *
 *   sinks   `fake` (every build but production): the last 50 reports in the page's memory, readable by a test or a
 *           live check (window.__nexusErrorReports, never in a production build); `off` (production): nothing is kept.
 *           A LIVE sink (an EU error-tracking service) needs the Owner's spend yes and a processor agreement (GDPR art.
 *           28): no vendor and no vendor SDK here.
 *   limits  one report per distinct error (name + message) a minute, at most 20 per page load: a loop never floods.
 */

export interface ClientSink {
  readonly kind: 'fake' | 'off'
  send(report: ErrorReport): void
}

export interface ClientTracker {
  readonly sink: ClientSink
  capture(error: unknown, context?: ReportContext): ErrorReport | null
}

export function memorySink(limit = 50): ClientSink & { reports(): readonly ErrorReport[] } {
  const kept: ErrorReport[] = []
  return {
    kind: 'fake',
    send(report) {
      kept.push(report)
      if (kept.length > limit) kept.splice(0, kept.length - limit)
    },
    reports: () => [...kept],
  }
}

export const offSink: ClientSink = Object.freeze({ kind: 'off' as const, send: () => undefined })

const REPEAT_MS = 60_000
const PER_PAGE = 20

export function createClientTracker(options: { source: ReportSource; sink: ClientSink; now?: () => Date; newId?: () => string }): ClientTracker {
  const now = options.now ?? (() => new Date())
  const newId = options.newId ?? (() => globalThis.crypto.randomUUID())
  const seen = new Map<string, number>()
  let sent = 0
  return {
    sink: options.sink,
    capture(error, context = {}) {
      if (options.sink.kind === 'off' || sent >= PER_PAGE) return null
      const at = now()
      const report = errorReportOf(error, { id: newId(), at: at.toISOString(), source: options.source, context })
      const key = `${report.name}:${report.message}`
      const last = seen.get(key)
      if (last !== undefined && at.getTime() - last < REPEAT_MS) return null
      seen.set(key, at.getTime())
      sent++
      try {
        options.sink.send(report)
      } catch {
        // A failing sink loses the report; the page goes on.
      }
      return report
    },
  }
}

/** Which source a page path is: the floor app or the rest of the web. */
export const sourceOf = (path: string): ReportSource => (path === '/floor' || path.startsWith('/floor/') ? 'floor' : 'web')

interface ErrorTarget {
  addEventListener(type: 'error' | 'unhandledrejection', listener: (event: Event) => void): void
  removeEventListener(type: 'error' | 'unhandledrejection', listener: (event: Event) => void): void
}

/** Listens for uncaught errors and unhandled rejections; returns the function that stops listening. */
export function installErrorReporting(target: ErrorTarget, tracker: ClientTracker, path: () => string, release?: string | null): () => void {
  const context = () => ({ path: path(), ...(release ? { release } : {}) })
  const onError = (event: Event) => {
    const { error, message } = event as ErrorEvent
    tracker.capture(error ?? message ?? 'An error without a value.', { ...context(), component: 'window.error' })
  }
  const onRejection = (event: Event) => {
    tracker.capture((event as PromiseRejectionEvent).reason, { ...context(), component: 'unhandledrejection' })
  }
  target.addEventListener('error', onError)
  target.addEventListener('unhandledrejection', onRejection)
  return () => {
    target.removeEventListener('error', onError)
    target.removeEventListener('unhandledrejection', onRejection)
  }
}
