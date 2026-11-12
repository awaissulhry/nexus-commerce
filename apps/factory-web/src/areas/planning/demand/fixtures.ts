import { createElement, type ReactNode } from 'react'
import { DEMAND_LAYERS, demandHorizon, LAYER_OF_KIND, type DemandKind, type DemandLayer } from '@nexus/factory-domain/planning/demand/rules'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { permissionCheck } from '../../../lib/session/session'
import { officeNavFor, OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER, rolePermissions } from '../../../shell/design-data'
import { OfficeShellView, type OfficeShellViewModel } from '../../../shell/office/view/OfficeShellView'
import { SITES } from '../board/fixtures'
import type { Demand, DemandCell, DemandHorizon, DemandRow, DemandTile, SourceRow, SourceRows } from './api'
import { controlsOf, demandCan, DEFAULT_LAYERS, sizeLineId, type DemandControls } from './model'
import type { DemandModel, ListRows } from './view-model'
import { DemandView } from './view/DemandView'

/**
 * SCR-374 Demand & forecast with made-up data: an invented site, styles ("JKT-DEMO-07 Giacca Demo Strada"), colourways ("Nero"),
 * customers ("Moto Demo Srl"), orders ("SO-DEMO-1043"), quotes ("Q-DEMO-0210"), sample rounds ("SR-DEMO-0031"), work orders
 * ("WO-DEMO-0050"), NCRs and returns. Nothing here is a real company, customer, person or number. Drawn inside the Office shell
 * with the role's navigation. Today is Thursday 12 November 2026; the horizon starts on Monday 9 November (13 weeks).
 */

const uid = (block: string, n: number) => `0190f0e4-${block}-7000-8000-${String(n).padStart(12, '0')}`
const SITE = SITES[0]!
const SITE_VIEW = { id: SITE.id, companyId: SITE.companyId, code: SITE.code, name: SITE.name, timeZone: 'Europe/Rome' }
const TODAY = '2026-11-12'
const AS_OF = '2026-11-12T08:42:00.000Z'

/** The horizons as the API makes them (factory-domain demandHorizon: from this week's Monday, uniform buckets). */
const horizonOf = (kind: 'WEEK' | 'MONTH'): DemandHorizon => {
  const horizon = demandHorizon(TODAY, 13, kind)
  return { kind, from: horizon.from, to: horizon.to, weeks: horizon.weeks, buckets: horizon.buckets.map((bucket) => ({ key: bucket.key, from: bucket.from, to: bucket.to })) }
}
const WEEK_HORIZON = horizonOf('WEEK')
const MONTH_HORIZON = horizonOf('MONTH')
const WEEK_BUCKETS = WEEK_HORIZON.buckets
const WEEKS = WEEK_BUCKETS.length
const W = (index: number) => WEEK_BUCKETS[index]!.key
const monthOf = (key: string) => {
  if (key === 'PAST' || key === 'NONE') return key
  const day = WEEK_BUCKETS.find((bucket) => bucket.key === key)?.from ?? ''
  return MONTH_HORIZON.buckets.find((bucket) => day >= bucket.from && day <= bucket.to)?.key ?? key
}

const named = (block: string, n: number, code: string, name: string) => ({ id: uid(block, n), code, name })
const JKT07 = named('6161', 1, 'JKT-DEMO-07', 'Giacca Demo Strada')
const JKT12 = named('6161', 2, 'JKT-DEMO-12', 'Giacca Demo Pista')
const PNT03 = named('6161', 3, 'PNT-DEMO-03', 'Pantalone Demo')
const GLV01 = named('6161', 4, 'GLV-DEMO-01', 'Guanto Demo')
const NERO = named('7272', 1, 'NER', 'Nero')
const ROSSO = named('7272', 2, 'ROS', 'Rosso')
const MARRONE = named('7272', 3, 'MAR', 'Marrone')
const CUSTOMER = named('4141', 1, 'C-DEMO-01', 'Moto Demo Srl')
const CUSTOMER2 = named('4141', 2, 'C-DEMO-02', 'Racing Esempio')

/** One piece of demand of a fixture row: size (null: made to measure), bucket, layer, pieces. */
type Entry = readonly [size: string | null, bucket: string, layer: DemandLayer, pieces: number]
const zero = () => ({ ORDERS: 0, QUOTES: 0, MTM: 0, SAMPLES: 0, REMAKES: 0, firm: 0 })
const firmOf = (counts: Omit<DemandCell, 'bucket' | 'firm'>) => counts.ORDERS + counts.MTM + counts.SAMPLES + counts.REMAKES

