import type { Issue } from '../../core/errors'
import { fitsDecimal, minorPlaces, UNIT_PRICE, type CurrencyCode } from '../../core/money'
import { decimalText } from '../../product/units/units'
import { Dec, HUNDRED, ZERO, parseDecimal, type Decimal } from '../../tax/decimal'
import { SALES_FEE_KINDS, type SalesFeeKind } from '../quotes/quotes'

/**
 * The price of a line (B-W2b-330; SAL-173, SAL-174, SAL-175, SAL-181, SAL-189), pure.
 *
 *   SAL-173  a suggested price from the line's cost (the style revision's cost sheet, W1 costing; W2b-6's cost sheets
 *            replace the source behind the same read) and the margin it should earn: net = cost ÷ (1 − margin), rounded
 *            UP to the currency's minor unit so the margin is never under the one asked
 *   SAL-174  the waterfall (factory-db QuoteLine.priceSteps / SalesOrderLine.priceSteps): a start (LIST, SUGGESTED or
 *            MANUAL), the changes (BREAK, OPTION, DISCOUNT, MANUAL; SIZE_SURCHARGE beside the running price) and NET,
 *            each with its source; `buildWaterfall` makes it, `stepsProblem` checks it as the database does
 *            (`factory_price_steps_problem`), `explainWaterfall` says it in words ("why this price?")
 *   SAL-175  a manual net names its reason code (the PRICE_ADJUSTMENT list; the API checks it is ACTIVE)
 *   SAL-181  a fee line (development, sample, tooling): its price and pieces checked here
 *   SAL-189  the margin floor of the person quoting: the lowest floor of their roles listed in the sales settings
 *            (SalesSettings.marginFloorByRole), else the company's floor (`floorFor`)
 *
 * Every price is a decimal string on the document's price basis (a consumer's quote VAT included), at most 6 places;
 * a delta is the difference of two such figures, so the steps always add up exactly.
 */

// ---- the waterfall ----------------------------------------------------------------------------------------------------

export const WATERFALL_KINDS = ['LIST', 'SUGGESTED', 'BREAK', 'SIZE_SURCHARGE', 'OPTION', 'DISCOUNT', 'MANUAL', 'NET'] as const
export type WaterfallKind = (typeof WATERFALL_KINDS)[number]
/** How a line's price starts: the list price, the price suggested from its cost, or a price typed with its reason. */
export const START_KINDS = ['LIST', 'SUGGESTED', 'MANUAL'] as const
export type StartKind = (typeof START_KINDS)[number]

export interface StepSource {
  readonly type: string
  readonly id: string
}

/** One step, the shape the database checks (unknown fields are refused there). */
export interface WaterfallStep {
  readonly kind: WaterfallKind
  readonly unitPrice?: string
  readonly delta?: string
  readonly pct?: string
  readonly sizes?: Readonly<Record<string, string>>
  readonly source?: StepSource
  readonly reasonCode?: string
  readonly label?: string
  readonly note?: string
}

export const WATERFALL_LIMITS = { steps: 50, label: 200, note: 500, sizes: 100, options: 40 } as const

const STEP_FIELDS = ['kind', 'unitPrice', 'delta', 'pct', 'sizes', 'source', 'reasonCode', 'label', 'note'] as const
const DECIMAL6 = /^-?[0-9]{1,12}(\.[0-9]{1,6})?$/
const DECIMAL4 = /^-?[0-9]{1,12}(\.[0-9]{1,4})?$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const MODEL_NAME = /^[A-Z][A-Za-z0-9]{0,62}$/
export const REASON_CODE = /^[A-Z][A-Z0-9_]{1,39}$/
const SIZE_CODE = /^[^\s\p{Cc}]{1,40}$/u
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/
// eslint-disable-next-line no-control-regex
const CONTROL_BUT_LINES = /[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/

const wordsOk = (value: unknown, longest: number, lines: boolean): boolean =>
  typeof value === 'string' && value.trim() !== '' && [...value].length <= longest && !(lines ? CONTROL_BUT_LINES : CONTROL).test(value)

const decimal6 = (value: unknown): Decimal | null => (typeof value === 'string' && DECIMAL6.test(value) ? new Dec(value) : null)
const decimal4 = (value: unknown): Decimal | null => (typeof value === 'string' && DECIMAL4.test(value) ? new Dec(value) : null)
const sourceOk = (value: unknown): boolean => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value).sort()
  const source = value as Record<string, unknown>
  return keys.length === 2 && keys[0] === 'id' && keys[1] === 'type' && typeof source.type === 'string' && MODEL_NAME.test(source.type) && typeof source.id === 'string' && UUID.test(source.id)
}

