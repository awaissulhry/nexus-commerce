import { z } from 'zod'
import { defineEvent } from '../events/define'
import { ROLL_STATES } from '../inventory/rolls/rolls'

/**
 * Rolls, protector lots and consumables (B-W2b-107; SCM-260, SCM-261, SCM-263). apps/factory-api's modules/inventory/rolls
 * emits them in the commands that make the change. Its own module folder, as quality-incoming (B-W2b-98): the inventory events
 * file is other steps' (B-W2b-94, -100 …), so the two never clash.
 *
 *   fabric_roll.tagged         rolls of a fabric lot were tagged (RL-…) against what the lot holds at a place
 *   fabric_roll.changed        a roll changed: described, issued, its end returned, moved, scrapped, corrected, set as an end;
 *                              the lot's move it took (if any) also emits inventory.moved
 *   protector_lot.recorded     a batch or one garment holds a protector lot (EN 1621): what the recall reads
 *   protector_lot.withdrawn    a wrong record was withdrawn by the office, with the reason
 *   consumable.pack_changed    a consumable's pack (how many base units one cone or box holds) was set, changed or removed
 *
 * Rolls reach the warehouse screens (inventory.stock.view) and the site's tablets that issue and cut (inventory.issue);
 * protector records the work order's readers (workorders.view) and the line's tablets that record them; a pack the materials
 * screens (product.materials.view). Ids, tags, states and lengths only: never a person, never money.
 */

const decimal = () => z.string().regex(/^\d{1,14}\.\d{4}$/)
const rollLive = { permission: 'inventory.stock.view', floor: 'inventory.issue', fields: ['rollId', 'code', 'lotId', 'change'] } as const
const protectorLive = { permission: 'workorders.view', floor: 'inventory.protectors.record', fields: ['rowId', 'workOrderId', 'garmentSerialId', 'lotId'] } as const

/** What a roll's change was. */
export const ROLL_CHANGES = ['DESCRIBED', 'ISSUED', 'RETURNED', 'MOVED', 'SCRAPPED', 'CORRECTED', 'END_SET', 'END_CLEARED'] as const
export type RollChange = (typeof ROLL_CHANGES)[number]

export const events = [
  defineEvent({
    type: 'fabric_roll.tagged',
    context: 'inventory-rolls',
    description: "Rolls of a fabric lot were tagged against what the lot holds at a place that no roll claimed yet.",
    payload: z.strictObject({
      lotId: z.uuid(),
      itemId: z.uuid(),
      locationId: z.uuid(),
      rollIds: z.array(z.uuid()).min(1),
      codes: z.array(z.string()).min(1),
      postedBy: z.enum(['FLOOR', 'OFFICE', 'SYSTEM']),
    }),
    live: { permission: 'inventory.stock.view', floor: 'inventory.issue', fields: ['lotId', 'locationId'] },
  }),
  defineEvent({
    type: 'fabric_roll.changed',
    context: 'inventory-rolls',
    description: "A fabric roll changed: what it is, a length taken off it for a work order, its end back, its place, scrapped, its length corrected, or set aside as an end of roll.",
    payload: z.strictObject({
      rollId: z.uuid(),
      code: z.string(),
      lotId: z.uuid(),
      change: z.enum(ROLL_CHANGES),
      state: z.enum(ROLL_STATES),
      lengthLeft: decimal(),
      uom: z.string(),
      moveIds: z.array(z.uuid()),
      workOrderId: z.uuid().nullable(),
      postedBy: z.enum(['FLOOR', 'OFFICE', 'SYSTEM']),
    }),
    live: rollLive,
  }),
  defineEvent({
    type: 'protector_lot.recorded',
    context: 'inventory-rolls',
    description: 'A batch (a work order) or one garment serial of it was recorded as holding a protector lot (EN 1621).',
    payload: z.strictObject({
      rowId: z.uuid(),
      workOrderId: z.uuid(),
      garmentSerialId: z.uuid().nullable(),
      lotId: z.uuid(),
      itemId: z.uuid(),
      postedBy: z.enum(['FLOOR', 'OFFICE', 'SYSTEM']),
    }),
    live: protectorLive,
  }),
  defineEvent({
    type: 'protector_lot.withdrawn',
    context: 'inventory-rolls',
    description: 'A wrong protector lot record of a batch or garment was withdrawn by the office, with the reason.',
    payload: z.strictObject({
      rowId: z.uuid(),
      workOrderId: z.uuid(),
      garmentSerialId: z.uuid().nullable(),
      lotId: z.uuid(),
    }),
    live: protectorLive,
  }),
  defineEvent({
    type: 'consumable.pack_changed',
    context: 'inventory-rolls',
    description: "A consumable's pack was set, changed or removed: how many base units one pack (a cone, a box) holds.",
    payload: z.strictObject({
      itemId: z.uuid(),
      code: z.string(),
      packSize: decimal().nullable(),
      packUom: z.string().nullable(),
    }),
    live: { permission: 'product.materials.view', fields: ['itemId', 'code'] },
  }),
] as const
