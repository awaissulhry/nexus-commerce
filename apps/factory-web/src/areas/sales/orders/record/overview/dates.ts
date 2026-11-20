import type { Dates } from './api'

/**
 * F-OO-100 (order overview lane: one file per section) — Next dates, its rules moved out of model.ts unchanged (F-SA-233, P16).
 * The requested date's field id stays in model.ts: Lines and the overview acts read it too.
 */

/** One of the next dates (the order's own milestones, late first; the ex-factory day when fewer than three wait). */
export interface NextDate {
  readonly id: string
  readonly what: { readonly kind: 'gate'; readonly gateKind: string | null; readonly label: string | null } | { readonly kind: 'milestone'; readonly milestone: string } | { readonly kind: 'exFactory' }
  readonly target: string | null
  readonly late: number | null
}

/** The next three dates to come: late first (most late first), then by target; the ex-factory day fills the last place. */
export function nextDatesOf(dates: Dates | null | undefined, promise: string | null, count = 3): NextDate[] {
  const open = (dates?.milestones ?? []).filter((row) => row.state !== 'DONE')
  const sorted = [...open].sort((a, b) => Number((b.late ?? 0) > 0) - Number((a.late ?? 0) > 0) || (b.late ?? 0) - (a.late ?? 0) || (a.target ?? '9999').localeCompare(b.target ?? '9999'))
  const rows: NextDate[] = sorted.slice(0, count).map((row) => ({ id: row.id, what: row.kind === 'GATE' ? { kind: 'gate', gateKind: row.gateKind, label: row.label } : { kind: 'milestone', milestone: row.kind }, target: row.target, late: row.late }))
  if (rows.length < count && promise && !open.some((row) => row.kind === 'SHIP')) rows.push({ id: 'ex-factory', what: { kind: 'exFactory' }, target: promise, late: null })
  return rows
}
