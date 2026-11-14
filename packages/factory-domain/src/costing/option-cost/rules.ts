import { Decimal } from 'decimal.js'
import type { BomLineData } from '../../product/bom/rules'
import type { EffectFacts } from '../../product/options/rules'
import type { WorkCentreKind } from '../../product/routing/operations'
import type { Uom } from '../../product/units/units'
import { componentsOf, type ComponentFacts, type Components, type ComponentStep } from '../sheet-components/components'
import { six } from '../sheet-components/rules'
import { splitBySize } from '../sheet-components/split'

/**
 * An option's own cost (B-W2b-423; FIN-018, follow-up KS4:01; design products.options › Price & BOM effects "Cost delta
 * (cost)"), pure. The cost sheet is the garment WITHOUT options (a BOM line or a routing step only for an option is left out
 * of it); what one option value adds to (or takes off) one garment of each size is the difference between the components
 * (B-W2b-418's computation, the same leather bases, rates, uplifts and overhead rules) of the garment with that value and of
 * the garment without options:
 *
 *   its own BOM lines        the revision's lines only for the value (B-W2b-211 optionValueId)
 *   its library effects      a material added (per garment or per size), the style's lines of a material replaced or left
 *                            out, an operation added (its minutes, else the operation's standard minutes), minutes at an
 *                            operation of the routing (B-W2b-229's OptionEffect)
 *   its own routing steps    the steps only for some options (B-W2b-225 appliesToOptionValueIds)
 *   minutes on the garment   a MINUTES effect at no operation, priced at the garment's labour cost per minute (its
 *                            in-house labour by time ÷ its minutes)
 *
 * The value's typed figures (B-W2b-378's OptionValue.materialDelta + currency, minutesDelta), when set, take the place of
 * what was worked out for that part: the material delta is the material part (in the sheet's currency only: no exchange
 * rate), the minutes delta × the garment's labour cost per minute the making part. Parts:
 *
 *   material   materials, leather, the BOM's packaging, freight and duty
 *   making     labour, outside operations, overhead
 *
 * A line's options cost (KS4:01: it joins the line's cost and margin on the quote and the order) is the sum of its chosen
 * values' own costs in the line's sizes. What cannot be known is said in words (that size's figure is then null), never 0.
 */

export const MATERIAL_PARTS = ['MATERIAL', 'LEATHER', 'PACKAGING', 'FREIGHT', 'DUTY'] as const
export const MAKING_PARTS = ['LABOUR', 'SUBCONTRACT', 'OVERHEAD', 'COMMISSION'] as const
export const PART_SOURCES = ['TYPED', 'DERIVED', 'NONE'] as const
export type PartSource = (typeof PART_SOURCES)[number]

/** An option value as costing reads it (office only: the floor never reads its cost). */
export interface OptionValueCostFacts {
  readonly id: string
  readonly groupId: string
  readonly code: string
  readonly name: string
  readonly materialDelta: string | null
  readonly materialDeltaCurrency: string | null
  readonly minutesDelta: string | null
}

/** A library operation an effect names. */
export interface EffectOperation {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly workCentreKind: WorkCentreKind
  readonly standardMinutes: string | null
}

/** The revision's parts only for options. */
export interface OptionParts {
  /** BOM line id → the value it is for. */
  readonly lines: ReadonlyMap<string, string>
  /** Routing step id → the values it is for (any one of them). */
  readonly steps: ReadonlyMap<string, readonly string[]>
}

/** Everything one garment's options are costed from: the components' facts with EVERY line and step (option-only ones too). */
export interface GarmentWithOptions {
  readonly facts: ComponentFacts
  readonly parts: OptionParts
  /** The library effects of the values that may be chosen. */
  readonly effects: readonly EffectFacts[]
  readonly operations: ReadonlyMap<string, EffectOperation>
}

export interface Configured {
  readonly facts: ComponentFacts
  /** Minutes on the garment as a whole (MINUTES effects at no operation). */
  readonly garmentMinutes: Decimal
  /** What the chosen values do that cannot be costed, in words. */
  readonly problems: readonly string[]
}

