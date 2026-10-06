/**
 * The Today board (GET /api/advertising/control-room/today, ads-today-board.service.ts): what needs a person now,
 * priced and ranked. The old Today tab drew it; since CR rebuild 1 the top tiles count it and the Needs you panel lists
 * it, on every tab.
 *
 * A row with no measurable price carries `amountCents: null` and a note saying what the missing number would have
 * measured, never a 0 that ranks a real problem below a trivial one.
 */
import type { Amount } from './todayAmounts'

export const TODAY_PATH = '/api/advertising/control-room/today'

export type Severity = 'critical' | 'warning' | 'info'

export interface Exception {
  key: string
  severity: Severity
  title: string
  detail: string
  count: number
  amountCents: number | null
  /** 7b — the price per currency; never added across currencies. */
  amounts?: Amount[]
  amountNote: string
  action: { label: string; href: string } | null
  since: string | null
}

export interface Board {
  generatedAt: string
  headline: { wastedSpend30dCents: number | null; wastedTargets: number; wasted?: Array<Amount & { targets: number }>; note: string }
  exceptions: Exception[]
  totals: { critical: number; warning: number; info: number }
}

/** "3 days" / "6 weeks" — the age of the oldest instance, not a timestamp nobody reads. */
export function waitingSince(iso: string | null, now = Date.now()): string | null {
  if (!iso) return null
  const ms = now - new Date(iso).getTime()
  if (Number.isNaN(ms) || ms < 0) return null
  const h = Math.floor(ms / 3_600_000)
  if (h < 1) return 'under an hour'
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'}`
  const d = Math.floor(h / 24)
  return d < 21 ? `${d} days` : `${Math.floor(d / 7)} weeks`
}
