import { z } from 'zod'
import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { notMoney } from '@nexus/factory-domain/money/marked'
import { AREA_LINE_OUTCOMES } from '@nexus/factory-domain/payables/area-check/rules'

/**
 * The leather area check's contracts (B-W2b-403; SCM-132). Areas are decimal strings (four places) in the material's base
 * area unit; no money: the check compares areas, the claim's credit is purchasing's (cost grain there).
 */

const words = output({ en: z.string(), it: z.string() })
const area = () => z.string()

const check = output({
  invoiced: area(),
  invoicedTotal: notMoney(area()),
  received: area(),
  measured: area(),
  measuredHides: z.number().int(),
  unmeasuredHides: z.number().int(),
  difference: area(),
  differencePercent: z.string(),
  outcome: z.enum(AREA_LINE_OUTCOMES),
  opensClaim: z.boolean(),
  shortfall: area(),
})

const line = output({
  lineId: id(),
  seq: z.number().int(),
  description: z.string(),
  quantity: z.string().nullable(),
  uom: z.string().nullable(),
  order: output({ id: id(), number: z.string(), lineId: id(), lineSeq: z.number().int(), siteId: id(), uom: z.string() }),
  item: output({ id: id(), code: z.string(), name: z.string(), baseUom: z.string() }),
  tolerancePercent: z.string(),
  toleranceFrom: z.enum(['ORDER_LINE', 'COMPANY', 'TENANT', 'DEFAULT']),
  lots: z.array(output({ id: id(), code: z.string() })),
  hides: z.array(output({ id: id(), code: z.string(), lotId: id(), received: area(), measured: area().nullable() })),
  check: check.nullable(),
  words,
  claim: output({ opens: z.boolean(), held: z.string().nullable(), existing: z.array(output({ id: id(), number: z.string(), status: z.string() })) }),
})

const params = input({ invoiceId: id() })

export const areaCheckContract = defineContract({ params, response: { 200: output({ invoiceId: id(), lines: z.array(line) }) } })

export const areaClaimContract = defineContract({
  params: input({ invoiceId: id(), lineId: id() }),
  body: input({ reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).optional(), note: z.string().trim().max(400).nullish() }),
  response: { 201: output({ claim: output({ id: id(), number: z.string(), status: z.string() }), check: check.nullable() }) },
})
