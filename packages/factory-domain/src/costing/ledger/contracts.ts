import { z } from 'zod'
import { businessDate, id, input, instant, output } from '../../core/contracts'
import { money } from '../../money/marked'
import { WORK_CENTRE_KINDS } from '../../product/routing/operations'
import { UOMS } from '../../product/units/units'
import { COST_ENTRY_KINDS, COSTING_METHODS } from './entries'
import { BRIDGE_REASONS, COST_PARTS } from './variance'

/**
 * The contracts of the work-order cost ledger and of estimated vs actual (B-W2a-21; FIN-026, FIN-027, FIN-033, FIN-038;
 * design finance.costing "Work orders: standard vs actual", "WO — cost", "Cost ledger"; production.workorders "Labour &
 * cost"). Every amount is `money.cost` in minor units of the work order's company's currency (dropped for a caller
 * without the cost grain); unit costs are decimal strings. Quantities, minutes, kinds and words are not money and are
 * shown to every caller with costing.view. No person is named anywhere: labour is per work order and operation
 * (Statuto dei Lavoratori art. 4).
 */


/** What an entry records, in the ledger's words (receipt, issue, WIP move, completion, scrap…). */
export const ENTRY_EVENTS = ['ISSUE', 'RETURN', 'STOCK_SCRAP', 'LABOUR', 'SCAN_SCRAP', 'REWORK_SCRAP', 'COMPLETION', 'OVERHEAD', 'SUBCONTRACT', 'ADJUSTMENT', 'REVERSAL'] as const
export type EntryEvent = (typeof ENTRY_EVENTS)[number]

/** Why a source event has no entry yet (or cannot have one), in words beside the code. */
export const WAITING_CODES = ['NOT_VALUED', 'NO_RATE', 'CURRENCY', 'LOCKED', 'NO_SCAN'] as const
export type WaitingCode = (typeof WAITING_CODES)[number]

export const DOCUMENT_TYPES = ['StockMove', 'OperationScan', 'ReworkOrder', 'SubcontractOrder', 'SupplierInvoiceLine', 'WorkOrderCostEntry'] as const

const itemRef = output({ id: id(), code: z.string(), name: z.string(), baseUom: z.enum(UOMS) })
const workOrderRef = output({ id: id(), number: z.string() })

export const ledgerEntryView = output({
  id: id(),
  workOrder: workOrderRef,
  kind: z.enum(COST_ENTRY_KINDS),
  event: z.enum(ENTRY_EVENTS),
  occurredAt: instant(),
  /** The Europe/Rome day the period lock reads. */
  day: businessDate(),
  item: itemRef.nullable(),
  /** Base units, signed as the amount. */
  quantity: z.string().nullable(),
  /** LABOUR: standard minutes earned. */
  minutes: z.string().nullable(),
  unitCost: money.cost(z.string().nullable()),
  standardUnitCost: money.cost(z.string().nullable()),
  amount: money.cost(z.number().int()),
  currency: z.string(),
  /** The company's costing method it was posted under. */
  method: z.enum(COSTING_METHODS),
  provisional: z.boolean(),
  /** The frozen standard it compares with. */
  standardId: id().nullable(),
  /** What it comes from: the stock move (its reference), the scan (bundle and operation), the rework, the entry. */
  document: output({ type: z.enum(DOCUMENT_TYPES), id: id(), label: z.string() }).nullable(),
  reversalOfId: id().nullable(),
  reversedBy: output({ id: id(), occurredAt: instant(), reason: z.string().nullable() }).nullable(),
  reason: z.string().nullable(),
  createdAt: instant(),
})
export type LedgerEntryView = z.infer<typeof ledgerEntryView>

const kindList = z
  .string()
  .transform((value) => value.split(',').map((part) => part.trim()).filter((part) => part.length > 0))
  .pipe(z.array(z.enum(COST_ENTRY_KINDS)))

