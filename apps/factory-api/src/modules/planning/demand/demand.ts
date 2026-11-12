import { ValidationError } from '@nexus/factory-domain/core/errors'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import {
  bucketKeyOf,
  daysLate,
  DEMAND_LIMITS,
  DEMAND_LAYERS,
  demandGrid,
  demandHorizon,
  kindCounts,
  kindCountWords,
  LATER,
  LATER_LAYERS,
  layerOf,
  PAST,
  UNDATED,
  type DemandBucketKind,
  type DemandHorizon,
  type DemandKind,
  type DemandLayer,
} from '@nexus/factory-domain/planning/demand/rules'
import { DEFAULT_PLANNING_SETTINGS } from '@nexus/factory-domain/planning/settings/settings'
import { PLANNING_VIEW } from '@nexus/factory-domain/planning/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { officeContextOf, siteFor } from '../access'
import { readSettings } from '../settings/store'
import type { Reader, SiteRow } from '../store'
import type { DemandRowView, DemandSourceView } from './contract'
import { mayOpen, namesOf, readDemandSources, strategiesOf, type DemandNames, type DemandSource } from './sources'

/**
 * One demand view (B-W2b-319; PLN-017, PLN-040, PLN-041, PLN-042; design planning.demand SCR-201), office reads with planning.view
 * over the site:
 *
 *   GET /planning/demand        "Demand at a glance" (a tile per layer: the W3 layers say "not known yet") and "Demand over time"
 *                               (style-colour rows × the horizon's buckets, opened to sizes, each cell per layer; QUOTES never in
 *                               the firm total)
 *   GET /planning/demand/rows   "Demand rows": the same pieces as a list with their source, in day order (no day last), paged by
 *                               the last row's key; filtered to one cell it is the popover "what makes this number"
 *
 * Both read the same sources (./sources.ts) at the same moment rules: the site's today in its time zone, a horizon of `weeks`
 * (default the site's planning horizon) from this week's Monday, in weeks or months. Nothing is written: no command, no event.
 */

export interface DemandQuery {
  readonly siteId: string
  readonly bucket?: DemandBucketKind | undefined
  readonly weeks?: number | undefined
}

const siteView = (site: SiteRow) => ({ id: site.id, companyId: site.companyId, code: site.code, name: site.name, timeZone: site.timezone })
const horizonView = (horizon: DemandHorizon) => ({ kind: horizon.kind, from: horizon.from, to: horizon.to, weeks: horizon.weeks, buckets: horizon.buckets.map((bucket) => ({ key: bucket.key, from: bucket.from, to: bucket.to })) })

async function horizonOf(db: Reader, site: SiteRow, query: DemandQuery, today: BusinessDate): Promise<DemandHorizon> {
  const weeks = query.weeks ?? (await readSettings(db, site.id))?.horizonWeeks ?? DEFAULT_PLANNING_SETTINGS.horizonWeeks
  return demandHorizon(today, weeks, query.bucket ?? 'WEEK')
}

const matches = (needle: string | undefined, ...values: (string | null | undefined)[]): boolean => {
  if (!needle) return true
  const lower = needle.toLowerCase()
  return values.some((value) => value?.toLowerCase().includes(lower) ?? false)
}

/** GET /planning/demand. */
export async function readDemand(caller: CommandCaller, query: DemandQuery & { readonly q?: string | undefined; readonly styleId?: string | undefined }) {
  const context = officeContextOf(caller)
  const site = await siteFor(caller, query.siteId, PLANNING_VIEW)
  const now = serverClock.now()
  const today = businessDate(now, site.timezone)
  return caller.withClient(async (db) => {
    const horizon = await horizonOf(db, site, query, today)
    const read = await readDemandSources(db, site, actorOf(context), today)
    const names = await namesOf(db, read.sources)
    const shown = read.sources.filter((source) => {
      if (query.styleId && source.styleId !== query.styleId) return false
      const style = names.styles.get(source.styleId)
      return matches(query.q, style?.code, style?.name)
    })
    const grid = demandGrid(shown, horizon, (styleId) => names.styles.get(styleId)?.sizes ?? [])
    const label = (row: { styleId: string; colourwayId: string | null }) => `${names.styles.get(row.styleId)?.code ?? ''}\u0000${row.colourwayId ? (names.colourways.get(row.colourwayId)?.code ?? '') : '￿'}`
    const sorted = [...grid.rows].sort((a, b) => (label(a) < label(b) ? -1 : label(a) > label(b) ? 1 : 0))
    const rows = sorted.slice(0, DEMAND_LIMITS.rows)
    const strategies = await strategiesOf(db, site.id, rows)
    return {
      site: siteView(site),
      asOf: toUtcIso(now),
      today,
      horizon: horizonView(horizon),
      tiles: [
        ...grid.tiles.map((tile) => ({ ...tile, known: true })),
        ...LATER_LAYERS.map((layer) => ({ layer, known: false, pieces: null, sources: null, pastDue: null, undated: null, later: null, unplanned: null })),
      ],
      rows: rows.map(
        (row): DemandRowView => ({
          key: row.key,
          style: styleRef(names, row.styleId),
          colourway: row.colourwayId ? colourwayRef(names, row.colourwayId) : null,
          strategy: row.colourwayId ? (strategies.get(`${row.styleId}:${row.colourwayId}`) ?? 'MAKE_TO_ORDER') : 'MAKE_TO_ORDER',
          totals: row.totals,
          cells: [...row.cells],
          sizes: row.sizes.map((size) => ({ size: size.size, totals: size.totals, cells: [...size.cells] })),
        }),
      ),
      truncated: sorted.length > rows.length,
      unplaced: read.unplaced,
    }
  })
}

