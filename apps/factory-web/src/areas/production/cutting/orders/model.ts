import type { LabelLayout } from '@nexus/ui/components/LabelPreview/index'
import type { Tone } from '@nexus/ui/primitives'
import { ALLOCATION_REFUSALS } from '@nexus/factory-domain/production/cutorders/allocation'
import { CUT_ORDER_LIMITS, CUT_ORDER_REFUSALS, ratioText, splitPlies } from '@nexus/factory-domain/production/cutorders/rules'
import { TICKET_REFUSALS } from '@nexus/factory-domain/production/cutorders/tickets'
import { CUT_VARIANCE_REASONS, RECONCILE_REFUSALS } from '@nexus/factory-domain/production/lays/reconcile'
import { isApiError, issuePath } from '../../../../lib/api/errors'
import type { CutLog } from '../../_shared/api'
import type { Allocation, CutRow, CutView, WorkOrderYield } from '../api'
import { phrase, type Phrase } from '../model'
import type {
  CreateBody,
  CutOrderRecord,
  CutOrderStatus,
  CutOrderSummary,
  CutOrderTiles,
  CutOrderView,
  CutTicket,
  CutTicketStatus,
  LayStatus,
  LayView,
  Reconciliation,
  RollCandidate,
  RollCandidates,
  WaitingCell,
  WaitingGroup,
} from './api'

/**
 * Cutting in depth (B-W2b-129; design production.cutting, W2b parts): the rules without a screen for cut orders of several work
 * orders (MES-034), their lays and rolls by shade and shrinkage group (MES-037), the tickets (MES-041), Reconcile cut (MES-045),
 * the yield's issued vs used vs returned and the supplier lot feedback, the lay sheet, and the leather cut's same shade lot
 * check. Words are message keys of the `cutting-orders` catalogue with their parameters (the API's English sentences are never
 * shown). Never who cut, spread or counted: tables, lays, rolls and lots only (Statuto dei Lavoratori art. 4; SCM-255). No money.
 */

export const ORDERS_NAMESPACE = 'cutting-orders'

// ---- who may do what -----------------------------------------------------------------------------------------------------------

export interface OrdersCan {
  /** production.cutting.view: cut orders, their record, the reconciliation and the lay sheet. */
  readonly view: boolean
  /** production.cutorders.manage: plan, release, send back, cancel, allocate rolls, print and void tickets, reconcile. */
  readonly manage: boolean
  /** print.view: the site's stations (the cutting table) and label printers. */
  readonly print: boolean
  /** workorders.view: a work order's leather cut (its hides) opens. */
  readonly workOrders: boolean
}

export function ordersCanOf(permissions: readonly string[]): OrdersCan {
  const held = new Set(permissions)
  return { view: held.has('production.cutting.view'), manage: held.has('production.cutorders.manage'), print: held.has('print.view'), workOrders: held.has('workorders.view') }
}

// ---- words of a status ---------------------------------------------------------------------------------------------------------

export const ORDER_TONE: Readonly<Record<CutOrderStatus, Tone>> = { PLANNED: 'neutral', RELEASED: 'info', IN_PROGRESS: 'info', CUT: 'success', RECONCILED: 'success', CANCELLED: 'neutral' }
export const LAY_TONE: Readonly<Record<LayStatus, Tone>> = { PLANNED: 'neutral', SPREADING: 'info', CHECKED: 'info', CUT: 'success', CANCELLED: 'neutral' }
export const TICKET_TONE: Readonly<Record<CutTicketStatus, Tone>> = { OPEN: 'neutral', STARTED: 'info', DONE: 'success', VOID: 'neutral' }

/** A decimal with at most `places` places in the person's language ("2,05"); "—" for nothing. */
export function decimalText(value: string | number | null, locale: string, places = 2): string {
  if (value === null) return '—'
  const number = Number(value)
  if (!Number.isFinite(number)) return '—'
  return new Intl.NumberFormat(locale, { maximumFractionDigits: places }).format(number)
}

/** The material and colour of a cut order ("DEMO-LIN-200 · GRY"). */
export const orderMaterial = (order: Pick<CutOrderSummary, 'material'>): string => [order.material.item.code, order.material.colour?.code].filter(Boolean).join(' · ')

/** The plan in words: "2 lays · 10 plies · 80 garments" (fabric), "12 garments" (leather), as a phrase. */
export function planPhrase(order: Pick<CutOrderSummary, 'kind' | 'plies' | 'garments' | 'lays'>): Phrase {
  if (order.kind === 'LEATHER') return phrase('plan.leather', { count: order.garments })
  return phrase('plan.fabric', { lays: order.lays.count, plies: order.plies ?? 0, garments: order.garments })
}

// ---- the list: cut orders beside the work orders' leather cuts ------------------------------------------------------------------

/** One row of the Cutting list: a cut order (W2b) or a work order's leather cut (W2a). Keyed `CO:<id>` / `WO:<id>`. */
export type ListRow = { readonly key: string; readonly order: CutOrderSummary; readonly cut: null } | { readonly key: string; readonly order: null; readonly cut: CutRow }

