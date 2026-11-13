import { createElement } from 'react'
import { defaultSectionLayout } from '@nexus/ui/patterns'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { DEMO_COMPANIES, DEMO_SITES, rolePermissions } from '../../../shell/design-data'
import { scopeOf } from '../../../shell/scope/scope-model'
import { inShell, PREFIX, uid } from '../../quality/_shared/fixtures'
import type { Backlog, BacklogHorizon, BacklogLine, Headline, Intake, IntakeOrder, IntakeSplit, Returns, ReturnLineRow, Sight } from './api'
import { reportsAddressOf, reportsCan, sectionSpecs } from './model'
import { ReportsView, type Read, type ReportsModel } from './view/ReportsView'

/**
 * SCR-250 — Sales reports with made-up customers, styles, orders, returns and figures only ("Demo" names, DEMO- numbers, invented
 * pieces and amounts): November so far — the headline, the order intake by week (no split, by customer, by style, by month), the
 * backlog by promise week (late weeks, this week, no promise) by customer or style, the return reasons with the heatmap; the
 * records behind a bar, a group, a cell and a tile; a production manager without the price grain (pieces, never an amount); a
 * reader without orders or returns in the role; each panel's states (loading, one failed while the others stand, nothing booked,
 * nothing open, no returns); Arrange, half widths, the keys, offline, no right.
 */

export const NOW = '2026-11-12T08:15:00.000Z'
const FROM = '2026-11-01'
const TO = '2026-11-12'
const TODAY = TO
const COMPANY = { id: DEMO_COMPANIES[0].id, code: DEMO_COMPANIES[0].code, name: DEMO_COMPANIES[0].name }
const head = { company: COMPANY, from: FROM, to: TO, today: TODAY, asOf: NOW }
const SIGHT: Sight = { orders: true, quotes: true, returns: true, values: true }
const SCOPE = scopeOf({ company: DEMO_COMPANIES[0], sites: DEMO_SITES, chosen: null })

const C1 = { id: uid('3481', 1), code: 'DEMO-C1', name: 'Moto Demo Racing' }
const C2 = { id: uid('3481', 2), code: 'DEMO-C2', name: 'Esempio Rider Shop' }
const C3 = { id: uid('3481', 3), code: 'DEMO-C3', name: 'Squadra Demo Corse' }
const S1 = { id: uid('3482', 1), code: 'DEMO-JKT-01', name: 'Giacca Demo Pista' }
const S2 = { id: uid('3482', 2), code: 'DEMO-JKT-02', name: 'Giacca Demo Strada' }
const S3 = { id: uid('3482', 3), code: 'DEMO-SUIT-01', name: 'Tuta Demo Intera' }
const FW27 = { id: uid('3483', 1), code: 'FW27', name: 'Autunno inverno 27' }
const SS27 = { id: uid('3483', 2), code: 'SS27', name: 'Primavera estate 27' }

const money = (entries: { value: number; currency?: string }[]) => {
  const sums = new Map<string, number>()
  for (const entry of entries) sums.set(entry.currency ?? 'EUR', (sums.get(entry.currency ?? 'EUR') ?? 0) + entry.value)
  const byCurrency = [...sums.entries()].map(([currency, value]) => ({ currency, value }))
  return byCurrency.length === 1 ? { byCurrency, value: byCurrency[0]!.value, currency: byCurrency[0]!.currency, mixedCurrencies: false } : { byCurrency, value: null, currency: byCurrency.length ? null : 'EUR', mixedCurrencies: byCurrency.length > 1 }
}
const withoutValues = <T extends object>(value: T): T => JSON.parse(JSON.stringify(value, (key, item) => (key === 'value' || key === 'credited' ? undefined : item))) as T

// ---- order intake ------------------------------------------------------------------------------------------------------------

