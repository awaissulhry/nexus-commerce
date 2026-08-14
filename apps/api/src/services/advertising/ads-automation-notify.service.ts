/**
 * TD.0 — automation notifications. Fans an automation event out to every
 * operator's notification bell (the existing Notification model / /api/
 * notifications feed). Used by the `notify` rule action, the circuit-breaker,
 * and halt/resume events so a 24/7 agent's decisions are always observable.
 * Best-effort: a notification failure never breaks an automation run.
 *
 * CAP (2026-08-14) — deduped, because "always observable" had become "never read".
 *
 * Measured before the caps were armed: 41,466 notifications in 24h, 273,780 in 7 days —
 * **70.6% of every notification this account had ever created landed in the last week** — against
 * a total reviewable output of 260 AdsRuleSuggestion rows. `Low CTR bid reduction` alone produced
 * 14,738/day, and bursts of four identical rows inside a single second were routine. Re-sizing the
 * daily caps removed most of that volume at the source, which is the right place; this closes the
 * rest, and covers the rules deliberately exempt from a row cap (`Retail guard` evaluates every
 * tick by design, and its notify fires whether or not it paused anything).
 *
 * Two things are deliberate:
 *
 * 🔴 `danger` is NEVER deduped. This function also carries the circuit-breaker, the halt event and
 * `ad-rank-defend`'s blast-radius guard. Collapsing a second incident into the first is exactly the
 * failure this whole programme keeps finding, and a suppressed alarm is worse than a loud one.
 *
 * 🔴 A deduped notification is NOT a failed one. `notifyAutomation` still returns the number of
 * rows created, which is 0 when suppressed — so callers reading it as "did anyone hear this" would
 * read a suppression as a failure, the same conflation WH fixed in `alert_operator`. Callers that
 * need to tell the two apart use `notifyAutomationDetailed`.
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'

export interface AutomationNotice {
  type: string
  severity?: 'info' | 'success' | 'warn' | 'danger'
  title: string
  body?: string
  href?: string
  meta?: Record<string, unknown>
}

export interface NotifyResult {
  /** Notification rows actually created. 0 when suppressed OR when it genuinely failed. */
  created: number
  /** True when an identical UNREAD notice already exists inside the window. */
  deduped: boolean
  /** Users it would have reached had it not been suppressed. */
  wouldHaveReached: number
}

/**
 * Same (type, title, body) inside this window, still unread → suppressed. Unread is the point: once
 * an operator has actually seen it, a recurrence is new information and notifies again.
 * `body` is part of the key on purpose — the `notify` handler puts the campaign, target and market
 * in it, so deduping on title alone would collapse 85 distinct keywords into one line.
 */
const DEDUPE_WINDOW_MINUTES = Number(process.env.NEXUS_ADS_NOTIFY_DEDUPE_MINUTES ?? 360)

export async function notifyAutomationDetailed(n: AutomationNotice): Promise<NotifyResult> {
  try {
    const users = await prisma.userProfile.findMany({ select: { id: true }, take: 100 })
    if (users.length === 0) return { created: 0, deduped: false, wouldHaveReached: 0 }

    const severity = n.severity ?? 'info'
    if (severity !== 'danger' && DEDUPE_WINDOW_MINUTES > 0) {
      const since = new Date(Date.now() - DEDUPE_WINDOW_MINUTES * 60_000)
      const existing = await prisma.notification.findFirst({
        where: {
          type: n.type,
          title: n.title,
          body: n.body ?? null,
          readAt: null,
          createdAt: { gte: since },
        },
        select: { id: true },
      })
      if (existing) {
        return { created: 0, deduped: true, wouldHaveReached: users.length }
      }
    }

    await prisma.notification.createMany({
      data: users.map((u) => ({
        userId: u.id,
        type: n.type,
        severity,
        title: n.title,
        body: n.body ?? null,
        href: n.href ?? '/marketing/trading-desk/automation',
        meta: (n.meta ?? undefined) as never,
      })),
    })
    return { created: users.length, deduped: false, wouldHaveReached: users.length }
  } catch (e) {
    logger.warn('[ads-automation-notify] failed', { error: String(e).slice(0, 140) })
    return { created: 0, deduped: false, wouldHaveReached: 0 }
  }
}

/**
 * Rows created. Unchanged signature — every existing caller keeps working, and the eleven call
 * sites across six files (rank-defend, eBay ads, auto-harvest, auto-bid, halt) stay untouched.
 */
export async function notifyAutomation(n: AutomationNotice): Promise<number> {
  const r = await notifyAutomationDetailed(n)
  return r.created
}
