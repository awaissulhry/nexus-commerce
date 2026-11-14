import { Decimal } from 'decimal.js'
import type { BusinessDate } from '../../core/time'
import type { BomLineData } from '../../product/bom/rules'
import type { ItemKind } from '../../product/materials/rules'
import type { WorkCentreKind } from '../../product/routing/operations'
import { baseFactor, decimalOf, decimalText, type Uom } from '../../product/units/units'
import { rateFor, type RateCandidate } from '../../people/earnings/rules'
import { bestDefault, type LiveDefault, type PackagingKind } from '../../shipping/packaging/rules'
import { absorb, MISSING_WORDS, rulesInForce, type AbsorptionFigures, type OverheadRuleFacts } from '../overhead-rules/rules'
import { OVERHEAD_TWICE } from '../cost-per-minute/rules'
import { pickRate, type CostingMaterial, type LabourRate, type OverheadRule } from '../inputs'
import { exactCell, prepareSheet } from '../sheet'
import {
  boughtArea,
  four,
  lineCost,
  pickLeatherBasis,
  pickMaterialUplift,
  pickWorkshopUplift,
  PIECE_RATE_SITE_WORDS,
  six,
  usableFactor,
  type ComponentMissing,
  type ComponentWarning,
  type GradeShares,
  type LeatherBasisFacts,
  type UpliftFacts,
} from './rules'

/**
 * A cost sheet's lines from its components (B-W2b-418), pure: what one garment of each size of a style revision costs in one
 * colourway, for one company on one day, written as the cost sheet's lines (B-W2b-378's CostSheetLine: a category, where it
 * came from, a size or every size, quantity × unit cost = its cost, a percent on a percent line).
 *
 *   LEATHER      a BOM line of a leather article: with its cost basis, the bought area (net ÷ yield × usable share by the
 *                grade mix) in the basis' unit at the price per that unit; without one, the BOM's area with its wastage
 *   MATERIAL     the other BOM lines at their standard price per base unit (W1); a packaging article of the BOM is PACKAGING
 *   LABOUR       each in-house step: its standard minutes × the cost per minute ÷ planned efficiency (W1, ROUTING); with
 *                piece-rate labour on and a published rate per piece for the step in every size, that rate (PIECE_RATE;
 *                per operation, never per worker: GATE-PIECE-PAY)
 *   SUBCONTRACT  each step a workshop does: its fee per piece (the routing's, in euros), and per visit to the workshop (its
 *                steps in a row) the transport out and back per piece from the workshop's uplift
 *   FREIGHT/DUTY each material's uplift (its own, else its kind's) on the material's cost: freight, insurance (counted as
 *                freight) and duty percents; from landed cost when the uplift was read from one
 *   PACKAGING    the packaging master's defaults of the style or size run: polybag, hanger and box per garment, the export
 *                carton's cost ÷ the garments it holds
 *   OVERHEAD     the overhead rules in force (B-W2b-419) per kind of work centre on its labour and minutes, and per garment;
 *                none in force: the costing settings' percent on material + labour (W1)
 *
 * Each size is costed whole, then a line that is the same in every size is written once for every size (size null); the
 * others once per size. Every line's cost is its quantity (4 places) × its unit cost (6 places) rounded once to 6 places, the
 * database's rule. A missing input is never 0: it is listed in words and the lines it touches are left out.
 */

/** The nine categories of a cost sheet line (factory-db CostCategory). */
export const SHEET_CATEGORIES = ['MATERIAL', 'LEATHER', 'LABOUR', 'OVERHEAD', 'SUBCONTRACT', 'FREIGHT', 'DUTY', 'PACKAGING', 'COMMISSION'] as const
export type SheetCategory = (typeof SHEET_CATEGORIES)[number]
/** Where a line's figures came from (factory-db CostLineSource). */
export const LINE_SOURCES = ['BOM_LINE', 'ROUTING', 'PIECE_RATE', 'OVERHEAD_RULE', 'COSTING_SETTINGS', 'UPLIFT', 'LANDED_COST', 'PACKAGING', 'TYPED'] as const
export type LineSource = (typeof LINE_SOURCES)[number]

/** A routing step as the components read it. */
export interface ComponentStep {
  readonly id: string
  readonly seq: number
  readonly operationId: string
  readonly code: string
  readonly name: string
  readonly workCentreKind: WorkCentreKind
  readonly standardMinutes: string
}

