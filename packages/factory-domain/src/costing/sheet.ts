import type { Decimal } from 'decimal.js'
import { ValidationError } from '../core/errors'
import { toMinorUnits } from '../core/money'
import type { BusinessDate } from '../core/time'
import { asMoney } from '../money/marked'
import { lineNeed, netQuantity } from '../product/bom/requirements'
import type { BomLineData } from '../product/bom/rules'
import { WORK_CENTRE_KINDS, type WorkCentreKind } from '../product/routing/operations'
import { MINUTES_ROUND, minutesForQuantity, sumMinutes } from '../product/routing/minutes'
import type { StepData } from '../product/routing/rules'
import { baseFactor, COST_SCALE, decimalOf, decimalText, QUANTITY_SCALE, roundTo, type RoundTo } from '../product/units/units'
import type { CellCostView, CostCellView, LabourRateUsedView, MaterialLineView, MaterialPriceView, MissingCode, MissingInputView, OverheadUsedView, WaterfallStepView } from './contracts'
import { categoryOf, COST_CATEGORIES, pickOverhead, pickRate, type CostCategory, type CostingMaterial, type LabourRate, type OverheadRule } from './inputs'

/**
 * The style cost sheet (features FIN-001, FIN-002, FIN-004; plan §4.7 stage 04-cost), pure: what one garment of each size
 * in each colourway of a style revision costs.
 *
 *   material   Σ over the BOM lines the cell uses: the line's quantity for the size × (1 + wastage ÷ 100), in the
 *              material's base unit (factory-domain product/bom lineNeed: the units module's exact ratio, or the
 *              material's own factor for a hide, a roll, a cone), × its standard purchase price per base unit
 *   labour     Σ over the kinds of work centre of the routing: their standard minutes (product/routing: the same for
 *              every size in W1) × the cost per minute ÷ (planned efficiency ÷ 100)
 *   overhead   (material + labour) × overhead % (the old app's rule), when an overhead rule is set
 *
 * Exact (decimal.js) to the end: every figure shown is rounded ONCE, half up to 6 places (a unit cost is Decimal(18,6)),
 * from its exact value, never from other rounded figures; the cell's total is the exact sum rounded once, and the
 * waterfall's ROUNDING step (only when not zero) makes its steps add up to it. An amount for a quantity is the exact
 * unit cost × the quantity, rounded once to minor units (core/money toMinorUnits).
 *
 * A missing input is never a 0: a material without a standard price, priced in another currency, a line whose unit
 * does not convert or with no quantity for the size, a kind of work centre without a rate, an empty BOM or routing is
 * listed (`missing`, in words, without a figure) and every cell it touches is not complete: its `total` is null, and
 * `knownTotal` says what the known inputs add up to. No overhead rule is not missing: the sheet then has no overhead.
 *
 * Colours do not change a price (the standard price is the material's), so a colour-dependent line costs the same in
 * every colourway that uses it; a colourway-only line counts only in its colourway.
 */

export const COST_ROUND: RoundTo = { scale: COST_SCALE, rounding: 'HALF_UP' }
const QUANTITY_ROUND: RoundTo = { scale: QUANTITY_SCALE, rounding: 'HALF_UP' }

/** A routing step as costing reads it. */
export type CostingStep = Pick<StepData, 'id' | 'workCentreKind' | 'standardMinutes'>

/** Everything a sheet is computed from. */
export interface CostFacts {
  /** The sheet's currency (inputs in another one are missing: no exchange rates in W1). */
  readonly currency: string
  /** The company whose rates and overhead are used; null: the tenant-wide ones only. */
  readonly companyId: string | null
  /** The day whose labour rates are used. */
  readonly on: BusinessDate
  /** The style's range, in order. */
  readonly sizes: readonly string[]
  /** The colourways costed (the active ones), in the style's order. */
  readonly colourwayIds: readonly string[]
  readonly lines: readonly BomLineData[]
  /** Every material a line names. */
  readonly materials: ReadonlyMap<string, CostingMaterial>
  readonly steps: readonly CostingStep[]
  /** Every rate that could apply (the company's and the tenant-wide ones); pickRate chooses. */
  readonly rates: readonly LabourRate[]
  /** The company's and the tenant-wide overhead rules; pickOverhead chooses. */
  readonly overheads: readonly OverheadRule[]
}

