import { decimalText } from '../../product/units/units'
import { Dec } from '../../tax/decimal'
import { MAX_TEXT } from '../quotes/quotes'

/**
 * Two versions of a quote compared (B-W2b-302; SAL-158 "Version difference view helps renegotiation"; design sales.quotes
 * quote.versions.compare: lines added / removed / changed, per size quantity changes, price, discount, dates and terms changes,
 * totals before → after, "Use as change note"), pure. The answer is shaped for the design part VersionCompare (B-W2b-207,
 * packages/ui patterns/VersionCompare) as B-W2b-220's style compare is: sections of lines matched across the two versions, each
 * line's fields WRITTEN (codes, exact decimals, dates as YYYY-MM-DD: language-free), its quantities per size, the totals before
 * → after. A screen hands a section straight to <VersionCompare> and may relabel the fields by `id`.
 *
 * Sections, in this order:
 *   terms   one line: validity, firm offer, promise date, payment terms, deposit, acceptance mode, Incoterm and place, ship
 *           complete, language, currency, T&C version
 *   lines   the lines matched by what they sell (kind, style, colourway, fee kind; the n-th such line of one version with the
 *           n-th of the other, in line order: a revise copies the lines with new ids); a line whose colourway changed is one
 *           removed and one added. Fields: place, section, text, note, revision, delivery schedule, options, times (a fee);
 *           sizes = pieces per size. Totals: lines, pieces
 *   prices  (the price grain) the same lines: unit price, list price, discount off the list, each size's own price, the line's
 *           net, the reason of a manual change. Totals: net, VAT, gross, deposit (the version's currency, 2 places)
 *   margin  (the margin grain) the same lines' margin %; total: the version's margin %
 */

export type Written = string | null

export interface CompareSide {
  readonly fields: Readonly<Record<string, Written>>
  readonly sizes?: Readonly<Record<string, string>>
}

export interface CompareLine {
  readonly id: string
  readonly label: string
  readonly detail: string | null
  readonly before: CompareSide | null
  readonly after: CompareSide | null
}

export interface CompareField {
  readonly id: string
  readonly label: string
}

export interface CompareTotal {
  readonly id: string
  readonly label: string
  readonly before: Written
  readonly after: Written
}

export const QUOTE_SECTION_IDS = ['terms', 'lines', 'prices', 'margin'] as const
export type QuoteSectionId = (typeof QUOTE_SECTION_IDS)[number]

export interface CompareSection {
  readonly id: QuoteSectionId
  readonly label: string
  readonly fields: readonly CompareField[]
  readonly sizes: readonly string[]
  readonly lines: readonly CompareLine[]
  readonly totals: readonly CompareTotal[]
  readonly summary: { readonly added: number; readonly removed: number; readonly changed: number; readonly unchanged: number }
}

// ---- what the API reads ------------------------------------------------------------------------------------------------

export interface QuoteLineFacts {
  readonly id: string
  readonly seq: number
  readonly kind: string
  readonly feeKind: string | null
  readonly section: string | null
  readonly styleId: string
  /** "SEED-JKT-01 Seed leather jacket". */
  readonly style: string
  readonly colourwayId: string
  /** "BLK Black". */
  readonly colourway: string
  /** "Rev 1" (the revision costed from), or null. */
  readonly revision: string | null
  readonly description: string | null
  readonly note: string | null
  /** A fee's times (a size-grid line: its pieces, said by its sizes). */
  readonly quantity: number
  /** Pieces per size. */
  readonly sizes: Readonly<Record<string, number>>
  /** "2026-12-04: 50 ×1, 52 ×1 · 2026-12-18: 52 ×2", or null. */
  readonly deliveries: string | null
  /** "Liner · Name \"ROSSI\"", or null. */
  readonly options: string | null
  readonly unitPrice: string
  readonly listUnitPrice: string | null
  readonly discountPct: string | null
  /** A size's own price when it differs from the line's. */
  readonly sizePrices: Readonly<Record<string, string>>
  /** The line's net, written in the currency ("1580.00"). */
  readonly net: string
  readonly adjustmentReason: string | null
  readonly marginPct: string | null
}

