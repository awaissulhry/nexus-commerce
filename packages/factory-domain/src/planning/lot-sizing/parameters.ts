import type { Issue } from '../../core/errors'
import { fitsDecimal, QUANTITY } from '../../core/money'
import { Dec, type Decimal } from '../../tax/decimal'

/**
 * The planning rules per item at a site (B-W2b-318; PLN-006, PLN-008, PLN-081, PLN-082; the ItemPlanning columns of
 * B-W2b-286), pure: the values a planner keeps beside W2a's item parameters (planning/settings/items), their exactness
 * in words (the …_planning_depth_w2b_guards trigger holds the same for every login; these say it first, with the field)
 * and the sentences that say what each one does.
 *
 *   lotSizing     how the run sizes the orders it suggests (read with the ORDERS method only): LOT_FOR_LOT (W1: exactly
 *                 the net need), FIXED (lots of fixedLotQty), MIN_MAX (each order at least minOrderQty, in steps of
 *                 orderMultiple, at most maxOrderQty: W2a's order limits of the row), PERIOD (the need of lotPeriodDays
 *                 days in one order). ./lots counts them.
 *   planLevel     a finished garment's (or a component's) planning level: SKU (each size its own planned work order),
 *                 STYLE_COLOUR (the colourway's sizes in one grid), STYLE (the same: a planned work order makes one
 *                 colourway); null: the site's size-run rule (B-W2b-293). ./plan-level.
 *   scrapPct      scrap on top of the BOM's wastage, percent of the need added (0 to under 100), and
 *   yieldPct      the yield, percent of the input that comes out good (above 0 to 100): the need × (1 + scrap) ÷ yield.
 *                 ./scrap.
 *   delayDays     the days between the supply's arrival and its use (incoming inspection, put-away), 0 to 366: the
 *                 calculated delay (../item-profile/delays) is the lead time plus these days, past the closures.
 *
 * Quantities in the item's BASE unit, four decimals at most; percents two decimals at most; days whole.
 */

export const LOT_SIZINGS = ['LOT_FOR_LOT', 'FIXED', 'MIN_MAX', 'PERIOD'] as const
export type LotSizing = (typeof LOT_SIZINGS)[number]
export const PLAN_LEVELS = ['STYLE', 'STYLE_COLOUR', 'SKU'] as const
export type PlanLevel = (typeof PLAN_LEVELS)[number]
/** The item kinds a plan level belongs to (B-W2b-286's guard). */
export const PLAN_LEVEL_ITEM_KINDS = ['FINISHED', 'COMPONENT'] as const

export const ITEM_RULE_LIMITS = Object.freeze({ periodDays: { min: 1, max: 366 }, delayDays: { min: 0, max: 366 } })

export interface ItemRuleValues {
  readonly lotSizing: LotSizing
  /** FIXED exactly: the lot, base unit, above 0. */
  readonly fixedLotQty: string | null
  /** PERIOD exactly: the days one order covers. */
  readonly lotPeriodDays: number | null
  /** null: the site's size-run rule. */
  readonly planLevel: PlanLevel | null
  /** Decimal strings, two decimals. */
  readonly scrapPct: string | null
  readonly yieldPct: string | null
  readonly delayDays: number | null
}

export const EMPTY_ITEM_RULES: ItemRuleValues = Object.freeze({ lotSizing: 'LOT_FOR_LOT', fixedLotQty: null, lotPeriodDays: null, planLevel: null, scrapPct: null, yieldPct: null, delayDays: null })

export const ITEM_RULE_FIELDS = Object.keys(EMPTY_ITEM_RULES) as (keyof ItemRuleValues)[]

export type ItemRulePatch = { readonly [Key in keyof ItemRuleValues]?: ItemRuleValues[Key] | undefined }

const DECIMAL = /^\d+(\.\d+)?$/
const isQuantity = (value: string): boolean => DECIMAL.test(value) && fitsDecimal(value, QUANTITY.precision, QUANTITY.scale)
const PERCENT = /^\d{1,3}(\.\d{1,2})?$/

/** A value as stored: quantities with four decimals, percents with two (an unreadable one stays as sent, for the words). */
function normal(values: ItemRuleValues): ItemRuleValues {
  const q4 = (value: string | null) => (value !== null && isQuantity(value) ? new Dec(value).toFixed(4) : value)
  const p2 = (value: string | null) => (value !== null && PERCENT.test(value) ? new Dec(value).toFixed(2) : value)
  return { ...values, fixedLotQty: q4(values.fixedLotQty), scrapPct: p2(values.scrapPct), yieldPct: p2(values.yieldPct) }
}

