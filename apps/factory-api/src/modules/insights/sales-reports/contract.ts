import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { BACKLOG_GROUPS, BACKLOG_HORIZONS, BACKLOG_WEEK_KINDS, INTAKE_BUCKETS, INTAKE_SPLITS } from '@nexus/factory-domain/insights/sales-reports/rules'
import { money } from '@nexus/factory-domain/money/marked'

/**
 * Sales reports (B-W2b-348; design sales.reports SCR-250: sec strip, sec intake, sec backlog, sec returns; Sales › Quotes sec
 * quotes.speed). Office only, read only. Every amount is money.price in minor units, dropped for a caller without the price
 * grain; counts and pieces stay. Amounts are never summed across currencies: `byCurrency` lists each, `value` is set only when
 * the figures are in one. No field names a person. The querystrings are strict: an unknown key is refused.
 *
 * Each answer carries the rows behind its bars (`orders`, `lines`: at most 2000, `complete` false beyond), so the page opens
 * "what this number counts" without a second read; the backlog's `lines` are the read B-W2b-323's "By promise week" reuses.
 */

const period = {
  /** Default this month so far (Rome): the monthly sales review. */
  from: businessDate().optional(),
  to: businessDate().optional(),
}

const ref = output({ id: id(), code: z.string(), name: z.string() })
const head = {
  /** The screen's company (null: every company the reader reaches). */
  company: ref.nullable(),
  from: businessDate(),
  to: businessDate(),
  today: businessDate(),
  asOf: instant(),
}
/** What the reader may see: orders (orders.view), quotes (quotes.view), returns (sales.returns.view), amounts (`values`: the price grain). */
const sight = output({ orders: z.boolean(), quotes: z.boolean(), returns: z.boolean(), values: z.boolean() })
const pct = () => z.string().regex(/^\d{1,3}\.\d$/).nullable()

const valueFigures = {
  /** Each currency's total (the company's first). */
  byCurrency: z.array(output({ currency: z.string(), value: money.price(z.number().int()) })),
  /** The total in `currency` when the figures are in one currency; null when in several. */
  value: money.price(z.number().int().nullable()),
  currency: z.string().nullable(),
  mixedCurrencies: z.boolean(),
}
const intakeFigures = output({ orders: z.number().int(), pieces: z.number().int(), ...valueFigures })
const backlogFigures = output({ orders: z.number().int(), lines: z.number().int(), pieces: z.number().int(), late: z.number().int(), ...valueFigures })
const returnFigures = output({ returns: z.number().int(), lines: z.number().int(), pieces: z.number().int(), ...valueFigures })
const speedFigures = {
  /** Quotes first sent in the period; the median working minutes from new (the inquiry's arrival, else the quote's making) to sent. */
  answered: z.number().int(),
  medianAnswerMinutes: z.number().int().nullable(),
  fromInquiries: z.number().int(),
  /** Versions answered in the period: accepted, declined; expired apart (never decided). */
  accepted: z.number().int(),
  declined: z.number().int(),
  expired: z.number().int(),
  /** accepted ÷ (accepted + declined), one decimal. */
  winRatePct: pct(),
  /** Median hours from the version's send to the customer's answer. */
  medianDecisionHours: z.number().int().nullable(),
}
const season = output({ id: id(), code: z.string(), name: z.string() })

export const headlineContract = defineContract({
  querystring: input(period),
  response: {
    200: output({
      ...head,
      sight,
      companyCurrency: z.string().nullable(),
      /** Null: not in the reader's role (the tile says so, never 0). */
      intake: intakeFigures.nullable(),
      backlog: backlogFigures.nullable(),
      quotes: output({ ...speedFigures }).nullable(),
      returns: output({ returns: z.number().int(), pieces: z.number().int(), shipped: z.number().int().nullable(), returnRatePct: pct() }).nullable(),
      complete: z.boolean(),
    }),
  },
})
export type PeriodQuery = z.infer<typeof headlineContract.querystring>

export const intakeContract = defineContract({
  querystring: input({ ...period, by: z.enum(INTAKE_BUCKETS).default('week'), split: z.enum(INTAKE_SPLITS).default('none') }),
  response: {
    200: output({
      ...head,
      sight,
      by: z.enum(INTAKE_BUCKETS),
      split: z.enum(INTAKE_SPLITS),
      companyCurrency: z.string().nullable(),
      all: intakeFigures,
      buckets: z.array(output({ key: z.string(), from: businessDate(), to: businessDate(), figures: intakeFigures })),
      /** The split's groups, the largest first (at most 50): a customer, a style (`fees`: the fee lines), a season (`none`: no season). */
      groups: z.array(output({ key: z.string(), code: z.string().nullable(), name: z.string().nullable(), figures: intakeFigures, buckets: z.array(output({ key: z.string(), figures: intakeFigures })) })),
      more: z.number().int(),
      /** The orders booked in the period (newest first, at most 2000): what each bar counts. */
      orders: z.array(
        output({
          id: id(),
          number: z.string(),
          status: z.string(),
          customer: ref,
          /** The day it counts on (its order date, or its first order's when split off another). */
          bookedOn: businessDate(),
          orderDate: businessDate(),
          splitOff: z.boolean(),
          season: season.nullable(),
          bucket: z.string(),
          pieces: z.number().int(),
          value: money.price(z.number().int()),
          currency: z.string(),
          /** Its pieces and value per style (`fees`: fee lines). */
          styles: z.array(output({ key: z.string(), pieces: z.number().int(), value: money.price(z.number().int()) })),
        }),
      ),
      complete: z.boolean(),
    }),
  },
})
export type IntakeQuery = z.infer<typeof intakeContract.querystring>