function cellsOf(entries: readonly Entry[], bucketOf: (key: string) => string): { cells: DemandCell[]; totals: DemandRow['totals'] } {
  const cells = new Map<string, DemandCell>()
  const totals = zero()
  for (const [, key, layer, pieces] of entries) {
    const bucket = bucketOf(key)
    const cell = { ...(cells.get(bucket) ?? { bucket, ...zero() }) }
    cell[layer] += pieces
    cell.firm = firmOf(cell)
    cells.set(bucket, cell)
    totals[layer] += pieces
  }
  totals.firm = firmOf(totals)
  return { cells: [...cells.values()], totals }
}

function row(style: { id: string; code: string; name: string }, colourway: { id: string; code: string; name: string } | null, strategy: DemandRow['strategy'], entries: readonly Entry[], monthly = false): DemandRow {
  const bucketOf = monthly ? monthOf : (key: string) => key
  const { cells, totals } = cellsOf(entries, bucketOf)
  const sizes = [...new Set(entries.map(([size]) => size))].sort((a, b) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)))
  return {
    key: `${style.id}:${colourway?.id ?? '-'}`,
    style,
    colourway,
    strategy,
    totals,
    cells,
    sizes: sizes.map((size) => ({ size, ...cellsOf(entries.filter(([entry]) => entry === size), bucketOf) })),
  }
}

const ENTRIES: { style: typeof JKT07; colourway: typeof NERO | null; strategy: DemandRow['strategy']; entries: Entry[] }[] = [
  {
    style: JKT07,
    colourway: NERO,
    strategy: 'MAKE_TO_ORDER',
    entries: [
      ['48', 'PAST', 'ORDERS', 2],
      ['50', 'PAST', 'ORDERS', 2],
      ['46', W(0), 'ORDERS', 4],
      ['48', W(0), 'ORDERS', 4],
      ['50', W(0), 'ORDERS', 4],
      ['50', W(1), 'REMAKES', 2],
      ['48', W(3), 'ORDERS', 6],
      ['50', W(3), 'ORDERS', 8],
      ['52', W(3), 'ORDERS', 6],
      [null, W(4), 'MTM', 1],
      ['52', W(5), 'ORDERS', 8],
      ['54', W(8), 'QUOTES', 12],
    ],
  },
  { style: JKT07, colourway: ROSSO, strategy: 'MAKE_TO_ORDER', entries: [['48', W(4), 'QUOTES', 15], ['50', W(4), 'QUOTES', 15], ['50', W(6), 'ORDERS', 10]] },
  { style: JKT12, colourway: NERO, strategy: 'MAKE_TO_STOCK', entries: [['50', W(1), 'ORDERS', 20], ['52', W(1), 'ORDERS', 20], ['50', W(4), 'ORDERS', 20], ['52', W(4), 'ORDERS', 20], ['54', W(10), 'ORDERS', 12]] },
  { style: PNT03, colourway: null, strategy: 'MAKE_TO_ORDER', entries: [['M', W(0), 'SAMPLES', 2], ['L', W(0), 'SAMPLES', 1]] },
  { style: GLV01, colourway: MARRONE, strategy: 'MIXED', entries: [['9', W(0), 'REMAKES', 1], ['8', 'NONE', 'ORDERS', 3], ['9', 'NONE', 'ORDERS', 3], ['10', W(2), 'SAMPLES', 2]] },
]
const ROWS = ENTRIES.map((entry) => row(entry.style, entry.colourway, entry.strategy, entry.entries))
const MONTH_ROWS = ENTRIES.map((entry) => row(entry.style, entry.colourway, entry.strategy, entry.entries, true))
/** "Many rows": made-up styles 01–40, each with a few orders. */
const MANY_ROWS = Array.from({ length: 40 }, (_, index) => {
  const style = named('6262', index + 1, `JKT-DEMO-${String(20 + index).padStart(2, '0')}`, `Giacca Demo ${index + 1}`)
  return row(style, NERO, index % 7 === 0 ? 'MAKE_TO_STOCK' : 'MAKE_TO_ORDER', [
    ['50', W(index % WEEKS), 'ORDERS', 4 + (index % 5) * 3],
    ['52', W((index + 3) % WEEKS), 'ORDERS', 6],
    ...(index % 4 === 0 ? ([['50', W((index + 1) % WEEKS), 'REMAKES', 1]] as Entry[]) : []),
    ...(index % 6 === 0 ? ([['48', 'PAST', 'ORDERS', 2]] as Entry[]) : []),
  ])
})

