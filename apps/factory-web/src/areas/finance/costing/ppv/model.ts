import type { Locale } from '../../../../lib/i18n/locales'
import type { PpvAnswer, PpvRow } from './api'
// B-W2b-GB02 (G053): the writes' rules (a reversal with its reason, a document posted by hand) and their refusals in words.
import { isApiError, issuePath } from '../../../../lib/api/errors'
import { rightRef } from '../../../../lib/i18n/rights'
import { PPV_REFUSALS, type PpvDocument, type PpvPostAnswer, type PpvSkip } from './api'

/**
 * B-W2b-424 — Finance › Costing › Purchase price variance (design finance.costing sec:ppv; FIN-031), the pure rules: the
 * difference's tone (paid above the standard: warning; below: success), a row's state (a reversal, reversed on a day, or
 * standing), the CSV of the chosen rows (the amount columns only with the cost grain: never more than the screen shows)
 * and the live events that read the section again. No fetching, no React. No person is named.
 */

/** The section's view model (PpvSection draws it and fetches nothing). */
export interface PpvSectionModel {
  /** Unit costs and differences: the cost grain (money.cost). */
  readonly cost: boolean
  /** The page's period (the API's from/to are its days). */
  readonly period: { readonly month: string; readonly from: string; readonly to: string }
  readonly rows: readonly PpvRow[] | null
  readonly more: boolean
  readonly problem: string | null
  /** "Still loading…" after about a second (design: GridSheetNote slow). */
  readonly slow: boolean
  /** Over every page of the period, per currency. */
  readonly totals: PpvAnswer['totals'] | null
  /** The company's figures wait for the accountant (its switch is off): nothing is posted here meanwhile. */
  readonly waits: boolean
  /** Design cases: the chosen rows, the focused row, the keys panel open. */
  readonly selected?: readonly string[]
  readonly focusRow?: number
  readonly keysOpen?: boolean
  // ---- B-W2b-GB02 (G053)
  /** costing.ledger.manage: reverse a variance, post a document's variances by hand (absent: neither). */
  readonly can?: { readonly manage: boolean }
  /** The reversal or the post dialog open (absent: none). */
  readonly dialog?: PpvDialog | null
  /** What the last write did, in words (absent: nothing to say). */
  readonly notice?: { readonly tone: 'success' | 'danger'; readonly words: PpvPhrase } | null
  /** Design cases: a typed reason, the document's kind and number. */
  readonly draft?: { readonly reason?: string; readonly at?: 'RECEIPT' | 'INVOICE'; readonly number?: string }
  // ---- end B-W2b-GB02
}

// ---- B-W2b-GB02 (G053; B-W2b-424's gap 1) ------------------------------------------------------------------------------