const isFor = (valueIds: readonly string[] | undefined, chosen: ReadonlySet<string>): boolean => valueIds === undefined || valueIds.length === 0 || valueIds.some((id) => chosen.has(id))

/** A material added by an effect, as a BOM line of the garment (never written: it only feeds the computation). */
function addedLine(effect: EffectFacts, index: number, sizes: readonly string[]): BomLineData {
  const perSize = effect.sizeQuantities
  const rows = perSize === null ? [] : sizes.flatMap((size) => (perSize[size] ?? effect.qty) === null || (perSize[size] ?? effect.qty) === undefined ? [] : [{ size, qty: (perSize[size] ?? effect.qty)! }])
  return {
    id: `option:${effect.id}`,
    seq: 90000 + index,
    itemId: effect.itemId!,
    placement: null,
    qty: effect.qty ?? '0',
    uom: effect.uom as Uom,
    wastagePct: '0',
    sizeDependent: perSize !== null,
    colourDependent: false,
    itemColourId: effect.itemColourId,
    colourwayId: null,
    supplierId: null,
    note: null,
    sizes: rows,
    colours: [],
  }
}

/** The garment with these values chosen (the others' lines and steps left out, the chosen values' effects applied). */
export function configured(garment: GarmentWithOptions, chosen: ReadonlySet<string>): Configured {
  const { facts, parts, operations } = garment
  const problems: string[] = []
  const mine = garment.effects.filter((effect) => chosen.has(effect.valueId))
  let lines: BomLineData[] = facts.lines.filter((line) => {
    const value = parts.lines.get(line.id)
    return value === undefined || chosen.has(value)
  })
  for (const effect of mine) {
    if (effect.targetItemId === null) continue
    if (effect.kind === 'BOM_REMOVE') lines = lines.filter((line) => line.itemId !== effect.targetItemId)
    if (effect.kind === 'BOM_REPLACE' && effect.itemId !== null) {
      lines = lines.map((line) =>
        line.itemId !== effect.targetItemId
          ? line
          : { ...line, itemId: effect.itemId!, itemColourId: effect.itemColourId, ...(effect.qty !== null && effect.uom !== null ? { qty: effect.qty, uom: effect.uom as Uom, sizeDependent: false, sizes: [] } : {}) },
      )
    }
  }
  mine.forEach((effect, index) => {
    if (effect.kind === 'BOM_ADD' && effect.itemId !== null && effect.uom !== null) lines.push(addedLine(effect, index, facts.sizes))
  })
  let steps: ComponentStep[] = facts.steps.filter((step) => isFor(parts.steps.get(step.id), chosen))
  let garmentMinutes = new Decimal(0)
  mine.forEach((effect, index) => {
    if (effect.kind !== 'OPERATION_ADD' && effect.kind !== 'MINUTES') return
    if (effect.kind === 'MINUTES' && effect.operationId === null) {
      garmentMinutes = garmentMinutes.plus(effect.minutes ?? '0')
      return
    }
    const operation = effect.operationId === null ? undefined : operations.get(effect.operationId)
    if (!operation) {
      problems.push('An option names an operation that could not be read: its minutes are not costed.')
      return
    }
    if (effect.kind === 'MINUTES') {
      const at = steps.find((step) => step.operationId === operation.id)
      if (at) {
        const minutes = new Decimal(at.standardMinutes).plus(effect.minutes ?? '0')
        if (minutes.lt(0)) {
          problems.push(`An option takes more minutes from ${operation.code} than the routing gives it.`)
          return
        }
        steps = steps.map((step) => (step.id === at.id ? { ...step, standardMinutes: minutes.toString() } : step))
        return
      }
      if (new Decimal(effect.minutes ?? '0').lte(0)) {
        problems.push(`An option takes minutes from ${operation.code}, which the routing does not have.`)
        return
      }
    }
    const minutes = effect.kind === 'MINUTES' ? effect.minutes : (effect.minutes ?? operation.standardMinutes)
    if (minutes === null) {
      problems.push(`${operation.code} has no standard minutes: the operation the option adds is not costed.`)
      return
    }
    steps.push({ id: `option:${effect.id}`, seq: 90000 + index, operationId: operation.id, code: operation.code, name: operation.name, workCentreKind: operation.workCentreKind, standardMinutes: minutes })
  })
  return { facts: { ...facts, lines, steps }, garmentMinutes, problems }
}

