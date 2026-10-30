import { z } from 'zod'
import { businessDate, id, input, instant, output } from '../../core/contracts'
import { STOCK_MOVE_REASONS } from '../../inventory/ledger/moves'
import { VALUATION_METHODS } from '../../inventory/ledger/valuation'
import { money } from '../../money/marked'
import { ITEM_KINDS, ITEM_TRACKINGS } from '../../product/materials/rules'
import { UOMS } from '../../product/units/units'
import { COSTING_METHODS } from '../ledger/entries'
import { VALUATION_CATEGORIES, VALUED_STATES } from './rules'

/**
 * The contracts of the stock valuation (B-W2a-29; FIN-039, SCM-256; design finance.reports "Stock valuation", pop-up "How
 * this lot is valued", warehouse.hides "Leather dashboard" area value). Every value is `money.cost` (dropped for a caller
 * without the cost grain: the design draws no value column then, never a '—'); quantities, areas, hides, methods and words
 * are shown to every caller who may see the stock. No person is named.
 */

const categoryList = z
  .string()
  .transform((value) => value.split(',').map((part) => part.trim()).filter((part) => part.length > 0))
  .pipe(z.array(z.enum(VALUATION_CATEGORIES)))

export const valuationQuery = input({
  /** The day the stock is valued at, Europe/Rome: every move up to the end of that day. Default: now. */
  asOf: businessDate().optional(),
  companyId: id().optional(),
  siteId: id().optional(),
  /** Comma-separated categories (LEATHER, MATERIALS, TRIMS, PACKAGING, FINISHED_GOODS, WIP). */
  category: categoryList.optional(),
  itemId: id().optional(),
  lotId: id().optional(),
  /** An item's code or name, a lot's code, a work order's number. */
  q: z.string().trim().min(1).max(100).optional(),
})
export type ValuationQuery = z.infer<typeof valuationQuery>

const itemRef = output({ id: id(), code: z.string(), name: z.string(), kind: z.enum([...ITEM_KINDS, 'FINISHED']), baseUom: z.enum(UOMS), tracking: z.enum(ITEM_TRACKINGS) })
const siteRef = output({ id: id(), code: z.string() })
const methodView = output({
  companyId: id(),
  /** The company's costing method (the accountant's; UNDECIDED until chosen). */
  method: z.enum(COSTING_METHODS),
  provisional: z.boolean(),
  words: z.string(),
})

export const valuationRowView = output({
  category: z.enum(VALUATION_CATEGORIES),
  companyId: id(),
  site: siteRef,
  /** null for a WIP row. */
  item: itemRef.nullable(),
  colour: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
  lot: output({ id: id(), code: z.string() }).nullable(),
  /** WIP: the work order whose ledger it is. */
  workOrder: output({ id: id(), number: z.string(), status: z.string(), done: z.boolean() }).nullable(),
  /** Base units on hand on the date (null for WIP). */
  quantity: z.string().nullable(),
  uom: z.enum(UOMS).nullable(),
  /** Hides of the lot with stock on the date. */
  hides: z.number().int(),
  /** Square metres, for leather counted in an area unit. */
  areaM2: z.string().nullable(),
  /** Σ the ledger's values of its moves (WIP: of its cost entries), minor units. */
  value: money.cost(z.number().int()),
  /** value ÷ quantity, per base unit. */
  unitCost: money.cost(z.string().nullable()),
  currency: z.string().nullable(),
  /** The stock ledger's bases its value rests on (WIP: none). */
  methods: z.array(z.enum(VALUATION_METHODS)),
  valued: z.enum(VALUED_STATES),
  unvaluedMoves: z.number().int(),
  /** The company's costing method could value it differently (always while UNDECIDED). */
  dependsOnMethod: z.boolean(),
  words: z.string(),
})
export type ValuationRowView = z.infer<typeof valuationRowView>

const categoryTotal = output({
  category: z.enum(VALUATION_CATEGORIES),
  rows: z.number().int(),
  value: money.cost(z.number().int().nullable()),
  currency: z.string().nullable(),
})

