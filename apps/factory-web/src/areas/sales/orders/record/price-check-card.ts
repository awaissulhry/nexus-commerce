import { isApiError, issuePath } from '../../../../lib/api/errors'
import type { BrandPriceRow, PriceCheck, PriceCheckLine } from '../price-check/api'
import { isClosedOrder } from '../price-check/model'
import { writeProblem, type OrderAbilities, type Phrase } from '../model'

/**
 * F-CP-142 (customer page plan C2d, C3; design 11-money §3.3, picture 21; review A3) — the order page's Money › "Price check" card,
 * pure: what it shows for whom and when it reads. The card sits after the Totals card; it compares, line by line and for the order,
 * our price with the customer's (without VAT, the order's currency, exact to the cent: the API's check, B-CP-017), says where the
 * customer's price came from, and opens the ONE customer's-price window (so/price-check, F-CP-114 — the Work tab's door is the other).
 *
 *   the money wall   without the price grain the card is ONE line of words ("Shown to people who see prices"), no table and no call
 *                    (the API would answer 403); as Sales worker / as Production manager the same
 *   the brand wall   the order's own customer only: the API reads the order's party (a person limited to some customers reads only
 *                    theirs; 404 like a wrong id otherwise)
 *
 * States: loading (skeleton rows) · empty ("No customer price yet" + Customer's price… as the primary) · filled (the table, the
 * sources) · the take-over row when a request of this order named the customer's prices · closed or cancelled (the button held in
 * words) · error (Try again) · stale (a take-over found the prices changed: read again, "Here they are now"). Live:
 * `sales_order.brand_price_changed` of this order reads the card again; its rows keep their place (the API's line order).
 */

/** The audit's record type of the customer's prices (B-CP-025: one history per order, read through the order). */
export const HISTORY_TYPE = 'OrderBrandPrice'
/** The live event that reads the card again (B-CP-017, `money.price`, office only). */
export const BRAND_PRICE_EVENT = 'sales_order.brand_price_changed'

/** The card is read only by a price holder, while Money shows (else held in words: no call). */
export const asksPriceCheck = (can: Pick<OrderAbilities, 'price'>, tab: string): boolean => can.price && tab === 'money'

/** The card's read: held (no price grain), reading, failed, or the check (with "Here they are now" after a refused take-over). */
export type PriceCheckRead =
  | { readonly state: 'held' }
  | { readonly state: 'loading' }
  | { readonly state: 'failed'; readonly problem: string }
  | { readonly state: 'ready'; readonly check: PriceCheck; readonly stale: boolean; readonly taking: boolean; readonly problem: Phrase | null }

export interface PriceCheckCardModel {
  readonly read: PriceCheckRead
  /** audit.read: History › opens the audit filtered to this order's customer prices (else held in words). */
  readonly canHistory: boolean
}

/** "Change our price ›" is the order's own Edit mode (one edit path, F-OP-106): held while it is open, else with the order's reason. */
export function changeOursHeldOf(amending: boolean, held: Phrase | null): Phrase | null {
  return amending ? { key: 'held.amending' } : held
}

export interface PriceCheckCardActions {
  /** Customer's price… — the ONE window (F-CP-114), read and saved by its own hook. */
  onEdit?: () => void
  /** Take them over (the request's prices, source Portal, lines without a customer's price only). */
  onTakeOver?: (requestId: string) => void
  onRetry?: () => void
}

/** Nothing of the customer's yet: no line and no order total has a stored row (the take-over row may still offer some). */
export const isEmptyCheck = (check: Pick<PriceCheck, 'lines' | 'total'>): boolean => check.total.row === null && check.lines.every((line) => line.row === null)

/** Why Customer's price… waits, in words (null: it opens): a closed or cancelled order keeps its prices; no right to change orders. */
export function editHeldOf(check: Pick<PriceCheck, 'status' | 'mayWrite'>): Phrase | null {
  if (isClosedOrder(check.status)) return { key: 'priceCheck.closed' }
  if (!check.mayWrite.allowed) return { key: 'held.noManage' }
  return null
}