export const ledgerQuery = input({
  companyId: id().optional(),
  siteId: id().optional(),
  workOrderId: id().optional(),
  /** Comma-separated kinds. */
  kind: kindList.optional(),
  /** Europe/Rome days of the entries' dates, both included. */
  from: businessDate().optional(),
  to: businessDate().optional(),
  /** B-W2b-22 (Z9:05): the work order's number, the item's code or name, or the entry's reason (words, never a person). */
  q: z.string().trim().min(1).max(100).optional(),
  cursor: id().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})
export type LedgerQuery = z.infer<typeof ledgerQuery>

export const waitingView = output({
  code: z.enum(WAITING_CODES),
  sourceType: z.enum(DOCUMENT_TYPES),
  sourceId: id(),
  /** In words, without a figure. */
  words: z.string(),
})
export type WaitingView = z.infer<typeof waitingView>

export const postAnswer = output({
  posted: z.array(ledgerEntryView),
  waiting: z.array(waitingView),
  method: z.enum(COSTING_METHODS),
  provisional: z.boolean(),
})

export const reverseBody = input({ reason: z.string().trim().min(3).max(500) })
export const reverseAnswer = output({ entry: ledgerEntryView, reversals: z.array(ledgerEntryView) })

// ---- estimated vs actual ---------------------------------------------------------------------------------------------------

const BASES = ['STANDARD', 'ESTIMATE'] as const

export const workOrderCostRowView = output({
  workOrder: output({
    id: id(),
    number: z.string(),
    status: z.string(),
    companyId: id(),
    siteId: id(),
    style: output({ id: id(), code: z.string(), name: z.string() }),
    /** Garments of its cells. */
    pieces: z.number().int(),
    releasedAt: instant().nullable(),
    completedAt: instant().nullable(),
  }),
  currency: z.string(),
  method: z.enum(COSTING_METHODS),
  provisional: z.boolean(),
  /** What the variance is taken against: the frozen standards of its garments, else the estimate at release. */
  basis: z.enum(BASES).nullable(),
  standardTotal: money.cost(z.number().int().nullable()),
  /** The estimate at release (its known part when `estimateComplete` is false). */
  estimateTotal: money.cost(z.number().int().nullable()),
  estimateComplete: z.boolean(),
  /** What it costs so far (the value moved to finished goods not deducted). */
  actualTotal: money.cost(z.number().int()),
  movedToStock: money.cost(z.number().int()),
  variance: money.cost(z.number().int().nullable()),
  variancePct: money.cost(z.string().nullable()),
  biggestReason: z.enum(BRIDGE_REASONS).nullable(),
  /** Over its basis by more than 5 %. */
  over: z.boolean(),
  /** COMPLETED or CLOSED: the variance is final (else it grows as work is reported). */
  final: z.boolean(),
  entries: z.number().int(),
})
export type WorkOrderCostRowView = z.infer<typeof workOrderCostRowView>