/**
 * The rules after a change: the current values (or the empty ones) with the fields the change names. A change of lot
 * sizing clears the old method's own number it does not name (FIXED's lot, PERIOD's days): `cleared` lists it, so the
 * screen can say so. Nothing else is cleared without being named.
 */
export function mergeItemRules(current: ItemRuleValues | null, patch: ItemRulePatch): { values: ItemRuleValues; cleared: (keyof ItemRuleValues)[] } {
  const base = current ?? EMPTY_ITEM_RULES
  const values: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) if (value !== undefined && key in EMPTY_ITEM_RULES) values[key] = value
  const cleared: (keyof ItemRuleValues)[] = []
  const clear = (key: 'fixedLotQty' | 'lotPeriodDays'): void => {
    if (patch[key] !== undefined) return
    if (values[key] !== null) cleared.push(key)
    values[key] = null
  }
  if (values.lotSizing !== 'FIXED' && base.lotSizing === 'FIXED') clear('fixedLotQty')
  if (values.lotSizing !== 'PERIOD' && base.lotSizing === 'PERIOD') clear('lotPeriodDays')
  return { values: normal(values as unknown as ItemRuleValues), cleared }
}

/** The rules differ in a field (as stored). */
export const changedRules = (a: ItemRuleValues, b: ItemRuleValues): (keyof ItemRuleValues)[] => ITEM_RULE_FIELDS.filter((key) => a[key] !== b[key])

/** What is wrong with a row's rules (empty when nothing is); `itemKind`: the item's kind; `base`: the body's path. */
export function itemRuleProblems(values: ItemRuleValues, itemKind: string, base = 'body'): Issue[] {
  const problems: Issue[] = []
  const at = (field: keyof ItemRuleValues, message: string) => problems.push({ path: `${base}/${field}`, message })
  if (!(LOT_SIZINGS as readonly string[]).includes(values.lotSizing)) at('lotSizing', `Size the orders by ${LOT_SIZINGS.join(', ')}.`)
  if (values.fixedLotQty !== null) {
    if (!isQuantity(values.fixedLotQty) || !new Dec(values.fixedLotQty).gt(0)) at('fixedLotQty', 'The fixed lot is a quantity above 0 in the item’s base unit, with at most four decimals.')
    else if (values.lotSizing !== 'FIXED') at('fixedLotQty', 'A fixed lot belongs to FIXED lot sizing; clear it or size the orders by FIXED.')
  } else if (values.lotSizing === 'FIXED') at('fixedLotQty', 'FIXED lot sizing needs its lot: how much each order brings.')
  const { min, max } = ITEM_RULE_LIMITS.periodDays
  if (values.lotPeriodDays !== null) {
    if (!Number.isSafeInteger(values.lotPeriodDays) || values.lotPeriodDays < min || values.lotPeriodDays > max) at('lotPeriodDays', `A period is ${min} to ${max} days.`)
    else if (values.lotSizing !== 'PERIOD') at('lotPeriodDays', 'A period belongs to PERIOD lot sizing; clear it or size the orders by PERIOD.')
  } else if (values.lotSizing === 'PERIOD') at('lotPeriodDays', 'PERIOD lot sizing needs its period: the days of need one order brings.')
  if (values.planLevel !== null) {
    if (!(PLAN_LEVELS as readonly string[]).includes(values.planLevel)) at('planLevel', `Plan it by ${PLAN_LEVELS.join(', ')}, or by the site’s size-run rule (none).`)
    else if (!(PLAN_LEVEL_ITEM_KINDS as readonly string[]).includes(itemKind)) at('planLevel', 'Only a finished garment or a component is planned by style, colour or size; a material is planned per colour.')
  }
  if (values.scrapPct !== null) {
    if (!PERCENT.test(values.scrapPct) || !new Dec(values.scrapPct).lt(100)) at('scrapPct', 'The scrap is a percent of the need from 0 to under 100, with at most two decimals (5 or 2.5).')
  }
  if (values.yieldPct !== null) {
    if (!PERCENT.test(values.yieldPct) || !new Dec(values.yieldPct).gt(0) || new Dec(values.yieldPct).gt(100)) at('yieldPct', 'The yield is a percent above 0 and at most 100, with at most two decimals (92 or 87.5).')
  }
  const delay = ITEM_RULE_LIMITS.delayDays
  if (values.delayDays !== null && (!Number.isSafeInteger(values.delayDays) || values.delayDays < delay.min || values.delayDays > delay.max)) at('delayDays', `The days between arrival and use are ${delay.min} to ${delay.max}.`)
  return problems
}

