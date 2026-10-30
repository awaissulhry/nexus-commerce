import type { Tone } from '@nexus/ui/primitives'
import { isApiError, issuePath } from '../../../lib/api/errors'
import type { Replacement } from '../cutting/api'
import type { ReplacementAsk, ScrapKind, ScrapRow, ScrapTiles } from './api'

/**
 * Production › Floor control › Scrap & rework (SCR-140; design production.scrap): the rules without a screen. What a
 * person may do (the session's permissions; the API checks every call again), the page's address (`?view=` the tiles'
 * saved filters, `?period=` days back, `?kind=`, `?by=` the pareto's dimension, `?group=` a bar's filter, `?q=`,
 * `?open=<row>` the row's detail, `?replace=<row>` Replace scrapped quantity), the filters over the rows read, the
 * pareto (bars per reason, operation or style with the cumulative line), what Approve reaches, why a replacement or a
 * decision is held, and a refused write in words. Values only with the cost grain. Per work order, bundle, operation
 * and station: never a person (Statuto dei Lavoratori art. 4). "Second quality" (downgrade, MES-133) is W2b.
 */

export const SCRAP_NAMESPACE = 'scrap'

export interface Phrase {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}
export const phrase = (key: string, params?: Phrase['params']): Phrase => (params ? { key, params } : { key })

// ---- who may do what ---------------------------------------------------------------------------------------------------------

export interface ScrapCan {
  /** production.scrap.view: the page. */
  readonly view: boolean
  /** production.scrap: ask a recut or a lower quantity. */
  readonly ask: boolean
  /** production.scrap.approve: approve or refuse a lower quantity (never one's own). */
  readonly approve: boolean
  /** money.cost: the value column and the value in the detail. */
  readonly cost: boolean
  /** workorders.view: the work order a row names opens. */
  readonly workOrders: boolean
  /** production.cutting.view: the recut list of the Cutting page. */
  readonly cutting: boolean
}

export function scrapCanOf(permissions: readonly string[]): ScrapCan {
  const held = new Set(permissions)
  return {
    view: held.has('production.scrap.view'),
    ask: held.has('production.scrap'),
    approve: held.has('production.scrap.approve'),
    cost: held.has('money.cost'),
    workOrders: held.has('workorders.view'),
    cutting: held.has('production.cutting.view'),
  }
}

// ---- the address ---------------------------------------------------------------------------------------------------------------

export const SCRAP_VIEWS = ['all', 'today', 'rework', 'approve', 'recuts'] as const
export type ScrapView = (typeof SCRAP_VIEWS)[number]
export const PERIODS = ['7', '30', '90', 'all'] as const
export type Period = (typeof PERIODS)[number]
export const DIMENSIONS = ['reason', 'operation', 'style'] as const
export type Dimension = (typeof DIMENSIONS)[number]

export interface ScrapAddress {
  readonly view: ScrapView
  readonly period: Period
  readonly kind: ScrapKind | null
  readonly by: Dimension
  /** A pareto bar's key (in the `by` dimension). */
  readonly group: string | null
  readonly q: string
  readonly open: string | null
  readonly replace: string | null
}

const pick = <T extends string>(values: readonly T[], value: string | null | undefined, fallback: T): T => ((values as readonly string[]).includes(value ?? '') ? (value as T) : fallback)
const rowId = (value: string | null | undefined) => (value && /^[a-z-]+:[0-9a-f-]{36}(:[A-Z0-9_]{1,40})?$/i.test(value) ? value : null)

export function addressOf(params: { get(name: string): string | null } | null): ScrapAddress {
  const kind = params?.get('kind') ?? ''
  const group = (params?.get('group') ?? '').trim()
  return {
    view: pick(SCRAP_VIEWS, params?.get('view'), 'all'),
    period: pick(PERIODS, params?.get('period'), '30'),
    kind: kind === 'SCRAP' || kind === 'REWORK' ? kind : null,
    by: pick(DIMENSIONS, params?.get('by'), 'reason'),
    group: group ? group.slice(0, 80) : null,
    q: (params?.get('q') ?? '').trim().slice(0, 60),
    open: rowId(params?.get('open')),
    replace: rowId(params?.get('replace')),
  }
}

