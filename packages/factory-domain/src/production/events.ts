import { z } from 'zod'
import { defineEvent } from '../events/define'
import { HIDE_STATES } from '../inventory/issue/rules'
import { GARMENT_TRACKINGS } from './serials/rules'
import { SCAN_SUBJECTS } from './settings/monitoring'
import { WORK_ORDER_STATUSES } from './work-orders/machine'

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
 */
export const MONITORING_CHANGES = ['WIDENED', 'NARROWED', 'BASIS_RECORDED', 'BASIS_REPLACED'] as const

const subject = z.enum(SCAN_SUBJECTS)

const live = { permission: 'workorders.view', fields: ['workOrderId', 'number'] } as const

export const WORK_ORDER_CHANGES = ['cells', 'revision', 'details'] as const

const decimal = () => z.string().regex(/^\d{1,14}\.\d{4}$/)
const postedBy = () => z.enum(['OFFICE', 'FLOOR', 'SYSTEM'])
/** The cutting tables of the event's site and the office's cutting screens (production.cut). */
const cutLive = { permission: 'production.cut', floor: true, fields: ['workOrderId', 'number', 'hideId'] } as const
/** The bundles screens of the event's site and the office's (production.bundles). */
const bundleLive = { permission: 'production.bundles', floor: true, fields: ['workOrderId', 'number', 'bundleId'] } as const
/** WIP and the work order record (workorders.view) and the floor devices of the event's site. */
const scanLive = { permission: 'workorders.view', floor: true, fields: ['workOrderId', 'number', 'bundleId'] } as const
/** Approvals and the refused scans (production.scan.correct) and the floor devices of the event's site. */
const correctionLive = { permission: 'production.scan.correct', floor: true, fields: ['workOrderId', 'number', 'requestId'] } as const
/** The garment label screens of the event's site and the office's (production.serials). */
const labelLive = { permission: 'production.serials', floor: true, fields: ['workOrderId', 'number', 'workOrderSizeId'] } as const

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
    live: { ...live, floor: true, fields: ['workOrderId', 'number', 'batchNumber'] },
  }),
  defineEvent({
    type: 'workorder.status_changed',
    context: 'production',
    description: 'A work order was started, completed, closed or cancelled.',
    payload: z.strictObject({ workOrderId: z.uuid(), number: z.string(), from: z.enum(WORK_ORDER_STATUSES), to: z.enum(WORK_ORDER_STATUSES) }),
    live: { ...live, floor: true, fields: ['workOrderId', 'number', 'to'] },
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
    live: { permission: 'production.scan.correct', floor: true, fields: ['refusalId', 'deviceId', 'code'] },
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
] as const
