import { z } from 'zod'
import { defineEvent } from '../events/define'
import { WORK_ORDER_STATUSES } from './work-orders/machine'

/**
 * The production module's events (plan A1 §3.4, §3.5 "workorder.released"; MES-001, MES-005, MES-007; design 02 "Work
 * orders" Live: a work order's status change refreshes the late list and the tiles). apps/factory-api's
 * modules/production emits them in the command that makes the change. Ids, numbers, counts and states only: no money,
 * no customer.
 *
 *   workorder.created         a DRAFT work order was made from sales order lines
 *   workorder.changed         a DRAFT's cells or revision, or a work order's due date, priority or note changed
 *   workorder.released        released with its frozen specification and batch number (the floor can start)
 *   workorder.status_changed  started, completed, closed or cancelled
 */
const live = { permission: 'workorders.view', fields: ['workOrderId', 'number'] } as const

export const WORK_ORDER_CHANGES = ['cells', 'revision', 'details'] as const

export const events = [
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
] as const
