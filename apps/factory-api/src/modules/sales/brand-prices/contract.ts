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
