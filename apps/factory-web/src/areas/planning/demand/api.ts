import { z } from 'zod'
import { DEMAND_BUCKETS, DEMAND_KINDS, DEMAND_LAYERS, LATER_LAYERS } from '@nexus/factory-domain/planning/demand/rules'
import { PRODUCTION_STRATEGIES } from '@nexus/factory-domain/planning/strategy/rules'
import { SAMPLE_KINDS } from '@nexus/factory-domain/sales/samples/rules'
import type { ApiClient } from '../../../lib/api/client'

/**
 * Every call of Planning › Demand & forecast (SCR-374; design planning.demand), the answers checked with zod (unknown fields
 * dropped, so a new API field never breaks the page). The shapes mirror apps/factory-api modules/planning/demand/contract.ts
 * (B-W2b-319); the enum lists are factory-domain's own. Two reads, each its own section, so one failing never blanks the
 * other: GET /planning/demand (the tiles and the time-phased rows) and GET /planning/demand/rows (the demand as a list with
 * its source; filtered to one cell it is the popover "what makes this number"). Pieces only: never money, never a person.
 * The API's English `words` are dropped: the screen says its own words from the kinds and their counts.
 */

const named = z.object({ id: z.string(), code: z.string(), name: z.string() })
const site = z.object({ id: z.string(), companyId: z.string(), code: z.string(), name: z.string(), timeZone: z.string() })
const horizon = z.object({
  kind: z.enum(DEMAND_BUCKETS),
  from: z.string(),
  to: z.string(),
  weeks: z.number(),
  buckets: z.array(z.object({ key: z.string(), from: z.string(), to: z.string() })),
})
const counts = { ORDERS: z.number(), QUOTES: z.number(), MTM: z.number(), SAMPLES: z.number(), REMAKES: z.number(), firm: z.number() }
const cell = z.object({ bucket: z.string(), ...counts })
const totals = z.object(counts)

export const tileSchema = z.object({
  layer: z.enum([...DEMAND_LAYERS, ...LATER_LAYERS]),
  known: z.boolean(),
  pieces: z.number().nullable(),
  sources: z.number().nullable(),
  pastDue: z.number().nullable(),
  undated: z.number().nullable(),
  later: z.number().nullable(),
  unplanned: z.number().nullable(),
})
export type DemandTile = z.infer<typeof tileSchema>

export const demandRowSchema = z.object({
  key: z.string(),
  style: named,
  colourway: named.nullable(),
  strategy: z.enum([...PRODUCTION_STRATEGIES, 'MIXED']),
  totals,
  cells: z.array(cell),
  sizes: z.array(z.object({ size: z.string().nullable(), totals, cells: z.array(cell) })),
})
export type DemandRow = z.infer<typeof demandRowSchema>
export type DemandCell = z.infer<typeof cell>
export type DemandTotals = z.infer<typeof totals>

const demandSchema = z.object({
  site,
  asOf: z.string(),
  today: z.string(),
  horizon,
  tiles: z.array(tileSchema),
  rows: z.array(demandRowSchema),
  truncated: z.boolean(),
  unplaced: z.object({ orderLines: z.number(), quoteLines: z.number(), sampleRounds: z.number() }),
})
export type Demand = z.infer<typeof demandSchema>
export type DemandHorizon = z.infer<typeof horizon>

export const sourceRowSchema = z.object({
  key: z.string(),
  layer: z.enum(DEMAND_LAYERS),
  kind: z.enum(DEMAND_KINDS),
  source: z.object({ recordType: z.string(), recordId: z.string(), number: z.string(), line: z.number().nullable(), mayOpen: z.boolean() }),
  origin: z.object({ recordType: z.string(), recordId: z.string(), number: z.string() }).nullable(),
  workOrder: z.object({ id: z.string(), number: z.string() }).nullable(),
  party: named.nullable(),
  style: named,
  colourway: named.nullable(),
  size: z.string().nullable(),
  pieces: z.number(),
  date: z.string().nullable(),
  bucket: z.string(),
  daysLate: z.number().nullable(),
  status: z.string(),
  sampleKind: z.enum(SAMPLE_KINDS).nullable(),
  part: z.string().nullable(),
  validUntil: z.string().nullable(),
  planned: z.boolean(),
})
export type SourceRow = z.infer<typeof sourceRowSchema>

const rowsSchema = z.object({
  site,
  asOf: z.string(),
  today: z.string(),
  horizon,
  rows: z.array(sourceRowSchema),
  kinds: z.array(z.object({ kind: z.enum(DEMAND_KINDS), sources: z.number(), pieces: z.number() })),
  pieces: z.number(),
  nextCursor: z.string().nullable(),
})
export type SourceRows = z.infer<typeof rowsSchema>
export type KindCount = SourceRows['kinds'][number]

export interface DemandAsk {
  readonly siteId: string
  readonly bucket: (typeof DEMAND_BUCKETS)[number]
  readonly weeks: number | null
  readonly q?: string | null
}

/** A filter of GET /planning/demand/rows: the list's own, or one cell of the grid (the popover). */
export interface RowsFilter {
  readonly layer?: (typeof DEMAND_LAYERS)[number] | null
  readonly styleId?: string | null
  /** A colourway's id, or `none` (sample cells of any colourway). */
  readonly colourwayId?: string | null
  readonly size?: string | null
  readonly madeToMeasure?: boolean
  /** A horizon key, PAST, NONE or LATER. */
  readonly cell?: string | null
  readonly q?: string | null
}

const clean = (value: string | null | undefined) => (value === null || value === undefined || value === '' ? undefined : value)

export const getDemand = (api: ApiClient, ask: DemandAsk, signal?: AbortSignal): Promise<Demand> =>
  api.get('/planning/demand', { query: { siteId: ask.siteId, bucket: ask.bucket, weeks: ask.weeks ?? undefined, q: clean(ask.q) }, schema: demandSchema, signal })

export function getDemandRows(api: ApiClient, ask: DemandAsk, filter: RowsFilter, page: { cursor?: string | null; limit?: number } = {}, signal?: AbortSignal): Promise<SourceRows> {
  return api.get('/planning/demand/rows', {
    query: {
      siteId: ask.siteId,
      bucket: ask.bucket,
      weeks: ask.weeks ?? undefined,
      layer: clean(filter.layer),
      styleId: clean(filter.styleId),
      colourwayId: clean(filter.colourwayId),
      size: clean(filter.size),
      madeToMeasure: filter.madeToMeasure ? 'true' : undefined,
      cell: clean(filter.cell),
      q: clean(filter.q),
      cursor: clean(page.cursor),
      limit: page.limit,
    },
    schema: rowsSchema,
    signal,
  })
}
