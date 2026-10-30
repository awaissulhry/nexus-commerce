import type { Tone } from '@nexus/ui/primitives'
import { isApiError, issuePath } from '../../../lib/api/errors'
import type { BundleRow, CutEntry, CutLog, WorkOrder, WorkOrderBundles } from '../_shared/api'
import { CUT_VIEWS, type CutRow, type CutState, type CutTiles, type CutView, type Replacement, type WorkOrderYield, type YieldFigures, type YieldHide } from './api'

/**
 * Production › Cutting room › Cutting (SCR-238; design production.cutting): the rules without a screen. What a person may
 * do (from the session's permissions; the API checks every call again), the page's address (`?view=` the saved filters,
 * `?q=`, `?new=1` New cut order, `?alloc=<work order>` Allocate hides), the tiles, the words of a cut's state, its area
 * per unit (never added across units), the cuts New cut order offers (waiting, the same material and colour), the record's
 * tabs, its pieces by part and size with the recuts, the yield per lot and supplier, the tickets and what holds a reprint
 * or a void, and a refused write in words. W2a has no cut order of its own: a cut is one work order's leather, cut by
 * hide at the cutting table (fabric lays, markers and grouped cut orders are W2b, MES-034/037). Words are message keys
 * of the `cutting` catalogue with their parameters; the views translate them. Never who cut: per work order, table, hide
 * and lot only (Statuto dei Lavoratori art. 4; SCM-255).
 */

export const CUTTING_NAMESPACE = 'cutting'

const ROME = 'Europe/Rome'

/** The instant the day of `now` began in Rome (the tiles' "today", as the API counts it). */
export function romeDayStart(now: Date): Date {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: ROME, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
  for (const hour of [-2, -1, 0, 1]) {
    const candidate = new Date(`${day}T00:00:00Z`)
    candidate.setUTCHours(hour)
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: ROME, hour: '2-digit', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(candidate)
    const of = (type: string) => parts.find((part) => part.type === type)?.value
    if (`${of('year')}-${of('month')}-${of('day')}` === day && of('hour') === '00') return candidate
  }
  return new Date(`${day}T00:00:00Z`)
}

export interface Phrase {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}
export const phrase = (key: string, params?: Phrase['params']): Phrase => (params ? { key, params } : { key })

// ---- who may do what ---------------------------------------------------------------------------------------------------------

export interface CuttingCan {
  /** production.cutting.view: the page, its tiles and the room's yield. */
  readonly view: boolean
  /** workorders.view: a cut's record (its cut log, yield and tickets are the work order's reads). */
  readonly workOrders: boolean
  /** inventory.reserve: Allocate hides (each hide reserved whole for the work order). */
  readonly reserve: boolean
  /** inventory.stock.view: the hides allocated, and the Find hides dialog's stock. */
  readonly stock: boolean
  /** production.scrap.view: the recuts on the Pieces tab. */
  readonly scrap: boolean
  /** production.scrap: a recut marked cut by its cut log entry. */
  readonly recut: boolean
  /** production.bundles: reprint and void a ticket. */
  readonly bundles: boolean
}

export function cuttingCanOf(permissions: readonly string[]): CuttingCan {
  const held = new Set(permissions)
  return {
    view: held.has('production.cutting.view'),
    workOrders: held.has('workorders.view'),
    reserve: held.has('inventory.reserve'),
    stock: held.has('inventory.stock.view'),
    scrap: held.has('production.scrap.view'),
    recut: held.has('production.scrap'),
    bundles: held.has('production.bundles'),
  }
}

// ---- the address -------------------------------------------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface CutAddress {
  readonly view: CutView
  readonly q: string
  /** New cut order is open. */
  readonly newCut: boolean
  /** Allocate hides is open for this work order. */
  readonly alloc: string | null
}

export function addressOf(params: { get(name: string): string | null } | null): CutAddress {
  const view = params?.get('view') ?? ''
  const alloc = params?.get('alloc') ?? ''
  return {
    view: (CUT_VIEWS as readonly string[]).includes(view) ? (view as CutView) : 'open',
    q: (params?.get('q') ?? '').trim().slice(0, 60),
    newCut: params?.get('new') === '1',
    alloc: UUID.test(alloc) ? alloc : null,
  }
}

export function addressText(address: CutAddress): string {
  const query = new URLSearchParams()
  if (address.view !== 'open') query.set('view', address.view)
  if (address.q.trim()) query.set('q', address.q.trim())
  if (address.newCut) query.set('new', '1')
  if (address.alloc) query.set('alloc', address.alloc)
  const text = query.toString()
  return text ? `?${text}` : ''
}

