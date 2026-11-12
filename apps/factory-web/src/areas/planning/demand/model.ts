import { DEMAND_LAYERS, LAYER_OF_KIND, LATER, PAST, UNDATED, type DemandKind, type DemandLayer } from '@nexus/factory-domain/planning/demand/rules'
import { isApiError } from '../../../lib/api/errors'
import { formatNumber } from '../../../lib/i18n/format'
import { INTL_LOCALE, type Locale } from '../../../lib/i18n/locales'
import type { Translate } from '../../../lib/i18n/messages'
import { recordAddress } from '../../../lib/records/record-links'
import { csvOf } from '../../_shared/buying/model'
import type { Demand, DemandCell, DemandHorizon, DemandRow, DemandTile, DemandTotals, KindCount, RowsFilter, SourceRow } from './api'

/**
 * Planning › Demand & forecast (SCR-374; design planning.demand, a workspace list), pure: the address (site, Week / Month, the
 * horizon, the layers shown, the grid's search, the list's filters), the tiles in the design's order (a W3 layer is "—",
 * never 0), the time-phased grid's lines (a style in a colourway, opened to its sizes), a cell's pieces in the layers shown
 * and its stacked mini bar, the popover's filter and its words ("3 orders, 1 remake · 38 pieces") said from the kinds the
 * API counted, where a source document opens (record-links: a real link, so ⌘-click is the new tab), the list's words and
 * the grid's CSV. Pieces only: no money, no person.
 */

export const NAMESPACE = 'planning-demand'

/** The layers the grid can show, in the design's order; QUOTES last (never bought for, never in the firm total). */
export const GRID_LAYERS = ['ORDERS', 'MTM', 'SAMPLES', 'REMAKES', 'QUOTES'] as const satisfies readonly DemandLayer[]
/** Shown when the address names none: what takes the machines. */
export const DEFAULT_LAYERS: readonly DemandLayer[] = ['ORDERS', 'MTM', 'SAMPLES', 'REMAKES']
/** The design's two W3 layers: a toggle held with its reason, a tile that says "—". */
export const HELD_LAYERS = ['BRANDS', 'FORECAST'] as const
/** The tiles in the design's order ("Confirmed orders, Made-to-measure units, Samples and protos, Remakes …"). */
export const TILE_ORDER = ['ORDERS', 'MTM', 'SAMPLES', 'REMAKES', 'QUOTES', 'BRANDS', 'FORECAST'] as const
export type TileLayer = (typeof TILE_ORDER)[number]
/** The horizons offered beside the site's own (weeks). */
export const WEEK_CHOICES = [13, 26, 52] as const
export const BUCKETS = ['WEEK', 'MONTH'] as const
export type Bucket = (typeof BUCKETS)[number]
/** Rows of the list per page, and in the popover. */
export const PAGE = 100
export const POPOVER_LIMIT = 200
/** Sources the popover lists before "Show all in Demand rows". */
export const POPOVER_SHOWN = 8

export interface DemandControls {
  site: string | null
  bucket: Bucket
  /** null: the site's planning horizon. */
  weeks: number | null
  /** The layers the grid adds up (the toggles). */
  layers: readonly DemandLayer[]
  /** The grid's search (a style's code or name). */
  q: string
  /** The list's own filters: a layer, a search (a style or a document's number) and one cell of the grid. */
  layer: DemandLayer | null
  rq: string
  style: string | null
  colour: string | null
  size: string | null
  mtm: boolean
  cell: string | null
}

export const isLayer = (value: string | null | undefined): value is DemandLayer => (DEMAND_LAYERS as readonly string[]).includes(value ?? '')

