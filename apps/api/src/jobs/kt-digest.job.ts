/**
 * KT.7 — the Keyword Tracker's daily digest.
 *
 * Same shape as `dashboard-digest.job.ts` and `ads-report-schedule.job.ts`: a cron gate of its own,
 * the shared Resend transport underneath, and **no second transport**. Two gates have to be open for
 * an email to leave the building — this job's own flag and `NEXUS_ENABLE_OUTBOUND_EMAILS` inside the
 * transport — and the summary states which of them stopped it, because "the digest works" is a claim
 * that is very easy to make about an email nobody received.
 *
 * Recipients come from `NEXUS_KT_DIGEST_TO`. Absent, the job builds the digest and reports what it
 * WOULD have said, which is the useful behaviour for a page whose value is being proven: the content
 * is verifiable before anyone's inbox is involved.
 */

import cron from '../lib/cron/clustered.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { envEnabled } from '../utils/env-flag.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

export async function runKtDigestOnce(): Promise<string> {
  const { buildKtDigest, renderKtDigest, sendKtDigest } = await import('../services/advertising/kt7-notify.service.js')
  const since = new Date(Date.now() - 24 * 3600_000)
  const to = (process.env.NEXUS_KT_DIGEST_TO ?? '').split(',').map((s) => s.trim()).filter(Boolean)

  if (to.length === 0) {
    // Build it anyway. The content is the point; the delivery is configuration.
    const data = await buildKtDigest(since)
    const r = renderKtDigest(data)
    return `built, NOT SENT (NEXUS_KT_DIGEST_TO unset) · applied=${data.applied} refused=${data.refused} reversed=${data.reversed} notable=${data.notable.length} · subject="${r.subject}"`
  }

  const { data, rendered, result } = await sendKtDigest({ recipients: to, since })
  const how = result.dryRun
    ? 'NOT SENT — the transport is in dry-run because NEXUS_ENABLE_OUTBOUND_EMAILS is not set'
    : result.ok ? `sent to ${to.length} recipient${to.length === 1 ? '' : 's'}` : `FAILED: ${result.error ?? 'unknown'}`
  return `${how} · applied=${data.applied} refused=${data.refused} reversed=${data.reversed} notable=${data.notable.length} · subject="${rendered.subject}"`
}

export async function runKtDigestCron(): Promise<void> {
  try {
    await recordCronRun('kt-digest', runKtDigestOnce)
  } catch (err) {
    logger.error('kt-digest cron: failure', { error: err instanceof Error ? err.message : String(err) })
  }
}

export function startKtDigestCron(): void {
  if (scheduledTask) { logger.warn('kt-digest cron already started'); return }
  if (!envEnabled('NEXUS_ENABLE_KT_DIGEST_CRON')) {
    logger.info('kt-digest cron disabled (set NEXUS_ENABLE_KT_DIGEST_CRON=1)')
    return
  }
  // 07:30 UTC — after the nightly ads jobs have settled, before the operator's morning.
  const schedule = process.env.NEXUS_KT_DIGEST_SCHEDULE ?? '30 7 * * *'
  if (!cron.validate(schedule)) { logger.error('kt-digest cron: invalid schedule', { schedule }); return }
  scheduledTask = cron.schedule(schedule, () => void runKtDigestCron())
  logger.info(`kt-digest cron scheduled (${schedule})`)
}