/** A step a workshop does: the workshop and its fee per piece (euros; null: agreed per order). */
export interface ComponentSubcontract {
  readonly supplierId: string
  readonly pricePerPiece: string | null
}

export interface ComponentWorkshop {
  readonly id: string
  readonly name: string
  /** A signed revision of written terms with the company holds the day (L. 192/1998 art. 2). */
  readonly termsInForce: boolean
}

export interface PackagingTypeFacts {
  readonly id: string
  readonly name: string
  readonly kind: PackagingKind
  readonly costPerUnit: string | null
  readonly costCurrency: string | null
}

export interface ComponentFacts {
  readonly currency: string
  readonly companyId: string
  readonly on: BusinessDate
  readonly styleId: string
  /** The style's range, in order. */
  readonly sizes: readonly string[]
  /** The colourway costed (a colourway-only BOM line counts only in its colourway). */
  readonly colourwayId: string
  readonly lines: readonly BomLineData[]
  readonly materials: ReadonlyMap<string, CostingMaterial>
  readonly steps: readonly ComponentStep[]
  /** By step id. */
  readonly subcontracts: ReadonlyMap<string, ComponentSubcontract>
  /** By party id. */
  readonly workshops: ReadonlyMap<string, ComponentWorkshop>
  readonly rates: readonly LabourRate[]
  /** The labour rates written by a cost-per-minute calculation that carries overhead per minute (B-W2b-419). */
  readonly ratesWithOverhead: ReadonlySet<string>
  /** The ACTIVE overhead rules of the company and of every company. */
  readonly overheadRules: readonly OverheadRuleFacts[]
  /** W1's costing settings percent, used while no overhead rule is in force. */
  readonly settingsOverhead: OverheadRule | null
  readonly leatherBases: readonly LeatherBasisFacts[]
  /** By leather article id. */
  readonly gradeShares: ReadonlyMap<string, GradeShares>
  readonly uplifts: readonly UpliftFacts[]
  readonly pieceRate: {
    readonly on: boolean
    readonly siteId: string | null
    readonly problem: keyof typeof PIECE_RATE_SITE_WORDS | null
    readonly candidates: readonly RateCandidate[]
  }
  readonly packaging: {
    readonly defaults: readonly LiveDefault[]
    /** The company's active packaging types, by id. */
    readonly types: ReadonlyMap<string, PackagingTypeFacts>
    readonly sizeScaleId: string | null
    /** size code → its place in the style's scale. */
    readonly sizeSeqs: ReadonlyMap<string, number>
  }
  /** How many garments an export carton holds (no column keeps it: the person says it). */
  readonly piecesPerCarton: number | null
}

/** One line, as a cost sheet keeps it (seq given when it is written). */
export interface ComponentLine {
  readonly category: SheetCategory
  readonly source: LineSource
  readonly sourceRecordType: string | null
  readonly sourceRecordId: string | null
  readonly itemId: string | null
  readonly workCentreKind: WorkCentreKind | null
  readonly label: string | null
  /** null: every size. */
  readonly size: string | null
  readonly quantity: string
  readonly uom: Uom | null
  readonly unitCost: string
  readonly cost: string
  readonly pct: string | null
  readonly note: string | null
}

export interface MissingComponent {
  readonly key: string
  readonly code: ComponentMissing
  readonly itemId: string | null
  readonly recordType: string | null
  readonly recordId: string | null
  readonly size: string | null
  readonly workCentreKind: WorkCentreKind | null
  readonly message: string
}

export interface WarningComponent {
  readonly code: ComponentWarning
  readonly recordId: string | null
  readonly message: string
}

export interface Components {
  readonly lines: ComponentLine[]
  readonly missing: MissingComponent[]
  readonly warnings: WarningComponent[]
}

/** A line before its cost and size are settled. */
interface Draft {
  readonly key: string
  readonly rank: number
  readonly category: SheetCategory
  readonly source: LineSource
  readonly sourceRecordType: string | null
  readonly sourceRecordId: string | null
  readonly itemId: string | null
  readonly workCentreKind: WorkCentreKind | null
  readonly label: string | null
  readonly quantity: string
  readonly uom: Uom | null
  readonly unitCost: string
  readonly pct: string | null
  readonly note: string | null
}