function tilesOf(rows: readonly DemandRow[], sources: Partial<Record<DemandLayer, number>> = {}, later: Partial<Record<DemandLayer, number>> = {}): DemandTile[] {
  const sum = (layer: DemandLayer, bucket?: string) => rows.reduce((total, entry) => total + (bucket ? (entry.cells.find((cell) => cell.bucket === bucket)?.[layer] ?? 0) : entry.totals[layer]), 0)
  return [
    ...DEMAND_LAYERS.map((layer) => ({ layer, known: true, pieces: sum(layer), sources: sources[layer] ?? rows.filter((entry) => entry.totals[layer] > 0).length, pastDue: sum(layer, 'PAST'), undated: sum(layer, 'NONE'), later: later[layer] ?? 0, unplanned: layer === 'ORDERS' ? 0 : sum(layer) })),
    { layer: 'BRANDS' as const, known: false, pieces: null, sources: null, pastDue: null, undated: null, later: null, unplanned: null },
    { layer: 'FORECAST' as const, known: false, pieces: null, sources: null, pastDue: null, undated: null, later: null, unplanned: null },
  ]
}

const demandOf = (rows: readonly DemandRow[], horizon: DemandHorizon = WEEK_HORIZON, over: Partial<Demand> = {}): Demand => ({
  site: SITE_VIEW,
  asOf: AS_OF,
  today: TODAY,
  horizon,
  tiles: tilesOf(rows, { ORDERS: 7, QUOTES: 2, MTM: 1, SAMPLES: 2, REMAKES: 3 }, { ORDERS: 24 }),
  rows: [...rows],
  truncated: false,
  unplaced: { orderLines: 0, quoteLines: 0, sampleRounds: 0 },
  ...over,
})
const DEMAND = demandOf(ROWS)

// ---- the sources (the list and the popovers) ----------------------------------------------------------------------------------

