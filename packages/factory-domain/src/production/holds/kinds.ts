import type { ReasonCodeList } from '../../reasons/lists'

/**
 * B-PR-15 (production plan schema wave 3/5; 08-backend §4.5; B-PR-21 places and lifts them): the plain hold on a work order
 * beside the quality holds, pure — the lists the database's WorkOrderHold mirrors (factory-db domain-mirrors keeps them equal).
 *
 *   PRODUCTION  the factory's own reason: a code of the tenant's PRODUCTION_HOLD reason list (reasons/lists)
 *   BRAND       the customer asked to pause: its accepted HOLD ask (OrderChangeRequest kind HOLD of that customer)
 *
 * A hold is ACTIVE until it is LIFTED (when, by whom, why); the work order is ON_HOLD while any hold names it and leaves
 * ON_HOLD only when no ACTIVE one does (the database's WorkOrder_production_holds). The customer reads "On hold" with the
 * words meant for it, never the office's note.
 */
export const WORK_ORDER_HOLD_KINDS = ['PRODUCTION', 'BRAND'] as const
export type WorkOrderHoldKind = (typeof WORK_ORDER_HOLD_KINDS)[number]

export const WORK_ORDER_HOLD_STATUSES = ['ACTIVE', 'LIFTED'] as const
export type WorkOrderHoldStatus = (typeof WORK_ORDER_HOLD_STATUSES)[number]

/** The reason list of a PRODUCTION hold (reasons/lists REASON_CODE_LISTS). */
export const PRODUCTION_HOLD_LIST = 'PRODUCTION_HOLD' as const satisfies ReasonCodeList

/** The limits the database keeps: the office's note, the customer's words and the lift reason (one line each but the note). */
export const HOLD_NOTE_MAX = 2000
export const HOLD_BRAND_WORDS_MAX = 500
export const HOLD_LIFT_REASON_MAX = 500
