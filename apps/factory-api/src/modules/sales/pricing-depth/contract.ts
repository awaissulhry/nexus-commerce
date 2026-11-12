import { z } from 'zod'
import { businessDate, currency, defineContract, id, input, instant, output, unitPrice } from '@nexus/factory-domain/core/contracts'
import { NUMBER_FORMATS } from '@nexus/factory-domain/imports/cells'
import { grainedJson, money, notMoney } from '@nexus/factory-domain/money/marked'
import { PRODUCT_TYPES } from '@nexus/factory-domain/product/styles/rules'
import { PRICE_LIST_LIMITS, PRICE_VERSION_STATUSES } from '@nexus/factory-domain/sales/pricelists/pricelists'
import { MINIMUM_ACTIONS, MINIMUM_PER, PRICING_DEPTH_LIMITS, SURCHARGE_SCOPES } from '@nexus/factory-domain/sales/pricing-depth/rules'

/**
 * Price lists in depth (B-W2b-325; SAL-166, SAL-167, SAL-170, SAL-178, SAL-180, SAL-183). Every price, break, surcharge
 * and small-run surcharge is the price grain (money.price): the API drops it for a caller without the grain and refuses
 * a body that sends one. A version's `version` guards its breaks, surcharges and prices; a list's its discount choice; a
 * minimum's its own edits (COL-078).
 */

const version = z.number().int().min(1)
const pct = () => z.string().refine((value) => /^\d{1,3}(\.\d{1,4})?$/.test(value), { message: 'Expected a percent with at most 4 decimals.' })
const label = output({ code: z.string(), name: z.string() })
const listParams = input({ listId: id() })
const versionParams = input({ listId: id(), versionId: id() })
const quoteParams = input({ quoteId: id() })

// ---- a version's breaks and surcharges ---------------------------------------------------------------------------------

const surchargeView = output({
  id: id(),
  /** Null: every style of the version. */
  styleId: id().nullable(),
  style: label.nullable(),
  size: z.string(),
  amount: money.price(z.string().nullable()),
  currency: z.string().nullable(),
  pct: money.price(z.string().nullable()),
  version: z.number().int(),
})

const rulesView = output({
  list: output({ id: id(), code: z.string(), currency: z.string(), showDiscount: z.boolean() }),
  version: output({ id: id(), revision: z.number().int(), status: z.enum(PRICE_VERSION_STATUSES), version: z.number().int(), updatedAt: instant() }),
  breaks: z.array(
    output({
      id: id(),
      /** Null: every price of the version (a discount). */
      entryId: id().nullable(),
      entry: output({ id: id(), styleId: id(), style: label, colourwayId: id().nullable(), colourway: label.nullable(), unitPrice: money.price(z.string()), validFrom: businessDate().nullable(), validTo: businessDate().nullable() }).nullable(),
      minQuantity: z.number().int(),
      unitPrice: money.price(z.string().nullable()),
      discountPct: money.price(z.string().nullable()),
      version: z.number().int(),
    }),
  ),
  sizeSurcharges: z.array(surchargeView),
  /** The own surcharges of the styles the version prices (kept per style: …/styles/:styleId/size-surcharges). */
  styleSurcharges: z.array(surchargeView),
})

export const rulesContract = defineContract({ params: versionParams, response: { 200: rulesView } })

export const setBreaksContract = defineContract({
  params: versionParams,
  body: input({
    version,
    breaks: z
      .array(input({ entryId: id().nullable(), minQuantity: z.number().int(), unitPrice: money.price(unitPrice().nullable()), discountPct: money.price(pct().nullable()) }))
      .min(1)
      .max(PRICING_DEPTH_LIMITS.rows),
  }),
  response: { 200: rulesView },
})

export const setVersionSurchargesContract = defineContract({
  params: versionParams,
  body: input({
    version,
    surcharges: z
      .array(input({ styleId: id().nullable(), size: z.string().trim().min(1).max(PRICING_DEPTH_LIMITS.size), amount: money.price(unitPrice().nullable()), pct: money.price(pct().nullable()) }))
      .min(1)
      .max(PRICING_DEPTH_LIMITS.rows),
  }),
  response: { 200: rulesView },
})

