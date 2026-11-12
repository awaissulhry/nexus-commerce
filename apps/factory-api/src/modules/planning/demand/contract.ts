import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { DEMAND_BUCKETS, DEMAND_KINDS, DEMAND_LAYERS, DEMAND_LIMITS, LATER_LAYERS } from '@nexus/factory-domain/planning/demand/rules'
import { notMoney } from '@nexus/factory-domain/money/marked'
import { PRODUCTION_STRATEGIES } from '@nexus/factory-domain/planning/strategy/rules'
import { SAMPLE_KINDS } from '@nexus/factory-domain/sales/samples/rules'

/**
 * One demand view (B-W2b-319; PLN-017, PLN-040, PLN-041, PLN-042; design planning.demand, SCR-201). Office only, read with
 * planning.view over the site (and over the customer of each source). Pieces only: never money, never a person (a customer is a
 * party, named as planning names it on the board). Two reads, each its own section, so one failing never blanks the other:
 *
 *   GET /planning/demand        the tiles (pieces by layer) and the time-phased rows (style and colourway × buckets, opened to
 *                               sizes, layer by layer)
 *   GET /planning/demand/rows   the same demand as a list with its source (the cell popover "what makes this number" is this
 *                               list filtered to the cell)
 */

const ref = output({ id: id(), code: z.string(), name: z.string() })
const layer = z.enum(DEMAND_LAYERS)
const bucketQuery = {
  /** WEEK (the default) or MONTH buckets. */
  bucket: z.enum(DEMAND_BUCKETS).optional(),
  /** The horizon in weeks from this week's Monday; default the site's planning horizon (26 without settings). */
  weeks: z.coerce.number().int().min(DEMAND_LIMITS.weeks.min).max(DEMAND_LIMITS.weeks.max).optional(),
}
const siteView = output({ id: id(), companyId: id(), code: z.string(), name: z.string(), timeZone: z.string() })
const horizonView = output({
  kind: z.enum(DEMAND_BUCKETS),
  from: businessDate(),
  to: businessDate(),
  weeks: z.number().int(),
  /** In order; PAST (before `from`), NONE (no day) and LATER (after `to`) are the other keys a cell or a row may carry. */
  buckets: z.array(output({ key: z.string(), from: businessDate(), to: businessDate() })),
})
const counts = {
  ORDERS: z.number().int(),
  QUOTES: z.number().int(),
  MTM: z.number().int(),
  SAMPLES: z.number().int(),
  REMAKES: z.number().int(),
  /** Every layer but QUOTES: what takes the machines. */
  firm: z.number().int(),
}
const cell = output({ bucket: z.string(), ...counts })
const totals = output(counts)

export const demandTileView = output({
  layer: z.enum([...DEMAND_LAYERS, ...LATER_LAYERS]),
  /** false: a W3 layer (brand demand, forecast): its numbers are null ("—"), never 0. */
  known: z.boolean(),
  /** Past due + in the horizon + without a day; never what is dated after the horizon. */
  pieces: z.number().int().nullable(),
  sources: z.number().int().nullable(),
  pastDue: z.number().int().nullable(),
  undated: z.number().int().nullable(),
  later: z.number().int().nullable(),
  /** Of `pieces`, those the material plan does not buy for (samples, quotes, rework, orders it does not plan). */
  unplanned: z.number().int().nullable(),
})

export const demandRowView = output({
  key: z.string(),
  style: ref,
  /** null: sample cells of any colourway. */
  colourway: ref.nullable(),
  /** The production strategy of its SKUs at the site (PLN-061): one, or MIXED. */
  strategy: z.enum([...PRODUCTION_STRATEGIES, 'MIXED']),
  /** Pieces per layer (never money). */
  totals: notMoney(totals),
  /** Sparse: a bucket without a piece is left out. */
  cells: z.array(cell),
  /** null size: made-to-measure units. */
  sizes: z.array(output({ size: z.string().nullable(), totals: notMoney(totals), cells: z.array(cell) })),
})
export type DemandRowView = z.infer<typeof demandRowView>

