/**
 * L.14.0 — the manual cron trigger: "Run now" on the Sync Logs hub and in the Ads Control Room (POST
 * /api/sync-logs/cron/:jobName/trigger).
 *
 * Looks up the registry entry, wraps the call in recordCronRun(triggeredBy='manual') and fires it. The route answers
 * 202 Accepted at once (the run might take a while; the CronRun row reflects its status as it progresses) and 404 when
 * the jobName is unknown — the registry is the source of truth for what's triggerable from the hub.
 *
 * ADS AUTONOMY W4-8 — moved unchanged out of `routes/sync-logs.routes.ts` so Claude's run-ad-engine-now starts an engine
 * by the same path; the route answers byte for byte as before (cron-trigger-route-parity.vitest.test.ts).
 */
import { CRON_REGISTRY, isKnownCron } from '../../jobs/cron-registry.js'
import { recordCronRun, type CronCompletedStatus } from '../../utils/cron-observability.js'

/**
 * Start a run of a registered job by hand, in the business of the caller, and return at once: false when the job is
 * not in the registry (nothing starts). `onError` hears a handler that threw (the run row records it as FAILED).
 */
export function startCronByHand(jobName: string, onError: (err: unknown) => void): boolean {
  if (!isKnownCron(jobName)) return false
  const handler = CRON_REGISTRY[jobName]
  // Fire-and-forget so the HTTP response returns immediately.
  // recordCronRun will write a CronRun row that the hub picks
  // up on its next 30s poll.
  void recordCronRun(
    jobName,
    async () => {
      /**
       * ACR.1.2b — KEEP the handler's summary. This threw the result away and wrote the
       * literal string "manual trigger", so every manually-triggered run in the platform
       * recorded a row that said only that it had been triggered manually — which the
       * `triggeredBy` column already says. Measured: a hand-run of
       * `ads-structural-reconcile` landed `SUCCESS · "manual trigger"` beside scheduled
       * rows carrying `campaigns=215 entities=7790 verified=6849 mismatch=731 …`.
       *
       * That is the whole value of a run: an operator presses the button precisely to
       * find out what happened, and got the one row that could not tell them. The
       * fallback is kept for handlers that genuinely return nothing.
       */
      const result = await handler()
      if (typeof result === 'string' && result.trim()) return result
      if (result && typeof result === 'object' && 'summary' in result) {
        const s = (result as { summary?: unknown }).summary
        // P1.8 review — a completed-but-not-green status (PARTIAL, NOT_CONFIGURED) travels with its
        // summary; reducing the result to the string recorded a hand-run partial as SUCCESS.
        if (typeof s === 'string' && s.trim()) return { summary: s, cronStatus: (result as { cronStatus?: CronCompletedStatus }).cronStatus }
      }
      return 'manual trigger'
    },
    { triggeredBy: 'manual' },
  ).catch(onError)
  return true
}