export function addressText(address: ScrapAddress): string {
  const query = new URLSearchParams()
  if (address.view !== 'all') query.set('view', address.view)
  if (address.period !== '30') query.set('period', address.period)
  if (address.kind) query.set('kind', address.kind)
  if (address.by !== 'reason') query.set('by', address.by)
  if (address.group) query.set('group', address.group)
  if (address.q.trim()) query.set('q', address.q.trim())
  if (address.open) query.set('open', address.open)
  if (address.replace) query.set('replace', address.replace)
  const text = query.toString()
  return text ? `?${text}` : ''
}

/** The instant the period starts (null: all), counted back from `now` in whole days. */
export function periodFrom(period: Period, now: number): string | null {
  return period === 'all' ? null : new Date(now - Number(period) * 24 * 60 * 60 * 1000).toISOString()
}

// ---- tiles -----------------------------------------------------------------------------------------------------------------------

export interface TileRule {
  readonly id: 'scrapToday' | 'reworkOpen' | 'toApprove' | 'recuts' | 'downgraded'
  /** The saved filter it sets; null: W2b (downgrade to second quality, MES-133). */
  readonly view: ScrapView | null
}
export const TILES: readonly TileRule[] = [
  { id: 'scrapToday', view: 'today' },
  { id: 'reworkOpen', view: 'rework' },
  { id: 'toApprove', view: 'approve' },
  { id: 'recuts', view: 'recuts' },
  { id: 'downgraded', view: null },
]

export function tileValue(id: TileRule['id'], tiles: ScrapTiles | null): string {
  if (!tiles || id === 'downgraded') return '—'
  if (id === 'scrapToday') return String(tiles.scrapToday)
  if (id === 'reworkOpen') return String(tiles.reworkOpen)
  if (id === 'toApprove') return String(tiles.reductionsToApprove)
  return String(tiles.recutsToCut)
}

// ---- rows ---------------------------------------------------------------------------------------------------------------------------

/** The reason in the person's language ("Macchia" / "Stain"), else its code. */
export const reasonWord = (row: Pick<ScrapRow, 'reasonCode' | 'reasonLabel'>, locale: string): string => (row.reasonLabel ? (locale === 'it' ? row.reasonLabel.it : row.reasonLabel.en) : row.reasonCode)

/** The pareto key of a row in a dimension, with its label. */
export function groupOf(row: ScrapRow, by: Dimension, locale: string): { key: string; label: string } {
  if (by === 'operation') return row.operation ? { key: row.operation.code, label: `${row.operation.seq} · ${row.operation.name}` } : { key: '-', label: '—' }
  if (by === 'style') return row.workOrder.style ? { key: row.workOrder.style.id, label: row.workOrder.style.code } : { key: '-', label: '—' }
  return { key: row.reasonCode, label: reasonWord(row, locale) }
}

const openReplacement = (row: ScrapRow, kind: 'RECUT' | 'REDUCE') => row.replacements.some((replacement) => replacement.kind === kind && replacement.status === 'OPEN')

/** The rows of the address's filters (the saved view, the kind, a pareto bar, the search), newest first. */
export function filterRows(rows: readonly ScrapRow[], address: ScrapAddress, todayStart: number, locale: string, options: { withGroup: boolean } = { withGroup: true }): ScrapRow[] {
  const q = address.q.trim().toLowerCase()
  return rows.filter((row) => {
    if (address.view === 'today' && (row.kind !== 'SCRAP' || Date.parse(row.at) < todayStart)) return false
    if (address.view === 'rework' && (row.kind !== 'REWORK' || (row.status !== 'OPEN' && row.status !== 'IN_PROGRESS'))) return false
    if (address.view === 'approve' && !openReplacement(row, 'REDUCE')) return false
    if (address.view === 'recuts' && !openReplacement(row, 'RECUT')) return false
    if (address.kind && row.kind !== address.kind) return false
    if (options.withGroup && address.group && groupOf(row, address.by, locale).key !== address.group) return false
    if (q) {
      const text = [row.workOrder.number, row.bundle?.code ?? '', row.reasonCode, reasonWord(row, locale), row.operation?.code ?? '', row.operation?.name ?? '', row.workOrder.style?.code ?? '', ...row.materials.flatMap((material) => [material.lotCode, material.hideCode])].join(' ').toLowerCase()
      if (!text.includes(q)) return false
    }
    return true
  })
}

export interface ParetoBar {
  readonly key: string
  readonly label: string
  readonly pieces: number
  /** The bars up to this one, as a share of every piece (whole percent). */
  readonly cumulative: number
}

