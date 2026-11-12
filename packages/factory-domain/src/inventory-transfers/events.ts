import { z } from 'zod'
import { defineEvent } from '../events/define'
import { TRANSFER_RESOLUTIONS, TRANSFER_STATUSES } from '../inventory/transfers/rules'

/**
 * The events of transfers between sites (B-W2b-326; SCM-219, SCM-220; apps/factory-api modules/inventory/transfers). Its
 * own module folder, as inventory-locations (B-W2b-289): the inventory events file is other steps', so the two never
 * clash. The stock moves a transfer posts are inventory.moved events of their own (the ship's TRANSFER onto the transit
 * place, the receipt's TRANSFER_OUT and TRANSFER_IN, a difference written off); this one says what happened to the
 * transfer. Its company and site are the SENDING site's; the receiving site's screens follow the TRANSFER_IN moves.
 *
 *   inventory.transfer_changed   once per step: drafted, its header or lines edited, shipped (with its DDT number),
 *                                goods received, a difference settled, its DDT's PDF stored, cancelled
 */
export const events = [
  defineEvent({
    type: 'inventory.transfer_changed',
    context: 'inventory-transfers',
    description: 'A transfer between sites was drafted, edited, shipped with its DDT, received (in part or in full), had a difference settled or its DDT printed, or was cancelled.',
    payload: z.strictObject({
      transferId: z.uuid(),
      number: z.string(),
      change: z.enum(['CREATED', 'EDITED', 'LINES', 'SHIPPED', 'RECEIVED', 'SETTLED', 'PRINTED', 'CANCELLED']),
      status: z.enum(TRANSFER_STATUSES),
      previousStatus: z.enum(TRANSFER_STATUSES).nullable(),
      fromSiteId: z.uuid(),
      toSiteId: z.uuid(),
      toCompanyId: z.uuid(),
      /** The DDT's number once shipped. */
      ddtNumber: z.string().nullable(),
      /** SETTLED: the line and how. */
      lineId: z.uuid().nullable(),
      resolution: z.enum(TRANSFER_RESOLUTIONS).nullable(),
    }),
    live: { permission: 'inventory.stock.view', fields: ['transferId', 'number', 'change', 'status', 'previousStatus', 'fromSiteId', 'toSiteId'] },
  }),
] as const