// ---- tiles ---------------------------------------------------------------------------------------------------------------------

export interface TileRule {
  readonly id: 'waiting' | 'cutting' | 'piecesToday' | 'areaToday' | 'yieldToday'
  /** The saved filter the tile sets; null: a figure of today, no filter. */
  readonly view: CutView | null
}
export const TILES: readonly TileRule[] = [
  { id: 'waiting', view: 'waiting' },
  { id: 'cutting', view: 'cutting' },
  { id: 'piecesToday', view: null },
  { id: 'areaToday', view: null },
  { id: 'yieldToday', view: null },
]

/** The tile's figure in words ("—" while unknown). */
export function tileValue(id: TileRule['id'], tiles: CutTiles | null, yieldToday: YieldFigures | null, locale: string): string {
  if (!tiles) return '—'
  if (id === 'waiting') return String(tiles.waiting)
  if (id === 'cutting') return String(tiles.cutting)
  if (id === 'piecesToday') return String(tiles.piecesToday)
  if (id === 'areaToday') return `${tiles.hidesToday} · ${areaNumber(tiles.areaTodayM2, locale)} m²`
  if (!yieldToday || yieldToday.yieldPct === null) return '—'
  return yieldToday.plannedPct === null ? percent(yieldToday.yieldPct, locale) : `${percent(yieldToday.yieldPct, locale)} / ${percent(yieldToday.plannedPct, locale)}`
}

// ---- numbers -------------------------------------------------------------------------------------------------------------------

/** An area with at most two decimals ("48,16"); "—" for nothing. */
export function areaNumber(value: string | null, locale: string): string {
  if (value === null) return '—'
  const number = Number(value)
  if (!Number.isFinite(number)) return '—'
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2, minimumFractionDigits: number % 1 === 0 ? 0 : 2 }).format(number)
}