/** Σ of some categories of one size's split. */
function partOf(split: ReturnType<typeof splitBySize>[number] | undefined, categories: readonly string[]): Decimal {
  return (split?.categories ?? []).filter((entry) => categories.includes(entry.category)).reduce((sum, entry) => sum.plus(entry.amount), new Decimal(0))
}

/** The garment's labour cost per minute in each size: its in-house labour costed by time ÷ those minutes (null: none). */
export function garmentRates(components: Components, sizes: readonly string[]): Map<string, Decimal | null> {
  return new Map(
    sizes.map((size) => {
      const labour = components.lines.filter((line) => line.category === 'LABOUR' && line.source === 'ROUTING' && (line.size === null || line.size === size))
      const minutes = labour.reduce((sum, line) => sum.plus(line.quantity), new Decimal(0))
      const cost = labour.reduce((sum, line) => sum.plus(line.cost), new Decimal(0))
      return [size, minutes.gt(0) ? cost.div(minutes) : null]
    }),
  )
}

export interface OptionSizeCost {
  readonly size: string
  readonly material: string | null
  readonly making: string | null
  readonly total: string | null
}

export interface OptionCost {
  readonly valueId: string
  readonly material: { readonly source: PartSource; readonly typed: string | null; readonly currency: string | null }
  readonly making: { readonly source: PartSource; readonly minutesTyped: string | null; readonly garmentMinutes: string }
  readonly bySize: readonly OptionSizeCost[]
  readonly complete: boolean
  /** What cannot be known, in words (no figure). */
  readonly missing: readonly string[]
}

export interface OptionCosts {
  /** The garment without options (the cost sheet's own lines). */
  readonly base: Components
  readonly values: readonly OptionCost[]
}

const CURRENCY_WORDS = (code: string, currency: string, sheet: string): string => `Option ${code}'s material delta is in ${currency}; this cost is in ${sheet} and has no exchange rate.`
const RATE_WORDS = (code: string, size: string): string => `Option ${code} adds minutes to the garment, but the garment has no labour costed by time in size ${size} to price them.`

/** What each value adds to one garment of each size of the range, against the garment without options. */
export function optionCosts(garment: GarmentWithOptions, values: readonly OptionValueCostFacts[]): OptionCosts {
  const sizes = garment.facts.sizes
  const none = configured(garment, new Set())
  const base = componentsOf(none.facts)
  const baseSplit = splitBySize(base.lines, sizes, base.missing)
  const baseKeys = new Set(base.missing.map((entry) => entry.key))
  const rates = garmentRates(base, sizes)
  const out = values.map((value): OptionCost => {
    const own = configured(garment, new Set([value.id]))
    const withValue = componentsOf(own.facts)
    const split = splitBySize(withValue.lines, sizes, withValue.missing)
    const fresh = withValue.missing.filter((entry) => !baseKeys.has(entry.key))
    const hasParts =
      [...garment.parts.lines.values()].includes(value.id) || [...garment.parts.steps.values()].some((ids) => ids.includes(value.id)) || garment.effects.some((effect) => effect.valueId === value.id && effect.kind !== 'PRICE' && effect.kind !== 'CERTIFICATE')
    const missing = new Set<string>(own.problems)
    const typedMaterial = value.materialDelta
    const currencyOk = typedMaterial === null || value.materialDeltaCurrency === garment.facts.currency
    if (!currencyOk) missing.add(CURRENCY_WORDS(value.code, value.materialDeltaCurrency ?? '?', garment.facts.currency))
    const bySize = sizes.map((size, index): OptionSizeCost => {
      const sizeFresh = fresh.filter((entry) => entry.size === null || entry.size === size)
      for (const entry of sizeFresh) missing.add(entry.message)
      const derivedKnown = sizeFresh.length === 0 && own.problems.length === 0
      const rate = rates.get(size) ?? null
      let material: Decimal | null = derivedKnown ? partOf(split[index], MATERIAL_PARTS).minus(partOf(baseSplit[index], MATERIAL_PARTS)) : null
      if (typedMaterial !== null) material = currencyOk ? new Decimal(typedMaterial) : null
      let making: Decimal | null = derivedKnown ? partOf(split[index], MAKING_PARTS).minus(partOf(baseSplit[index], MAKING_PARTS)) : null
      if (making !== null && !own.garmentMinutes.isZero()) {
        if (rate === null) {
          missing.add(RATE_WORDS(value.code, size))
          making = null
        } else making = making.plus(own.garmentMinutes.times(rate))
      }
      if (value.minutesDelta !== null) {
        if (rate === null) {
          missing.add(RATE_WORDS(value.code, size))
          making = null
        } else making = new Decimal(value.minutesDelta).times(rate)
      }
      return {
        size,
        material: material === null ? null : six(material),
        making: making === null ? null : six(making),
        total: material === null || making === null ? null : six(material.plus(making)),
      }
    })
    return {
      valueId: value.id,
      material: { source: typedMaterial !== null ? 'TYPED' : hasParts ? 'DERIVED' : 'NONE', typed: typedMaterial, currency: value.materialDeltaCurrency },
      making: { source: value.minutesDelta !== null ? 'TYPED' : hasParts ? 'DERIVED' : 'NONE', minutesTyped: value.minutesDelta, garmentMinutes: own.garmentMinutes.toString() },
      bySize,
      complete: bySize.every((entry) => entry.total !== null),
      missing: [...missing],
    }
  })
  return { base, values: out }
}