/** The pareto: pieces per group, largest first, the first `top` and "other" for the rest; the cumulative share. */
export function pareto(rows: readonly ScrapRow[], by: Dimension, locale: string, top = 8): ParetoBar[] {
  const groups = new Map<string, { label: string; pieces: number }>()
  for (const row of rows) {
    const group = groupOf(row, by, locale)
    const entry = groups.get(group.key) ?? { label: group.label, pieces: 0 }
    entry.pieces += row.pieces
    groups.set(group.key, entry)
  }
  const sorted = [...groups.entries()].map(([key, entry]) => ({ key, ...entry })).sort((a, b) => b.pieces - a.pieces || a.label.localeCompare(b.label))
  const head = sorted.slice(0, top)
  const rest = sorted.slice(top).reduce((sum, entry) => sum + entry.pieces, 0)
  const bars = rest > 0 ? [...head, { key: '', label: '', pieces: rest }] : head
  const total = bars.reduce((sum, entry) => sum + entry.pieces, 0)
  let running = 0
  return bars.map((entry) => {
    running += entry.pieces
    return { key: entry.key, label: entry.label, pieces: entry.pieces, cumulative: total > 0 ? Math.round((running / total) * 100) : 0 }
  })
}

export const KIND_TONE: Readonly<Record<ScrapKind, Tone>> = { SCRAP: 'danger', REWORK: 'warning' }
export const REPLACEMENT_TONE: Readonly<Record<string, Tone>> = { OPEN: 'info', APPROVED: 'success', REFUSED: 'neutral', DONE: 'success', CANCELLED: 'neutral' }

/** Leather the row held, per lot and hide ("SEED-LOT-1 / HD-1 3,33 ft²"). */
export function materialsText(row: ScrapRow, locale: string): string {
  if (row.materials.length === 0) return '—'
  const format = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 })
  return row.materials.map((material) => `${material.lotCode} / ${material.hideCode} ${format.format(Number(material.area))} ${UNIT_WORDS[material.uom] ?? material.uom}`).join(' · ')
}
const UNIT_WORDS: Readonly<Record<string, string>> = { FT2: 'ft²', M2: 'm²', DM2: 'dm²' }

/** A value in minor units of its currency ("€ 14,00"); "—" when unknown. */
export function moneyText(value: number | null | undefined, currency: string | null | undefined, locale: string): string {
  if (value === null || value === undefined || !currency) return '—'
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(value / 100)
}

// ---- approve (lower quantities) ----------------------------------------------------------------------------------------------------

/** The row's lower-quantity request waiting for a decision, with its version and who asked (from the open list). */
export function reductionOf(row: ScrapRow, open: readonly Replacement[]): Replacement | null {
  const ids = row.replacements.filter((replacement) => replacement.kind === 'REDUCE' && replacement.status === 'OPEN').map((replacement) => replacement.id)
  return open.find((replacement) => ids.includes(replacement.id)) ?? null
}

/** Why this person may not decide this lower quantity (else null): no right, the asker, not read yet. */
export function decideHeld(reduction: Replacement | null, can: ScrapCan, me: string, busy: boolean): Phrase | null {
  if (!can.approve) return phrase('held.permission', { permission: 'production.scrap.approve' })
  if (!reduction) return phrase('held.noReduction')
  if (reduction.createdBy?.id === me) return phrase('held.ownAsk')
  if (busy) return phrase('held.busy')
  return null
}

/** The selected rows Approve N reaches: an open lower quantity someone else asked. */
export function approvable(rows: readonly ScrapRow[], open: readonly Replacement[], can: ScrapCan, me: string): Replacement[] {
  return rows.flatMap((row) => {
    const reduction = reductionOf(row, open)
    return reduction && decideHeld(reduction, can, me, false) === null ? [reduction] : []
  })
}

// ---- Replace scrapped quantity --------------------------------------------------------------------------------------------------

/** Garments of the row still to replace: its pieces less what open, approved or done replacements already cover. */
export function leftToReplace(row: ScrapRow): number {
  const covered = row.replacements.filter((replacement) => replacement.status !== 'REFUSED' && replacement.status !== 'CANCELLED').reduce((sum, replacement) => sum + replacement.quantity, 0)
  return Math.max(0, row.pieces - covered)
}

export interface ReplaceDraft {
  readonly kind: 'RECUT' | 'REDUCE'
  readonly quantity: string
  readonly reason: string
}

