import { z } from 'zod'
import { defineContract, id, input, instant, output, unitPrice } from '@nexus/factory-domain/core/contracts'
import { money } from '@nexus/factory-domain/money/marked'
import { PRICE_MATCHES } from '@nexus/factory-domain/sales/brand-prices/match'

/**
 * The customer's price and the price check of one order (customer page plan C2d, C3, B-CP-017; design customer-page 11 §1.2; the
 * money wall, Owner O1-O4; review B2, B4). EVERY key of these contracts is the price grain (`money.price`), ids, words and
 * counts included: the routes answer only a price holder (403 in words for anyone else), and the grain filter keeps every field
 * of the answer and refuses every key of a body from a person without the grain — a state ("not equal"), a count of lines that
 * differ, a difference, the customer's note (it may name a price, review B2) or who typed it never reaches a no-price reader.
 * Names that look like money (`brandPrice`, `priceMatch`, `priceDiff`, `price…Lines`, `priceOtherCurrency`; review B4) and the
 * rest alike: contract.vitest.test.ts walks every key. Amounts are minor units of the order's currency, without VAT; unit prices
 * plain decimal strings.
 */

const BRAND_PRICE_SOURCES = ['PORTAL', 'CUSTOMER_PO', 'OFFICE'] as const
/** The sources the office types (PORTAL is the customer's own: the portal, or carried from its request). */
const OFFICE_SOURCES = ['CUSTOMER_PO', 'OFFICE'] as const
const MAX_ROWS = 500

/** One row of the customer's price: a line's unit price or line total, or the order's total; where from, and who typed it. */
const rowView = output({
  id: money.price(id()),
  /** A line's unit price (a plain decimal string); null: its line total, or the order's total row. */
  unitPrice: money.price(z.string().nullable()),
  /** A line's total, or the order's total (minor units); null: a unit price. */
  netAmount: money.price(z.number().int().nullable()),
  currency: money.price(z.string()),
  /** PORTAL: the customer's own (in words "From the portal"); CUSTOMER_PO: typed by us from its PO; OFFICE: typed by us. */
  source: money.price(z.enum(BRAND_PRICE_SOURCES)),
  /** The customer's PO it was typed from (a file of this order); null: none, or no longer there. */
  sourceFile: money.price(output({ id: money.price(id()), name: money.price(z.string()) }).nullable()),
  note: money.price(z.string().nullable()),
  /** The office person who typed it; null: the customer's own (PORTAL). */
  enteredBy: money.price(output({ name: money.price(z.string()) }).nullable()),
  enteredAt: money.price(instant()),
  version: money.price(z.number().int()),
})

export const priceCheckView = output({
  orderId: money.price(id()),
  number: money.price(z.string()),
  currency: money.price(z.string()),
  status: money.price(z.string()),
  lines: money.price(
    z.array(
      output({
        lineId: money.price(id()),
        seq: money.price(z.number().int()),
        /** The line's words (its description, else its style and colourway codes). */
        label: money.price(z.string()),
        pieces: money.price(z.number().int()),
        ourUnitPrice: money.price(z.string()),
        /** Our line net (minor units). */
        ourAmount: money.price(z.number().int()),
        /** The customer's amount for the line: its line total, else unit price × pieces (half up); null: none. */
        brandAmount: money.price(z.number().int().nullable()),
        /** null: the line is not checked (no pieces, or free with no customer price). */
        priceMatch: money.price(z.enum(PRICE_MATCHES).nullable()),
        /** Ours − the customer's (+ we ask more); null: the customer's is not known. */
        priceDiff: money.price(z.number().int().nullable()),
        row: money.price(rowView.nullable()),
      }),
    ),
  ),
  total: money.price(
    output({
      ourPrice: money.price(z.number().int()),
      /** The customer's total row, else the sum of its line amounts when every counted line has one; null: not known yet. */
      brandPrice: money.price(z.number().int().nullable()),
      priceMatch: money.price(z.enum(PRICE_MATCHES)),
      priceDiff: money.price(z.number().int().nullable()),
      priceNotEqualLines: money.price(z.number().int()),
      priceMissingLines: money.price(z.number().int()),
      /** The customer's rows left out: in another currency (never converted). */
      priceOtherCurrency: money.price(z.number().int()),
      row: money.price(rowView.nullable()),
    }),
  ),
  /** The customer's own portal request whose prices can be taken over (lines without a row yet); null: none. */
  fromRequest: money.price(output({ requestId: money.price(id()), number: money.price(z.string().nullable()), lines: money.price(z.number().int()) }).nullable()),
  /** May this reader change the customer's price now; `why` in words when not (a closed order, no orders.manage). */
  mayWrite: money.price(output({ allowed: money.price(z.boolean()), why: money.price(z.string().nullable()) })),
})

const orderParams = input({ orderId: id() })

export const priceCheckContract = defineContract({
  params: orderParams,
  response: { 200: priceCheckView },
})

/** One row typed: a line's (unit price or line total: one of the two) or the order's total (`lineId` null, an amount). */
const rowInput = input({
  lineId: money.price(id().nullable()),
  unitPrice: money.price(unitPrice().nullish()),
  netAmount: money.price(z.number().int().min(0).max(2_147_483_647).nullish()),
  source: money.price(z.enum(OFFICE_SOURCES)),
  /** The customer's PO it was typed from: a file of this order (it becomes a priced file). */
  sourceFileId: money.price(id().nullish()),
  note: money.price(z.string().trim().max(1000).nullish()),
  /** The row's version as read; none: the line (or the order) has no customer's price yet. */
  version: money.price(z.number().int().min(1)),
})