export interface QuoteVersionFacts {
  readonly revision: number
  readonly status: string
  readonly validUntil: string | null
  readonly firmOffer: boolean
  readonly promiseDate: string | null
  readonly paymentTerms: string | null
  readonly depositPct: string | null
  readonly depositKind: string | null
  readonly acceptanceMode: string | null
  readonly incoterm: string | null
  readonly incotermPlace: string | null
  readonly shipComplete: boolean
  readonly language: string
  readonly currency: string
  readonly termsVersion: string | null
  /** Written in the currency ("3190.00"). */
  readonly net: string
  readonly vat: string
  readonly gross: string
  readonly deposit: string | null
  readonly marginPct: string | null
  readonly lines: readonly QuoteLineFacts[]
}

// ---- writing -----------------------------------------------------------------------------------------------------------

const YES = '✓'
const flag = (value: boolean): Written => (value ? YES : null)
const num = (value: string | null): Written => (value === null ? null : decimalText(value))
const joined = (parts: readonly (string | null | undefined)[], by = ' · '): string | null => {
  const kept = parts.filter((part): part is string => typeof part === 'string' && part.length > 0)
  return kept.length === 0 ? null : kept.join(by)
}

function sameValue(a: Written, b: Written): boolean {
  if (a === null || b === null) return a === b
  if (a === b) return true
  try {
    return new Dec(a).eq(new Dec(b))
  } catch {
    return false
  }
}

type Kind = 'added' | 'removed' | 'changed' | 'unchanged'

function lineKind(line: CompareLine, fields: readonly CompareField[]): Kind {
  if (!line.before) return 'added'
  if (!line.after) return 'removed'
  for (const field of fields) if (!sameValue(line.before.fields[field.id] ?? null, line.after.fields[field.id] ?? null)) return 'changed'
  const sizes = new Set([...Object.keys(line.before.sizes ?? {}), ...Object.keys(line.after.sizes ?? {})])
  for (const size of sizes) if (!sameValue(line.before.sizes?.[size] ?? null, line.after.sizes?.[size] ?? null)) return 'changed'
  return 'unchanged'
}

function section(id: QuoteSectionId, label: string, fields: readonly CompareField[], sizes: readonly string[], lines: readonly CompareLine[], totals: readonly CompareTotal[]): CompareSection {
  const summary = { added: 0, removed: 0, changed: 0, unchanged: 0 }
  for (const line of lines) summary[lineKind(line, fields)]++
  return { id, label, fields, sizes, lines, totals, summary }
}

/** Pairs lines of two versions by what they sell, the n-th of one with the n-th of the other in line order; then the removed. */
function pairBy<T>(before: readonly T[], after: readonly T[], keyOf: (row: T) => string): [T | null, T | null][] {
  const queues = new Map<string, T[]>()
  for (const row of before) queues.set(keyOf(row), [...(queues.get(keyOf(row)) ?? []), row])
  const pairs: [T | null, T | null][] = after.map((row) => [queues.get(keyOf(row))?.shift() ?? null, row])
  for (const rest of queues.values()) for (const row of rest) pairs.push([row, null])
  return pairs
}

export const TERMS_FIELDS: readonly CompareField[] = [
  { id: 'validUntil', label: 'Valid until' },
  { id: 'firmOffer', label: 'Firm offer' },
  { id: 'promiseDate', label: 'Promise date' },
  { id: 'paymentTerms', label: 'Payment terms' },
  { id: 'deposit', label: 'Deposit' },
  { id: 'acceptanceMode', label: 'Acceptance' },
  { id: 'incoterm', label: 'Incoterm' },
  { id: 'shipComplete', label: 'Ship complete' },
  { id: 'language', label: 'Language' },
  { id: 'currency', label: 'Currency' },
  { id: 'termsVersion', label: 'Terms version' },
]

export const LINE_FIELDS: readonly CompareField[] = [
  { id: 'seq', label: 'Place' },
  { id: 'section', label: 'Section' },
  { id: 'description', label: 'Text' },
  { id: 'note', label: 'Note' },
  { id: 'revision', label: 'Revision' },
  { id: 'deliveries', label: 'Delivery schedule' },
  { id: 'options', label: 'Options' },
  { id: 'quantity', label: 'Times' },
]

export const PRICE_FIELDS: readonly CompareField[] = [
  { id: 'unitPrice', label: 'Unit price' },
  { id: 'listUnitPrice', label: 'List price' },
  { id: 'discountPct', label: 'Discount %' },
  { id: 'sizePrices', label: 'Price by size' },
  { id: 'net', label: 'Net' },
  { id: 'adjustmentReason', label: 'Reason' },
]