/** The order's pieces (the Total row): the lines' own. */
export const totalPiecesOf = (check: Pick<PriceCheck, 'lines'>): number => check.lines.reduce((sum, line) => sum + line.pieces, 0)

/** The customer's unit price of a line (a decimal string): its unit price row; a line total has none (null). */
export const customerUnitOf = (line: Pick<PriceCheckLine, 'row'>): string | null => line.row?.unitPrice ?? null

/** One "where it came from" line: the source, the lines it covers (by their numbers) or the order's total, its PO file, who typed it, when, the note. */
export interface SourceLine {
  readonly key: string
  readonly source: BrandPriceRow['source']
  /** The lines' numbers (seq) this source gave; empty with `total`. */
  readonly seqs: readonly number[]
  /** The order's total row is among them. */
  readonly total: boolean
  readonly file: { readonly id: string; readonly name: string } | null
  readonly by: string | null
  /** The newest time among them. */
  readonly at: string
  readonly note: string | null
}

/** The stored rows grouped by where they came from (same source, file, person and note), in the lines' order, the total last. */
export function sourceLinesOf(check: Pick<PriceCheck, 'lines' | 'total'>): SourceLine[] {
  const groups = new Map<string, { source: BrandPriceRow['source']; seqs: number[]; total: boolean; file: SourceLine['file']; by: string | null; at: string; note: string | null }>()
  const take = (row: BrandPriceRow, seq: number | null) => {
    const key = [row.source, row.sourceFile?.id ?? '', row.enteredBy?.name ?? '', row.note ?? ''].join('|')
    const group = groups.get(key) ?? { source: row.source, seqs: [], total: false, file: row.sourceFile, by: row.enteredBy?.name ?? null, at: row.enteredAt, note: row.note }
    if (seq === null) group.total = true
    else group.seqs.push(seq)
    if (row.enteredAt > group.at) group.at = row.enteredAt
    groups.set(key, group)
  }
  for (const line of [...check.lines].sort((a, b) => a.seq - b.seq)) if (line.row) take(line.row, line.seq)
  if (check.total.row) take(check.total.row, null)
  return [...groups.entries()].map(([key, group]) => ({ key, ...group }))
}

/** "1–2, 4": the lines' numbers, runs folded. */
export function seqList(seqs: readonly number[]): string {
  const sorted = [...new Set(seqs)].sort((a, b) => a - b)
  const parts: string[] = []
  for (let i = 0; i < sorted.length; i++) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++
    parts.push(j > i ? `${sorted[i]}–${sorted[j]}` : String(sorted[i]))
    i = j
  }
  return parts.join(', ')
}

/** The address of History ›: the audit filtered to this order's customer prices (B-CP-025: the audit record id is the order). */
export function historyHref(prefix: string, orderId: string): string {
  const query = new URLSearchParams({ type: HISTORY_TYPE, record: orderId })
  return `${prefix}/admin/audit?${query.toString()}`
}

/**
 * A refused take-over (POST …/brand-prices/from-request): 409 — the prices were taken or typed meanwhile ("Someone changed these
 * prices meanwhile. Here they are now."); 400 on the body — the order closed meanwhile; any other 400 — not this order's request any
 * more; each reads the card again. Anything else: the orders' own words, the card kept.
 */
export function takeOverRefusalOf(error: unknown): { readonly reread: boolean; readonly words: Phrase } {
  if (isApiError(error) && error.kind === 'conflict') return { reread: true, words: { key: 'priceCheck.stale' } }
  if (isApiError(error) && error.kind === 'invalid') return { reread: true, words: { key: error.issues.some((issue) => issuePath(issue) === 'body') ? 'priceCheck.closed' : 'priceCheck.stale' } }
  const problem = writeProblem(error)
  return { reread: problem.reload, words: problem.params ? { key: problem.key, params: problem.params } : { key: problem.key } }
}
