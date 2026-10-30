import type { PickerReason } from '../../../_shared/reasons/api'
import { wordsIn } from '../../../_shared/reasons/model'
import type { StepUpState } from '../../../quality/_shared/hooks'
import type { BundleRow, PickList, ReadinessWord, WorkOrder, WorkOrderBundles, WorkOrderStatus, WorkOrderWip } from '../../_shared/api'
import type { Phrase } from '../../_shared/model'
import type { Availability, Finished, Hold, HoldRecord, ReadinessRow, ScrapRow, SplitReason, Yield } from './api'

/**
 * The work order every day (B-W2a-46), pure: who may do the W2a parts, why a button waits (held with its reason, in this
 * app's words: never the API's English), and how the parts read — the readiness word, holds, report finished to stock,
 * yield, scrap and rework grouped by operation and reason, the hides a reserve may take, the operation flow with the pile
 * waiting before each operation, and the pick list and cutting list to print. No money (no grain is read), no worker.
 * Words are keys of `messages/<locale>/production-work-orders.json` (DAILY_NAMESPACE).
 */

export const DAILY_NAMESPACE = 'production-work-orders'

/** A part a tab reads (null value while it loads; a problem when the read failed: never drawn as empty). */
export interface Part<T> {
  value: T | null
  problem: string | null
}
export const LOADING = { value: null, problem: null } as const
const phrase = (key: string, params?: Phrase['params']): Phrase => (params ? { key, params } : { key })

// ---- who may do what -------------------------------------------------------------------------------------------------------------

export interface DailyCan {
  /** quality.holds.view: the holds of the work order and of its bundles. */
  readonly holdsView: boolean
  /** quality.holds.place: Put on hold. */
  readonly holdsPlace: boolean
  /** quality.holds.release (+ the office's step-up): Release the hold. */
  readonly holdsRelease: boolean
  /** production.finish: Report finished to stock. */
  readonly finish: boolean
  /** inventory.stock.view: the hides a reserve may take. */
  readonly stockView: boolean
  /** inventory.reserve: Reserve leather. */
  readonly reserve: boolean
  /** production.scrap.view: scrap and rework of the work order. */
  readonly scrapView: boolean
  /** production.bundles: split a bundle. */
  readonly bundles: boolean
  /** workorders.view: the list's readiness word, the yield, finished to stock. */
  readonly view: boolean
}

export function dailyCan(permissions: readonly string[]): DailyCan {
  const held = new Set(permissions)
  return {
    holdsView: held.has('quality.holds.view'),
    holdsPlace: held.has('quality.holds.place'),
    holdsRelease: held.has('quality.holds.release'),
    finish: held.has('production.finish'),
    stockView: held.has('inventory.stock.view'),
    reserve: held.has('inventory.reserve') && held.has('inventory.stock.view'),
    scrapView: held.has('production.scrap.view'),
    bundles: held.has('production.bundles'),
    view: held.has('workorders.view'),
  }
}

/** A DRAFT, or a DRAFT put on hold: nothing is frozen yet, its release check is what the record shows. */
export const beforeRelease = (workOrder: Pick<WorkOrder, 'status' | 'hold'>): boolean => workOrder.status === 'DRAFT' || (workOrder.status === 'ON_HOLD' && workOrder.hold?.fromStatus === 'DRAFT')

// ---- the readiness word ------------------------------------------------------------------------------------------------------------

export type Tone = 'success' | 'info' | 'warning' | 'danger' | 'neutral'

export const READINESS_TONE: Readonly<Record<ReadinessWord, Tone>> = Object.freeze({
  NOT_ENOUGH: 'danger',
  DELAYED: 'danger',
  REQUESTED: 'warning',
  EXPECTED: 'info',
  NOT_BOOKED: 'warning',
  RECEIVED: 'success',
  NOT_PLANNED: 'neutral',
})

/** The word in this app's words ("Expected 12 Nov" with the date said by the page). */
export function readinessPhrase(word: ReadinessWord, date: string | null): Phrase {
  return word === 'EXPECTED' && date ? phrase('readiness.EXPECTED_on', { date }) : phrase(`readiness.${word}`)
}