export function percent(value: string | null, locale: string): string {
  if (value === null) return '—'
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(Number(value))} %`
}

const UNIT_WORDS: Readonly<Record<string, string>> = { FT2: 'ft²', M2: 'm²', DM2: 'dm²' }
export const unitWord = (uom: string): string => UNIT_WORDS[uom] ?? uom

/** The area used per unit, joined ("48,16 ft² · 2,1 m²"): areas of different units are never added. */
export function usedText(used: CutRow['hides']['used'], locale: string): string {
  return used.length === 0 ? '—' : used.map((part) => `${areaNumber(part.area, locale)} ${unitWord(part.uom)}`).join(' · ')
}

/** Yield against the plan: the tone of the variance (behind the plan by more than 2 points: warning; ahead: success). */
export function varianceTone(variancePct: string | null): Tone {
  if (variancePct === null) return 'neutral'
  const value = Number(variancePct)
  if (value < -2) return 'warning'
  if (value > 0) return 'success'
  return 'neutral'
}

// ---- a cut's state ---------------------------------------------------------------------------------------------------------------

export const STATE_TONE: Readonly<Record<CutState, Tone>> = { WAITING: 'neutral', CUTTING: 'info', CUT: 'success', HELD: 'warning' }

/** The material and colour of a cut, as one line ("SEED-LEA-100 · BLK"). */
export function materialLine(row: Pick<CutRow, 'materials'>): string {
  return row.materials.map((material) => [material.code, material.colourCode].filter(Boolean).join(' · ')).join(', ') || '—'
}

/** The shade lots (lot code and dye batch). */
export function lotLine(row: Pick<CutRow, 'lots'>): string {
  return row.lots.map((lot) => (lot.dyeBatch ? `${lot.code} (${lot.dyeBatch})` : lot.code)).join(', ') || '—'
}

/** The key New cut order groups by: one leather and colour (W2a: a cut is one work order; grouping several is W2b). */
export const materialKey = (row: Pick<CutRow, 'materials'>): string => row.materials.map((material) => `${material.itemId}|${material.colourCode ?? '-'}`).sort().join(',')

// ---- New cut order ------------------------------------------------------------------------------------------------------------

/** The cuts New cut order offers: released work orders with nothing cut yet and no hide allocated. */
export function newCutChoices(rows: readonly CutRow[]): CutRow[] {
  return rows.filter((row) => row.state === 'WAITING' && row.allocated === 0)
}

/**
 * Why a work order cannot be ticked in New cut order (else null): another material and colour than the first ticked
 * (one cut cuts one leather; a cut order of several work orders is W2b).
 */
export function newCutRowHeld(row: CutRow, picked: readonly CutRow[]): Phrase | null {
  const first = picked[0]
  if (first && first.workOrder.id !== row.workOrder.id && materialKey(first) !== materialKey(row)) return phrase('newCut.why.material', { material: materialLine(first) })
  return null
}

/** Why Create cut order is held (else null). */
export function newCutHeld(picked: readonly CutRow[], can: CuttingCan, busy: boolean): Phrase | null {
  if (!can.reserve) return phrase('held.permission', { permission: 'inventory.reserve' })
  if (busy) return phrase('held.busy')
  if (picked.length === 0) return phrase('newCut.held.none')
  if (picked.length > 1) return phrase('newCut.held.many')
  return null
}

// ---- Allocate hides ---------------------------------------------------------------------------------------------------------------

/** Why Allocate hides is held for a cut (else null). */
export function allocateHeld(row: Pick<CutRow, 'state' | 'workOrder'> | null, can: CuttingCan): Phrase | null {
  if (!can.reserve) return phrase('held.permission', { permission: 'inventory.reserve' })
  if (!can.stock) return phrase('held.permission', { permission: 'inventory.stock.view' })
  if (!row) return phrase('held.loading')
  if (row.state === 'CUT') return phrase('alloc.held.cut')
  if (row.workOrder.status === 'COMPLETED') return phrase('alloc.held.cut')
  return null
}

/** Why Print tickets is held (else null): it opens one cut's tickets. */
export function ticketsHeld(selected: number, can: CuttingCan): Phrase | null {
  if (!can.workOrders) return phrase('held.permission', { permission: 'workorders.view' })
  if (selected !== 1) return phrase('held.tickets.one')
  return null
}

// ---- the record ----------------------------------------------------------------------------------------------------------------------

export const RECORD_TABS = ['lay', 'pieces', 'yield', 'tickets'] as const
export type RecordTab = (typeof RECORD_TABS)[number]
export const tabOf = (value: string | null | undefined): RecordTab => ((RECORD_TABS as readonly string[]).includes(value ?? '') ? (value as RecordTab) : 'lay')

/** One part of a work order read on its own: its value, or the problem in words (a message key), or neither while loading. */
export interface Part<T> {
  readonly value: T | null
  readonly problem: string | null
}
export const loading = <T>(): Part<T> => ({ value: null, problem: null })

/** A read's problem as a message key: no right, gone, no answer, else a failed read. */
export function readProblem(error: unknown): string {
  if (!isApiError(error)) return 'problem.read'
  if (error.kind === 'forbidden' || error.kind === 'step_up') return 'problem.forbidden'
  if (error.kind === 'not_found') return 'problem.gone'
  if (error.kind === 'unavailable') return 'problem.offline'
  return 'problem.read'
}

const REFUSALS: Readonly<Record<string, string>> = {
  NOT_A_RECUT: 'problem.recut.notRecut',
  CUT_NOT_OF_CELL: 'problem.recut.notOfCell',
  WRONG_STATE: 'problem.recut.state',
  // The reservation's rules (B-W2a-11, a line's `body/lines/<i>/refusal/<CODE>`): Allocate hides.
  HIDE_RESERVED: 'problem.alloc.reserved',
  HIDE_NOT_IN_STOCK: 'problem.alloc.notInStock',
  LOT_HELD: 'problem.alloc.lotHeld',
  NOT_AVAILABLE: 'problem.alloc.hide',
  LOT_NOT_AVAILABLE: 'problem.alloc.hide',
}

/** A refused write in this app's words: the rule the API named (`refusal/<CODE>`, also a line's), else by its kind. */
export function writeProblem(error: unknown): Phrase {
  if (!isApiError(error)) return phrase('problem.write')
  for (const issue of error.issues) {
    const path = issuePath(issue)
    const code = /(?:^|\/)refusal\/([A-Z_]+)$/.exec(path)?.[1] ?? null
    if (code && REFUSALS[code]) return phrase(REFUSALS[code]!)
    if (/(?:^|\/|\.)lines[./]\d+[./]hideId$/.test(path)) return phrase('problem.alloc.hide')
  }
  if (error.kind === 'conflict') return phrase('problem.changed')
  if (error.kind === 'forbidden' || error.kind === 'step_up') return phrase('problem.forbidden')
  if (error.kind === 'not_found') return phrase('problem.gone')
  if (error.kind === 'invalid') return phrase('problem.invalid')
  if (error.kind === 'unavailable') return phrase('problem.offline')
  return phrase('problem.write')
}

// ---- Lay or hides: each hide's area -----------------------------------------------------------------------------------------------

export interface HideLine {
  readonly hideId: string
  readonly code: string
  readonly lotCode: string
  readonly grade: string | null
  readonly shade: string | null
  readonly state: CutLog['hides'][number]['state']
  readonly uom: string
  /** The hide's area at receipt (null: not cut yet, so not in the yield). */
  readonly areaIn: string | null
  readonly used: string
  readonly remnant: string | null
  readonly waste: string
  readonly wastePct: string | null
  /** The cut log's bar: cut + waste + returned + left = issued. */
  readonly bar: CutLog['hides'][number]
}

/** The hides of a cut: the cut log's bars, with the yield's grade, shade, area in and remnant where the hide was cut. */
export function hideLines(log: CutLog, figures: WorkOrderYield | null): HideLine[] {
  const yields = new Map((figures?.hides ?? []).map((row) => [row.hide.id, row]))
  return log.hides.map((hide) => {
    const row = yields.get(hide.hideId)
    return {
      hideId: hide.hideId,
      code: hide.code,
      lotCode: hide.lotCode,
      grade: row?.hide.grade ?? null,
      shade: row?.hide.shade ?? null,
      state: hide.state,
      uom: row?.item.uom ?? '',
      areaIn: row?.areaIn ?? null,
      used: hide.cut,
      remnant: row?.remnant ?? null,
      waste: hide.waste,
      wastePct: row?.wastePct ?? null,
      bar: hide,
    }
  })
}

// ---- Pieces: by part and size ---------------------------------------------------------------------------------------------------

export interface PieceCell {
  readonly cellId: string
  readonly planned: number
  readonly cut: number
  /** Pieces still to cut against the plan (never below 0). */
  readonly short: number
  /** Recuts asked and not cut yet, in pieces of this part (whole-garment recuts count one piece of every part). */
  readonly recut: number
}

export interface PieceRow {
  readonly part: string
  /** A part the BOM names (else a part logged by another name, a recut's). */
  readonly planned: boolean
  readonly cells: readonly PieceCell[]
}

/** The matrix part × size: planned (the cell's garments), cut, recut open, short; the BOM's parts first. */
export function piecesMatrix(log: CutLog, recuts: readonly Replacement[]): PieceRow[] {
  const parts: { part: string; planned: boolean }[] = []
  for (const cell of log.cells) for (const part of cell.parts) if (!parts.some((row) => row.part === part.part)) parts.push({ part: part.part, planned: part.planned })
  parts.sort((a, b) => (a.planned === b.planned ? 0 : a.planned ? -1 : 1))
  const open = recuts.filter((recut) => recut.status === 'OPEN')
  return parts.map(({ part, planned }) => ({
    part,
    planned,
    cells: log.cells.map((cell) => {
      const found = cell.parts.find((row) => row.part === part)
      const plannedPieces = found?.planned ? cell.quantity : 0
      const cut = found?.pieces ?? 0
      const recut = open.filter((row) => row.cell.id === cell.id && (row.part === null || row.part === part)).reduce((sum, row) => sum + row.quantity, 0)
      return { cellId: cell.id, planned: plannedPieces, cut, short: Math.max(0, plannedPieces - cut), recut }
    }),
  }))
}

/** The live entries a recut may be marked cut by: entries of its cell with pieces of its part (any part for whole garments). */
export function recutEntries(log: CutLog, recut: Replacement): CutEntry[] {
  return log.entries.filter((entry) => entry.live && !entry.reversalOfId && entry.pieces.some((piece) => piece.workOrderSizeId === recut.cell.id && (recut.part === null || piece.part === recut.part)))
}

/** Why "Mark cut" is held for a recut (else null). */
export function recutHeld(recut: Replacement, log: CutLog | null, can: CuttingCan, busy: boolean): Phrase | null {
  if (!can.recut) return phrase('held.permission', { permission: 'production.scrap' })
  if (recut.status !== 'OPEN') return phrase('held.recut.done')
  if (busy) return phrase('held.busy')
  if (!log) return phrase('held.loading')
  if (recutEntries(log, recut).length === 0) return phrase('held.recut.noEntry', { cell: `${recut.cell.colourwayCode} ${recut.cell.size}`, part: recut.part ?? '' })
  return null
}

// ---- Yield: per lot and supplier ------------------------------------------------------------------------------------------------

export interface LotYield {
  readonly lotId: string
  readonly lotCode: string
  readonly supplierLotRef: string | null
  readonly supplier: string | null
  readonly hides: number
  readonly uom: string
  readonly used: number
  readonly pattern: number
  readonly waste: number
  /** pattern / (used − unmatched) of the sums, two places; null when nothing counts. */
  readonly yieldPct: string | null
}

/** The work order's hides summed per lot: the areas added first, the percentage of the sums (never an average of percentages). */
export function lotYields(hides: readonly YieldHide[]): LotYield[] {
  const groups = new Map<string, YieldHide[]>()
  for (const hide of hides) groups.set(hide.lot.id, [...(groups.get(hide.lot.id) ?? []), hide])
  return [...groups.values()].map((rows) => {
    const first = rows[0]!
    const sum = (pick: (row: YieldHide) => string) => rows.reduce((total, row) => total + Number(pick(row)), 0)
    const counted = sum((row) => row.used) - sum((row) => row.unmatched)
    const pattern = sum((row) => row.pattern)
    return {
      lotId: first.lot.id,
      lotCode: first.lot.code,
      supplierLotRef: first.lot.supplierLotRef,
      supplier: first.supplier?.name ?? null,
      hides: rows.length,
      uom: first.item.uom,
      used: sum((row) => row.used),
      pattern,
      waste: sum((row) => row.waste),
      yieldPct: counted > 0 ? ((pattern * 100) / counted).toFixed(2) : null,
    }
  })
}

/** The chart's data: one bar per hide (its yield %), the planned line. */
export function yieldChart(figures: WorkOrderYield): Array<Record<string, number | string>> {
  return figures.hides.map((hide) => ({ hide: hide.hide.code, yieldPct: hide.yieldPct === null ? 0 : Number(hide.yieldPct), plannedPct: figures.overall.plannedPct === null ? 0 : Number(figures.overall.plannedPct) }))
}

// ---- Tickets ---------------------------------------------------------------------------------------------------------------------------

export type TicketState = 'QUEUED' | 'SENT' | 'PRINTED' | 'FAILED' | 'PDF' | 'UNKNOWN'

export interface TicketLine {
  readonly bundle: BundleRow
  /** The last print job's state; PDF: printed as a PDF label; UNKNOWN: no print.view. */
  readonly print: TicketState
  readonly reprints: number
}

export function ticketLines(bundles: WorkOrderBundles): TicketLine[] {
  return bundles.bundles.map((bundle) => {
    const last = bundle.tickets === null ? null : [...bundle.tickets].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0]
    return { bundle, print: bundle.tickets === null ? 'UNKNOWN' : last ? last.status : 'PDF', reprints: bundle.reprints.length }
  })
}

export const PRINT_TONE: Readonly<Record<TicketState, Tone>> = { QUEUED: 'info', SENT: 'info', PRINTED: 'success', FAILED: 'danger', PDF: 'neutral', UNKNOWN: 'neutral' }

/** Why Reprint is held (else null). */
export function reprintHeld(bundle: BundleRow, can: CuttingCan, busy: boolean): Phrase | null {
  if (!can.bundles) return phrase('held.permission', { permission: 'production.bundles' })
  if (bundle.status === 'VOID') return phrase('held.ticket.voided')
  if (busy) return phrase('held.busy')
  return null
}

/** Why Void is held (else null): only a bundle no operation scanned yet. */
export function voidHeld(bundle: BundleRow, can: CuttingCan, busy: boolean): Phrase | null {
  if (!can.bundles) return phrase('held.permission', { permission: 'production.bundles' })
  if (bundle.status === 'VOID') return phrase('held.ticket.voided')
  if (bundle.scans > 0) return phrase('held.ticket.scanned', { count: bundle.scans })
  if (busy) return phrase('held.busy')
  return null
}

/** A typed reason long enough for the API (3 to 200 characters). */
export const reasonOk = (value: string): boolean => value.trim().length >= 3 && value.trim().length <= 200

// ---- CSV ----------------------------------------------------------------------------------------------------------------------------

const cell = (value: string | number) => {
  const text = String(value)
  return /[",\n;]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/** Export N (CSV): the selected cuts as the columns show them (never who cut). */
export function csvOf(rows: readonly CutRow[], header: readonly string[], locale: string): string {
  const lines = rows.map((row) =>
    [
      row.workOrder.number,
      'LEATHER',
      row.style.code,
      materialLine(row),
      lotLine(row),
      row.state,
      row.pieces.planned,
      row.pieces.cut,
      row.hides.count,
      usedText(row.hides.used, locale),
      row.yield.yieldPct ?? '',
      row.yield.plannedPct ?? '',
      row.stations.map((station) => station.code).join(' '),
      row.lastCutAt ?? '',
    ]
      .map(cell)
      .join(','),
  )
  return [header.map(cell).join(','), ...lines].join('\n')
}

// ---- a cut from its work order (the record) ---------------------------------------------------------------------------------------

/** Where a cut stands — the API's rule (cutting/office.ts cutStateOf): held, cut, waiting, else cutting. */
export function cutStateOf(status: string, cells: readonly { readonly toCut: number | null }[], liveEntries: number): CutState {
  if (status === 'ON_HOLD') return 'HELD'
  const counted = cells.filter((cell) => cell.toCut !== null)
  if (status === 'COMPLETED' || (counted.length > 0 && counted.every((cell) => cell.toCut === 0))) return 'CUT'
  return liveEntries === 0 ? 'WAITING' : 'CUTTING'
}

const AREA_UNITS = new Set(['FT2', 'M2', 'DM2'])

/**
 * The record's cut, built from the work order, its cut log and its yield (the list's row, for the record's band and
 * its Allocate hides): the leathers are the frozen materials counted in an area.
 */
export function cutOf(workOrder: WorkOrder, log: CutLog | null, figures: WorkOrderYield | null, allocated: number): CutRow {
  const live = log ? log.entries.filter((entry) => entry.live && !entry.reversalOfId) : []
  const counted = (log?.cells ?? []).filter((cell) => cell.cut !== null)
  const planned = counted.reduce((sum, cell) => sum + cell.quantity, 0)
  const cut = counted.reduce((sum, cell) => sum + (cell.cut ?? 0), 0)
  const lots = new Map<string, { id: string; code: string; dyeBatch: string | null }>()
  for (const hide of figures?.hides ?? []) lots.set(hide.lot.id, { id: hide.lot.id, code: hide.lot.code, dyeBatch: null })
  const used = new Map<string, number>()
  for (const hide of figures?.hides ?? []) used.set(hide.item.uom, (used.get(hide.item.uom) ?? 0) + Number(hide.used))
  const stations = new Map<string, { id: string; code: string }>()
  for (const entry of live) if (entry.station) stations.set(entry.station.id, { id: entry.station.id, code: entry.station.code })
  const last = (log?.entries ?? []).reduce<string | null>((latest, entry) => (latest === null || entry.serverTime > latest ? entry.serverTime : latest), null)
  return {
    workOrder: {
      id: workOrder.id,
      number: workOrder.number,
      batchNumber: workOrder.batchNumber,
      status: workOrder.status,
      companyId: workOrder.companyId,
      siteId: workOrder.siteId,
      dueDate: workOrder.dueDate,
      priority: workOrder.priority,
      holdReason: workOrder.status === 'ON_HOLD' ? (workOrder.hold?.reason ?? null) : null,
    },
    style: { id: workOrder.style.id, code: workOrder.style.code, name: workOrder.style.name },
    kind: 'LEATHER',
    state: cutStateOf(workOrder.status, log?.cells ?? [], live.length),
    materials: workOrder.spec.materials.filter((material) => AREA_UNITS.has(material.baseUom)).map((material) => ({ itemId: material.itemId, itemColourId: material.itemColourId, code: material.itemCode, name: material.itemName, baseUom: material.baseUom, colourCode: material.colourCode })),
    lots: [...lots.values()],
    garments: { planned, cut, toCut: Math.max(0, planned - cut) },
    pieces: {
      planned: (log?.cells ?? []).reduce((sum, cell) => sum + cell.quantity * cell.parts.filter((part) => part.planned).length, 0),
      cut: (log?.cells ?? []).reduce((sum, cell) => sum + cell.parts.reduce((total, part) => total + part.pieces, 0), 0),
    },
    hides: { count: figures?.hides.length ?? 0, used: [...used.entries()].map(([uom, area]) => ({ uom, area: area.toFixed(4) })) },
    allocated,
    yield: { yieldPct: figures?.overall.yieldPct ?? null, plannedPct: figures?.overall.plannedPct ?? null, variancePct: figures?.overall.variancePct ?? null, plannedSource: figures?.plannedSource ?? 'BOM' },
    stations: [...stations.values()],
    lastCutAt: last,
    recutsOpen: 0,
  }
}
