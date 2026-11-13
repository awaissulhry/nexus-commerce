import { parsePrice } from '../../model'
import type { QuoteDetail, QuoteLine } from '../../api'
import type { ListPriceLine, PriceBody, PriceReason, PriceStep, PricingLine } from './api'

/**
 * Prices on screen (B-W2b-343; design quote › Price & margin "Pricing by line", the line drawer's "Cost breakdown and
 * Waterfall", the Lines blocks' "Discount %" and "Price by size"): the pure rules the screens draw — what each step of a
 * line's stored waterfall says (from its kind, reason code and figures; never the API's English), the body that changes
 * the net while keeping the stored start and discount (a manual change names its reason: SAL-175), why a price cannot
 * change here (in words), and the cost of a line from its revision's cost sheet. No fetching, no React: the tests hold them.
 */

export const PRICE_DEPTH_NS = 'sales-prices-depth'

/** A sentence of this step's catalogue (or the `sales` one when it names it) with its values. */
export interface Words {
  ns?: 'sales'
  key: string
  params?: Record<string, string | number>
}

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

const dec = (value: string | null | undefined): number | null => {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}
/** A figure to 6 places as text (no float noise): "-21", "4.25". */
const text6 = (value: number): string => String(Math.round(value * 1e6) / 1e6)

// ---- a stored waterfall, step by step -----------------------------------------------------------------------------------

export type StartKind = 'LIST' | 'SUGGESTED' | 'MANUAL'

/** The step a line's price started from (the first), or null without a waterfall. */
export function startOf(steps: readonly PriceStep[] | null | undefined): PriceStep | null {
  const first = steps?.[0]
  return first && (first.kind === 'LIST' || first.kind === 'SUGGESTED' || first.kind === 'MANUAL') ? first : null
}

/** The quantity break of the waterfall (its change and percent), or null. */
export const breakOf = (steps: readonly PriceStep[] | null | undefined): PriceStep | null => steps?.find((step) => step.kind === 'BREAK') ?? null

/** The discount of the waterfall (percent and reason), or null. */
export const discountOf = (steps: readonly PriceStep[] | null | undefined): PriceStep | null => steps?.find((step) => step.kind === 'DISCOUNT') ?? null

/** The manual change after the start (the net typed with its reason), or null. */
export const manualOf = (steps: readonly PriceStep[] | null | undefined): PriceStep | null => (steps ?? []).slice(1).find((step) => step.kind === 'MANUAL') ?? null

/** What the options add together (the OPTION steps' changes), or null when there is none. */
export function optionsOf(steps: readonly PriceStep[] | null | undefined): string | null {
  const options = (steps ?? []).filter((step) => step.kind === 'OPTION' && step.delta !== undefined)
  if (options.length === 0) return null
  return text6(options.reduce((sum, step) => sum + (dec(step.delta) ?? 0), 0))
}

/** Per size: what it adds beside the line's price (the SIZE_SURCHARGE steps). */
export function sizeSurchargesOf(steps: readonly PriceStep[] | null | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const step of steps ?? []) if (step.kind === 'SIZE_SURCHARGE') Object.assign(out, step.sizes ?? {})
  return out
}