export const orderKey = (id: string): string => `CO:${id}`
export const cutKey = (workOrderId: string): string => `WO:${workOrderId}`

/**
 * The cut orders' read for a saved filter of the Cutting page (null: none, the filter is about the work orders' cuts only):
 * Waiting reads the open ones and keeps the planned and released (the list's `waitingOrders`), Held has no cut order (a cut
 * order is not held: its work order is).
 */
export function orderViewOf(view: CutView): CutOrderView | null {
  if (view === 'held') return null
  if (view === 'waiting') return 'open'
  if (view === 'cutting') return 'cutting'
  if (view === 'cut') return 'cut'
  if (view === 'all') return 'all'
  return 'open'
}

/** The rows of a saved filter: the cut orders (newest first) and then the work orders' leather cuts. */
export function listRows(view: CutView, orders: readonly CutOrderSummary[] | null, cuts: readonly CutRow[] | null): ListRow[] {
  const kept = (orders ?? []).filter((order) => view !== 'waiting' || order.status === 'PLANNED' || order.status === 'RELEASED')
  return [...kept.map((order) => ({ key: orderKey(order.id), order, cut: null })), ...(cuts ?? []).map((cut) => ({ key: cutKey(cut.workOrder.id), order: null, cut }))]
}

/**
 * The fabric cut orders in the tiles Waiting to cut and Cutting now (a leather cut order's work orders are already counted by
 * their cuts): planned + released wait, in progress is cutting; null while unknown.
 */
export function fabricTiles(fabric: CutOrderTiles | null): { waiting: number; cutting: number } | null {
  return fabric ? { waiting: fabric.planned + fabric.released, cutting: fabric.cutting } : null
}

/** The day a cut order last moved: cut, else released, else made. */
export const orderDate = (order: Pick<CutOrderSummary, 'cutAt' | 'releasedAt' | 'createdAt'>): string => order.cutAt ?? order.releasedAt ?? order.createdAt