/** Work orders the readiness word means something for (open ones; a repair plans no material). */
export const READINESS_STATUSES: readonly WorkOrderStatus[] = Object.freeze(['DRAFT', 'RELEASED', 'IN_PROGRESS', 'ON_HOLD'])

/** One material's word on the Materials tab (from the release check's readiness for a draft, else the list read). */
export function materialWord(readiness: ReadinessRow | null, itemId: string, itemColourId: string | null): { word: ReadinessWord; date: string | null } | null {
  const row = readiness?.materials.find((entry) => entry.itemId === itemId && (entry.itemColourId ?? null) === (itemColourId ?? null))
  return row ? { word: row.word, date: row.date } : null
}

export interface ReadinessView {
  readonly word: ReadinessWord
  readonly date: string | null
  readonly materials: ReadonlyArray<{ readonly itemId: string; readonly itemColourId: string | null; readonly label: string; readonly word: ReadinessWord; readonly date: string | null; readonly short: string; readonly uom: string }>
}

/** The readiness the record shows: a draft's from its release check, a released one's from the list read (labels from its spec). */
export function readinessView(workOrder: Pick<WorkOrder, 'status' | 'spec'>, check: { readonly readiness?: ReadinessView | null } | null, row: ReadinessRow | null): ReadinessView | null {
  if (check?.readiness) return check.readiness
  if (!row) return null
  const labelOf = (itemId: string, itemColourId: string | null) => {
    const material = workOrder.spec.materials.find((entry) => entry.itemId === itemId && (entry.itemColourId ?? null) === (itemColourId ?? null))
    return material ? { label: [material.itemCode, material.colourCode].filter(Boolean).join(' '), uom: material.baseUom } : { label: '—', uom: '' }
  }
  return { word: row.word, date: row.date, materials: row.materials.map((material) => ({ itemId: material.itemId, itemColourId: material.itemColourId, ...labelOf(material.itemId, material.itemColourId), word: material.word, date: material.date, short: '0' })) }
}

// ---- holds ---------------------------------------------------------------------------------------------------------------------------

export const HOLDABLE: readonly WorkOrderStatus[] = Object.freeze(['DRAFT', 'RELEASED', 'IN_PROGRESS'])

/** Why "Put on hold" waits for one work order, or null. */
export function holdHeld(workOrder: Pick<WorkOrder, 'status'>, can: DailyCan, busy = false): Phrase | null {
  if (!can.holdsPlace) return phrase('held.noHoldPlace')
  if (workOrder.status === 'ON_HOLD') return phrase('held.alreadyHeld')
  if (!HOLDABLE.includes(workOrder.status)) return phrase('held.notOpen', { status: `status.${workOrder.status}` })
  if (busy) return phrase('held.busy')
  return null
}

/** "Hold N": the rows the bulk action may take (open, not held) and why it waits. */
export function bulkHoldHeld(rows: ReadonlyArray<{ status: WorkOrderStatus }>, can: DailyCan): Phrase | null {
  if (!can.holdsPlace) return phrase('held.noHoldPlace')
  const not = rows.filter((row) => !HOLDABLE.includes(row.status)).length
  if (not > 0) return phrase('held.bulkNotOpen', { count: not })
  return null
}

/** Why "Put on hold" in the dialog waits: a reason, the note a reason asks for, and a short note. */
export function placeHeld(reasonCode: string, note: string, reasons: readonly PickerReason[] | null, busy: boolean): Phrase | null {
  if (busy) return phrase('held.busy')
  if (!reasons) return phrase('hold.held.reasons')
  const reason = reasons.find((entry) => entry.code === reasonCode)
  if (!reason) return phrase('hold.held.reason')
  if (reason.needsDetail && note.trim().length < 3) return phrase('hold.held.note')
  if (note.length > 500) return phrase('hold.held.noteLong')
  return null
}

/** A HOLD reason in the person's language (else its code). */
export function holdReasonWords(code: string, reasons: readonly PickerReason[] | null, locale: string): string {
  const reason = reasons?.find((entry) => entry.code === code)
  return reason ? wordsIn(reason, locale) : code
}