interface Missing {
  readonly key: string
  readonly code: MissingCode
  readonly itemId: string | null
  readonly lineId: string | null
  readonly size: string | null
  readonly workCentreKind: WorkCentreKind | null
  readonly message: string
}

const missingOf = (code: MissingCode, parts: Partial<Omit<Missing, 'key' | 'code' | 'message'>>, message: string): Missing => {
  const item = { itemId: parts.itemId ?? null, lineId: parts.lineId ?? null, size: parts.size ?? null, workCentreKind: parts.workCentreKind ?? null }
  return { key: [code, item.itemId ?? item.lineId ?? item.workCentreKind ?? '', item.size ?? ''].join(':').replace(/:+$/, ''), code, ...item, message }
}

/** The labour of one kind of work centre per garment (the same in every cell in W1). */
interface LabourPart {
  readonly workCentreKind: WorkCentreKind
  readonly steps: number
  readonly minutes: Decimal
  readonly rate: LabourRate | null
  /** null when it cannot be known. */
  readonly amount: Decimal | null
  readonly missing: readonly string[]
}

/** What does not change from cell to cell: the labour, the overhead rule and the price of each material. */
export interface PreparedSheet {
  readonly facts: CostFacts
  readonly labour: readonly LabourPart[]
  readonly minutes: Decimal
  readonly overhead: OverheadRule | null
  readonly overheadPct: Decimal | null
  /** Missing inputs that touch every cell (no BOM, no routing, the labour ones). */
  readonly everywhere: readonly string[]
  /** Per material: its exact price per base unit, or the keys of what is missing. */
  readonly prices: ReadonlyMap<string, { readonly price: Decimal | null; readonly missing: readonly string[] }>
  /** Per BOM line: the key of a unit its material does not convert, and per size of the range without a quantity. */
  readonly lineProblems: ReadonlyMap<string, { readonly unit: string | null; readonly sizes: ReadonlyMap<string, string> }>
  /** Every missing input, by key, in the order found (a cell lists those that touch it). */
  readonly missing: ReadonlyMap<string, Missing>
}

const pct = (value: Decimal): Decimal => value.div(100)

