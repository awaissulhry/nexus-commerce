import type { Issue } from '../../core/errors'
import { Dec, HUNDRED, type Decimal } from '../../tax/decimal'
import { decimalText } from '../../product/units/units'
import type { Words } from '../../product/options/rules'
import type { WaterfallStep } from '../price-waterfall/rules'

/**
 * The configurator on a quote or order line (B-W2b-340; SAL-133, SAL-136, SAL-139, SAL-140, SAL-249; follow-ups CF1:01-03),
 * pure. apps/factory-api's modules/sales/configurator reads and writes through it; B-W2b-229's `checkConfiguration` (through
 * the API's checkStyleOptions) stays THE check of a choice, and B-W2b-280's …_sales_pricing_w2b_guards triggers the last word.
 *
 *   picks        what the line command takes: the values chosen (a free text when the value takes one), and with any of them
 *                a library colour (a panel's colour) OR a material and its colour (leather by article and colour), never both.
 *   surcharges   each chosen value's surcharge is FROZEN on the line as it is priced (QuoteLineOption.surchargeAmount, net, the
 *                document's currency): an amount as the value's PRICE effect says it, a percent taken once of the line's start
 *                price (percents never compound), both added when a value has both; an amount in another currency is refused
 *                in words, never converted. On an order, a value it already had keeps the surcharge it was accepted with.
 *   the price    a quote line is priced again through B-W2b-330's waterfall after the picks (its start, discount and manual
 *                change kept); `optionsPriced` says whether the line's waterfall still holds the options' surcharges. An order keeps
 *                the price it was accepted at: a choice that changes what the options add is held until the person keeps the
 *                accepted price or amends the order (`orderChangeHeld`).
 *   the order    options change while the order is CONFIRMED, IN_PRODUCTION or READY (the database's states) and no work order
 *                makes the line yet: the cells carry the values they were made with (WorkOrderSize.optionValueIds).
 *   line rules   CONFIGURATOR_LINE_CODES: the quote's send checks and the order's line checks (codes; the screens say them).
 *
 * Words are { it, en } where a person reads them; the API's other sentences are English.
 */

export const CONFIGURATOR_LIMITS = Object.freeze({
  /** Values chosen on one line (B-W2b-330's waterfall takes at most 40 priced options). */
  picks: 40,
  /** Artwork files on one line. */
  artwork: 20,
  /** Library colours and leather articles offered in one answer. */
  colours: 500,
  leathers: 200,
})

/** The send check codes (quotes) and line check codes (orders) of the configurator's rule. */
export const CONFIGURATOR_LINE_CODES = ['OPTIONS_REFUSED', 'OPTIONS_MISSING', 'OPTIONS_OUTSIDE_CERTIFICATE', 'OPTIONS_NOT_PRICED'] as const
export type ConfiguratorLineCode = (typeof CONFIGURATOR_LINE_CODES)[number]

/** The order states its lines' options change in (the …_sales_pricing_w2b_guards trigger's). */
export const ORDER_OPTION_STATES = ['CONFIRMED', 'IN_PRODUCTION', 'READY'] as const

/** The artwork a line takes: a PDF or a picture (never an SVG: it would be served as a page). */
export const ARTWORK_CONTENT_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] as const
export const artworkKindOf = (contentType: string): 'PHOTO' | 'DOCUMENT' => (contentType.toLowerCase().startsWith('image/') ? 'PHOTO' : 'DOCUMENT')
export const artworkTypeProblem = (contentType: string): string | null =>
  (ARTWORK_CONTENT_TYPES as readonly string[]).includes(contentType.trim().toLowerCase()) ? null : 'Artwork is a PDF or a picture (JPEG, PNG, WebP).'

const w = (it: string, en: string): Words => ({ it, en })

// ---- picks ---------------------------------------------------------------------------------------------------------------

/** One value chosen on a line, as the line command takes it. */
export interface LinePick {
  readonly valueId: string
  readonly text?: string | null | undefined
  /** A library colour picked with the value (a panel's colour). */
  readonly colourId?: string | null | undefined
  /** A material picked with the value (leather by article) and its colour. */
  readonly itemId?: string | null | undefined
  readonly itemColourId?: string | null | undefined
}

/** What is wrong with the picks' shape, before the check reads them (the check says the rest: offered, twice, text). */
export function picksProblems(picks: readonly LinePick[]): Issue[] {
  const issues: Issue[] = []
  if (picks.length > CONFIGURATOR_LIMITS.picks) issues.push({ path: 'body/picks', message: `A line takes at most ${CONFIGURATOR_LIMITS.picks} options.` })
  picks.forEach((pick, index) => {
    if (pick.colourId && pick.itemId) issues.push({ path: `body/picks/${index}`, message: 'A choice takes a library colour or a material, not both.' })
    if (pick.itemColourId && !pick.itemId) issues.push({ path: `body/picks/${index}/itemColourId`, message: "A material's colour is picked with its material." })
  })
  return issues
}

