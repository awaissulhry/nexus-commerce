import { z } from 'zod'
import { defineContract, id, input, instant, output, unitPrice } from '@nexus/factory-domain/core/contracts'
import { money, notMoney } from '@nexus/factory-domain/money/marked'
import { FEE_LIMITS, START_KINDS } from '@nexus/factory-domain/sales/price-waterfall/rules'
import { QUOTE_VERSION_STATUSES, SALES_FEE_KINDS, SALES_LINE_KINDS } from '@nexus/factory-domain/sales/quotes/quotes'
import { quoteView } from '../quotes/contract'

/**
 * The price of a line (B-W2b-330; SAL-173, SAL-174, SAL-175, SAL-181, SAL-189). Every price and every waterfall is the
 * price grain (money.price), a margin and a floor the margin grain: the API drops a marked field the caller's grains do
 * not reach and refuses a body that sends one. The quote's `version` guards each write (COL-078); the settings row's
 * `version` the floors.
 */

const version = z.number().int().min(1)
const pct = () => z.string().trim().refine((value) => /^\d{1,3}(\.\d{1,4})?$/.test(value), { message: 'Expected a percent with at most 4 decimals.' })
const reasonCode = () => z.string().trim().regex(/^[A-Z][A-Z0-9_]{1,39}$/, 'Expected a reason code (capitals, digits and _).')
const note = () => z.string().trim().max(500)
const steps = () => money.price(z.array(z.record(z.string(), z.unknown())).nullable())
const why = () => money.price(output({ rows: z.array(z.record(z.string(), z.unknown())), sentence: z.string() }).nullable())
const quoteParams = input({ quoteId: id() })
const lineParams = input({ quoteId: id(), lineId: id() })

const floorView = output({
  marginFloorPct: money.margin(z.string()),
  /** ROLE: the lowest floor of the version maker's listed roles; COMPANY: the company's floor. */
  source: z.enum(['ROLE', 'COMPANY']),
  roleKey: z.string().nullable(),
  personId: id().nullable(),
})

const basedOn = output({ revisionId: id().nullable(), revision: z.number().int().nullable(), revisionStatus: z.string().nullable(), on: z.string().nullable(), computedAt: z.string().nullable() })

const feeCredit = output({ enabled: z.boolean(), words: z.string() })

export const quotePricingContract = defineContract({
  params: quoteParams,
  response: {
    200: output({
      quoteId: id(),
      versionId: id(),
      revision: z.number().int(),
      status: z.enum(QUOTE_VERSION_STATUSES),
      currency: z.string(),
      priceBasis: notMoney(z.enum(['NET', 'GROSS'])),
      floor: floorView,
      lines: z.array(
        output({
          lineId: id(),
          seq: z.number().int(),
          kind: z.enum(SALES_LINE_KINDS),
          feeKind: z.enum(SALES_FEE_KINDS).nullable(),
          styleId: id(),
          colourwayId: id(),
          quantity: z.number().int(),
          unitPrice: money.price(z.string()),
          listUnitPrice: money.price(z.string().nullable()),
          adjustmentReason: z.string().nullable(),
          /** The waterfall as stored (QuoteLine.priceSteps); null: priced without one. */
          steps: steps(),
          /** "Why this price?": each step in words, and one sentence. */
          why: why(),
          stepsProblem: z.string().nullable(),
          /** The steps a LIST start (with the line's options) would write now (NET last); null: no list prices it. */
          fromList: steps(),
          /** SAL-173: the price the line's cost suggests at the floor the version is held to (a fee: null). */
          suggested: output({ unitPrice: money.price(z.string().nullable()), marginPct: money.margin(z.string().nullable()), basedOn: basedOn.nullable(), problem: z.string().nullable() }).nullable(),
          marginPct: money.margin(z.string().nullable()),
          belowFloor: money.margin(z.boolean()),
          fee: output({ creditAgainstBulk: feeCredit }).nullable(),
        }),
      ),
    }),
  },
})

const lineAnswer = output({ lineId: id(), unitPrice: money.price(z.string()), listUnitPrice: money.price(z.string().nullable()), adjustmentReason: z.string().nullable(), steps: steps(), why: why() })