export const valuationAnswer = output({
  /** The instant the stock is valued at (null: now, every move so far). */
  asOf: instant().nullable(),
  asOfDay: businessDate().nullable(),
  rows: z.array(valuationRowView),
  categories: z.array(categoryTotal),
  /** Σ of every row (null across currencies). */
  value: money.cost(z.number().int().nullable()),
  currency: z.string().nullable(),
  /** Stock that is gone whose values do not add up to 0 (the rounding of lot costs): Σ rows + residue = the ledger. */
  residue: money.cost(z.number().int().nullable()),
  /** Moves that change stock and have no value yet. */
  unvaluedMoves: z.number().int(),
  methods: z.array(methodView),
  words: z.string(),
  truncated: z.boolean(),
})
export type ValuationAnswer = z.infer<typeof valuationAnswer>

// ---- How this lot is valued -----------------------------------------------------------------------------------------------

export const layersQuery = input({
  siteId: id(),
  itemId: id(),
  itemColourId: id().optional(),
  lotId: id().optional(),
  hideId: id().optional(),
  asOf: businessDate().optional(),
  /** The latest moves shown (with the balance before them). */
  limit: z.coerce.number().int().min(1).max(500).default(200),
})
export type LayersQuery = z.infer<typeof layersQuery>

export const layerView = output({
  moveId: id(),
  reason: z.enum(STOCK_MOVE_REASONS),
  occurredAt: instant(),
  day: businessDate(),
  reference: z.string().nullable(),
  hide: output({ id: id(), code: z.string() }).nullable(),
  /** Signed base quantity (+ in, − out). */
  quantity: z.string(),
  /** The move's valuation; null: not valued. */
  method: z.enum(VALUATION_METHODS).nullable(),
  unitCost: money.cost(z.string().nullable()),
  value: money.cost(z.number().int().nullable()),
  /** A receipt: its receipt and purchase order, and the order line's price in its own unit. */
  receipt: output({ id: id(), number: z.string() }).nullable(),
  purchaseOrder: output({ id: id(), number: z.string(), unitPrice: money.cost(z.string()), uom: z.enum(UOMS), currency: z.string() }).nullable(),
  /** After this move. */
  balanceQuantity: z.string(),
  balanceValue: money.cost(z.number().int()),
  reversalOfId: id().nullable(),
})

export const layersAnswer = output({
  asOf: instant().nullable(),
  site: siteRef,
  item: itemRef,
  lot: output({ id: id(), code: z.string(), qualityStatus: z.string() }).nullable(),
  quantity: z.string(),
  value: money.cost(z.number().int()),
  unitCost: money.cost(z.string().nullable()),
  /** The lot's cost the next issue leaves at (inventory's moving average of what came in), per base unit. */
  lotCost: money.cost(z.string().nullable()),
  currency: z.string().nullable(),
  opening: output({ quantity: z.string(), value: money.cost(z.number().int()) }),
  layers: z.array(layerView),
  complete: z.boolean(),
  method: methodView,
  dependsOnMethod: z.boolean(),
  words: z.string(),
})

// ---- value by area (SCM-256) ----------------------------------------------------------------------------------------------

export const leatherQuery = input({
  asOf: businessDate().optional(),
  companyId: id().optional(),
  siteId: id().optional(),
  itemId: id().optional(),
})
export type LeatherQuery = z.infer<typeof leatherQuery>

const areaFigures = {
  hides: z.number().int(),
  /** Base units (the article's area unit). */
  quantity: z.string(),
  areaM2: z.string().nullable(),
  value: money.cost(z.number().int()),
  valuePerM2: money.cost(z.string().nullable()),
  /** Per base unit. */
  unitCost: money.cost(z.string().nullable()),
}

export const leatherRowView = output({
  companyId: id(),
  site: siteRef,
  item: itemRef,
  colour: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
  ...areaFigures,
  currency: z.string().nullable(),
  valued: z.enum(VALUED_STATES),
  lots: z.array(output({ lot: output({ id: id(), code: z.string(), qualityStatus: z.string() }), ...areaFigures, valued: z.enum(VALUED_STATES) })),
  dependsOnMethod: z.boolean(),
})

export const leatherAnswer = output({
  asOf: instant().nullable(),
  rows: z.array(leatherRowView),
  hides: z.number().int(),
  areaM2: z.string(),
  value: money.cost(z.number().int().nullable()),
  valuePerM2: money.cost(z.string().nullable()),
  currency: z.string().nullable(),
  /** Rows counted in a unit that is no area (not added to the m²). */
  notArea: z.number().int(),
  methods: z.array(methodView),
  words: z.string(),
})
