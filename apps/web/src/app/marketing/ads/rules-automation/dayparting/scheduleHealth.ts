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
}

/**
 * rank-defend runs every 15 minutes. Two missed ticks is noise (a slow tick skips itself via the
 * overlap guard); by ~40 minutes something is actually wrong.
 */
export const STALE_AFTER_MS = 40 * 60 * 1000

export function scheduleHealth(input: HealthInput, now: number = Date.now()): Health {
  const { enabled, lastEvaluatedAt, failedWrites, governedElsewhere, membersTotal } = input

  // Failures outrank everything, including Paused: a schedule paused *because* it was failing
  // must not hide why. The Status column already says Paused, so nothing is lost.
  if (failedWrites > 0) {
    return { tone: 'bad', label: `${failedWrites} write${failedWrites === 1 ? '' : 's'} failing`, detail: `${failedWrites} Amazon write${failedWrites === 1 ? '' : 's'} from this schedule ended FAILED in the last 24 hours. Open Activity to see which.` }
  }
  // A paused schedule is not stale — it is not meant to be running.
  if (!enabled) {
    return { tone: 'muted', label: 'Paused', detail: 'Paused, so the rank loop skips it. Nothing is being held and nothing is reverted — Amazon keeps whatever bids were last set.' }
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
