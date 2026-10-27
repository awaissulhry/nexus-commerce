/**
 * Reviews › Settings › Alerts (2026-10-26, build spec §3.6 / B15, PR D) — "New negative review": when the review intake
 * reads a NEW review of 1 or 2 stars, or one the AI reads as negative, the people the business picked hear about it at
 * once — in Nexus (a Notification row in the bell, like publish-refusal-notify.service.ts) and/or by e-mail.
 *
 * Rules (the lessons publish-refusal-notify.service.ts states):
 *   - RECIPIENTS ARE THIS BUSINESS'S PEOPLE, never every user: the members the business picked under Alerts; nobody
 *     picked = its active owners. Someone who left the business gets nothing.
 *   - DEDUPED: one unread notice per review per person.
 *   - Only reviews that ARRIVE: an imported file of old reviews and sandbox (fixture) rows alert nobody.
 *   - Best-effort: a failure here is logged and never turns a read review into a failed intake.
 *
 * The e-mail goes through the shared transport (sendEmail), which sends nothing unless outbound e-mail is on, and
 * carries this business's own sender (business-identity.service.ts); without one, no e-mail is sent.
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { workspaceIdForQuery } from '../../lib/workspace-context.js'
import { resolveBusinessIdentity } from '../business-identity.service.js'
import { sendEmail } from '../email/transport.js'
import { channelMarketLabel } from './overviewMath.js'
import { readAlert, teamMembers, type AlertSetting, type TeamMember } from './review-settings.service.js'

export const NEGATIVE_REVIEW_ALERT_TYPE = 'review-negative'

export interface NegativeReviewInput {
  reviewId: string
  channel: string
  marketplace: string | null
  rating: number | null
  /** The AI's reading: POSITIVE | NEUTRAL | NEGATIVE. */
  label: string | null
  /** How the review arrived (Review.ingestSource). */
  ingestSource: string | null
  title?: string | null
  body: string
  productName?: string | null
}

export interface AlertNotifyResult {
  created: number
  /** Skipped because the same notice is still unread. */
  deduped: number
  emailed: number
  /** Why nothing was sent, when nothing was ("off", "not negative", "imported", "nobody"). */
  skipped?: string
}

/** Sources that are not a review arriving: a file of old reviews, a hand entry, sandbox rows. */
const NOT_ARRIVALS = new Set(['IMPORT_CSV', 'IMPORT', 'MANUAL', 'FIXTURE'])

/** Whether a review counts as a new negative one for the alert. Pure. */
export function isAlertableNegative(input: Pick<NegativeReviewInput, 'rating' | 'label' | 'ingestSource'>): { alert: boolean; why?: string } {
  if (NOT_ARRIVALS.has((input.ingestSource ?? '').toUpperCase())) return { alert: false, why: 'imported' }
  const negative = input.label === 'NEGATIVE' || (input.rating != null && input.rating <= 2)
  return negative ? { alert: true } : { alert: false, why: 'not negative' }
}

/** Who gets it: the picked members still in the business, else its owners. Pure. */
export function alertRecipients(alert: Pick<AlertSetting, 'recipients'>, team: readonly TeamMember[]): TeamMember[] {
  const picked = team.filter((m) => alert.recipients.includes(m.userId))
  return picked.length ? picked : team.filter((m) => m.owner)
}

/** The notice's title and body, in words. Pure. */
export function negativeAlertWords(input: Pick<NegativeReviewInput, 'channel' | 'marketplace' | 'rating' | 'title' | 'body' | 'productName'>): { title: string; body: string } {
  const where = channelMarketLabel(input.channel, input.marketplace)
  const stars = input.rating != null ? `${input.rating} ${input.rating === 1 ? 'star' : 'stars'}` : 'Negative'
  const about = input.productName ? ` · ${input.productName}` : ''
  const quote = (input.title ? `${input.title} — ` : '') + input.body.replace(/\s+/g, ' ').trim()
  return {
    title: `New negative review: ${stars} on ${where}${about}`,
    body: quote.length > 200 ? `“${quote.slice(0, 199)}…”` : `“${quote}”`,
  }
}