export function controlsOf(params: { get(name: string): string | null } | null | undefined): DemandControls {
  const get = (name: string) => params?.get(name) ?? null
  const bucket = get('bucket')
  const weeks = Number(get('weeks'))
  const layersText = get('layers')
  const layers = layersText === null ? DEFAULT_LAYERS : layersText.split(',').filter(isLayer)
  const layer = get('layer')
  return {
    site: get('site'),
    bucket: bucket === 'MONTH' ? 'MONTH' : 'WEEK',
    weeks: Number.isInteger(weeks) && weeks >= 1 && weeks <= 104 ? weeks : null,
    layers: GRID_LAYERS.filter((entry) => layers.includes(entry)),
    q: get('q') ?? '',
    layer: isLayer(layer) ? layer : null,
    rq: get('rq') ?? '',
    style: get('style'),
    colour: get('colour'),
    size: get('size'),
    mtm: get('mtm') === '1',
    cell: get('cell'),
  }
}

const sameLayers = (a: readonly DemandLayer[], b: readonly DemandLayer[]) => a.length === b.length && a.every((layer) => b.includes(layer))

export function queryOf(controls: DemandControls): string {
  const query = new URLSearchParams()
  if (controls.site) query.set('site', controls.site)
  if (controls.bucket !== 'WEEK') query.set('bucket', controls.bucket)
  if (controls.weeks !== null) query.set('weeks', String(controls.weeks))
  if (!sameLayers(controls.layers, DEFAULT_LAYERS)) query.set('layers', controls.layers.join(','))
  if (controls.q) query.set('q', controls.q)
  if (controls.layer) query.set('layer', controls.layer)
  if (controls.rq) query.set('rq', controls.rq)
  if (controls.style) query.set('style', controls.style)
  if (controls.colour) query.set('colour', controls.colour)
  if (controls.size) query.set('size', controls.size)
  if (controls.mtm) query.set('mtm', '1')
  if (controls.cell) query.set('cell', controls.cell)
  return query.toString()
}

/** A layer on or off; the grid always keeps one (the last cannot be switched off). */
export function toggledLayers(layers: readonly DemandLayer[], layer: DemandLayer): DemandLayer[] {
  const next = layers.includes(layer) ? layers.filter((entry) => entry !== layer) : [...layers, layer]
  return next.length === 0 ? [...layers] : GRID_LAYERS.filter((entry) => next.includes(entry))
}

/** The list's filters as the rows read takes them. */
export function listFilterOf(controls: DemandControls): RowsFilter {
  return { layer: controls.layer, styleId: controls.style, colourwayId: controls.colour, size: controls.mtm ? null : controls.size, madeToMeasure: controls.mtm, cell: controls.cell, q: controls.rq || null }
}

/** The list is narrowed to one cell (or one row) of the grid. */
export const listOnCell = (controls: DemandControls): boolean => controls.style !== null

export const clearedList = (controls: DemandControls): DemandControls => ({ ...controls, layer: null, rq: '', style: null, colour: null, size: null, mtm: false, cell: null })

// ---- the tiles --------------------------------------------------------------------------------------------------------------

export function tilesInOrder(tiles: readonly DemandTile[]): DemandTile[] {
  return TILE_ORDER.map((layer) => tiles.find((tile) => tile.layer === layer) ?? { layer, known: false, pieces: null, sources: null, pastDue: null, undated: null, later: null, unplanned: null })
}

// ---- the time-phased grid ---------------------------------------------------------------------------------------------------

/** One line of the grid: a style in a colourway, or one of its sizes (null size: made-to-measure units). */
export interface GridLine {
  readonly id: string
  readonly kind: 'row' | 'size'
  readonly row: DemandRow
  /** A size line's size (null: made to measure); undefined on a style-colour line. */
  readonly size?: string | null
  readonly totals: DemandTotals
  readonly cells: readonly DemandCell[]
}

export const sizeLineId = (rowKey: string, size: string | null) => `${rowKey}|${size ?? '~mtm'}`

/** The grid's lines: each style-colour row, and below it its sizes while it is open. */
export function gridLines(rows: readonly DemandRow[], open: readonly string[]): GridLine[] {
  const lines: GridLine[] = []
  for (const row of rows) {
    lines.push({ id: row.key, kind: 'row', row, totals: row.totals, cells: row.cells })
    if (!open.includes(row.key)) continue
    for (const size of row.sizes) lines.push({ id: sizeLineId(row.key, size.size), kind: 'size', row, size: size.size, totals: size.totals, cells: size.cells })
  }
  return lines
}