/**
 * What is wrong with a waterfall for a line priced `unitPrice` (and `listPrice`, a quote line's list price), in words, or
 * null: the database's `factory_price_steps_problem`, word for word in what it accepts, so the API refuses first in
 * words and the database never has to.
 */
export function stepsProblem(steps: unknown, unitPrice: string | null, listPrice: string | null): string | null {
  if (!Array.isArray(steps)) return 'the waterfall is a list of steps'
  const n = steps.length
  if (n < 2 || n > WATERFALL_LIMITS.steps) return 'the waterfall has 2 to 50 steps: a start, the changes, and NET'
  let running = ZERO
  for (let index = 0; index < n; index++) {
    const i = index + 1
    const step = steps[index] as Record<string, unknown>
    if (!step || typeof step !== 'object' || Array.isArray(step)) return `step ${i} is not an object`
    if (Object.keys(step).some((key) => !(STEP_FIELDS as readonly string[]).includes(key))) return `step ${i} has a field the waterfall does not know (it knows ${STEP_FIELDS.join(', ')})`
    const kind = typeof step.kind === 'string' && (WATERFALL_KINDS as readonly string[]).includes(step.kind) ? (step.kind as WaterfallKind) : null
    if (kind === null) return `step ${i} has no kind of the waterfall (${WATERFALL_KINDS.join(', ')})`
    if ('label' in step && !wordsOk(step.label, WATERFALL_LIMITS.label, false)) return `step ${i} (${kind}): its label is one line of 1 to 200 characters`
    if ('note' in step && !wordsOk(step.note, WATERFALL_LIMITS.note, true)) return `step ${i} (${kind}): its note is 1 to 500 characters`
    if ('source' in step && !sourceOk(step.source)) return `step ${i} (${kind}): its source is { "type": a record type, "id": a UUID }`
    if ((['LIST', 'SUGGESTED', 'BREAK', 'SIZE_SURCHARGE', 'OPTION'].includes(kind) && !('source' in step)) || (['MANUAL', 'NET'].includes(kind) && 'source' in step)) {
      return `step ${i} (${kind}): a list price, a suggested price, a break, a size surcharge and an option name their source; a manual change and NET name none`
    }
    if ('reasonCode' in step && (!['MANUAL', 'DISCOUNT'].includes(kind) || typeof step.reasonCode !== 'string' || !REASON_CODE.test(step.reasonCode))) {
      return `step ${i} (${kind}): a reason code (capitals, digits and _) belongs to a manual change or a discount`
    }
    if (kind === 'MANUAL' && !('reasonCode' in step)) return `step ${i}: a manual change of the price names its reason code (SAL-175)`
    if ('sizes' in step && kind !== 'SIZE_SURCHARGE') return `step ${i} (${kind}): sizes belong to a size surcharge`
    if ('pct' in step) {
      const pct = decimal4(step.pct)
      if (!['BREAK', 'OPTION', 'DISCOUNT'].includes(kind) || pct === null || pct.isZero() || pct.lt(-100) || pct.gt(1000) || (kind === 'DISCOUNT' && (pct.lte(0) || pct.gt(100)))) {
        return `step ${i} (${kind}): a percent belongs to a break, an option (-100 to 1000, never 0) or a discount (above 0, at most 100), with up to 4 decimals`
      }
    } else if (kind === 'DISCOUNT') return `step ${i}: a discount says its percent`

    if (i === 1) {
      if (!(START_KINDS as readonly string[]).includes(kind)) return 'the waterfall starts with LIST (the list price), SUGGESTED (from the cost) or MANUAL (typed)'
      if ('delta' in step || 'pct' in step) return `step 1 (${kind}) is the start: a unit price, no change`
      const price = decimal6(step.unitPrice)
      if (price === null || price.lt(0)) return `step 1 (${kind}): its unit price is a decimal string of 0 or more, up to 6 decimals`
      if (kind === 'LIST' && listPrice !== null && !price.eq(new Dec(listPrice))) return `step 1 (LIST) starts at ${decimalText(price)}, not at the line's list price ${decimalText(listPrice)}`
      running = price
    } else if (i === n) {
      if (kind !== 'NET') return `the last step (${kind}) is NET: the unit price the steps reach`
      if ('delta' in step || 'pct' in step || 'reasonCode' in step) return 'NET is the result: a unit price, no change'
      const price = decimal6(step.unitPrice)
      if (price === null || !price.eq(running)) return `NET says ${typeof step.unitPrice === 'string' ? step.unitPrice : 'nothing'} but the steps reach ${decimalText(running)}`
      if (unitPrice === null || !price.eq(new Dec(unitPrice))) return `NET ${decimalText(price)} is not the line's unit price ${unitPrice === null ? 'none' : decimalText(unitPrice)}`
    } else {
      if (kind === 'LIST' || kind === 'SUGGESTED' || kind === 'NET') return `step ${i} is ${kind}: only the first step is the start and only the last is NET`
      if (kind === 'SIZE_SURCHARGE') {
        const sizes = step.sizes
        if ('delta' in step || 'unitPrice' in step || !sizes || typeof sizes !== 'object' || Array.isArray(sizes)) return `step ${i} (SIZE_SURCHARGE): what it adds per size, beside the running price (no delta, no unit price)`
        const entries = Object.entries(sizes as Record<string, unknown>)
        for (const [size, value] of entries) {
          const change = decimal6(value)
          if (!SIZE_CODE.test(size) || change === null || change.isZero()) return `step ${i} (SIZE_SURCHARGE): size "${size.slice(0, 60)}" adds a decimal string, never 0`
        }
        if (entries.length === 0 || entries.length > WATERFALL_LIMITS.sizes) return `step ${i} (SIZE_SURCHARGE) names 1 to 100 sizes`
      } else {
        const change = decimal6(step.delta)
        const price = decimal6(step.unitPrice)
        if (change === null || change.isZero()) return `step ${i} (${kind}): its delta is a decimal string, never 0`
        if (price === null || price.lt(0) || !price.eq(running.plus(change))) {
          return `step ${i} (${kind}): ${decimalText(running)} ${change.isNegative() ? '-' : '+'} ${decimalText(change.abs())} makes ${decimalText(running.plus(change))}, not ${typeof step.unitPrice === 'string' ? step.unitPrice : 'nothing'}`
        }
        running = price
      }
    }
  }
  return null
}