export function inboxReviewHref(reviewId: string): string {
  return `/marketing/reviews/inbox?review=${encodeURIComponent(reviewId)}`
}

/**
 * An e-mailed link into the web app, inside THIS business (`/w/<business id>/…`, audit E9): a person who belongs to
 * several businesses lands in the one the e-mail is about, not in whichever they used last. Without business profiles
 * (or a business context) the bare path. null when the web address is unknown (`base` overrides it).
 */
export function businessWebLink(path: string, base: string | null = process.env.NEXUS_WEB_URL ?? null): string | null {
  const webBase = (base ?? '').replace(/\/$/, '')
  if (!webBase) return null
  if (process.env.NEXUS_WORKSPACES_ENABLED !== '1') return `${webBase}${path}`
  let id: string | null = null
  try {
    id = workspaceIdForQuery()
  } catch {
    id = null
  }
  return id ? `${webBase}/w/${encodeURIComponent(id)}${path}` : `${webBase}${path}`
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * Tell the picked people about a new negative review, as the business's "New negative review" alert says. Called by
 * the review intake for each new review; never throws.
 */
export async function notifyReviewAlert(input: NegativeReviewInput): Promise<AlertNotifyResult> {
  const none = (skipped: string): AlertNotifyResult => ({ created: 0, deduped: 0, emailed: 0, skipped })
  const negative = isAlertableNegative(input)
  if (!negative.alert) return none(negative.why ?? 'not negative')
  try {
    const alert = await readAlert('negative')
    if (!alert.on) return none('off')
    const recipients = alertRecipients(alert, await teamMembers())
    if (recipients.length === 0) return none('nobody')
    const words = negativeAlertWords(input)
    const href = inboxReviewHref(input.reviewId)
    const result: AlertNotifyResult = { created: 0, deduped: 0, emailed: 0 }

    if (alert.via.includes('app')) {
      for (const person of recipients) {
        const unread = await prisma.notification.findFirst({
          where: { userId: person.userId, type: NEGATIVE_REVIEW_ALERT_TYPE, entityType: 'Review', entityId: input.reviewId, readAt: null },
          select: { id: true },
        })
        if (unread) {
          result.deduped++
          continue
        }
        await prisma.notification.create({
          data: {
            userId: person.userId,
            type: NEGATIVE_REVIEW_ALERT_TYPE,
            severity: 'warn',
            title: words.title,
            body: words.body,
            entityType: 'Review',
            entityId: input.reviewId,
            // A bare path: the bell's router adds the business, so the link cannot open another business.
            href,
            meta: { channel: input.channel, marketplace: input.marketplace, rating: input.rating },
          },
        })
        result.created++
      }
    }

    if (alert.via.includes('email')) {
      const to = recipients.map((m) => m.email).filter(Boolean)
      const identity = await resolveBusinessIdentity()
      if (to.length && identity.ok) {
        // Inside this business (E9), as the daily digest's link.
        const link = businessWebLink(href)
        const sent = await sendEmail({
          to,
          from: identity.identity.emailFrom,
          subject: words.title,
          html: `<p><strong>${escapeHtml(words.title)}</strong></p><p>${escapeHtml(words.body)}</p>${link ? `<p><a href="${escapeHtml(link)}">Open it in the Inbox</a></p>` : ''}`,
          text: `${words.title}\n\n${words.body}${link ? `\n\nOpen it in the Inbox: ${link}` : ''}`,
          tag: 'review-negative-alert',
        })
        if (sent.ok) result.emailed = to.length
        else logger.warn('[review-alert-notify] e-mail not sent', { error: (sent.error ?? '').slice(0, 160) })
      }
    }
    return result
  } catch (error) {
    logger.warn('[review-alert-notify] failed', { error: String(error).slice(0, 160) })
    return none('failed')
  }
}