export function prepareSheet(facts: CostFacts): PreparedSheet {
  const missing = new Map<string, Missing>()
  const note = (entry: Missing): string => {
    if (!missing.has(entry.key)) missing.set(entry.key, entry)
    return entry.key
  }
  const everywhere: string[] = []
  if (facts.lines.length === 0) everywhere.push(note(missingOf('NO_BOM', {}, 'The revision has no BOM lines: add its materials to cost them.')))
  if (facts.steps.length === 0) everywhere.push(note(missingOf('NO_ROUTING', {}, 'The revision has no routing: add its operations to cost the labour.')))

  // Labour: the minutes of each kind present in the routing, in floor order, and the rate in force.
  const labour: LabourPart[] = WORK_CENTRE_KINDS.flatMap((workCentreKind) => {
    const ofKind = facts.steps.filter((step) => step.workCentreKind === workCentreKind)
    if (ofKind.length === 0) return []
    const minutes = sumMinutes(ofKind)
    const rate = pickRate(facts.rates, workCentreKind, facts.companyId, facts.on)
    const keys: string[] = []
    let amount: Decimal | null = null
    if (rate === null) {
      keys.push(note(missingOf('LABOUR_RATE', { workCentreKind }, `No cost per minute for ${workCentreKind} work centres is in force on ${facts.on}.`)))
    } else if (rate.currency !== facts.currency) {
      keys.push(note(missingOf('LABOUR_CURRENCY', { workCentreKind }, `The cost per minute for ${workCentreKind} is in ${rate.currency}; this cost sheet is in ${facts.currency} and has no exchange rate.`)))
    } else if (!decimalOf(rate.plannedEfficiencyPct, 'plannedEfficiencyPct').gt(0)) {
      keys.push(note(missingOf('LABOUR_RATE', { workCentreKind }, `The ${workCentreKind} rate's planned efficiency is not above 0.`)))
    } else {
      amount = minutes.times(decimalOf(rate.costPerMinute, 'costPerMinute')).div(pct(decimalOf(rate.plannedEfficiencyPct, 'plannedEfficiencyPct')))
    }
    everywhere.push(...keys)
    return [{ workCentreKind, steps: ofKind.length, minutes, rate, amount, missing: keys }]
  })

  // Prices: per material, once.
  const prices = new Map<string, { price: Decimal | null; missing: string[] }>()
  for (const line of [...facts.lines].sort((a, b) => a.seq - b.seq)) {
    if (prices.has(line.itemId)) continue
    const material = facts.materials.get(line.itemId)
    if (!material) throw new Error(`The material ${line.itemId} of BOM line ${line.seq} was not read.`)
    if (material.standardCost === null) {
      prices.set(line.itemId, { price: null, missing: [note(missingOf('MATERIAL_PRICE', { itemId: material.id }, `${material.code} ${material.name} has no standard purchase price.`))] })
    } else if (material.currency !== facts.currency) {
      prices.set(line.itemId, {
        price: null,
        missing: [note(missingOf('MATERIAL_CURRENCY', { itemId: material.id }, `${material.code} is priced in ${material.currency}; this cost sheet is in ${facts.currency} and has no exchange rate.`))],
      })
    } else {
      prices.set(line.itemId, { price: decimalOf(material.standardCost, 'standardCost'), missing: [] })
    }
  }

  // Lines: a unit the material does not convert; a size of the range a size-dependent line has no quantity for.
  const lineProblems = new Map<string, { unit: string | null; sizes: Map<string, string> }>()
  for (const line of [...facts.lines].sort((a, b) => a.seq - b.seq)) {
    const material = facts.materials.get(line.itemId)!
    const unit =
      baseFactor(line.uom, material.units) === null
        ? note(missingOf('MATERIAL_UNIT', { lineId: line.id }, `BOM line ${line.seq} is in ${line.uom}, which ${material.code} does not convert to its base unit ${material.units.baseUom}.`))
        : null
    const sizes = new Map<string, string>()
    for (const size of facts.sizes) {
      if (netQuantity(line, size) === null) sizes.set(size, note(missingOf('BOM_QUANTITY', { lineId: line.id, size }, `BOM line ${line.seq} (${material.code}) has no quantity for size ${size}.`)))
    }
    lineProblems.set(line.id, { unit, sizes })
  }

  const overhead = pickOverhead(facts.overheads, facts.companyId)
  return {
    facts,
    labour,
    minutes: sumMinutes(facts.steps),
    overhead,
    overheadPct: overhead === null ? null : decimalOf(overhead.overheadPct, 'overheadPct'),
    everywhere: [...new Set(everywhere)],
    prices,
    lineProblems,
    missing,
  }
}

// ---- one cell, exact --------------------------------------------------------------------------------------------------

interface MaterialPart {
  readonly line: BomLineData
  readonly material: CostingMaterial
  readonly category: CostCategory
  readonly net: Decimal | null
  readonly base: Decimal | null
  readonly price: Decimal | null
  readonly amount: Decimal | null
}

/** One garment of one size in one colourway, exact. */
export interface ExactCell {
  readonly colourwayId: string
  readonly size: string
  readonly materials: readonly MaterialPart[]
  readonly labour: readonly LabourPart[]
  readonly minutes: Decimal
  /** The known parts. */
  readonly material: Decimal
  readonly labourCost: Decimal
  readonly overhead: { readonly pct: Decimal; readonly base: Decimal; readonly amount: Decimal } | null
  readonly knownTotal: Decimal
  readonly materialComplete: boolean
  readonly labourComplete: boolean
  /** The keys of the missing inputs that touch it, in the sheet's order. */
  readonly missing: readonly string[]
}