/** Why "Release the hold" waits, or null (quality.holds.release; the API's checks: placer, maker, results). */
export function releaseHoldHeld(record: HoldRecord | null, can: DailyCan, statement: boolean, needsStatement: boolean, busy: boolean): Phrase | null {
  if (!can.holdsRelease) return phrase('held.noHoldRelease')
  if (!record) return phrase('held.loading')
  if (record.hold.status !== 'ACTIVE') return phrase('held.holdNotActive')
  if (!record.release.mayRelease) return phrase('held.notPlacer')
  if (needsStatement && !statement) return phrase('releaseHold.held.statement')
  const open = record.release.checks.filter((check) => !check.ok && check.key !== 'STATEMENT')
  if (open.length > 0) return phrase('releaseHold.held.checks', { count: open.length })
  if (busy) return phrase('held.busy')
  return null
}

/** The release checks in this app's words (by their key; the API's sentence is never drawn). */
export function releaseCheckPhrase(key: string, ok: boolean): Phrase {
  return phrase(`releaseHold.check.${key}.${ok ? 'ok' : 'open'}`)
}

/** The bundles under an ACTIVE hold of their own (the Bundles tab's "On hold" column). */
export function bundlesOnHold(holds: readonly Hold[] | null): ReadonlySet<string> {
  return new Set((holds ?? []).filter((hold) => hold.status === 'ACTIVE' && hold.subjectType === 'Bundle').flatMap((hold) => hold.subjects.map((subject) => subject.id)))
}

// ---- report finished to stock ----------------------------------------------------------------------------------------------------

export const FINISHABLE: readonly WorkOrderStatus[] = Object.freeze(['RELEASED', 'IN_PROGRESS', 'COMPLETED'])

/** Why "Report finished to stock" waits on the record, in this app's words (from the work order and the numbers). */
export function finishHeld(workOrder: Pick<WorkOrder, 'status' | 'kind'>, finished: Finished | null, can: DailyCan): Phrase | null {
  if (!can.finish) return phrase('held.noFinish')
  if (workOrder.kind === 'REPAIR') return phrase('held.repairNoStock')
  if (workOrder.status === 'ON_HOLD') return phrase('held.onHold')
  if (!FINISHABLE.includes(workOrder.status)) return phrase('held.notOpen', { status: `status.${workOrder.status}` })
  if (!finished) return phrase('held.loading')
  if (finished.places.length === 0) return phrase('held.noFinishedPlace')
  if (finished.garments.canReport === 0) return finished.garments.netReleased === 0 ? phrase('held.nothingReleased') : phrase('held.allInStock')
  return null
}

/** The dialog's rows: per cell what can go now and the quantity asked (default: all it can). */
export function finishRows(finished: Finished, asked: Readonly<Record<string, number>>): Array<Finished['cells'][number] & { asked: number; over: boolean }> {
  return finished.cells.map((cell) => {
    const value = asked[cell.cellId] ?? cell.canReport
    return { ...cell, asked: value, over: value > cell.canReport || value < 0 || !Number.isInteger(value) }
  })
}

/** Why the dialog's "Report N finished" waits. */
export function reportHeld(rows: ReturnType<typeof finishRows>, placeId: string | null, busy: boolean): Phrase | null {
  if (busy) return phrase('held.busy')
  if (rows.some((row) => row.over)) return phrase('finish.held.over')
  if (rows.reduce((sum, row) => sum + row.asked, 0) === 0) return phrase('finish.held.none')
  if (!placeId) return phrase('finish.held.place')
  return null
}

/** The body's cells: only the ones asked for more than 0. */
export const reportCells = (rows: ReturnType<typeof finishRows>) => rows.filter((row) => row.asked > 0).map((row) => ({ cellId: row.cellId, quantity: row.asked }))

// ---- yield -----------------------------------------------------------------------------------------------------------------------------

export interface YieldBar {
  readonly hideId: string
  readonly label: string
  readonly lot: string
  /** 0–100: the pattern area of the hide's area in; null when nothing was used. */
  readonly yieldPct: number | null
  readonly plannedPct: number | null
  /** Below the plan by more than two points. */
  readonly low: boolean
}