/** The factor the need is multiplied by: (1 + scrap ÷ 100) ÷ (yield ÷ 100); null when it is 1 (no scrap, no yield loss). */
export function scrapYieldFactor(scrapPct: string | null, yieldPct: string | null): Decimal | null {
  const scrap = scrapPct !== null && PERCENT.test(scrapPct) ? new Dec(scrapPct) : new Dec(0)
  const yieldOf = yieldPct !== null && PERCENT.test(yieldPct) && new Dec(yieldPct).gt(0) ? new Dec(yieldPct) : new Dec(100)
  const factor = new Dec(100).plus(scrap).div(yieldOf)
  return factor.eq(1) ? null : factor
}

const trim = (value: string): string => (value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value)

/** What the row's rules do, in English (one sentence each; null when the rule is the default). */
export function itemRuleWords(values: ItemRuleValues, facts: { readonly method: string; readonly itemKind: string; readonly uom: string; readonly minOrderQty: string | null; readonly orderMultiple: string | null; readonly maxOrderQty: string | null }) {
  const onlyOrders = facts.method === 'ORDERS' ? '' : ` It is read only when the item is planned by its orders (its method is ${facts.method}).`
  let lotSizing: string | null = null
  if (values.lotSizing === 'FIXED' && values.fixedLotQty !== null) lotSizing = `Each order brings ${trim(values.fixedLotQty)} ${facts.uom}, as many as the need takes.${onlyOrders}`
  else if (values.lotSizing === 'PERIOD' && values.lotPeriodDays !== null) lotSizing = `One order brings the need of ${values.lotPeriodDays} day${values.lotPeriodDays === 1 ? '' : 's'}; the next period is the next order.${onlyOrders}`
  else if (values.lotSizing === 'MIN_MAX') {
    const limits = [facts.minOrderQty !== null ? `at least ${trim(facts.minOrderQty)}` : null, facts.orderMultiple !== null ? `in steps of ${trim(facts.orderMultiple)}` : null, facts.maxOrderQty !== null ? `at most ${trim(facts.maxOrderQty)}` : null].filter(Boolean)
    lotSizing = limits.length > 0 ? `Each order is ${limits.join(', ')} ${facts.uom}; above the maximum the need is split into more orders.${onlyOrders}` : `No order limits are set: each order is exactly the need, as lot for lot.${onlyOrders}`
  }
  // A finished garment's orders are planned work orders of the ordered pieces: its lot sizing is kept, not read yet.
  if (lotSizing !== null && facts.itemKind === 'FINISHED') lotSizing = `Kept for the finished garment; the plan sizes material orders only (a planned work order makes the ordered pieces).`
  let planLevel: string | null = null
  if (values.planLevel !== null) {
    if (facts.itemKind === 'COMPONENT') planLevel = 'Kept for the component; a component is planned per colour as a part to make (planned work orders of components are not made yet).'
    else if (values.planLevel === 'SKU') planLevel = 'Each size is a planned work order of its own.'
    else if (values.planLevel === 'STYLE_COLOUR') planLevel = 'The colourway’s sizes are planned in one grid, whatever the site’s size groups.'
    else planLevel = 'Planned as style and colour: a planned work order makes one colourway, with its sizes in one grid.'
  }
  const factor = scrapYieldFactor(values.scrapPct, values.yieldPct)
  const scrapYield =
    factor === null
      ? null
      : `The need is multiplied by ${trim(factor.toDecimalPlaces(4).toFixed(4))} (${[values.scrapPct !== null && !new Dec(values.scrapPct).isZero() ? `${trim(values.scrapPct)} % scrap` : null, values.yieldPct !== null && !new Dec(values.yieldPct).eq(100) ? `${trim(values.yieldPct)} % yield` : null].filter(Boolean).join(', ')}), on top of the BOM’s wastage.${facts.itemKind === 'FINISHED' ? ' For a finished garment: every material of its size.' : ''}`
  const delay = values.delayDays !== null && values.delayDays > 0 ? `${values.delayDays} day${values.delayDays === 1 ? '' : 's'} between arrival and use: a supply is usable that many days after it arrives.` : null
  return { lotSizing, planLevel, scrapYield, delay }
}
