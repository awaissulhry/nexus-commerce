import { z } from 'zod'
import { amountMinor, businessDate, currency, id, input, instant, output, unitPrice } from '../core/contracts'
import { money } from '../money/marked'
import { ITEM_KINDS } from '../product/materials/rules'
import { WORK_CENTRE_KINDS } from '../product/routing/operations'
import { REVISION_STATUSES } from '../product/styles/revisions'
import { STYLE_STATUSES } from '../product/styles/rules'
import { UOMS } from '../product/units/units'
import { COST_CATEGORIES, PRICE_SOURCES } from './inputs'
import { isPercent, LABOUR_RATE_STATUSES } from './rates'

/**
 * The cost sheet's contracts (plan A1 D2; A2 SCR-044 "Style › Cost"; features FIN-001, FIN-002, FIN-004, PLT-034): what
 * apps/factory-api's modules/costing answers and the web's typed client reads.
 *
 * Every cost figure is `money.cost`: the API drops it from the answer of a caller without the cost grain (A1 §2.6), so
 * such a caller still sees the structure (materials, quantities, minutes, what is missing) and never a figure. Cost
 * figures are plain decimal strings, each rounded half up to 6 places once, from exact values (a unit cost is
 * Decimal(18,6)); an amount for a quantity is an integer of minor units. A figure that cannot be known is null, never 0,
 * and the cell says it is not complete. Labels never carry a figure (the old app's flaw: euros inside a label escaped
 * the filter).
 */

const kind = () => z.enum(WORK_CENTRE_KINDS)

/** Why a figure cannot be known (the cell is then not complete, and its total is null). */
export const MISSING_CODES = [
  /** The revision has no BOM lines. */
  'NO_BOM',
  /** The revision has no routing steps. */
  'NO_ROUTING',
  /** A size-dependent BOM line has no quantity for a size of the range. */
  'BOM_QUANTITY',
  /** A BOM line's unit does not convert to its material's base unit. */
  'MATERIAL_UNIT',
  /** A material has no standard purchase price. */
  'MATERIAL_PRICE',
  /** A material is priced in another currency than the sheet (no exchange rates in W1). */
  'MATERIAL_CURRENCY',
  /** No usable cost per minute for a kind of work centre the routing uses. */
  'LABOUR_RATE',
  /** The cost per minute is in another currency than the sheet. */
  'LABOUR_CURRENCY',
] as const
export type MissingCode = (typeof MISSING_CODES)[number]

export const missingInputView = output({
  /** Stable within a sheet: the cells name the missing inputs that touch them by it. */
  key: z.string(),
  code: z.enum(MISSING_CODES),
  itemId: id().nullable(),
  lineId: id().nullable(),
  size: z.string().nullable(),
  workCentreKind: kind().nullable(),
  /** In words, without a figure. */
  message: z.string(),
})
export type MissingInputView = z.infer<typeof missingInputView>

/** One BOM line in one cell: its quantity, waste, quantity in base units and what it costs. */
export const materialLineView = output({
  lineId: id(),
  seq: z.number().int(),
  itemId: id(),
  code: z.string(),
  category: z.enum(COST_CATEGORIES),
  placement: z.string().nullable(),
  /** Per garment before waste, in the line's unit; null: no quantity for this size (listed as missing). */
  qty: z.string().nullable(),
  uom: z.enum(UOMS),
  wastagePct: z.string(),
  /** Per garment with waste, in the material's base unit (4 places); null when it cannot be known. */
  baseQuantity: z.string().nullable(),
  baseUom: z.enum(UOMS),
  /** The standard purchase price per base unit. */
  unitCost: money.cost(z.string().nullable()),
  amount: money.cost(z.string().nullable()),
})
export type MaterialLineView = z.infer<typeof materialLineView>

/** The minutes of one kind of work centre in one garment and what they cost. */
export const labourLineView = output({
  workCentreKind: kind(),
  steps: z.number().int(),
  minutes: z.string(),
  costPerMinute: money.cost(z.string().nullable()),
  plannedEfficiencyPct: z.string().nullable(),
  amount: money.cost(z.string().nullable()),
})
export type LabourLineView = z.infer<typeof labourLineView>

export const WATERFALL_STEPS = ['MATERIAL', 'LABOUR', 'OVERHEAD', 'ROUNDING'] as const

/** One step of the waterfall from nothing to the garment's cost (A2 Waterfall, cost side). */
export const waterfallStepView = output({
  step: z.enum(WATERFALL_STEPS),
  category: z.enum(COST_CATEGORIES).nullable(),
  workCentreKind: kind().nullable(),
  /** Every input behind the step is known (else its amount is the known part only). */
  complete: z.boolean(),
  amount: money.cost(z.string()),
  /** The cost so far; the last step's equals the cell's knownTotal. */
  runningTotal: money.cost(z.string()),
})
export type WaterfallStepView = z.infer<typeof waterfallStepView>

