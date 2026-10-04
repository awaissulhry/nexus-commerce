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
import { workspaceContext } from '../../lib/workspace-context.js'

/**
 * Ads fix 7d (review 8.8) — where an automation notice links: the Control Room, where Resume and the dial live. The old
 * default, `/marketing/trading-desk/automation`, has no page (the web 308s it here for notices already stored).
 */
export const AUTOMATION_HREF = '/marketing/ads/rules-automation/control-room'

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

/**
 * WHO an automation notice is for.
 *
 * 🔴 2026-09-16 — this was `userProfile.findMany({ take: 100 })`: every login on the
 * system, of any status, capped at the first hundred. Measured on the local database:
 * `fulfillment-test@nexus.local` — DEACTIVATED, a member of ZERO businesses — had
 * received 195,370 ads notices. Three separate defects in one line:
 *
 *   • deactivated people were notified (and could never read it);
 *   • with business profiles on, people outside the business were addressed. Row-level
 *     security kept them from READING those rows, so no screen leaked — but the rows
 *     were written into a business the recipient does not belong to;
 *   • `take: 100` silently dropped real members once a system passed a hundred users,
 *     so the people who ran the automation could be the ones left out.
 *
 * Now: with business profiles on, the ACTIVE members of the business the automation
 * ran in. With them off there is one business, so every ACTIVE user. No cap — a
 * recipient list that truncates silently is the bug, and floods are what the caps and
 * the dedupe below are for.
 *
 * Profiles on with NO business in context sends to nobody and says so. Every business
 * sweep runs inside `withWorkspace`; a caller that does not is broken, and guessing an
 * audience for it would be exactly the fan-out this replaces.
 */
async function recipients(): Promise<string[] | null> {
  if (process.env.NEXUS_WORKSPACES_ENABLED === '1') {
    const context = workspaceContext()
    if (!context) {
      logger.warn('[ads-automation-notify] no business in context; notice not delivered')
      return null
    }
    const members = await prisma.workspaceMembership.findMany({
      where: { workspaceId: context.workspaceId, status: 'active', user: { status: 'active' } },
      select: { userId: true },
    })
    return members.map((m) => m.userId)
  }
  const users = await prisma.userProfile.findMany({ where: { status: 'active' }, select: { id: true } })
  return users.map((u) => u.id)
}

export async function notifyAutomationDetailed(n: AutomationNotice): Promise<NotifyResult> {
  try {
    const everyone = await recipients()
    if (!everyone || everyone.length === 0) return { created: 0, deduped: false, wouldHaveReached: 0 }

    const severity = n.severity ?? 'info'
    let targets = everyone
    if (severity !== 'danger' && DEDUPE_WINDOW_MINUTES > 0) {
      const since = new Date(Date.now() - DEDUPE_WINDOW_MINUTES * 60_000)
      /*
       * 🔴 PER PERSON. This used to ask "does an identical unread notice exist for
       * anyone", so one person's unread copy suppressed the notice for everyone — and a
       * deactivated account never reads anything, so its copies could have silenced the
       * people still working. Each person now gets at most one unread copy of their own.
       */
      const already = await prisma.notification.findMany({
        where: {
          type: n.type,
          title: n.title,
          body: n.body ?? null,
          readAt: null,
          createdAt: { gte: since },
          userId: { in: everyone },
        },
        select: { userId: true },
      })
      const holding = new Set(already.map((a) => a.userId))
      targets = everyone.filter((id) => !holding.has(id))
      if (targets.length === 0) {
        return { created: 0, deduped: true, wouldHaveReached: everyone.length }
      }
    }

    await prisma.notification.createMany({
      data: targets.map((userId) => ({
        userId,
        type: n.type,
        severity,
        title: n.title,
        body: n.body ?? null,
        href: n.href ?? AUTOMATION_HREF,
        meta: (n.meta ?? undefined) as never,
      })),
    })
    return { created: targets.length, deduped: false, wouldHaveReached: everyone.length }
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
