import { z } from 'zod'
import { defineEvent } from '../events/define'
import { CUT_ORDER_KINDS, CUT_ORDER_STATUSES, CUT_TICKET_STATUSES, PLY_RUN_STATUSES } from '../production/cutorders/rules'

/**
 * Cut orders and cut tickets (B-W2b-112; MES-034, MES-037, MES-041, MES-043; design production.cutting "live", floor.fabriccut).
 * apps/factory-api's modules/production/cutorders emits them in the commands that make the change. In a module folder of its own
 * (as production-repair): production/events.ts is other steps'.
 *
 *   cut_order.changed   a cut order was planned, its plan changed, it was released (with its tickets), sent back to planning,
 *                       cancelled, started at a table (its first ticket), cut (its last ticket), or rolls were allocated to its
 *                       lays or taken off them
 *   cut_ticket.changed  a ticket was made (at a release, or to replace a lost one), printed, scanned at the start or at the end
 *                       of cutting, or voided
 *   ply_run.changed     a run of ply stickers was made (and printed), printed again, or voided
 *
 * They reach the Cutting page (production.cutting.view) and the cutting tablets of the site (production.cut). Ids, numbers,
 * states and counts only: no person, no money, no words a person typed.
 */

const live = { permission: 'production.cutting.view', floor: 'production.cut', fields: ['cutOrderId', 'number', 'status', 'change'] } as const

export const CUT_ORDER_CHANGES = ['PLANNED', 'PLAN_CHANGED', 'RELEASED', 'BACK_TO_PLANNING', 'CANCELLED', 'STARTED', 'CUT', 'ROLLS_ALLOCATED', 'ROLLS_REMOVED'] as const
export type CutOrderChange = (typeof CUT_ORDER_CHANGES)[number]
export const CUT_TICKET_CHANGES = ['MADE', 'PRINTED', 'STARTED', 'DONE', 'VOIDED'] as const
export type CutTicketChange = (typeof CUT_TICKET_CHANGES)[number]
export const PLY_RUN_CHANGES = ['MADE', 'PRINTED', 'VOIDED'] as const
export type PlyRunChange = (typeof PLY_RUN_CHANGES)[number]

export const events = [
  defineEvent({
    type: 'cut_order.changed',
    context: 'production-cutorders',
    description: 'A cut order was planned or re-planned, released with its tickets, sent back to planning, cancelled, started or cut at a table, or rolls were allocated to its lays or taken off them.',
    payload: z.strictObject({
      cutOrderId: z.uuid(),
      number: z.string(),
      kind: z.enum(CUT_ORDER_KINDS),
      status: z.enum(CUT_ORDER_STATUSES),
      change: z.enum(CUT_ORDER_CHANGES),
      /** The work orders its lines cut. */
      workOrderIds: z.array(z.uuid()),
      /** ROLLS_ALLOCATED / ROLLS_REMOVED: the lay and the rolls. */
      layId: z.uuid().nullable(),
      rollIds: z.array(z.uuid()),
    }),
    live,
  }),
  defineEvent({
    type: 'cut_ticket.changed',
    context: 'production-cutorders',
    description: 'A cut ticket was made, printed, scanned at the start or at the end of cutting, or voided.',
    payload: z.strictObject({
      ticketId: z.uuid(),
      ticketNumber: z.string(),
      cutOrderId: z.uuid(),
      number: z.string(),
      layId: z.uuid().nullable(),
      ticketStatus: z.enum(CUT_TICKET_STATUSES),
      status: z.enum(CUT_ORDER_STATUSES),
      change: z.enum(CUT_TICKET_CHANGES),
      /** VOIDED with a replacement: the new ticket. */
      replacedById: z.uuid().nullable(),
    }),
    live: { ...live, fields: ['cutOrderId', 'number', 'ticketId', 'ticketNumber', 'change'] },
  }),
  defineEvent({
    type: 'ply_run.changed',
    context: 'production-cutorders',
    description: 'A run of ply stickers of a counted lay was made (and printed), printed again, or voided.',
    payload: z.strictObject({
      plyRunId: z.uuid(),
      layId: z.uuid(),
      cutOrderId: z.uuid(),
      number: z.string(),
      runStatus: z.enum(PLY_RUN_STATUSES),
      change: z.enum(PLY_RUN_CHANGES),
      firstPly: z.number().int().min(1),
      lastPly: z.number().int().min(1),
      labelCount: z.number().int().min(1),
    }),
    live: { ...live, fields: ['cutOrderId', 'number', 'plyRunId', 'change'] },
  }),
] as const