const pctOf = (value: string | null): number | null => (value === null ? null : Number(value))

export function yieldBars(value: Yield): YieldBar[] {
  return value.hides.map((row) => {
    const yieldPct = pctOf(row.yieldPct)
    const plannedPct = pctOf(row.plannedPct)
    return { hideId: row.hide.id, label: row.hide.code, lot: row.lot.code, yieldPct, plannedPct, low: yieldPct !== null && plannedPct !== null && yieldPct < plannedPct - 2 }
  })
}

// ---- scrap, rework and holds ------------------------------------------------------------------------------------------------------

export interface ScrapGroup {
  readonly key: string
  readonly operation: string
  readonly seq: number | null
  readonly kind: 'SCRAP' | 'REWORK'
  readonly reasonCode: string
  readonly reason: string
  readonly rows: number
  readonly pieces: number
  /** Rework still open (OPEN or IN_PROGRESS). */
  readonly open: number
}

/** Scrap and rework per operation and reason, with counts (design wo-scrap "grouped list with counts"). */
export function scrapGroups(rows: readonly ScrapRow[], locale: string): ScrapGroup[] {
  const groups = new Map<string, { group: Omit<ScrapGroup, 'rows' | 'pieces' | 'open'>; rows: number; pieces: number; open: number }>()
  for (const row of rows) {
    const key = `${row.operation?.seq ?? '-'}|${row.kind}|${row.reasonCode}`
    const reason = row.reasonLabel ? (locale === 'it' ? row.reasonLabel.it : row.reasonLabel.en) : row.reasonCode
    const entry = groups.get(key) ?? { group: { key, operation: row.operation ? `${row.operation.seq} · ${row.operation.name}` : '—', seq: row.operation?.seq ?? null, kind: row.kind, reasonCode: row.reasonCode, reason }, rows: 0, pieces: 0, open: 0 }
    entry.rows += 1
    entry.pieces += row.pieces
    if (row.kind === 'REWORK' && (row.status === 'OPEN' || row.status === 'IN_PROGRESS')) entry.open += row.pieces
    groups.set(key, entry)
  }
  return [...groups.values()]
    .map((entry) => ({ ...entry.group, rows: entry.rows, pieces: entry.pieces, open: entry.open }))
    .sort((a, b) => (a.seq ?? 9999) - (b.seq ?? 9999) || (a.kind < b.kind ? 1 : a.kind > b.kind ? -1 : 0) || b.pieces - a.pieces)
}

export function scrapTotals(rows: readonly ScrapRow[]): { scrap: number; rework: number; reworkOpen: number } {
  return rows.reduce(
    (sum, row) => ({
      scrap: sum.scrap + (row.kind === 'SCRAP' ? row.pieces : 0),
      rework: sum.rework + (row.kind === 'REWORK' ? row.pieces : 0),
      reworkOpen: sum.reworkOpen + (row.kind === 'REWORK' && (row.status === 'OPEN' || row.status === 'IN_PROGRESS') ? row.pieces : 0),
    }),
    { scrap: 0, rework: 0, reworkOpen: 0 },
  )
}

// ---- reserve leather -------------------------------------------------------------------------------------------------------------

export type AvailableHide = Availability['hides'][number]

/** A hide a reserve may not take: why, in this app's words (else null). */
export function hideHeld(hide: AvailableHide, workOrderId: string): string | null {
  if (hide.held) return 'reserve.why.held'
  if (hide.reservedFor && hide.reservedFor.id === workOrderId) return 'reserve.why.mine'
  if (hide.reservedFor) return 'reserve.why.other'
  if (Number(hide.onHand) <= 0) return 'reserve.why.empty'
  return null
}

/** The leather materials of the work order a reserve can be made for (area-tracked: FT2 / M2). */
export function leatherMaterials(workOrder: Pick<WorkOrder, 'spec'>): WorkOrder['spec']['materials'] {
  return workOrder.spec.materials.filter((material) => material.baseUom === 'FT2' || material.baseUom === 'M2' || material.baseUom === 'DM2')
}