type LayerCounts = Pick<DemandTotals, DemandLayer>
/** Pieces of the layers shown. */
export const shown = (counts: LayerCounts | undefined, layers: readonly DemandLayer[]): number => (counts ? layers.reduce((sum, layer) => sum + (counts[layer] ?? 0), 0) : 0)

export const cellOf = (line: Pick<GridLine, 'cells'>, bucket: string): DemandCell | undefined => line.cells.find((cell) => cell.bucket === bucket)

/** The grid's columns, in order: PAST (only when something is late), the horizon's buckets, NONE (only when something has no day). */
export function columnBuckets(demand: Pick<Demand, 'horizon' | 'rows'>, layers: readonly DemandLayer[]): string[] {
  const any = (bucket: string) => demand.rows.some((row) => shown(cellOf(row, bucket), layers) > 0)
  return [...(any(PAST) ? [PAST] : []), ...demand.horizon.buckets.map((bucket) => bucket.key), ...(any(UNDATED) ? [UNDATED] : [])]
}

/** The busiest cell of the grid (style-colour lines, the layers shown): the mini bars' full width. */
export function busiest(rows: readonly DemandRow[], layers: readonly DemandLayer[]): number {
  let max = 0
  for (const row of rows) for (const cell of row.cells) max = Math.max(max, shown(cell, layers))
  return max
}

export interface BarPart {
  readonly layer: DemandLayer
  readonly pieces: number
  /** Its share of the bar's length (0–100). */
  readonly pct: number
}

/** The stacked mini bar of a cell: its length against the busiest cell, one part per layer shown that has pieces. */
export function barOf(counts: LayerCounts | undefined, layers: readonly DemandLayer[], max: number): { length: number; parts: BarPart[] } {
  const total = shown(counts, layers)
  if (!counts || total <= 0 || max <= 0) return { length: 0, parts: [] }
  const length = Math.max(8, Math.round((Math.min(total, max) / max) * 100))
  const parts = GRID_LAYERS.filter((layer) => layers.includes(layer) && counts[layer] > 0).map((layer) => ({ layer, pieces: counts[layer], pct: (counts[layer] / total) * 100 }))
  return { length, parts }
}

export interface Words {
  readonly t: Translate
  readonly locale: Locale
}

export const pieces = (value: number, locale: Locale) => formatNumber(value, locale)
/** "1 piece", "38 pieces" in the person's language. */
export const piecesWords = (value: number, words: Words): string => words.t('common.pieces', { count: value, n: pieces(value, words.locale) })
/** "1 source", "11 sources". */
export const sourcesWords = (value: number, words: Words): string => words.t('common.sources', { count: value, n: pieces(value, words.locale) })

/** A day as the grid says it: "16 Nov". */
export function dayWords(day: string, locale: Locale, withYear = false): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number]
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], { timeZone: 'UTC', day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}) }).format(new Date(Date.UTC(year, month - 1, date)))
}

/** A bucket's head: "Wk 47" (its days in the head's tooltip), "Nov 2026", "Late", "No date". */
export function bucketLabel(key: string, horizon: Pick<DemandHorizon, 'buckets' | 'kind'>, words: Words): string {
  const { t, locale } = words
  if (key === PAST) return t('grid.past')
  if (key === UNDATED) return t('grid.none')
  if (key === LATER) return t('grid.later')
  const bucket = horizon.buckets.find((entry) => entry.key === key)
  if (!bucket) return key
  if (horizon.kind === 'MONTH') {
    const [year, month] = key.split('-').map(Number) as [number, number]
    return new Intl.DateTimeFormat(INTL_LOCALE[locale], { timeZone: 'UTC', month: 'short', year: 'numeric' }).format(new Date(Date.UTC(year, month - 1, 15)))
  }
  const week = /W(\d{2})$/.exec(key)?.[1]
  return t('grid.week', { week: week ? String(Number(week)) : '—' })
}

