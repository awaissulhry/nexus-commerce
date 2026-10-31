import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { KIT_HELD } from '@nexus/factory-domain/inventory/kits/rules'
import { KIT_STATUSES } from '../issue/kit-rules'

/**
 * Kit staging's contracts (B-W2b-15; SCM-213). A kit is one work order's: its id is the work order's. Quantities are
 * counts of lines (planned materials), never money; the check keeps no person in what it answers (only when).
 */

const named = output({ id: id(), code: z.string(), name: z.string() })
const action = output({ allowed: z.boolean(), held: z.enum(KIT_HELD).nullable(), count: z.number().int().optional() })

/** The kit as a list row and a sheet show it (Picking & kits): the picks' state, its place, the check, its version. */
export const kitView = output({
  /** From the picks: OPEN (nothing issued), PARTLY, COMPLETE (every line issued in full). */
  status: z.enum(KIT_STATUSES),
  /** Where it waits; null: not staged. */
  location: named.nullable(),
  /** When it was checked complete; null: not checked (or opened again). */
  checkedAt: instant().nullable(),
  /** The kit record's version (0: no record yet; the first write makes it). */
  version: z.number().int().min(0),
})

export const kitRecord = output({
  workOrderId: id(),
  number: z.string(),
  workOrderStatus: z.string(),
  siteId: id(),
  status: z.enum(KIT_STATUSES),
  lines: output({ all: z.number().int(), picked: z.number().int(), short: z.number().int() }),
  location: named.nullable(),
  checkedAt: instant().nullable(),
  note: z.string().nullable(),
  version: z.number().int().min(0),
  actions: output({ stage: action, complete: action, reopen: action }),
})

const params = input({ workOrderId: id() })
const one = { 200: output({ kit: kitRecord }) }

export const getKitContract = defineContract({ params, response: one })

export const stageKitContract = defineContract({
  params,
  body: input({
    /** The version read (0 while the work order has no kit record yet). */
    version: z.number().int().min(0),
    /** A location of the work order's site in use (not a workshop's); null takes the kit off its place. */
    locationId: id().nullable(),
  }),
  response: one,
})

export const completeKitContract = defineContract({
  params,
  body: input({
    version: z.number().int().min(0),
    /** What the person saw, when there is something to say (kept on the kit). */
    note: z.string().trim().min(1).max(500).optional(),
  }),
  response: one,
})

export const reopenKitContract = defineContract({
  params,
  body: input({
    version: z.number().int().min(1),
    /** Why it is open again (a line given back, something missing): required, kept in the history. */
    reason: z.string().trim().min(1).max(500),
  }),
  response: one,
})