/** One garment of one size in one colourway. */
export const cellCostView = output({
  colourwayId: id(),
  size: z.string(),
  /** Every input is known: the total is the cost. */
  complete: z.boolean(),
  /** The keys of the sheet's missing inputs that touch this cell. */
  missing: z.array(z.string()),
  /** Standard minutes per garment. */
  minutes: z.string(),
  material: output({
    complete: z.boolean(),
    amount: money.cost(z.string()),
    byCategory: z.array(output({ category: z.enum(COST_CATEGORIES), complete: z.boolean(), amount: money.cost(z.string()) })),
    lines: z.array(materialLineView),
  }),
  labour: output({
    complete: z.boolean(),
    amount: money.cost(z.string()),
    lines: z.array(labourLineView),
  }),
  /** null: no overhead rule is set. */
  overhead: output({ overheadPct: z.string(), base: money.cost(z.string()), amount: money.cost(z.string()) }).nullable(),
  /** What the known inputs add up to (the whole cost when complete). */
  knownTotal: money.cost(z.string()),
  /** The cost per garment; null unless complete. */
  total: money.cost(z.string().nullable()),
  waterfall: z.array(waterfallStepView),
})
export type CellCostView = z.infer<typeof cellCostView>

/** A material's price as the sheet used it (A2 `style.cost.sources`). */
export const materialPriceView = output({
  itemId: id(),
  code: z.string(),
  name: z.string(),
  kind: z.enum(ITEM_KINDS),
  category: z.enum(COST_CATEGORIES),
  source: z.enum(PRICE_SOURCES),
  baseUom: z.enum(UOMS),
  /** Per base unit; null: none typed. */
  standardCost: money.cost(z.string().nullable()),
  currency: z.string(),
  /** When the price was last set, when known. */
  asOf: instant().nullable(),
  purchaseUom: z.enum(UOMS),
  /** The same price per purchase unit (per hide for leather bought by the hide). */
  standardCostPerPurchaseUnit: money.cost(z.string().nullable()),
})
export type MaterialPriceView = z.infer<typeof materialPriceView>

/** The labour rate the sheet used for one kind of work centre of the routing. */
export const labourRateUsedView = output({
  workCentreKind: kind(),
  steps: z.number().int(),
  minutes: z.string(),
  /** NONE: no rate applies (listed as missing). */
  source: z.enum(['LABOUR_RATE', 'NONE']),
  rateId: id().nullable(),
  /** The rate's company; null: a tenant-wide rate (or none). */
  companyId: id().nullable(),
  costPerMinute: money.cost(z.string().nullable()),
  currency: z.string().nullable(),
  plannedEfficiencyPct: z.string().nullable(),
  validFrom: z.string().nullable(),
})
export type LabourRateUsedView = z.infer<typeof labourRateUsedView>

export const overheadUsedView = output({
  /** NONE: no overhead rule is set (no overhead line; not a missing input). */
  source: z.enum(['OVERHEAD_RULE', 'NONE']),
  ruleId: id().nullable(),
  companyId: id().nullable(),
  overheadPct: z.string().nullable(),
  updatedAt: instant().nullable(),
})
export type OverheadUsedView = z.infer<typeof overheadUsedView>

const inputsView = output({ materials: z.array(materialPriceView), labour: z.array(labourRateUsedView), overhead: overheadUsedView })

/** What the domain computes for a sheet; the API adds the style, the revision and when. */
export const costSheetBody = {
  /** The sheet's currency: the company's (no exchange rates in W1). */
  currency: z.string(),
  /** The company whose rates and overhead are used; null: tenant-wide ones only. */
  companyId: id().nullable(),
  /** The day whose labour rates are used. */
  on: businessDate(),
  /** Every cell is complete. */
  complete: z.boolean(),
  missing: z.array(missingInputView),
  inputs: inputsView,
  cells: z.array(cellCostView),
}

const styleRef = output({ id: id(), code: z.string(), name: z.string(), companyId: id().nullable(), status: z.enum(STYLE_STATUSES), baseSize: z.string().nullable() })
const revisionRef = output({ id: id(), revision: z.number().int(), status: z.enum(REVISION_STATUSES), version: z.number().int() })

