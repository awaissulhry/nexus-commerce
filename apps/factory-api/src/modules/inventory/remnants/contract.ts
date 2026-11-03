import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { AREA_UOMS } from '@nexus/factory-domain/inventory/hides/area'
import { HIDE_STATES } from '@nexus/factory-domain/inventory/issue/rules'
import { STOCK_MOVE_REASONS } from '@nexus/factory-domain/inventory/ledger/moves'
import { REMNANT_STATES } from '@nexus/factory-domain/inventory/remnants/rules'
import { notMoney } from '@nexus/factory-domain/money/marked'

/**
 * Remnant stock (B-W2b-100; SCM-254): the contracts of read.ts and backfill.ts. Areas are decimal strings with four
 * decimals in the unit beside them, with the other unit (m² ↔ ft²); the list's totals are pieces beside area. No money; no
 * person in a list (the history names an office person by name, a floor action by its audience).
 */

const areaUom = z.enum(AREA_UOMS)
const figure = output({ uom: areaUom, quantity: z.string(), other: output({ uom: areaUom, quantity: z.string() }) })
const words = output({ it: z.string(), en: z.string() })

export const remnantView = output({
  id: id(),
  code: z.string(),
  state: z.enum(REMNANT_STATES),
  area: figure,
  baseArea: z.string(),
  baseUom: z.string(),
  grade: z.string().nullable(),
  hide: output({ id: id(), code: z.string(), state: z.enum(HIDE_STATES) }),
  lot: output({ id: id(), code: z.string(), dyeBatch: z.string().nullable() }),
  item: output({ id: id(), code: z.string(), name: z.string() }),
  colour: output({ code: z.string(), name: z.string() }).nullable(),
  shade: z.string().nullable(),
  outOfShade: z.boolean(),
  location: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
  /** The move that put it into stock (REMNANT; RETURN for a W1 remnant tagged later) and the work order it came back from. */
  move: output({ id: id(), reason: z.enum(STOCK_MOVE_REASONS), workOrderNumber: z.string().nullable(), occurredAt: instant() }),
  note: z.string().nullable(),
  version: z.number().int(),
  createdAt: instant(),
})

export const listRemnantsContract = defineContract({
  querystring: input({
    siteId: id().optional(),
    itemId: id().optional(),
    itemColourId: id().optional(),
    lotId: id().optional(),
    hideId: id().optional(),
    state: z.enum([...REMNANT_STATES, 'all']).optional(),
    q: z.string().trim().min(1).max(40).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: id().optional(),
  }),
  response: {
    200: output({
      rows: z.array(remnantView),
      nextCursor: id().nullable(),
      /** Pieces beside area per unit of entry, for the whole selection (all pages): counts and areas, not money. */
      totals: notMoney(z.array(output({ uom: areaUom, pieces: z.number().int(), area: z.string(), words }))),
      /** The smallest piece kept as stock (MINIMUM_REMNANT; `setting` false: no setting column yet, every site uses it). */
      minimum: output({ area: z.string(), uom: areaUom, setting: z.boolean() }),
    }),
  },
})

export const remnantParams = input({ remnantId: id() })

export const remnantRecordContract = defineContract({
  params: remnantParams,
  response: {
    200: output({
      remnant: remnantView,
      /** The minimum in the leather's base unit; null for a unit that is not an area. */
      minimum: output({ baseArea: z.string(), setting: z.boolean() }).nullable(),
      history: z.array(
        output({
          at: instant(),
          action: z.enum(['TAGGED', 'STATE', 'MOVED']),
          from: z.string().nullable(),
          to: z.string().nullable(),
          cause: z.string().nullable(),
          /** The office person's name; null for a floor action or the system. */
          by: z.string().nullable(),
          audience: z.string(),
          reason: z.string().nullable(),
        }),
      ),
    }),
  },
})

export const lookupRemnantContract = defineContract({
  querystring: input({ code: z.string().trim().min(3).max(40) }),
  response: { 200: output({ remnant: remnantView }) },
})

export const tagRemnantContract = defineContract({
  body: input({ hideId: id(), note: z.string().trim().max(500).nullish() }),
  response: { 201: output({ remnant: remnantView }) },
})
