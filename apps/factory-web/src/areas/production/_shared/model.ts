import type { Tone } from '@nexus/ui/primitives'
import { isApiError, issuePath } from '../../../lib/api/errors'
import type { BundleRow, CutEntry, CutLog, ListQuery, ReleaseCheck, ReleaseCheckCode, WorkOrder, WorkOrderCounts, WorkOrderRow, WorkOrderStatus, WorkOrderWip } from './api'

/**
 * The Production office screens' rules, without a screen (SCR-069 … SCR-073): what a person may do (from the session's
 * permissions; the API checks every call again), the list's saved views and tiles, the record's tabs and its next step
 * (held with its reason, never disabled), the release check in this app's words, the size grid's layers, the hides'
 * area bars, where each bundle waits, and an API error as a message key. Words are message keys of the `production`
 * catalogue with their parameters (`Phrase`); the views translate them. No money anywhere (the production manager sees
 * no cost; the work order API carries none).
 */

export interface Phrase {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}
const phrase = (key: string, params?: Phrase['params']): Phrase => (params ? { key, params } : { key })

// ---- who may do what ---------------------------------------------------------------------------------------------------------

export interface ProductionCan {
  /** workorders.view: every page of the area. */
  readonly view: boolean
  /** workorders.manage: new work orders, a draft's sizes, due date and priority, start / complete / close / cancel. */
  readonly manage: boolean
  /** workorders.release. */
  readonly release: boolean
  /** production.cut.correct: the office's correction of a cut entry. */
  readonly correctCuts: boolean
  /** production.bundles: reprint a bundle ticket. */
  readonly bundles: boolean
  /** print.labels: send a ticket to a label printer. */
  readonly printLabels: boolean
  /** quality.inspections.view: the Quality tab. */
  readonly quality: boolean
  /** inventory.issue: the pick list on the Materials tab. */
  readonly pick: boolean
  /** orders.view: find the sales order a new work order is made from. */
  readonly orders: boolean
}

export function abilitiesOf(permissions: readonly string[]): ProductionCan {
  const held = new Set(permissions)
  return {
    view: held.has('workorders.view'),
    manage: held.has('workorders.manage'),
    release: held.has('workorders.release'),
    correctCuts: held.has('production.cut.correct'),
    bundles: held.has('production.bundles'),
    printLabels: held.has('print.labels'),
    quality: held.has('quality.inspections.view'),
    pick: held.has('inventory.issue'),
    orders: held.has('orders.view'),
  }
}

export const STATUS_TONE: Readonly<Record<WorkOrderStatus, Tone>> = Object.freeze({
  DRAFT: 'neutral',
  RELEASED: 'info',
  IN_PROGRESS: 'warning',
  COMPLETED: 'success',
  CLOSED: 'neutral',
  CANCELLED: 'danger',
  ON_HOLD: 'danger',
})

// ---- the list: saved views and tiles -------------------------------------------------------------------------------------------

/** Rows ▾: the saved views (design wo-grid). `open` is the default. */
export const LIST_VIEWS = ['open', 'late', 'DRAFT', 'RELEASED', 'IN_PROGRESS', 'COMPLETED', 'CLOSED', 'CANCELLED', 'all'] as const
export type ListView = (typeof LIST_VIEWS)[number]
export const DEFAULT_VIEW: ListView = 'open'

export function viewOf(value: string | null | undefined): ListView {
  return (LIST_VIEWS as readonly string[]).includes(value ?? '') ? (value as ListView) : DEFAULT_VIEW
}

/**
 * The view an address asks for: `?view=`, or the API list's own query (record-links LIST_PAGES keeps it: Today's
 * "See all" opens `?status=DRAFT` or `?late=true`).
 */
export function viewFromAddress(params: { get(name: string): string | null } | null | undefined): ListView {
  const view = params?.get('view')
  if (view) return viewOf(view)
  if (params?.get('late') === 'true') return 'late'
  const status = params?.get('status')
  if (status && (LIST_VIEWS as readonly string[]).includes(status)) return status as ListView
  return DEFAULT_VIEW
}

