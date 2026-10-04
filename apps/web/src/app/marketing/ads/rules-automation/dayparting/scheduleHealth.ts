/**
 * RDX/A3 — health, as distinct from status.
 *
 * The list's Status pill means one thing only: `enabled`. It stayed green while every Amazon write
 * dead-lettered, while a family plan quietly took the campaigns over, and while the cron sat dead.
 * Health is the second, honest signal — computed from the runtime the group endpoint now returns.
 *
 * Pure and dependency-free so the ordering can be tested; the order below IS the policy.
 */

export type HealthTone = 'ok' | 'warn' | 'bad' | 'muted'
export interface Health { tone: HealthTone; label: string; detail: string }

export interface HealthInput {
  enabled: boolean
  lastEvaluatedAt: string | null
  failedWrites: number
  governedElsewhere: number
  membersTotal: number
  /** RD.P2 — members that can never reach their own goal. 0 when nothing is wrong. */
  cannotConverge?: number
  /** The engine's own reason, for the tooltip. */
  cannotConvergeReason?: string | null
}

/**
 * rank-defend runs every 15 minutes. Two missed ticks is noise (a slow tick skips itself via the
 * overlap guard); by ~40 minutes something is actually wrong.
 */
export const STALE_AFTER_MS = 40 * 60 * 1000

export function scheduleHealth(input: HealthInput, now: number = Date.now()): Health {
  const { enabled, lastEvaluatedAt, failedWrites, governedElsewhere, membersTotal } = input
  const cannotConverge = input.cannotConverge ?? 0

  // Failures outrank everything, including Paused: a schedule paused *because* it was failing
  // must not hide why. The Status column already says Paused, so nothing is lost.
  if (failedWrites > 0) {
    return { tone: 'bad', label: `${failedWrites} write${failedWrites === 1 ? '' : 's'} failing`, detail: `${failedWrites} Amazon write${failedWrites === 1 ? '' : 's'} from this schedule ended FAILED in the last 24 hours. Open Activity to see which.` }
  }
  // A paused schedule is not stale — it is not meant to be running.
  // 2a — pausing gives back the bids it floored (review 3.2); before, they stayed at the floor for good.
  if (!enabled) {
    // Owner 2026-10-04 — after a wait, the loop gives back on a paused campaign only; a live one waits for a person.
    return { tone: 'muted', label: 'Paused', detail: 'Paused, so the rank loop skips it. The bids it floored are given back when it is paused — or, if ads automation was stopped or Rank & Dayparting switched off, on the first run after that changes for a paused campaign, while a live one waits for you to give its bids back from the banner on this list. Placement percentages stay as last set.' }
  }
  if (membersTotal === 0) {
    return { tone: 'warn', label: 'No campaigns', detail: 'This schedule holds no campaigns, so it can never run. Add campaigns, or delete it.' }
  }
  // The silent one. rank-defend skips any campaign a Rank Director family plan governs, so these
  // members sit in the schedule without being controlled by it.
  if (governedElsewhere >= membersTotal) {
    return { tone: 'warn', label: 'Governed elsewhere', detail: 'Every campaign here is governed by a Rank Director family plan, which takes precedence. This schedule is evaluated for none of them.' }
  }
  if (governedElsewhere > 0) {
    return { tone: 'warn', label: `${governedElsewhere} governed elsewhere`, detail: `${governedElsewhere} of ${membersTotal} campaigns are governed by a Rank Director family plan and are not controlled by this schedule.` }
  }
  /**
   * RD.P2 — the state the page most needed and did not have.
   *
   * Placed here deliberately, and the position IS the policy:
   *
   *  · BELOW `Governed elsewhere`, because a campaign a family plan owns is not this schedule's to
   *    converge — saying "cannot converge" about a row it never evaluates would be false.
   *  · ABOVE `Never run` and `Stale`, because those are TRANSIENT — a schedule armed two minutes
   *    ago reaches its first tick in fifteen, and a stale cron is fixed by the next tick. Cannot
   *    converge is a CONFIG fault that no amount of waiting repairs: the ceiling equals the floor,
   *    or the CPC ceiling pins the placement below its own floor, or the base bid alone defeats the
   *    ceiling. Ranking a transient above a permanent fault buries the permanent one, which is
   *    exactly how 29 open-loop campaigns spent months reading `OK`.
   */
  if (cannotConverge > 0) {
    const all = cannotConverge >= membersTotal
    return {
      tone: 'warn',
      label: all ? 'Cannot converge' : `${cannotConverge} cannot converge`,
      detail: input.cannotConvergeReason
        ?? (all
          ? 'This schedule is running and can never reach its goal. Open the Campaigns grain to see which ceiling is deciding.'
          : `${cannotConverge} of ${membersTotal} campaigns here can never reach their goal. Open the Campaigns grain to see which.`),
    }
  }
  if (!lastEvaluatedAt) {
    return { tone: 'muted', label: 'Never run', detail: 'No evaluation recorded yet. A schedule armed within the last 15 minutes has simply not reached its first tick.' }
  }
  const age = now - new Date(lastEvaluatedAt).getTime()
  if (age > STALE_AFTER_MS) {
    return { tone: 'warn', label: 'Stale', detail: `Last evaluated ${Math.round(age / 60000)} minutes ago. The rank loop runs every 15 — check that the ad-rank-defend cron is alive.` }
  }
  return { tone: 'ok', label: 'OK', detail: 'Evaluated on schedule, with no failed Amazon writes in the last 24 hours.' }
}