const statusList = z
  .string()
  .transform((value) => value.split(',').map((part) => part.trim()).filter((part) => part.length > 0))
  .pipe(z.array(z.enum(['RELEASED', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED', 'CLOSED', 'CANCELLED'])))

export const workOrderCostsQuery = input({
  companyId: id().optional(),
  siteId: id().optional(),
  /** Comma-separated statuses (default: every one but DRAFT and CANCELLED). */
  status: statusList.optional(),
  /** Only those over their basis by more than 5 % (the page may then hold fewer rows). */
  over: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  /** The work order's number or batch. */
  q: z.string().trim().min(1).max(100).optional(),
  /** B-W2b-22 (Z9:05): completed on these Europe/Rome days, both included ("Closed in <month>"); a work order not completed is left out. */
  completedFrom: businessDate().optional(),
  completedTo: businessDate().optional(),
  cursor: id().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})
export type WorkOrderCostsQuery = z.infer<typeof workOrderCostsQuery>

export const costTilesView = output({
  /** Work orders over their basis by more than 5 % (null: none can be told). */
  overStandard: z.number().int().nullable(),
  /** Σ variance of the work orders completed this month (Europe/Rome). */
  varianceThisMonth: money.cost(z.number().int().nullable()),
  /** Σ of the stock's values now (StockValuation) at the companies in scope. */
  stockValue: money.cost(z.number().int().nullable()),
  /** Moves that change stock and have no value yet. */
  unvaluedMoves: z.number().int(),
  /** Later (design): null. */
  wipValue: money.cost(z.number().int().nullable()),
  currency: z.string().nullable(),
  month: z.string(),
  /** Why a figure is null, in words. */
  words: z.string().nullable(),
})

export const workOrderCostsAnswer = output({ rows: z.array(workOrderCostRowView), nextCursor: id().nullable(), tiles: costTilesView })

const partsView = output({ material: money.cost(z.number().int()), labour: money.cost(z.number().int()), subcontract: money.cost(z.number().int()), overhead: money.cost(z.number().int()), total: money.cost(z.number().int()) })

export const workOrderCostView = workOrderCostRowView.extend({
  /** Per garment of each cell's finished item, Σ garments × each part (null: a cell has no frozen standard). */
  standard: partsView.nullable(),
  standardMissing: z.array(output({ cellId: id(), colourwayCode: z.string(), size: z.string(), itemId: id().nullable(), words: z.string() })),
  estimate: partsView.extend({ complete: z.boolean(), missing: z.array(z.string()) }).nullable(),
  actual: output({
    material: money.cost(z.number().int()),
    labour: money.cost(z.number().int()),
    subcontract: money.cost(z.number().int()),
    overhead: money.cost(z.number().int()),
    adjustment: money.cost(z.number().int()),
    total: money.cost(z.number().int()),
    movedToStock: money.cost(z.number().int()),
    onWorkOrder: money.cost(z.number().int()),
    scrapLost: money.cost(z.number().int()),
    scrapFromStock: money.cost(z.number().int()),
  }),
  /** From the basis to the actual: reasons that add up to the variance exactly (null without a basis). */
  bridge: z.array(output({ reason: z.enum(BRIDGE_REASONS), amount: money.cost(z.number().int()) })).nullable(),
  /** The Labour & cost tab: planned (the basis) · actual · variance · per garment. */
  parts: z.array(output({ part: z.enum(COST_PARTS), planned: money.cost(z.number().int().nullable()), actual: money.cost(z.number().int()), variance: money.cost(z.number().int().nullable()), perGarment: money.cost(z.number().int().nullable()) })),
  perGarment: output({ planned: money.cost(z.number().int().nullable()), actual: money.cost(z.number().int().nullable()) }),
  materials: z.array(
    output({
      item: itemRef,
      /** The work order's frozen need (waste included), base units. */
      plannedQuantity: z.string().nullable(),
      /** Issued less returned, base units. */
      issuedQuantity: z.string(),
      unitCost: money.cost(z.string().nullable()),
      standardUnitCost: money.cost(z.string().nullable()),
      amount: money.cost(z.number().int()),
      lots: z.array(output({ lotId: id().nullable(), lotCode: z.string().nullable(), hideId: id().nullable(), hideCode: z.string().nullable(), quantity: z.string(), amount: money.cost(z.number().int()) })),
    }),
  ),
  labour: z.array(
    output({
      operation: output({ id: id(), seq: z.number().int(), code: z.string(), name: z.string(), workCentreKind: z.enum(WORK_CENTRE_KINDS) }),
      /** Standard minutes × the work order's garments. */
      plannedMinutes: z.string(),
      /** Standard minutes of the good garments its scans reported (W2a: earned; timed minutes are W2b). */
      earnedMinutes: z.string(),
      perMinute: money.cost(z.string().nullable()),
      amount: money.cost(z.number().int()),
    }),
  ),
  scrap: z.array(output({ entryId: id(), event: z.enum(ENTRY_EVENTS), occurredAt: instant(), item: itemRef.nullable(), quantity: z.string().nullable(), value: money.cost(z.number().int().nullable()) })),
  waitingItems: z.array(waitingView),
  words: z.string(),
})
export type WorkOrderCostView = z.infer<typeof workOrderCostView>