/** The API query of a view and a search. */
export function viewQuery(view: ListView, q: string, cursor: string | null = null): ListQuery {
  const base: ListQuery = { q: q.trim() || undefined, cursor, limit: 50 }
  if (view === 'open') return { ...base, open: true }
  if (view === 'late') return { ...base, late: true }
  if (view === 'all') return base
  return { ...base, status: view }
}

/** The tiles (design wo-metrics): each IS a saved view, so pressing one shows its rows (one filter model). */
export const TILES = [
  { id: 'draft', view: 'DRAFT', count: (counts: WorkOrderCounts) => counts.draft },
  { id: 'released', view: 'RELEASED', count: (counts: WorkOrderCounts) => counts.released },
  { id: 'inProgress', view: 'IN_PROGRESS', count: (counts: WorkOrderCounts) => counts.inProgress },
  { id: 'late', view: 'late', count: (counts: WorkOrderCounts) => counts.late },
] as const satisfies ReadonlyArray<{ id: string; view: ListView; count: (counts: WorkOrderCounts) => number }>

// ---- numbers --------------------------------------------------------------------------------------------------------------------

/**
 * A decimal string of the API (areas and quantities in the base unit, four decimals) as the person reads it: grouped and
 * with the language's decimal mark, without trailing zeros ("50.4000" → "50,4" in Italian). Not a number: as it came.
 */
export function quantityText(value: string, locale: string): string {
  const number = Number(value)
  if (!Number.isFinite(number)) return value
  return new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-GB', { maximumFractionDigits: 4 }).format(number)
}

// ---- progress ------------------------------------------------------------------------------------------------------------------

/** A share in whole percent (0–100), or null when nothing is counted or nothing is planned. */
export function percentOf(done: number | null, total: number): number | null {
  if (done === null || total <= 0) return null
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)))
}

/** The furthest step a work order's progress counts, for one short phrase in the list ("finished 6 of 24"). */
export function progressPhrase(row: Pick<WorkOrderRow, 'progress' | 'pieces' | 'status'>): Phrase {
  if (row.status === 'DRAFT' || !row.progress) return phrase('progress.notFrozen')
  const p = row.progress
  for (const step of ['finished', 'sewn', 'bundled', 'cut'] as const) {
    const value = p[step]
    if (value !== null && value > 0) return phrase(`progress.${step}`, { done: value, total: row.pieces })
  }
  return phrase('progress.none', { total: row.pieces })
}

// ---- the record --------------------------------------------------------------------------------------------------------------

export const RECORD_TABS = ['overview', 'materials', 'cutting', 'bundles', 'operations', 'quality', 'activity'] as const
export type RecordTab = (typeof RECORD_TABS)[number]

export function tabOf(value: string | null | undefined): RecordTab {
  return (RECORD_TABS as readonly string[]).includes(value ?? '') ? (value as RecordTab) : 'overview'
}

export type StepKind = 'release' | 'start' | 'complete' | 'close'

export interface NextStep {
  readonly kind: StepKind | null
  /** Why the step cannot be taken now (shown on the held button), or null. */
  readonly held: Phrase | null
}

/**
 * The band's primary action by state (design: Release → … → Close): a DRAFT is released (held with the number of checks
 * open, or without the right), a RELEASED one is started by hand (the floor's first work starts it too), one IN_PROGRESS
 * is completed when every cell is finished (WIP readyToComplete), a COMPLETED one is closed. Held, never hidden.
 */