/** The order lines are listed in: leather, materials, the BOM's packaging, labour, outside operations, freight, duty, the packaging master, overhead. */
const RANK = { LEATHER: 1, MATERIAL: 2, BOM_PACKAGING: 3, LABOUR: 4, SUBCONTRACT: 5, FREIGHT: 6, DUTY: 7, PACKAGING: 8, OVERHEAD: 9 } as const

const W1_MATERIAL_CODES = new Set(['NO_BOM', 'BOM_QUANTITY', 'MATERIAL_UNIT', 'MATERIAL_PRICE', 'MATERIAL_CURRENCY'])
const PER_GARMENT_PACKAGING: readonly PackagingKind[] = ['POLYBAG', 'HANGER', 'BOX']
const ZERO = new Decimal(0)
const pctText = (value: Decimal): string => decimalText(value.toDecimalPlaces(1, Decimal.ROUND_HALF_UP))

const categoryOfKind = (kind: ItemKind): SheetCategory => (kind === 'LEATHER' ? 'LEATHER' : kind === 'PACKAGING' ? 'PACKAGING' : 'MATERIAL')

export function componentsOf(facts: ComponentFacts): Components {
  const missing = new Map<string, MissingComponent>()
  const warnings = new Map<string, WarningComponent>()
  const miss = (entry: Omit<MissingComponent, 'itemId' | 'recordType' | 'recordId' | 'size' | 'workCentreKind'> & Partial<MissingComponent>): void => {
    if (!missing.has(entry.key)) missing.set(entry.key, { itemId: null, recordType: null, recordId: null, size: null, workCentreKind: null, ...entry })
  }
  const warn = (code: ComponentWarning, recordId: string | null, message: string): void => {
    const key = `${code}:${recordId ?? ''}`
    if (!warnings.has(key)) warnings.set(key, { code, recordId, message })
  }

  // W1's material math (factory-domain costing/sheet): the prices, the units and each size's parts, never its labour.
  const prepared = prepareSheet({
    currency: facts.currency,
    companyId: facts.companyId,
    on: facts.on,
    sizes: facts.sizes,
    colourwayIds: [facts.colourwayId],
    lines: facts.lines,
    materials: facts.materials,
    steps: [],
    rates: [],
    overheads: [],
  })
  for (const entry of prepared.missing.values()) {
    if (!W1_MATERIAL_CODES.has(entry.code)) continue
    miss({ key: entry.key, code: entry.code as ComponentMissing, itemId: entry.itemId, recordType: entry.lineId ? 'BomLine' : null, recordId: entry.lineId, size: entry.size, message: entry.message })
  }

  const inHouse = facts.steps.filter((step) => !facts.subcontracts.has(step.id))
  if (facts.steps.length === 0) miss({ key: 'NO_ROUTING', code: 'NO_ROUTING', message: 'The revision has no routing: add its operations to cost the labour.' })
  const pieceRates = facts.pieceRate.on && facts.pieceRate.siteId !== null
  if (facts.pieceRate.on && facts.pieceRate.problem !== null) warn('PIECE_RATE_SITE', null, PIECE_RATE_SITE_WORDS[facts.pieceRate.problem])

  const bySize = new Map<string, Draft[]>()
  for (const size of facts.sizes) {
    const drafts: Draft[] = []
    const cell = exactCell(prepared, facts.colourwayId, size)

    // ---- materials and leather ----
    const materialCosts: { readonly itemId: string; readonly kind: ItemKind; readonly cost: Decimal }[] = []
    for (const part of cell.materials) {
      const { line, material } = part
      if (part.price === null || part.net === null || part.base === null) continue // listed missing by W1's math
      const category = categoryOfKind(material.kind)
      const basis = material.kind === 'LEATHER' ? pickLeatherBasis(facts.leatherBases, material.id, facts.styleId, facts.companyId, facts.on) : null
      let quantity: string
      let uom: Uom
      let unitCost: string
      let note: string | null = null
      if (basis !== null) {
        const shares = facts.gradeShares.get(material.id) ?? { grades: new Map(), itemRules: new Map() }
        const usable = usableFactor(basis.gradeMix, shares)
        const lineFactor = baseFactor(line.uom, material.units)
        const areaFactor = baseFactor(basis.areaUnit, material.units)
        if (usable.factor === null) {
          miss({ key: `LEATHER_GRADE:${basis.id}`, code: 'LEATHER_GRADE', itemId: material.id, recordType: 'LeatherCostBasis', recordId: basis.id, message: `The cost basis of ${material.code} names ${usable.unknown.length > 0 ? `the grade${usable.unknown.length === 1 ? '' : 's'} ${usable.unknown.join(', ')}, which the tenant has no longer active` : 'no usable share'}: correct its grade mix.` })
          continue
        }
        if (lineFactor === null || areaFactor === null) {
          miss({ key: `LEATHER_UNIT:${basis.id}`, code: 'LEATHER_UNIT', itemId: material.id, recordType: 'LeatherCostBasis', recordId: basis.id, message: `${material.code} does not convert ${basis.areaUnit} to its base unit ${material.units.baseUom}: give it a factor, or price its basis in another unit.` })
          continue
        }
        const bought = boughtArea(part.net.times(lineFactor), basis.expectedYieldPct, usable.factor)
        quantity = four(bought.div(areaFactor))
        uom = basis.areaUnit
        unitCost = six(part.price.times(areaFactor))
        note = `Bought area: the net area ÷ (${decimalText(basis.expectedYieldPct)} % yield × ${pctText(usable.factor.times(100))} % usable by the grade mix ${Object.entries(basis.gradeMix).map(([code, share]) => `${code} ${decimalText(share)}`).join(' / ')}); the yield takes the place of the BOM line's wastage.`
      } else {
        if (material.kind === 'LEATHER') warn('NO_LEATHER_BASIS', material.id, `${material.code} has no cost basis: its area is the BOM's with its wastage (no yield, no grade mix).`)
        quantity = four(part.base)
        uom = material.units.baseUom
        unitCost = six(part.price)
      }
      drafts.push({
        key: `bom:${line.id}`,
        rank: category === 'LEATHER' ? RANK.LEATHER : category === 'PACKAGING' ? RANK.BOM_PACKAGING : RANK.MATERIAL,
        category,
        source: 'BOM_LINE',
        sourceRecordType: 'BomLine',
        sourceRecordId: line.id,
        itemId: material.id,
        workCentreKind: null,
        label: `${material.code} ${material.name}`.slice(0, 200),
        quantity,
        uom,
        unitCost,
        pct: null,
        note,
      })
      materialCosts.push({ itemId: material.id, kind: material.kind, cost: decimalOf(lineCost(quantity, unitCost)) })
    }

    // ---- labour: piece rate where it holds in every size, else minutes ----
    const labourByKind = new Map<WorkCentreKind, { cost: Decimal; minutes: Decimal; rateIds: Set<string> }>()
    const addLabour = (kind: WorkCentreKind, cost: string, minutes: string, rateId: string | null): void => {
      const entry = labourByKind.get(kind) ?? { cost: ZERO, minutes: ZERO, rateIds: new Set<string>() }
      entry.cost = entry.cost.plus(cost)
      entry.minutes = entry.minutes.plus(minutes)
      if (rateId) entry.rateIds.add(rateId)
      labourByKind.set(kind, entry)
    }
    for (const step of inHouse) {
      const label = `${step.code} ${step.name}`.slice(0, 200)
      if (pieceRates) {
        const everySize = facts.sizes.map((other) => rateFor(facts.pieceRate.candidates, { day: facts.on, operationId: step.operationId, styleId: facts.styleId, lineId: null, size: other }))
        const rate = everySize.every((found) => found !== null) ? rateFor(facts.pieceRate.candidates, { day: facts.on, operationId: step.operationId, styleId: facts.styleId, lineId: null, size }) : null
        if (rate !== null) {
          if (rate.currency !== facts.currency) {
            miss({ key: `PIECE_RATE_CURRENCY:${rate.entryId}`, code: 'PIECE_RATE_CURRENCY', recordType: 'PieceRateEntry', recordId: rate.entryId, workCentreKind: step.workCentreKind, message: `The piece rate of ${step.code} is in ${rate.currency}; this cost sheet is in ${facts.currency} and has no exchange rate.` })
            continue
          }
          const unitCost = six(new Decimal(rate.ratePerPiece))
          drafts.push({ key: `step:${step.id}`, rank: RANK.LABOUR, category: 'LABOUR', source: 'PIECE_RATE', sourceRecordType: 'PieceRateEntry', sourceRecordId: rate.entryId, itemId: null, workCentreKind: step.workCentreKind, label, quantity: '1', uom: null, unitCost, pct: null, note: 'One piece at the published piece rate of the operation.' })
          addLabour(step.workCentreKind, unitCost, step.standardMinutes, null)
          continue
        }
        warn('NO_PIECE_RATE', step.id, `${step.code} has no published piece rate for every size of the style: it is costed by its minutes.`)
      }
      const rate = pickRate(facts.rates, step.workCentreKind, facts.companyId, facts.on)
      if (rate === null) {
        miss({ key: `LABOUR_RATE:${step.workCentreKind}`, code: 'LABOUR_RATE', workCentreKind: step.workCentreKind, message: `No cost per minute for ${step.workCentreKind} work centres is in force on ${facts.on}.` })
        continue
      }
      if (rate.currency !== facts.currency) {
        miss({ key: `LABOUR_CURRENCY:${step.workCentreKind}`, code: 'LABOUR_CURRENCY', workCentreKind: step.workCentreKind, message: `The cost per minute for ${step.workCentreKind} is in ${rate.currency}; this cost sheet is in ${facts.currency} and has no exchange rate.` })
        continue
      }
      const efficiency = decimalOf(rate.plannedEfficiencyPct, 'plannedEfficiencyPct')
      if (!efficiency.gt(0)) {
        miss({ key: `LABOUR_RATE:${step.workCentreKind}`, code: 'LABOUR_RATE', workCentreKind: step.workCentreKind, message: `The ${step.workCentreKind} rate's planned efficiency is not above 0.` })
        continue
      }
      const quantity = four(decimalOf(step.standardMinutes))
      const unitCost = six(decimalOf(rate.costPerMinute).div(efficiency.div(100)))
      drafts.push({ key: `step:${step.id}`, rank: RANK.LABOUR, category: 'LABOUR', source: 'ROUTING', sourceRecordType: 'RoutingOperation', sourceRecordId: step.id, itemId: null, workCentreKind: step.workCentreKind, label, quantity, uom: null, unitCost, pct: null, note: null })
      addLabour(step.workCentreKind, lineCost(quantity, unitCost), step.standardMinutes, rate.id)
    }

    // ---- outside operations: the fee per step, the transport per visit ----
    let visit: { readonly supplierId: string; readonly firstStepId: string } | null = null
    const visits: { readonly supplierId: string; readonly firstStepId: string }[] = []
    for (const step of [...facts.steps].sort((a, b) => a.seq - b.seq)) {
      const outside = facts.subcontracts.get(step.id)
      if (!outside) {
        visit = null
        continue
      }
      if (visit === null || visit.supplierId !== outside.supplierId) {
        visit = { supplierId: outside.supplierId, firstStepId: step.id }
        visits.push(visit)
      }
      const workshop = facts.workshops.get(outside.supplierId)
      const workshopName = workshop?.name ?? 'the workshop'
      if (workshop && !workshop.termsInForce) warn('NO_WRITTEN_TERMS', workshop.id, `No signed written terms with ${workshopName} hold today (L. 192/1998 art. 2): the fee is the routing's.`)
      if (outside.pricePerPiece === null) {
        miss({ key: `SUBCONTRACT_FEE:${step.id}`, code: 'SUBCONTRACT_FEE', recordType: 'RoutingOperation', recordId: step.id, message: `${step.code} at ${workshopName} has no fee per piece on the routing (agreed per order): type it on the step.` })
        continue
      }
      if (facts.currency !== 'EUR') {
        miss({ key: `SUBCONTRACT_CURRENCY:${step.id}`, code: 'SUBCONTRACT_CURRENCY', recordType: 'RoutingOperation', recordId: step.id, message: `The routing's fee of ${step.code} is in EUR; this cost sheet is in ${facts.currency} and has no exchange rate.` })
        continue
      }
      drafts.push({ key: `outside:${step.id}`, rank: RANK.SUBCONTRACT, category: 'SUBCONTRACT', source: 'ROUTING', sourceRecordType: 'RoutingOperation', sourceRecordId: step.id, itemId: null, workCentreKind: step.workCentreKind, label: `${step.code} ${step.name} at ${workshopName}`.slice(0, 200), quantity: '1', uom: null, unitCost: six(new Decimal(outside.pricePerPiece)), pct: null, note: null })
    }
    for (const trip of visits) {
      const workshopName = facts.workshops.get(trip.supplierId)?.name ?? 'the workshop'
      const uplift = pickWorkshopUplift(facts.uplifts, trip.supplierId, facts.companyId, facts.on)
      if (uplift === null) {
        warn('NO_TRANSPORT', trip.supplierId, `No transport to ${workshopName} and back is kept: none is costed. Add the workshop's transport per piece.`)
        continue
      }
      if (uplift.currency !== facts.currency) {
        miss({ key: `TRANSPORT_CURRENCY:${uplift.id}`, code: 'TRANSPORT_CURRENCY', recordType: 'MaterialCostUplift', recordId: uplift.id, message: `The transport to ${workshopName} is in ${uplift.currency ?? '?'}; this cost sheet is in ${facts.currency} and has no exchange rate.` })
        continue
      }
      for (const [way, figure] of [['out', uplift.transportOutPerPiece], ['back', uplift.transportBackPerPiece]] as const) {
        if (figure === null) continue
        drafts.push({ key: `transport:${trip.firstStepId}:${way}`, rank: RANK.SUBCONTRACT, category: 'SUBCONTRACT', source: 'UPLIFT', sourceRecordType: 'MaterialCostUplift', sourceRecordId: uplift.id, itemId: null, workCentreKind: null, label: (way === 'out' ? `Transport to ${workshopName}` : `Transport back from ${workshopName}`).slice(0, 200), quantity: '1', uom: null, unitCost: six(new Decimal(figure)), pct: null, note: null })
      }
    }

    // ---- freight, insurance and duty on the materials ----
    const groups = new Map<string, { uplift: UpliftFacts; base: Decimal; items: Set<string> }>()
    for (const cost of materialCosts) {
      const uplift = pickMaterialUplift(facts.uplifts, { itemId: cost.itemId, kind: cost.kind }, facts.companyId, facts.on)
      if (uplift === null) continue
      const group = groups.get(uplift.id) ?? { uplift, base: ZERO, items: new Set<string>() }
      group.base = group.base.plus(cost.cost)
      group.items.add(cost.itemId)
      groups.set(uplift.id, group)
    }
    for (const { uplift, base, items } of groups.values()) {
      const single = items.size === 1 ? [...items][0]! : null
      const what = uplift.target === 'MATERIAL' ? 'the material' : `${(uplift.itemKind ?? '').toLowerCase()} materials`
      for (const [field, category, words] of [['freightPct', 'FREIGHT', 'Freight'], ['insurancePct', 'FREIGHT', 'Insurance'], ['dutyPct', 'DUTY', 'Duty']] as const) {
        const value = uplift[field]
        if (value === null || !new Decimal(value).gt(0)) continue
        drafts.push({
          key: `uplift:${uplift.id}:${field}`,
          rank: category === 'FREIGHT' ? RANK.FREIGHT : RANK.DUTY,
          category,
          source: uplift.source === 'LANDED_COST' ? 'LANDED_COST' : 'UPLIFT',
          sourceRecordType: 'MaterialCostUplift',
          sourceRecordId: uplift.id,
          itemId: single,
          workCentreKind: null,
          label: `${words} on ${what}`,
          quantity: '1',
          uom: null,
          unitCost: six(base.times(value).div(100)),
          pct: decimalText(value),
          note: uplift.source === 'LANDED_COST' ? 'The percent read from the landed cost of earlier receipts.' : null,
        })
      }
    }

    // ---- the packaging master ----
    const seq = facts.packaging.sizeSeqs.get(size) ?? null
    const garment = { styleId: facts.styleId, sizeScaleId: facts.packaging.sizeScaleId ?? '', sizeSeq: seq }
    let masterPackaging = false
    for (const kind of [...PER_GARMENT_PACKAGING, 'CARTON' as const]) {
      const found = bestDefault(facts.packaging.defaults, kind, garment)
      const type = found ? facts.packaging.types.get(found.packagingTypeId) : undefined
      if (!type) continue
      masterPackaging = true
      if (type.costPerUnit === null || type.costCurrency !== facts.currency) {
        miss({ key: `PACKAGING_PRICE:${type.id}`, code: 'PACKAGING_PRICE', recordType: 'PackagingType', recordId: type.id, message: type.costPerUnit === null ? `${type.name} has no cost per unit: give it one in the packaging types.` : `${type.name} costs in ${type.costCurrency ?? '?'}; this cost sheet is in ${facts.currency} and has no exchange rate.` })
        continue
      }
      if (kind === 'CARTON') {
        if (facts.piecesPerCarton === null) {
          miss({ key: 'CARTON_PIECES', code: 'CARTON_PIECES', recordType: 'PackagingType', recordId: type.id, message: `How many garments does ${type.name} hold? Say it to cost each garment's share of the carton.` })
          continue
        }
        drafts.push({ key: `packaging:${kind}:${type.id}`, rank: RANK.PACKAGING, category: 'PACKAGING', source: 'PACKAGING', sourceRecordType: 'PackagingType', sourceRecordId: type.id, itemId: null, workCentreKind: null, label: `${type.name}: one garment's share`.slice(0, 200), quantity: '1', uom: null, unitCost: six(new Decimal(type.costPerUnit).div(facts.piecesPerCarton)), pct: null, note: `The carton's cost ÷ ${facts.piecesPerCarton} garments.` })
      } else {
        drafts.push({ key: `packaging:${kind}:${type.id}`, rank: RANK.PACKAGING, category: 'PACKAGING', source: 'PACKAGING', sourceRecordType: 'PackagingType', sourceRecordId: type.id, itemId: null, workCentreKind: null, label: type.name.slice(0, 200), quantity: '1', uom: null, unitCost: six(new Decimal(type.costPerUnit)), pct: null, note: null })
      }
    }
    if (masterPackaging && materialCosts.some((cost) => cost.kind === 'PACKAGING')) {
      warn('PACKAGING_TWICE', null, 'The BOM has packaging articles and the packaging master gives this style packaging too: check it is not counted twice.')
    }

    // ---- overhead: the rules in force per kind and per garment, else the settings' percent ----
    const overheadDrafts = (rules: readonly OverheadRuleFacts[], figures: AbsorptionFigures, kind: WorkCentreKind | null): void => {
      for (const line of absorb(rules, figures, facts.currency).lines) {
        if (line.amount === null || line.quantity === null || line.unitCost === null) {
          miss({ key: `OVERHEAD_FIGURE:${line.ruleId}`, code: 'OVERHEAD_FIGURE', recordType: 'OverheadRule', recordId: line.ruleId, workCentreKind: kind, message: line.missing ? MISSING_WORDS[line.missing] : 'An overhead rule cannot be absorbed.' })
          continue
        }
        if (!new Decimal(line.amount).gt(0) && line.pct === null) continue
        drafts.push({
          key: `overhead:${line.ruleId}:${kind ?? 'garment'}`,
          rank: RANK.OVERHEAD,
          category: 'OVERHEAD',
          source: 'OVERHEAD_RULE',
          sourceRecordType: 'OverheadRule',
          sourceRecordId: line.ruleId,
          itemId: null,
          workCentreKind: kind,
          label: overheadLabel(line.basis, kind),
          quantity: decimalText(line.quantity),
          uom: null,
          unitCost: decimalText(line.unitCost),
          pct: line.pct === null ? null : decimalText(line.pct),
          note: null,
        })
      }
    }
    let ruled = false
    for (const [kind, labour] of labourByKind) {
      const chosen = rulesInForce(facts.overheadRules, facts.companyId, kind, facts.on).filter((rule) => !(rule.basis === 'PER_UNIT' && rule.workCentreKind === null))
      if (chosen.length === 0) continue
      ruled = true
      if (chosen.some((rule) => rule.basis === 'PER_MINUTE') && [...labour.rateIds].some((id) => facts.ratesWithOverhead.has(id))) warn('OVERHEAD_TWICE', null, OVERHEAD_TWICE)
      overheadDrafts(chosen, { labourCost: six(labour.cost), minutes: decimalText(labour.minutes), units: '1' }, kind)
    }
    const perGarment = rulesInForce(facts.overheadRules, facts.companyId, null, facts.on).filter((rule) => rule.basis === 'PER_UNIT')
    if (perGarment.length > 0) {
      ruled = true
      overheadDrafts(perGarment, { units: '1' }, null)
    }
    const settings = facts.settingsOverhead
    if (!ruled && settings !== null && new Decimal(settings.overheadPct).gt(0)) {
      const base = drafts.filter((draft) => draft.category === 'MATERIAL' || draft.category === 'LEATHER' || draft.category === 'LABOUR' || (draft.category === 'PACKAGING' && draft.source === 'BOM_LINE')).reduce((sum, draft) => sum.plus(lineCost(draft.quantity, draft.unitCost)), ZERO)
      drafts.push({ key: `settings:${settings.id}`, rank: RANK.OVERHEAD, category: 'OVERHEAD', source: 'COSTING_SETTINGS', sourceRecordType: 'CostingSettings', sourceRecordId: settings.id, itemId: null, workCentreKind: null, label: 'Overhead on material and labour', quantity: '1', uom: null, unitCost: six(base.times(settings.overheadPct).div(100)), pct: decimalText(settings.overheadPct), note: 'No overhead rule is in force: the costing settings’ percent on material and labour.' })
    }
    bySize.set(size, drafts)
  }

  return { lines: collapse(facts.sizes, bySize), missing: [...missing.values()], warnings: [...warnings.values()] }
}