/** Why Ask is held (else null). */
export function replaceHeld(row: ScrapRow | null, draft: ReplaceDraft, can: ScrapCan, busy: boolean): Phrase | null {
  if (!can.ask) return phrase('held.permission', { permission: 'production.scrap' })
  if (!row) return phrase('held.loading')
  if (row.kind !== 'SCRAP') return phrase('replace.held.rework')
  if (row.workOrder.status !== 'RELEASED' && row.workOrder.status !== 'IN_PROGRESS') return phrase('replace.held.notOpen', { number: row.workOrder.number, status: row.workOrder.status })
  const left = leftToReplace(row)
  if (left === 0) return phrase('replace.held.covered')
  const quantity = Number(draft.quantity)
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > left) return phrase('replace.held.quantity', { max: left })
  if (draft.reason.trim().length < 3) return phrase('held.reason')
  if (busy) return phrase('held.busy')
  return null
}

/** The request Ask sends: from the row's source (a scan's scrap or a finished rework's). */
export function replaceBody(row: ScrapRow, draft: ReplaceDraft): ReplacementAsk {
  return {
    kind: draft.kind,
    quantity: Number(draft.quantity),
    reason: draft.reason.trim(),
    part: draft.kind === 'RECUT' ? row.part : null,
    ...(row.source.type === 'SCAN' ? { sourceScanId: row.source.id } : { reworkOrderId: row.source.id }),
  }
}

// ---- refusals ---------------------------------------------------------------------------------------------------------------------

const REFUSALS: Readonly<Record<string, string>> = {
  WORK_ORDER_NOT_OPEN: 'problem.notOpen',
  MORE_THAN_SCRAPPED: 'problem.moreThanScrapped',
  MORE_THAN_CELL: 'problem.moreThanCell',
  NO_SCRAP: 'problem.noScrap',
  NOT_A_PART: 'problem.notAPart',
  SELF_DECISION: 'problem.selfDecision',
  WRONG_STATE: 'problem.wrongState',
  NOT_A_REDUCE: 'problem.wrongState',
}

export function readProblem(error: unknown): string {
  if (!isApiError(error)) return 'problem.read'
  if (error.kind === 'forbidden' || error.kind === 'step_up') return 'problem.forbidden'
  if (error.kind === 'not_found') return 'problem.gone'
  if (error.kind === 'unavailable') return 'problem.offline'
  return 'problem.read'
}

/** A refused write in this app's words: the rule the API named (`refusal/<CODE>`), else by its kind. */
export function writeProblem(error: unknown): Phrase {
  if (!isApiError(error)) return phrase('problem.write')
  for (const issue of error.issues) {
    const path = issuePath(issue)
    const code = /(?:^|\/)refusal\/([A-Z_]+)$/.exec(path)?.[1] ?? null
    if (code && REFUSALS[code]) return phrase(REFUSALS[code]!)
  }
  if (error.kind === 'conflict') return phrase('problem.changed')
  if (error.kind === 'forbidden' || error.kind === 'step_up') return phrase('problem.forbidden')
  if (error.kind === 'not_found') return phrase('problem.gone')
  if (error.kind === 'invalid') return phrase('problem.invalid')
  if (error.kind === 'unavailable') return phrase('problem.offline')
  return phrase('problem.write')
}

// ---- CSV --------------------------------------------------------------------------------------------------------------------------

const cell = (value: string | number) => {
  const text = String(value)
  return /[",\n;]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export function csvOf(rows: readonly ScrapRow[], header: readonly string[], locale: string, withCost: boolean): string {
  const lines = rows.map((row) =>
    [
      row.at,
      row.workOrder.number,
      row.bundle?.code ?? '',
      row.operation ? `${row.operation.seq} ${row.operation.code}` : '',
      `${row.cell.colourwayCode} ${row.cell.size}`,
      row.part ?? '',
      row.pieces,
      row.kind,
      reasonWord(row, locale),
      materialsText(row, 'en'),
      row.replacements.map((replacement) => `${replacement.kind} ${replacement.quantity} ${replacement.status}`).join(' · '),
      row.station?.code ?? '',
      ...(withCost ? [row.value === null || row.value === undefined ? '' : (row.value / 100).toFixed(2), row.currency ?? ''] : []),
    ]
      .map(cell)
      .join(','),
  )
  return [header.map(cell).join(','), ...lines].join('\n')
}