export function nextStep(workOrder: Pick<WorkOrder, 'status' | 'nextActions'>, can: ProductionCan, check: ReleaseCheck | null, wip: Pick<WorkOrderWip, 'readyToComplete' | 'cells'> | null): NextStep {
  switch (workOrder.status) {
    case 'DRAFT': {
      if (!can.release) return { kind: 'release', held: phrase('held.noRelease') }
      if (!check) return { kind: 'release', held: phrase('held.checking') }
      const open = check.checks.filter((entry) => entry.state === 'BLOCKED')
      const onlyMaterial = open.length === 1 && open[0]!.code === 'MATERIAL'
      // A short material alone is released with the planner's reason (the dialog asks for it).
      if (open.length > 0 && !onlyMaterial) return { kind: 'release', held: phrase('held.checksOpen', { count: open.length }) }
      return { kind: 'release', held: null }
    }
    case 'RELEASED':
      return { kind: 'start', held: can.manage ? null : phrase('held.noManage') }
    case 'IN_PROGRESS': {
      if (!can.manage) return { kind: 'complete', held: phrase('held.noManage') }
      if (!wip) return { kind: 'complete', held: phrase('held.checking') }
      if (!wip.readyToComplete) {
        const left = wip.cells.reduce((sum, cell) => sum + Math.max(0, cell.quantity - (cell.finished ?? 0)), 0)
        return { kind: 'complete', held: phrase('held.notFinished', { count: left }) }
      }
      return { kind: 'complete', held: null }
    }
    case 'COMPLETED':
      return { kind: 'close', held: can.manage ? null : phrase('held.noManage') }
    default:
      return { kind: null, held: null }
  }
}

/** Cancel (⋯): a draft, a released or an in-progress work order, with workorders.manage and a reason. */
export function mayCancel(workOrder: Pick<WorkOrder, 'nextActions'>, can: ProductionCan): boolean {
  return can.manage && workOrder.nextActions.includes('CANCELLED')
}

/** Due date and priority change until the work order is closed or cancelled (the API's rule). */
export function mayEditDetails(workOrder: Pick<WorkOrder, 'status'>, can: ProductionCan): boolean {
  return can.manage && workOrder.status !== 'CLOSED' && workOrder.status !== 'CANCELLED'
}

// ---- the release check in this app's words ------------------------------------------------------------------------------------

export interface CheckItem {
  readonly code: ReleaseCheckCode
  readonly state: ReleaseCheck['checks'][number]['state']
  readonly words: Phrase
  readonly problems: readonly Phrase[]
}

const cellLabel = (workOrder: Pick<WorkOrder, 'cells'>, cellId: string): string => {
  const cell = workOrder.cells.find((entry) => entry.id === cellId)
  return cell ? `${cell.colourwayCode} ${cell.size}` : '—'
}

/**
 * Each check as one sentence of this app (by its code and state, with the record's own facts), and each problem by
 * where it is (`cells/<id>/certificate`, `orders/<id>/deposit`, `materials/<item>[/<colour>]`, `checks/WORK_CENTRES/<kind>`,
 * `cells/<id>/bom/<line>`, `cells/<id>/size`). The API's English sentences are never drawn.
 */
export function checkItems(check: ReleaseCheck, workOrder: Pick<WorkOrder, 'cells' | 'orders' | 'revision' | 'labelTemplate' | 'site'>): CheckItem[] {
  return check.checks.map((entry) => {
    const params: Record<string, string | number> = {
      revision: workOrder.revision?.revision ?? '—',
      revisionStatus: workOrder.revision?.status ?? '—',
      label: workOrder.labelTemplate ? `${workOrder.labelTemplate.code} v${workOrder.labelTemplate.revision}` : '—',
      site: workOrder.site.code,
      cells: workOrder.cells.length,
      count: entry.problems.length,
    }
    let wordKey = `check.${entry.code}.${entry.state}`
    if (entry.code === 'REVISION' && entry.state === 'BLOCKED') wordKey = workOrder.revision ? 'check.REVISION.notReleased' : 'check.REVISION.none'
    if (entry.code === 'LABEL_TEMPLATE' && entry.state === 'BLOCKED') wordKey = !workOrder.revision ? 'check.noRevision' : workOrder.labelTemplate ? 'check.LABEL_TEMPLATE.notActive' : 'check.LABEL_TEMPLATE.none'
    if (entry.code === 'BOM' && entry.state === 'BLOCKED' && !workOrder.revision) wordKey = 'check.noRevision'
    // No kind named: the routing has no step at all (no revision, or a routing without operations).
    if (entry.code === 'WORK_CENTRES' && entry.state === 'BLOCKED' && !entry.problems.some((problem) => problem.path.startsWith('checks/WORK_CENTRES/'))) wordKey = 'check.WORK_CENTRES.noSteps'
    const problems = entry.state === 'BLOCKED' || entry.state === 'OVERRIDDEN' ? entry.problems.flatMap((problem) => problemWords(problem.path, entry.code, check, workOrder)) : []
    return { code: entry.code, state: entry.state, words: phrase(wordKey, params), problems }
  })
}

