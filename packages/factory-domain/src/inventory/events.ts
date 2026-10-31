import { z } from 'zod'
import { defineEvent } from '../events/define'
import { PURCHASE_ORDER_STATUSES } from '../purchasing/orders'
import { HIDE_STATES } from './issue/rules'
import { COUNT_ITEM_KINDS, STOCK_COUNT_KINDS, STOCK_COUNT_STATUSES } from './counts/rules'
import { STOCK_MOVE_REASONS } from './ledger/moves'
// B-W2a-31: receiving every day.
import { DISCREPANCY_KINDS, DISCREPANCY_STATUSES } from './receipts/discrepancies'

/**
 * The inventory module's events (plan A1 §3.4; SCM-189). apps/factory-api's modules/inventory/ledger `postMoves` emits
 * `inventory.moved` once per stock move, in the command that posts it (receipts, issues, returns, transfers,
 * adjustments, counts, scraps, reversals). `valued` says whether the command valued the move already: the office and
 * the system value their moves in the same command; the floor cannot see costs, so its moves that enter or leave the
 * site's stock are valued afterwards by the worker's `inventory.valueFloorMoves` handler. Never a cost in a payload.
 *
 * Picking (B-W1-39, modules/inventory/issue): `inventory.issued` once per issue to a work order (its moves; the worker's
 * `inventory.startWorkOrderOnIssue` handler moves a RELEASED work order to IN_PROGRESS on it), `inventory.returned` once
 * per return of unused stock from a work order, `inventory.pick_reversed` once per undo or reversal of either. They reach
 * the office's pick and work-order screens and the site's floor devices (the pick list of another tablet refreshes).
 *
 * Receipts (B-W1-32, modules/inventory/receipts): `inventory.receipt_posted` once per receipt posted against a purchase
 * order (its moves also emit `inventory.moved`), `inventory.receipt_reversed` once per reversal. They reach the
 * receipts, lots, hides and purchase order screens of the office (inventory.stock.view).
 *
 * Opening stock (B-W1-35, modules/inventory/opening): `inventory.opening_posted` once per imported line of the count (its
 * lot, new or joined, its hides and its OPENING moves, each also `inventory.moved`); posted by the import's apply, so
 * by the system. It reaches the stock, lots and hides screens and the opening-stock summary (inventory.stock.view).

 *
 * Stock counts (B-W2a-15, modules/inventory/counts; SCM-224, SCM-230): `inventory.count_changed` once per move of a
 * count (made, started, submitted, approved, sent back, cancelled) or edit of its header, `inventory.count_recorded` once
 * per request that records counts, recounts or reasons, asks recounts, adds or removes a line, `inventory.count_applied`
 * once when its differences are posted (its COUNT moves also emit `inventory.moved`), `inventory.count_signed_off` once
 * when a year-end inventory is signed off with its valued list. They reach the counts screens (inventory.counts.view);
 * never a cost, never a person.
 *
 * Receiving every day (B-W2a-31, modules/inventory/receipts; SCM-118): `inventory.receipt_discrepancy_changed` once per
 * discrepancy recorded, changed, removed or settled (agreed, credited, closed) on a receipt, and
 * `inventory.receipt_discrepancies_reported` once per report sent to the supplier (the OPEN ones it names become SENT).
 * They reach the receipt's Discrepancies tab and the Receipts tiles (inventory.stock.view); never a price or a person.
 * B-W2b-14: `inventory.receipt_ddt_corrected` once per correction of a posted receipt's supplier DDT number or date.
 */
const decimal = () => z.string().regex(/^\d{1,14}\.\d{4}$/)