const ZERO = decimalOf('0')
const total = (values: readonly Decimal[]): Decimal => values.reduce((sum, value) => sum.plus(value), ZERO)

/** The cell, exact. Its colourway and size are the caller's to check (a costed colourway, a size of the range). */
export function exactCell(sheet: PreparedSheet, colourwayId: string, size: string): ExactCell {
  const { facts } = sheet
  const keys = new Set<string>(sheet.everywhere)
  const materials: MaterialPart[] = []
  for (const line of [...facts.lines].sort((a, b) => a.seq - b.seq)) {
    if (line.colourwayId !== null && line.colourwayId !== colourwayId) continue
    const net = netQuantity(line, size)
    if (net !== null && net.isZero()) continue // this size does not use the line
    const material = facts.materials.get(line.itemId)!
    const priced = sheet.prices.get(line.itemId)!
    const problems = sheet.lineProblems.get(line.id)!
    const quantityMissing = net === null ? (problems.sizes.get(size) ?? null) : null
    for (const key of [quantityMissing, problems.unit, ...priced.missing]) if (key !== null) keys.add(key)
    const base = net === null || problems.unit !== null ? null : lineNeed(line, size, material.units)!.base
    const amount = base !== null && priced.price !== null ? base.times(priced.price) : null
    materials.push({ line, material, category: categoryOf(material.kind), net, base, price: priced.price, amount })
  }
  const materialComplete = facts.lines.length > 0 && materials.every((part) => part.amount !== null)
  const labourComplete = facts.steps.length > 0 && sheet.labour.every((part) => part.amount !== null)
  const material = total(materials.flatMap((part) => (part.amount === null ? [] : [part.amount])))
  const labourCost = total(sheet.labour.flatMap((part) => (part.amount === null ? [] : [part.amount])))
  const overheadBase = material.plus(labourCost)
  const overhead = sheet.overheadPct === null ? null : { pct: sheet.overheadPct, base: overheadBase, amount: overheadBase.times(pct(sheet.overheadPct)) }
  return {
    colourwayId,
    size,
    materials,
    labour: sheet.labour,
    minutes: sheet.minutes,
    material,
    labourCost,
    overhead,
    knownTotal: overheadBase.plus(overhead?.amount ?? ZERO),
    materialComplete,
    labourComplete,
    missing: [...sheet.missing.keys()].filter((key) => keys.has(key)),
  }
}

// ---- views --------------------------------------------------------------------------------------------------------------

/** A figure as shown: rounded half up to 6 places, once, from its exact value. */
export const shownCost = (value: Decimal): string => decimalText(roundTo(value, COST_ROUND))
const shownOrNull = (value: Decimal | null): string | null => (value === null ? null : shownCost(value))
const costField = (value: Decimal) => asMoney('cost', shownCost(value))
const costOrNullField = (value: Decimal | null) => asMoney('cost', shownOrNull(value))
const minutesText = (value: Decimal): string => decimalText(roundTo(value, MINUTES_ROUND))

/** The known amount of some material parts, and whether every one of them is known. */
function partsAmount(parts: readonly MaterialPart[]): { amount: Decimal; complete: boolean } {
  return { amount: total(parts.flatMap((part) => (part.amount === null ? [] : [part.amount]))), complete: parts.every((part) => part.amount !== null) }
}

/**
 * The steps from nothing to the cell's known total: material categories, labour kinds, overhead, and the rounding that
 * makes the shown steps add up to the shown total. A step whose inputs are not all known says so (`complete` false):
 * its amount is the known part only, never a figure standing in for the unknown one.
 */