// ---- surcharges (SAL-136) ------------------------------------------------------------------------------------------------

/** A value's price effect as the library keeps it (OptionEffect PRICE): an amount in a currency, or a percent. */
export interface ValuePrice {
  readonly valueId: string
  readonly amount: string | null
  readonly currency: string | null
  readonly pct: string | null
}

/** A surcharge frozen on a line: the net amount per piece (never 0: null when none), and the percent it came from. */
export interface Frozen {
  readonly amount: string | null
  readonly pct: string | null
}

const SIX = 6
const exact = (value: Decimal): string => decimalText(value.toDecimalPlaces(SIX, Dec.ROUND_HALF_UP))

/**
 * Each chosen value's surcharge on a line priced from `base` (net, the line's start price) in `currency`: the value's amounts
 * of that currency plus its percents taken once of the base. Refused in words when an amount is in another currency.
 */
export function frozenSurcharges(valueIds: readonly string[], prices: readonly ValuePrice[], base: string, currency: string): { readonly ok: true; readonly rows: ReadonlyMap<string, Frozen> } | { readonly ok: false; readonly message: Words } {
  const rows = new Map<string, Frozen>()
  for (const valueId of valueIds) {
    const own = prices.filter((price) => price.valueId === valueId)
    const other = own.find((price) => price.amount !== null && price.currency !== null && price.currency !== currency)
    if (other) return { ok: false, message: w(`Un supplemento è in ${other.currency}, la riga in ${currency}: non si converte da solo.`, `A surcharge is in ${other.currency}, the line in ${currency}: it is not converted by itself.`) }
    let amount = new Dec(0)
    let pct: Decimal | null = null
    for (const price of own) {
      if (price.amount !== null) amount = amount.plus(price.amount)
      if (price.pct !== null) pct = (pct ?? new Dec(0)).plus(price.pct)
    }
    if (pct !== null) amount = amount.plus(new Dec(base).times(pct).dividedBy(HUNDRED))
    const total = amount.toDecimalPlaces(SIX, Dec.ROUND_HALF_UP)
    // The database keeps the percent only with the amount it gave, never 0, within -100..1000.
    const keptPct = pct !== null && !pct.isZero() && pct.gte(-100) && pct.lte(1000) && !total.isZero() ? decimalText(pct) : null
    rows.set(valueId, { amount: total.isZero() ? null : exact(total), pct: keptPct })
  }
  return { ok: true, rows }
}

/** On an order: a value it already had keeps the surcharge it was accepted with; a new value takes today's. */
export function orderSurcharges(current: readonly { readonly valueId: string; readonly amount: string | null; readonly pct: string | null }[], fresh: ReadonlyMap<string, Frozen>): Map<string, Frozen> {
  const out = new Map<string, Frozen>()
  for (const [valueId, frozen] of fresh) {
    const kept = current.find((row) => row.valueId === valueId)
    out.set(valueId, kept ? { amount: kept.amount, pct: kept.pct } : frozen)
  }
  return out
}

/** What a set of frozen surcharges adds a piece. */
export const surchargeTotal = (rows: Iterable<{ readonly amount: string | null }>): string => {
  let total = new Dec(0)
  for (const row of rows) if (row.amount !== null) total = total.plus(row.amount)
  return exact(total)
}

/** after − before, per piece. */
export const surchargeChange = (before: Iterable<{ readonly amount: string | null }>, after: Iterable<{ readonly amount: string | null }>): string => exact(new Dec(surchargeTotal(after)).minus(surchargeTotal(before)))

// ---- does the price hold the options? (SAL-133) ----------------------------------------------------------------------------

const key = (valueId: string, amount: string | null): string => `${valueId}:${amount === null ? '0' : exact(new Dec(amount))}`

/**
 * Whether a line's waterfall holds its options' surcharges: every option that adds something is an OPTION step of the stored
 * steps (read by the step's source: the option row it names, of this version or the one it was copied from) with the same
 * amount. A line whose options add nothing holds them by itself; a line with priced options and no waterfall does not.
 */
export function optionsPriced(steps: readonly WaterfallStep[] | null, sources: ReadonlyMap<string, { readonly valueId: string; readonly amount: string | null }>, current: readonly { readonly valueId: string; readonly amount: string | null }[]): boolean {
  const wanted = current.filter((row) => row.amount !== null && !new Dec(row.amount).isZero()).map((row) => key(row.valueId, row.amount)).sort()
  if (wanted.length === 0) return true
  if (steps === null) return false
  const taken = steps
    .filter((step) => step.kind === 'OPTION' && step.source !== undefined)
    .flatMap((step) => {
      const row = sources.get(step.source!.id)
      return row && row.amount !== null ? [key(row.valueId, row.amount)] : []
    })
    .sort()
  return taken.length === wanted.length && taken.every((entry, index) => entry === wanted[index])
}