function problemWords(path: string, code: ReleaseCheckCode, check: ReleaseCheck, workOrder: Pick<WorkOrder, 'cells' | 'orders' | 'site'>): Phrase[] {
  const parts = path.split('/')
  if (parts[0] === 'cells' && parts[1]) {
    const cell = cellLabel(workOrder, parts[1])
    if (parts[2] === 'certificate') return [phrase('problem.certificate', { cell })]
    if (parts[2] === 'bom') return [phrase('problem.bom', { cell })]
    if (parts[2] === 'size') return [phrase('problem.size', { cell })]
  }
  if (parts[0] === 'orders' && parts[1]) {
    const order = workOrder.orders.find((entry) => entry.id === parts[1])
    return [phrase('problem.deposit', { order: order?.number ?? '—' })]
  }
  if (parts[0] === 'materials' && parts[1]) {
    const line = check.materials.find((entry) => entry.itemId === parts[1] && (entry.itemColourId ?? '') === (parts[2] ?? ''))
    if (!line) return [phrase('problem.material.unknown')]
    const held = line.held.filter((entry) => Number(entry.quantity) > 0)
    return [
      phrase('problem.material.short', { material: line.label, short: line.short, uom: line.baseUom, needed: line.needed, available: line.available }),
      ...held.map((entry) => phrase('problem.material.held', { quantity: entry.quantity, uom: line.baseUom, reason: `reason.${entry.reason}` })),
    ]
  }
  if (parts[0] === 'checks' && parts[1] === 'WORK_CENTRES' && parts[2]) return [phrase('problem.workCentre', { kind: `kind.${parts[2]}`, site: workOrder.site.code })]
  // `checks/<CODE>`: the check's own sentence says it.
  if (parts[0] === 'checks' && parts[1] === code) return []
  return [phrase('problem.other')]
}

/** "Release · 2 checks open" — how many checks hold the release (0: it can go). */
export function openChecks(check: ReleaseCheck | null): number {
  return check ? check.checks.filter((entry) => entry.state === 'BLOCKED').length : 0
}

/** Only a short material holds the release: the planner may release with a reason (workorders.release). */
export function onlyMaterialShort(check: ReleaseCheck | null): boolean {
  if (!check) return false
  const open = check.checks.filter((entry) => entry.state === 'BLOCKED')
  return open.length === 1 && open[0]!.code === 'MATERIAL'
}

// ---- the size run --------------------------------------------------------------------------------------------------------------

export const SIZE_LAYERS = ['quantity', 'cut', 'bundled', 'sewn', 'finished', 'balance'] as const
export type SizeLayer = (typeof SIZE_LAYERS)[number]

export interface SizeRun {
  readonly colours: Array<{ key: string; label: string; offered: string[] }>
  readonly sizes: Array<{ key: string; label: string }>
  readonly value: Record<string, Record<string, number>>
  /** The layer counts nothing yet (a draft, or no cell counts the step). */
  readonly uncounted: boolean
}

/**
 * The colour × size grid of one layer: the ordered quantity, or what the floor counted (cut, bundled, sewn, finished),
 * or what is left (quantity − finished). Sizes in the style's scale order; a size a colourway has no cell in is "not
 * offered". A cell the step does not count reads 0 only when the layer counts something elsewhere; else `uncounted`.
 */