function waterfallOf(cell: ExactCell): WaterfallStepView[] {
  const steps: { step: WaterfallStepView['step']; category: CostCategory | null; workCentreKind: WorkCentreKind | null; complete: boolean; amount: string }[] = []
  for (const category of COST_CATEGORIES) {
    const parts = cell.materials.filter((part) => part.category === category)
    if (parts.length === 0) continue
    const { amount, complete } = partsAmount(parts)
    steps.push({ step: 'MATERIAL', category, workCentreKind: null, complete, amount: shownCost(amount) })
  }
  for (const part of cell.labour) steps.push({ step: 'LABOUR', category: null, workCentreKind: part.workCentreKind, complete: part.amount !== null, amount: shownCost(part.amount ?? ZERO) })
  if (cell.overhead) steps.push({ step: 'OVERHEAD', category: null, workCentreKind: null, complete: cell.materialComplete && cell.labourComplete, amount: shownCost(cell.overhead.amount) })
  const rounding = decimalOf(shownCost(cell.knownTotal)).minus(total(steps.map((step) => decimalOf(step.amount))))
  if (!rounding.isZero()) steps.push({ step: 'ROUNDING', category: null, workCentreKind: null, complete: true, amount: decimalText(rounding) })
  let running = ZERO
  return steps.map((step) => {
    running = running.plus(decimalOf(step.amount))
    return { ...step, amount: asMoney('cost', step.amount), runningTotal: asMoney('cost', decimalText(running)) }
  })
}

export function cellView(cell: ExactCell): CellCostView {
  const complete = cell.missing.length === 0
  const byCategory = COST_CATEGORIES.flatMap((category) => {
    const parts = cell.materials.filter((part) => part.category === category)
    if (parts.length === 0) return []
    const { amount, complete: known } = partsAmount(parts)
    return [{ category, complete: known, amount: costField(amount) }]
  })
  const lines: MaterialLineView[] = cell.materials.map((part) => ({
    lineId: part.line.id,
    seq: part.line.seq,
    itemId: part.material.id,
    code: part.material.code,
    category: part.category,
    placement: part.line.placement,
    qty: part.net === null ? null : decimalText(part.net),
    uom: part.line.uom,
    wastagePct: part.line.wastagePct,
    baseQuantity: part.base === null ? null : decimalText(roundTo(part.base, QUANTITY_ROUND)),
    baseUom: part.material.units.baseUom,
    unitCost: costOrNullField(part.price),
    amount: costOrNullField(part.amount),
  }))
  return {
    colourwayId: cell.colourwayId,
    size: cell.size,
    complete,
    missing: [...cell.missing],
    minutes: minutesText(cell.minutes),
    material: { complete: cell.materialComplete, amount: costField(cell.material), byCategory, lines },
    labour: {
      complete: cell.labourComplete,
      amount: costField(cell.labourCost),
      lines: cell.labour.map((part) => ({
        workCentreKind: part.workCentreKind,
        steps: part.steps,
        minutes: minutesText(part.minutes),
        costPerMinute: asMoney('cost', part.rate === null ? null : decimalText(part.rate.costPerMinute)),
        plannedEfficiencyPct: part.rate === null ? null : decimalText(part.rate.plannedEfficiencyPct),
        amount: costOrNullField(part.amount),
      })),
    },
    overhead: cell.overhead === null ? null : { overheadPct: decimalText(cell.overhead.pct), base: costField(cell.overhead.base), amount: costField(cell.overhead.amount) },
    knownTotal: costField(cell.knownTotal),
    total: costOrNullField(complete ? cell.knownTotal : null),
    waterfall: waterfallOf(cell),
  }
}

/** The missing inputs that touch these cells, as the answer lists them (in the order they were found). */
export function missingView(sheet: PreparedSheet, cells: readonly ExactCell[]): MissingInputView[] {
  const keys = new Set(cells.flatMap((cell) => cell.missing))
  return [...sheet.missing.values()].filter((entry) => keys.has(entry.key)).map((entry) => ({ ...entry }))
}