/** The OPTION steps' sources (the option rows they name). */
export const optionSourceIds = (steps: readonly WaterfallStep[] | null): string[] => (steps ?? []).flatMap((step) => (step.kind === 'OPTION' && step.source ? [step.source.id] : []))

/** Why a quote line is not priced again after its picks (null: it is). */
export const REPRICE_HELD = ['NO_START', 'NOT_SIZE_GRID', 'FEE'] as const
export type RepriceHeld = (typeof REPRICE_HELD)[number]

/**
 * The manual change of a stored waterfall (a MANUAL step after the start: its amount, reason and words), kept as an AMOUNT
 * when the line is priced again: the options move the price, the person's change stays the change it was (a rounding of
 * -0.25 stays -0.25 whatever the options add).
 */
export function manualChangeOf(steps: readonly WaterfallStep[] | null): { readonly delta: string; readonly reasonCode: string; readonly note: string | null } | null {
  if (!steps) return null
  const manual = [...steps.slice(1)].reverse().find((step) => step.kind === 'MANUAL' && step.delta !== undefined && step.reasonCode !== undefined)
  return manual ? { delta: manual.delta!, reasonCode: manual.reasonCode!, note: manual.note ?? null } : null
}

// ---- margin (SAL-133) ----------------------------------------------------------------------------------------------------

/** The margin of a net unit price over a unit cost, percent of the net, 2 places; null without a cost or a price above 0. */
export function marginPctOf(net: string | null, cost: string | null): string | null {
  if (net === null || cost === null) return null
  const price = new Dec(net)
  if (price.lte(0)) return null
  return decimalText(price.minus(cost).times(HUNDRED).dividedBy(price).toDecimalPlaces(2, Dec.ROUND_HALF_UP))
}

/** A price on the document's basis back to its net (a consumer's quote is priced VAT included at `rate`). */
export function netOfBasis(price: string, basis: 'NET' | 'GROSS', rate: string | null): string {
  if (basis === 'NET' || rate === null) return exact(new Dec(price))
  return exact(new Dec(price).times(HUNDRED).dividedBy(HUNDRED.plus(rate)))
}

// ---- the order (SAL-133: the picks travel; an order keeps its accepted price) ----------------------------------------------

/** Why an order line's options cannot change now, in words (null: they can). */
export function orderOptionsRefusal(status: string, workOrderCells: number): Words | null {
  if (!(ORDER_OPTION_STATES as readonly string[]).includes(status)) {
    return w(`L'ordine è ${status}: le opzioni delle righe cambiano solo mentre è confermato, in produzione o pronto.`, `The order is ${status}: its lines' options change only while it is confirmed, in production or ready.`)
  }
  if (workOrderCells > 0) {
    return w(
      "Gli ordini di lavoro di questa riga sono già fatti con le sue opzioni: cambiale con una modifica dell'ordine e rifai gli ordini di lavoro.",
      'Work orders already make this line with its options: change them through an order change and make the work orders again.',
    )
  }
  return null
}

/**
 * A choice on an order that changes what the options add a piece is held until the person decides: keep the price the
 * customer accepted (the surcharge given), or amend the order to charge it (W2a's amendment asks the customer's yes).
 */
export function orderChangeHeld(change: string, keepPrice: boolean): boolean {
  return !new Dec(change).isZero() && !keepPrice
}

// ---- line checks (codes; the API's message in English) ---------------------------------------------------------------------

/** A line check finding's severity per document: an order only warns (its customer accepted it; it is made as accepted). */
export function findingSeverity(code: ConfiguratorLineCode, document: 'QUOTE' | 'ORDER'): 'BLOCKS' | 'WARNING' {
  if (document === 'ORDER') return 'WARNING'
  return code === 'OPTIONS_REFUSED' || code === 'OPTIONS_MISSING' ? 'BLOCKS' : 'WARNING'
}

/** The English sentence of a finding (the screens say the code in their own words). */
export function findingMessage(code: ConfiguratorLineCode, seq: number, detail: string | null): string {
  switch (code) {
    case 'OPTIONS_REFUSED':
      return `Line ${seq}: its options no longer pass their rules${detail ? `: ${detail}` : ''}.`
    case 'OPTIONS_MISSING':
      return `Line ${seq}: the style asks options nobody chose${detail ? `: ${detail}` : ''}.`
    case 'OPTIONS_OUTSIDE_CERTIFICATE':
      return `Line ${seq}: an option takes the garment outside its certificate${detail ? `: ${detail}` : ''}.`
    case 'OPTIONS_NOT_PRICED':
      return `Line ${seq}: its options add to the price, but its price does not hold them: price the line again.`
  }
}
