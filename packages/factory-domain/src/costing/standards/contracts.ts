import { z } from 'zod'
import { businessDate, id, input, instant, output, quantity, unitPrice } from '../../core/contracts'
import { money } from '../../money/marked'
import { ITEM_KINDS } from '../../product/materials/rules'
import { UOMS } from '../../product/units/units'
import { COSTING_METHODS, DECIDED_METHODS } from '../ledger/entries'
import { STANDARD_COST_SOURCES, STANDARD_COST_STATUSES } from './rules'

/**
 * The contracts of standard costs and the costing method (B-W2a-21; FIN-024, FIN-025; design finance.costing "Standard
 * cost per item", finance.settings "Costing"): what apps/factory-api's modules/costing/standards and /method answer and
 * the web's typed client reads. Every cost figure is `money.cost` (dropped for a caller without the cost grain, refused in
 * a body without it): figures per base unit as decimal strings (6 places at most).
 */

/** The kinds an item with a standard may be: a material of the library, or a finished garment (its SKU). */
export const STANDARD_ITEM_KINDS = [...ITEM_KINDS, 'FINISHED'] as const

export const standardItemView = output({ id: id(), code: z.string(), name: z.string(), kind: z.enum(STANDARD_ITEM_KINDS), baseUom: z.enum(UOMS) })

export const standardCostView = output({
  id: id(),
  companyId: id(),
  item: standardItemView,
  validFrom: businessDate(),
  /** null: until the next one takes over. */
  validTo: businessDate().nullable(),
  status: z.enum(STANDARD_COST_STATUSES),
  source: z.enum(STANDARD_COST_SOURCES),
  currency: z.string(),
  materialCost: money.cost(z.string()),
  labourCost: money.cost(z.string()),
  subcontractCost: money.cost(z.string()),
  overheadCost: money.cost(z.string()),
  /** The sum of the four. */
  unitCost: money.cost(z.string()),
  /** The standard minutes per unit its labour is priced on (a made item). */
  labourMinutes: z.string().nullable(),
  note: z.string().nullable(),
  /** FROZEN and its period holds today (Europe/Rome). */
  inForce: z.boolean(),
  frozenAt: instant().nullable(),
  frozenById: id().nullable(),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})
export type StandardCostView = z.infer<typeof standardCostView>

/** One standard with how it was built (a ROLLUP: the cost sheet's cell at preparation, its revision, the inputs used). */
export const standardCostRecordView = standardCostView.extend({ breakdown: money.cost(z.unknown().nullable()) })
export type StandardCostRecordView = z.infer<typeof standardCostRecordView>

export const standardsQuery = input({
  companyId: id().optional(),
  itemId: id().optional(),
  status: z.enum(STANDARD_COST_STATUSES).optional(),
  /** FROZEN and in force on this day. */
  on: businessDate().optional(),
  /** FINISHED garments, or the materials of the library. */
  kind: z.enum(['FINISHED', 'MATERIAL']).optional(),
  /** The item's code or name. */
  q: z.string().trim().min(1).max(100).optional(),
  cursor: id().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})
export type StandardsQuery = z.infer<typeof standardsQuery>

const parts = {
  materialCost: money.cost(unitPrice()),
  labourCost: money.cost(unitPrice()),
  subcontractCost: money.cost(unitPrice()),
  overheadCost: money.cost(unitPrice()),
}
const note = () => z.string().trim().min(1).max(500)

/** A standard typed by finance (MANUAL) or from a supplier's price (PURCHASE): parts not sent are 0. */
export const createStandardBody = input({
  companyId: id(),
  itemId: id(),
  validFrom: businessDate(),
  validTo: businessDate().nullable().optional(),
  source: z.enum(['PURCHASE', 'MANUAL']).optional(),
  ...parts,
  labourMinutes: quantity().nullable().optional(),
  note: note().nullable().optional(),
})
export type CreateStandardBody = z.infer<typeof createStandardBody>