/** A price as the waterfall writes it: at most 6 places, no trailing zeros. */
export const stepPrice = (value: Decimal | string): string => decimalText(new Dec(value).toDecimalPlaces(UNIT_PRICE.scale, Dec.ROUND_HALF_UP))

/** One option chosen on the line, frozen as priced (QuoteLineOption / SalesOrderLineOption): what it adds, net. */
export interface OptionCharge {
  readonly optionId: string
  /** The record the option is chosen on: QuoteLineOption (default) or SalesOrderLineOption. */
  readonly sourceType?: 'QuoteLineOption' | 'SalesOrderLineOption'
  readonly label: string
  /** The frozen surcharge, net (the line's currency); null or 0: the option adds nothing. */
  readonly amount: string | null
  /** The percent it came from, when it was one. */
  readonly pct: string | null
}

/**
 * One size surcharge of the line as its price list gives it (B-W2b-325 linePriceOf: the most particular surcharge of the
 * size, a percent taken of the price after the break), already on the document's basis.
 */
export interface SizeCharge {
  readonly surchargeId: string
  readonly size: string
  /** What a piece of that size adds beside the line's price, on the basis. */
  readonly added: string
}

export interface WaterfallInput {
  /** The start: its kind, its unit price on the basis, its source (LIST, SUGGESTED) or reason (MANUAL), its label. */
  readonly start: { readonly kind: StartKind; readonly unitPrice: string; readonly source?: StepSource; readonly reasonCode?: string; readonly label?: string; readonly note?: string }
  /** The quantity break (from the list, B-W2b-325's linePriceOf), already on the basis. */
  readonly breakStep?: { readonly delta: string; readonly pct?: string; readonly source: StepSource; readonly label?: string } | null
  readonly options?: readonly OptionCharge[]
  /** A discount off the running price, percent (above 0, at most 100), with its reason when there is one. */
  readonly discount?: { readonly pct: string; readonly reasonCode?: string | null; readonly label?: string } | null
  /** The net the person typed (SAL-175): a MANUAL step brings the running price to it, with its reason code. */
  readonly net?: { readonly unitPrice: string; readonly reasonCode: string; readonly note?: string | null } | null
  readonly sizeCharges?: readonly SizeCharge[]
  /** A net figure on the document's basis (identity on a business's quote; VAT added on a consumer's). */
  readonly onBasis?: (net: string) => string
  /** A figure on the document's basis back to its net (identity on a business's quote). */
  readonly toNet?: (basis: string) => string
  readonly currency: CurrencyCode
}

