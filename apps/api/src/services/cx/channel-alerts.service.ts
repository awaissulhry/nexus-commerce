/**
 * P3.4 (docs/channel-connections/FINAL-PLAN.md section 6, row P3.4) — alerts:
 * *dead-letter growth, signature failures, feed rejections over a threshold, secret
 * expiry, deprecation headers — to the owning profile's owners.*
 *
 * Done when: *each alert fired once in a test.*
 *
 * ## What was measured first (2026-09-20), and why this file exists
 *
 * There IS an alert service — `services/monitoring/alert.service.ts` — and P0.5's
 * app-secret-expiry alert already calls it. It reaches nobody:
 *
 * ```ts
 * private async createInAppAlert(alert: Alert, destination: string): Promise<void> {
 *   // Store in database for in-app notification
 *   console.log(`[IN_APP] Alert for ${destination}:`, alert.title)
 * }
 * ```
 *
 * The comment says "store in database". It writes a console line. And the only other
 * channel on `CONNECTION_HEALTH` is EMAIL, guarded by
 * `enabled: !!process.env.NEXUS_CONNECTION_ALERT_EMAIL` — **which is not set in
 * production** (checked against the live variable list, 2026-09-20).
 *
 * So every CONNECTION_HEALTH alert in production, including the secret-expiry alerts
 * this programme shipped in P0.5, has gone to a log line and stopped. The `IN_APP`
 * destination is the string `'admin'`, which is not a user id.
 *
 * Meanwhile the thing that DOES deliver sits right beside it: `Notification` + the
 * bell, **391,197 rows**, every one written by the ads programme. It is per-user, it is
 * scoped by business profile, and the bell reads it. That is the path.
 *
 * ## What each alert has to work with
 *
 * | Alert | Source | Rows today |
 * |---|---|---|
 * | dead-letter growth | `WebhookEvent.status = 'dlq'` (P2.1) | **0** — none has ever reached dlq |
 * | signature failures | `WebhookEvent.signatureOk = false` | **7**, real, and nothing has ever looked at them |
 * | feed rejections | `ListingIssue` (P3.2) | 0 locally; the store went live with P3.2 |
 * | secret expiry | `ChannelApp.secretExpiresAt` | **0** — no app has a date set, so P0.5's alert also has nothing to fire on |
 * | deprecation headers | — | **no producer yet; P3.5 builds it** |
 *
 * Four of the five can fire today. The fifth is named here with its shape so P3.5 only
 * has to call `raiseChannelAlert`, and is NOT presented as working.
 *
 * ## Two rules taken from `publish-refusal-notify.service.ts`
 *
 * 🔴 **Recipients are THIS business's people**, never every user. That file records why:
 * `ads-automation-notify.service.ts` fans out to every login on the system, and under
 * business profiles that delivers one business's problem — naming another business — to
 * people who belong to neither.
 *
 * 🔴 **Deduped, or it floods.** The same notifier measured 41,466 notifications a day
 * before its caps. A dead-letter backlog is the same fact every five minutes until
 * someone acts on it. One unread notice per kind per subject per person; once read, a
 * recurrence is new information and notifies again.
 */

import prisma from '../../db.js'
import { requireWorkspace } from '../../lib/workspace-context.js'
import { logger } from '../../utils/logger.js'

/**
 * The five alert kinds the plan row names. Each is a `Notification.type`, so the bell
 * and any future filter can tell them apart without reading the title.
 */
export const CHANNEL_ALERT_KINDS = [
  'channel-dead-letters',
  'channel-signature-failures',
  'channel-feed-rejections',
  'channel-secret-expiry',
  'channel-deprecation',
] as const

export type ChannelAlertKind = (typeof CHANNEL_ALERT_KINDS)[number]

export type ChannelAlertSeverity = 'info' | 'warn' | 'danger'

export interface ChannelAlert {
  kind: ChannelAlertKind
  severity: ChannelAlertSeverity
  title: string
  body: string
  /**
   * What the alert is ABOUT — a channel, an account, a listing. The dedupe key is
   * (kind, entityType, entityId, recipient), so two channels' dead letters are two
   * notices and one channel's are one.
   */
  entityType: string
  entityId: string
  /** Where the operator can act. A bare path; the bell's router adds the business prefix. */
  href?: string | null
  meta?: Record<string, unknown>
}