export const saveBrandPricesContract = defineContract({
  params: orderParams,
  body: input({
    /** The order's currency as read (a check: the price is typed in the order's currency). */
    currency: money.price(z.string().trim().regex(/^[A-Z]{3}$/)),
    rows: money.price(z.array(rowInput).max(MAX_ROWS)),
    remove: money.price(z.array(input({ id: money.price(id()), version: money.price(z.number().int().min(1)) })).max(MAX_ROWS)),
  }),
  response: { 200: priceCheckView },
})

export const takeOverContract = defineContract({
  params: orderParams,
  body: input({
    /** The request the price check named (fromRequest.requestId). */
    requestId: money.price(id()),
  }),
  response: { 200: priceCheckView },
})

// ── B-CP-018: one customer's counts (the Work tab's "Not equal" view chip) ──
export const summaryContract = defineContract({
  querystring: input({ partyId: id(), companyId: id().optional() }),
  response: {
    200: output({
      partyId: money.price(id()),
      /** Its orders (every status, as the list's rows=all) whose price check reads Not equal. */
      priceNotEqualCount: money.price(z.number().int()),
      /** Its orders that read No customer price yet. */
      priceMissingCount: money.price(z.number().int()),
    }),
  },
})
// ── end B-CP-018 ──

// ── B-CP-019 (customer page plan C3, D2, D3; Owner O4; review C3): the customer's own price check, in its portal ──
// The customer's Buyer, Finance and Admin read their own order's check (the price grain of their role); the Buyer and the Admin
// type their own price per line (portal.salesOrders.ask). Every key is the price grain, as the office's. A row the factory typed
// says where it came from in words only: never the office note, never who typed it, never the PO file's name (review C3).

/** Words in both languages (the portal speaks Italian as "voi"). */
const portalWords = output({ it: money.price(z.string()), en: money.price(z.string()) })

/** A customer's price as the customer reads it. */
const portalRowView = output({
  id: money.price(id()),
  /** A line's unit price (plain decimal string); null: its line total, or the order's total row. */
  unitPrice: money.price(z.string().nullable()),
  netAmount: money.price(z.number().int().nullable()),
  currency: money.price(z.string()),
  /** PORTAL: typed by you here; CUSTOMER_PO: typed by the factory from your PO; OFFICE: typed by the factory. */
  source: money.price(z.enum(BRAND_PRICE_SOURCES)),
  /** The source in the customer's words ("Typed by you", "From your PO", "Typed by the factory"). */
  sourceWords: money.price(portalWords),
  /** Your own note (a row typed in the portal); always null on a row the factory typed. */
  note: money.price(z.string().nullable()),
  enteredAt: money.price(instant()),
  version: money.price(z.number().int()),
})

export const portalPriceCheckView = output({
  orderId: money.price(id()),
  currency: money.price(z.string()),
  lines: money.price(
    z.array(
      output({
        lineId: money.price(id()),
        seq: money.price(z.number().int()),
        label: money.price(z.string()),
        pieces: money.price(z.number().int()),
        ourUnitPrice: money.price(z.string()),
        ourAmount: money.price(z.number().int()),
        brandAmount: money.price(z.number().int().nullable()),
        priceMatch: money.price(z.enum(PRICE_MATCHES).nullable()),
        priceDiff: money.price(z.number().int().nullable()),
        row: money.price(portalRowView.nullable()),
      }),
    ),
  ),
  total: money.price(
    output({
      ourPrice: money.price(z.number().int()),
      brandPrice: money.price(z.number().int().nullable()),
      priceMatch: money.price(z.enum(PRICE_MATCHES)),
      priceDiff: money.price(z.number().int().nullable()),
      priceNotEqualLines: money.price(z.number().int()),
      priceMissingLines: money.price(z.number().int()),
      priceOtherCurrency: money.price(z.number().int()),
      /** The customer's total for the whole order (the factory typed it from your PO); null: none. */
      row: money.price(portalRowView.nullable()),
    }),
  ),
  /** May this person give or change the customer's price now; `why` in words when not (a closed order, a role that reads only). */
  mayWrite: money.price(output({ allowed: money.price(z.boolean()), why: money.price(portalWords.nullable()) })),
})

const portalOrderParams = input({ orderId: id() })

export const portalPriceCheckContract = defineContract({
  params: portalOrderParams,
  response: { 200: portalPriceCheckView },
})

/** One line's price typed by the customer: its unit price or its line total (one of the two), an optional note of its own. */
const portalRowInput = input({
  lineId: money.price(id()),
  unitPrice: money.price(unitPrice().nullish()),
  netAmount: money.price(z.number().int().min(0).max(2_147_483_647).nullish()),
  note: money.price(z.string().trim().max(1000).nullish()),
  /** The row's version as read (also a row the factory typed, which yours replaces); none: the line has no price yet. */
  version: money.price(z.number().int().min(1)),
})

export const portalSaveBrandPricesContract = defineContract({
  params: portalOrderParams,
  body: input({
    /** The order's currency as read (a check: the price is given in the order's currency). */
    currency: money.price(z.string().trim().regex(/^[A-Z]{3}$/)),
    rows: money.price(z.array(portalRowInput).max(MAX_ROWS)),
    /** Your own prices taken away (a row the factory typed is replaced, never only removed). */
    remove: money.price(z.array(input({ id: money.price(id()), version: money.price(z.number().int().min(1)) })).max(MAX_ROWS)),
  }),
  response: { 200: portalPriceCheckView },
})
// ── end B-CP-019 ──