/** A bucket's days in words, for the head's tooltip: "16–22 Nov 2026"; the late column: "before 9 Nov". */
export function bucketSpan(key: string, horizon: Pick<DemandHorizon, 'buckets' | 'from' | 'to'>, words: Words): string {
  const { t, locale } = words
  if (key === PAST) return t('grid.pastSpan', { day: dayWords(horizon.from, locale, true) })
  if (key === UNDATED) return t('grid.noneSpan')
  if (key === LATER) return t('grid.laterSpan', { day: dayWords(horizon.to, locale, true) })
  const bucket = horizon.buckets.find((entry) => entry.key === key)
  return bucket ? t('grid.span', { from: dayWords(bucket.from, locale), to: dayWords(bucket.to, locale, true) }) : key
}

/** A line's name: "SEED-JKT-02 · Black", a sample row of any colourway, a size, made to measure. */
export function lineName(line: GridLine, t: Translate): string {
  if (line.kind === 'size') return line.size === null ? t('grid.mtm') : t('grid.size', { size: line.size ?? '' })
  return `${line.row.style.code} · ${line.row.colourway ? line.row.colourway.name : t('grid.anyColour')}`
}

/** What a cell holds in words (the trigger's name): "SEED-JKT-02 · Black, Wk 47: 5 pieces — 3 orders, 2 remakes". */
export function cellLabel(line: GridLine, bucketName: string, counts: LayerCounts | undefined, layers: readonly DemandLayer[], words: Words): string {
  const { t } = words
  const total = shown(counts, layers)
  const parts = GRID_LAYERS.filter((layer) => layers.includes(layer) && (counts?.[layer] ?? 0) > 0).map((layer) => t(`layerCount.${layer}`, { count: counts![layer] }))
  const name = line.kind === 'size' ? `${line.row.style.code} · ${line.row.colourway?.name ?? t('grid.anyColour')} · ${lineName(line, t)}` : lineName(line, t)
  return t('grid.cellLabel', { line: name, bucket: bucketName, pieces: piecesWords(total, words), layers: parts.join(', ') || '—' })
}

// ---- the popover: what makes this number --------------------------------------------------------------------------------------

/** The cell the popover is about: a grid line and a bucket (null: the line's whole horizon). */
export interface CellRef {
  readonly lineId: string
  readonly bucket: string | null
}

export const cellRefKey = (ref: CellRef) => `${ref.lineId}@${ref.bucket ?? '*'}`

/** The rows read of a cell: its style, its colourway (or none), its size (or made to measure), its bucket. */
export function cellFilter(line: GridLine, bucket: string | null): RowsFilter {
  return {
    styleId: line.row.style.id,
    colourwayId: line.row.colourway?.id ?? 'none',
    ...(line.kind === 'size' ? (line.size === null ? { madeToMeasure: true } : { size: line.size }) : {}),
    cell: bucket,
  }
}

/** The list's address terms for the same cell ("Show all in Demand rows"). */
export function listOnCellOf(controls: DemandControls, line: GridLine, bucket: string | null): DemandControls {
  return {
    ...clearedList(controls),
    style: line.row.style.id,
    colour: line.row.colourway?.id ?? 'none',
    size: line.kind === 'size' && line.size !== null ? (line.size ?? null) : null,
    mtm: line.kind === 'size' && line.size === null,
    cell: bucket,
  }
}

/** The kinds the popover counts, those of the layers shown only. */
export const shownKinds = (kinds: readonly KindCount[], layers: readonly DemandLayer[]): KindCount[] => kinds.filter((entry) => layers.includes(LAYER_OF_KIND[entry.kind]) && entry.sources > 0)

/** "3 orders, 1 remake" in our words (never the API's), from the kinds' counts. */
export function kindsWords(kinds: readonly KindCount[], t: Translate): string {
  return kinds.map((entry) => t(`kindCount.${entry.kind}`, { count: entry.sources })).join(', ')
}

// ---- a source document ---------------------------------------------------------------------------------------------------------

/** Where a source opens (company prefix + record-links): its own page once built, else its panels. */
export function recordHref(prefix: string, built: ReadonlySet<string>, ref: { recordType: string; recordId: string; number: string }): string {
  return `${prefix}${recordAddress({ type: ref.recordType, id: ref.recordId, label: ref.number }, built)}`
}