export const MARGIN_FIELDS: readonly CompareField[] = [{ id: 'marginPct', label: 'Margin %' }]

const termsFields = (version: QuoteVersionFacts): Record<string, Written> => ({
  validUntil: version.validUntil,
  firmOffer: flag(version.firmOffer),
  promiseDate: version.promiseDate,
  paymentTerms: version.paymentTerms,
  deposit: version.depositPct === null ? null : joined([`${decimalText(version.depositPct)} %`, version.depositKind], ' '),
  acceptanceMode: version.acceptanceMode,
  incoterm: version.incoterm === null ? null : joined([version.incoterm, version.incotermPlace], ' '),
  shipComplete: flag(version.shipComplete),
  language: version.language,
  currency: version.currency,
  termsVersion: version.termsVersion,
})

const lineKey = (line: QuoteLineFacts) => `${line.kind}:${line.styleId}:${line.colourwayId}:${line.feeKind ?? ''}`
const sizesText = (sizes: Readonly<Record<string, number>>): Record<string, string> => Object.fromEntries(Object.entries(sizes).map(([size, pieces]) => [size, String(pieces)]))
const sizePricesText = (prices: Readonly<Record<string, string>>): Written => joined(Object.entries(prices).map(([size, price]) => `${size} ${decimalText(price)}`), ', ')
const pieces = (lines: readonly QuoteLineFacts[]) => String(lines.reduce((total, line) => total + (line.kind === 'FEE' ? 0 : Object.values(line.sizes).reduce((a, b) => a + b, 0)), 0))

/** The sizes of the lines in the order they come (each line's own sizes in its style's order), each once. */
function sizeOrder(lines: readonly QuoteLineFacts[], range: (styleId: string) => readonly string[]): string[] {
  const order: string[] = []
  for (const line of lines) {
    const own = range(line.styleId)
    const sizes = Object.keys(line.sizes).sort((a, b) => (own.indexOf(a) < 0 ? 999 : own.indexOf(a)) - (own.indexOf(b) < 0 ? 999 : own.indexOf(b)))
    for (const size of sizes) if (!order.includes(size)) order.push(size)
  }
  return order
}

/** The two versions compared, section by section (`range`: a style's sizes in order). */
export function compareQuoteVersions(before: QuoteVersionFacts, after: QuoteVersionFacts, range: (styleId: string) => readonly string[] = () => []): CompareSection[] {
  const pairs = pairBy([...before.lines].sort((a, b) => a.seq - b.seq), [...after.lines].sort((a, b) => a.seq - b.seq), lineKey)
  const labelOf = (line: QuoteLineFacts) => (line.kind === 'FEE' ? `${line.seq} · ${line.feeKind ?? 'FEE'} · ${line.style}` : `${line.seq} · ${line.style} · ${line.colourway}`)
  const matched = <Side>(sideOf: (line: QuoteLineFacts) => Side) =>
    pairs.map(([from, to]) => {
      const line = (to ?? from)!
      return { id: line.id, label: labelOf(line), detail: line.section, before: from ? sideOf(from) : null, after: to ? sideOf(to) : null }
    })

  const lineSide = (line: QuoteLineFacts): CompareSide => ({
    fields: {
      seq: String(line.seq),
      section: line.section,
      description: line.description,
      note: line.note,
      revision: line.revision,
      deliveries: line.deliveries,
      options: line.options,
      quantity: line.kind === 'FEE' ? String(line.quantity) : null,
    },
    ...(line.kind === 'FEE' ? {} : { sizes: sizesText(line.sizes) }),
  })
  const priceSide = (line: QuoteLineFacts): CompareSide => ({
    fields: { unitPrice: num(line.unitPrice), listUnitPrice: num(line.listUnitPrice), discountPct: num(line.discountPct), sizePrices: sizePricesText(line.sizePrices), net: num(line.net), adjustmentReason: line.adjustmentReason },
  })
  const marginSide = (line: QuoteLineFacts): CompareSide => ({ fields: { marginPct: num(line.marginPct) } })

  return [
    section('terms', 'Terms & delivery', TERMS_FIELDS, [], [{ id: 'terms', label: 'Terms', detail: null, before: { fields: termsFields(before) }, after: { fields: termsFields(after) } }], []),
    section('lines', 'Lines', LINE_FIELDS, sizeOrder([...before.lines, ...after.lines], range), matched(lineSide), [
      { id: 'lines', label: 'Lines', before: String(before.lines.length), after: String(after.lines.length) },
      { id: 'pieces', label: 'Pieces', before: pieces(before.lines), after: pieces(after.lines) },
    ]),
    section('prices', 'Prices', PRICE_FIELDS, [], matched(priceSide), [
      { id: 'net', label: 'Net', before: before.net, after: after.net },
      { id: 'vat', label: 'VAT', before: before.vat, after: after.vat },
      { id: 'gross', label: 'Gross', before: before.gross, after: after.gross },
      { id: 'deposit', label: 'Deposit', before: before.deposit, after: after.deposit },
    ]),
    section('margin', 'Margin', MARGIN_FIELDS, [], matched(marginSide), [{ id: 'marginPct', label: 'Margin %', before: num(before.marginPct), after: num(after.marginPct) }]),
  ]
}