/** The chosen values' costs added up per size (KS4:01); null in a size where one of them is not known. */
export function chosenTotal(costs: readonly OptionCost[], chosen: readonly string[], sizes: readonly string[]): Map<string, string | null> {
  const mine = costs.filter((cost) => chosen.includes(cost.valueId))
  return new Map(
    sizes.map((size) => {
      let sum = new Decimal(0)
      for (const cost of mine) {
        const at = cost.bySize.find((entry) => entry.size === size)
        if (!at || at.total === null) return [size, null]
        sum = sum.plus(at.total)
      }
      return [size, six(sum)]
    }),
  )
}

/** The typed figures an option value may carry (B-W2b-378's OptionValue_cost_delta_check, said in words first). */
export function typedDeltaProblems(body: { readonly materialDelta: string | null; readonly materialDeltaCurrency: string | null; readonly minutesDelta: string | null }): { readonly path: string; readonly message: string }[] {
  const issues: { path: string; message: string }[] = []
  if ((body.materialDelta === null) !== (body.materialDeltaCurrency === null)) issues.push({ path: body.materialDelta === null ? 'materialDelta' : 'materialDeltaCurrency', message: 'A material delta comes with its currency, and a currency only with an amount.' })
  if (body.materialDelta !== null) {
    if (!/^-?\d{1,12}(\.\d{1,6})?$/.test(body.materialDelta)) issues.push({ path: 'materialDelta', message: 'An amount with at most 12 digits and 6 decimals (below 0 when the option takes cost off).' })
    else if (new Decimal(body.materialDelta).isZero()) issues.push({ path: 'materialDelta', message: 'Never 0: leave it out when the option adds no material cost.' })
  }
  if (body.materialDeltaCurrency !== null && !/^[A-Z]{3}$/.test(body.materialDeltaCurrency)) issues.push({ path: 'materialDeltaCurrency', message: 'The currency of the amount (ISO 4217: EUR).' })
  if (body.minutesDelta !== null) {
    if (!/^-?\d{1,5}(\.\d{1,3})?$/.test(body.minutesDelta)) issues.push({ path: 'minutesDelta', message: 'Minutes with at most 3 decimals (below 0 when the option takes minutes off).' })
    else if (new Decimal(body.minutesDelta).isZero()) issues.push({ path: 'minutesDelta', message: 'Never 0: leave it out when the option adds no minutes.' })
    else if (new Decimal(body.minutesDelta).abs().gt(10000)) issues.push({ path: 'minutesDelta', message: 'At most 10000 minutes either way.' })
  }
  return issues
}