const styleSurchargesView = output({ style: output({ id: id(), code: z.string(), name: z.string() }), surcharges: z.array(surchargeView) })
export const getStyleSurchargesContract = defineContract({ params: input({ styleId: id() }), response: { 200: styleSurchargesView } })
export const setStyleSurchargesContract = defineContract({
  params: input({ styleId: id() }),
  body: input({
    surcharges: z
      .array(input({ size: z.string().trim().min(1).max(PRICING_DEPTH_LIMITS.size), amount: money.price(unitPrice().nullable()), currency: currency().nullish(), pct: money.price(pct().nullable()) }))
      .min(1)
      .max(PRICING_DEPTH_LIMITS.rows),
  }),
  response: { 200: styleSurchargesView },
})

// ---- dated prices ------------------------------------------------------------------------------------------------------

const entryView = output({
  id: id(),
  styleId: id(),
  style: output({ code: z.string(), name: z.string(), status: z.string() }),
  colourwayId: id().nullable(),
  colourway: label.nullable(),
  unitPrice: money.price(z.string()),
  standardCost: money.cost(z.string().nullable()),
  marginPct: money.margin(z.string().nullable()),
  belowFloor: money.margin(z.boolean()),
  validFrom: businessDate().nullable(),
  validTo: businessDate().nullable(),
  version: z.number().int(),
})
const versionView = output({
  id: id(),
  revision: z.number().int(),
  status: z.enum(PRICE_VERSION_STATUSES),
  validFrom: z.string().nullable(),
  validTo: z.string().nullable(),
  activatedAt: instant().nullable(),
  activatedById: id().nullable(),
  note: z.string().nullable(),
  entries: z.number().int(),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})

export const setDatedPricesContract = defineContract({
  params: versionParams,
  body: input({
    version,
    // The rows; each row's price is marked.
    prices: notMoney(
      z
        .array(input({ styleId: id(), colourwayId: id().nullable(), validFrom: businessDate().nullable(), validTo: businessDate().nullable(), unitPrice: money.price(unitPrice().nullable()) }))
        .min(1)
        .max(PRICE_LIST_LIMITS.entries),
    ),
  }),
  response: { 200: output({ version: versionView, entries: z.array(entryView) }) },
})

export const discountDisplayContract = defineContract({
  params: listParams,
  body: input({ version, showDiscount: z.boolean() }),
  response: { 200: output({ list: output({ id: id(), code: z.string(), showDiscount: z.boolean(), version: z.number().int() }) }) },
})

// ---- import and export -------------------------------------------------------------------------------------------------

export const exportContract = defineContract({
  params: versionParams,
  querystring: input({ format: z.enum(['csv', 'xlsx']).default('xlsx'), numberFormat: z.enum(NUMBER_FORMATS).default('it') }),
  response: {},
})

// ---- minimums ----------------------------------------------------------------------------------------------------------

const minimumView = output({
  id: id(),
  companyId: id().nullable(),
  /** The price list whose customers it binds (null: every customer): a reference, not money. */
  priceListId: notMoney(id().nullable()),
  priceList: notMoney(output({ id: id(), code: z.string(), name: z.string() }).nullable()),
  subject: z.enum(['STYLE', 'PRODUCT_TYPE', 'MATERIAL']),
  styleId: id().nullable(),
  style: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
  productType: z.enum(PRODUCT_TYPES).nullable(),
  itemId: id().nullable(),
  item: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
  minQuantity: z.number().int(),
  per: z.enum(MINIMUM_PER),
  action: z.enum(MINIMUM_ACTIONS),
  surchargeAmount: money.price(z.string().nullable()),
  currency: z.string().nullable(),
  surchargePct: money.price(z.string().nullable()),
  note: z.string().nullable(),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})
const oneMinimum = { 200: output({ minimum: minimumView }) }
const ruleParams = input({ ruleId: id() })
const note = z.string().max(PRICING_DEPTH_LIMITS.note)