// ---- in words ----------------------------------------------------------------------------------------------------------

export interface Differs {
  readonly section: QuoteSectionId
  readonly label: string
  readonly added: number
  readonly removed: number
  readonly changed: number
}

/** The sections that differ (a line added, removed or changed, or a total that moved). */
export function differsOf(sections: readonly CompareSection[]): Differs[] {
  return sections.flatMap((entry) => {
    const totalsMoved = entry.totals.some((total) => !sameValue(total.before, total.after))
    const { added, removed, changed } = entry.summary
    return added + removed + changed > 0 || totalsMoved ? [{ section: entry.id, label: entry.label, added, removed, changed }] : []
  })
}

/** "Lines: 1 added, 2 changed · Terms & delivery: 1 changed", or "the same quote". */
export function differsWords(differs: readonly Differs[]): string {
  if (differs.length === 0) return 'the same quote'
  return differs
    .map((entry) => {
      const parts = [entry.added ? `${entry.added} added` : null, entry.removed ? `${entry.removed} removed` : null, entry.changed ? `${entry.changed} changed` : null].filter(Boolean)
      return `${entry.label}: ${parts.length > 0 ? parts.join(', ') : 'totals changed'}`
    })
    .join(' · ')
}

/**
 * A plain change note from the sections the reader may see ("Use as change note" fills the new version's "What changed"):
 * each line added, removed or changed with its changed fields (from → to) and sizes, then the totals that moved; at most
 * W1's change-note length.
 */
export function changeNoteOf(sections: readonly CompareSection[]): string {
  const parts: string[] = []
  for (const entry of sections) {
    const changes: string[] = []
    for (const line of entry.lines) {
      const kind = lineKind(line, entry.fields)
      if (kind === 'unchanged') continue
      if (kind === 'added' || kind === 'removed') {
        if (entry.id === 'lines') changes.push(`${line.label} ${kind}`)
        continue
      }
      const fields = entry.fields
        .filter((field) => !sameValue(line.before!.fields[field.id] ?? null, line.after!.fields[field.id] ?? null))
        .map((field) => `${field.label.toLowerCase()} ${line.before!.fields[field.id] ?? '—'} → ${line.after!.fields[field.id] ?? '—'}`)
      const sizeIds = [...new Set([...Object.keys(line.before!.sizes ?? {}), ...Object.keys(line.after!.sizes ?? {})])]
      const sizes = sizeIds.filter((size) => !sameValue(line.before!.sizes?.[size] ?? null, line.after!.sizes?.[size] ?? null)).map((size) => `${size} ${line.before!.sizes?.[size] ?? '—'} → ${line.after!.sizes?.[size] ?? '—'}`)
      const what = [...fields, ...sizes]
      if (what.length > 0) changes.push(entry.id === 'terms' ? what.join(', ') : `${line.label}: ${what.join(', ')}`)
    }
    for (const total of entry.totals) if (!sameValue(total.before, total.after) && entry.id !== 'lines') changes.push(`${total.label.toLowerCase()} ${total.before ?? '—'} → ${total.after ?? '—'}`)
    if (changes.length > 0) parts.push(`${entry.label}: ${changes.join('; ')}`)
  }
  const note = parts.length === 0 ? 'No change.' : parts.join('. ')
  return note.length <= MAX_TEXT.changeNote ? note : `${note.slice(0, MAX_TEXT.changeNote - 1)}…`
}