/** The size codes in the order a size scale reads them (numbers up, then the letter run, then the rest). */
export function sizeOrder(sizes: readonly string[]): string[] {
  const letters = ['XXXS', '3XS', 'XXS', '2XS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '2XL', 'XXXL', '3XL', '4XL', '5XL']
  const rank = (size: string): [number, number, string] => {
    const upper = size.toUpperCase()
    if (/^\d+(\.\d+)?$/.test(upper)) return [0, Number(upper), upper]
    const at = letters.indexOf(upper)
    return at >= 0 ? [1, at, upper] : [2, 0, upper]
  }
  return [...new Set(sizes)].sort((a, b) => {
    const [ga, na, ta] = rank(a)
    const [gb, nb, tb] = rank(b)
    return ga - gb || na - nb || ta.localeCompare(tb)
  })
}

/** A step said in this screen's words: its kind, and what sets it apart (break from N pieces, a reason, an option). */
export interface StepWords {
  kind: PriceStep['kind']
  /** The step's name (a message key with its values). */
  name: Words
  /** A short line under the name: the reason, the note, the list, the break's pieces (null: none). */
  note: Words | null
  /** start / step / total, as the DS Waterfall draws it; null for a size surcharge (beside the running price). */
  bar: 'start' | 'step' | 'total' | null
  /** The opening value (start), the signed change (step) or the server's net (total). */
  amount: number | null
}

/**
 * Each step of a stored waterfall in words, ready for the DS Waterfall: the start (list, from the cost, typed by hand), the
 * break, each option, the discount, the manual change, then NET; a size surcharge is beside the running price (its own
 * list under the chart). `list` (GET …/list-prices of the line) names the list and the break's pieces when its ids match.
 */
export function stepWords(steps: readonly PriceStep[], list: ListPriceLine | null, reasonOf: (code: string) => string): StepWords[] {
  return steps.map((step): StepWords => {
    const reason = step.reasonCode ? reasonOf(step.reasonCode) : null
    const withNote = (base: Words | null): Words | null => (reason && step.note ? { key: 'step.reasonNote', params: { reason, note: step.note } } : reason ? { key: 'step.reason', params: { reason } } : base)
    switch (step.kind) {
      case 'LIST': {
        const same = list?.list && step.source?.id === list.list.entryId
        return {
          kind: step.kind,
          name: { key: 'step.LIST' },
          note: same && list?.list ? (list.list.revision !== null ? { key: 'step.listOf', params: { code: list.list.code, revision: list.list.revision } } : { key: 'step.listCode', params: { code: list.list.code } }) : null,
          bar: 'start',
          amount: dec(step.unitPrice),
        }
      }
      case 'SUGGESTED':
        return { kind: step.kind, name: { key: 'step.SUGGESTED' }, note: null, bar: 'start', amount: dec(step.unitPrice) }
      case 'MANUAL':
        if (step.delta === undefined) return { kind: step.kind, name: { key: 'step.MANUAL_START' }, note: withNote(null), bar: 'start', amount: dec(step.unitPrice) }
        return { kind: step.kind, name: { key: 'step.MANUAL' }, note: withNote(null), bar: 'step', amount: dec(step.delta) }
      case 'BREAK': {
        const same = list?.break && step.source?.id === list.break.breakId
        const pct = dec(step.pct)
        return {
          kind: step.kind,
          name: same && list?.break ? { key: 'step.BREAK_FROM', params: { count: list.break.minQuantity } } : { key: 'step.BREAK' },
          note: same && list?.break ? { key: 'step.breakPieces', params: { count: list.break.pieces } } : pct !== null ? { key: 'step.pct', params: { pct: String(Math.abs(pct)) } } : null,
          bar: 'step',
          amount: dec(step.delta),
        }
      }
      case 'OPTION':
        return { kind: step.kind, name: { key: 'step.OPTION' }, note: step.pct ? { key: 'step.pct', params: { pct: step.pct } } : null, bar: 'step', amount: dec(step.delta) }
      case 'DISCOUNT':
        return { kind: step.kind, name: { key: 'step.DISCOUNT', params: { pct: step.pct ?? '' } }, note: withNote(null), bar: 'step', amount: dec(step.delta) }
      case 'SIZE_SURCHARGE':
        return { kind: step.kind, name: { key: 'step.SIZE_SURCHARGE', params: { sizes: sizeOrder(Object.keys(step.sizes ?? {})).join(', ') } }, note: null, bar: null, amount: null }
      case 'NET':
        return { kind: step.kind, name: { key: 'step.NET' }, note: null, bar: 'total', amount: dec(step.unitPrice) }
    }
  })
}

// ---- writing a price ----------------------------------------------------------------------------------------------------

/**
 * The body that sets a line's net to `net` with its reason (SAL-175), keeping how the price was reached: the stored start
 * (a typed start with its own price and reason), the discount, the options; a line priced without a waterfall starts from
 * its list when one prices it, else the typed price becomes a typed start with that reason.
 */
export function netBody(line: Pick<PricingLine, 'steps' | 'fromList'>, net: string, reasonCode: string, note: string | null): PriceBody {
  const start = startOf(line.steps)
  const discount = discountOf(line.steps)
  const kept = discount?.pct ? { discount: { pct: discount.pct, ...(discount.reasonCode ? { reasonCode: discount.reasonCode } : {}) } } : {}
  const typed = { net: { unitPrice: net, reasonCode, ...(note ? { note } : {}) } }
  if (!start) return line.fromList ? { start: 'LIST', ...typed } : { start: 'MANUAL', startPrice: net, startReasonCode: reasonCode, ...(note ? { startNote: note } : {}) }
  if (start.kind === 'MANUAL') return { start: 'MANUAL', startPrice: start.unitPrice ?? net, startReasonCode: start.reasonCode ?? reasonCode, ...(start.note ? { startNote: start.note } : {}), ...kept, ...typed }
  return { start: start.kind as 'LIST' | 'SUGGESTED', ...kept, ...typed }
}

/** Why a line's price cannot be set here (Words), or null: a fee keeps its own price, a line no list or cost can start. */
export function lineHeld(line: Pick<PricingLine, 'kind' | 'fromList' | 'suggested'>, how: 'LIST' | 'SUGGESTED' | 'NET'): Words | null {
  if (line.kind !== 'SIZE_GRID') return { key: 'held.fee' }
  if (how === 'LIST' && !line.fromList) return { key: 'held.noList' }
  if (how === 'SUGGESTED' && (!line.suggested || line.suggested.unitPrice === null || line.suggested.unitPrice === undefined)) return { key: line.suggested?.basedOn ? 'held.noCost' : 'held.noCostSheet' }
  return null
}

export interface NetDraft {
  lineId: string
  /** The net as typed. */
  text: string
  reasonCode: string
  note: string
}

/** What stops "Save the new net" (Words, in order), checked as the API will: a price, a reason, its note when it asks one. */
export function netProblems(draft: NetDraft, current: string | null | undefined, reasons: readonly PriceReason[]): Words[] {
  const problems: Words[] = []
  const parsed = parsePrice(draft.text)
  if (parsed === null) problems.push({ key: 'manual.problem.price' })
  else if (current !== null && current !== undefined && Number(parsed) === Number(current)) problems.push({ key: 'manual.problem.same' })
  const reason = reasons.find((entry) => entry.code === draft.reasonCode)
  if (!reason) problems.push({ key: 'manual.problem.reason' })
  else if (reason.needsDetail && draft.note.trim() === '') problems.push({ key: 'manual.problem.note' })
  if (draft.note.trim().length > 500) problems.push({ key: 'manual.problem.noteLong' })
  return problems
}

/** A reason's words in the person's language (the list's own labels), else its code. */
export function reasonLabel(reasons: readonly PriceReason[], code: string, locale: 'it' | 'en'): string {
  const reason = reasons.find((entry) => entry.code === code)
  return reason ? (locale === 'it' ? reason.labelIt : reason.labelEn) : code
}

/** The flag of a line: under the floor, negative, or none (only with the margin grain). */
export function lineFlag(line: Pick<PricingLine, 'marginPct' | 'belowFloor'>): 'negative' | 'belowFloor' | null {
  const margin = dec(line.marginPct)
  if (margin !== null && margin < 0) return 'negative'
  return line.belowFloor ? 'belowFloor' : null
}

/** "Pricing by line" in the quote's line order, each with its quote line (style, colourway, cost) when the record has it. */
export function pricingRows(pricing: { lines: readonly PricingLine[] }, quote: Pick<QuoteDetail, 'lines'>): Array<{ pricing: PricingLine; line: QuoteLine | null }> {
  return [...pricing.lines].sort((a, b) => a.seq - b.seq).map((entry) => ({ pricing: entry, line: quote.lines.find((line) => line.id === entry.lineId) ?? null }))
}

/** A colour line's discount: its waterfall's (percent), else W1's own discount field; null without one. */
export function lineDiscount(line: Pick<QuoteLine, 'discountPct'>, pricing: Pick<PricingLine, 'steps'> | null): string | null {
  const step = discountOf(pricing?.steps)
  return step?.pct ?? line.discountPct ?? null
}

/** A colour line's own price per size where it differs from the line's (its size surcharge), in scale order. */
export function pricesBySize(line: Pick<QuoteLine, 'unitPrice' | 'sizes'>): Array<{ size: string; unitPrice: string }> {
  const base = dec(line.unitPrice)
  const own = line.sizes.filter((row) => row.unitPrice !== null && row.unitPrice !== undefined && dec(row.unitPrice) !== base).map((row) => ({ size: row.size, unitPrice: row.unitPrice! }))
  const order = sizeOrder(own.map((row) => row.size))
  return order.map((size) => own.find((row) => row.size === size)!)
}

// ---- the cost of a line from its revision's cost sheet -------------------------------------------------------------------

export interface CostBreakdown {
  /** Per piece, weighted by the line's pieces per size (the cost grain). */
  material: number
  labour: number
  overhead: number | null
  total: number | null
  /** Every cell of the line's sizes is complete. */
  complete: boolean
  /** The sheet's figure against the line's own cost (frozen when it was priced): + dearer now; null when unknown. */
  changed: number | null
}

/**
 * What one piece of the line costs on the revision's cost sheet today (W1 costing; design "How is this made?"): the cells
 * of the line's colourway, weighted by its pieces per size; the materials, labour and overhead, the total when every cell
 * is complete, and how far it is from the cost the quote keeps (`unitCost`, frozen when the line was priced).
 */
/** One cell of a cost sheet as the breakdown reads it (W1 costing's cellCostView: the cost grain's figures). */
export interface CostCell {
  colourwayId: string
  size: string
  complete: boolean
  material: { amount?: string | null }
  labour: { amount?: string | null }
  overhead: { amount?: string | null } | null
  total?: string | null
}

export function costBreakdown(sheet: { readonly cells: readonly CostCell[] }, line: Pick<QuoteLine, 'colourwayId' | 'sizes' | 'quantity' | 'unitCost'>): CostBreakdown | null {
  const rows = line.sizes.filter((row) => row.quantity > 0)
  const pieces = rows.reduce((sum, row) => sum + row.quantity, 0)
  if (pieces === 0) return null
  let material = 0
  let labour = 0
  let overhead = 0
  let total = 0
  let complete = true
  let anyOverhead = false
  for (const row of rows) {
    const cell = sheet.cells.find((entry) => entry.colourwayId === line.colourwayId && entry.size === row.size)
    if (!cell) return null
    material += (dec(cell.material.amount) ?? 0) * row.quantity
    labour += (dec(cell.labour.amount) ?? 0) * row.quantity
    if (cell.overhead) {
      anyOverhead = true
      overhead += (dec(cell.overhead.amount) ?? 0) * row.quantity
    }
    const cellTotal = dec(cell.total)
    if (!cell.complete || cellTotal === null) complete = false
    else total += cellTotal * row.quantity
  }
  const round = (value: number) => Math.round((value / pieces) * 100) / 100
  const own = dec(line.unitCost)
  const each = complete ? round(total) : null
  return { material: round(material), labour: round(labour), overhead: anyOverhead ? round(overhead) : null, total: each, complete, changed: each !== null && own !== null ? Math.round((each - own) * 100) / 100 : null }
}

/** The margin of a price over a cost, percent of the price (one decimal is the screen's), or null. */
export function marginOf(price: string | number | null | undefined, cost: number | null): number | null {
  const net = typeof price === 'number' ? price : dec(price)
  if (net === null || cost === null || net === 0) return null
  return ((net - cost) / net) * 100
}