const csvCell = (value: string | number) => {
  const text = String(value)
  return /[",\n;]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/**
 * Export N (CSV): the rows selected as the columns show them — a cut order (its work orders, garments and plies) or a work
 * order's leather cut (hides, area per unit, yield). Never who cut.
 */
export function listCsv(rows: readonly ListRow[], header: readonly string[], areaText: (cut: CutRow) => string): string {
  const lines = rows.map((row) => {
    if (row.order) {
      const order = row.order
      return [order.number, order.kind, order.workOrders.map((workOrder) => workOrder.number).join(' '), order.styles.map((style) => style.code).join(' '), orderMaterial(order), '', order.status, order.garments, '', order.plies ?? '', '', '', '', order.station?.code ?? '', orderDate(order)]
    }
    const cut = row.cut
    return [cut.workOrder.number, 'LEATHER', cut.workOrder.number, cut.style.code, cut.materials.map((material) => [material.code, material.colourCode].filter(Boolean).join(' · ')).join(', '), cut.lots.map((lot) => lot.dyeBatch ?? lot.code).join(' '), cut.state, cut.pieces.planned, cut.pieces.cut, '', cut.hides.count, areaText(cut), cut.yield.yieldPct ?? '', cut.stations.map((station) => station.code).join(' '), cut.lastCutAt ?? '']
  })
  return [header, ...lines].map((line) => line.map(csvCell).join(',')).join('\n')
}

// ---- refusals in words -------------------------------------------------------------------------------------------------------

const KNOWN_REFUSALS: ReadonlySet<string> = new Set([...CUT_ORDER_REFUSALS, ...ALLOCATION_REFUSALS, ...TICKET_REFUSALS, ...RECONCILE_REFUSALS, 'FLOOR_NOT_READY'])

/** A body path's words (the API's 400 issues). */
const FIELD_WORDS: readonly (readonly [RegExp, string])[] = [
  [/^body\/lines\/\d+\/ratio$/, 'problem.field.ratio'],
  [/^body\/lines\/\d+\/quantity$/, 'problem.field.quantity'],
  [/^body\/lines\/\d+\/reasonCode$/, 'problem.field.reason'],
  [/^body\/lines\/\d+\/note$/, 'problem.field.note'],
  [/^body\/lines(\/\d+\/(lineId|workOrderSizeId))?$/, 'problem.field.lines'],
  [/^body\/marker/, 'problem.field.marker'],
  [/^body\/plies$/, 'problem.field.plies'],
  [/^body\/lays/, 'problem.field.lays'],
  [/^body\/stationId$/, 'problem.field.station'],
  [/^body\/printerId$/, 'problem.field.printer'],
  [/^body\/reason$/, 'problem.field.reason'],
  [/^body\/rolls/, 'problem.field.rolls'],
]

/** A refused write in this app's words: the rule the API named (`refusal/<CODE>`), a field of the body, else by its kind. */
export function orderProblem(error: unknown): Phrase {
  if (!isApiError(error)) return phrase('problem.write')
  for (const issue of error.issues) {
    const path = issuePath(issue)
    const code = /(?:^|\/)refusal\/([A-Z_]+)$/.exec(path)?.[1] ?? null
    if (code && KNOWN_REFUSALS.has(code)) return phrase(`refusal.${code}`)
    const field = FIELD_WORDS.find(([pattern]) => pattern.test(path))
    if (field) return phrase(field[1])
  }
  if (error.kind === 'conflict') return phrase('problem.changed')
  if (error.kind === 'forbidden' || error.kind === 'step_up') return phrase('problem.forbidden')
  if (error.kind === 'not_found') return phrase('problem.gone')
  if (error.kind === 'invalid') return phrase('problem.invalid')
  if (error.kind === 'unavailable') return phrase('problem.offline')
  return phrase('problem.write')
}

// ---- New cut order -------------------------------------------------------------------------------------------------------------

/** One material and colour at one site: what New cut order groups (cells of several work orders). */
export const groupKeyOf = (group: Pick<WaitingGroup, 'kind' | 'siteId' | 'item' | 'colour'>): string => `${group.kind}|${group.siteId}|${group.item.id}|${group.colour?.id ?? '-'}`

export interface NewOrderDraft {
  readonly groupKey: string | null
  /** The cells ticked (work order sizes). */
  readonly picked: readonly string[]
  /** FABRIC: each cell's garments in one ply of the marker (typed). */
  readonly ratio: Readonly<Record<string, string>>
  /** LEATHER: each cell's garments (typed; empty = what is left). */
  readonly quantity: Readonly<Record<string, string>>
  readonly markerName: string
  /** In metres. */
  readonly markerLength: string
  /** In centimetres; optional. */
  readonly markerWidth: string
  readonly plies: string
  /** How many lays the plies are split in. */
  readonly lays: string
  readonly stationId: string
  /** YYYY-MM-DD; optional. */
  readonly dueDate: string
}

export const NO_DRAFT: NewOrderDraft = Object.freeze({ groupKey: null, picked: [], ratio: {}, quantity: {}, markerName: '', markerLength: '', markerWidth: '', plies: '', lays: '1', stationId: '', dueDate: '' }) as NewOrderDraft

const WHOLE = /^\d{1,7}$/
const DECIMAL = /^\d{1,7}([.,]\d{1,4})?$/
const decimal = (text: string): string => text.trim().replace(',', '.')
const whole = (text: string): number | null => (WHOLE.test(text.trim()) ? Number(text.trim()) : null)

/** The plies of each lay: the plies split as even as can be (bigger lays first); null while plies or lays are not right. */
export function layPlies(draft: Pick<NewOrderDraft, 'plies' | 'lays'>): number[] | null {
  const plies = whole(draft.plies)
  const lays = whole(draft.lays)
  if (!plies || !lays || plies > CUT_ORDER_LIMITS.plies || lays > CUT_ORDER_LIMITS.lays || lays > plies) return null
  return splitPlies(plies, lays)
}

/** A cell's garments on the new cut order (FABRIC: ratio × plies; LEATHER: typed, else what is left); null while not a number. */
export function cellGarments(draft: NewOrderDraft, group: Pick<WaitingGroup, 'kind'>, cell: Pick<WaitingCell, 'workOrderSizeId' | 'left'>): number | null {
  if (group.kind === 'LEATHER') {
    const typed = draft.quantity[cell.workOrderSizeId] ?? ''
    return typed.trim() === '' ? cell.left : whole(typed)
  }
  const ratio = whole(draft.ratio[cell.workOrderSizeId] ?? '1')
  const plies = whole(draft.plies)
  return ratio !== null && plies !== null ? ratio * plies : null
}

/** The sizes of the marker as the table reads them ("46:1 · 48:2"): the ticked cells' ratios. */
export function draftRatio(draft: NewOrderDraft, group: WaitingGroup): string {
  return ratioText(group.cells.filter((cell) => draft.picked.includes(cell.workOrderSizeId)).map((cell) => ({ size: cell.size, ratio: whole(draft.ratio[cell.workOrderSizeId] ?? '1') })))
}

/** Why a cell cannot be ticked (else null): nothing left for a new cut order. */
export function cellHeld(cell: Pick<WaitingCell, 'left'>): Phrase | null {
  return cell.left <= 0 ? phrase('newOrder.why.full') : null
}

/** Why Create cut order is held (else null): the right, a material, a cell, the marker, the plies and lays, each cell's garments. */
export function newOrderHeld(draft: NewOrderDraft, group: WaitingGroup | null, can: OrdersCan, busy: boolean): Phrase | null {
  if (!can.manage) return phrase('held.permission', { permission: 'production.cutorders.manage' })
  if (busy) return phrase('held.busy')
  if (!group) return phrase('newOrder.held.group')
  const picked = group.cells.filter((cell) => draft.picked.includes(cell.workOrderSizeId))
  if (picked.length === 0) return phrase('newOrder.held.cells')
  if (picked.length > CUT_ORDER_LIMITS.lines) return phrase('newOrder.held.tooMany', { max: CUT_ORDER_LIMITS.lines })
  if (group.kind === 'FABRIC') {
    const name = draft.markerName.trim()
    if (name === '' || name.length > CUT_ORDER_LIMITS.markerName) return phrase('newOrder.held.markerName')
    const length = decimal(draft.markerLength)
    if (!DECIMAL.test(length) || Number(length) <= 0 || Number(length) > CUT_ORDER_LIMITS.markerMetres) return phrase('newOrder.held.markerLength', { max: CUT_ORDER_LIMITS.markerMetres })
    const width = decimal(draft.markerWidth)
    if (width !== '' && (!DECIMAL.test(width) || Number(width) <= 0 || Number(width) > CUT_ORDER_LIMITS.markerWidthCm)) return phrase('newOrder.held.markerWidth', { max: CUT_ORDER_LIMITS.markerWidthCm })
    const plies = whole(draft.plies)
    if (!plies || plies > CUT_ORDER_LIMITS.plies) return phrase('newOrder.held.plies', { max: CUT_ORDER_LIMITS.plies })
    const split = layPlies(draft)
    if (!split) return phrase('newOrder.held.lays', { max: Math.min(CUT_ORDER_LIMITS.lays, plies) })
    if (Math.max(...split) > CUT_ORDER_LIMITS.pliesPerLay) return phrase('newOrder.held.layTooHigh', { max: CUT_ORDER_LIMITS.pliesPerLay })
    for (const cell of picked) {
      const ratio = whole(draft.ratio[cell.workOrderSizeId] ?? '1')
      if (!ratio || ratio > CUT_ORDER_LIMITS.ratio) return phrase('newOrder.held.ratio', { cell: `${cell.workOrder.number} ${cell.colourway.code} ${cell.size}`, max: CUT_ORDER_LIMITS.ratio })
      if (ratio * plies > cell.left) return phrase('newOrder.held.beyond', { cell: `${cell.workOrder.number} ${cell.colourway.code} ${cell.size}`, garments: ratio * plies, left: cell.left })
    }
  } else {
    for (const cell of picked) {
      const garments = cellGarments(draft, group, cell)
      if (!garments || garments < 1) return phrase('newOrder.held.quantity', { cell: `${cell.workOrder.number} ${cell.colourway.code} ${cell.size}` })
      if (garments > cell.left) return phrase('newOrder.held.beyond', { cell: `${cell.workOrder.number} ${cell.colourway.code} ${cell.size}`, garments, left: cell.left })
    }
  }
  if (draft.dueDate !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(draft.dueDate)) return phrase('newOrder.held.due')
  return null
}

/** The body of POST /production/cut-orders for a draft New cut order holds nothing back on. */
export function newOrderBody(draft: NewOrderDraft, group: WaitingGroup): CreateBody {
  const picked = group.cells.filter((cell) => draft.picked.includes(cell.workOrderSizeId))
  const common = { siteId: group.siteId, kind: group.kind, itemId: group.item.id, itemColourId: group.colour?.id ?? null, ...(draft.stationId ? { stationId: draft.stationId } : {}), ...(draft.dueDate ? { dueDate: draft.dueDate } : {}) }
  if (group.kind === 'LEATHER') return { ...common, lines: picked.map((cell) => ({ workOrderSizeId: cell.workOrderSizeId, quantity: cellGarments(draft, group, cell)! })) }
  const width = decimal(draft.markerWidth)
  return {
    ...common,
    marker: { name: draft.markerName.trim(), length: decimal(draft.markerLength), uom: 'M', ...(width ? { widthCm: width } : {}) },
    plies: whole(draft.plies)!,
    lays: layPlies(draft)!,
    lines: picked.map((cell) => ({ workOrderSizeId: cell.workOrderSizeId, ratio: whole(draft.ratio[cell.workOrderSizeId] ?? '1')! })),
  }
}

/** The draft's garments in all (the ticked cells). */
export function draftGarments(draft: NewOrderDraft, group: WaitingGroup | null): number {
  if (!group) return 0
  return group.cells.filter((cell) => draft.picked.includes(cell.workOrderSizeId)).reduce((sum, cell) => sum + (cellGarments(draft, group, cell) ?? 0), 0)
}

// ---- the record --------------------------------------------------------------------------------------------------------------

export const ORDER_TABS = ['lay', 'pieces', 'yield', 'tickets'] as const
export type OrderTab = (typeof ORDER_TABS)[number]
export const orderTabOf = (value: string | null | undefined): OrderTab => ((ORDER_TABS as readonly string[]).includes(value ?? '') ? (value as OrderTab) : 'lay')

/** The lays that count (not cancelled), in their order. */
export const liveLays = (record: Pick<CutOrderRecord, 'lays'>): LayView[] => record.lays.filter((lay) => lay.status !== 'CANCELLED').sort((a, b) => a.seq - b.seq)

/** A lay's length on the table, in metres: its own (set when spread), else the marker's. */
export function layLength(lay: Pick<LayView, 'layLength' | 'lengthUom'>, marker: CutOrderRecord['cutOrder']['marker']): string | null {
  const metres = (value: string | null, uom: string | null): string | null => {
    if (value === null || uom === null) return null
    const factor = uom === 'CM' ? 0.01 : uom === 'MM' ? 0.001 : 1
    return String(Number(value) * factor)
  }
  return metres(lay.layLength, lay.lengthUom) ?? metres(marker?.length ?? null, marker?.uom ?? null)
}

/** A lay's shade as a person reads it: its rolls' shade group label or shade words; null: no roll yet. */
export const layShade = (lay: Pick<LayView, 'rolls' | 'shade'>): string | null => (lay.rolls.length === 0 ? null : (lay.shade ?? '—'))

/** Why Release is held (else null). */
export function releaseHeld(record: CutOrderRecord, can: OrdersCan, busy: boolean): Phrase | null {
  if (!can.manage) return phrase('held.permission', { permission: 'production.cutorders.manage' })
  if (record.cutOrder.status !== 'PLANNED') return phrase('held.release.status', { status: record.cutOrder.status })
  if (busy) return phrase('held.busy')
  return null
}

/** Why Back to planning is held (else null). */
export function backHeld(record: CutOrderRecord, can: OrdersCan, busy: boolean): Phrase | null {
  if (!can.manage) return phrase('held.permission', { permission: 'production.cutorders.manage' })
  if (record.cutOrder.status !== 'RELEASED') return phrase('held.back.status')
  if (!record.can.backToPlanning) return phrase('held.back.started')
  if (busy) return phrase('held.busy')
  return null
}

/** Why Cancel is held (else null). */
export function cancelHeld(record: CutOrderRecord, can: OrdersCan, busy: boolean): Phrase | null {
  if (!can.manage) return phrase('held.permission', { permission: 'production.cutorders.manage' })
  if (record.cutOrder.status !== 'PLANNED' && record.cutOrder.status !== 'RELEASED') return phrase('held.cancel.status')
  if (!record.can.cancel) return phrase('held.cancel.started')
  if (busy) return phrase('held.busy')
  return null
}

/** A typed reason long enough (3 to 500 characters). */
export const reasonOk = (value: string): boolean => value.trim().length >= 3 && value.trim().length <= CUT_ORDER_LIMITS.reason

// ---- Allocate rolls ---------------------------------------------------------------------------------------------------------------

/** Why a lay takes no roll now (else null): the right, the cut order released, the lay planned. */
export function allocateHeld(record: CutOrderRecord, lay: LayView, can: OrdersCan): Phrase | null {
  if (!can.manage) return phrase('held.permission', { permission: 'production.cutorders.manage' })
  if (record.cutOrder.kind !== 'FABRIC') return phrase('held.rolls.leather')
  if (record.cutOrder.status !== 'RELEASED' && record.cutOrder.status !== 'IN_PROGRESS') return phrase('held.rolls.notReleased')
  if (lay.status !== 'PLANNED') return phrase('held.rolls.layAtTable', { seq: lay.seq })
  if (lay.allocated >= lay.plies) return phrase('held.rolls.layFull', { seq: lay.seq })
  return null
}

/** A roll's shade words ("A", "Black 01"); null: unknown. */
export const rollShade = (roll: Pick<RollCandidate, 'shadeGroup' | 'shade'>): string | null => roll.shadeGroup?.label ?? roll.shade ?? null

/** The key the database compares a lay's rolls by: the shade group and the shade words. */
const shadeKey = (roll: { readonly shadeGroupId: string | null; readonly shade: string | null }): string => JSON.stringify([roll.shadeGroupId, roll.shade])
const candidateKey = (roll: Pick<RollCandidate, 'shadeGroup' | 'shade'>): string => shadeKey({ shadeGroupId: roll.shadeGroup?.id ?? null, shade: roll.shade })

/** The plies each ticked roll gives the lay, in the order ticked: what it gives, up to what the lay still needs. */
export function pickedPlies(lay: Pick<LayView, 'plies' | 'allocated'>, picked: readonly RollCandidate[]): Map<string, number> {
  let need = Math.max(0, lay.plies - lay.allocated)
  const out = new Map<string, number>()
  for (const roll of picked) {
    const take = Math.min(roll.plies, need)
    out.set(roll.id, take)
    need -= take
  }
  return out
}

/**
 * Why a roll cannot be ticked for the lay (else null), the API's rules ahead of it: its own refusal (not in stock, rejected, a
 * held or unusable lot, too narrow, no whole ply), already on this lay, another shade group or another shrinkage group than the
 * lay's rolls (one lay is cut from one shade and one shrinkage group: mixing is refused with the reason), the lay full.
 */
export function rollHeld(roll: RollCandidate, lay: LayView, picked: readonly RollCandidate[], number: string): Phrase | null {
  if (roll.refusal) return phrase(`refusal.${roll.refusal.code}`)
  if (roll.plies <= 0) return phrase('refusal.ROLL_SHORT')
  if (lay.rolls.some((row) => row.rollId === roll.id) || roll.allocatedTo.some((row) => row.cutOrderNumber === number && row.laySeq === lay.seq)) return phrase('rolls.why.mine', { seq: lay.seq })
  const first = lay.rolls[0] ?? null
  const firstPicked = picked.find((row) => row.id !== roll.id) ?? null
  const layKey = first ? shadeKey(first) : firstPicked ? candidateKey(firstPicked) : null
  if (layKey !== null && layKey !== candidateKey(roll)) {
    const layWords = first ? (first.shade ?? null) : firstPicked ? rollShade(firstPicked) : null
    return phrase('rolls.why.shade', { seq: lay.seq, lay: layWords ?? '—', roll: rollShade(roll) ?? '—' })
  }
  const groups = [...lay.rolls.map((row) => row.shrinkageGroup), ...picked.filter((row) => row.id !== roll.id).map((row) => row.shrinkageGroup)].filter((group): group is string => group !== null)
  if (roll.shrinkageGroup !== null && groups.length > 0 && groups[0] !== roll.shrinkageGroup) return phrase('rolls.why.shrinkage', { seq: lay.seq, lay: groups[0]!, roll: roll.shrinkageGroup })
  const taken = [...pickedPlies(lay, picked.filter((row) => row.id !== roll.id)).values()].reduce((sum, value) => sum + value, 0)
  if (!picked.some((row) => row.id === roll.id) && lay.allocated + taken >= lay.plies) return phrase('rolls.why.full', { seq: lay.seq })
  return null
}

/**
 * The rolls a selection may keep, in the order ticked: each checked against the lay and the rolls kept before it (a grid that drew
 * its boxes before a tick changed the lay's group cannot slip in a roll of another group).
 */
export function allowedRolls(ids: readonly string[], rolls: readonly RollCandidate[], lay: LayView, number: string): string[] {
  const kept: RollCandidate[] = []
  for (const rollId of ids) {
    const roll = rolls.find((row) => row.id === rollId)
    if (roll && rollHeld(roll, lay, kept, number) === null) kept.push(roll)
  }
  return kept.map((roll) => roll.id)
}

/** What decides which rolls may be ticked now: the lay's shade and shrinkage group (its rolls, else the first ticked) and whether it is full. */
export function rollsGate(lay: LayView, picked: readonly RollCandidate[]): string {
  const first = lay.rolls[0] ?? null
  const key = first ? shadeKey(first) : picked[0] ? candidateKey(picked[0]) : ''
  const shrinkage = [...lay.rolls.map((row) => row.shrinkageGroup), ...picked.map((row) => row.shrinkageGroup)].find((group) => group !== null) ?? ''
  const given = [...pickedPlies(lay, picked).values()].reduce((sum, value) => sum + value, 0)
  return `${key}|${shrinkage}|${lay.allocated + given >= lay.plies}`
}

/** The proposal's rolls for this lay (ends and part rolls first, one shade and shrinkage group), as candidates. */
export function proposalFor(candidates: RollCandidates, layId: string): RollCandidate[] {
  const proposed = candidates.proposal.find((row) => row.layId === layId)
  return (proposed?.rolls ?? []).map((row) => candidates.rolls.find((roll) => roll.id === row.rollId)).filter((roll): roll is RollCandidate => !!roll)
}

/** Why Allocate N rolls is held (else null). */
export function allocateGoHeld(record: CutOrderRecord, lay: LayView, picked: readonly RollCandidate[], can: OrdersCan, busy: boolean): Phrase | null {
  const held = allocateHeld(record, lay, can)
  if (held) return held
  if (busy) return phrase('held.busy')
  if (picked.length === 0) return phrase('rolls.held.none')
  return null
}

/** The rolls of a lay in words: "RL-1 (A) 6 · RL-2 (A) 4". */
export const layRollsText = (lay: Pick<LayView, 'rolls'>): string => lay.rolls.map((roll) => `${roll.code}${roll.shade ? ` (${roll.shade})` : ''} ${roll.plies}`).join(' · ')

// ---- Tickets -----------------------------------------------------------------------------------------------------------------------

/** Why a ticket cannot be printed (else null): a void or done ticket is never printed again. */
export function printHeld(ticket: CutTicket, can: OrdersCan, busy: boolean): Phrase | null {
  if (!can.manage) return phrase('held.permission', { permission: 'production.cutorders.manage' })
  if (ticket.status === 'VOID') return phrase('held.ticket.void')
  if (ticket.status === 'DONE') return phrase('held.ticket.done')
  if (busy) return phrase('held.busy')
  return null
}

/** Why a ticket cannot be voided (else null): a done or void ticket stays. */
export function voidHeld(ticket: CutTicket, can: OrdersCan, busy: boolean): Phrase | null {
  if (!can.manage) return phrase('held.permission', { permission: 'production.cutorders.manage' })
  if (ticket.status === 'VOID') return phrase('held.ticket.void')
  if (ticket.status === 'DONE') return phrase('held.ticket.done')
  if (busy) return phrase('held.busy')
  return null
}

/** Why Print N tickets is held for a selection (else null). */
export function printManyHeld(tickets: readonly CutTicket[], can: OrdersCan, busy: boolean): Phrase | null {
  if (tickets.length === 0) return phrase('tickets.held.none')
  for (const ticket of tickets) {
    const held = printHeld(ticket, can, busy)
    if (held) return held
  }
  return null
}

// ---- Reconcile cut ---------------------------------------------------------------------------------------------------------------

export interface ReconcileDraft {
  /** The variance reason per line (a code of the list). */
  readonly reason: Readonly<Record<string, string>>
  readonly note: Readonly<Record<string, string>>
}
export const NO_RECONCILE: ReconcileDraft = Object.freeze({ reason: {}, note: {} }) as ReconcileDraft

export const VARIANCE_REASONS = CUT_VARIANCE_REASONS

/** The lines still to reconcile. */
export const openLines = (recon: Reconciliation) => recon.lines.filter((line) => line.reconciled === null)

/** Why Reconcile is held (else null): the right, the cut order cut and its fabric confirmed, a reason per line that differs. */
export function reconcileHeld(recon: Reconciliation | null, draft: ReconcileDraft, can: OrdersCan, busy: boolean): Phrase | null {
  if (!can.manage) return phrase('held.permission', { permission: 'production.cutorders.manage' })
  if (!recon) return phrase('held.loading')
  if (recon.refusal) return phrase(`refusal.${recon.refusal.code}`)
  if (busy) return phrase('held.busy')
  for (const line of openLines(recon)) {
    if (!line.needsReason) continue
    const code = draft.reason[line.id] ?? ''
    if (!code) return phrase('reconcile.held.reason', { seq: line.seq, cut: line.cut, ordered: line.ordered })
    if (code === 'OTHER' && !(draft.note[line.id] ?? '').trim()) return phrase('reconcile.held.note', { seq: line.seq })
  }
  return null
}

/** The body of POST …/reconcile: a reason (and words) on each line that differs, the others named alone. */
export function reconcileBody(recon: Reconciliation, draft: ReconcileDraft): { version: number; lines: { lineId: string; reasonCode?: string; note?: string | null }[] } {
  return {
    version: recon.cutOrder.version,
    lines: openLines(recon).map((line) => {
      const note = (draft.note[line.id] ?? '').trim()
      return line.needsReason ? { lineId: line.id, reasonCode: draft.reason[line.id]!, ...(note ? { note } : {}) } : { lineId: line.id, ...(note ? { note } : {}) }
    }),
  }
}

/** A signed difference ("+2", "−3", "0"). */
export const signed = (value: number): string => (value > 0 ? `+${value}` : value < 0 ? `−${Math.abs(value)}` : '0')

/** Used against the estimate, as a phrase ("0.6 m more than the estimate (+5 %)"); null when nothing was estimated. */
export function usedAgainstEstimate(sum: { readonly used: string; readonly estimated: string }, locale: string): Phrase | null {
  const used = Number(sum.used)
  const estimated = Number(sum.estimated)
  if (!(estimated > 0)) return null
  const difference = used - estimated
  if (Math.abs(difference) < 0.00005) return phrase('material.asEstimated')
  const pct = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(Math.abs((difference * 100) / estimated))
  return phrase(difference > 0 ? 'material.more' : 'material.less', { metres: decimalText(Math.abs(difference), locale), pct })
}

// ---- Yield of a leather cut: issued vs used vs returned, and the supplier lot feedback ----------------------------------------

export interface AreaBalance {
  readonly uom: string
  readonly hides: number
  readonly issued: number
  readonly cut: number
  readonly waste: number
  readonly returned: number
  readonly left: number
}

/**
 * The work order's leather, issued against used against returned (MES-045 for leather; the W2b reconciliation of the Yield
 * tab): the hides of the cut log summed per unit (areas of different units are never added); `fallbackUom` for a hide with no
 * cut entry (the work order's one leather unit, else none).
 */
export function areaBalance(log: Pick<CutLog, 'hides' | 'entries'>, figures: Pick<WorkOrderYield, 'hides'> | null, fallbackUom = ''): AreaBalance[] {
  const unitOf = new Map<string, string>()
  for (const entry of log.entries) unitOf.set(entry.hideId, entry.uom)
  for (const hide of figures?.hides ?? []) unitOf.set(hide.hide.id, hide.item.uom)
  const sums = new Map<string, AreaBalance>()
  for (const hide of log.hides) {
    // A hide never cut here has no entry: the work order's leather unit (when it has one) is its unit.
    const uom = unitOf.get(hide.hideId) ?? fallbackUom
    const sum = sums.get(uom) ?? { uom, hides: 0, issued: 0, cut: 0, waste: 0, returned: 0, left: 0 }
    sums.set(uom, { uom, hides: sum.hides + 1, issued: sum.issued + Number(hide.issued), cut: sum.cut + Number(hide.cut), waste: sum.waste + Number(hide.waste), returned: sum.returned + Number(hide.returned), left: sum.left + Number(hide.left) })
  }
  return [...sums.values()]
}

/** How far a lot's yield is from the plan, in points (null: unknown). */
export function againstPlan(yieldPct: string | null, plannedPct: string | null): number | null {
  if (yieldPct === null || plannedPct === null) return null
  return Math.round((Number(yieldPct) - Number(plannedPct)) * 10) / 10
}

/** A lot that yields more than two points below the plan: worth a word to the supplier. */
export const underPlan = (points: number | null): boolean => points !== null && points < -2

/**
 * Why "Raise with the supplier" (a supplier claim on the lot, which the supplier's Quality & rating counts) is held for a lot
 * (else null): the buying side's right, a supplier on the lot.
 */
export function feedbackHeld(lot: { readonly supplier: string | null }, claims: boolean): Phrase | null {
  if (!claims) return phrase('held.permission', { permission: 'purchasing.claims.manage' })
  if (!lot.supplier) return phrase('feedback.held.noSupplier')
  return null
}

// ---- the leather cut's same shade lot check -----------------------------------------------------------------------------------

export interface ShadeLot {
  readonly lot: string
  readonly shade: string | null
  readonly hides: number
}

/**
 * The shade lots of a work order's leather (SCM-206 "one shade lot per order"): the hides cut (their lot and shade) and the hides
 * allocated and not cut yet (their lot). One lot and shade: the order is cut from one shade lot; more: the cutting table warns
 * and a lead signs Cut anyway, the reserve refuses another lot without inventory.shade.override.
 */
export function shadeLots(hides: readonly { readonly lotCode: string; readonly shade: string | null }[], allocated: readonly Pick<Allocation, 'lot'>[]): ShadeLot[] {
  const lots = new Map<string, ShadeLot>()
  const add = (lot: string, shade: string | null) => {
    const key = JSON.stringify([lot, shade])
    const found = lots.get(key)
    lots.set(key, { lot, shade, hides: (found?.hides ?? 0) + 1 })
  }
  for (const hide of hides) add(hide.lotCode, hide.shade)
  for (const row of allocated) {
    const code = row.lot?.code
    if (!code) continue
    // An allocated hide's shade is its lot's: it joins a known shade of that lot when there is one.
    const known = [...lots.values()].find((entry) => entry.lot === code)
    add(code, known?.shade ?? null)
  }
  return [...lots.values()]
}

// ---- the lay sheet (a new tab) ------------------------------------------------------------------------------------------------

export interface SheetAddress {
  readonly id: string | null
  readonly lay: string | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function sheetAddressOf(params: { get(name: string): string | null } | null): SheetAddress {
  const id = params?.get('id') ?? ''
  const lay = params?.get('lay') ?? ''
  return { id: UUID.test(id) ? id : null, lay: UUID.test(lay) ? lay : null }
}

/** The lay sheet's address (a new tab): one cut order, all its lays or one. */
export function sheetHref(prefix: string, cutOrderId: string, layId?: string | null): string {
  return `${prefix}/production/cutting/sheet?id=${encodeURIComponent(cutOrderId)}${layId ? `&lay=${encodeURIComponent(layId)}` : ''}`
}

export const orderHref = (prefix: string, cutOrderId: string, tab?: OrderTab): string => `${prefix}/production/cutting/orders/${encodeURIComponent(cutOrderId)}${tab && tab !== 'lay' ? `?tab=${tab}` : ''}`

/** The ticket's label as the printer prints it (factory-domain `ticketLines` takes this shape). */
export function ticketFacts(record: CutOrderRecord, lay: LayView | null, language: 'it' | 'en', maker: string | null) {
  const order = record.cutOrder
  const of = liveLays(record).length
  const lines = record.lines
  const styles = [...new Set(lines.map((line) => line.style.code))].join(', ')
  return {
    code: lay?.ticket?.code ?? record.tickets.find((ticket) => ticket.layId === null && ticket.status !== 'VOID')?.code ?? '',
    language,
    maker,
    cutOrderNumber: order.number,
    kind: order.kind,
    lay: lay ? { seq: lay.seq, of, plies: lay.plies } : null,
    material: [order.material.item.code, order.material.colour?.code, order.material.item.name].filter(Boolean).join(' '),
    marker: order.marker ? `${order.marker.name}${order.marker.length ? ` · ${Number(order.marker.length)} ${(order.marker.uom ?? 'M').toLowerCase()}` : ''}` : null,
    ratio: order.marker?.ratio ?? null,
    styles,
    workOrders: [...new Set(lines.map((line) => line.workOrder.number))].join(', '),
    garments: lay ? (order.marker?.garmentsPerPly ?? 0) * lay.plies : order.garments,
    due: order.dueDate,
  }
}

/** The garments a lay cuts of a line: its ratio × the lay's plies (fabric); a leather line: its garments. */
export const lineGarments = (line: Pick<CutOrderRecord['lines'][number], 'ratio' | 'quantity'>, lay: Pick<LayView, 'plies'> | null): number => (lay && line.ratio !== null ? line.ratio * lay.plies : line.quantity)

/** A cut ticket as LabelPreview draws it: the heading, the title, the Code 128 of its scan code, the fields in two columns. */
export function ticketLayout(lines: { readonly heading: string; readonly title: string; readonly fields: readonly { readonly label: string; readonly value: string }[] }, code: string): LabelLayout {
  return {
    name: lines.heading,
    widthMm: 100,
    heightMm: 60,
    blocks: [
      { kind: 'text', text: lines.heading },
      { kind: 'title', text: lines.title, size: 'md' },
      ...(code ? [{ kind: 'barcode' as const, value: code, heightMm: 9 }] : []),
      { kind: 'fields', columns: 2, fields: lines.fields.map((field) => ({ label: field.label, value: field.value, size: 'sm' as const })) },
    ],
  }
}