function source(n: number, kind: DemandKind, over: Partial<SourceRow> & Pick<SourceRow, 'style' | 'size' | 'pieces' | 'date' | 'bucket'>): SourceRow {
  const layer = LAYER_OF_KIND[kind]
  return {
    key: `${kind}:${uid('9999', n)}:${over.colourway?.id ?? '-'}:${over.size ?? '-'}:${over.date ?? '-'}`,
    layer,
    kind,
    source: { recordType: 'SalesOrder', recordId: uid('9001', n), number: `SO-DEMO-10${40 + n}`, line: 1, mayOpen: true },
    origin: null,
    workOrder: null,
    party: CUSTOMER,
    colourway: NERO,
    daysLate: 0,
    status: 'CONFIRMED',
    sampleKind: null,
    part: null,
    validUntil: null,
    planned: true,
    ...over,
  }
}
const SO_1043 = { recordType: 'SalesOrder', recordId: uid('9001', 3), number: 'SO-DEMO-1043', line: 1, mayOpen: true }
const SO_1047 = { recordType: 'SalesOrder', recordId: uid('9001', 7), number: 'SO-DEMO-1047', line: 2, mayOpen: true }
const SOURCES: SourceRow[] = [
  source(1, 'ORDER_LINE', { style: JKT07, size: '48', pieces: 2, date: '2026-11-04', bucket: 'PAST', daysLate: 8, source: SO_1043, status: 'IN_PRODUCTION' }),
  source(2, 'ORDER_LINE', { style: JKT07, size: '50', pieces: 2, date: '2026-11-04', bucket: 'PAST', daysLate: 8, source: SO_1043, status: 'IN_PRODUCTION' }),
  source(3, 'ORDER_LINE', { style: JKT07, size: '46', pieces: 4, date: '2026-11-13', bucket: W(0), source: SO_1047 }),
  source(4, 'ORDER_LINE', { style: JKT07, size: '48', pieces: 4, date: '2026-11-13', bucket: W(0), source: SO_1047 }),
  source(5, 'ORDER_LINE', { style: JKT07, size: '50', pieces: 4, date: '2026-11-13', bucket: W(0), source: SO_1047 }),
  source(6, 'SAMPLE_ROUND', { style: PNT03, colourway: null, size: 'M', pieces: 2, date: '2026-11-14', bucket: W(0), source: { recordType: 'SampleRound', recordId: uid('9101', 1), number: 'SR-DEMO-0031', line: null, mayOpen: true }, party: CUSTOMER2, status: 'IN_MAKING', sampleKind: 'FIT', planned: false }),
  source(7, 'SAMPLE_ROUND', { style: PNT03, colourway: null, size: 'L', pieces: 1, date: '2026-11-14', bucket: W(0), source: { recordType: 'SampleRound', recordId: uid('9101', 1), number: 'SR-DEMO-0031', line: null, mayOpen: true }, party: CUSTOMER2, status: 'IN_MAKING', sampleKind: 'FIT', planned: false }),
  source(8, 'RECUT', { style: GLV01, colourway: MARRONE, size: '9', pieces: 1, date: '2026-11-15', bucket: W(0), source: { recordType: 'WorkOrder', recordId: uid('9201', 1), number: 'WO-DEMO-0050', line: null, mayOpen: true }, origin: { recordType: 'Nonconformance', recordId: uid('9301', 1), number: 'NCR-DEMO-0007' }, party: null, status: 'OPEN', part: 'palmo', planned: false }),
  source(9, 'REWORK', { style: JKT07, size: '50', pieces: 2, date: '2026-11-18', bucket: W(1), source: { recordType: 'ReworkOrder', recordId: uid('9401', 1), number: 'WO-DEMO-0044', line: null, mayOpen: true }, origin: { recordType: 'Nonconformance', recordId: uid('9301', 2), number: 'NCR-DEMO-0009' }, workOrder: { id: uid('9201', 2), number: 'WO-DEMO-0044' }, party: null, status: 'IN_PROGRESS', planned: false }),
  source(10, 'ORDER_LINE', { style: JKT12, size: '50', pieces: 20, date: '2026-11-20', bucket: W(1), source: { ...SO_1043, line: 2 }, party: CUSTOMER2, status: 'CONFIRMED' }),
  source(11, 'ORDER_LINE', { style: JKT12, size: '52', pieces: 20, date: '2026-11-20', bucket: W(1), source: { ...SO_1043, line: 2 }, party: CUSTOMER2, status: 'CONFIRMED' }),
  source(12, 'MTM_UNIT', { style: JKT07, size: null, pieces: 1, date: '2026-12-09', bucket: W(4), source: { ...SO_1047, line: 4 }, status: 'CONFIRMED' }),
  source(13, 'QUOTE_LINE', { style: JKT07, colourway: ROSSO, size: '48', pieces: 15, date: '2026-12-10', bucket: W(4), source: { recordType: 'Quote', recordId: uid('9501', 1), number: 'Q-DEMO-0210', line: 1, mayOpen: false }, party: CUSTOMER2, status: 'SENT', validUntil: '2026-11-30', planned: false }),
  source(14, 'QUOTE_LINE', { style: JKT07, colourway: ROSSO, size: '50', pieces: 15, date: '2026-12-10', bucket: W(4), source: { recordType: 'Quote', recordId: uid('9501', 1), number: 'Q-DEMO-0210', line: 1, mayOpen: false }, party: CUSTOMER2, status: 'SENT', validUntil: '2026-11-30', planned: false }),
  source(15, 'RETURN_REPLACEMENT', { style: JKT07, colourway: ROSSO, size: '50', pieces: 10, date: '2026-12-18', bucket: W(6), source: { recordType: 'SalesOrder', recordId: uid('9001', 9), number: 'SO-DEMO-1052', line: 1, mayOpen: true }, origin: { recordType: 'ReturnAuthorisation', recordId: uid('9601', 1), number: 'RMA-DEMO-0004' }, status: 'CONFIRMED' }),
  source(16, 'ORDER_LINE', { style: GLV01, colourway: MARRONE, size: '8', pieces: 3, date: null, bucket: 'NONE', daysLate: null, source: { recordType: 'SalesOrder', recordId: uid('9001', 11), number: 'SO-DEMO-1060', line: 3, mayOpen: true }, status: 'READY' }),
]