export interface BuiltWaterfall {
  readonly steps: readonly WaterfallStep[]
  /** NET: the line's unit price. */
  readonly unitPrice: string
  /** Per size: its own unit price (NET + its surcharge), the sizes with a surcharge only. */
  readonly sizePrices: Readonly<Record<string, string>>
  /** The reason the price differs from its start, for QuoteLine.adjustmentReason: the manual change's, else the discount's. */
  readonly adjustmentReason: string | null
}

const identity = (net: string): string => stepPrice(net)

/**
 * The waterfall of a line (SAL-174): start → BREAK → OPTION… → DISCOUNT → MANUAL (to the net typed) → SIZE_SURCHARGE (per
 * size, beside the running price: a size's own price is NET + what its list adds, B-W2b-325's figure) → NET. On the
 * document's basis: an option's net surcharge adds `onBasis(net + surcharge) − onBasis(net)`, net the running price's;
 * a discount takes its percent of the running price, to 6 places. A change of 0 is left out (the database refuses a
 * delta of 0). Returns the steps, or the problems in words.
 */
export function buildWaterfall(input: WaterfallInput): BuiltWaterfall | Issue[] {
  const issues: Issue[] = []
  const onBasis = input.onBasis ?? identity
  const start = decimal6(input.start.unitPrice)
  if (start === null || start.lt(0)) return [{ path: 'body/start', message: 'The starting price is 0 or more, at most 6 decimals.' }]
  if (input.start.kind === 'MANUAL' && !(input.start.reasonCode && REASON_CODE.test(input.start.reasonCode))) issues.push({ path: 'body/startReasonCode', message: 'A typed starting price names its reason code (SAL-175).' })
  if (input.start.kind !== 'MANUAL' && !input.start.source) issues.push({ path: 'body/start', message: 'A list or suggested price names where it comes from.' })
  if ((input.options?.length ?? 0) > WATERFALL_LIMITS.options) issues.push({ path: 'body/options', message: `A line takes at most ${WATERFALL_LIMITS.options} priced options.` })
  if (issues.length > 0) return issues

  const steps: WaterfallStep[] = [
    {
      kind: input.start.kind,
      unitPrice: stepPrice(start),
      ...(input.start.source ? { source: { type: input.start.source.type, id: input.start.source.id } } : {}),
      ...(input.start.kind === 'MANUAL' ? { reasonCode: input.start.reasonCode! } : {}),
      ...(input.start.label ? { label: input.start.label.slice(0, WATERFALL_LIMITS.label) } : {}),
      ...(input.start.note ? { note: input.start.note.slice(0, WATERFALL_LIMITS.note) } : {}),
    },
  ]
  let running = start
  // The net of the running price: a surcharge is net, so it is added to the net and both are put on the basis.
  const toNet = input.toNet ?? identity
  const netOf = (price: Decimal): Decimal => new Dec(toNet(stepPrice(price)))
  const change = (kind: WaterfallKind, delta: Decimal, extra: Partial<WaterfallStep>) => {
    const exact = new Dec(stepPrice(delta))
    if (exact.isZero()) return
    running = running.plus(exact)
    steps.push({ kind, delta: stepPrice(exact), unitPrice: stepPrice(running), ...extra })
  }
  if (input.breakStep) {
    const delta = decimal6(input.breakStep.delta)
    if (delta === null) return [{ path: 'body/start', message: 'The quantity break is a decimal of at most 6 places.' }]
    change('BREAK', delta, { ...(input.breakStep.pct ? { pct: input.breakStep.pct } : {}), source: input.breakStep.source, ...(input.breakStep.label ? { label: input.breakStep.label } : {}) })
  }
  // A surcharge on the basis: the basis of (net + surcharge) less the basis of net, so it adds up to 6 places.
  for (const option of input.options ?? []) {
    if (option.amount === null) continue
    const amount = decimal6(option.amount)
    if (amount === null || amount.isZero()) continue
    const base = netOf(running)
    const delta = new Dec(onBasis(stepPrice(base.plus(amount)))).minus(new Dec(onBasis(stepPrice(base))))
    const pct = option.pct === null ? null : decimal4(option.pct)
    change('OPTION', delta, { ...(pct && !pct.isZero() && pct.gte(-100) && pct.lte(1000) ? { pct: decimalText(pct) } : {}), source: { type: option.sourceType ?? 'QuoteLineOption', id: option.optionId }, label: option.label.slice(0, WATERFALL_LIMITS.label) })
  }
  if (input.discount) {
    const pct = decimal4(input.discount.pct)
    if (pct === null || pct.lte(0) || pct.gt(100)) return [{ path: 'body/discount/pct', message: 'A discount above 0 and at most 100 percent, at most 4 decimals.' }]
    if (input.discount.reasonCode !== undefined && input.discount.reasonCode !== null && !REASON_CODE.test(input.discount.reasonCode)) return [{ path: 'body/discount/reasonCode', message: 'A reason code of the price adjustment list.' }]
    const delta = running.times(pct).dividedBy(HUNDRED).negated()
    change('DISCOUNT', delta, { pct: decimalText(pct), ...(input.discount.reasonCode ? { reasonCode: input.discount.reasonCode } : {}), ...(input.discount.label ? { label: input.discount.label } : {}) })
  }
  if (input.net) {
    const target = decimal6(input.net.unitPrice)
    if (target === null || target.lt(0)) return [{ path: 'body/net/unitPrice', message: 'A net unit price of 0 or more, at most 6 decimals.' }]
    if (!REASON_CODE.test(input.net.reasonCode)) return [{ path: 'body/net/reasonCode', message: 'A manual net names its reason code (SAL-175).' }]
    const note = input.net.note?.trim() ? input.net.note.trim().slice(0, WATERFALL_LIMITS.note) : null
    change('MANUAL', target.minus(running), { reasonCode: input.net.reasonCode, ...(note ? { note } : {}) })
  }
  if (running.lt(0)) return [{ path: 'body', message: 'The steps bring the price under 0.' }]

  // Per size: what it adds beside the running price (the list's figure; a size's own price is NET + it).
  const bySource = new Map<string, Record<string, string>>()
  const sizePrices: Record<string, string> = {}
  for (const charge of input.sizeCharges ?? []) {
    const exact = decimal6(charge.added)
    if (exact === null || exact.isZero() || !SIZE_CODE.test(charge.size)) continue
    bySource.set(charge.surchargeId, { ...(bySource.get(charge.surchargeId) ?? {}), [charge.size]: stepPrice(exact) })
    sizePrices[charge.size] = stepPrice(running.plus(exact))
  }
  for (const [id, sizes] of bySource) steps.push({ kind: 'SIZE_SURCHARGE', sizes, source: { type: 'SizeSurcharge', id }, label: `Size ${Object.keys(sizes).join(', ')}`.slice(0, WATERFALL_LIMITS.label) })
  steps.push({ kind: 'NET', unitPrice: stepPrice(running) })
  const problem = stepsProblem(steps, stepPrice(running), input.start.kind === 'LIST' ? stepPrice(start) : null)
  if (problem) return [{ path: 'body', message: `The price steps do not add up: ${problem}.` }]
  // The reason the price is not its start: the last manual step's (a typed start counts), else the discount's.
  const reasoned = [...steps].reverse().find((step) => step.kind === 'MANUAL' || (step.kind === 'DISCOUNT' && step.reasonCode !== undefined))
  const adjustmentReason = reasoned?.reasonCode ?? null
  return { steps, unitPrice: stepPrice(running), sizePrices, adjustmentReason }
}