export function reserveHeld(workOrder: Pick<WorkOrder, 'status'>, can: DailyCan): Phrase | null {
  if (!can.reserve) return phrase('held.noReserve')
  if (!['DRAFT', 'RELEASED', 'IN_PROGRESS', 'ON_HOLD'].includes(workOrder.status)) return phrase('held.notOpen', { status: `status.${workOrder.status}` })
  return null
}

// ---- split a bundle -----------------------------------------------------------------------------------------------------------------

/** Why "Split…" waits for a bundle, or null. */
export function splitHeld(bundle: Pick<BundleRow, 'status' | 'quantity'>, workOrderStatus: WorkOrderStatus, can: DailyCan): Phrase | null {
  if (!can.bundles) return phrase('held.noBundles')
  if (bundle.status === 'VOID') return phrase('held.bundleVoid')
  if (workOrderStatus === 'ON_HOLD') return phrase('held.onHold')
  if (workOrderStatus !== 'RELEASED' && workOrderStatus !== 'IN_PROGRESS') return phrase('held.notOpen', { status: `status.${workOrderStatus}` })
  if (bundle.quantity < 2) return phrase('held.bundleOne')
  return null
}

export function splitAskHeld(quantity: number, bundle: Pick<BundleRow, 'quantity'>, reason: SplitReason | '', busy: boolean): Phrase | null {
  if (busy) return phrase('held.busy')
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > bundle.quantity - 1) return phrase('split.held.quantity', { max: bundle.quantity - 1 })
  if (!reason) return phrase('split.held.reason')
  return null
}

// ---- the operation flow --------------------------------------------------------------------------------------------------------------

export interface FlowStep {
  readonly seq: number
  readonly code: string
  readonly name: string
  /** Garments that arrived and wait before this operation (the pile). */
  readonly waiting: number
  readonly good: number
  readonly scrap: number
  readonly rework: number
  readonly final: boolean
  /** The operation with the biggest pile (more than 0). */
  readonly bottleneck: boolean
}

/** Operations as a row with the pile waiting before each (design wo-flow "W2a OperationFlow"). Totals only, no person. */
export function flowSteps(wip: WorkOrderWip | null): FlowStep[] {
  if (!wip) return []
  const most = Math.max(0, ...wip.operations.map((op) => op.waiting))
  return wip.operations.map((op) => ({ seq: op.seq, code: op.code, name: op.name, waiting: op.waiting, good: op.good, scrap: op.scrap, rework: op.rework, final: op.final, bottleneck: most > 0 && op.waiting === most }))
}

// ---- documents to print -------------------------------------------------------------------------------------------------------------

export interface PickRow {
  readonly material: string
  readonly toIssue: string
  readonly uom: string
  readonly from: string
}

/** The pick list as printed: each material still to issue with where its usable stock lies (lot, hide, place). */
export function pickRows(pick: PickList | null): PickRow[] {
  if (!pick) return []
  return pick.lines.map((line) => ({
    material: [line.itemCode, line.colourCode].filter(Boolean).join(' · '),
    toIssue: line.toIssue,
    uom: line.baseUom,
    from: line.usable.candidates.map((entry) => [entry.locationCode, entry.lotCode, entry.hideCode].filter(Boolean).join(' / ')).join('; ') || '—',
  }))
}

export interface CuttingRow {
  readonly cell: string
  readonly quantity: number
  readonly parts: string
}

/** The cutting list as printed: per colourway and size the garments and the parts to cut (from the bundles' parts). */
export function cuttingRows(workOrder: Pick<WorkOrder, 'cells'>, bundles: WorkOrderBundles | null): CuttingRow[] {
  return workOrder.cells.map((cell) => {
    const parts = bundles?.cells.find((entry) => entry.workOrderSizeId === cell.id)?.parts ?? []
    return { cell: `${cell.colourwayCode} ${cell.size}`, quantity: cell.quantity, parts: parts.map((part) => `${part.part} × ${part.pieces}`).join(', ') || '—' }
  })
}

