/**
 * P3.4 — the sweep that turns the four measurable channel problems into notices the
 * owning profile's owners actually receive.
 *
 * Four, not five: `channel-deprecation` has no producer until P3.5 teaches the gateway
 * to read `Deprecation` / `Sunset` headers. Its shape lives in the service so P3.5 can
 * raise it through the same path; it is not swept here, and build/P3.4.md says so
 * rather than leaving a reader to assume it works.
 *
 * ## Why a sweep and not a hook at each failure
 *
 * Three of the four are about a RATE, not an event. One dead letter is normal; five in
 * an hour is a channel that has stopped working. A hook at the failure site can only
 * ever say "this one failed", which is the notice that trains an operator to ignore the
 * bell. The exception is signature failures, whose threshold is 1 — one payload we
 * could not verify is already worth saying — and even that is swept so the notice
 * carries a count instead of arriving seven times.
 *
 * A non-platform `cron.schedule` already visits every active business profile and runs
 * the handler inside each one, so every query here is this profile's own rows and the
 * recipients are this profile's owners.
 */

import cron from '../lib/cron/clustered.js'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import {
  raiseChannelAlert, thresholds,
  deadLetterAlert, signatureFailureAlert, feedRejectionAlert, secretExpiryAlert,
  signingKeyExpiryAlert,
  staleChannelDataAlert,
  callbackReadinessAlert,
} from '../services/cx/channel-alerts.service.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

export interface ChannelAlertSweepResult {
  /** Notices written. */
  created: number
  /** Notices folded into one already unread. */
  deduped: number
  /** Alerts that were evaluated and did NOT meet their threshold. */
  belowThreshold: number
}

/** Whole days until a date, rounded down; negative once it has passed. */
export function daysUntil(when: Date, now: number): number {
  return Math.floor((when.getTime() - now) / 86_400_000)
}

