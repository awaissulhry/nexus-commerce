import type { Locale } from '../../../../lib/i18n/locales'
import { isApiError, issuePath } from '../../../../lib/api/errors'
import { parsePrice } from '../../quotes/model'
import { amountText, writeProblem, type Phrase } from '../model'
import type { BrandPriceRow, BrandPriceRowBody, OfficeSource, PriceCheck, SaveBrandPricesBody } from './api'

/**
 * F-CP-114 (customer page plan C2d, C3; design 11-money §3.3; review A3; lead pick "one editor, two doors") — the rules of the ONE
 * customer's-price editor, pure: what the window starts from (the stored rows), what Save sends (the changed rows at the versions
 * read, the cleared ones removed), when Save is held and why (in words), and a refused save in words (never the API's English).
 *
 * Per line the person types the customer's "Unit price without VAT" or its "Line total"; one optional "Customer's total for the whole
 * order"; where it comes from (From the customer's PO · Typed by us), the PO file (this order's files) and a note go with the prices
 * typed now. A price cleared is removed. A row the customer gave in its portal keeps its source until someone types over it.
 */

export type PriceAs = 'unit' | 'line'

/** One line as typed: the customer's unit price or its line total, as the person writes it ("92,50" or "92.50"); '' = none. */
export interface LineDraft {
  readonly as: PriceAs
  readonly value: string
}

export interface PriceDraft {
  /** By the order line's id. */
  readonly lines: Readonly<Record<string, LineDraft>>
  /** The customer's total for the whole order ('' = none). */
  readonly total: string
  readonly source: OfficeSource
  /** The PO file ('' = none; only with From the customer's PO). */
  readonly fileId: string
  readonly note: string
}

/** The key of the total row among the line ids (the problems and a refusal name it). */
export const TOTAL_KEY = 'total'
/** The key of the PO file's problem. */
export const FILE_KEY = 'file'

const CLOSED = ['CLOSED', 'CANCELLED']
/** A closed or cancelled order keeps its prices (the API refuses a change; the window says so before the click). */
export const isClosedOrder = (status: string): boolean => CLOSED.includes(status)

/** A decimal string of the API as the person types it ("92.5" → "92,5" in Italian). */
export const decimalText = (value: string, locale: Locale): string => (locale === 'it' ? value.replace('.', ',') : value)

/** Minor units from typed text ("1.234,56", "1234.56", "0"); null when it is not an amount of at most two decimals. */
export function minorOfTyped(text: string): number | null {
  const price = parsePrice(text)
  if (price === null) return null
  const [whole = '0', fraction = ''] = price.split('.')
  if (fraction.length > 2) return null
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
}

/** A decimal string without its padding ("092.50" → "92.5"): two prices compare equal when they are the same number. */
const canon = (value: string): string => {
  const [whole = '0', fraction = ''] = value.split('.')
  const kept = fraction.replace(/0+$/, '')
  return `${whole.replace(/^0+(?=\d)/, '')}${kept ? `.${kept}` : ''}`
}

const lineDraftOf = (row: BrandPriceRow | null, locale: Locale): LineDraft =>
  row?.unitPrice != null ? { as: 'unit', value: decimalText(row.unitPrice, locale) } : row?.netAmount != null ? { as: 'line', value: amountText(row.netAmount, locale) } : { as: 'unit', value: '' }

/** The row the window's source, PO file and note start from: the order total's, else the first line's typed by us (never the portal's). */
function metaRowOf(check: PriceCheck): BrandPriceRow | null {
  const rows = [check.total.row, ...check.lines.map((line) => line.row)]
  return rows.find((row): row is BrandPriceRow => !!row && row.source !== 'PORTAL') ?? null
}

/** What the window starts from: the stored rows as the person would type them. */
export function draftOf(check: PriceCheck, locale: Locale): PriceDraft {
  const meta = metaRowOf(check)
  const total = check.total.row?.netAmount
  return {
    lines: Object.fromEntries(check.lines.map((line) => [line.lineId, lineDraftOf(line.row, locale)])),
    total: total === null || total === undefined ? '' : amountText(total, locale),
    source: meta?.source === 'OFFICE' ? 'OFFICE' : 'CUSTOMER_PO',
    fileId: meta?.sourceFile?.id ?? '',
    note: meta?.note ?? '',
  }
}

type Price = { readonly unitPrice: string } | { readonly netAmount: number }

const samePrice = (row: BrandPriceRow, price: Price): boolean =>
  'unitPrice' in price ? row.unitPrice !== null && canon(row.unitPrice) === canon(price.unitPrice) : row.unitPrice === null && row.netAmount === price.netAmount

interface Meta {
  readonly source: OfficeSource
  readonly sourceFileId: string | null
  readonly note: string | null
}
const metaOf = (draft: Pick<PriceDraft, 'source' | 'fileId' | 'note'>): Meta => ({ source: draft.source, sourceFileId: draft.source === 'CUSTOMER_PO' && draft.fileId ? draft.fileId : null, note: draft.note.trim() || null })
const sameMeta = (a: Meta, b: Meta): boolean => a.source === b.source && a.sourceFileId === b.sourceFileId && a.note === b.note
const rowMeta = (row: BrandPriceRow): Meta => ({ source: row.source === 'OFFICE' ? 'OFFICE' : 'CUSTOMER_PO', sourceFileId: row.sourceFile?.id ?? null, note: row.note })