/** A DRAFT corrected: only the fields sent change. */
export const updateStandardBody = input({
  version: z.number().int().min(1),
  validFrom: businessDate().optional(),
  validTo: businessDate().nullable().optional(),
  source: z.enum(STANDARD_COST_SOURCES).optional(),
  ...parts,
  labourMinutes: quantity().nullable().optional(),
  note: note().nullable().optional(),
})
export type UpdateStandardBody = z.infer<typeof updateStandardBody>

/**
 * DRAFT standards prepared for a period: a finished garment (its SKU, or its FINISHED item) from its style's released
 * revision's cost sheet cell (ROLLUP; the materials at the company's frozen standards of the first day, else their
 * standard purchase price; the labour rates of that day), a material from its standard purchase price (PURCHASE). A
 * DRAFT of the same item and first day is prepared again; a FROZEN one is left alone.
 */
export const prepareStandardsBody = input({
  companyId: id(),
  validFrom: businessDate(),
  validTo: businessDate().nullable().optional(),
  items: z
    .array(input({ itemId: id().optional(), variantId: id().optional() }).refine((row) => (row.itemId === undefined) !== (row.variantId === undefined), { message: 'Send an itemId or a variantId.' }))
    .min(1)
    .max(200),
  note: note().nullable().optional(),
})
export type PrepareStandardsBody = z.infer<typeof prepareStandardsBody>

export const preparedSkipView = output({
  index: z.number().int(),
  itemId: id().nullable(),
  variantId: id().nullable(),
  code: z.string().nullable(),
  /** In words, without a figure. */
  reason: z.string(),
  missing: z.array(z.string()),
})

export const versionBody = input({ version: z.number().int().min(1) })

export const freezeAnswer = output({
  standard: standardCostRecordView,
  /** The frozen standard this one ended (its last day set to the day before). */
  ended: standardCostView.nullable(),
  /**
   * Every stock move of the finished item that had no value yet in the standard's period (production receipts, restocked
   * returns, shipments taken from stock, counts, write-offs; and their reversals), valued at this standard now, and the
   * receipts' work orders (their COMPLETION entries posted).
   */
  valued: output({
    moves: z.number().int(),
    workOrders: z.array(output({ id: id(), number: z.string() })),
    /** Moves left unvalued, in words (a locked period, another currency). */
    skipped: z.array(output({ moveId: id(), reason: z.string() })),
  }),
})

// ---- the costing method (FIN-025; design finance.settings "Costing", pop-up "Why the costing method is locked") --------------

export const methodQuery = input({ companyId: id().optional() })

export const costingMethodView = output({
  /** null: the tenant-wide method. */
  companyId: id().nullable(),
  /** The settings row the method comes from (null: none yet, the default). */
  settingsId: id().nullable(),
  from: z.enum(['COMPANY', 'TENANT', 'DEFAULT']),
  method: z.enum(COSTING_METHODS),
  /** UNDECIDED: every cost is provisional until the accountant chooses. */
  provisional: z.boolean(),
  locked: z.boolean(),
  lockedAt: instant().nullable(),
  lockedById: id().nullable(),
  /** The company's first cost entry (the "transactions exist since" of the held choice). */
  firstEntryAt: instant().nullable(),
  entries: z.number().int(),
  /** In words: provisional, chosen, or locked and why. */
  words: z.string(),
  choices: z.array(z.enum(DECIDED_METHODS)),
  /** It may still be chosen (not locked). */
  open: z.boolean(),
  version: z.number().int().nullable(),
})
export type CostingMethodView = z.infer<typeof costingMethodView>

export const chooseMethodBody = input({
  companyId: id().optional(),
  method: z.enum(COSTING_METHODS),
  /** The row's version when it exists. */
  version: z.number().int().min(1).optional(),
  /** Why (the accountant's letter, the board's decision). */
  reason: z.string().trim().min(3).max(500).optional(),
})
export type ChooseMethodBody = z.infer<typeof chooseMethodBody>