export function sizeRunOf(workOrder: Pick<WorkOrder, 'cells' | 'style'>, layer: SizeLayer): SizeRun {
  const used = new Set(workOrder.cells.map((cell) => cell.size))
  const order = workOrder.style.sizes.filter((size) => used.has(size))
  for (const size of used) if (!order.includes(size)) order.push(size)
  const colours = new Map<string, { key: string; label: string; offered: string[] }>()
  const value: Record<string, Record<string, number>> = {}
  let counted = layer === 'quantity'
  for (const cell of workOrder.cells) {
    const key = cell.colourwayCode
    if (!colours.has(key)) colours.set(key, { key, label: `${cell.colourwayCode} · ${cell.colourwayName}`, offered: [] })
    colours.get(key)!.offered.push(cell.size)
    const row = (value[key] ??= {})
    const shown =
      layer === 'quantity' ? cell.quantity
        : layer === 'balance' ? (cell.progress.finished === null ? null : Math.max(0, cell.quantity - cell.progress.finished))
          : cell.progress[layer]
    if (shown !== null) counted = true
    row[cell.size] = (row[cell.size] ?? 0) + (shown ?? 0)
  }
  return { colours: [...colours.values()], sizes: order.map((size) => ({ key: size, label: size })), value, uncounted: !counted }
}

/** The totals the overview shows beside the grid: pieces, and each step summed (null when nothing counts it). */
export function stepTotals(workOrder: Pick<WorkOrder, 'cells'>): Record<'cut' | 'bundled' | 'sewn' | 'finished', number | null> {
  const sum = (step: 'cut' | 'bundled' | 'sewn' | 'finished') => {
    const values = workOrder.cells.map((cell) => cell.progress[step]).filter((value): value is number => value !== null)
    return values.length ? values.reduce((total, value) => total + value, 0) : null
  }
  return { cut: sum('cut'), bundled: sum('bundled'), sewn: sum('sewn'), finished: sum('finished') }
}

/** A draft's cells as the editor's value (colourway × size → pieces) and back, per order line (the API's unit). */
export function draftGrid(workOrder: Pick<WorkOrder, 'cells'>): Record<string, Record<string, number>> {
  const value: Record<string, Record<string, number>> = {}
  for (const cell of workOrder.cells) (value[cell.colourwayCode] ??= {})[cell.size] = cell.quantity
  return value
}

/** The PUT body's cells for an edited grid: every cell of the draft with its new count (0 removes it). */
export function cellsBody(workOrder: Pick<WorkOrder, 'cells'>, grid: Readonly<Record<string, Readonly<Record<string, number>>>>): Array<{ salesOrderLineId: string; size: string; quantity: number }> {
  return workOrder.cells.map((cell) => ({ salesOrderLineId: cell.salesOrderLineId, size: cell.size, quantity: grid[cell.colourwayCode]?.[cell.size] ?? 0 }))
}

export function gridChanged(workOrder: Pick<WorkOrder, 'cells'>, grid: Readonly<Record<string, Readonly<Record<string, number>>>>): boolean {
  return workOrder.cells.some((cell) => (grid[cell.colourwayCode]?.[cell.size] ?? 0) !== cell.quantity)
}

// ---- cutting -------------------------------------------------------------------------------------------------------------------

export interface HideBar {
  readonly issued: number
  /** Each part's share of what was issued, in whole percent (they add up to 100 when anything was issued). */
  readonly parts: Array<{ part: 'cut' | 'waste' | 'returned' | 'left'; value: string; percent: number }>
}