/** What Save does: send these rows (their keys in body order, for a refusal by place), nothing, or not yet (problems by key). */
export type PricePlan =
  | { readonly kind: 'save'; readonly body: SaveBrandPricesBody; readonly keys: readonly string[] }
  | { readonly kind: 'nothing' }
  | { readonly kind: 'problems'; readonly problems: Readonly<Record<string, Phrase>> }

/**
 * The plan of a Save: every line (and the order's total) whose price changed — typed new, typed over, or cleared (removed) — with the
 * version read for a row that exists; where it came from, the PO file and the note go with them. When only those three changed, they
 * go on the prices we typed before (never on the customer's own portal prices). A typed value that is no amount is a problem at its line.
 */
export function pricePlanOf(check: PriceCheck, draft: PriceDraft): PricePlan {
  const problems: Record<string, Phrase> = {}
  const typed: { key: string; lineId: string | null; price: Price; stored: BrandPriceRow | null }[] = []
  const remove: { id: string; version: number }[] = []
  const take = (key: string, lineId: string | null, as: PriceAs, value: string, stored: BrandPriceRow | null) => {
    if (value.trim() === '') {
      if (stored) remove.push({ id: stored.id, version: stored.version })
      return
    }
    const unit = as === 'unit' ? parsePrice(value) : null
    const minor = as === 'line' ? minorOfTyped(value) : null
    if (unit === null && minor === null) {
      problems[key] = { key: 'priceCheck.notAmount' }
      return
    }
    typed.push({ key, lineId, price: unit !== null ? { unitPrice: unit } : { netAmount: minor! }, stored })
  }
  for (const line of check.lines) {
    const entry = draft.lines[line.lineId] ?? { as: 'unit' as const, value: '' }
    take(line.lineId, line.lineId, entry.as, entry.value, line.row)
  }
  take(TOTAL_KEY, null, 'line', draft.total, check.total.row)
  if (Object.keys(problems).length > 0) return { kind: 'problems', problems }

  const meta = metaOf(draft)
  let send = typed.filter((row) => !row.stored || !samePrice(row.stored, row.price))
  if (send.length === 0 && remove.length === 0 && !sameMeta(meta, metaOf(draftOf(check, 'en')))) {
    // Only where it came from, the PO file or the note changed: they go on the prices we typed (the customer's own keep theirs).
    send = typed.filter((row) => row.stored && row.stored.source !== 'PORTAL' && !sameMeta(rowMeta(row.stored), meta))
  }
  if (send.length === 0 && remove.length === 0) return { kind: 'nothing' }
  const rows: BrandPriceRowBody[] = send.map((row) => ({ lineId: row.lineId, ...row.price, ...meta, ...(row.stored ? { version: row.stored.version } : {}) }))
  return { kind: 'save', body: { currency: check.currency, rows, remove }, keys: send.map((row) => row.key) }
}

/** Why Save is held now, in words (null: it saves): saving, a closed order, no right, a value to fix, nothing changed. */
export function saveHeldOf(check: Pick<PriceCheck, 'status' | 'mayWrite'>, plan: PricePlan, busy: boolean): Phrase | null {
  if (busy) return { key: 'priceCheck.saving' }
  if (isClosedOrder(check.status)) return { key: 'priceCheck.closed' }
  if (!check.mayWrite.allowed) return { key: 'held.noManage' }
  if (plan.kind === 'problems') return { key: 'priceCheck.fixFirst' }
  if (plan.kind === 'nothing') return { key: 'priceCheck.nothing' }
  return null
}

/** A refused save in words: what to say, whether the window reads the prices again, and the fields it names. */
export interface SaveRefusal {
  readonly words: Phrase
  /** Read the check again (a 409: "Here they are now"; the order closed meanwhile). */
  readonly reread: boolean
  readonly fields: Readonly<Record<string, Phrase>>
}

/**
 * A refused save: 409 — someone changed these prices meanwhile (read again, "Here they are now"); 400 by place — the currency, a
 * closed order, a line's price or the PO file (at their field, by the body's order); any other refusal the orders' own words.
 */
export function saveRefusalOf(error: unknown, keys: readonly string[], currency: string): SaveRefusal {
  if (isApiError(error) && error.kind === 'conflict') return { words: { key: 'priceCheck.stale' }, reread: true, fields: {} }
  if (isApiError(error) && error.kind === 'invalid') {
    const fields: Record<string, Phrase> = {}
    let words: Phrase = { key: 'problem.write.invalid' }
    for (const issue of error.issues) {
      const path = issuePath(issue)
      const parts = path.split(/[./]/)
      if (path === 'body') words = { key: 'priceCheck.closed' }
      else if (parts.includes('currency')) words = { key: 'priceCheck.currency', params: { currency } }
      else if (parts[1] === 'rows') {
        if (parts[3] === 'sourceFileId') fields[FILE_KEY] = { key: 'priceCheck.notAFile' }
        else if (keys[Number(parts[2])] !== undefined) fields[keys[Number(parts[2])]!] = { key: 'priceCheck.refusedLine' }
      }
    }
    return { words, reread: words.key === 'priceCheck.closed', fields }
  }
  const problem = writeProblem(error)
  return { words: problem.params ? { key: problem.key, params: problem.params } : { key: problem.key }, reread: problem.reload, fields: {} }
}

/** Where a stored customer's price came from, in words (the customer's own portal, its PO, or typed by us). */
export const sourceWords = (source: BrandPriceRow['source']): string => (source === 'PORTAL' ? 'priceCheck.fromPortal' : source === 'CUSTOMER_PO' ? 'priceCheck.fromPo' : 'priceCheck.typedByUs')
