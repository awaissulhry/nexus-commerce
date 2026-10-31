import { z } from 'zod'
import { defineEvent } from '../events/define'
import { HIDE_STATES } from '../inventory/issue/rules'
import { GARMENT_TRACKINGS } from './serials/rules'
import { SCAN_SUBJECTS } from './settings/monitoring'
import { WORK_ORDER_STATUSES } from './work-orders/machine'
// W2a B-W2a-13: split, rework, replacements, scrap by lot.
import { SPLIT_REASONS } from './bundles/split'
import { REWORK_STATUSES } from './rework/rules'
import { REPLACEMENT_KINDS, REPLACEMENT_STATUSES } from './scrap/rules'
// B-W2b-29: off-standard and indirect time.
import { BLOCK_ENDINGS, BLOCK_SOURCES, OFF_STANDARD_KINDS } from './offstandard/rules'
// B-W2b-46: checks before a scan counts.
import { GUARD_KINDS, OVERRIDE_REASON_CODES } from './guards/rules'
// B-W2b-53: floor rules per site and scrap above the limit.
import { DECIDED_ON, SCRAP_DECISIONS } from './scrap/approval'
import { FLOOR_RULE_FIELDS, FLOOR_RULE_MODES } from './settings/floor-rules'

/**
 * The production module's events (plan A1 §3.4, §3.5 "workorder.released"; MES-001, MES-005, MES-007, MES-278; design
 * 02 "Work orders" Live: a work order's status change refreshes the late list and the tiles). apps/factory-api's
 * modules/production emits them in the commands that make the change. Ids, numbers, counts and states only: no money,
 * no customer, no legal-basis text, no reason, no person's name in a payload.
 *
 *   production.monitoring_changed   a site's floor rules changed: who floor records name (WIDENED: the station → the
 *                                   worker; NARROWED: the worker → the station) or the legal basis on record
 *                                   (BASIS_RECORDED, BASIS_REPLACED) (B-W1-37; office screens)
 *   workorder.created               a DRAFT work order was made from sales order lines (B-W1-38)
 *   workorder.changed               a DRAFT's cells or revision, or a work order's due date, priority or note changed
 *   workorder.released              released with its frozen specification and batch number (the floor can start)
 *   workorder.status_changed        started, completed, closed or cancelled
 *   workorder.finished_to_stock     released garments of a work order went into finished-goods stock, all or part
 *                                   (B-W2a-12; GAP-003, MES-011: one PRODUCTION_RECEIPT move per cell)
 *   workorder.finished_reversed     a report to finished goods was taken back: its garments left stock again
 *   production.cut_logged           a cut log entry of a hide for a work order: its pieces per cell, the area it used
 *                                   (B-W1-40; the cutting tables of the site and the work order record refresh)
 *   production.hide_closed          a hide was closed for a work order (Hide done): its remnant back to stock, or used up
 *   production.cut_reversed         a cut log entry was undone by its cutter or corrected by the office (a mirror entry)
 *   production.bundle_created       a bundle was made from a cell's cut garments, its ticket's code given (B-W1-41; the
 *                                   bundles screens of the site and the work order record refresh)
 *   production.bundle_reprinted     a bundle's ticket was reprinted with a new code; the old code is refused at a scan
 *   production.bundle_voided        a bundle made by mistake was voided before any scan: its garments are cut, not in
 *                                   bundles, again
 *   production.scan_recorded        a bundle was reported at an operation, a report undone, or a correction recorded
 *                                   (B-W1-42; WIP, the size grid's progress and the bundle screens refresh)
 *   production.scan_correction_requested  the floor asked a correction of one of its own older reports (Approvals)
 *   production.scan_correction_decided    a correction request was approved (a CORRECTION row) or refused
 *   production.scan_refused         a floor scan was refused (online or from the offline queue): the refused scans list
 *                                   (SCR-023) and the device's queue refresh; no counts, no person
 *   production.garment_labels_printed    garment labels of a cell's finished garments printed at the final operation:
 *                                        with the batch number, or one serial each (B-W1-44; the label screens refresh)
 *   production.garment_labels_reprinted  labels printed again (the same batch or serials); the reason stays in the log
 *   production.garment_serial_voided     a MADE serial voided (a spoilt label, a garment scrapped): its cell has one
 *                                        more garment to label
 *   production.report_subscription_changed  B-W2a-38: someone subscribed to the daily production report by e-mail, or a
 *                                           subscription changed or was turned off (the report page's state refreshes)
 *   production.daily_report_sent            B-W2a-38: the scheduler e-mailed one person's daily production report
 *   production.scan_guard_flagged           B-W2b-46: a report counted although a check found something (the site's
 *                                           rule is WARN): the team leader is told (MES-097, MES-098); no person
 *   production.scan_guard_overridden        B-W2b-46: a team leader overrode the checks that held a report, with their
 *                                           PIN and a reason tile (MES-070, MES-097, MES-098); no person, no words
 *   production.bundle_coupons_changed       B-W2b-41: a bundle's coupons printed, one reprinted or voided (MES-067)
 *   production.bundle_stuck                 B-W2b-41: a bundle with no scan past its site's limit, once per wait (MES-168)
 *   production.scan_findings_found          B-W2b-41: the scan-pattern checks found patterns about bundles (MES-075)
 *   production.scan_finding_reviewed        B-W2b-41: one finding reviewed or dismissed
 *   production.bundle_rules_changed         B-W2b-41: a site's bundle code mode or stuck limit changed
 *   production.floor_rules_changed          B-W2b-53: a site's floor checks changed (the quantity guard, the sequence,
 *                                           the scrap approval limit); Floor rules & codes and the site's tablets re-read
 *   production.scrap_over_limit_decided     B-W2b-53: a scan's scrap above the site's limit was approved (it posts) or
 *                                           refused, by a team leader on the tablet or in the office (MES-128)
 */