export const priceLineContract = defineContract({
  params: lineParams,
  body: input({
    version,
    start: z.enum(START_KINDS),
    /** MANUAL: the starting price typed (on the version's basis), its reason code and words. */
    startPrice: money.price(unitPrice().nullish()),
    startReasonCode: reasonCode().nullish(),
    startNote: note().nullish(),
    /** SUGGESTED: the margin to earn, percent of the net; default the floor the version is held to. */
    marginPct: money.margin(pct().nullish()),
    /** The options chosen on the line as steps (default true). */
    options: z.boolean().optional(),
    discount: input({ pct: money.price(pct()), reasonCode: reasonCode().nullish(), note: note().nullish() }).nullish(),
    /** SAL-175: the net typed, with its reason code (PRICE_ADJUSTMENT) and words. */
    net: input({ unitPrice: money.price(unitPrice()), reasonCode: reasonCode(), note: note().nullish() }).nullish(),
  }),
  response: { 200: output({ quote: quoteView, line: lineAnswer }) },
})

export const addFeeContract = defineContract({
  params: quoteParams,
  body: input({
    version,
    feeKind: z.enum(SALES_FEE_KINDS),
    styleId: id(),
    colourwayId: id().nullish(),
    unitPrice: money.price(unitPrice()),
    quantity: z.number().int().min(1).max(FEE_LIMITS.quantity).optional(),
    description: z.string().trim().max(FEE_LIMITS.description).nullish(),
    note: z.string().trim().max(FEE_LIMITS.note).nullish(),
  }),
  response: { 201: output({ quote: quoteView }) },
})

export const editFeeContract = defineContract({
  params: lineParams,
  body: input({
    version,
    feeKind: z.enum(SALES_FEE_KINDS).optional(),
    unitPrice: money.price(unitPrice().optional()),
    quantity: z.number().int().min(1).max(FEE_LIMITS.quantity).optional(),
    description: z.string().trim().max(FEE_LIMITS.description).nullish(),
    note: z.string().trim().max(FEE_LIMITS.note).nullish(),
  }),
  response: { 200: output({ quote: quoteView }) },
})

export const orderPricingContract = defineContract({
  params: input({ orderId: id() }),
  response: {
    200: output({
      orderId: id(),
      currency: z.string(),
      lines: z.array(
        output({
          lineId: id(),
          seq: z.number().int(),
          kind: z.enum(SALES_LINE_KINDS),
          feeKind: z.enum(SALES_FEE_KINDS).nullable(),
          description: z.string().nullable(),
          quantity: z.number().int(),
          unitPrice: money.price(z.string()),
          steps: steps(),
          why: why(),
          stepsProblem: z.string().nullable(),
          fee: output({ invoices: z.array(output({ invoiceId: id(), number: z.string().nullable(), draft: z.boolean() })), invoiced: z.boolean(), creditAgainstBulk: feeCredit }).nullable(),
        }),
      ),
    }),
  },
})

const floorsRow = output({ id: id(), companyId: id().nullable(), floors: money.margin(z.record(z.string(), z.string()).nullable()), version: z.number().int(), updatedAt: instant() })

export const getFloorsContract = defineContract({
  querystring: input({ companyId: id().optional() }),
  response: {
    200: output({
      tenant: floorsRow.nullable(),
      company: floorsRow.nullable(),
      inForce: output({ floors: money.margin(z.record(z.string(), z.string()).nullable()), from: z.enum(['COMPANY', 'TENANT']).nullable(), companyFloorPct: money.margin(z.string()) }),
      roles: z.array(output({ key: z.string(), name: z.string() })),
    }),
  },
})

export const saveFloorsContract = defineContract({
  body: input({
    /** A company's own settings; none: the tenant-wide ones (a role over every company). */
    companyId: id().optional(),
    version,
    /** Role key → floor percent (0 to 100, at most 4 decimals); null or {}: no role's own floor. */
    floors: money.margin(z.record(z.string(), pct()).nullable()),
  }),
  response: { 200: output({ settings: floorsRow }) },
})
