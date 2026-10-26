/**
 * Reviews › Requests › Queue — the bulk bar (Owner ruling 7): which ticked requests Snooze, Skip and Send now would
 * change, and which they leave out and why. A bulk action that cannot apply to some ticked rows counts the rows it
 * changes; when it can apply to none it is held and names why. The server decides again when it runs
 * (`POST /api/review-queue/bulk` answers `{ changed, held }`); this plan only says so before the press. Send now's
 * reasons are the server's own words per row (`sendNowHeld`); Snooze and Skip follow the server's rules
 * (review-queue-words.ts `snoozeHeldFor`, `skipHeldFor`). Pure; tested in queueBulk.vitest.test.ts.
 */
import type { QueueRow } from './queueDatasource'

export type QueueBulkAction = 'snooze' | 'skip' | 'send-now'
export type SnoozeDays = 1 | 3 | 7

const DAY_MS = 24 * 60 * 60 * 1000
/** Amazon's last day for a request, counted from Nexus's delivery date. */
export const AMAZON_LAST_DAY = 30

export const SNOOZE_CHOICES: { days: SnoozeDays; label: string }[] = [
  { days: 1, label: '1 day' },
  { days: 3, label: '3 days' },
  { days: 7, label: '1 week' },
]

export interface BulkPlan {
  apply: string[]
  held: { id: string; words: string }[]
}

const shortDate = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })

/** Why Snooze by `days` is held for one row, or null. */
export function snoozeHeld(row: QueueRow, days: number, now: Date): string | null {
  if (row.status === 'SENT') return 'Already sent — nothing to snooze'
  if (row.status === 'SKIPPED' || row.status === 'SUPPRESSED') return 'Not in the queue — use Allow again first'
  if (row.channel === 'AMAZON' && row.deliveredAt) {
    const next = row.nextTryAt ? new Date(row.nextTryAt) : null
    const from = next && next.getTime() > now.getTime() ? next : now
    const target = from.getTime() + days * DAY_MS
    const lastDay = new Date(row.deliveredAt).getTime() + AMAZON_LAST_DAY * DAY_MS
    if (target > lastDay) return `That moves it past Amazon’s day 30 (${shortDate(new Date(lastDay).toISOString())}) — it would never go`
  }
  return null
}

/** Why Skip is held for one row, or null. */
export function skipHeld(row: QueueRow): string | null {
  if (row.status === 'SENT') return 'Already sent — a sent request cannot be taken back'
  if (row.status === 'SKIPPED') return 'Already skipped'
  return null
}

/** Which ticked rows an action changes and which it leaves out, with the reason. */
export function queueBulkPlan(rows: readonly QueueRow[], action: QueueBulkAction, now: Date, days: SnoozeDays = 1): BulkPlan {
  const plan: BulkPlan = { apply: [], held: [] }
  for (const row of rows) {
    const why = action === 'skip' ? skipHeld(row) : action === 'snooze' ? snoozeHeld(row, days, now) : row.sendNowHeld
    if (why) plan.held.push({ id: row.id, words: why })
    else plan.apply.push(row.id)
  }
  return plan
}

const VERB: Record<QueueBulkAction, string> = { snooze: 'snoozed', skip: 'skipped', 'send-now': 'sent now' }

/**
 * The bar's held reason: null when at least one ticked row can change. When none can, the reason they share, or the
 * first one with how many more differ.
 */
export function bulkHeldReason(plan: BulkPlan, action: QueueBulkAction): string | null {
  if (plan.apply.length > 0 || plan.held.length === 0) return null
  const reasons = [...new Set(plan.held.map((h) => h.words))]
  const n = plan.held.length
  const lead = n === 1 ? 'The ticked request cannot be ' : `None of the ${n} ticked requests can be `
  if (reasons.length === 1) return `${lead}${VERB[action]}: ${reasons[0]}`
  return `${lead}${VERB[action]}: ${reasons[0]} (and ${reasons.length - 1} other ${reasons.length === 2 ? 'reason' : 'reasons'})`
}

/** "Send now" or "Send now (3 of 5)" when some ticked rows are left out. */
export function bulkLabel(base: string, plan: BulkPlan): string {
  const total = plan.apply.length + plan.held.length
  return plan.held.length > 0 && plan.apply.length > 0 ? `${base} (${plan.apply.length} of ${total})` : base
}

/** The left-out rows grouped by reason: "2 already sent", in the confirm. */
export function leftOutLines(plan: BulkPlan): string[] {
  const by = new Map<string, number>()
  for (const h of plan.held) by.set(h.words, (by.get(h.words) ?? 0) + 1)
  return [...by].map(([words, n]) => `${n} left out: ${words}`)
}

/** The toast after the server answered. */
export function bulkResultWords(action: QueueBulkAction, changed: number, held: readonly { words: string }[], days?: SnoozeDays): string {
  const what = action === 'snooze'
    ? `${changed} ${changed === 1 ? 'request' : 'requests'} snoozed by ${SNOOZE_CHOICES.find((c) => c.days === days)?.label ?? `${days} days`}`
    : action === 'skip'
      ? `${changed} ${changed === 1 ? 'request' : 'requests'} skipped`
      : `${changed} ${changed === 1 ? 'request' : 'requests'} sent now`
  if (held.length === 0) return what
  const reasons = [...new Set(held.map((h) => h.words))]
  return `${what} · ${held.length} left out: ${reasons[0]}${reasons.length > 1 ? ` (+${reasons.length - 1} more reasons)` : ''}`
}
