import type { MinorUnits } from '../../../core/money'
import { Dec, type Decimal } from '../../../tax/decimal'
import type { EarningsKind } from '../../earnings/rules'

/**
 * The earnings report (B-W2b-43; MES-304 "piece pay per worker, line and period, with make-up cost"; design people.reports
 * "Earnings report": worker or line · pieces · earnings · make-up · make-up share; "Group by line for people without
 * individual access"), pure. Rows are made from the ledger; reversals count (they carry the opposite figures), so a corrected
 * scan is counted once. A team's split counts its share of the team's pieces, so a line's pieces are the pieces made.
 *
 * Nothing here names a person: the caller passes a group key and masks a group below the company's minimum size.
 */

export interface ReportEntry {
  readonly kind: EarningsKind
  readonly employeeId: string
  readonly pieces: number | null
  readonly sharePct: string | null
  readonly amount: MinorUnits
}

export interface ReportRow {
  readonly key: string
  readonly people: number
  /** Pieces made (three decimals: a team's share may split a piece). */
  readonly pieces: string
  readonly earnings: MinorUnits
  readonly makeUp: MinorUnits
  /** Make-up ÷ (earnings + make-up), percent, two decimals; null with no pay. */
  readonly makeUpSharePct: string | null
}

const share = (entry: ReportEntry): Decimal => {
  const pieces = new Dec(entry.pieces ?? 0)
  return entry.kind === 'TEAM_SPLIT' && entry.sharePct !== null ? pieces.times(new Dec(entry.sharePct)).dividedBy(100) : pieces
}

/** One row per group, in the order the groups were first met. */
export function reportRows(entries: readonly (ReportEntry & { readonly group: string })[]): ReportRow[] {
  const groups = new Map<string, { people: Set<string>; pieces: Decimal; earnings: number; makeUp: number }>()
  for (const entry of entries) {
    const group = groups.get(entry.group) ?? { people: new Set<string>(), pieces: new Dec(0), earnings: 0, makeUp: 0 }
    group.people.add(entry.employeeId)
    if (entry.kind === 'MAKE_UP') group.makeUp += entry.amount
    else group.earnings += entry.amount
    if (entry.kind === 'SCAN' || entry.kind === 'TEAM_SPLIT') group.pieces = group.pieces.plus(share(entry))
    groups.set(entry.group, group)
  }
  return [...groups].map(([key, group]) => {
    const pay = group.earnings + group.makeUp
    return {
      key,
      people: group.people.size,
      pieces: group.pieces.toDecimalPlaces(3, Dec.ROUND_HALF_UP).toFixed(3),
      earnings: group.earnings,
      makeUp: group.makeUp,
      makeUpSharePct: pay <= 0 ? null : new Dec(group.makeUp).times(100).dividedBy(pay).toDecimalPlaces(2, Dec.ROUND_HALF_UP).toFixed(2),
    }
  })
}