/** A revision's cost sheet (A2 SCR-044): every active colourway × every size of the range. */
export const costSheetView = output({
  style: styleRef,
  revision: revisionRef,
  /** A draft revision: the cost is an estimate (it may still change). */
  estimate: z.boolean(),
  sizes: z.array(z.string()),
  colourways: z.array(output({ id: id(), code: z.string(), name: z.string() })),
  computedAt: instant(),
  ...costSheetBody,
})
export type CostSheetView = z.infer<typeof costSheetView>

/** Which company's rates and currency a sheet uses: needed only for a tenant-wide style (else it is the style's). */
export const costSheetQuery = input({ companyId: id().optional() })
export type CostSheetQuery = z.output<typeof costSheetQuery>

// ---- two revisions compared -------------------------------------------------------------------------------------------

const cellSummary = output({
  complete: z.boolean(),
  materialCost: money.cost(z.string()),
  labourCost: money.cost(z.string()),
  overheadCost: money.cost(z.string().nullable()),
  knownTotal: money.cost(z.string()),
  total: money.cost(z.string().nullable()),
})

/** One cell of two revisions: each side's figures and, when both are complete, the change. */
export const cellDiffView = output({
  colourwayId: id(),
  size: z.string(),
  /** null: the cell is not in that revision's sheet (a colourway or size it lacks). */
  from: cellSummary.nullable(),
  to: cellSummary.nullable(),
  materialCostChange: money.cost(z.string().nullable()),
  labourCostChange: money.cost(z.string().nullable()),
  overheadCostChange: money.cost(z.string().nullable()),
  /** to − from; null unless both sides are complete. */
  totalChange: money.cost(z.string().nullable()),
  /** The materials whose quantity or cost differs in this cell (base units). */
  materials: z.array(
    output({
      itemId: id(),
      code: z.string(),
      from: output({ baseQuantity: z.string().nullable(), materialCost: money.cost(z.string().nullable()) }).nullable(),
      to: output({ baseQuantity: z.string().nullable(), materialCost: money.cost(z.string().nullable()) }).nullable(),
    }),
  ),
  /** The kinds of work centre whose minutes or cost differ. */
  labour: z.array(
    output({
      workCentreKind: kind(),
      from: output({ minutes: z.string(), labourCost: money.cost(z.string().nullable()) }).nullable(),
      to: output({ minutes: z.string(), labourCost: money.cost(z.string().nullable()) }).nullable(),
    }),
  ),
})
export type CellDiffView = z.infer<typeof cellDiffView>

export const costDiffView = output({
  style: styleRef,
  from: revisionRef.extend({ complete: z.boolean(), missing: z.array(missingInputView) }),
  to: revisionRef.extend({ complete: z.boolean(), missing: z.array(missingInputView) }),
  currency: z.string(),
  companyId: id().nullable(),
  on: businessDate(),
  computedAt: instant(),
  /** Cells whose figures, materials or minutes differ; unchanged cells are counted only. */
  cells: z.array(cellDiffView),
  unchanged: z.number().int(),
})
export type CostDiffView = z.infer<typeof costDiffView>

export const compareCostQuery = input({ from: id(), to: id(), companyId: id().optional() })
export type CompareCostQuery = z.output<typeof compareCostQuery>

// ---- cells for a quote (B-W1-21) -------------------------------------------------------------------------------------

export const MAX_COST_CELLS = 500

export const costCellsBody = input({
  styleId: id(),
  revisionId: id(),
  /** The quote's company (its rates and currency); needed only for a tenant-wide style. */
  companyId: id().optional(),
  cells: z
    .array(
      input({
        colourwayId: id(),
        size: z.string().trim().min(1).max(10),
        /** Garments; with it the answer has the minutes and the amount for the quantity. */
        quantity: z.number().int().min(1).max(1_000_000).optional(),
      }),
    )
    .min(1)
    .max(MAX_COST_CELLS),
})
export type CostCellsBody = z.output<typeof costCellsBody>

export const costCellView = output({
  colourwayId: id(),
  size: z.string(),
  quantity: z.number().int().nullable(),
  complete: z.boolean(),
  missing: z.array(z.string()),
  minutes: z.string(),
  materialCost: money.cost(z.string()),
  labourCost: money.cost(z.string()),
  overheadCost: money.cost(z.string().nullable()),
  knownUnitCost: money.cost(z.string()),
  /** The cost per garment (Decimal(18,6), QuoteLine.unitCost); null unless complete. */
  unitCost: money.cost(z.string().nullable()),
  /** Minutes for the quantity (capacity), rounded once. */
  quantityMinutes: z.string().nullable(),
  /** unit cost × quantity in minor units, rounded once (QuoteLine.costAmount); null unless complete and a quantity. */
  amount: money.cost(amountMinor().nullable()),
})
export type CostCellView = z.infer<typeof costCellView>