export const MONITORING_CHANGES = ['WIDENED', 'NARROWED', 'BASIS_RECORDED', 'BASIS_REPLACED'] as const

const subject = z.enum(SCAN_SUBJECTS)

const live = { permission: 'workorders.view', fields: ['workOrderId', 'number'] } as const

// B-W2a-12: 'steps', a repair DRAFT's routing steps (MES-019).
export const WORK_ORDER_CHANGES = ['cells', 'revision', 'details', 'steps'] as const

const decimal = () => z.string().regex(/^\d{1,14}\.\d{4}$/)
const postedBy = () => z.enum(['OFFICE', 'FLOOR', 'SYSTEM'])
/** The cutting tables of the event's site and the office's cutting screens (production.cut). */
const cutLive = { permission: 'production.cut', floor: 'production.cut', fields: ['workOrderId', 'number', 'hideId'] } as const
/** The bundles screens of the event's site and the office's (production.bundles). */
const bundleLive = { permission: 'production.bundles', floor: 'production.bundles', fields: ['workOrderId', 'number', 'bundleId'] } as const
/** WIP and the work order record (workorders.view) and the floor devices of the event's site. */
const scanLive = { permission: 'workorders.view', floor: 'floor.work', fields: ['workOrderId', 'number', 'bundleId'] } as const
/** Approvals and the refused scans (production.scan.correct) and the floor devices of the event's site. */
const correctionLive = { permission: 'production.scan.correct', floor: 'production.scan', fields: ['workOrderId', 'number', 'requestId'] } as const
/** The garment label screens of the event's site and the office's (production.serials). */
const labelLive = { permission: 'production.serials', floor: 'production.serials', fields: ['workOrderId', 'number', 'workOrderSizeId'] } as const
// W2a B-W2a-13.
/** The rework of the event's site (production.rework, the floor too). */
const reworkLive = { permission: 'production.rework', floor: 'production.rework', fields: ['workOrderId', 'number', 'reworkId'] } as const
/** Scrap & rework in the office (production.scrap.view). */
const scrapLive = { permission: 'production.scrap.view', fields: ['workOrderId', 'number'] } as const
/** B-W2b-29: the labour inbox (production.offstandard.view) and the tablets of the event's site (floor.work). No person in a field. */
const offStandardLive = { permission: 'production.offstandard.view', floor: 'floor.work', fields: ['blockId', 'siteId', 'lineId', 'status'] } as const
// B-W2b-46.
/** The checks the floor met: the office's leads and supervisors (production.scan.correct) and the team leaders' tablets (production.scan.override). */
const guardLive = { permission: 'production.scan.correct', floor: 'production.scan.override', fields: ['workOrderId', 'number', 'bundleId', 'scanId'] } as const

