import type { Issue } from '../core/errors'
import type { Permission } from '../core/permissions'
import { parseNumber, PatternError } from './format'
import { isFiscalKind, kindLabel, yearOfScope, type DocumentKind } from './kinds'

/**
 * The number preview and the controlled override (B-W2b-24; PLT-125 "number preview and controlled override"; design
 * admin.documents popup `override` "Type a number for a migrated document": "Number, why; clashes refused at once"; the
 * W1 gap "no number preview for GR / LOT / PO"), pure.
 *
 *   preview    the number a new document of a kind would get now: the series' next one, NOT reserved (another document
 *              may take it first; the number is given when the document is saved). Shown to who makes such documents.
 *   override   a document carried over from the old system (an open order, a work order, a lot at go-live) keeps the
 *              number it had there instead of the series' next one. Controlled: numbering.override over the company, a
 *              reason (kept in the audit row), only the kinds below (never a fiscal kind: an invoice, credit note,
 *              deposit invoice or DDT keeps its gapless series, DPR 633/1972 art. 21), and refused at once when the number
 *              is taken (issued by the company's series of the kind, or typed for another document) or when the series
 *              would give it later (its pattern, this period, at or after its next number). The series' counter does not
 *              move and no NumberAllocation row is written: the typed number is not the series' (the fiscal check and
 *              "Numbers issued" list only what the series gave).
 */

/** The kinds a migrated document may carry its old number for (never a fiscal kind). */
export const OVERRIDABLE_KINDS = ['QUOTE', 'SALES_ORDER', 'PURCHASE_ORDER', 'WORK_ORDER', 'SUBCONTRACT', 'LOT'] as const satisfies readonly DocumentKind[]
export type OverridableKind = (typeof OVERRIDABLE_KINDS)[number]
export const isOverridableKind = (kind: unknown): kind is OverridableKind => typeof kind === 'string' && (OVERRIDABLE_KINDS as readonly string[]).includes(kind)

/**
 * Who may see the number a new document would get (besides numbering.view): the permission that makes such a document
 * (W1 gap: goods receipts, lots, purchase orders; and the kinds a migrated document may carry its old number for).
 */
export const PREVIEW_PERMISSIONS: Readonly<Partial<Record<DocumentKind, readonly Permission[]>>> = Object.freeze({
  QUOTE: ['quotes.manage'],
  SALES_ORDER: ['orders.manage'],
  PURCHASE_ORDER: ['purchasing.manage'],
  GOODS_RECEIPT: ['inventory.receive'],
  LOT: ['inventory.receive', 'inventory.opening.import'],
  WORK_ORDER: ['workorders.manage'],
  SUBCONTRACT: ['purchasing.subcontract.manage'],
})

/** A typed number: 1 to 40 letters, digits and / . _ - (no spaces), starting with a letter or a digit. */
export const TYPED_NUMBER = /^[A-Za-z0-9][A-Za-z0-9/._-]{0,39}$/
export const MAX_TYPED_NUMBER_LENGTH = 40
export const OVERRIDE_REASON_MIN = 3
export const OVERRIDE_REASON_MAX = 500

/** Why a typed number is refused (codes travel; the web says its own words). */
export const OVERRIDE_REFUSALS = Object.freeze({
  kind: 'This kind of document always takes the next number of its series (a fiscal series never skips or reuses a number).',
  shape: 'Type the number as it was printed: 1 to 40 letters, digits and / . _ - , no spaces.',
  reason: 'Say why this document keeps its old number (for example: an open order carried over from the old system).',
  taken: 'This number is used already: another document of this kind has it.',
  future: 'The series will give this number later: type another, or move the series past it first (Admin › Documents & numbering).',
})
export type OverrideRefusal = keyof typeof OVERRIDE_REFUSALS

/** The typed number as kept: trimmed. */
export const typedNumberOf = (text: string): string => text.trim()

/** What is wrong with the typed number and its reason, before the series and the documents are read. */
export function typedNumberProblems(input: { readonly kind: DocumentKind; readonly number: string; readonly reason?: string | null }): { readonly code: OverrideRefusal; readonly issue: Issue }[] {
  const out: { code: OverrideRefusal; issue: Issue }[] = []
  if (isFiscalKind(input.kind) || !isOverridableKind(input.kind)) out.push({ code: 'kind', issue: { path: 'kind', message: OVERRIDE_REFUSALS.kind } })
  if (!TYPED_NUMBER.test(typedNumberOf(input.number))) out.push({ code: 'shape', issue: { path: 'number', message: OVERRIDE_REFUSALS.shape } })
  if (input.reason !== undefined) {
    const reason = (input.reason ?? '').trim()
    if (reason.length < OVERRIDE_REASON_MIN || reason.length > OVERRIDE_REASON_MAX) out.push({ code: 'reason', issue: { path: 'reason', message: OVERRIDE_REFUSALS.reason } })
  }
  return out
}

/**
 * Whether the series would give this number later: the typed text is its pattern's for its period and its value is at or
 * after the series' next number. A pattern that cannot read the text (other fixed text, another year) never clashes.
 */
export function seriesWouldIssue(series: { readonly pattern: string; readonly scopeKey: string; readonly nextValue: number }, number: string): boolean {
  let value: number | null
  try {
    value = parseNumber(series.pattern, typedNumberOf(number), yearOfScope(series.scopeKey))
  } catch (error) {
    if (error instanceof PatternError) return false
    throw error
  }
  return value !== null && value >= series.nextValue
}

/** The audit row's words of an override (English; the reason as the person typed it). */
export function overrideWords(kind: DocumentKind, number: string): string {
  return `The ${kindLabel(kind)} keeps the number ${typedNumberOf(number)} it had in the old system.`
}
