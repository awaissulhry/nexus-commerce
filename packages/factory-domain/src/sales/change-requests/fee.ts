import type { Issue } from '../../core/errors'
import { fitsDecimal, fromMinorUnits, toMinorUnits, type MinorUnits } from '../../core/money'
import { decimalText } from '../../product/units/units'
import { parseDecimal } from '../../tax/decimal'
import type { Words } from './rules'

/**
 * The cancel fee of a customer's cancel request (B-W2b-F14 on B-W2b-183; design portal.customer.orders "Ask to cancel"
 * "Fee 15%"; SalesSettings.cancelFeePct, schema wave 23): a percent of each cancelled line's net value, 0 to 100 with at
 * most 4 decimals (the column's Decimal(7,4) and the database's SalesSettings_cancel_fee_check); none: free. The fee is
 * SHOWN — in the cancel pop-up before the customer sends, on a waiting cancel request, in the office's answer — and moves
 * no money (no invoice, no credit note). It is a price (the money.price grain): a reader without the grain sees the
 * percent, not the amounts.
 *
 *   per line   the line's net value (minor units of the order's currency) × the percent, rounded once at the minor unit
 *              by the money rules' one rounding function (core/money toMinorUnits, A1 §2.1)
 *   whole      the sum of the lines' fees (a line closed short already is not cancelled again: no fee)
 */

export const MAX_CANCEL_FEE_PCT = 100

/** The settings' problems in words, by path (`body/cancelFeePct`); null (free) is fine. */
export function cancelFeeProblems(value: unknown, path = 'body/cancelFeePct'): Issue[] {
  if (value === null) return []
  const parsed = typeof value === 'string' ? parseDecimal(value) : null
  if (typeof value !== 'string' || parsed === null || !fitsDecimal(value, 7, 4) || parsed.lt(0) || parsed.gt(MAX_CANCEL_FEE_PCT)) {
    return [{ path, message: `A percentage from 0 to ${MAX_CANCEL_FEE_PCT}, at most 4 decimals, or none (free).` }]
  }
  return []
}

/** The percent as stored (Decimal(7,4)) → its plain text ("15", "12.5"); null: free. */
export const cancelFeePctOf = (stored: { toString(): string } | string | null): string | null => (stored === null ? null : decimalText(stored.toString()))

/** One line's fee: its net value × the percent, in minor units of the currency (0 when free). */
export function cancelFeeOf(netMinor: MinorUnits, pct: string | null, currency: string): MinorUnits {
  if (pct === null) return 0
  const percent = parseDecimal(pct)
  if (percent === null || percent.isZero() || netMinor === 0) return 0
  return toMinorUnits(fromMinorUnits(netMinor, currency).times(percent).dividedBy(100), currency)
}

/** "Free to cancel" / "Fee 15% of the cancelled lines' value", in both languages (the Italian with a decimal comma). */
export function cancelFeeWords(pct: string | null): Words {
  const percent = pct === null ? null : parseDecimal(pct)
  if (percent === null || percent.isZero()) return { it: 'Annullamento gratuito', en: 'Free to cancel' }
  return { it: `Penale del ${pct!.replace('.', ',')}% sul valore delle righe annullate`, en: `Fee ${pct}% of the cancelled lines' value` }
}

export interface FeeLine {
  readonly id: string
  readonly seq: number
  readonly netAmount: MinorUnits
  readonly closedShort: boolean
}

export interface CancelFee {
  readonly pct: string | null
  readonly words: Words
  readonly currency: string
  readonly lines: readonly { readonly lineId: string; readonly seq: number; readonly fee: MinorUnits }[]
  readonly totalFee: MinorUnits
}

/**
 * The fee of cancelling these lines (none named: the whole order, every line not closed short), line by line in the order's
 * line order, and the total.
 */
export function cancelFeeFor(lines: readonly FeeLine[], lineIds: readonly string[] | null, pct: string | null, currency: string): CancelFee {
  const asked = lineIds === null || lineIds.length === 0 ? null : new Set(lineIds)
  const cancelled = [...lines].filter((line) => (asked ? asked.has(line.id) : !line.closedShort)).sort((a, b) => a.seq - b.seq)
  const fees = cancelled.map((line) => ({ lineId: line.id, seq: line.seq, fee: line.closedShort ? 0 : cancelFeeOf(line.netAmount, pct, currency) }))
  return { pct, words: cancelFeeWords(pct), currency, lines: fees, totalFee: fees.reduce((total, line) => total + line.fee, 0) }
}