const order = (n: number, customer: typeof C1, bookedOn: string, bucket: string, season: typeof FW27 | null, styles: { style: typeof S1; pieces: number; value: number }[], splitOff = false): IntakeOrder => ({
  id: uid('3484', n),
  number: `DEMO-SO-04${String(n).padStart(2, '0')}`,
  status: 'CONFIRMED',
  customer,
  bookedOn,
  orderDate: splitOff ? '2026-11-10' : bookedOn,
  splitOff,
  season,
  bucket,
  pieces: styles.reduce((sum, entry) => sum + entry.pieces, 0),
  value: styles.reduce((sum, entry) => sum + entry.value, 0),
  currency: 'EUR',
  styles: styles.map((entry) => ({ key: entry.style.id, pieces: entry.pieces, value: entry.value })),
})
const ORDERS: IntakeOrder[] = [
  order(9, C1, '2026-11-11', '2026-W46', FW27, [{ style: S1, pieces: 120, value: 2_160_000 }]),
  order(8, C2, '2026-11-10', '2026-W46', FW27, [{ style: S2, pieces: 60, value: 870_000 }, { style: S1, pieces: 20, value: 360_000 }]),
  order(7, C3, '2026-11-09', '2026-W46', SS27, [{ style: S3, pieces: 24, value: 1_440_000 }]),
  order(6, C1, '2026-11-05', '2026-W45', FW27, [{ style: S1, pieces: 200, value: 3_600_000 }], true),
  order(5, C2, '2026-11-04', '2026-W45', null, [{ style: S2, pieces: 90, value: 1_305_000 }]),
  order(4, C1, '2026-11-03', '2026-W45', SS27, [{ style: S3, pieces: 12, value: 720_000 }]),
  order(3, C3, '2026-11-01', '2026-W44', FW27, [{ style: S2, pieces: 40, value: 580_000 }]),
]
const BUCKETS = [
  { key: '2026-W44', from: '2026-11-01', to: '2026-11-01' },
  { key: '2026-W45', from: '2026-11-02', to: '2026-11-08' },
  { key: '2026-W46', from: '2026-11-09', to: '2026-11-12' },
]
type Part = { orderId: string; bucket: string; pieces: number; value: number }
const partsOf = (split: IntakeSplit): Map<string, Part[]> => {
  const out = new Map<string, Part[]>()
  for (const entry of ORDERS) {
    const rows = split === 'style' ? entry.styles.map((style) => ({ key: style.key, pieces: style.pieces, value: style.value ?? 0 })) : [{ key: split === 'customer' ? entry.customer.id : split === 'season' ? (entry.season?.id ?? 'none') : 'all', pieces: entry.pieces, value: entry.value ?? 0 }]
    for (const row of rows) out.set(row.key, [...(out.get(row.key) ?? []), { orderId: entry.id, bucket: entry.bucket, pieces: row.pieces, value: row.value }])
  }
  return out
}
const figuresOf = (parts: Part[]) => ({ orders: new Set(parts.map((part) => part.orderId)).size, pieces: parts.reduce((sum, part) => sum + part.pieces, 0), ...money(parts.map((part) => ({ value: part.value }))) })
const NAMES = new Map<string, { code: string | null; name: string | null }>([...[C1, C2, C3, S1, S2, S3, FW27, SS27].map((entry) => [entry.id, { code: entry.code, name: entry.name }] as const), ['none', { code: null, name: null }]])

function intakeOf(split: IntakeSplit, by: 'week' | 'month' = 'week'): Intake {
  const all = [...partsOf('none').values()].flat()
  const buckets = by === 'week' ? BUCKETS : [{ key: '2026-11', from: FROM, to: TO }]
  const bucketOf = (entry: IntakeOrder) => (by === 'week' ? entry.bucket : '2026-11')
  const groups =
    split === 'none'
      ? []
      : [...partsOf(split).entries()]
          .map(([key, parts]) => ({ key, ...(NAMES.get(key) ?? { code: null, name: null }), figures: figuresOf(parts), buckets: buckets.map((bucket) => ({ key: bucket.key, figures: figuresOf(parts.filter((part) => (by === 'week' ? part.bucket === bucket.key : true))) })) }))
          .sort((a, b) => (b.figures.value ?? 0) - (a.figures.value ?? 0))
  return {
    ...head,
    sight: SIGHT,
    by,
    split,
    companyCurrency: 'EUR',
    all: figuresOf(all),
    buckets: buckets.map((bucket) => ({ ...bucket, figures: figuresOf(all.filter((part) => (by === 'week' ? part.bucket === bucket.key : true))) })),
    groups,
    more: 0,
    orders: ORDERS.map((entry) => ({ ...entry, bucket: bucketOf(entry) })),
    complete: true,
  }
}
export const INTAKE = intakeOf('none')
const INTAKE_BY_CUSTOMER = intakeOf('customer')
const INTAKE_BY_STYLE = intakeOf('style')
const INTAKE_BY_MONTH = intakeOf('season', 'month')