// ---- the sub-model the record reads ------------------------------------------------------------------------------------------------

export type DailyDialog =
  | { kind: 'hold'; workOrderIds: string[]; numbers: string[] }
  | { kind: 'releaseHold'; holdId: string }
  | { kind: 'finish' }
  | { kind: 'reserve'; itemId: string; itemColourId: string | null }
  | { kind: 'split'; bundleId: string }
  | { kind: 'print'; what: 'pick' | 'cutting' }

export interface DailyModel {
  can: DailyCan
  /** The work order's holds (quality.holds.view); null without the right. */
  holds: Part<Hold[]> | null
  /** ACTIVE holds of bundles at the work order's site (the Bundles tab's column); null without the right. */
  bundleHolds: Hold[] | null
  /** The HOLD reasons (the dialog's picker and the holds' words). */
  reasons: PickerReason[] | null
  /** The readiness word of a released work order and its materials (a draft reads it in its release check). */
  readiness: Part<ReadinessRow> | null
  finished: Part<Finished> | null
  yield: Part<Yield> | null
  /** Scrap and rework (production.scrap.view); null without the right. */
  scrap: Part<ScrapRow[]> | null
  /** The hides of the material the reserve dialog shows. */
  availability: Part<Availability> | null
  /** The hold the release dialog shows. */
  holdRecord: Part<HoldRecord> | null
  dialog: DailyDialog | null
  busy: boolean
  /** A refused write while its dialog is open, in words (what was typed stays). */
  problem: Phrase | null
  stepUp: StepUpState
  /** Design cases: what a dialog holds. */
  draft?: { reasonCode?: string; note?: string; statement?: boolean; asked?: Record<string, number>; placeId?: string; picked?: string[]; quantity?: number; splitReason?: SplitReason }
}

export interface DailyActions {
  onDialog?: (dialog: DailyDialog | null) => void
  onPlaceHold?: (input: { workOrderIds: string[]; reasonCode: string; reasonNote: string | null }) => void
  onReleaseHold?: (input: { holdId: string; version: number; note: string | null; notMakerStatement: boolean }) => void
  onReport?: (input: { cells: Array<{ cellId: string; quantity: number }>; toLocationId: string | null; note: string | null }) => void
  onReserve?: (hideIds: string[]) => void
  onSplit?: (input: { bundleId: string; quantity: number; reason: SplitReason; note: string | null }) => void
  onStepUp?: (code: string) => void
  onCancelStepUp?: () => void
  onRetry?: (part: 'holds' | 'finished' | 'yield' | 'scrap' | 'readiness' | 'availability' | 'holdRecord') => void
}

export const NO_DAILY = (can: DailyCan): DailyModel => ({
  can,
  holds: can.holdsView ? LOADING : null,
  bundleHolds: null,
  reasons: null,
  readiness: null,
  finished: null,
  yield: null,
  scrap: can.scrapView ? LOADING : null,
  availability: null,
  holdRecord: null,
  dialog: null,
  busy: false,
  problem: null,
  stepUp: { open: false, busy: false, sentence: '', problem: null },
})

/** A refused write in this app's words (the API's English is never drawn). */
export function dailyProblem(error: unknown): Phrase {
  const kind = typeof error === 'object' && error !== null && 'kind' in error ? String((error as { kind: unknown }).kind) : ''
  if (kind === 'conflict') return phrase('problem.conflict')
  if (kind === 'forbidden') return phrase('problem.forbidden')
  if (kind === 'invalid') return phrase('problem.invalid')
  if (kind === 'not_found') return phrase('problem.gone')
  if (kind === 'unavailable' || kind === 'network') return phrase('problem.offline')
  return phrase('problem.write')
}

/** A failed read in this app's words (a key of DAILY_NAMESPACE). */
export function dailyReadProblem(error: unknown): string {
  const kind = typeof error === 'object' && error !== null && 'kind' in error ? String((error as { kind: unknown }).kind) : ''
  if (kind === 'forbidden') return 'problem.forbiddenRead'
  if (kind === 'unavailable' || kind === 'network') return 'problem.offline'
  return 'problem.read'
}