// ---- a suggested price (SAL-173) ----------------------------------------------------------------------------------------

export interface SuggestedPrice {
  /** On the document's basis. */
  readonly unitPrice: string
  /** Net, rounded up to the minor unit. */
  readonly netUnitPrice: string
  /** The margin it was asked to earn, percent of the net. */
  readonly marginPct: string
}

/**
 * The price that earns `marginPct` of the net on a line costing `unitCost` a piece: net = cost ÷ (1 − margin ÷ 100),
 * rounded UP to the currency's minor unit (the margin is then at least the one asked), then on the document's basis.
 * Null with words: no cost (or not complete), a margin of 100 % or more, a negative cost.
 */
export function suggestedPriceOf(input: { readonly unitCost: string | null; readonly marginPct: string; readonly currency: CurrencyCode; readonly onBasis?: (net: string) => string }): SuggestedPrice | { readonly problem: string } {
  if (input.unitCost === null) return { problem: 'The line has no complete cost yet: a price is suggested once its cost sheet is complete.' }
  const cost = parseDecimal(input.unitCost)
  const margin = parseDecimal(input.marginPct)
  if (cost === null || cost.lt(0)) return { problem: 'The cost is not a figure of 0 or more.' }
  if (margin === null || margin.lt(0) || margin.gte(100) || !fitsDecimal(input.marginPct, 7, 4)) return { problem: 'The margin to earn is from 0 to below 100 percent, at most 4 decimals.' }
  const places = minorPlaces(input.currency)
  const net = cost.times(HUNDRED).dividedBy(HUNDRED.minus(margin)).toDecimalPlaces(places, Dec.ROUND_UP)
  const netText = stepPrice(net)
  return { unitPrice: (input.onBasis ?? identity)(netText), netUnitPrice: netText, marginPct: decimalText(margin) }
}