const kindsOf = (rows: readonly SourceRow[]) => {
  const counts = new Map<DemandKind, { kind: DemandKind; sources: number; pieces: number; ids: Set<string> }>()
  for (const entry of rows) {
    const count = counts.get(entry.kind) ?? { kind: entry.kind, sources: 0, pieces: 0, ids: new Set<string>() }
    const id = `${entry.source.recordId}:${entry.source.line ?? ''}`
    if (!count.ids.has(id)) count.ids.add(id)
    count.sources = count.ids.size
    count.pieces += entry.pieces
    counts.set(entry.kind, count)
  }
  return [...counts.values()].map(({ kind, sources, pieces }) => ({ kind, sources, pieces }))
}
const rowsAnswer = (rows: readonly SourceRow[], nextCursor: string | null = null): SourceRows => ({ site: SITE_VIEW, asOf: AS_OF, today: TODAY, horizon: WEEK_HORIZON, rows: [...rows], kinds: kindsOf(rows), pieces: rows.reduce((sum, entry) => sum + entry.pieces, 0), nextCursor })
const listOf = (rows: readonly SourceRow[], nextCursor: string | null = null): ListRows => {
  const answer = rowsAnswer(rows, nextCursor)
  return { rows: answer.rows, pieces: answer.pieces, sources: answer.kinds.reduce((sum, entry) => sum + entry.sources, 0), nextCursor, more: 'idle' }
}

const NERO_ROW = ROWS[0]!
const W46 = W(0)
const POPOVER_ROWS = SOURCES.filter((entry) => entry.style.id === JKT07.id && entry.colourway?.id === NERO.id && entry.bucket === W46)

// ---- the cases -----------------------------------------------------------------------------------------------------------------

export interface DemandCase {
  model: DemandModel
  permissions: readonly string[]
}

function inShell(page: ReactNode, permissions: readonly string[]): ReactNode {
  const shell: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck(permissions)),
    path: '/planning/demand',
    switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: [], site: null, path: '/planning/demand' },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  return createElement(OfficeShellView, { model: shell }, page)
}

function DemandDesign({ model }: { model: DemandCase }) {
  return inShell(createElement(DemandView, { model: model.model }), model.permissions)
}

const PLANNER = rolePermissions('planner')
const BASE_CONTROLS: DemandControls = { ...controlsOf(null), site: SITE.id }

function make(over: Partial<Omit<DemandModel, 'controls'>> & { controls?: Partial<DemandControls> } = {}, permissions: readonly string[] = PLANNER): DemandCase {
  const { controls, ...rest } = over
  return {
    permissions,
    model: {
      prefix: '/w/DEMO',
      can: demandCan(permissions),
      sites: { status: 'ready', value: [SITE] },
      siteId: SITE.id,
      demand: { status: 'ready', value: DEMAND },
      list: { status: 'ready', value: listOf(SOURCES) },
      open: [],
      popover: null,
      live: 'live',
      updates: 0,
      dialog: null,
      built: OFFICE_PAGES,
      ...rest,
      controls: { ...BASE_CONTROLS, layers: DEFAULT_LAYERS, ...(controls ?? {}) },
    },
  }
}

const popoverOn = (rows: SourceRows | 'loading' | 'error', lineId = NERO_ROW.key, bucket: string | null = W46) => ({
  popover: { ref: { lineId, bucket }, rows: rows === 'loading' ? ({ status: 'loading' } as const) : rows === 'error' ? ({ status: 'error', problem: 'error.offline' } as const) : ({ status: 'ready', value: rows } as const) },
})
const onCell = { style: JKT07.id, colour: NERO.id, cell: W46 }