/** A hide's area bar (cut + waste + returned + left = issued, the API's base unit). */
export function hideBar(hide: CutLog['hides'][number]): HideBar {
  const issued = Number(hide.issued)
  const parts = (['cut', 'waste', 'returned', 'left'] as const).map((part) => ({ part, value: hide[part], amount: Math.max(0, Number(hide[part])) }))
  const shares = parts.map((entry) => (issued > 0 ? (entry.amount / issued) * 100 : 0))
  // Whole percents that still add up to 100 (largest remainder).
  const floors = shares.map(Math.floor)
  let left = issued > 0 ? 100 - floors.reduce((sum, value) => sum + value, 0) : 0
  const order = shares.map((share, index) => ({ index, rest: share - floors[index]! })).sort((a, b) => b.rest - a.rest)
  for (const entry of order) {
    if (left <= 0) break
    floors[entry.index]! += 1
    left -= 1
  }
  return { issued, parts: parts.map((entry, index) => ({ part: entry.part, value: entry.value, percent: floors[index]! })) }
}

export type CorrectHold = 'reversal' | 'reversed' | 'usedUp' | 'notOpen' | 'noRight' | null

/**
 * Whether the office may correct an entry, before asking (the API checks again: a bundle that names it answers 409 in
 * words): a live cut of an open work order; of a used-up hide only its closing cut (correcting it opens the hide again).
 */
export function correctHold(entry: CutEntry, log: CutLog, can: ProductionCan): CorrectHold {
  if (entry.reversalOfId) return 'reversal'
  if (!entry.live || entry.reversedById) return 'reversed'
  if (!can.correctCuts) return 'noRight'
  if (!['RELEASED', 'IN_PROGRESS'].includes(log.workOrder.status)) return 'notOpen'
  const hide = log.hides.find((row) => row.hideId === entry.hideId)
  if (hide && (hide.state === 'CONSUMED' || hide.state === 'SCRAPPED') && !entry.closing) return 'usedUp'
  return null
}

/** The pieces of an entry, grouped by cell ("BLK 50: sleeve 2, body 2"). */
export function entryPieces(entry: CutEntry): Array<{ cell: string; parts: Array<{ part: string; pieces: number }> }> {
  const cells = new Map(entry.cells.map((cell) => [cell.workOrderSizeId, `${cell.colourwayCode} ${cell.size}`]))
  const grouped = new Map<string, Array<{ part: string; pieces: number }>>()
  for (const piece of entry.pieces) {
    const cell = cells.get(piece.workOrderSizeId) ?? '—'
    const list = grouped.get(cell) ?? []
    list.push({ part: piece.part, pieces: piece.pieces })
    grouped.set(cell, list)
  }
  return [...grouped.entries()].map(([cell, parts]) => ({ cell, parts }))
}

// ---- bundles -------------------------------------------------------------------------------------------------------------------

/**
 * The scanned operation a bundle waits at: the first scanned operation (routing order) it is not done at, or null when
 * it is done at every one (finished) or void. `scanned` are the work order's scanned operations' seqs in order.
 */
export function waitingAt(bundle: Pick<BundleRow, 'status' | 'doneAt' | 'part'>, scanned: readonly number[]): number | null {
  if (bundle.status !== 'ACTIVE') return null
  const done = new Set(bundle.doneAt)
  return scanned.find((seq) => !done.has(seq)) ?? null
}

/** Why a bundle's ticket may not be reprinted (its box stays off with the reason), or null. */
export function reprintHold(bundle: Pick<BundleRow, 'status'>, workOrderStatus: WorkOrderStatus): 'void' | 'notOpen' | null {
  if (bundle.status !== 'ACTIVE') return 'void'
  if (workOrderStatus !== 'RELEASED' && workOrderStatus !== 'IN_PROGRESS') return 'notOpen'
  return null
}

export const REPRINT_REASONS = ['lost', 'damaged', 'unreadable'] as const
export type ReprintReason = (typeof REPRINT_REASONS)[number] | 'other'

// ---- errors in this app's words -------------------------------------------------------------------------------------------------

const CUT_CODES = new Set(['WORK_ORDER_NOT_OPEN', 'HIDE_USED_UP', 'NOT_A_CUT', 'REVERSED_ALREADY', 'IN_BUNDLE'])
const BUNDLE_CODES = new Set(['WORK_ORDER_NOT_OPEN', 'VOIDED', 'SCANNED', 'REPLACED', 'FLOOR_NOT_READY'])

