import { z } from 'zod'
import { defineEvent } from '../events/define'
import { CUT_TICKET_STATUSES } from '../production/cutorders/rules'
import { SECONDARY_KINDS, SECONDARY_PLACES, SECONDARY_STATUSES } from '../production/cutissue/secondary'
import { CUT_ISSUE_STATUSES } from '../production/cutissue/trolley'

/**
 * After the cut (B-W2b-117; MES-044, MES-047, MES-048; design floor.fabriccut "live": "Recut requested → the recut count on the
 * tile", "Line confirms receipt → the trolley shows 'Received'"). apps/factory-api's modules/production/{rework,cutissue} emit
 * them in the commands that make the change. In a module folder of its own (as production-cutorders).
 *
 *   recut_ticket.changed       a recut ticket was made (asked in the office or at a tablet), printed, started or finished at the
 *                              cutting table, or voided
 *   secondary_process.changed  a bundle was given a secondary process, or it started, was done or was cancelled
 *   cut_issue.changed          a trolley was opened, a bundle scanned onto it or taken off, it was sent to a line, received there
 *                              (with its differences counted) or cancelled
 *
 * They reach the Cutting page (production.cutting.view) and the site's tablets (recuts: production.cut, the cutting table;
 * processes: production.secondary; trolleys: production.trolleys, the cutting room and the line). Ids, codes, states and counts
 * only: no person, no money, no words a person typed.
 */

const office = 'production.cutting.view'

export const RECUT_TICKET_CHANGES = ['MADE', 'PRINTED', 'STARTED', 'DONE', 'VOIDED'] as const
export type RecutTicketChange = (typeof RECUT_TICKET_CHANGES)[number]
export const SECONDARY_PROCESS_CHANGES = ['ADDED', 'STARTED', 'DONE', 'CANCELLED'] as const
export type SecondaryProcessChange = (typeof SECONDARY_PROCESS_CHANGES)[number]
export const CUT_ISSUE_CHANGES = ['OPENED', 'LOADED', 'UNLOADED', 'LINE_CHANGED', 'SENT', 'RECEIVED', 'CANCELLED'] as const
export type CutIssueChange = (typeof CUT_ISSUE_CHANGES)[number]

export const events = [
  defineEvent({
    type: 'recut_ticket.changed',
    context: 'production-cutissue',
    description: 'A recut ticket (replacement panels that join a bundle) was made, printed, started or finished at the cutting table, or voided.',
    payload: z.strictObject({
      ticketId: z.uuid(),
      ticketNumber: z.string(),
      workOrderId: z.uuid(),
      /** The work order's number. */
      number: z.string(),
      workOrderSizeId: z.uuid(),
      /** The bundle its panels join (null: none named). */
      bundleId: z.uuid().nullable(),
      ticketStatus: z.enum(CUT_TICKET_STATUSES),
      change: z.enum(RECUT_TICKET_CHANGES),
      /** MADE from a replacement request: the request. */
      replacementId: z.uuid().nullable(),
      quantity: z.number().int().min(1),
    }),
    live: { permission: office, floor: 'production.cut', fields: ['ticketId', 'ticketNumber', 'workOrderId', 'number', 'change'] },
  }),
  defineEvent({
    type: 'secondary_process.changed',
    context: 'production-cutissue',
    description: 'A bundle was given a secondary process after cutting (fusing, perforation, print, embroidery), or one started, was done or was cancelled.',
    payload: z.strictObject({
      processId: z.uuid(),
      workOrderId: z.uuid(),
      number: z.string(),
      bundleId: z.uuid(),
      kind: z.enum(SECONDARY_KINDS),
      place: z.enum(SECONDARY_PLACES),
      processStatus: z.enum(SECONDARY_STATUSES),
      change: z.enum(SECONDARY_PROCESS_CHANGES),
      workCentreId: z.uuid().nullable(),
    }),
    live: { permission: office, floor: 'production.secondary', fields: ['processId', 'workOrderId', 'number', 'bundleId', 'change'] },
  }),
  defineEvent({
    type: 'cut_issue.changed',
    context: 'production-cutissue',
    description: 'A trolley of cut bundles was opened, loaded or unloaded, sent to a sewing line, received at the line or cancelled.',
    payload: z.strictObject({
      issueId: z.uuid(),
      trolleyCode: z.string(),
      lineId: z.uuid(),
      issueStatus: z.enum(CUT_ISSUE_STATUSES),
      change: z.enum(CUT_ISSUE_CHANGES),
      /** LOADED / UNLOADED: the bundle; otherwise none. */
      bundleId: z.uuid().nullable(),
      /** The work orders of its bundles. */
      workOrderIds: z.array(z.uuid()),
      bundles: z.number().int().min(0),
      /** RECEIVED: the bundles not found at the line. */
      missing: z.number().int().min(0),
    }),
    live: { permission: office, floor: 'production.trolleys', fields: ['issueId', 'trolleyCode', 'lineId', 'change'] },
  }),
] as const