// ---- why this price? -------------------------------------------------------------------------------------------------

export interface ExplainedStep {
  readonly kind: WaterfallKind
  /** What the step adds (a change), or the price it states (a start, NET); per size for a size surcharge. */
  readonly amount: string | null
  readonly unitPrice: string | null
  readonly sizes: Readonly<Record<string, string>> | null
  readonly pct: string | null
  readonly label: string | null
  readonly reasonCode: string | null
  readonly source: StepSource | null
  readonly text: string
}

const KIND_WORDS: Readonly<Record<WaterfallKind, string>> = Object.freeze({
  LIST: 'List price',
  SUGGESTED: 'Suggested from the cost',
  BREAK: 'Quantity break',
  SIZE_SURCHARGE: 'Size surcharge',
  OPTION: 'Option',
  DISCOUNT: 'Discount',
  MANUAL: 'Manual change',
  NET: 'Net',
})

const signed = (value: string): string => (value.startsWith('-') ? `− ${value.slice(1)}` : `+ ${value}`)
/** A figure as said: at least the currency's minor places, more only when it has them ("10.000000" → "10.00"). */
const fixed = (value: string, currency: CurrencyCode): string => {
  const text = decimalText(value)
  return new Dec(text).toFixed(Math.max(minorPlaces(currency), Math.min(6, (text.split('.')[1] ?? '').length)))
}

/**
 * "Why this price?" (the brand's question; design quote line drawer "Cost breakdown and Waterfall"): each step in words,
 * in English (the screen words per kind and reason from its catalogue), and one sentence. `reasonLabel` gives a reason
 * code its words (the PRICE_ADJUSTMENT list). Steps the database never wrote (a stale shape) are said as they are.
 */