// ---- backlog -----------------------------------------------------------------------------------------------------------------

const WEEKS = [
  { key: '2026-W44', kind: 'WEEK' as const, from: '2026-10-26', to: '2026-11-01', past: true, current: false },
  { key: '2026-W45', kind: 'WEEK' as const, from: '2026-11-02', to: '2026-11-08', past: true, current: false },
  { key: '2026-W46', kind: 'WEEK' as const, from: '2026-11-09', to: '2026-11-15', past: false, current: true },
  { key: '2026-W47', kind: 'WEEK' as const, from: '2026-11-16', to: '2026-11-22', past: false, current: false },
  { key: '2026-W48', kind: 'WEEK' as const, from: '2026-11-23', to: '2026-11-29', past: false, current: false },
  { key: '2026-W49', kind: 'WEEK' as const, from: '2026-11-30', to: '2026-12-06', past: false, current: false },
  { key: '2026-W50', kind: 'WEEK' as const, from: '2026-12-07', to: '2026-12-13', past: false, current: false },
  { key: 'NONE', kind: 'NONE' as const, from: null, to: null, past: false, current: false },
]
const line = (n: number, customer: typeof C1, style: typeof S1, size: string | null, open: number, promise: string | null, week: string, horizon: BacklogHorizon, value: number, source: 'RECORD' | 'TYPED' | null = 'TYPED'): BacklogLine => ({
  orderId: uid('3485', Math.ceil(n / 2)),
  number: `DEMO-SO-03${String(Math.ceil(n / 2)).padStart(2, '0')}`,
  status: 'IN_PRODUCTION',
  lineId: uid('3486', n),
  seq: 10 * (1 + (n % 2)),
  customer,
  style: style,
  colourway: { code: 'NER', name: 'Nero' },
  size,
  open,
  promise,
  promiseSource: promise ? source : null,
  week,
  horizon,
  value,
  currency: 'EUR',
})
const LINES: BacklogLine[] = [
  line(1, C3, S2, '50', 30, '2026-10-30', '2026-W44', 'late', 435_000),
  line(2, C1, S1, '52', 40, '2026-11-06', '2026-W45', 'late', 720_000, 'RECORD'),
  line(3, C2, S2, '48', 25, '2026-11-11', '2026-W46', 'late', 362_500),
  line(4, C1, S1, '54', 60, '2026-11-13', '2026-W46', 'thisWeek', 1_080_000),
  line(5, C2, S3, '50', 12, '2026-11-20', '2026-W47', 'next4', 720_000),
  line(6, C1, S1, '50', 80, '2026-11-27', '2026-W48', 'next4', 1_440_000),
  line(7, C3, S3, '52', 18, '2026-12-04', '2026-W49', 'next4', 1_080_000, 'RECORD'),
  line(8, C2, S2, '52', 45, '2026-12-11', '2026-W50', 'next4', 652_500),
  line(9, C3, S1, null, 1, null, 'NONE', 'none', 180_000),
]
const backlogFigures = (rows: BacklogLine[]) => ({ orders: new Set(rows.map((row) => row.orderId)).size, lines: new Set(rows.map((row) => row.lineId)).size, pieces: rows.reduce((sum, row) => sum + row.open, 0), late: rows.reduce((sum, row) => sum + (row.horizon === 'late' ? row.open : 0), 0), ...money(rows.map((row) => ({ value: row.value ?? 0 }))) })
function backlogOf(by: 'customer' | 'style', rows: BacklogLine[] = LINES): Backlog {
  const keys = [...new Set(rows.map((row) => (by === 'customer' ? row.customer.id : row.style.id)))]
  const groups = keys
    .map((key) => {
      const own = rows.filter((row) => (by === 'customer' ? row.customer.id : row.style.id) === key)
      const named = by === 'customer' ? own[0]!.customer : own[0]!.style
      const horizons = { late: 0, thisWeek: 0, next4: 0, later: 0, none: 0 }
      for (const row of own) horizons[row.horizon] += row.open
      return { key, code: named.code, name: named.name, figures: backlogFigures(own), horizons }
    })
    .sort((a, b) => (b.figures.value ?? 0) - (a.figures.value ?? 0))
  return { company: COMPANY, today: TODAY, asOf: NOW, sight: SIGHT, by, companyCurrency: 'EUR', all: backlogFigures(rows), weeks: WEEKS.map((week) => ({ ...week, figures: backlogFigures(rows.filter((row) => row.week === week.key)) })), groups, more: 0, lines: rows, complete: true }
}
export const BACKLOG = backlogOf('customer')
const BACKLOG_BY_STYLE = backlogOf('style')

