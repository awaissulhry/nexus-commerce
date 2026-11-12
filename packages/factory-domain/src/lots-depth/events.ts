import { z } from 'zod'
import { defineEvent } from '../events/define'
import { LIFECYCLE_CAUSES, LOT_LIFECYCLES } from '../inventory/lots-depth/lifecycle'
import { SPLIT_KINDS } from '../inventory/lots-depth/split'
import { TRACE_REPORT_AUDIENCES, TRACE_REPORT_FORMATS } from '../inventory/lots-depth/trace-report'

/**
 * Lots in depth (B-W2b-313; the code is factory-domain inventory/lots-depth). A module folder of its own, as materials-depth
 * (the event guard wants `src/<module>/events.ts`; the inventory events file is other steps'). apps/factory-api's
 * modules/inventory/lots-depth and inventory/trace/report.ts emit them in the commands that make the change.
 *
 *   lot.lifecycle_changed    a lot moved in its life (QUARANTINE → RELEASED → IN_USE → DEPLETED; BLOCKED; RETURNED), with
 *                            what moved it: the lists' Lifecycle column and Depleted view read again
 *   lot.split                hides of a lot went into child lots (SPLIT: new child lots, one per shade group; REGROUP: into
 *                            lots of the family that exist); each hide is a new tag in its new lot
 *   lot.attributes_changed   a lot's attributes were recorded or changed (the keys that changed, never the values)
 *   lot.trace_report_made    a dated trace report was made for a customer, a notified body or an authority (its file)
 *
 * Live for inventory.stock.view. Ids, codes, states and counts only: no person, no party name, no money.
 */

const live = { permission: 'inventory.stock.view' } as const

export const events = [
  defineEvent({
    type: 'lot.lifecycle_changed',
    context: 'lots-depth',
    description: 'A lot moved in its life (released, first issue, last unit out, blocked, sent back, stock back), as its stock moves and quality decisions say.',
    payload: z.strictObject({
      lotId: z.uuid(),
      code: z.string(),
      from: z.enum(LOT_LIFECYCLES),
      to: z.enum(LOT_LIFECYCLES),
      cause: z.enum(LIFECYCLE_CAUSES),
    }),
    live: { ...live, fields: ['lotId', 'code', 'from', 'to', 'cause'] },
  }),
  defineEvent({
    type: 'lot.split',
    context: 'lots-depth',
    description: 'Hides of a lot went into child lots that keep the parent link (new shade lots, or a regroup into lots of the family), each with a new tag.',
    payload: z.strictObject({
      kind: z.enum(SPLIT_KINDS),
      parentLotId: z.uuid(),
      fromLotIds: z.array(z.uuid()).min(1),
      toLotIds: z.array(z.uuid()).min(1),
      newLotIds: z.array(z.uuid()),
      hides: z.number().int().min(1),
      moveIds: z.array(z.uuid()),
    }),
    live: { ...live, fields: ['kind', 'parentLotId', 'fromLotIds', 'toLotIds', 'newLotIds'] },
  }),
  defineEvent({
    type: 'lot.attributes_changed',
    context: 'lots-depth',
    description: "A lot's attributes (thickness range, finish, tannage, grade mix, origin; a fabric's width and weight) were recorded or changed.",
    payload: z.strictObject({ lotId: z.uuid(), code: z.string(), keys: z.array(z.string()).min(1) }),
    live: { ...live, fields: ['lotId', 'code', 'keys'] },
  }),
  defineEvent({
    type: 'lot.trace_report_made',
    context: 'lots-depth',
    description: 'A dated trace report was made for a customer, a notified body or an authority, and kept as a file of the record traced.',
    payload: z.strictObject({
      recordType: z.string(),
      recordId: z.uuid(),
      fileId: z.uuid(),
      audience: z.enum(TRACE_REPORT_AUDIENCES),
      format: z.enum(TRACE_REPORT_FORMATS),
      direction: z.enum(['BACKWARD', 'FORWARD', 'BOTH']),
      asOf: z.string(),
      nodes: z.number().int().min(0),
    }),
    live: { ...live, fields: ['recordType', 'recordId', 'fileId'] },
  }),
] as const