/** The document in words: "SO-0004 · line 2", "SR-0001", "WO-0001 (rework)". */
export function documentWords(row: SourceRow, t: Translate): string {
  return row.source.line !== null ? t('rows.docLine', { number: row.source.number, line: row.source.line }) : row.source.number
}

/** The source's kind in words, with its sample kind or recut part: "Sample round · Fit", "Recut · sleeve". */
export function kindWords(row: Pick<SourceRow, 'kind' | 'sampleKind' | 'part'>, t: Translate): string {
  const base = t(`kind.${row.kind}`)
  if (row.sampleKind) return `${base} · ${t(`sampleKind.${row.sampleKind}`)}`
  if (row.part) return `${base} · ${row.part}`
  return base
}

export const STATUS_WORDS = ['CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED', 'SENT', 'REQUESTED', 'IN_MAKING', 'OPEN', 'IN_PROGRESS', 'AUTHORISED', 'RECEIVED', 'INSPECTED'] as const
/** The source's own status in words (a status the screen does not know reads "Open", never its code). */
export const statusWords = (status: string, t: Translate): string => ((STATUS_WORDS as readonly string[]).includes(status) ? t(`status.${status}`) : t('status.other'))

/** The day in words: "15 Jan 2027 · 3 days late", "No date". */
export function whenWords(row: Pick<SourceRow, 'date' | 'daysLate'>, words: Words): { day: string; late: string | null } {
  const { t, locale } = words
  if (row.date === null) return { day: t('rows.noDate'), late: null }
  return { day: dayWords(row.date, locale, true), late: row.daysLate && row.daysLate > 0 ? t('rows.late', { count: row.daysLate }) : null }
}

export const sizeWords = (row: Pick<SourceRow, 'size'>, t: Translate): string => (row.size === null ? t('grid.mtm') : row.size)

// ---- what the page may do, and its problems --------------------------------------------------------------------------------

export interface DemandCan {
  /** planning.view: the page. */
  readonly view: boolean
  /** planning.strategy.manage: the strategy page changes what the rows show. */
  readonly strategy: boolean
}

export const demandCan = (permissions: readonly string[]): DemandCan => ({ view: permissions.includes('planning.view'), strategy: permissions.includes('planning.strategy.manage') })

/** A failed read in our words (a key of the catalogue). */
export function readProblemOf(error: unknown): string {
  if (!isApiError(error)) return 'error.failed'
  if (error.kind === 'forbidden' || error.kind === 'step_up') return 'error.forbidden'
  if (error.kind === 'unavailable') return 'error.offline'
  if (error.kind === 'not_found') return 'error.gone'
  if (error.kind === 'invalid' && error.issues.some((issue) => String(issue.path ?? '').includes('cursor'))) return 'error.moved'
  return 'error.failed'
}

// ---- the grid's file -----------------------------------------------------------------------------------------------------------

/** The grid as shown (the layers on), one line per style-colour (and per size of the open ones): the band's Export and Export N. */
export function csvOfGrid(demand: Demand, lines: readonly GridLine[], layers: readonly DemandLayer[], words: Words): string {
  const { t } = words
  const buckets = columnBuckets(demand, layers)
  const header = [t('csv.style'), t('csv.colourway'), t('csv.size'), t('csv.strategy'), t('csv.total'), ...buckets.map((key) => bucketLabel(key, demand.horizon, words))]
  const rows = lines.map((line) => [
    `${line.row.style.code} ${line.row.style.name}`,
    line.row.colourway ? `${line.row.colourway.code} ${line.row.colourway.name}` : t('grid.anyColour'),
    line.kind === 'size' ? (line.size === null ? t('grid.mtm') : line.size) : '',
    line.kind === 'row' ? t(`strategy.${line.row.strategy}`) : '',
    shown(line.totals, layers),
    ...buckets.map((key) => shown(cellOf(line, key), layers)),
  ])
  return csvOf(header, rows)
}

export const kindLayer = (kind: DemandKind): DemandLayer => LAYER_OF_KIND[kind]