// ---- returns -----------------------------------------------------------------------------------------------------------------

const REASONS = {
  WRONG_SIZE: { it: 'Taglia sbagliata', en: 'Wrong size' },
  DEFECT: { it: 'Difetto', en: 'Defect' },
  DAMAGED_IN_TRANSIT: { it: 'Danneggiato nel trasporto', en: 'Damaged in transit' },
} as const
const rl = (n: number, rma: number, customer: typeof C1, style: typeof S1 | null, size: string | null, reason: keyof typeof REASONS, pieces: number, credited: number | null, requestedOn: string): ReturnLineRow => ({
  returnId: uid('3487', rma),
  number: `DEMO-RMA-00${rma}`,
  status: credited === null ? 'AUTHORISED' : 'INSPECTED',
  lineId: uid('3488', n),
  seq: 10 * n,
  requestedOn,
  reason,
  style,
  colour: style ? { code: 'NER', name: 'Nero' } : null,
  size,
  customer,
  pieces,
  credited,
  currency: 'EUR',
})
const RETURN_LINES: ReturnLineRow[] = [
  rl(1, 1, C2, S2, '48', 'WRONG_SIZE', 3, null, '2026-11-10'),
  rl(2, 1, C2, S2, '50', 'WRONG_SIZE', 2, null, '2026-11-10'),
  rl(3, 2, C1, S1, '52', 'DEFECT', 4, 72_000, '2026-11-06'),
  rl(4, 2, C1, S1, '54', 'WRONG_SIZE', 5, null, '2026-11-06'),
  rl(5, 3, C3, S3, '50', 'DAMAGED_IN_TRANSIT', 1, 60_000, '2026-11-03'),
  rl(6, 3, C3, null, null, 'DEFECT', 3, null, '2026-11-03'),
]
const returnFigures = (rows: ReturnLineRow[]) => ({ returns: new Set(rows.map((row) => row.returnId)).size, lines: rows.length, pieces: rows.reduce((sum, row) => sum + row.pieces, 0), ...money(rows.flatMap((row) => (typeof row.credited === 'number' ? [{ value: row.credited }] : []))) })
const groupBy = (rows: ReturnLineRow[], keyOf: (row: ReturnLineRow) => string, label: (row: ReturnLineRow) => { code: string | null; name: string | null }) =>
  [...new Set(rows.map(keyOf))].map((key) => {
    const own = rows.filter((row) => keyOf(row) === key)
    return { key, ...label(own[0]!), figures: returnFigures(own) }
  }).sort((a, b) => b.figures.pieces - a.figures.pieces)