export const backlogContract = defineContract({
  querystring: input({ by: z.enum(BACKLOG_GROUPS).default('customer') }),
  response: {
    200: output({
      company: ref.nullable(),
      today: businessDate(),
      asOf: instant(),
      sight,
      by: z.enum(BACKLOG_GROUPS),
      companyCurrency: z.string().nullable(),
      all: backlogFigures,
      /** The promise weeks (ISO), EARLIER / LATER folded, NONE: no promise; `past`: late, `current`: this week. */
      weeks: z.array(output({ key: z.string(), kind: z.enum(BACKLOG_WEEK_KINDS), from: businessDate().nullable(), to: businessDate().nullable(), past: z.boolean(), current: z.boolean(), figures: backlogFigures })),
      groups: z.array(output({ key: z.string(), code: z.string(), name: z.string(), figures: backlogFigures, horizons: output(Object.fromEntries(BACKLOG_HORIZONS.map((horizon) => [horizon, z.number().int()])) as Record<(typeof BACKLOG_HORIZONS)[number], z.ZodNumber>) })),
      more: z.number().int(),
      /** Every open size (at most 2000, by promise): the rows behind each bar and cell. */
      lines: z.array(
        output({
          orderId: id(),
          number: z.string(),
          status: z.string(),
          lineId: id(),
          seq: z.number().int(),
          customer: ref,
          style: ref,
          colourway: output({ code: z.string(), name: z.string() }),
          /** null: a made-to-measure unit. */
          size: z.string().nullable(),
          open: z.number().int(),
          promise: businessDate().nullable(),
          /** RECORD: the promise history; TYPED: the date typed on the line or order. */
          promiseSource: z.enum(['RECORD', 'TYPED']).nullable(),
          week: z.string(),
          horizon: z.enum(BACKLOG_HORIZONS),
          value: money.price(z.number().int()),
          currency: z.string(),
        }),
      ),
      complete: z.boolean(),
    }),
  },
})
export type BacklogQuery = z.infer<typeof backlogContract.querystring>

const named = output({ key: z.string(), code: z.string().nullable(), name: z.string().nullable(), figures: returnFigures })

export const returnsContract = defineContract({
  querystring: input(period),
  response: {
    200: output({
      ...head,
      sight,
      companyCurrency: z.string().nullable(),
      all: returnFigures,
      /** Pieces shipped in the period (null without orders.view) and the return rate (pieces asked back ÷ shipped). */
      shipped: z.number().int().nullable(),
      returnRatePct: pct(),
      /** By reason (the RETURN list's code and its words; `words` null: a code no longer in the list). Reason groups: none yet. */
      reasons: z.array(output({ key: z.string(), words: output({ it: z.string(), en: z.string() }).nullable(), figures: returnFigures })),
      styles: z.array(named),
      colours: z.array(named),
      sizes: z.array(named),
      customers: z.array(named),
      /** Pieces per style (the most returned, at most 12) and size. */
      heatmap: output({ styles: z.array(output({ key: z.string(), code: z.string(), name: z.string() })), sizes: z.array(z.string()), cells: z.array(z.array(z.number().int().nullable())) }),
      /** The return lines (newest first, at most 2000): the rows behind each bar and cell. */
      lines: z.array(
        output({
          returnId: id(),
          number: z.string(),
          status: z.string(),
          lineId: id(),
          seq: z.number().int(),
          requestedOn: businessDate(),
          reason: z.string(),
          style: ref.nullable(),
          colour: output({ code: z.string(), name: z.string() }).nullable(),
          size: z.string().nullable(),
          customer: ref,
          pieces: z.number().int(),
          credited: money.price(z.number().int().nullable()),
          currency: z.string().nullable(),
        }),
      ),
      complete: z.boolean(),
    }),
  },
})

export const quoteSpeedContract = defineContract({
  querystring: input(period),
  response: {
    200: output({
      ...head,
      sight,
      companyCurrency: z.string().nullable(),
      ...speedFigures,
      /** The accepted versions' value. */
      won: output(valueFigures),
      complete: z.boolean(),
    }),
  },
})