export interface RaiseResult {
  created: number
  /** Skipped because an identical notice is still unread. */
  deduped: number
  recipients: number
}

/**
 * The people to tell: the actor, if there is one, plus the ACTIVE OWNERS of the
 * business in context. Never every user on the system.
 */
export async function alertRecipients(workspaceId: string, actorUserId: string | null): Promise<string[]> {
  const owners = await prisma.workspaceMembership.findMany({
    where: {
      workspaceId, status: 'active', user: { status: 'active' },
      roles: { some: { role: { key: 'OWNER' } } },
    },
    select: { userId: true },
  })
  return [...new Set([...(actorUserId ? [actorUserId] : []), ...owners.map((o) => o.userId)])]
}

/**
 * Raise one channel alert to the owning profile's owners.
 *
 * Best-effort by design: an alert is a report ABOUT a failure, and a failure to file it
 * must never become a second failure. Returns what happened so a caller — or a test —
 * can assert on it rather than infer it from logs.
 */
export async function raiseChannelAlert(alert: ChannelAlert): Promise<RaiseResult> {
  try {
    const { workspaceId, actorUserId } = requireWorkspace()
    const recipients = await alertRecipients(workspaceId, actorUserId)
    if (recipients.length === 0) {
      // Not an error: a business with no active owner is a real state. Said out loud,
      // because an alert that silently reaches nobody is the defect this file exists
      // to fix — repeating it quietly would be worse than the original.
      logger.warn('[channel-alerts] no active owner to tell', { kind: alert.kind, workspaceId })
      return { created: 0, deduped: 0, recipients: 0 }
    }

    let created = 0
    let deduped = 0
    for (const userId of recipients) {
      const unread = await prisma.notification.findFirst({
        where: {
          userId, type: alert.kind, entityType: alert.entityType, entityId: alert.entityId, readAt: null,
        },
        select: { id: true },
      })
      if (unread) { deduped++; continue }
      await prisma.notification.create({
        data: {
          userId,
          type: alert.kind,
          severity: alert.severity,
          title: alert.title,
          body: alert.body,
          entityType: alert.entityType,
          entityId: alert.entityId,
          href: alert.href ?? null,
          meta: (alert.meta ?? {}) as never,
        },
      })
      created++
    }
    return { created, deduped, recipients: recipients.length }
  } catch (err: any) {
    logger.warn('[channel-alerts] could not raise', { kind: alert.kind, error: err?.message })
    return { created: 0, deduped: 0, recipients: 0 }
  }
}

/* ────────────────────────────────────────────────────────────────────────────────────
 * The thresholds. Each is an env override with a default that is deliberately not 1.
 *
 * A threshold of 1 on a retrying system turns a transient blip into a notice, and an
 * operator who learns to dismiss the bell stops reading it — which costs more than the
 * alert saves. Signature failures are the exception: one is already a security-relevant
 * fact, because it means something sent us a payload we could not verify.
 * ──────────────────────────────────────────────────────────────────────────────────── */

const int = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

export const thresholds = {
  /** Dead letters in the window before anyone is told. */
  deadLetters: (): number => int(process.env.NEXUS_ALERT_DLQ_THRESHOLD, 5),
  /** One unverifiable payload is worth saying. */
  signatureFailures: (): number => int(process.env.NEXUS_ALERT_SIGNATURE_THRESHOLD, 1),
  /** Rejected listings in the window before anyone is told. */
  feedRejections: (): number => int(process.env.NEXUS_ALERT_REJECTION_THRESHOLD, 10),
  /** Days before an app secret expires. Mirrors P0.5's own 90/30/7 ladder at its floor. */
  secretExpiryDays: (): number => int(process.env.NEXUS_ALERT_SECRET_EXPIRY_DAYS, 30),
  /** How far back each sweep looks. */
  windowHours: (): number => int(process.env.NEXUS_ALERT_WINDOW_HOURS, 24),
}

/* ────────────────────────────────────────────────────────────────────────────────────
 * The five evaluations. Each returns the alert it WOULD raise, or null — pure enough to
 * test without a database behind it, and separate from the raising so a test can assert
 * the threshold without asserting the delivery.
 * ──────────────────────────────────────────────────────────────────────────────────── */