/** A message key of the costing-close catalogue and its values (the view translates it). */
export interface PpvPhrase {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

export type PpvDialog =
  | { readonly kind: 'reverse'; readonly row: PpvRow; readonly busy: boolean; readonly problem: PpvPhrase | null }
  | { readonly kind: 'post'; readonly busy: boolean; readonly problem: PpvPhrase | null; readonly result: PpvPostResult | null }

/** What a post by hand did: the document, the variances it wrote and the lines that took none (and why). */
export interface PpvPostResult {
  readonly number: string
  readonly posted: number
  readonly skipped: readonly { readonly seq: number; readonly code: PpvSkip }[]
}

export const PPV_REASON_MIN = 3
export const PPV_REASON_MAX = 1000

/** Why "Reverse…" is held on a row, or null: no costing.ledger.manage, a reversal row, a variance reversed already, a write running. */
export function ppvReverseHeld(row: Pick<PpvRow, 'reversalOfId' | 'reversedBy'>, can: { readonly manage: boolean } | undefined, busy = false): PpvPhrase | null {
  if (!can?.manage) return { key: 'ppv.held.noManage', params: { right: rightRef('costing.ledger.manage') } }
  if (row.reversalOfId) return { key: 'ppv.held.isReversal' }
  if (row.reversedBy) return { key: 'ppv.held.reversed' }
  if (busy) return { key: 'ppv.held.busy' }
  return null
}

/** Why the reversal's button is held: the reason (3 to 1,000 characters), or a write running. */
export function ppvReasonHeld(reason: string, busy = false): PpvPhrase | null {
  const length = reason.trim().length
  if (length < PPV_REASON_MIN) return { key: 'ppv.reverse.reasonShort', params: { min: PPV_REASON_MIN } }
  if (length > PPV_REASON_MAX) return { key: 'ppv.reverse.reasonLong', params: { max: PPV_REASON_MAX } }
  if (busy) return { key: 'ppv.held.busy' }
  return null
}

/** Why "Post a document…" (or its dialog's Post) is held: no costing.ledger.manage, no number typed, a write running. */
export function ppvPostHeld(can: { readonly manage: boolean } | undefined, number: string | null, busy = false): PpvPhrase | null {
  if (!can?.manage) return { key: 'ppv.held.noManage', params: { right: rightRef('costing.ledger.manage') } }
  if (number !== null && number.trim().length === 0) return { key: 'ppv.post.numberNeeded' }
  if (busy) return { key: 'ppv.held.busy' }
  return null
}

/** The document with exactly this number (the API's search finds every number that contains it), or null. */
export function documentByNumber(found: readonly PpvDocument[], number: string): PpvDocument | null {
  const wanted = number.trim().toLowerCase()
  return found.find((document) => document.number.trim().toLowerCase() === wanted) ?? null
}

/** A post's answer as the dialog says it. */
export const postResultOf = (number: string, answer: Pick<PpvPostAnswer, 'posted' | 'skipped'>): PpvPostResult => ({ number, posted: answer.posted.length, skipped: answer.skipped.map((line) => ({ seq: line.seq, code: line.code })) })

/** A refused write in this section's words: the API's `refusal/<CODE>` by its code, else the kind of failure. */
export function ppvWriteProblem(error: unknown): PpvPhrase {
  if (!isApiError(error)) return { key: 'problem.internal' }
  const refusal = error.issues.map(issuePath).find((path) => path.startsWith('refusal/'))
  const code = refusal?.split('/')[1]
  if (code && (PPV_REFUSALS as readonly string[]).includes(code)) return { key: `ppv.refusal.${code}` }
  if (code) return { key: 'ppv.refusal.other' }
  if (error.kind === 'conflict') return { key: 'ppv.problem.changed' }
  if (['signed_out', 'forbidden', 'not_found', 'unavailable', 'rate_limited', 'invalid'].includes(error.kind)) return { key: `problem.${error.kind}` }
  return { key: 'problem.internal' }
}

/** The document search failing: without the right to read receipts or supplier invoices, it says which. */
export function ppvFindProblem(error: unknown, at: 'RECEIPT' | 'INVOICE'): PpvPhrase {
  if (isApiError(error) && error.kind === 'forbidden') return { key: 'ppv.post.noLookup', params: { right: rightRef(at === 'RECEIPT' ? 'inventory.stock.view' : 'payables.view') } }
  return ppvWriteProblem(error)
}
// ---- end B-W2b-GB02

export interface PpvSectionActions {
  onRetry?: () => void
  onMore?: () => void
  onExport?: (rows: readonly PpvRow[], words: PpvCsvWords, fileName: string) => void
  /** Enter on a row: the document it comes from. */
  onOpen?: (row: PpvRow) => void
  // ---- B-W2b-GB02 (G053)
  /** Reverse… on a row (null: the dialog closes). */
  onReverse?: (row: PpvRow | null) => void
  onReverseSubmit?: (reason: string) => void
  /** Post a document… (false: the dialog closes). */
  onPost?: (open: boolean) => void
  onPostSubmit?: (document: { at: 'RECEIPT' | 'INVOICE'; number: string }) => void
  onDismissNotice?: () => void
  // ---- end B-W2b-GB02
}

/** Above 0 the material was paid above its standard (unfavourable). */
export function differenceTone(row: Pick<PpvRow, 'differenceAmount'>): 'warning' | 'success' | 'neutral' {
  if (typeof row.differenceAmount !== 'number' || row.differenceAmount === 0) return 'neutral'
  return row.differenceAmount > 0 ? 'warning' : 'success'
}

export type PpvState = 'reversal' | 'reversed' | 'standing'
export const ppvStateOf = (row: Pick<PpvRow, 'reversalOfId' | 'reversedBy'>): PpvState => (row.reversalOfId ? 'reversal' : row.reversedBy ? 'reversed' : 'standing')

/** The document a row comes from, as a record reference (a goods receipt or a supplier invoice). */
export const documentRef = (row: Pick<PpvRow, 'source'>): { type: 'GoodsReceipt' | 'SupplierInvoice'; id: string; label: string } => ({
  type: row.source.at === 'RECEIPT' ? 'GoodsReceipt' : 'SupplierInvoice',
  id: row.source.documentId,
  label: row.source.number,
})

export interface PpvCsvWords {
  readonly header: (column: string) => string
  readonly at: (row: PpvRow) => string
  readonly state: (row: PpvRow) => string
}

const plainMinor = (value: number | undefined, locale: Locale): string => (value === undefined ? '' : (value / 100).toFixed(2).replace('.', locale === 'it' ? ',' : '.'))
const plainDecimal = (value: string | undefined, locale: Locale): string => (value === undefined ? '' : locale === 'it' ? value.replace('.', ',') : value)

/** The chosen rows as CSV: `;` and the decimal comma in Italian, `,` and the dot in English; amounts only with the cost grain. */
export function ppvCsv(rows: readonly PpvRow[], cost: boolean, words: PpvCsvWords, locale: Locale): string {
  const separator = locale === 'it' ? ';' : ','
  const cell = (value: string | number): string => {
    const text = String(value)
    return new RegExp(`["\\n${separator}]`).test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const columns = ['material', 'supplier', 'document', 'at', 'day', 'quantity', 'unit', ...(cost ? ['standard', 'paid', 'difference', 'currency'] : []), 'state']
  const lines = [columns.map((column) => cell(words.header(column))).join(separator)]
  for (const row of rows) {
    lines.push(
      [
        `${row.item.code} · ${row.item.name}`,
        row.supplier.name,
        `${row.source.number} / ${row.source.seq}`,
        words.at(row),
        row.day,
        plainDecimal(row.quantity, locale),
        row.item.baseUom,
        ...(cost ? [plainDecimal(row.standardUnitCost, locale), plainDecimal(row.paidUnitCost, locale), plainMinor(row.differenceAmount, locale), row.currency] : []),
        words.state(row),
      ]
        .map(cell)
        .join(separator),
    )
  }
  return `${lines.join('\n')}\n`
}

/** A variance posted or taken back, or the company's switch changed: the section reads again. */
export const ppvTouches = (change: { type: string }): boolean => change.type === 'purchase_price_variance.posted' || change.type === 'actual_cost_settings.changed'