function overheadLabel(basis: OverheadRuleFacts['basis'], kind: WorkCentreKind | null): string {
  const of = kind === null ? '' : ` (${kind.toLowerCase()})`
  if (basis === 'PERCENT_OF_LABOUR') return `Overhead on labour${of}`
  if (basis === 'PER_MINUTE') return `Overhead per minute${of}`
  if (basis === 'PER_MACHINE_HOUR') return `Overhead per machine hour${of}`
  return `Overhead per garment${of}`
}

const sameDraft = (a: Draft, b: Draft): boolean =>
  a.quantity === b.quantity && a.unitCost === b.unitCost && a.pct === b.pct && a.uom === b.uom && a.label === b.label && a.note === b.note && a.itemId === b.itemId && a.sourceRecordId === b.sourceRecordId && a.source === b.source && a.category === b.category

/** One line for every size where a key is the same in every size; else one per size where it is. */
function collapse(sizes: readonly string[], bySize: ReadonlyMap<string, readonly Draft[]>): ComponentLine[] {
  const order = new Map<string, { draft: Draft; at: number }>()
  for (const size of sizes) for (const draft of bySize.get(size) ?? []) if (!order.has(draft.key)) order.set(draft.key, { draft, at: order.size })
  const keys = [...order.values()].sort((a, b) => a.draft.rank - b.draft.rank || a.at - b.at).map((entry) => entry.draft.key)
  const out: ComponentLine[] = []
  for (const key of keys) {
    const perSize = sizes.map((size) => (bySize.get(size) ?? []).find((draft) => draft.key === key) ?? null)
    const first = perSize[0]
    if (first && perSize.every((draft) => draft !== null && sameDraft(draft, first))) {
      out.push(lineOf(first, null))
      continue
    }
    perSize.forEach((draft, index) => {
      if (draft) out.push(lineOf(draft, sizes[index]!))
    })
  }
  return out
}

function lineOf(draft: Draft, size: string | null): ComponentLine {
  return {
    category: draft.category,
    source: draft.source,
    sourceRecordType: draft.sourceRecordType,
    sourceRecordId: draft.sourceRecordId,
    itemId: draft.itemId,
    workCentreKind: draft.workCentreKind,
    label: draft.label,
    size,
    quantity: draft.quantity,
    uom: draft.uom,
    unitCost: draft.unitCost,
    cost: lineCost(draft.quantity, draft.unitCost),
    pct: draft.pct,
    note: draft.note,
  }
}

/** Places for the lines (10, 20, 30 …), skipping the places other lines of the sheet keep. */
export function numbered<Line>(lines: readonly Line[], taken: ReadonlySet<number> = new Set()): (Line & { readonly seq: number })[] {
  let next = 10
  return lines.map((line) => {
    while (taken.has(next)) next += 10
    const seq = next
    next += 10
    return { ...line, seq }
  })
}