export async function runChannelAlertSweep(now: number = Date.now()): Promise<ChannelAlertSweepResult> {
  const hours = thresholds.windowHours()
  const since = new Date(now - hours * 3_600_000)
  const out: ChannelAlertSweepResult = { created: 0, deduped: 0, belowThreshold: 0 }

  const raise = async (alert: Awaited<ReturnType<typeof deadLetterAlert>>) => {
    if (!alert) { out.belowThreshold++; return }
    const r = await raiseChannelAlert(alert)
    out.created += r.created
    out.deduped += r.deduped
  }

  // 1 & 2 — dead letters and signature failures, both from the P2.1 inbound ledger,
  //         both per channel so one bad channel does not hide behind four good ones.
  try {
    const [dead, unverified] = await Promise.all([
      prisma.webhookEvent.groupBy({
        by: ['channel'], where: { status: 'dlq', createdAt: { gte: since } }, _count: { _all: true },
      }),
      prisma.webhookEvent.groupBy({
        by: ['channel'], where: { signatureOk: false, createdAt: { gte: since } }, _count: { _all: true },
      }),
    ])
    for (const row of dead) await raise(deadLetterAlert(String(row.channel), row._count?._all ?? 0, hours))
    for (const row of unverified) await raise(signatureFailureAlert(String(row.channel), row._count?._all ?? 0, hours))
  } catch (err: any) {
    logger.warn('[channel-alerts] inbound ledger sweep failed', { error: err?.message })
  }

  // 3 — feed rejections, from the P3.2 store. Counted per channel through the listing,
  //     because ListingIssue names a source and a listing but not a channel.
  try {
    const issues = await prisma.listingIssue.findMany({
      where: { resolvedAt: null, firstSeenAt: { gte: since } },
      select: { listingId: true, channelListing: { select: { channel: true } } },
    })
    const byChannel = new Map<string, { issues: number; listings: Set<string> }>()
    for (const i of issues) {
      const channel = i.channelListing?.channel ?? 'UNKNOWN'
      const entry = byChannel.get(channel) ?? { issues: 0, listings: new Set<string>() }
      entry.issues++
      entry.listings.add(i.listingId)
      byChannel.set(channel, entry)
    }
    for (const [channel, e] of byChannel) await raise(feedRejectionAlert(channel, e.issues, e.listings.size, hours))
  } catch (err: any) {
    logger.warn('[channel-alerts] rejection sweep failed', { error: err?.message })
  }

  // 4 — app-secret expiry. P0.5 already computes this and hands it to an alert service
  //     whose in-app channel is a console.log and whose email channel is off in
  //     production. Same fact, delivered.
  try {
    const apps = await prisma.channelApp.findMany({
      // P6.8 — NO `where`. The filter used to be `secretExpiresAt: { not: null }`, then
      // an OR with the signing key — and the callback-readiness check below is about a
      // row having NO dates and NO redirect URI at all. Selecting on the presence of a
      // date is exactly how a row with nothing set stays invisible. Five rows: read
      // them all and let each alert decide.
      where: {},
      select: { channelKey: true, environment: true, secretExpiresAt: true, signingKeyExpiresAt: true, redirectUris: true },
    })
    for (const app of apps) {
      if (app.secretExpiresAt) {
        await raise(secretExpiryAlert(app.channelKey, app.environment, daysUntil(app.secretExpiresAt, now)))
      }
      // P6.2 — the SIGNING key is a second credential with its own death date. Before
      // this the query filtered on `secretExpiresAt` alone, so a row carrying only a
      // signing-key date was not even selected.
      if (app.signingKeyExpiresAt) {
        await raise(signingKeyExpiryAlert(app.channelKey, app.environment, daysUntil(app.signingKeyExpiresAt, now)))
      }
      // P6.8 — a production app whose sign-in has nowhere to come back to.
      await raise(callbackReadinessAlert(app.channelKey, app.environment, app.redirectUris))
    }
  } catch (err: any) {
    logger.warn('[channel-alerts] secret-expiry sweep failed', { error: err?.message })
  }

  // 5 — P4.6e: Etsy's six-hour rule. A term of Etsy's API licence, not a performance target.
  //     Measured with NO `where` on the date, for the same reason as the sweep above: a row that
  //     has never been read has `lastSyncedAt` null, and that is the population this exists for.
  //     Selecting on the presence of a date would have made the whole finding invisible.
  try {
    const { ETSY_MAX_CONTENT_AGE_MS, etsyFreshnessCensus } = await import('../services/etsy/freshness.js')
    const rows = await prisma.channelListing.findMany({
      where: { channel: 'ETSY' },
      select: { lastSyncedAt: true },
    })
    const census = etsyFreshnessCensus(rows, now)
    // 🔴 Logged ALWAYS, including `total: 0`.
    //
    // The first version wrapped this in `if (rows.length > 0)`, and production answered with
    // silence — which is indistinguishable from the sweep having failed. It took a positive
    // control (`[channel-alerts] sweep` DID run at 10:30) to tell "there are no Etsy listings"
    // from "this block threw". That is the trap this whole package keeps finding, in this
    // session's own code: **an unwitnessed zero neither passes nor convicts.**
    //
    // The ALERT still only fires when something is stale — an empty shop is not a breach — but
    // the measurement is a fact and gets written down either way.
    logger.info('[channel-alerts] etsy freshness', census)
    await raise(staleChannelDataAlert('Etsy', census, ETSY_MAX_CONTENT_AGE_MS / 3_600_000))
  } catch (err: any) {
    logger.warn('[channel-alerts] etsy freshness sweep failed', { error: err?.message })
  }

  logger.info('[channel-alerts] sweep', { ...out, windowHours: hours })
  return out
}

export function startChannelAlertsCron(): void {
  if (scheduledTask) {
    logger.warn('channel-alerts cron already started')
    return
  }
  // Every 15 minutes. Fast enough that a channel which stopped working is noticed
  // within a coffee break; slow enough that the dedupe does the work rather than the
  // schedule. Every query is indexed and scoped to the window.
  const schedule = process.env.NEXUS_CHANNEL_ALERTS_SCHEDULE ?? '*/15 * * * *'
  if (!cron.validate(schedule)) {
    logger.error('channel-alerts cron: invalid schedule', { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, async () => {
    await recordCronRun('channel-alerts', async () => {
      const r = await runChannelAlertSweep()
      return `created=${r.created} deduped=${r.deduped} below=${r.belowThreshold}`
    })
  })
  logger.info('channel-alerts cron: scheduled', { schedule })
}

export function stopChannelAlertsCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}