function returnsOf(rows: ReturnLineRow[] = RETURN_LINES): Returns {
  const reasons = groupBy(rows, (row) => row.reason, () => ({ code: null, name: null })).map((group) => ({ key: group.key, words: REASONS[group.key as keyof typeof REASONS] ?? null, figures: group.figures }))
  const styles = groupBy(rows, (row) => row.style?.id ?? 'none', (row) => ({ code: row.style?.code ?? null, name: row.style?.name ?? null }))
  const heatStyles = styles.filter((group) => group.key !== 'none')
  const sizes = ['48', '50', '52', '54']
  return {
    ...head,
    sight: SIGHT,
    companyCurrency: 'EUR',
    all: returnFigures(rows),
    shipped: 1_120,
    returnRatePct: ((rows.reduce((sum, row) => sum + row.pieces, 0) / 1_120) * 100).toFixed(1),
    reasons,
    styles,
    colours: groupBy(rows, (row) => (row.style ? `${row.style.id}|NER` : 'none'), (row) => ({ code: row.colour?.code ?? null, name: row.colour ? `${row.style?.code} ${row.colour.name}` : null })),
    sizes: groupBy(rows, (row) => row.size ?? 'none', (row) => ({ code: row.size, name: null })),
    customers: groupBy(rows, (row) => row.customer.id, (row) => ({ code: row.customer.code, name: row.customer.name })),
    heatmap: {
      styles: heatStyles.map((group) => ({ key: group.key, code: group.code ?? '', name: group.name ?? '' })),
      sizes,
      cells: heatStyles.map((group) => sizes.map((size) => rows.filter((row) => row.style?.id === group.key && row.size === size).reduce((sum, row) => sum + row.pieces, 0) || null)),
    },
    lines: rows,
    complete: true,
  }
}
export const RETURNS = returnsOf()

// ---- the headline ------------------------------------------------------------------------------------------------------------

export const HEADLINE: Headline = {
  ...head,
  sight: SIGHT,
  companyCurrency: 'EUR',
  intake: INTAKE.all,
  backlog: BACKLOG.all,
  quotes: { answered: 9, medianAnswerMinutes: 380, fromInquiries: 4, accepted: 5, declined: 3, expired: 1, winRatePct: '62.5', medianDecisionHours: 70 },
  returns: { returns: RETURNS.all.returns, pieces: RETURNS.all.pieces, shipped: 1_120, returnRatePct: RETURNS.returnRatePct },
  complete: true,
}

// ---- the cases ---------------------------------------------------------------------------------------------------------------

const ready = <T>(value: T): Read<T> => ({ status: 'ready', value })
const loading = <T>(): Read<T> => ({ status: 'loading' })
const failed = <T>(): Read<T> => ({ status: 'error', problem: 'problem.read' })

export const SALES = [...rolePermissions('sales'), 'sales.reports.view', 'money.price']
const MANAGER = rolePermissions('production_manager').filter((name) => name !== 'money.price')
const specs = sectionSpecs((id) => id)

function model(over: Partial<ReportsModel> = {}, permissions: readonly string[] = SALES, search = ''): ReportsModel {
  return {
    prefix: PREFIX,
    can: reportsCan(permissions),
    address: reportsAddressOf(new URLSearchParams(search)),
    scope: SCOPE,
    range: { from: FROM, to: TO },
    today: TODAY,
    headline: ready(HEADLINE),
    intake: ready(INTAKE),
    backlog: ready(BACKLOG),
    returns: ready(RETURNS),
    live: 'live',
    asOf: NOW,
    layout: defaultSectionLayout(specs),
    specs,
    arranging: false,
    drill: null,
    ...over,
  }
}

function ReportsDesign({ model: value }: { model: ReportsModel }) {
  return inShell('/sales/reports', createElement(ReportsView, { model: value }), 'owner')
}

const noPrice = <T extends object>(value: T): T => ({ ...withoutValues(value), sight: { ...SIGHT, values: false } })
const blind: Headline = { ...HEADLINE, sight: { orders: false, quotes: true, returns: false, values: true }, intake: null, backlog: null, returns: null }
const emptyIntake: Intake = { ...INTAKE, all: { orders: 0, pieces: 0, ...money([]) }, buckets: INTAKE.buckets.map((bucket) => ({ ...bucket, figures: { orders: 0, pieces: 0, ...money([]) } })), orders: [] }
const halfLayout = { order: ['strip', 'intake', 'backlog', 'returns'], widths: { strip: 'full' as const, intake: 'full' as const, backlog: 'half' as const, returns: 'half' as const } }