export const designScreen = defineDesignScreen<DemandCase>({
  screen: 'SCR-374',
  title: 'Demand & forecast',
  view: DemandDesign,
  cases: [
    { id: 'planner', label: 'The planner: demand at a glance, over time, the rows', model: make(), note: 'Tiles in the design’s order (brand demand and the forecast “—”); the grid adds the layers switched on; a number opens what makes it.' },
    { id: 'months', label: 'By month', model: make({ demand: { status: 'ready', value: demandOf(MONTH_ROWS, MONTH_HORIZON) }, controls: { bucket: 'MONTH' } }) },
    { id: 'quotes-on', label: 'Quotes likely to win switched on (never in the firm total)', model: make({ controls: { layers: ['ORDERS', 'MTM', 'SAMPLES', 'REMAKES', 'QUOTES'] } }) },
    { id: 'remakes-only', label: 'Only the remakes layer', model: make({ controls: { layers: ['REMAKES'] } }), note: 'The last layer on cannot be switched off (held with its reason).' },
    { id: 'sizes-open', label: 'JKT-DEMO-07 Nero opened to its sizes (and made to measure)', model: make({ open: [NERO_ROW.key] }) },
    { id: 'popover', label: 'What makes this number: JKT-DEMO-07 Nero, week 46', model: make(popoverOn(rowsAnswer(POPOVER_ROWS))), note: 'Each document is a real link: ⌘-click (or ↗) opens the source in a new tab.' },
    { id: 'popover-size', label: 'What makes this number: size 50 of JKT-DEMO-07 Nero, week 47 (a rework from an NCR)', model: make({ open: [NERO_ROW.key], ...popoverOn(rowsAnswer(SOURCES.filter((entry) => entry.kind === 'REWORK')), sizeLineId(NERO_ROW.key, '50'), W(1)) }) },
    { id: 'popover-held', label: 'A quote the planner may not open (no quotes.view): held, never a dead link', model: make({ controls: { layers: ['ORDERS', 'MTM', 'SAMPLES', 'REMAKES', 'QUOTES'] }, ...popoverOn(rowsAnswer(SOURCES.filter((entry) => entry.kind === 'QUOTE_LINE')), ROWS[1]!.key, W(4)) }) },
    { id: 'popover-loading', label: 'The popover while it reads', model: make(popoverOn('loading')) },
    { id: 'popover-error', label: 'The popover could not read', model: make(popoverOn('error')) },
    { id: 'list-cell', label: 'Demand rows narrowed to one cell (Show all in Demand rows)', model: make({ controls: onCell, list: { status: 'ready', value: listOf(POPOVER_ROWS) } }) },
    { id: 'tile-remakes', label: 'Tile Remakes pressed: the list shows remakes', model: make({ controls: { layer: 'REMAKES' }, list: { status: 'ready', value: listOf(SOURCES.filter((entry) => entry.layer === 'REMAKES')) } }) },
    { id: 'list-more', label: 'More rows to read: Show more', model: make({ list: { status: 'ready', value: listOf(SOURCES.slice(0, 10), SOURCES[9]!.key) } }) },
    { id: 'many', label: 'Many style-colours', model: make({ demand: { status: 'ready', value: demandOf(MANY_ROWS) } }) },
    { id: 'selection', label: 'Selection in the grid: Open sizes, Close sizes, Export', model: make({ selected: [ROWS[0]!.key, ROWS[2]!.key] }) },
    { id: 'selection-rows', label: 'Selection in the rows: Export N', model: make({ selectedRows: [SOURCES[2]!.key, SOURCES[3]!.key] }) },
    { id: 'banners', label: 'More than 400 style-colours, and demand without a making site', model: make({ demand: { status: 'ready', value: demandOf(ROWS, WEEK_HORIZON, { truncated: true, unplaced: { orderLines: 2, quoteLines: 1, sampleRounds: 0 } }) } }) },
    { id: 'updates', label: 'Three changes of the sources wait: Show', model: make({ updates: 3 }) },
    { id: 'search-empty', label: 'A style search that matches nothing', model: make({ controls: { q: 'zzz' }, demand: { status: 'ready', value: demandOf([]) } }) },
    { id: 'list-empty', label: 'The rows’ filters match nothing', model: make({ controls: { layer: 'MTM', rq: 'SO-DEMO-9' }, list: { status: 'ready', value: listOf([]) } }) },
    { id: 'empty', label: 'No demand in this horizon', model: make({ demand: { status: 'ready', value: demandOf([]) }, list: { status: 'ready', value: listOf([]) } }) },
    { id: 'loading', label: 'Loading: tiles “—”, skeleton rows', model: make({ demand: { status: 'loading' }, list: { status: 'loading' }, live: 'connecting' }) },
    { id: 'error', label: 'Couldn’t load the demand (tiles and grid), the rows still show', model: make({ demand: { status: 'error', problem: 'error.offline' }, live: 'offline' }), note: 'A failed read is never drawn as empty; each section fails on its own.' },
    { id: 'list-error', label: 'Couldn’t load the demand rows', model: make({ list: { status: 'error', problem: 'error.failed' } }) },
    { id: 'two-sites', label: 'Two sites: picked in the band', model: make({ sites: { status: 'ready', value: SITES } }) },
    { id: 'buyer', label: 'The buyer reads the same view', model: make({}, rolePermissions('buyer')) },
    { id: 'no-permission', label: 'Sales: no planning.view — the page says so', model: make({}, rolePermissions('sales').filter((permission) => permission !== 'planning.view')) },
    { id: 'keys', label: 'Keyboard shortcuts', model: make({ dialog: { kind: 'keys' } }) },
    { id: 'keyboard', label: 'Keyboard: the keys sit in the footer icon', model: make({ focusRow: 0, keysOpen: true }) },
  ],
})

export const FIXTURES = { DEMAND, ROWS, SOURCES, POPOVER_ROWS, WEEK_HORIZON, MONTH_HORIZON, JKT07, NERO, rowsAnswer, listOf }
