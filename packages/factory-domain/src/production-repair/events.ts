import { z } from 'zod'
import { defineEvent } from '../events/define'
import { REWORK_STATUSES } from '../production/rework/rules'
import { DOWNGRADE_TARGETS, REPAIR_STEPS } from '../production/repair/rules'

/**
 * The repair station and second quality (B-W2b-126; MES-132, MES-133; design floor.mywork "repair queue", production.scrap
 * "live: production.scan_recorded with scrap → rows and tiles"). apps/factory-api's modules/production/repair emits them in
 * the commands that make the change. In a module folder of its own (as quality-inprocess, plant-statutory): production/events.ts
 * is other steps'.
 *
 *   production.repair_scanned       a bundle was scanned in at a repair station (its rework started), or scanned out (its
 *                                   rework finished with good and scrapped garments, and its repair minutes)
 *   production.garments_downgraded  scrapped garments went to second quality instead of scrap, with the reason and the stock
 *                                   move that put them into a place
 *   production.downgrade_withdrawn  a wrong downgrade was withdrawn with the reason (its stock taken out again)
 *
 * The repair scans reach the repair tablets of the site (production.repair) and Scrap & rework (production.scrap.view);
 * downgrades reach Scrap & rework. Ids, codes, counts and states only: no person, no money, no words a person typed.
 */

const repairLive = { permission: 'production.scrap.view', floor: 'production.repair', fields: ['workOrderId', 'number', 'reworkId', 'step'] } as const
const downgradeLive = { permission: 'production.scrap.view', fields: ['workOrderId', 'number', 'downgradeId'] } as const

export const events = [
  defineEvent({
    type: 'production.repair_scanned',
    context: 'production-repair',
    description: 'A bundle was scanned in at a repair station (its rework started) or scanned out (its rework finished with good and scrapped garments), with the repair minutes per rework.',
    payload: z.strictObject({
      workOrderId: z.uuid(),
      number: z.string(),
      reworkId: z.uuid(),
      bundleId: z.uuid().nullable(),
      step: z.enum(REPAIR_STEPS),
      /** The station that scanned it in. */
      stationId: z.uuid(),
      status: z.enum(REWORK_STATUSES),
      repairInAt: z.iso.datetime(),
      repairOutAt: z.iso.datetime().nullable(),
      /** OUT: whole minutes between the scans (per rework, never per person). */
      minutes: z.number().int().min(0).nullable(),
      goodQuantity: z.number().int().min(0),
      scrapQuantity: z.number().int().min(0),
    }),
    live: repairLive,
  }),
  defineEvent({
    type: 'production.garments_downgraded',
    context: 'production-repair',
    description: 'Scrapped garments of a cell went to second quality instead of scrap (ESPR), with the reason and the stock move that put them into a place as the SKU or a second-quality item.',
    payload: z.strictObject({
      workOrderId: z.uuid(),
      number: z.string(),
      downgradeId: z.uuid(),
      workOrderSizeId: z.uuid(),
      bundleId: z.uuid().nullable(),
      reworkOrderId: z.uuid().nullable(),
      sourceScanId: z.uuid().nullable(),
      quantity: z.number().int().min(1),
      reasonCode: z.string(),
      target: z.enum(DOWNGRADE_TARGETS),
      itemId: z.uuid(),
      variantId: z.uuid().nullable(),
      moveId: z.uuid(),
      toLocationId: z.uuid(),
    }),
    live: downgradeLive,
  }),
  defineEvent({
    type: 'production.downgrade_withdrawn',
    context: 'production-repair',
    description: 'A wrong downgrade to second quality was withdrawn with the reason; the move that took its garments out of stock again.',
    payload: z.strictObject({
      workOrderId: z.uuid(),
      number: z.string(),
      downgradeId: z.uuid(),
      quantity: z.number().int().min(1),
      /** The reversal of its stock move; null: an older downgrade that moved no stock. */
      moveId: z.uuid().nullable(),
    }),
    live: downgradeLive,
  }),
] as const