export function deadLetterAlert(channel: string, count: number, hours: number): ChannelAlert | null {
  if (count < thresholds.deadLetters()) return null
  return {
    kind: 'channel-dead-letters',
    severity: 'danger',
    title: `${count} ${channel} event${count === 1 ? '' : 's'} gave up`,
    // "Dead letter" is the table's word, not an operator's. What matters is that
    // nothing will try them again — that is what makes this different from a retry.
    body: `${count} incoming ${channel} event${count === 1 ? ' has' : 's have'} run out of attempts in the last ${hours} hours. Nothing will try ${count === 1 ? 'it' : 'them'} again until someone replays ${count === 1 ? 'it' : 'them'}.`,
    entityType: 'Channel',
    entityId: channel,
    href: '/settings/channels',
    meta: { channel, count, windowHours: hours, threshold: thresholds.deadLetters() },
  }
}

export function signatureFailureAlert(channel: string, count: number, hours: number): ChannelAlert | null {
  if (count < thresholds.signatureFailures()) return null
  return {
    kind: 'channel-signature-failures',
    severity: 'danger',
    title: `${channel} sent ${count} message${count === 1 ? '' : 's'} we could not verify`,
    // Deliberately does not claim an attack. A rotated secret and a forged payload look
    // identical from here, and saying which would be a guess presented as a finding.
    body: `${count} incoming ${channel} message${count === 1 ? '' : 's'} failed its signature check in the last ${hours} hours. Either the signing secret has changed and ours is stale, or something else is sending us ${channel} payloads. Check the signing secret first.`,
    entityType: 'Channel',
    entityId: channel,
    href: '/settings/channels',
    meta: { channel, count, windowHours: hours, threshold: thresholds.signatureFailures() },
  }
}

export function feedRejectionAlert(channel: string, count: number, listings: number, hours: number): ChannelAlert | null {
  if (count < thresholds.feedRejections()) return null
  return {
    kind: 'channel-feed-rejections',
    severity: 'warn',
    title: `${channel} rejected ${listings} listing${listings === 1 ? '' : 's'}`,
    body: `${channel} refused ${count} change${count === 1 ? '' : 's'} across ${listings} listing${listings === 1 ? '' : 's'} in the last ${hours} hours. Each one is on its listing, in ${channel}'s own words.`,
    entityType: 'Channel',
    entityId: channel,
    href: '/settings/channels',
    meta: { channel, issues: count, listings, windowHours: hours, threshold: thresholds.feedRejections() },
  }
}

export function secretExpiryAlert(channelKey: string, environment: string, daysLeft: number): ChannelAlert | null {
  if (daysLeft > thresholds.secretExpiryDays()) return null
  const expired = daysLeft < 0
  return {
    kind: 'channel-secret-expiry',
    severity: expired ? 'danger' : 'warn',
    title: expired
      ? `The ${channelKey} app secret has expired`
      : `The ${channelKey} app secret expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`,
    body: expired
      ? `The ${environment} ${channelKey} app secret expired ${Math.abs(daysLeft)} day${Math.abs(daysLeft) === 1 ? '' : 's'} ago. Every call on this channel will be refused until it is replaced.`
      : `The ${environment} ${channelKey} app secret expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}. Replace it before then or every call on this channel starts being refused.`,
    // Keyed on the app, not the channel: two environments of one channel are two
    // different secrets and two different pieces of work.
    entityType: 'ChannelApp',
    entityId: `${channelKey}:${environment}`,
    href: '/settings/channels',
    meta: { channelKey, environment, daysLeft },
  }
}

/**
 * 🔶 The deprecation alert's SHAPE. It has no producer: P3.5 is the package that makes
 * the gateway read `Deprecation` / `Sunset` headers. This exists so that package raises
 * an alert through the same path as the other four rather than inventing a sixth, and
 * it is listed in build/P3.4.md as NOT firing today.
 */
export function deprecationAlert(channel: string, endpoint: string, sunsetAt: string | null): ChannelAlert {
  return {
    kind: 'channel-deprecation',
    severity: sunsetAt ? 'warn' : 'info',
    title: `${channel} is retiring an API Nexus uses`,
    body: sunsetAt
      ? `${channel} has marked ${endpoint} as deprecated and says it stops working on ${sunsetAt}. Nexus still calls it.`
      : `${channel} has marked ${endpoint} as deprecated. It has not said when it stops working. Nexus still calls it.`,
    entityType: 'ChannelEndpoint',
    entityId: `${channel}:${endpoint}`,
    href: '/settings/channels',
    meta: { channel, endpoint, sunsetAt },
  }
}