/** A failed read, as a message key. */
export function readProblem(error: unknown): string {
  if (!isApiError(error)) return 'error.read'
  if (error.kind === 'forbidden') return 'error.forbidden'
  if (error.kind === 'unavailable') return 'error.offline'
  return 'error.read'
}

/**
 * A refused write, as words: a cutting or bundle refusal by its code (`refusal/<CODE>`), a changed record (409 without a
 * refusal: read again), no right, a bad request, no answer.
 */
export function writeProblem(error: unknown, area: 'workOrder' | 'cut' | 'bundle' = 'workOrder'): Phrase {
  if (!isApiError(error)) return phrase('error.write')
  const refusal = error.issues.map(issuePath).find((path) => path.startsWith('refusal/'))
  const code = refusal?.split('/')[1]
  if (code && area === 'cut' && CUT_CODES.has(code)) return phrase(`refusal.cut.${code}`)
  if (code && area === 'bundle' && BUNDLE_CODES.has(code)) return phrase(`refusal.bundle.${code}`)
  if (code) return phrase('refusal.other')
  switch (error.kind) {
    case 'conflict':
      return phrase(area === 'workOrder' ? 'error.changed' : 'error.conflict')
    case 'forbidden':
    case 'step_up':
      return phrase('error.forbidden')
    case 'not_found':
      return phrase('error.gone')
    case 'invalid':
      return phrase(area === 'bundle' ? 'error.printer' : 'error.invalid')
    case 'unavailable':
      return phrase('error.offline')
    default:
      return phrase('error.write')
  }
}

/** The release's refusal: which checks hold it (`checks/<CODE>…`, `cells/…`, `orders/…`, `materials/…`), as check codes. */
export function releaseRefusalCodes(error: unknown): ReleaseCheckCode[] {
  if (!isApiError(error) || error.kind !== 'conflict') return []
  const codes = new Set<ReleaseCheckCode>()
  for (const path of error.issues.map(issuePath)) {
    const [head, second, third] = path.split('/')
    if (head === 'checks' && second) codes.add(second as ReleaseCheckCode)
    if (head === 'orders') codes.add('DEPOSIT')
    if (head === 'materials') codes.add('MATERIAL')
    if (head === 'cells') codes.add(third === 'certificate' ? 'CERTIFICATE' : third === 'bom' ? 'BOM' : 'CELLS')
  }
  return [...codes]
}

// ---- the list as CSV ---------------------------------------------------------------------------------------------------------

const csvCell = (value: string | number | null): string => {
  const text = value === null ? '' : String(value)
  return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** The selected rows as CSV (Export N): what the list shows, in the person's words for the header and the status. */
export function workOrdersCsv(rows: readonly WorkOrderRow[], words: { header: readonly string[]; status: (status: WorkOrderStatus) => string }): string {
  const lines = [words.header.map(csvCell).join(',')]
  for (const row of rows) {
    lines.push(
      [
        row.number,
        row.batchNumber,
        words.status(row.status),
        row.styleCode,
        row.styleName,
        row.colourways.join(' '),
        row.orders.map((order) => order.partyName).join('; '),
        row.orders.map((order) => order.number).join(' '),
        row.pieces,
        row.progress?.cut ?? null,
        row.progress?.bundled ?? null,
        row.progress?.sewn ?? null,
        row.progress?.finished ?? null,
        row.dueDate,
        row.daysLate,
        row.priority,
        row.siteCode,
      ]
        .map(csvCell)
        .join(','),
    )
  }
  return `${lines.join('\n')}\n`
}

/** A live change that touches this work order (its id in the event's fields), or any work order (list pages). */
export function liveTouches(change: { type: string; fields: Readonly<Record<string, unknown>> }, workOrderId?: string): boolean {
  const ours = change.type.startsWith('workorder.') || change.type.startsWith('production.')
  if (!ours) return false
  if (!workOrderId) return true
  return change.fields.workOrderId === workOrderId
}
