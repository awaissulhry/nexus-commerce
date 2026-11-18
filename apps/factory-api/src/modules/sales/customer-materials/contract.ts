import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'

/**
 * The customer-supplied materials routes (B-W2b-309; modules/sales/customer-materials). Quantities in the material's base
 * unit, 4 decimals; no money anywhere (a customer's own material is never valued).
 */

const words = output({ en: z.string(), it: z.string() })
const params = input({ orderId: id() })
const item = output({ id: id(), code: z.string(), name: z.string() })
const colour = output({ id: id(), code: z.string(), name: z.string().nullable() }).nullable()
const quantity = z.string()

const row = output({
  id: id(),
  orderLineId: id(),
  seq: z.number().int(),
  bomRevisionId: id(),
  bomLineId: id(),
  item,
  colour,
  uom: z.string(),
  expected: quantity,
  expectedBySize: z.record(z.string(), quantity),
  received: quantity,
  used: quantity,
  returned: quantity,
  left: quantity,
  note: z.string().nullable(),
  version: z.number().int(),
  /** B-SA-043 (office only): what of it the order's extra pieces took (cut beyond the order), in its base unit; null: none. */
  usedForExtra: quantity.nullable(),
})

const view = {
  orderId: id(),
  number: z.string(),
  partyId: id(),
  rows: z.array(row),
  notPlanned: z.array(output({ orderLineId: id(), bomLineId: id(), item, colour, uom: z.string(), expected: quantity, expectedBySize: z.record(z.string(), quantity), words })),
  lots: z.array(output({ id: id(), code: z.string(), itemId: id(), itemColourId: id().nullable(), siteId: id(), onHand: quantity, receiptId: id().nullable(), receiptNumber: z.string().nullable(), receivedAt: instant().nullable() })),
  problems: z.array(z.string()),
  empty: words.nullable(),
  /** B-SA-043 (office only): the order's extra pieces per line and size ("Made extra: 4 M"), and the words of the rows' usedForExtra. */
  extra: output({ pieces: z.array(output({ lineId: id(), size: z.string(), count: z.number().int(), words })), usedWords: words.nullable() }),
}

export const listCustomerMaterialsContract = defineContract({ params, response: { 200: output(view) } })

export const planCustomerMaterialsContract = defineContract({
  params,
  response: { 200: output({ ...view, planned: output({ made: z.number().int(), changed: z.number().int(), removed: z.number().int(), kept: z.number().int(), problems: z.array(z.string()) }) }) },
})

export const recountCustomerMaterialsContract = defineContract({ params, response: { 200: output({ ...view, changed: z.number().int() }) } })