export const costCellsView = output({
  style: styleRef,
  revision: revisionRef,
  estimate: z.boolean(),
  currency: z.string(),
  companyId: id().nullable(),
  on: businessDate(),
  computedAt: instant(),
  complete: z.boolean(),
  missing: z.array(missingInputView),
  cells: z.array(costCellView),
})
export type CostCellsView = z.infer<typeof costCellsView>

// ---- labour rates and costing settings (the Cost tab's "Costing parameters"; Finance settings) -------------------------

const percent = () => z.string().refine(isPercent, { message: 'Expected a percentage with at most 3 digits and 4 decimals.' })
const note = () => z.string().trim().min(1).max(500)

/** A labour rate: the cost of one standard minute at a kind of work centre, from a day. */
export const labourRateView = output({
  id: id(),
  /** null: tenant-wide. */
  companyId: id().nullable(),
  workCentreKind: kind(),
  costPerMinute: money.cost(z.string()),
  currency: z.string(),
  plannedEfficiencyPct: z.string(),
  validFrom: businessDate(),
  note: z.string().nullable(),
  status: z.enum(LABOUR_RATE_STATUSES),
  /** The rate a cost sheet uses today for its company (a tenant-wide one: for a company without its own). */
  inForce: z.boolean(),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})
export type LabourRateView = z.infer<typeof labourRateView>

/** The rates list: a company's own and the tenant-wide ones (or every one the caller sees), by kind, newest day first. */
export const listRatesQuery = input({
  companyId: id().optional(),
  kind: kind().optional(),
  status: z.enum([...LABOUR_RATE_STATUSES, 'ALL']).default('ACTIVE'),
})
export type ListRatesQuery = z.output<typeof listRatesQuery>

export const createRateBody = input({
  /** Left out or null: tenant-wide. */
  companyId: id().nullish(),
  workCentreKind: kind(),
  /** Required; needs the cost grain. */
  costPerMinute: money.cost(unitPrice()),
  currency: currency().optional(),
  /** Default 100. */
  plannedEfficiencyPct: percent().optional(),
  validFrom: businessDate(),
  note: note().nullish(),
})
export type CreateRateBody = z.output<typeof createRateBody>

/** A correction: only the fields sent change (null clears the note). */
export const updateRateBody = input({
  version: z.number().int().min(1),
  costPerMinute: money.cost(unitPrice()),
  currency: currency().optional(),
  plannedEfficiencyPct: percent().optional(),
  validFrom: businessDate().optional(),
  note: note().nullish(),
})
export type UpdateRateBody = z.output<typeof updateRateBody>

export const archiveRateBody = input({ version: z.number().int().min(1), reason: note().optional() })
export type ArchiveRateBody = z.output<typeof archiveRateBody>

/** The costing settings of a company, or the tenant-wide ones. */
export const costingSettingsView = output({
  id: id(),
  companyId: id().nullable(),
  /** Percent on material + labour. */
  overheadPct: z.string(),
  /**
   * B-W2b-22 (Z9:02): a company's row that holds its costing method only and follows the tenant-wide overhead (its own
   * overheadPct is then 0 and not read). Always false on the tenant-wide row.
   */
  overheadFromTenant: z.boolean(),
  version: z.number().int(),
  updatedAt: instant(),
})
export type CostingSettingsView = z.infer<typeof costingSettingsView>

export const settingsQuery = input({ companyId: id().optional() })
export type SettingsQuery = z.output<typeof settingsQuery>

/** The tenant-wide settings, the company's when asked, and which of them a cost sheet for that company uses. */
export const settingsListView = output({
  tenant: costingSettingsView.nullable(),
  company: costingSettingsView.nullable(),
  /** The id of the row in force (the company's own overhead, else the tenant's: a company row that follows the tenant-wide overhead is not); null: no overhead. */
  inForce: id().nullable(),
})
export type SettingsListView = z.infer<typeof settingsListView>

/** Saves the overhead of a company (or the tenant-wide one): with the version of the row when it exists. */
export const saveSettingsBody = input({
  companyId: id().nullish(),
  overheadPct: percent(),
  /**
   * B-W2b-22 (Z9:02): true: the company follows the tenant-wide overhead again (its row keeps its costing method; send
   * overheadPct 0). Left out or false: the overhead sent is the company's own. Never on the tenant-wide row.
   */
  overheadFromTenant: z.boolean().optional(),
  version: z.number().int().min(1).optional(),
})
export type SaveSettingsBody = z.output<typeof saveSettingsBody>