export const designScreen = defineDesignScreen<ReportsModel>({
  screen: 'SCR-250',
  title: 'Sales reports (Sales)',
  view: ReportsDesign,
  holdsPage: true,
  cases: [
    { id: 'report', label: 'November so far (sales)', model: model(), note: 'The headline, the order intake by week, the backlog by promise week by customer, the return reasons with the most returned styles by size.' },
    { id: 'by-customer', label: 'Intake split by customer', model: model({ intake: ready(INTAKE_BY_CUSTOMER) }, SALES, 'split=customer') },
    { id: 'by-style', label: 'Intake split by style (fees apart)', model: model({ intake: ready(INTAKE_BY_STYLE) }, SALES, 'split=style') },
    { id: 'by-month-season', label: 'Intake by month, split by season', model: model({ intake: ready(INTAKE_BY_MONTH) }, SALES, 'by=month&split=season') },
    { id: 'backlog-style', label: 'Backlog table by style', model: model({ backlog: ready(BACKLOG_BY_STYLE) }, SALES, 'backlog=style') },
    { id: 'returns-customer', label: 'Returns also by customer', model: model({}, SALES, 'also=customer') },
    { id: 'drill-bucket', label: 'Orders behind a bar (week 46)', model: model({ drill: { section: 'intake', bucket: '2026-W46', group: null } }), note: 'Each order a link; J / K open the next and previous week; Open Orders searches the list as close as it can.' },
    { id: 'drill-group', label: 'Orders of one style', model: model({ intake: ready(INTAKE_BY_STYLE), drill: { section: 'intake', bucket: null, group: S1.id } }, SALES, 'split=style') },
    { id: 'drill-tile', label: 'The intake tile: every order booked', model: model({ drill: { section: 'intake', bucket: null, group: null } }) },
    { id: 'drill-week', label: 'Open sizes of a late week', model: model({ drill: { section: 'backlog', week: '2026-W45', group: null, horizon: null } }) },
    { id: 'drill-cell', label: 'One customer’s late sizes', model: model({ drill: { section: 'backlog', week: null, group: C1.id, horizon: 'late' } }) },
    { id: 'drill-reason', label: 'Return lines of one reason', model: model({ drill: { section: 'returns', by: 'reason', key: 'WRONG_SIZE' } }) },
    { id: 'drill-heat', label: 'Return lines of a heatmap cell', model: model({ drill: { section: 'returns', by: 'style', key: S1.id, size: '52' } }) },
    { id: 'no-price', label: 'Production manager (no price grain: pieces only)', model: model({ headline: ready(noPrice(HEADLINE)), intake: ready(noPrice(INTAKE)), backlog: ready(noPrice(BACKLOG)), returns: ready(noPrice(RETURNS)) }, MANAGER) },
    { id: 'outside', label: 'Orders and returns not in the role', model: model({ headline: ready(blind), intake: ready({ ...INTAKE, sight: blind.sight }), backlog: ready({ ...BACKLOG, sight: blind.sight }), returns: ready({ ...RETURNS, sight: blind.sight }) }), note: 'Each tile and panel says the records are not in the role; never 0.' },
    { id: 'loading', label: 'Loading (tile skeletons, chart frames)', model: model({ headline: loading(), intake: loading(), backlog: loading(), returns: loading(), asOf: null }) },
    { id: 'error', label: 'One panel failed, the others stand', model: model({ backlog: failed() }), note: 'The panel says what failed and Try again; a failed read is never drawn as empty.' },
    { id: 'empty', label: 'Nothing booked, nothing open, no returns', model: model({ intake: ready(emptyIntake), backlog: ready(backlogOf('customer', [])), returns: ready(returnsOf([])) }) },
    { id: 'arrange', label: 'Arrange panels', model: model({ arranging: true }) },
    { id: 'half-widths', label: 'Backlog and returns at half width', model: model({ layout: halfLayout }) },
    { id: 'keys', label: 'Keyboard shortcuts', model: model({ keysOpen: true }) },
    { id: 'offline', label: 'Offline (live off)', model: model({ live: 'offline' }) },
    { id: 'no-permission', label: 'No right (planner)', model: model({}, rolePermissions('planner')) },
  ],
})
