import { createHmac, timingSafeEqual } from 'node:crypto'
import { scopePublicToken, publicLinkSalt } from '../../lib/workspace-public-links.js'
import { workspaceKey } from '@nexus/database/workspace-context'
/**
 * RV.9.5 — Email suppression service.
 *
 * Single source of truth for "is this address allowed to receive
 * transactional review email?". Used by:
 *   - sendReviewRequestEmail (eBay/Shopify reviewer outreach)
 *   - sendSentimentCheckEmail (RV.6.3 diversion email)
 *   - public unsubscribe routes /api/email/unsubscribe/*
 *
 * The suppression table is keyed by (email, channel) where channel=null
 * means global suppression. A single check covers both cases:
 *
 *   isSuppressed('a@b.com', 'review-sentiment-check') →
 *     finds either { email, channel: 'review-sentiment-check' }
 *           OR     { email, channel: null }
 *
 * Note on legal posture: under EU GDPR (Art 21) + IT D.Lgs 196/2003 +
 * CAN-SPAM Section 5(a)(5), unsubscribe must be honored within 10
 * business days. By suppressing AT SEND TIME (not at unsubscribe time),
 * we honor instantly — no race window between a click and the next
 * cron tick.
 */

import prisma from '../../db.js'

export type SuppressionSource =
  | 'UNSUBSCRIBE_LINK'
  | 'BOUNCE_HARD'
  | 'COMPLAINT'
  | 'MANUAL'
  | 'GDPR_REQUEST'

export async function isEmailSuppressed(
  email: string,
  channel: string,
): Promise<{ suppressed: boolean; source?: string; reason?: string | null }> {
  const lower = email.trim().toLowerCase()
  if (!lower) return { suppressed: false }
  const row = await prisma.emailSuppression.findFirst({
    where: {
      email: lower,
      OR: [{ channel }, { channel: null }],
    },
    select: { source: true, reason: true, channel: true },
  })
  if (!row) return { suppressed: false }
  return { suppressed: true, source: row.source, reason: row.reason }
}

export async function addSuppression(opts: {
  email: string
  channel?: string | null
  source: SuppressionSource
  reason?: string | null
  ipAddress?: string | null
  userAgent?: string | null
}): Promise<{ created: boolean }> {
  const lower = opts.email.trim().toLowerCase()
  if (!lower) throw new Error('email is required')
  // Upsert against the (email, channel) unique. Postgres treats NULL as
  // distinct in unique constraints, so for channel=null we need a manual
  // existence check first.
  if (opts.channel == null) {
    const existing = await prisma.emailSuppression.findFirst({
      where: { email: lower, channel: null },
    })
    if (existing) return { created: false }
    await prisma.emailSuppression.create({
      data: {
        email: lower,
        channel: null,
        source: opts.source,
        reason: opts.reason ?? null,
        ipAddress: opts.ipAddress ?? null,
        userAgent: opts.userAgent ?? null,
      },
    })
    return { created: true }
  }
  await prisma.emailSuppression.upsert({
    where: { email_channel: workspaceKey({ email: lower, channel: opts.channel }) },
    update: {
      source: opts.source,
      reason: opts.reason ?? null,
      ipAddress: opts.ipAddress ?? null,
      userAgent: opts.userAgent ?? null,
    },
    create: {
      email: lower,
      channel: opts.channel,
      source: opts.source,
      reason: opts.reason ?? null,
      ipAddress: opts.ipAddress ?? null,
      userAgent: opts.userAgent ?? null,
    },
  })
  return { created: true }
}

export async function removeSuppression(opts: {
  email: string
  channel?: string | null
}): Promise<{ removed: number }> {
  const lower = opts.email.trim().toLowerCase()
  if (!lower) return { removed: 0 }
  if (opts.channel == null) {
    const res = await prisma.emailSuppression.deleteMany({
      where: { email: lower, channel: null },
    })
    return { removed: res.count }
  }
  const res = await prisma.emailSuppression.deleteMany({
    where: { email: lower, channel: opts.channel },
  })
  return { removed: res.count }
}

/**
 * New links authenticate the email and business. Previously issued links
 * continue to opt out only from the original business.
 */
export function unsubscribeTokenFor(email: string): string {
  const secret = process.env.NEXUS_UNSUBSCRIBE_SECRET
  if (!secret && !publicLinkSalt()) return legacyUnsubscribeToken(email)
  if (!secret) throw new Error('Configure the unsubscribe signing secret before sending review email.')
  return scopePublicToken(createHmac('sha256', secret).update(`${publicLinkSalt()}${email.trim().toLowerCase()}`).digest('base64url'))
}

function legacyUnsubscribeToken(email: string): string {
  return Buffer.from(`${email.trim().toLowerCase()}|${process.env.NEXUS_UNSUBSCRIBE_SECRET ?? 'xavia-default-secret'}`).toString('base64url').slice(0, 32)
}
export function verifyUnsubscribeToken(email: string, token: string): boolean {
  const equals = (expected: string) => token.length === expected.length && timingSafeEqual(Buffer.from(token), Buffer.from(expected))
  if (!publicLinkSalt() && equals(legacyUnsubscribeToken(email))) return true
  try { return equals(unsubscribeTokenFor(email)) } catch { return false }
}

export function emailFromUnsubscribeToken(token: string, candidates: string[]): string | null {
  // Token isn't directly reversible — caller must give us candidate
  // emails (recent recipients) to match against. In practice the
  // unsubscribe route accepts both ?token=X and ?email=foo@bar.com and
  // re-verifies the email vs token before suppressing.
  for (const email of candidates) {
    if (verifyUnsubscribeToken(email, token)) return email
  }
  return null
}
