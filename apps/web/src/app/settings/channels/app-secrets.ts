/**
 * P0.5 (docs/channel-connections/FINAL-PLAN.md) — what the "App secrets" card says about each of our
 * channel apps. Pure, so the web vitest runner (node, no DOM) can pin every wording and tone.
 *
 * The rows come from `GET /api/cx/apps`, which never returns a secret — only the expiry date an
 * operator recorded and the days left.
 */
import type { Tone } from '@/design-system/primitives'

export interface AppSecretRow {
  channelKey: string
  label: string
  environment: string
  secretExpiresAt: string | null
  daysLeft: number | null
  rotatedAt: string | null
}

/** Apps whose secret expires on a fixed schedule we must track (Amazon: every 180 days). */
export const SECRET_EXPIRES_ON_SCHEDULE = new Set(['AMAZON_SP'])

export function formatExpiryDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
}

export function appSecretStatus(row: AppSecretRow): { tone: Tone; label: string; detail: string } {
  const scheduled = SECRET_EXPIRES_ON_SCHEDULE.has(row.channelKey)
  if (!row.secretExpiresAt || row.daysLeft === null) {
    return scheduled
      ? {
          tone: 'warning',
          label: 'No expiry date recorded',
          detail: 'Find the date on this app’s LWA credentials in the Amazon Solution Provider Portal and record it here. Without it, Nexus cannot warn you before every Amazon call stops.',
        }
      : {
          tone: 'neutral',
          label: 'No expiry date recorded',
          detail: 'This channel does not expire our app secret on a schedule. Record a date only if the channel gave you one.',
        }
  }
  const date = formatExpiryDate(row.secretExpiresAt)
  const days = row.daysLeft
  if (days < 0) {
    return { tone: 'danger', label: 'Expired', detail: `The secret expired on ${date}. Rotate it in the channel’s developer portal now, then record the new date.` }
  }
  const left = `${days} day${days === 1 ? '' : 's'} left`
  const detail = `The secret expires on ${date}. Nexus alerts 90, 30 and 7 days before.`
  if (days <= 7) return { tone: 'danger', label: left, detail }
  if (days <= 30) return { tone: 'warning', label: left, detail }
  if (days <= 90) return { tone: 'info', label: left, detail }
  return { tone: 'success', label: left, detail }
}

/** The `yyyy-mm-dd` the date field edits, from the stored ISO timestamp (midnight UTC). */
export const expiryInputValue = (row: AppSecretRow): string => row.secretExpiresAt?.slice(0, 10) ?? ''

/** Apps with a scheduled expiry first (they can stop every call), then by name. */
export function sortAppSecrets(rows: AppSecretRow[]): AppSecretRow[] {
  const rank = (row: AppSecretRow) => (SECRET_EXPIRES_ON_SCHEDULE.has(row.channelKey) ? 0 : 1)
  return [...rows].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label) || a.environment.localeCompare(b.environment))
}