export const listMinimumsContract = defineContract({
  querystring: input({ companyId: id().optional(), priceListId: notMoney(id().optional()), styleId: id().optional(), status: z.enum(['ACTIVE', 'ARCHIVED', 'ALL']).optional() }),
  response: { 200: output({ minimums: z.array(minimumView) }) },
})
export const getMinimumContract = defineContract({ params: ruleParams, response: oneMinimum })
export const createMinimumContract = defineContract({
  body: input({
    companyId: id().nullish(),
    /** The price list whose customers it binds: a reference, not money. */
    priceListId: notMoney(id().nullish()),
    styleId: id().nullish(),
    productType: z.enum(PRODUCT_TYPES).nullish(),
    itemId: id().nullish(),
    minQuantity: z.number().int(),
    per: z.enum(MINIMUM_PER),
    action: z.enum(MINIMUM_ACTIONS),
    surchargeAmount: money.price(unitPrice().nullish()),
    currency: currency().nullish(),
    surchargePct: money.price(pct().nullish()),
    note: note.nullish(),
  }),
  response: { 201: output({ minimum: minimumView }) },
})
export const updateMinimumContract = defineContract({
  params: ruleParams,
  body: input({
    version,
    /** The price list whose customers it binds: a reference, not money. */
    priceListId: notMoney(id().nullish()),
    minQuantity: z.number().int().optional(),
    per: z.enum(MINIMUM_PER).optional(),
    action: z.enum(MINIMUM_ACTIONS).optional(),
    surchargeAmount: money.price(unitPrice().nullish()),
    currency: currency().nullish(),
    surchargePct: money.price(pct().nullish()),
    note: note.nullish(),
  }),
  response: oneMinimum,
})
export const moveMinimumContract = defineContract({ params: ruleParams, body: input({ version }), response: oneMinimum })
export const deleteMinimumContract = defineContract({ params: ruleParams, querystring: input({ version: z.coerce.number().int().min(1) }), response: { 200: output({ deleted: output({ id: id() }) }) } })

// ---- a quote's list prices and the line rules --------------------------------------------------------------------------

export const quoteListPricesContract = defineContract({
  params: quoteParams,
  response: {
    200: output({
      quoteId: id(),
      versionId: id(),
      revision: z.number().int(),
      /** The quote's date (its version's day): the dated price that holds then. */
      day: businessDate(),
      currency: z.string(),
      priceBasis: notMoney(z.enum(['NET', 'GROSS'])),
      showDiscount: z.boolean(),
      lines: z.array(
        output({
          lineId: id(),
          seq: z.number().int(),
          styleId: id(),
          colourwayId: id(),
          quantity: z.number().int(),
          /** What the line holds now. */
          listUnitPrice: money.price(z.string().nullable()),
          lineUnitPrice: money.price(z.string()),
          /** The price list entry the line is priced from. */
          list: output({
            listId: id(),
            code: z.string(),
            versionId: id(),
            revision: z.number().int().nullable(),
            entryId: id(),
            validFrom: businessDate().nullable(),
            validTo: businessDate().nullable(),
            /** The colourway's own price (true), or the style's for every colourway. */
            colourwayPrice: notMoney(z.boolean()),
            depth: z.number().int(),
          }).nullable(),
          /** From the list, on the quote's price basis. */
          listPrice: money.price(z.string().nullable()),
          break: output({
            breakId: id(),
            ownBreak: z.boolean(),
            minQuantity: z.number().int(),
            /** The pieces the break counted (every line of the version this price prices). */
            pieces: z.number().int(),
            unitPrice: money.price(z.string()),
            discountPct: money.price(z.string().nullable()),
            delta: money.price(z.string()),
          }).nullable(),
          /** The list price after the break. */
          unitPrice: money.price(z.string().nullable()),
          sizeSurcharges: z.array(output({ size: z.string(), surchargeId: id(), scope: z.enum(SURCHARGE_SCOPES), amount: money.price(z.string()), pct: money.price(z.string().nullable()) })),
          /** The waterfall's first steps (factory-db QuoteLine.priceSteps' shape), for B-W2b-330 to write with the price. */
          steps: money.price(z.array(z.record(z.string(), z.unknown()))),
        }),
      ),
    }),
  },
})

const findingView = output({
  check: z.string(),
  code: z.string(),
  severity: z.enum(['BLOCKS', 'WARNING']),
  lineIds: z.array(id()),
  seqs: z.array(z.number().int()),
  message: z.string(),
  /** The rule's details (a minimum: ruleId, action, per, minQuantity, quantity, colourwayId, its small-run surcharge). */
  details: grainedJson(),
})

export const quoteLineChecksContract = defineContract({
  params: quoteParams,
  response: { 200: output({ versionId: id(), /** The price list that prices it. */ priceListId: notMoney(id().nullable()), findings: z.array(findingView) }) },
})
export const orderLineChecksContract = defineContract({
  params: input({ orderId: id() }),
  response: { 200: output({ orderId: id(), /** The price list that prices it. */ priceListId: notMoney(id().nullable()), findings: z.array(findingView) }) },
})
