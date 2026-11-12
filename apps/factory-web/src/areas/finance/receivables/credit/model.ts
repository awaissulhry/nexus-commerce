import { isApiError } from '../../../../lib/api/errors'
import type { Locale } from '../../../../lib/i18n/locales'
import { parseAmount } from '../../_shared/model'
import { LIMIT_VIEWS, type LimitRow, type LimitView } from './api'

/**
 * Finance › Receivables › Credit limits (SCR-151 sec:credit, design "Credit limits — Limit, used (open invoices + unbilled
 * orders), available, orders on hold"; "Change limit (logged, ActionConfirm)"): the pure rules of the section — who may do
 * what, the address's view, the bar's tone, the typed limit, the change's review, the CSV. B-W2b-304.
 */

export const CREDIT_NAMESPACE = 'sales-credit'

export interface CreditCan {
  readonly view: boolean
  readonly price: boolean
  readonly change: boolean
}

/** What the person may do here, from the session's permissions (each row says again what it allows: `mayChange`). */
export function creditCanOf(permissions: readonly string[]): CreditCan {
  const held = new Set(permissions)
  return { view: held.has('sales.credit.view'), price: held.has('money.price'), change: held.has('sales.credit.limits') }
}

/** The view in the address (`?credit=OVER`), else All. */
export function creditViewOf(params: { get(name: string): string | null } | null): LimitView {
  const value = params?.get('credit') ?? null
  return (LIMIT_VIEWS as readonly string[]).includes(value ?? '') ? (value as LimitView) : 'ALL'
}

/** The bar's tone: within (under 80 %), close (80 to 100 %), over (above, or anything found over the limit). */
export function usedTone(row: Pick<LimitRow, 'usedPct' | 'findings'>): 'complete' | 'partial' | 'missing' | 'unknown' {
  if (row.usedPct === null) return 'unknown'
  if (row.findings.includes('OVER_LIMIT') || row.usedPct > 100) return 'missing'
  return row.usedPct >= 80 ? 'partial' : 'complete'
}

/** What waits for credit, as phrases ("2 orders · 1 shipment"); empty when nothing does. */
export function heldPhrases(row: Pick<LimitRow, 'held'>): { key: string; count: number }[] {
  const out: { key: string; count: number }[] = []
  if (row.held.orders > 0) out.push({ key: 'row.orders', count: row.held.orders })
  if (row.held.releases > 0) out.push({ key: 'row.releases', count: row.held.releases })
  if (row.held.shipments > 0) out.push({ key: 'row.shipments', count: row.held.shipments })
  return out
}

/** A typed limit ("25.000,00", "25000") as minor units, 0 allowed; null when it is not an amount. */
export function parseLimit(text: string): number | null {
  if (/^\s*0+([.,]0{1,2})?\s*$/.test(text)) return 0
  return parseAmount(text)
}

export interface ChangeDraft {
  readonly amountText: string
  readonly currency: string
  readonly clear: boolean
  readonly reason: string
}

export type ChangeProblem = 'amount' | 'reason' | 'same' | 'customer'

/** What is wrong with a change before it is reviewed (each a key under `change.problem.`). */
export function changeProblems(draft: ChangeDraft, current: { readonly limit: number | null | undefined; readonly currency: string | null } | null, picked = true): ChangeProblem[] {
  const problems: ChangeProblem[] = []
  if (!picked) problems.push('customer')
  const amount = draft.clear ? null : parseLimit(draft.amountText)
  if (!draft.clear && amount === null) problems.push('amount')
  if (draft.reason.trim() === '' || draft.reason.length > 500 || /[\r\n]/.test(draft.reason)) problems.push('reason')
  if (current && amount !== null && current.limit === amount && current.currency === draft.currency) problems.push('same')
  if (current && draft.clear && (current.limit === null || current.limit === undefined)) problems.push('same')
  return problems
}

/** A refusal of the API in the section's words (a key under the namespace). */
export function readProblem(error: unknown): string {
  if (!isApiError(error)) return 'problem.internal'
  if (['conflict', 'signed_out', 'forbidden', 'not_found', 'unavailable', 'rate_limited', 'invalid'].includes(error.kind)) return `problem.${error.kind}`
  return 'problem.internal'
}

/** A live event that may change a credit reading or the limits. */
export const creditLiveTouches = (change: { type: string }): boolean =>
  change.type === 'credit_check.recorded' ||
  change.type === 'credit_limit.changed' ||
  change.type.startsWith('payment.') ||
  change.type === 'invoice.issued' ||
  change.type === 'sales_order.created' ||
  change.type === 'sales_order.status_changed'

// ---- CSV ------------------------------------------------------------------------------------------------------------------

const cell = (value: string): string => (/[";\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)
const minorText = (minor: number | null | undefined, locale: Locale): string => (minor === null || minor === undefined ? '' : (minor / 100).toFixed(2).replace('.', locale === 'it' ? ',' : '.'))

/** The chosen rows as CSV (`;`), amounts only with the price grain (the API left them out otherwise). */
export function creditCsv(rows: readonly LimitRow[], header: (column: string) => string, locale: Locale): string {
  const columns = ['customer', 'code', 'company', 'currency', 'limit', 'used', 'available', 'overdue', 'orders', 'releases', 'shipments']
  const lines = [columns.map((column) => cell(header(column))).join(';')]
  for (const row of rows) {
    lines.push(
      [row.party.name, row.party.code, row.company.code, row.currency, minorText(row.limit, locale), minorText(row.used, locale), minorText(row.available, locale), minorText(row.overdue, locale), String(row.held.orders), String(row.held.releases), String(row.held.shipments)]
        .map(cell)
        .join(';'),
    )
  }
  return `${lines.join('\n')}\n`
}
