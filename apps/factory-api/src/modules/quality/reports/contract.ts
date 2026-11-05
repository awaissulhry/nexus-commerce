import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { DIMENSIONS } from '@nexus/factory-domain/quality/reports/rules'

/**
 * Quality reports (B-W2b-138; QHS-147; design quality.reports SCR-147). Office only, read only. Percents, DHU and days are
 * decimal strings with one place ("96.4"), null when nothing was counted (the screen says "—", never 0). No field carries
 * money; no field names or counts a person: a group too small to hide one person answers `tooFew` with every figure null
 * (Statuto dei Lavoratori art. 4; ANA-075). A figure whose records the reader may not see is null with its `sight` false.
 * The querystrings are strict: a person key (workerId, operatorId, …) is refused like any unknown key.
 */

const scope = {
  /** Default: the first site (by code) of the screen's company where the caller reads the quality reports. */
  siteId: id().optional(),
  /** Default: the 30 days up to today at the site. */
  from: businessDate().optional(),
  to: businessDate().optional(),
}

const one = () => z.string().regex(/^\d{1,9}\.\d$/).nullable()
const site = output({ id: id(), code: z.string(), name: z.string(), timeZone: z.string() })
const ref = output({ id: id(), code: z.string(), name: z.string() })
const change = output({ direction: z.enum(['UP', 'DOWN', 'SAME']), by: z.string(), better: z.boolean().nullable() }).nullable()
const head = {
  site,
  /** Every site of the screen's company where the caller reads the quality reports. */
  sites: z.array(output({ id: id(), code: z.string(), name: z.string() })),
  from: businessDate(),
  to: businessDate(),
  today: businessDate(),
  asOf: instant(),
  /** The company's minimum group (People settings, ANA-075): a smaller group shows no figure. */
  minimumGroupSize: z.number().int(),
}

/** Which records the caller may see (each figure is counted only from those). */
const sight = output({
  inprocess: z.boolean(),
  inspections: z.boolean(),
  ncr: z.boolean(),
  capa: z.boolean(),
  holds: z.boolean(),
  incoming: z.boolean(),
  lots: z.boolean(),
})

/**
 * A rate (first-pass yield, DHU, AQL pass, CAPA on time): `value` is the figure, `part` over `whole` what it stands on
 * (first-pass pieces over pieces; defects over pieces; passed over decided; on time over done), `checks` the records counted.
 */
const rate = output({
  tooFew: z.boolean(),
  value: one(),
  part: z.number().int().nullable(),
  whole: z.number().int().nullable(),
  checks: z.number().int().nullable(),
  previous: output({ tooFew: z.boolean(), value: one() }).nullable(),
  change,
  /** Per ISO week of the period (the tile's sparkline), each masked on its own. */
  weeks: z.array(output({ week: z.string(), from: businessDate(), to: businessDate(), tooFew: z.boolean(), value: one() })),
})

/** A count at the period's end (NCRs open, old holds): nothing about people, never masked. */
const count = output({
  value: z.number().int(),
  /** NCRs only: their average age in days at the period's end. */
  averageAgeDays: one(),
  previous: output({ value: z.number().int(), averageAgeDays: one() }).nullable(),
  change,
})

export const kpisContract = defineContract({
  querystring: input({ ...scope, compare: z.enum(['previous']).optional() }),
  response: {
    200: output({
      ...head,
      previous: output({ from: businessDate(), to: businessDate() }).nullable(),
      sight,
      kpis: output({
        fpy: rate.nullable(),
        dhu: rate.nullable(),
        aqlPass: rate.nullable(),
        ncrOpen: count.nullable(),
        /** CAPA has no site: the actions of the site's company. */
        capaOnTime: rate.nullable(),
        holdsOld: count.nullable(),
      }),
      /** Corrections signed after signing in the period (B-W2b-123): they never change a verdict or a count, so every figure reads the signed records. */
      amendments: output({ signed: z.number().int() }).nullable(),
    }),
  },
})
export type KpisQuery = z.infer<typeof kpisContract.querystring>

export const trendContract = defineContract({
  querystring: input({ ...scope, lineId: id().optional() }),
  response: {
    200: output({
      ...head,
      sight,
      /** The line the trend is of (null: every line of the site). */
      lineId: id().nullable(),
      /** The site's lines (the picker). */
      lines: z.array(ref),
      weeks: z.array(
        output({
          week: z.string(),
          from: businessDate(),
          to: businessDate(),
          /** Too few people behind the week's end-of-line and final figures: those are null. */
          tooFew: z.boolean(),
          fpy: one(),
          dhu: one(),
          pieces: z.number().int().nullable(),
          defects: z.number().int().nullable(),
          checks: z.number().int().nullable(),
          aql: output({ passed: z.number().int(), decided: z.number().int(), pct: one() }).nullable(),
          /** Too few people made the week's finally inspected work orders: `aql` is null. */
          aqlTooFew: z.boolean(),
          /** The CAPAs closed that week (the chart's markers): numbers only, at most 10 named. */
          capaClosed: output({ count: z.number().int(), capas: z.array(output({ id: id(), number: z.string() })) }).nullable(),
        }),
      ),
    }),
  },
})
export type TrendQuery = z.infer<typeof trendContract.querystring>

export const compareContract = defineContract({
  querystring: input({ ...scope, by: z.enum(DIMENSIONS).optional() }),
  response: {
    200: output({
      ...head,
      by: z.enum(DIMENSIONS),
      /** The columns the caller may see for this dimension. */
      sight: output({ counts: z.boolean(), aql: z.boolean(), ncrs: z.boolean() }),
      rows: z.array(
        output({
          key: z.string(),
          /** The line, library operation (id null: grouped by code), supplier or style; null: none recorded. */
          ref: output({ id: id().nullable(), code: z.string(), name: z.string() }).nullable(),
          tooFew: z.boolean(),
          inspected: z.number().int().nullable(),
          defects: z.number().int().nullable(),
          dhu: one(),
          aql: output({ passed: z.number().int(), decided: z.number().int(), pct: one() }).nullable(),
          ncrs: z.number().int().nullable(),
        }),
      ),
      /** Rows emptied because too few people stand behind them. */
      hidden: z.number().int(),
    }),
  },
})
export type CompareQuery = z.infer<typeof compareContract.querystring>

export const incomingContract = defineContract({
  querystring: input(scope),
  response: {
    200: output({
      ...head,
      sight: output({ incoming: z.boolean(), lots: z.boolean() }),
      suppliers: z.array(
        output({
          /** The supplier (a workshop for goods back from subcontracting); null: lots without a supplier. */
          party: ref.nullable(),
          workshop: z.boolean(),
          /** Lots received in the period (quality.lots.view). */
          lotsReceived: z.number().int().nullable(),
          rejected: z.number().int().nullable(),
          crViFails: z.number().int().nullable(),
          averageQuarantineDays: one(),
          inQuarantine: z.number().int().nullable(),
          /** Incoming inspections signed in the period (quality.incoming.view). */
          inspections: z.number().int().nullable(),
          inspectionsFailed: z.number().int().nullable(),
        }),
      ),
    }),
  },
})
export type IncomingQuery = z.infer<typeof incomingContract.querystring>