export function explainWaterfall(steps: readonly WaterfallStep[], currency: CurrencyCode, reasonLabel: (code: string) => string | null = () => null): { readonly rows: ExplainedStep[]; readonly sentence: string } {
  const rows: ExplainedStep[] = steps.map((step) => {
    const label = step.label ?? null
    const reason = step.reasonCode ? (reasonLabel(step.reasonCode) ?? step.reasonCode) : null
    const extras = [label, step.pct && step.kind !== 'SIZE_SURCHARGE' ? `${step.pct} %` : null, reason].filter((part): part is string => part !== null && part !== '')
    const tail = extras.length > 0 ? ` (${extras.join(', ')})` : ''
    let text: string
    if (step.kind === 'SIZE_SURCHARGE') text = `${KIND_WORDS[step.kind]}${tail}: ${Object.entries(step.sizes ?? {}).map(([size, add]) => `size ${size} ${signed(fixed(add, currency))}`).join(', ')}`
    else if (step.delta !== undefined) text = `${KIND_WORDS[step.kind]}${tail} ${signed(fixed(step.delta, currency))} = ${fixed(step.unitPrice ?? '0', currency)}`
    else text = `${KIND_WORDS[step.kind]}${tail} ${fixed(step.unitPrice ?? '0', currency)}`
    return {
      kind: step.kind,
      amount: step.delta ?? (step.kind === 'SIZE_SURCHARGE' ? null : (step.unitPrice ?? null)),
      unitPrice: step.unitPrice ?? null,
      sizes: step.sizes ?? null,
      pct: step.pct ?? null,
      label,
      reasonCode: step.reasonCode ?? null,
      source: step.source ?? null,
      text,
    }
  })
  return { rows, sentence: rows.map((row) => row.text).join('; ') + '.' }
}

// ---- the margin floor of the person quoting (SAL-189) ---------------------------------------------------------------

export const FLOOR_LIMITS = { roles: 50 } as const
const ROLE_KEY = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/

/** A role's floor as stored: a decimal string 0 to 100, at most 4 decimals ("25.0000"). */
export const floorText = (value: string): string => new Dec(value).toFixed(4)

/** What is wrong with floors by role as typed (role keys of the tenant's office roles are the API's check). */
export function floorsProblems(floors: Readonly<Record<string, string>> | null, at = 'body/floors'): Issue[] {
  if (floors === null) return []
  const issues: Issue[] = []
  const entries = Object.entries(floors)
  if (entries.length > FLOOR_LIMITS.roles) issues.push({ path: at, message: `At most ${FLOOR_LIMITS.roles} roles have a floor of their own.` })
  for (const [key, value] of entries) {
    if (!ROLE_KEY.test(key) || key.length > 80) issues.push({ path: `${at}/${key}`, message: 'Not a role key.' })
    const pct = parseDecimal(value)
    if (pct === null || !fitsDecimal(value, 7, 4) || pct.lt(0) || pct.gt(100)) issues.push({ path: `${at}/${key}`, message: 'A margin floor from 0 to 100 percent, at most 4 decimals.' })
  }
  return issues
}

/** The floors by role as read from SalesSettings.marginFloorByRole (anything else: none). */
export function floorsOf(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const entries = Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && parseDecimal(entry[1]) !== null)
  return entries.length === 0 ? null : Object.fromEntries(entries)
}

export interface FloorInForce {
  /** The floor the quote is held to, percent of the net (as the rules write it: "25"). */
  readonly marginFloorPct: string
  /** ROLE: the lowest floor of the person's listed roles; COMPANY: the company's (or tenant's, or default) floor. */
  readonly source: 'ROLE' | 'COMPANY'
  /** The role whose floor it is (ROLE). */
  readonly roleKey: string | null
}

/**
 * The floor of a person holding `roleKeys` (their live office roles over the quote's company and customer): the lowest
 * floor among their roles listed in `floors`, else the company's (SalesSettings.marginFloorPct in force). A role's floor
 * may be above the company's (a junior seller held higher) or below it (the owner may go lower on their own).
 */