export const events = [
  defineEvent({
    type: 'production.monitoring_changed',
    context: 'production',
    description: "A site's floor rules changed: who scans and cut logs name (the worker or the station), or the legal basis on record.",
    payload: z.strictObject({ siteId: z.uuid(), scanSubject: subject, previous: subject, change: z.enum(MONITORING_CHANGES), basisOnRecord: z.boolean() }),
    live: { permission: 'production.settings.view', fields: ['siteId', 'scanSubject', 'change'] },
  }),
  defineEvent({
    type: 'workorder.created',
    context: 'production',
    description: 'A DRAFT work order was made from sales order lines of one style.',
    payload: z.strictObject({
      workOrderId: z.uuid(),
      number: z.string(),
      siteId: z.uuid(),
      styleId: z.uuid(),
      salesOrderIds: z.array(z.uuid()).min(1),
      cells: z.number().int().min(0),
      pieces: z.number().int().min(0),
      /** B-W2a-12: a REPAIR work order's repair order (MES-019); absent for a size run. */
      repairOrderId: z.uuid().optional(),
    }),
    live: { ...live, fields: ['workOrderId', 'number', 'styleId'] },
  }),
  defineEvent({
    type: 'workorder.changed',
    context: 'production',
    description: "A work order's cells or revision (while a DRAFT), or its due date, priority or note changed.",
    payload: z.strictObject({ workOrderId: z.uuid(), number: z.string(), changes: z.array(z.enum(WORK_ORDER_CHANGES)).min(1), cells: z.number().int().min(0), pieces: z.number().int().min(0) }),
    live,
  }),
  defineEvent({
    type: 'workorder.released',
    context: 'production',
    description: 'A work order was released to the floor with its frozen specification and batch number.',
    payload: z.strictObject({
      workOrderId: z.uuid(),
      number: z.string(),
      batchNumber: z.string(),
      siteId: z.uuid(),
      styleId: z.uuid(),
      styleRevisionId: z.uuid(),
      labelTemplateId: z.uuid(),
      salesOrderIds: z.array(z.uuid()).min(1),
      cells: z.number().int().min(1),
      pieces: z.number().int().min(1),
      operations: z.number().int().min(1),
      materials: z.number().int().min(0),
      /** Released with material short, on the planner's override (its reason is in the audit row). */
      materialOverride: z.boolean(),
    }),
    live: { ...live, floor: 'floor.work', fields: ['workOrderId', 'number', 'batchNumber'] },
  }),
  defineEvent({
    type: 'workorder.status_changed',
    context: 'production',
    description: 'A work order was started, completed, closed or cancelled.',
    payload: z.strictObject({ workOrderId: z.uuid(), number: z.string(), from: z.enum(WORK_ORDER_STATUSES), to: z.enum(WORK_ORDER_STATUSES) }),
    live: { ...live, floor: 'floor.work', fields: ['workOrderId', 'number', 'to'] },
  }),
  // B-W2a-12 (modules/production/completion): report finished to stock and taking a report back.
  defineEvent({
    type: 'workorder.finished_to_stock',
    context: 'production',
    description: "Released garments of a work order went into finished-goods stock (all or part, per size): one production receipt per cell.",
    payload: z.strictObject({
      workOrderId: z.uuid(),
      number: z.string(),
      siteId: z.uuid(),
      /** The report: its first move's id. */
      reportId: z.uuid(),
      locationId: z.uuid(),
      moveIds: z.array(z.uuid()).min(1),
      cells: z.array(z.strictObject({ workOrderSizeId: z.uuid(), itemId: z.uuid(), quantity: z.number().int().min(1) })).min(1),
      pieces: z.number().int().min(1),
      /** Every garment of every cell is in finished goods now. */
      allInStock: z.boolean(),
    }),
    live: { ...live, fields: ['workOrderId', 'number', 'reportId'] },
  }),
  defineEvent({
    type: 'workorder.finished_reversed',
    context: 'production',
    description: 'A report to finished goods was taken back (the reason is in the audit row): its garments left stock again.',
    payload: z.strictObject({ workOrderId: z.uuid(), number: z.string(), siteId: z.uuid(), reportId: z.uuid(), moveIds: z.array(z.uuid()).min(1), pieces: z.number().int().min(1) }),
    live: { ...live, fields: ['workOrderId', 'number', 'reportId'] },
  }),
  defineEvent({
    type: 'production.cut_logged',
    context: 'production',
    description: 'A cut of a hide for a work order was logged: the garment sets and parts per cell, and the area it used.',
    payload: z.strictObject({
      workOrderId: z.uuid(),
      number: z.string(),
      cutLogId: z.uuid(),
      hideId: z.uuid(),
      lotId: z.uuid(),
      /** In the hide's material's base unit. */
      baseAreaUsed: decimal(),
      baseRemnantArea: decimal(),
      cells: z.array(z.strictObject({ workOrderSizeId: z.uuid(), pieces: z.number().int().min(1) })),
      /** The hide was issued to the work order by this cut (the scan of a hide still in stock): the issue's first move. */
      issueId: z.uuid().nullable(),
      /** The entry closed the hide for the work order (Hide done). */
      closesHide: z.boolean(),
      hideState: z.enum(HIDE_STATES),
      postedBy: postedBy(),
    }),
    live: cutLive,
  }),
  defineEvent({
    type: 'production.hide_closed',
    context: 'production',
    description: 'A hide was closed for a work order (Hide done): its remnant went back to stock, or the hide is used up.',
    payload: z.strictObject({
      workOrderId: z.uuid(),
      number: z.string(),
      hideId: z.uuid(),
      lotId: z.uuid(),
      /** The last entry, with the rest of the hide; null: nothing more was used. */
      cutLogId: z.uuid().nullable(),
      /** The remnant's RETURN move; null: no remnant. */
      remnantMoveId: z.uuid().nullable(),
      baseRemnantArea: decimal(),
      hideState: z.enum(HIDE_STATES),
      postedBy: postedBy(),
    }),
    live: cutLive,
  }),
  defineEvent({
    type: 'production.cut_reversed',
    context: 'production',
    description: "A cut log entry was undone by its cutter, or corrected by the office: a mirror entry takes its pieces and area back.",
    payload: z.strictObject({
      workOrderId: z.uuid(),
      number: z.string(),
      /** The mirror entry. */
      cutLogId: z.uuid(),
      reversedId: z.uuid(),
      undo: z.boolean(),
      hideId: z.uuid(),
      baseAreaUsed: decimal(),
      /** The remnant the entry had returned came back to the work order too (an undo of Hide done). */
      remnantReturnReversed: z.boolean(),
      hideState: z.enum(HIDE_STATES),
      postedBy: postedBy(),
    }),
    live: cutLive,
  }),
  defineEvent({
    type: 'production.bundle_created',
    context: 'production',
    description: "A bundle was made from a cell's cut garments (whole garments, or one part), with its ticket's code.",
    payload: z.strictObject({
      workOrderId: z.uuid(),
      number: z.string(),
      bundleId: z.uuid(),
      code: z.string(),
      workOrderSizeId: z.uuid(),
      /** A part bundle's part; null: whole garments. */
      part: z.string().nullable(),
      quantity: z.number().int().min(1),
      postedBy: postedBy(),
    }),
    live: bundleLive,
  }),
  defineEvent({
    type: 'production.bundle_reprinted',
    context: 'production',
    description: "A bundle's ticket was reprinted with a new code; a scan of the old code is refused with the new one in the words.",
    payload: z.strictObject({ workOrderId: z.uuid(), number: z.string(), bundleId: z.uuid(), code: z.string(), replacedCode: z.string(), postedBy: postedBy() }),
    live: bundleLive,
  }),
  defineEvent({
    type: 'production.bundle_voided',
    context: 'production',
    description: 'A bundle made by mistake was voided before any scan named it: its garments are cut, not in bundles, again.',
    payload: z.strictObject({ workOrderId: z.uuid(), number: z.string(), bundleId: z.uuid(), code: z.string(), workOrderSizeId: z.uuid(), quantity: z.number().int().min(1), postedBy: postedBy() }),
    live: bundleLive,
  }),
  defineEvent({
    type: 'production.scan_recorded',
    context: 'production',
    description: 'A bundle was reported done at an operation (good, scrap and rework counts), a report was undone, or an approved correction voided an older scan.',
    payload: z.strictObject({
      workOrderId: z.uuid(),
      number: z.string(),
      bundleId: z.uuid(),
      scanId: z.uuid(),
      kind: z.enum(['REPORT', 'UNDO', 'CORRECTION']),
      operationId: z.uuid(),
      operationSeq: z.number().int(),
      /** UNDO, CORRECTION: the scan it voids. */
      correctsId: z.uuid().nullable(),
      goodQuantity: z.number().int().min(0),
      scrapQuantity: z.number().int().min(0),
      reworkQuantity: z.number().int().min(0),
      postedBy: postedBy(),
    }),
    live: scanLive,
  }),
  defineEvent({
    type: 'production.scan_correction_requested',
    context: 'production',
    description: 'The floor asked a correction of one of its own older reports; a lead or the office decides it.',
    payload: z.strictObject({ workOrderId: z.uuid(), number: z.string(), requestId: z.uuid(), scanId: z.uuid(), bundleId: z.uuid(), operationId: z.uuid() }),
    live: correctionLive,
  }),
  defineEvent({
    type: 'production.scan_correction_decided',
    context: 'production',
    description: 'A correction request was approved (a CORRECTION scan voids the old one, which stays) or refused.',
    payload: z.strictObject({
      workOrderId: z.uuid(),
      number: z.string(),
      requestId: z.uuid(),
      scanId: z.uuid(),
      decision: z.enum(['APPROVED', 'REFUSED']),
      correctionScanId: z.uuid().nullable(),
    }),
    live: correctionLive,
  }),
  defineEvent({
    type: 'production.scan_refused',
    context: 'production',
    description: "A floor scan was refused (online or from a device's offline queue) and kept with its reason and fix for the refused scans list.",
    payload: z.strictObject({
      refusalId: z.uuid(),
      deviceId: z.uuid(),
      code: z.string(),
      /** False: the queue sends it again by itself. */
      final: z.boolean(),
      workOrderId: z.uuid().nullable(),
      bundleId: z.uuid().nullable(),
    }),
    live: { permission: 'production.scan.correct', floor: 'production.scan', fields: ['refusalId', 'deviceId', 'code'] },
  }),
  defineEvent({
    type: 'production.garment_labels_printed',
    context: 'production',
    description: "Garment labels of a cell's finished garments were printed at the final operation: with the work order's batch number, or a serial given (MADE) to each garment with its own label.",
    payload: z.strictObject({
      workOrderId: z.uuid(),
      number: z.string(),
      workOrderSizeId: z.uuid(),
      tracking: z.enum(GARMENT_TRACKINGS),
      quantity: z.number().int().min(1),
      batchNumber: z.string(),
      /** SERIAL: the serials given; BATCH: none. */
      serialIds: z.array(z.uuid()),
      postedBy: postedBy(),
    }),
    live: labelLive,
  }),
  defineEvent({
    type: 'production.garment_labels_reprinted',
    context: 'production',
    description: 'Garment labels were printed again with the same batch number or serials (the reason is in the label log, not here).',
    payload: z.strictObject({
      workOrderId: z.uuid(),
      number: z.string(),
      workOrderSizeId: z.uuid(),
      tracking: z.enum(GARMENT_TRACKINGS),
      quantity: z.number().int().min(1),
      serialIds: z.array(z.uuid()),
      postedBy: postedBy(),
    }),
    live: labelLive,
  }),
  defineEvent({
    type: 'production.garment_serial_voided',
    context: 'production',
    description: 'A garment serial was voided before release (a spoilt label, a garment scrapped): its cell has one more garment to label.',
    payload: z.strictObject({ workOrderId: z.uuid(), number: z.string(), workOrderSizeId: z.uuid(), serialId: z.uuid(), serial: z.string(), postedBy: postedBy() }),
    live: labelLive,
  }),
  // ---- W2a B-W2a-13: split a bundle (MES-071), the rework loop (MES-126), replacements (MES-130), scrap by lot (MES-129).
  defineEvent({
    type: 'production.bundle_split',
    context: 'production',
    description: 'Garments of a bundle were split off into a child bundle with its own ticket (rework, a recut, a hold); the parent keeps its genealogy.',
    payload: z.strictObject({
      workOrderId: z.uuid(),
      number: z.string(),
      /** The child bundle. */
      bundleId: z.uuid(),
      parentBundleId: z.uuid(),
      code: z.string(),
      workOrderSizeId: z.uuid(),
      part: z.string().nullable(),
      quantity: z.number().int().min(1),
      reason: z.enum(SPLIT_REASONS),
      postedBy: postedBy(),
    }),
    live: bundleLive,
  }),
  defineEvent({
    type: 'production.rework_opened',
    context: 'production',
    description: "Garments of a cell were sent back to an operation to be made again (from a scan's rework count, or by hand).",
    payload: z.strictObject({
      workOrderId: z.uuid(),
      number: z.string(),
      reworkId: z.uuid(),
      workOrderSizeId: z.uuid(),
      bundleId: z.uuid().nullable(),
      sourceScanId: z.uuid().nullable(),
      foundAtOperationId: z.uuid().nullable(),
      reworkAtOperationId: z.uuid(),
      quantity: z.number().int().min(1),
      /** A child bundle was split off for it in the same command. */
      split: z.boolean(),
      postedBy: postedBy(),
    }),
    live: reworkLive,
  }),
  defineEvent({
    type: 'production.rework_moved',
    context: 'production',
    description: 'A rework was started, finished (good and scrapped garments) or cancelled.',
    payload: z.strictObject({
      workOrderId: z.uuid(),
      number: z.string(),
      reworkId: z.uuid(),
      bundleId: z.uuid().nullable(),
      status: z.enum(REWORK_STATUSES),
      goodQuantity: z.number().int().min(0),
      scrapQuantity: z.number().int().min(0),
      postedBy: postedBy(),
    }),
    live: reworkLive,
  }),
  defineEvent({
    type: 'production.replacement_requested',
    context: 'production',
    description: 'Scrapped garments of a cell are to be replaced: a recut for the cutting room, or a lower order quantity to approve.',
    payload: z.strictObject({
      workOrderId: z.uuid(),
      number: z.string(),
      replacementId: z.uuid(),
      workOrderSizeId: z.uuid(),
      kind: z.enum(REPLACEMENT_KINDS),
      quantity: z.number().int().min(1),
      sourceScanId: z.uuid().nullable(),
      reworkOrderId: z.uuid().nullable(),
    }),
    live: scrapLive,
  }),
  defineEvent({
    type: 'production.replacement_changed',
    context: 'production',
    description: 'A replacement request was approved, refused, done (a recut by its cut log entry) or cancelled.',
    payload: z.strictObject({
      workOrderId: z.uuid(),
      number: z.string(),
      replacementId: z.uuid(),
      kind: z.enum(REPLACEMENT_KINDS),
      status: z.enum(REPLACEMENT_STATUSES),
      cutLogId: z.uuid().nullable(),
    }),
    live: scrapLive,
  }),
  defineEvent({
    type: 'production.scrap_posted',
    context: 'production',
    description: 'Material scrapped for a work order left stock by lot (SCRAP moves; the area of a hide for leather), valued by the stock ledger.',
    payload: z.strictObject({
      workOrderId: z.uuid(),
      number: z.string(),
      /** The first move's id. */
      scrapId: z.uuid(),
      moveIds: z.array(z.uuid()),
      itemIds: z.array(z.uuid()),
      lotIds: z.array(z.uuid()),
      hideIds: z.array(z.uuid()),
      sourceScanId: z.uuid().nullable(),
      reworkOrderId: z.uuid().nullable(),
    }),
    live: scrapLive,
  }),
  // B-W2a-38: production reports (the daily report's subscriptions and its morning mail). Ids, the report's key, the day
  // and counts only: no figure, no name, no e-mail address (the recipient is an office user's id, never a floor worker).
  defineEvent({
    type: 'production.report_subscription_changed',
    context: 'production',
    description: 'Someone was subscribed to a production report e-mailed each morning, or a subscription was changed or turned off.',
    payload: z.strictObject({
      reportKey: z.string(),
      siteId: z.uuid().nullable(),
      subscriptionIds: z.array(z.uuid()).min(1),
      change: z.enum(['SUBSCRIBED', 'CHANGED', 'TURNED_OFF']),
    }),
    live: { permission: 'production.reports.view', fields: ['reportKey'] },
  }),
  defineEvent({
    type: 'production.daily_report_sent',
    context: 'production',
    description: "One person's daily production report was e-mailed by the scheduler (they, or a colleague for them, subscribed).",
    payload: z.strictObject({
      subscriptionId: z.uuid(),
      userId: z.uuid(),
      reportKey: z.string(),
      day: z.iso.date(),
      emailOutboundId: z.uuid(),
      lanes: z.number().int().min(0),
    }),
  }),
  // B-W2b-41: bundles tracked (coupons per operation, stuck bundles, scan-pattern findings, the site's bundle codes). Ids,
  // codes, counts and states only: never a person, never a station (a station can stand for one person), never a reason.
  defineEvent({
    type: 'production.bundle_coupons_changed',
    context: 'production',
    description: "A bundle's coupons changed (MES-067): coupons printed for its scanned operations, one reprinted with a new code (the old one is refused when scanned), or one voided.",
    payload: z.strictObject({
      workOrderId: z.uuid(),
      number: z.string(),
      bundleId: z.uuid(),
      change: z.enum(['ISSUED', 'REPRINTED', 'VOIDED']),
      couponIds: z.array(z.uuid()).min(1),
      postedBy: postedBy(),
    }),
    live: bundleLive,
  }),
  defineEvent({
    type: 'production.bundle_stuck',
    context: 'production',
    description: "A bundle has had no scan for longer than its site allows (MES-168): the floor-now board and the bundles list show it. Told once per wait: a new scan starts a new one.",
    payload: z.strictObject({
      workOrderId: z.uuid(),
      number: z.string(),
      bundleId: z.uuid(),
      code: z.string(),
      siteId: z.uuid(),
      place: z.enum(['CUTTING', 'LINE']),
      lastScanId: z.uuid().nullable(),
      workingHours: z.number().min(0),
      limitHours: z.number().int().min(1),
    }),
    live: { permission: 'production.bundles.view', fields: ['workOrderId', 'number', 'bundleId'] },
  }),
  defineEvent({
    type: 'production.scan_findings_found',
    context: 'production',
    description: 'The scan-pattern checks found patterns about bundles at a site (MES-075): counts per kind, to talk about, never a score.',
    payload: z.strictObject({
      siteId: z.uuid(),
      findingIds: z.array(z.uuid()).min(1),
      bunched: z.number().int().min(0),
      movedNotScanned: z.number().int().min(0),
      gapBelowStandard: z.number().int().min(0),
    }),
    live: { permission: 'production.bundles.view', fields: ['siteId'] },
  }),
  defineEvent({
    type: 'production.scan_finding_reviewed',
    context: 'production',
    description: 'A scan-pattern finding about a bundle was reviewed or dismissed by the office.',
    payload: z.strictObject({ findingId: z.uuid(), siteId: z.uuid(), bundleId: z.uuid(), status: z.enum(['REVIEWED', 'DISMISSED']) }),
    live: { permission: 'production.bundles.view', fields: ['findingId', 'bundleId'] },
  }),
  defineEvent({
    type: 'production.bundle_rules_changed',
    context: 'production',
    description: "A site's bundle rules changed: one bundle code or a coupon per operation (MES-067), and the hours after which a bundle with no scan is stuck (MES-168).",
    payload: z.strictObject({ siteId: z.uuid(), bundleCodeMode: z.enum(['ONE_CODE', 'COUPON_PER_OPERATION']), stuckBundleHours: z.number().int().min(1) }),
    live: { permission: 'production.settings.view', fields: ['siteId', 'bundleCodeMode'] },
  }),
  // B-W2b-29: off-standard and indirect time (MES-155 … MES-158; modules/production/offstandard). A block's ids, its line,
  // station, code and state, its day and its minutes: never the worker, a name or a note (Statuto dei Lavoratori art. 4;
  // the labour inbox and the tablets read the block again). A code's change carries its code only, never its words.
  //   production.off_standard_code_changed   a company's off-standard or indirect code was added, edited, set inactive
  //                                          or active again (the settings grid and the floor's tiles read the codes again)
  //   production.off_standard_started        a block started on the floor: no bundle runs (MES-156, MES-158)
  //   production.off_standard_ended          a block ended (the worker, a bundle scanned, another tile, the team leader,
  //                                          the help call, the clock-out): waiting for approval or approved at once
  //   production.off_standard_recorded       a block typed afterwards by the team leader or the office (ended already)
  //   production.off_standard_decided        a waiting block was approved or rejected (MES-157), alone or with others
  //   production.off_standard_changed        an ended block was corrected or a decided one reopened (MES-204: the labour
  //                                          edit keeps before and after)
  defineEvent({
    type: 'production.off_standard_code_changed',
    context: 'production',
    description: "A company's off-standard or indirect code was added, edited, set inactive or active again.",
    payload: z.strictObject({ companyId: z.uuid(), codeId: z.uuid(), code: z.string().min(1).max(40), change: z.enum(['CREATED', 'EDITED', 'DEACTIVATED', 'REACTIVATED']) }),
    live: { permission: 'production.offstandard.view', fields: ['codeId', 'code', 'change'] },
  }),
  defineEvent({
    type: 'production.off_standard_started',
    context: 'production',
    description: 'A block of off-standard or indirect time started on the floor, while no bundle runs.',
    payload: z.strictObject({
      blockId: z.uuid(),
      siteId: z.uuid(),
      lineId: z.uuid().nullable(),
      stationId: z.uuid().nullable(),
      codeId: z.uuid(),
      code: z.string(),
      kind: z.enum(OFF_STANDARD_KINDS),
      source: z.enum(BLOCK_SOURCES),
      workDate: z.iso.date(),
      status: z.literal('OPEN'),
    }),
    live: offStandardLive,
  }),
  defineEvent({
    type: 'production.off_standard_ended',
    context: 'production',
    description: 'A block of off-standard or indirect time ended: waiting for the team leader, or approved at once for a code that needs no approval.',
    payload: z.strictObject({
      blockId: z.uuid(),
      siteId: z.uuid(),
      lineId: z.uuid().nullable(),
      stationId: z.uuid().nullable(),
      codeId: z.uuid(),
      code: z.string(),
      kind: z.enum(OFF_STANDARD_KINDS),
      endedBy: z.enum(BLOCK_ENDINGS),
      workDate: z.iso.date(),
      minutes: z.number().int().min(0),
      status: z.enum(['PENDING', 'APPROVED']),
    }),
    live: offStandardLive,
  }),
  defineEvent({
    type: 'production.off_standard_recorded',
    context: 'production',
    description: 'A block of off-standard or indirect time was typed afterwards by the team leader or the office.',
    payload: z.strictObject({
      blockId: z.uuid(),
      siteId: z.uuid(),
      lineId: z.uuid().nullable(),
      stationId: z.uuid().nullable(),
      codeId: z.uuid(),
      code: z.string(),
      kind: z.enum(OFF_STANDARD_KINDS),
      workDate: z.iso.date(),
      minutes: z.number().int().min(0),
      status: z.enum(['PENDING', 'APPROVED']),
    }),
    live: offStandardLive,
  }),
  defineEvent({
    type: 'production.off_standard_decided',
    context: 'production',
    description: 'A block of off-standard time waiting for the team leader was approved or rejected.',
    payload: z.strictObject({
      blockId: z.uuid(),
      siteId: z.uuid(),
      lineId: z.uuid().nullable(),
      codeId: z.uuid(),
      code: z.string(),
      status: z.enum(['APPROVED', 'REJECTED']),
      decidedOn: z.enum(['OFFICE', 'FLOOR']),
      /** One of several blocks approved at once ("Approve 8 normal blocks"). */
      bulk: z.boolean(),
    }),
    live: offStandardLive,
  }),
  defineEvent({
    type: 'production.off_standard_changed',
    context: 'production',
    description: 'An ended block of off-standard time was corrected, or a decided one reopened, with its labour edit.',
    payload: z.strictObject({
      blockId: z.uuid(),
      siteId: z.uuid(),
      lineId: z.uuid().nullable(),
      change: z.enum(['CORRECTED', 'REOPENED']),
      /** The block's columns that changed (codeId, startedAt, endedAt, lineId, stationId, status). */
      fields: z.array(z.string()).min(1),
      status: z.enum(['PENDING', 'APPROVED', 'REJECTED']),
    }),
    live: offStandardLive,
  }),
  // ---- B-W2b-46: checks before a scan counts (modules/production/guards). Ids, kinds and the reason tile's code only.
  defineEvent({
    type: 'production.scan_guard_flagged',
    context: 'production',
    description: "A floor report counted although a check before it counts found something the site's rule only warns about (more garments than the operation before passed, a skipped required operation): the team leaders are told.",
    payload: z.strictObject({ workOrderId: z.uuid(), number: z.string(), bundleId: z.uuid(), scanId: z.uuid(), operationId: z.uuid(), operationSeq: z.number().int(), stationId: z.uuid().nullable(), guards: z.array(z.enum(GUARD_KINDS)).min(1) }),
    live: guardLive,
  }),
  defineEvent({
    type: 'production.scan_guard_overridden',
    context: 'production',
    description: "A team leader overrode the checks that held a floor report (more garments than the operation before passed, a skipped required operation, a bundle of another line) with their PIN and a reason; the report counted.",
    payload: z.strictObject({
      workOrderId: z.uuid(),
      number: z.string(),
      bundleId: z.uuid(),
      scanId: z.uuid(),
      operationId: z.uuid(),
      operationSeq: z.number().int(),
      stationId: z.uuid().nullable(),
      guards: z.array(z.enum(GUARD_KINDS)).min(1),
      reasonCode: z.enum(OVERRIDE_REASON_CODES),
    }),
    live: guardLive,
  }),
  // B-W2b-53: floor rules per site (MES-294) and scrap above a site's limit (MES-128). Ids, modes, counts and states:
  // no reason text, no person (who decided stays in the audit log).
  defineEvent({
    type: 'production.floor_rules_changed',
    context: 'production',
    description: "A site's floor checks changed: the quantity guard, the sequence (skipped operations) or the scrap approval limit.",
    payload: z.strictObject({
      siteId: z.uuid(),
      fields: z.array(z.enum(FLOOR_RULE_FIELDS)).min(1),
      quantityGuard: z.enum(FLOOR_RULE_MODES),
      skippedOperationRule: z.enum(FLOOR_RULE_MODES),
      scrapApprovalLimit: z.number().int().min(1).nullable(),
    }),
    live: { permission: 'production.settings.view', floor: 'floor.work', fields: ['siteId', 'fields'] },
  }),
  defineEvent({
    type: 'production.scrap_over_limit_decided',
    context: 'production',
    description: "A scan's scrap above its site's limit was approved (it posts: replacement, scrap of stock, cost) or refused (it does not), on the tablet or in the office.",
    payload: z.strictObject({
      workOrderId: z.uuid(),
      number: z.string(),
      siteId: z.uuid(),
      bundleId: z.uuid(),
      scanId: z.uuid(),
      decision: z.enum(SCRAP_DECISIONS),
      scrapQuantity: z.number().int().min(1),
      limit: z.number().int().min(1),
      decidedOn: z.enum(DECIDED_ON),
    }),
    live: { permission: 'production.scrap.view', floor: 'floor.lead', fields: ['workOrderId', 'number', 'scanId'] },
  }),
] as const