export const demandContract = defineContract({
  querystring: input({
    siteId: id(),
    ...bucketQuery,
    /** A style's code or name. */
    q: z.string().trim().min(1).max(100).optional(),
    styleId: id().optional(),
  }),
  response: {
    200: output({
      site: siteView,
      asOf: instant(),
      today: businessDate(),
      horizon: horizonView,
      tiles: z.array(demandTileView),
      rows: z.array(demandRowView),
      /** More style-colour rows exist than shown (by code). */
      truncated: z.boolean(),
      /** Sources of the site's company with no making site while it has several plants: not counted here. */
      unplaced: output({ orderLines: z.number().int(), quoteLines: z.number().int(), sampleRounds: z.number().int() }),
    }),
  },
})

export const demandSourceView = output({
  /** `<kind>:<source>:<colourway or ->:<size or ->:<day or ->`. */
  key: z.string(),
  layer,
  kind: z.enum(DEMAND_KINDS),
  /** The document to open (record-links): SalesOrder, Quote, SampleRound, ReworkOrder, WorkOrder (a recut), ReturnAuthorisation. */
  source: output({ recordType: z.string(), recordId: id(), number: z.string(), line: z.number().int().nullable(), mayOpen: z.boolean() }),
  /** What it came from: the NCR of a rework or recut, the return of a replacement order. */
  origin: output({ recordType: z.string(), recordId: id(), number: z.string() }).nullable(),
  workOrder: output({ id: id(), number: z.string() }).nullable(),
  party: ref.nullable(),
  style: ref,
  colourway: ref.nullable(),
  /** null: a made-to-measure unit. */
  size: z.string().nullable(),
  pieces: z.number().int(),
  date: businessDate().nullable(),
  bucket: z.string(),
  /** Days past its day on the site's today (0: not late; null: no day). */
  daysLate: z.number().int().nullable(),
  /** The source's own status (order, quote, round stage, rework, recut, return). */
  status: z.string(),
  sampleKind: z.enum(SAMPLE_KINDS).nullable(),
  /** A recut of one part ("sleeve"); null: whole garments. */
  part: z.string().nullable(),
  /** A quote's last day. */
  validUntil: businessDate().nullable(),
  /** The material plan buys for it. */
  planned: z.boolean(),
})
export type DemandSourceView = z.infer<typeof demandSourceView>

export const demandRowsContract = defineContract({
  querystring: input({
    siteId: id(),
    ...bucketQuery,
    layer: layer.optional(),
    kind: z.enum(DEMAND_KINDS).optional(),
    styleId: id().optional(),
    /** A colourway's id, or `none` for sample cells of any colourway. */
    colourwayId: z.union([id(), z.literal('none')]).optional(),
    size: z.string().trim().min(1).max(20).optional(),
    /** true: only made-to-measure units (no size). */
    madeToMeasure: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
    /** A horizon key, PAST, NONE or LATER: the cell popover. */
    cell: z.string().trim().min(1).max(20).optional(),
    /** A style's code or name, or a document's number. */
    q: z.string().trim().min(1).max(100).optional(),
    /** The key of the last row of the page before. */
    cursor: z.string().max(400).optional(),
    limit: z.coerce.number().int().min(1).max(DEMAND_LIMITS.page.max).optional(),
  }),
  response: {
    200: output({
      site: siteView,
      asOf: instant(),
      today: businessDate(),
      horizon: horizonView,
      rows: z.array(demandSourceView),
      /** Over every page of the filter: per kind, how many sources and pieces ("3 orders, 1 remake"), and those words. */
      kinds: z.array(output({ kind: z.enum(DEMAND_KINDS), sources: z.number().int(), pieces: z.number().int() })),
      words: output({ en: z.string(), it: z.string() }),
      pieces: z.number().int(),
      nextCursor: z.string().nullable(),
    }),
  },
})