export function floorFor(floors: Readonly<Record<string, string>> | null, roleKeys: readonly string[], companyFloorPct: string): FloorInForce {
  let best: { key: string; pct: Decimal } | null = null
  for (const key of [...new Set(roleKeys)].sort()) {
    const value = floors?.[key]
    const pct = value === undefined ? null : parseDecimal(value)
    if (pct === null) continue
    if (best === null || pct.lt(best.pct)) best = { key, pct }
  }
  if (best === null) return { marginFloorPct: decimalText(companyFloorPct), source: 'COMPANY', roleKey: null }
  return { marginFloorPct: decimalText(best.pct), source: 'ROLE', roleKey: best.key }
}

/**
 * A change of the floors by role that lets more quotes through without a yes (a role's floor lower than it was, or a
 * new role floor under the company's): it asks for a fresh step-up (design ssettings.approval "Raising a limit asks for
 * step-up"). Removing a role's floor that was under the company's lets fewer through; one above it, more.
 */
export function lowersAFloor(before: Readonly<Record<string, string>> | null, after: Readonly<Record<string, string>> | null, companyFloorPct: string): boolean {
  const company = new Dec(companyFloorPct)
  const of = (map: Readonly<Record<string, string>> | null, key: string): Decimal => (map?.[key] === undefined ? company : new Dec(map[key]!))
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])
  return [...keys].some((key) => of(after, key).lt(of(before, key)))
}

// ---- fees (SAL-181) ----------------------------------------------------------------------------------------------------

export const FEE_LIMITS = { quantity: 9999, description: 1000, note: 2000 } as const

export const FEE_WORDS: Readonly<Record<SalesFeeKind, string>> = Object.freeze({
  DEVELOPMENT: 'Development fee',
  SAMPLE: 'Sample fee',
  TOOLING: 'Tooling fee',
})

export interface FeeInput {
  readonly feeKind?: SalesFeeKind | undefined
  readonly unitPrice?: string | undefined
  readonly quantity?: number | undefined
}

/** What is wrong with a fee as typed: a kind of fee, a price above 0 (6 places), whole pieces from 1. */
export function feeProblems(input: FeeInput, at = 'body'): Issue[] {
  const issues: Issue[] = []
  if (input.feeKind !== undefined && !(SALES_FEE_KINDS as readonly string[]).includes(input.feeKind)) issues.push({ path: `${at}/feeKind`, message: `A fee is ${SALES_FEE_KINDS.join(', ')}.` })
  if (input.unitPrice !== undefined) {
    const price = parseDecimal(input.unitPrice)
    if (price === null || !fitsDecimal(input.unitPrice, UNIT_PRICE.precision, UNIT_PRICE.scale) || price.lte(0)) issues.push({ path: `${at}/unitPrice`, message: 'A fee above 0, at most 6 decimals.' })
  }
  if (input.quantity !== undefined && (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > FEE_LIMITS.quantity)) issues.push({ path: `${at}/quantity`, message: `Whole times from 1 to ${FEE_LIMITS.quantity}.` })
  return issues
}

/** A fee line's description when none is typed: the kind of fee and the style it is for. */
export const feeDescription = (feeKind: SalesFeeKind, style: { readonly code: string; readonly name: string }): string => `${FEE_WORDS[feeKind]} - ${style.code} ${style.name}`.slice(0, FEE_LIMITS.description)

/**
 * GATE-ACCOUNTANT (B-W2b-330): a fee is invoiced once, on the first invoice of its order's shipped goods, taxed as those
 * goods; crediting a development fee against the bulk order that follows is NOT built: it waits for the accountant's
 * word on the document (a credit note, or a deduction line on the bulk invoice) and for the link between the two orders
 * (a schema need). This switch says so wherever the question is asked.
 */
export const FEE_CREDIT_AGAINST_BULK = { enabled: false, gate: 'GATE-ACCOUNTANT', words: 'Crediting a fee against the bulk order waits for the accountant (GATE-ACCOUNTANT): the fee is invoiced once and stays on that invoice.' } as const