const styleRef = (names: DemandNames, styleId: string) => {
  const style = names.styles.get(styleId)
  return { id: styleId, code: style?.code ?? '', name: style?.name ?? '' }
}
const colourwayRef = (names: DemandNames, colourwayId: string) => {
  const colourway = names.colourways.get(colourwayId)
  return { id: colourwayId, code: colourway?.code ?? '', name: colourway?.name ?? '' }
}

export interface DemandRowsQuery extends DemandQuery {
  readonly layer?: DemandLayer | undefined
  readonly kind?: DemandKind | undefined
  readonly styleId?: string | undefined
  readonly colourwayId?: string | undefined
  readonly size?: string | undefined
  readonly madeToMeasure?: boolean | undefined
  readonly cell?: string | undefined
  readonly q?: string | undefined
  readonly cursor?: string | undefined
  readonly limit?: number | undefined
}

const LAYER_RANK = new Map<string, number>(DEMAND_LAYERS.map((layer, index) => [layer, index]))
/** Day order (no day last), then layer, the document's number, its line, the size. */
function listOrder(a: DemandSource, b: DemandSource): number {
  if (a.date !== b.date) return a.date === null ? 1 : b.date === null ? -1 : a.date < b.date ? -1 : 1
  const layers = (LAYER_RANK.get(layerOf(a.kind)) ?? 0) - (LAYER_RANK.get(layerOf(b.kind)) ?? 0)
  if (layers !== 0) return layers
  if (a.source.number !== b.source.number) return a.source.number < b.source.number ? -1 : 1
  if ((a.source.line ?? 0) !== (b.source.line ?? 0)) return (a.source.line ?? 0) - (b.source.line ?? 0)
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
}

/** GET /planning/demand/rows. */
export async function readDemandRows(caller: CommandCaller, query: DemandRowsQuery) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const site = await siteFor(caller, query.siteId, PLANNING_VIEW)
  const now = serverClock.now()
  const today = businessDate(now, site.timezone)
  if (query.cell && ![PAST, UNDATED, LATER].includes(query.cell) && !/^\d{4}-(W\d{2}|\d{2})$/.test(query.cell)) {
    throw new ValidationError('No such cell.', [{ path: 'querystring/cell', message: 'Name a bucket of the horizon (2026-W47, 2026-11), PAST, NONE or LATER.' }])
  }
  if (query.madeToMeasure && query.size) throw new ValidationError('A made-to-measure unit has no size.', [{ path: 'querystring/size', message: 'Ask for a size, or for made-to-measure units, not both.' }])
  return caller.withClient(async (db) => {
    const horizon = await horizonOf(db, site, query, today)
    const read = await readDemandSources(db, site, actor, today)
    const names = await namesOf(db, read.sources)
    const filtered = read.sources.filter((source) => {
      if (query.layer && layerOf(source.kind) !== query.layer) return false
      if (query.kind && source.kind !== query.kind) return false
      if (query.styleId && source.styleId !== query.styleId) return false
      if (query.colourwayId && (query.colourwayId === 'none' ? source.colourwayId !== null : source.colourwayId !== query.colourwayId)) return false
      if (query.size && source.size !== query.size) return false
      if (query.madeToMeasure !== undefined && (source.size === null) !== query.madeToMeasure) return false
      if (query.cell && bucketKeyOf(horizon, source.date) !== query.cell) return false
      const style = names.styles.get(source.styleId)
      return matches(query.q, style?.code, style?.name, source.source.number, source.origin?.number, source.workOrder?.number)
    })
    const sorted = filtered.sort(listOrder)
    const limit = query.limit ?? DEMAND_LIMITS.page.default
    const start = query.cursor ? sorted.findIndex((row) => row.key === query.cursor) + 1 : 0
    if (query.cursor && start === 0) throw new ValidationError('The page this cursor names is gone: read the list again.', [{ path: 'querystring/cursor', message: 'Start from the first page.' }])
    const page = sorted.slice(start, start + limit)
    const kinds = kindCounts(sorted)
    return {
      site: siteView(site),
      asOf: toUtcIso(now),
      today,
      horizon: horizonView(horizon),
      rows: page.map(
        (source): DemandSourceView => ({
          key: source.key,
          layer: layerOf(source.kind),
          kind: source.kind,
          source: { ...source.source, mayOpen: mayOpen(actor, site, source) },
          origin: source.origin,
          workOrder: source.workOrder,
          party: source.partyId ? (names.parties.get(source.partyId) ?? null) : null,
          style: styleRef(names, source.styleId),
          colourway: source.colourwayId ? colourwayRef(names, source.colourwayId) : null,
          size: source.size,
          pieces: source.pieces,
          date: source.date,
          bucket: bucketKeyOf(horizon, source.date),
          daysLate: daysLate(source.date, today),
          status: source.status,
          sampleKind: source.sampleKind,
          part: source.part,
          validUntil: source.validUntil,
          planned: source.planned,
        }),
      ),
      kinds,
      words: { en: kindCountWords(kinds, 'en'), it: kindCountWords(kinds, 'it') },
      pieces: sorted.reduce((sum, row) => sum + row.pieces, 0),
      nextCursor: start + limit < sorted.length ? page[page.length - 1]!.key : null,
    }
  })
}
