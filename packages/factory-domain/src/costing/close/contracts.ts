import { z } from 'zod'
import { id, input, instant, output } from '../../core/contracts'
import { money } from '../../money/marked'
import { UOMS } from '../../product/units/units'
import { ledgerEntryView, waitingView } from '../ledger/contracts'
import { NOT_SPLIT_CODES, VARIANCE_CATEGORIES } from '../variances/split'
import { CLOSE_REASONS, CLOSE_REFUSALS } from './rules'

/**
 * The contracts of the work order close (B-W2b-411; MES-012, MES-013, FIN-029, FIN-030, FIN-034; design production.workorders
 * pop "Close work order", record tab "Labour & cost" › "Cost"). Material cost, unit costs and every amount are
 * `money.cost` in minor units of the company's currency (dropped for a caller without the cost grain: a production
 * manager still sees the garments, minutes, scrap, which figures are beyond the tolerance and the reasons). Minutes are
 * work-order totals, never a person's. The office user who closed, undid or reopened is named inside the one record.
 */

const version = z.number().int().min(1).optional()

/** POST /production/work-orders/:workOrderId/close */
export const closeBody = input({
  version,
  /** Exactly when a figure is beyond the tolerance (the close check says so). */
  reasonCode: z.enum(CLOSE_REASONS).optional(),
  /** Words with the reason (OTHER needs them), or a note on a close within the tolerance; 1 to 1,000 characters. */
  reasonNote: z.string().trim().min(1).max(1000).optional(),
})
export type CloseBody = z.infer<typeof closeBody>

/** POST /production/work-orders/:workOrderId/close/undo */
export const undoBody = input({ version })
export type UndoBody = z.infer<typeof undoBody>

/** POST /production/work-orders/:workOrderId/reopen */
export const reopenBody = input({ version, reason: z.string().trim().min(3).max(1000) })
export type ReopenBody = z.infer<typeof reopenBody>

export const figuresView = output({
  plannedQuantity: z.number().int(),
  actualQuantity: z.number().int(),
  plannedScrapQuantity: z.number().int(),
  scrapQuantity: z.number().int(),
  plannedMaterialCost: money.cost(z.number().int()),
  actualMaterialCost: money.cost(z.number().int()),
  plannedMinutes: z.string(),
  actualMinutes: z.string(),
  currency: z.string(),
})

export const beyondView = output({ quantity: z.boolean(), material: z.boolean(), minutes: z.boolean(), scrap: z.boolean(), any: z.boolean() })

const itemRef = output({ id: id(), code: z.string(), name: z.string(), baseUom: z.enum(UOMS) })
const person = output({ id: id(), name: z.string() })

export const varianceLineView = output({
  /** Null in the close check's preview (not written yet). */
  id: id().nullable(),
  category: z.enum(VARIANCE_CATEGORIES),
  categoryWords: z.string(),
  item: itemRef.nullable(),
  /** Base units (material), minutes (labour) or garments; both or neither. */
  standardQuantity: z.string().nullable(),
  actualQuantity: z.string().nullable(),
  standardUnitCost: money.cost(z.string().nullable()),
  actualUnitCost: money.cost(z.string().nullable()),
  /** Above 0: cost more than standard. */
  amount: money.cost(z.number().int()),
  note: z.string().nullable(),
})

export const splitView = output({
  basis: z.enum(['STANDARD', 'ESTIMATE']).nullable(),
  lines: z.array(varianceLineView),
  /** What was left on the work order before the close. */
  balance: money.cost(z.number().int()),
  explained: money.cost(z.number().int()),
  /** The closing entry: what the lines leave, taken off. */
  closing: money.cost(z.number().int()),
  notSplit: z.array(output({ category: z.enum(VARIANCE_CATEGORIES).nullable(), code: z.enum(NOT_SPLIT_CODES), words: z.string() })),
  words: z.string(),
})
export type SplitView = z.infer<typeof splitView>

export const closeRecordView = output({
  id: id(),
  workOrderId: id(),
  figures: figuresView,
  tolerancePct: z.string(),
  beyond: beyondView,
  reasonCode: z.string().nullable(),
  reasonWords: z.string().nullable(),
  reasonNote: z.string().nullable(),
  closedAt: instant(),
  closedBy: person,
  undoneAt: instant().nullable(),
  undoneBy: person.nullable(),
  reopenReason: z.string().nullable(),
  /** Not undone. */
  live: z.boolean(),
  /** Its closing entry is posted: the work order's ledger adds up to 0 and takes no entry but a reversal. */
  settled: z.boolean(),
  /** Until when the person who closed it may undo it (null once undone, or past). */
  undoUntil: instant().nullable(),
  can: output({ undo: z.boolean(), reopen: z.boolean() }),
})
export type CloseRecordView = z.infer<typeof closeRecordView>

export const reasonView = output({ code: z.enum(CLOSE_REASONS), words: z.string(), noteNeeded: z.boolean() })

/** GET /production/work-orders/:workOrderId/close-check: what the close dialog shows before the close. */
export const closeCheckView = output({
  workOrder: output({ id: id(), number: z.string(), status: z.string(), version: z.number().int(), companyId: id(), siteId: id() }),
  /** COMPLETED and the caller may close it. */
  closable: z.boolean(),
  refusal: output({ code: z.enum(CLOSE_REFUSALS), message: z.string() }).nullable(),
  figures: figuresView,
  tolerancePct: z.string(),
  beyond: beyondView,
  reasonNeeded: z.boolean(),
  beyondWords: z.string(),
  reasons: z.array(reasonView),
  /** The company's figures for the accountant are on: the close settles the cost. */
  settles: z.boolean(),
  /** CLOSE_WAITS while they are off, else null. */
  waits: z.string().nullable(),
  /** Cost entries the close posts first (the worker had not posted them yet). */
  toPost: z.number().int(),
  /** What cannot post yet, in words (while the figures are on, the close waits for them). */
  waiting: z.array(waitingView),
  /** The variance split as the close would write it now (costing.view; amounts with the cost grain); null otherwise. */
  split: splitView.nullable(),
  undoSeconds: z.number().int(),
  /** The close that stands (a CLOSED work order). */
  live: closeRecordView.nullable(),
  words: z.string(),
})
export type CloseCheckView = z.infer<typeof closeCheckView>

/** GET /costing/work-orders/:workOrderId/close: every close of the work order, newest first, with its split and entries. */
export const workOrderClosesView = output({
  workOrder: output({ id: id(), number: z.string(), status: z.string(), companyId: id(), siteId: id() }),
  currency: z.string(),
  closes: z.array(
    closeRecordView.extend({
      lines: z.array(varianceLineView),
      /** The closing entry's amount (null: none, the close was not settled). */
      closing: money.cost(z.number().int().nullable()),
      /** Its VARIANCE and CLOSE entries and their reversals. */
      entries: z.array(ledgerEntryView),
    }),
  ),
  waits: z.string().nullable(),
  words: z.string(),
})
export type WorkOrderClosesView = z.infer<typeof workOrderClosesView>