export const events = [
  defineEvent({
    type: 'inventory.moved',
    context: 'inventory',
    description: 'A stock move was posted to the ledger: stock entered a location of a site, left one, or both.',
    payload: z.strictObject({
      moveId: z.uuid(),
      reason: z.enum(STOCK_MOVE_REASONS),
      itemId: z.uuid(),
      itemColourId: z.uuid().nullable(),
      lotId: z.uuid().nullable(),
      hideId: z.uuid().nullable(),
      fromLocationId: z.uuid().nullable(),
      toLocationId: z.uuid().nullable(),
      /** In the item's base unit. */
      baseQuantity: decimal(),
      reversalOfId: z.uuid().nullable(),
      /** Who posted it: the office, a floor device, or the system (a job). */
      postedBy: z.enum(['OFFICE', 'FLOOR', 'SYSTEM']),
      /** The move enters or leaves the site's stock (not a transfer inside it): it has a value. */
      changesValue: z.boolean(),
      /** Its value was written with it (office and system moves); false: the valuation handler values it. */
      valued: z.boolean(),
    }),
    live: { permission: 'inventory.stock.view', fields: ['moveId', 'reason', 'itemId', 'lotId', 'hideId', 'fromLocationId', 'toLocationId'] },
  }),
  defineEvent({
    type: 'inventory.issued',
    context: 'inventory',
    description: 'Stock was issued to a work order: a hide whole, or a quantity of a lot or an untracked material.',
    payload: z.strictObject({
      workOrderId: z.uuid(),
      number: z.string(),
      /** The issue's first move: the undo and the reversal name it. */
      issueId: z.uuid(),
      moveIds: z.array(z.uuid()).min(1),
      itemId: z.uuid(),
      itemColourId: z.uuid().nullable(),
      lotId: z.uuid().nullable(),
      hideId: z.uuid().nullable(),
      /** In the item's base unit, all its moves together. */
      baseQuantity: decimal(),
      /** More than the work order still needed, with the reason (the office). */
      overIssue: z.boolean(),
      /** The work order was RELEASED: its first work, so the worker moves it to IN_PROGRESS. */
      startsWorkOrder: z.boolean(),
      postedBy: z.enum(['OFFICE', 'FLOOR', 'SYSTEM']),
    }),
    live: { permission: 'inventory.issue', floor: 'inventory.issue', fields: ['workOrderId', 'number', 'itemId', 'lotId', 'hideId'] },
  }),
  defineEvent({
    type: 'inventory.returned',
    context: 'inventory',
    description: 'Unused stock came back from a work order: a remnant of a hide with its measured area, or part of a lot.',
    payload: z.strictObject({
      workOrderId: z.uuid(),
      number: z.string(),
      returnId: z.uuid(),
      itemId: z.uuid(),
      itemColourId: z.uuid().nullable(),
      lotId: z.uuid().nullable(),
      hideId: z.uuid().nullable(),
      toLocationId: z.uuid(),
      baseQuantity: decimal(),
      /** The hide's state after the return (REMNANT once part of it stayed with the work order). */
      hideState: z.enum(HIDE_STATES).nullable(),
      postedBy: z.enum(['OFFICE', 'FLOOR', 'SYSTEM']),
    }),
    live: { permission: 'inventory.issue', floor: 'inventory.issue', fields: ['workOrderId', 'number', 'itemId', 'lotId', 'hideId'] },
  }),
  defineEvent({
    type: 'inventory.pick_reversed',
    context: 'inventory',
    description: 'An issue to a work order (or a return from it) was undone on the spot or reversed by the office: one mirror move per move.',
    payload: z.strictObject({
      workOrderId: z.uuid(),
      number: z.string(),
      /** The issue or return reversed (its first move). */
      reversedId: z.uuid(),
      of: z.enum(['ISSUE', 'RETURN']),
      /** The poster's own last issue, undone before its next action (else a reversal by the office). */
      undo: z.boolean(),
      moveIds: z.array(z.uuid()).min(1),
      postedBy: z.enum(['OFFICE', 'FLOOR', 'SYSTEM']),
    }),
    live: { permission: 'inventory.issue', floor: 'inventory.issue', fields: ['workOrderId', 'number', 'reversedId', 'of'] },
  }),
  defineEvent({
    type: 'inventory.receipt_posted',
    context: 'inventory',
    description: 'Goods were received against a purchase order: the receipt, its lots and hides, and its moves are in the ledger.',
    payload: z.strictObject({
      receiptId: z.uuid(),
      number: z.string(),
      purchaseOrderId: z.uuid().nullable(),
      /** The order's state after the receipt (PARTLY_RECEIVED or RECEIVED). */
      purchaseOrderStatus: z.enum(PURCHASE_ORDER_STATUSES).nullable(),
      lotIds: z.array(z.uuid()),
      /** The lots that start in quarantine (a Cr VI test, a PPE certificate or a hold): not usable until released. */
      quarantinedLotIds: z.array(z.uuid()),
      hides: z.number().int().min(0),
      moveIds: z.array(z.uuid()).min(1),
      postedBy: z.enum(['OFFICE', 'FLOOR', 'SYSTEM']),
    }),
    live: { permission: 'inventory.stock.view', fields: ['receiptId', 'number', 'purchaseOrderId', 'purchaseOrderStatus'] },
  }),
  defineEvent({
    type: 'inventory.receipt_reversed',
    context: 'inventory',
    description: 'A posted goods receipt was reversed: one mirror move per receipt move, its lots rejected, the order\'s progress read again.',
    payload: z.strictObject({
      receiptId: z.uuid(),
      number: z.string(),
      purchaseOrderId: z.uuid().nullable(),
      purchaseOrderStatus: z.enum(PURCHASE_ORDER_STATUSES).nullable(),
      lotIds: z.array(z.uuid()),
      moveIds: z.array(z.uuid()).min(1),
      postedBy: z.enum(['OFFICE', 'FLOOR', 'SYSTEM']),
    }),
    live: { permission: 'inventory.stock.view', fields: ['receiptId', 'number', 'purchaseOrderId', 'purchaseOrderStatus'] },
  }),
  defineEvent({
    type: 'inventory.opening_posted',
    context: 'inventory',
    description: 'A line of the opening stock was posted by an import: its lot (new or one an earlier line made), its hides and its OPENING moves.',
    payload: z.strictObject({
      /** The import job that posted it. */
      jobId: z.uuid(),
      /** The line's own reference in the sheet. */
      line: z.string().min(1).max(40),
      itemId: z.uuid(),
      lotId: z.uuid().nullable(),
      lotCode: z.string().nullable(),
      /** The line made the lot (false: it added to a lot an earlier line made). */
      newLot: z.boolean(),
      /** The lot's state after the line: QUARANTINE until a quality person releases it; RELEASED when it needs no quality step. */
      qualityStatus: z.enum(['QUARANTINE', 'RELEASED', 'REJECTED', 'BLOCKED']).nullable(),
      crViStatus: z.enum(['NOT_REQUIRED', 'PENDING', 'PASS', 'FAIL']).nullable(),
      /** The chromium VI result the line brought (its LabResult), if any. */
      resultId: z.uuid().nullable(),
      hideIds: z.array(z.uuid()),
      moveIds: z.array(z.uuid()).min(1),
      /** In the material's base unit, all its moves together. */
      baseQuantity: decimal(),
    }),
    live: { permission: 'inventory.stock.view', fields: ['jobId', 'line', 'itemId', 'lotId', 'lotCode', 'qualityStatus'] },
  }),
  // ---- B-W2a-11 (SCM-205, SCM-209, SCM-210, SCM-193): reservations and write-offs -----------------------------------------
  // modules/inventory/reservations emits `inventory.reserved` once per request (its reservations, all for one work order
  // or one order line) and `inventory.reservations_released` once per release (one or many, with the reason); an issue
  // that counts against a work order's reservations emits only its own `inventory.issued` and `inventory.moved`.
  // modules/inventory/ledger's write-off emits `inventory.written_off` once (its SCRAP moves also `inventory.moved`).
  defineEvent({
    type: 'inventory.reserved',
    context: 'inventory',
    description: 'Stock of a site was reserved for a work order or a sales order line: quantities, areas of leather or named hides.',
    payload: z.strictObject({
      reservationIds: z.array(z.uuid()).min(1),
      workOrderId: z.uuid().nullable(),
      salesOrderLineId: z.uuid().nullable(),
      itemIds: z.array(z.uuid()).min(1),
      hideIds: z.array(z.uuid()),
    }),
    live: { permission: 'inventory.stock.view', fields: ['reservationIds', 'workOrderId', 'salesOrderLineId', 'itemIds', 'hideIds'] },
  }),
  defineEvent({
    type: 'inventory.reservations_released',
    context: 'inventory',
    description: 'Reservations were released with the reason: what they still held is available again.',
    payload: z.strictObject({
      reservationIds: z.array(z.uuid()).min(1),
      workOrderIds: z.array(z.uuid()),
      salesOrderLineIds: z.array(z.uuid()),
      itemIds: z.array(z.uuid()).min(1),
      hideIds: z.array(z.uuid()),
    }),
    live: { permission: 'inventory.stock.view', fields: ['reservationIds', 'workOrderIds', 'itemIds', 'hideIds'] },
  }),
  defineEvent({
    type: 'inventory.written_off',
    context: 'inventory',
    description: 'Stock was written off with a reason (damaged, expired, obsolete, lost): it left the site as scrap.',
    payload: z.strictObject({
      writeOffId: z.uuid(),
      reasonCode: z.string().min(1),
      moveIds: z.array(z.uuid()).min(1),
      itemIds: z.array(z.uuid()).min(1),
      hideIds: z.array(z.uuid()),
      lotIds: z.array(z.uuid()),
    }),
    live: { permission: 'inventory.stock.view', fields: ['writeOffId', 'reasonCode', 'moveIds', 'itemIds', 'hideIds', 'lotIds'] },
  }),
  // ---- stock counts (B-W2a-15) ----
  defineEvent({
    type: 'inventory.count_changed',
    context: 'inventory',
    description: 'A stock count or year-end inventory was made, started (its expected quantities frozen), edited, submitted, approved, sent back for a recount or cancelled.',
    payload: z.strictObject({
      countId: z.uuid(),
      number: z.string(),
      kind: z.enum(STOCK_COUNT_KINDS),
      status: z.enum(STOCK_COUNT_STATUSES),
      /** The state before (the same when only the header changed). */
      previousStatus: z.enum(STOCK_COUNT_STATUSES).nullable(),
      change: z.enum(['CREATED', 'STARTED', 'EDITED', 'SUBMITTED', 'APPROVED', 'SENT_BACK', 'CANCELLED']),
      /** Its lines (after a start: the frozen snapshot's). */
      lines: z.number().int().min(0),
      /** From SUBMITTED on: whether a second person approves (the value is a cost and never travels here). */
      approvalRequired: z.boolean().nullable(),
      scopeLocationId: z.uuid().nullable(),
      scopeItemId: z.uuid().nullable(),
      scopeLotId: z.uuid().nullable(),
      scopeItemKind: z.enum(COUNT_ITEM_KINDS).nullable(),
    }),
    live: { permission: 'inventory.counts.view', fields: ['countId', 'number', 'kind', 'status', 'change'] },
  }),
  defineEvent({
    type: 'inventory.count_recorded',
    context: 'inventory',
    description: "Lines of a stock count changed while it is counted: counts or recounts typed, reasons given, recounts asked for, a line found that was not expected added, or such a line removed.",
    payload: z.strictObject({
      countId: z.uuid(),
      number: z.string(),
      change: z.enum(['COUNTED', 'RECOUNT_ASKED', 'ADDED', 'REMOVED']),
      lineIds: z.array(z.uuid()).min(1),
      /** After the change: the lines, and how many are counted. */
      lines: z.number().int().min(0),
      counted: z.number().int().min(0),
    }),
    live: { permission: 'inventory.counts.view', fields: ['countId', 'number', 'change', 'lineIds', 'lines', 'counted'] },
  }),
  defineEvent({
    type: 'inventory.count_applied',
    context: 'inventory',
    description: "A stock count's differences were posted: one COUNT move per line that differs, dated at the count's snapshot.",
    payload: z.strictObject({
      countId: z.uuid(),
      number: z.string(),
      kind: z.enum(STOCK_COUNT_KINDS),
      /** The count was approved in the same command (its differences were under the approval limit). */
      approvedWithApply: z.boolean(),
      moveIds: z.array(z.uuid()),
      /** The lines that differed: one move each. */
      differences: z.number().int().min(0),
      snapshotAt: z.iso.datetime(),
    }),
    live: { permission: 'inventory.counts.view', fields: ['countId', 'number', 'kind', 'differences'] },
  }),
  defineEvent({
    type: 'inventory.count_signed_off',
    context: 'inventory',
    description: 'A year-end inventory was signed off: its valued list as of the inventory date is frozen as files of the count (c.c. art. 2217).',
    payload: z.strictObject({
      countId: z.uuid(),
      number: z.string(),
      /** The inventory date, YYYY-MM-DD. */
      inventoryDate: z.iso.date(),
      /** The valued list's PDF (the count's valuedListFileId) and its spreadsheet. */
      valuedListFileId: z.uuid(),
      valuedListSheetFileId: z.uuid(),
      /** The list's rows (item, colour and lot). */
      rows: z.number().int().min(0),
    }),
    live: { permission: 'inventory.counts.view', fields: ['countId', 'number', 'inventoryDate'] },
  }),
  // B-W2a-31: receiving every day (discrepancies and their report to the supplier).
  defineEvent({
    type: 'inventory.receipt_discrepancy_changed',
    context: 'inventory',
    description: 'A discrepancy of a goods receipt was recorded, changed, removed, or settled (agreed, credited, closed).',
    payload: z.strictObject({
      receiptId: z.uuid(),
      discrepancyId: z.uuid(),
      seq: z.number().int().min(1),
      kind: z.enum(DISCREPANCY_KINDS),
      /** Its state after the change (REMOVED: deleted while OPEN). */
      status: z.enum([...DISCREPANCY_STATUSES, 'REMOVED']),
      change: z.enum(['RECORDED', 'CHANGED', 'REMOVED', 'SETTLED']),
    }),
    live: { permission: 'inventory.stock.view', fields: ['receiptId', 'discrepancyId', 'status', 'change'] },
  }),
  defineEvent({
    type: 'inventory.receipt_discrepancies_reported',
    context: 'inventory',
    description: "A goods receipt's discrepancy report (a PDF without prices) was sent to the supplier on the receipt's thread.",
    payload: z.strictObject({
      receiptId: z.uuid(),
      number: z.string(),
      /** Every discrepancy the report named, and the OPEN ones it moved to SENT. */
      discrepancyIds: z.array(z.uuid()).min(1),
      sentIds: z.array(z.uuid()),
      documentFileId: z.uuid(),
      outboundId: z.uuid(),
      recipients: z.number().int().min(1),
    }),
    live: { permission: 'inventory.stock.view', fields: ['receiptId', 'number', 'discrepancyIds'] },
  }),
  // B-W2b-14: the supplier's DDT number or date corrected on a posted receipt (the receipt's audit row keeps every one).
  defineEvent({
    type: 'inventory.receipt_ddt_corrected',
    context: 'inventory',
    description: "The supplier's DDT number or date of a posted goods receipt was corrected, with why.",
    payload: z.strictObject({
      receiptId: z.uuid(),
      number: z.string(),
      /** What the receipt names now (the transport document's own number, not a person). */
      supplierDdtNumber: z.string().nullable(),
      supplierDdtDate: z.iso.date().nullable(),
    }),
    live: { permission: 'inventory.stock.view', fields: ['receiptId', 'number'] },
  }),
] as const