/** Compact relative time for the Last run column. */
export function relTime(iso: string | null): string {
  if (!iso) return '—'
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

// ── 2a — what deleting, pausing or removing gives back, in words ─────────────────────────────────────────────────

/** GET /advertising/rank-schedule-groups/:id/release-preview, as the API sends it. */
export interface ReleasePreview {
  campaigns: number
  /** Campaigns whose bids would come back. */
  restore: number
  /** Bids that would come back across them. */
  bids: number
  keptByOthers: number
  nothing: number
  /** Why the give-back would wait now (ads automation stopped, Rank & Dayparting switched off); null = at once. */
  waitWhy: string | null
  items: Array<{
    campaignId: string; name: string; outcome: 'restore' | 'kept-by-others' | 'nothing'; bids: number
    floorCents: number | null; floorBy: string | null; placements: { top: number; rest: number; product: number }
  }>
}

/** What a delete, a pause or a save gave back, as the API answers it (`release`). */
export interface ReleaseReport {
  restored: number; keptByOthers: number; failed: number; deferred: number; deferredWhy: string | null; writes: number
}

const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`

/**
 * The preview in plain sentences, for the delete dialog: what comes back, what stays floored and why, and the
 * placements, which stay as last set (nothing stored what they were before the schedule).
 */
export function releasePreviewLines(p: ReleasePreview): string[] {
  const lines: string[] = []
  if (!p.restore) lines.push('No campaign here holds a bid floor this schedule set, so no bid changes.')
  else if (p.waitWhy) lines.push(`The ${n(p.bids, 'bid')} it floored on ${n(p.restore, 'campaign')} ${p.bids === 1 ? 'stays' : 'stay'} floored for now because ${p.waitWhy}. ${p.bids === 1 ? 'It comes' : 'They come'} back on the first run after that changes on a paused campaign; on a live one, when you give ${p.bids === 1 ? 'it' : 'them'} back from the banner on the Rank & Dayparting list.`)
  else lines.push(`Gives back at once the ${n(p.bids, 'bid')} it floored on ${n(p.restore, 'campaign')}.`)
  if (p.keptByOthers) {
    const who = [...new Set(p.items.filter((i) => i.outcome === 'kept-by-others').map((i) => i.floorBy ?? 'someone else'))]
    lines.push(`${n(p.keptByOthers, 'campaign')} ${p.keptByOthers === 1 ? 'stays' : 'stay'} floored: the floor was set by ${who.join(', ')}, not by this schedule.`)
  }
  const placed = p.items.filter((i) => i.placements.top || i.placements.rest || i.placements.product)
  if (!placed.length) lines.push('Placement percentages stay as they are (all at 0%).')
  else {
    const shown = placed.slice(0, 3).map((i) => `${i.name} Top ${i.placements.top}% · Rest ${i.placements.rest}% · Product ${i.placements.product}%`)
    lines.push(`Placement percentages stay as they are: ${shown.join('; ')}${placed.length > 3 ? `; and ${n(placed.length - 3, 'more campaign')}` : ''}.`)
  }
  return lines
}

/** The builder's note: how many of its campaigns this schedule holds at a floor right now. */
export function releaseHoldLine(p: ReleasePreview): string {
  if (!p.restore) return 'Right now this schedule holds no bid floor.'
  return `Right now this schedule holds a bid floor on ${p.restore} of its ${n(p.campaigns, 'campaign')} (${n(p.bids, 'bid')}).`
}

/** After a pause: what came back, what waits and why, what someone else holds. */
export function releaseOutcomeLine(schedules: number, r: ReleaseReport): string {
  const parts = [`Paused ${n(schedules, 'schedule')}.`]
  if (r.restored) parts.push(`Gave back the bids on ${n(r.restored, 'campaign')} (${n(r.writes, 'bid')}).`)
  if (r.deferred) parts.push(`${n(r.deferred, 'campaign')} ${r.deferred === 1 ? 'stays' : 'stay'} floored for now because ${r.deferredWhy ?? 'ads automation is stopped'}; the bids come back on the first run after that changes on a paused campaign, and a live one waits for you in the banner on this list.`)
  if (r.keptByOthers) parts.push(`${n(r.keptByOthers, 'campaign')} ${r.keptByOthers === 1 ? 'stays' : 'stay'} floored by someone else.`)
  if (r.failed) parts.push(`${n(r.failed, 'campaign')} could not be given back in full; the next run tries again on a paused campaign, and a live one waits for you in the banner on this list.`)
  if (!r.restored && !r.deferred && !r.keptByOthers && !r.failed) parts.push(`None of ${schedules === 1 ? 'its' : 'their'} campaigns held a bid floor, so no bid changed.`)
  return parts.join(' ')
}