/** The inputs the sheet used, with where each came from and when (A2 `style.cost.sources`, `style.cost.params`). */
export function inputsView(sheet: PreparedSheet): { materials: MaterialPriceView[]; labour: LabourRateUsedView[]; overhead: OverheadUsedView } {
  const { facts } = sheet
  const materials = [...sheet.prices.keys()].map((itemId): MaterialPriceView => {
    const material = facts.materials.get(itemId)!
    const perPurchase = material.standardCost === null ? null : baseFactor(material.units.purchaseUom, material.units)
    return {
      itemId,
      code: material.code,
      name: material.name,
      kind: material.kind,
      category: categoryOf(material.kind),
      source: 'STANDARD',
      baseUom: material.units.baseUom,
      standardCost: asMoney('cost', material.standardCost === null ? null : decimalText(material.standardCost)),
      currency: material.currency,
      asOf: material.priceAsOf,
      purchaseUom: material.units.purchaseUom,
      standardCostPerPurchaseUnit: asMoney('cost', material.standardCost === null || perPurchase === null ? null : shownCost(decimalOf(material.standardCost).times(perPurchase))),
    }
  })
  const labour = sheet.labour.map((part): LabourRateUsedView => ({
    workCentreKind: part.workCentreKind,
    steps: part.steps,
    minutes: minutesText(part.minutes),
    source: part.rate === null ? 'NONE' : 'LABOUR_RATE',
    rateId: part.rate?.id ?? null,
    companyId: part.rate?.companyId ?? null,
    costPerMinute: asMoney('cost', part.rate === null ? null : decimalText(part.rate.costPerMinute)),
    currency: part.rate?.currency ?? null,
    plannedEfficiencyPct: part.rate === null ? null : decimalText(part.rate.plannedEfficiencyPct),
    validFrom: part.rate?.validFrom ?? null,
  }))
  const rule = sheet.overhead
  return {
    materials,
    labour,
    overhead: {
      source: rule === null ? 'NONE' : 'OVERHEAD_RULE',
      ruleId: rule?.id ?? null,
      companyId: rule?.companyId ?? null,
      overheadPct: rule === null ? null : decimalText(rule.overheadPct),
      updatedAt: rule?.updatedAt ?? null,
    },
  }
}

/** Every costed colourway × every size of the range, exact (colourways first, then sizes, in their order). */
export function exactCells(sheet: PreparedSheet): ExactCell[] {
  return sheet.facts.colourwayIds.flatMap((colourwayId) => sheet.facts.sizes.map((size) => exactCell(sheet, colourwayId, size)))
}

/** The sheet as the API answers it (the style, revision and times are the API's). */
export function costSheet(facts: CostFacts) {
  const sheet = prepareSheet(facts)
  const cells = exactCells(sheet)
  return {
    currency: facts.currency,
    companyId: facts.companyId,
    on: facts.on,
    complete: cells.length > 0 && cells.every((cell) => cell.missing.length === 0),
    missing: missingView(sheet, cells),
    inputs: inputsView(sheet),
    cells: cells.map(cellView),
  }
}

// ---- a quantity of garments (a quote line) ----------------------------------------------------------------------------

/**
 * One cell for a quote line (B-W1-21): the cost per garment and, for a quantity, its minutes (capacity) and its amount
 * in minor units, each rounded once from the exact values. The amount and unit cost are null unless the cell is complete.
 */
export function quantityCost(cell: ExactCell, quantity: number | null, currency: string): CostCellView {
  const complete = cell.missing.length === 0
  let amount: number | null = null
  if (complete && quantity !== null) {
    try {
      amount = toMinorUnits(cell.knownTotal.times(quantity), currency)
    } catch (error) {
      if (!(error instanceof RangeError)) throw error
      throw new ValidationError('The cost of this quantity is too large for one document line.', [{ path: 'quantity', message: 'Split the quantity over several lines.' }])
    }
  }
  return {
    colourwayId: cell.colourwayId,
    size: cell.size,
    quantity,
    complete,
    missing: [...cell.missing],
    minutes: minutesText(cell.minutes),
    materialCost: costField(cell.material),
    labourCost: costField(cell.labourCost),
    overheadCost: costOrNullField(cell.overhead?.amount ?? null),
    knownUnitCost: costField(cell.knownTotal),
    unitCost: costOrNullField(complete ? cell.knownTotal : null),
    quantityMinutes: quantity === null ? null : minutesForQuantity(cell.minutes, String(quantity), MINUTES_ROUND),
    amount: asMoney('cost', amount),
  }
}
