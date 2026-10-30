import { isApiError, issuePath } from '../../../../lib/api/errors'
import type { LiveState } from '../../../_shared/buying/hooks'
import type { MaterialDetail, MaterialOption } from '../../../_shared/buying/api'
import type { RecordPanelsViewModel } from '../../../../record-panels/model'
import type { BundleOption, KitDdtReason, OrderAction, OutsideOperations, ReceiveAnswer, ReceiveBody, SendKitAnswer, SendKitBody, SubcontractOrder, TransportBy, WorkshopStockRow } from '../api'
import { plannedLines, words, type SubcontractCan, type Words } from '../model'

/**
 * The subcontract order's record (SCR-128 "Record: Subcontract order"; design purchasing.subcontracting rec), pure: its
 * tabs, the band's primary act by state, the cell-by-cell save marks of a draft's operations, the dialogs' drafts and
 * what holds them, the bodies they send, and every answer and refusal in this app's words (keys of the
 * `subcontract-order` catalogue; never the API's English). The view takes `SubcontractRecordModel`; the container
 * (SubcontractRecord.tsx) reads and writes.
 */

// ---- tabs ---------------------------------------------------------------------------------------------------------------------

export const RECORD_TABS = ['ops', 'kit', 'back', 'documents', 'activity'] as const
export type RecordTab = (typeof RECORD_TABS)[number]
export const tabOf = (value: string | null | undefined): RecordTab => ((RECORD_TABS as readonly string[]).includes(value ?? '') ? (value as RecordTab) : 'ops')

/** A part read beside the order: its value, or why it is missing (both null: still loading). */
export interface Part<T> {
  value: T | null
  problem: string | null
}
export const LOADING: Part<never> = Object.freeze({ value: null, problem: null })
export const ready = <T>(value: T): Part<T> => ({ value, problem: null })

export type Loaded<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; problem: string } | { status: 'not_found' } | { status: 'forbidden' }

// ---- the band ---------------------------------------------------------------------------------------------------------------------

/** The band's main act by state: issue a draft, send the kit of a sent order, receive back while out, close once back. */
export function primaryAct(order: Pick<SubcontractOrder, 'status' | 'kitLines' | 'operations'>): OrderAction | null {
  switch (order.status) {
    case 'DRAFT':
      return 'issue'
    case 'ISSUED':
      return 'send'
    case 'AT_WORKSHOP':
    case 'PARTLY_RECEIVED':
      return 'receive'
    case 'RECEIVED':
      return 'close'
    default:
      return null
  }
}

/** Send kit stays beside Receive back while something is still planned or left to send. */
export function sendBeside(order: SubcontractOrder): boolean {
  if (order.status !== 'AT_WORKSHOP' && order.status !== 'PARTLY_RECEIVED') return false
  return plannedLines(order).length > 0 || order.operations.some((operation) => operation.piecesSent < operation.pieces)
}

/** The newest live kit DDT (the band's Print kit DDT). */
export const liveDdt = (order: Pick<SubcontractOrder, 'ddts'>) => order.ddts.find((ddt) => !ddt.cancelled) ?? null

// ---- a draft's operations: one cell at a time -------------------------------------------------------------------------------

export const CELL_FIELDS = ['pieces', 'pricePerPiece', 'expectedBackDate', 'note'] as const
export type CellField = (typeof CELL_FIELDS)[number]
export const cellKey = (operationId: string, field: CellField | 'sizes') => `${operationId}:${field}`

/** A cell's save as it stands: in flight, saved, or not saved with why. */
export type SaveMark = { state: 'saving' } | { state: 'saved' } | { state: 'failed'; words: Words }

/** A typed cell → the operation's change, or why it is not sent (null value: nothing changed). */
export function cellPatch(field: CellField, typed: string, before: SubcontractOrder['operations'][number]): { patch: Record<string, unknown> | null; problem: Words | null } {
  const text = typed.trim()
  switch (field) {
    case 'pieces': {
      if (!/^\d+$/.test(text) || Number(text) < 1) return { patch: null, problem: words('ops.cell.piecesWhole') }
      return Number(text) === before.pieces ? { patch: null, problem: null } : { patch: { pieces: Number(text) }, problem: null }
    }
    case 'pricePerPiece': {
      const value = text.replace(',', '.')
      if (!/^\d+(\.\d{1,6})?$/.test(value)) return { patch: null, problem: words('ops.cell.feeNumber') }
      return before.pricePerPiece !== undefined && Number(value) === Number(before.pricePerPiece) ? { patch: null, problem: null } : { patch: { pricePerPiece: value }, problem: null }
    }
    case 'expectedBackDate':
      if (text !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(text)) return { patch: null, problem: words('ops.cell.date') }
      return (before.expectedBackDate ?? '') === text ? { patch: null, problem: null } : { patch: { expectedBackDate: text === '' ? null : text }, problem: null }
    case 'note':
      return (before.note ?? '') === text ? { patch: null, problem: null } : { patch: { note: text === '' ? null : text }, problem: null }
  }
}

// ---- refusals in words ---------------------------------------------------------------------------------------------------------

const pathsOf = (error: unknown): string[] => (isApiError(error) ? error.issues.map(issuePath).map((path) => path.replace(/\./g, '/')) : [])

/** A refused write, by its kind (the screen's own words for a path it knows come first). */
export function kindWords(error: unknown): Words {
  if (!isApiError(error)) return words('problem.write')
  switch (error.kind) {
    case 'conflict':
      return words('problem.changed')
    case 'forbidden':
    case 'step_up':
      return words('problem.forbidden')
    case 'not_found':
      return words('problem.gone')
    case 'invalid':
      return words('problem.invalid')
    case 'rate_limited':
      return words('problem.slowDown')
    case 'unavailable':
      return words('problem.offline')
    default:
      return words('problem.write')
  }
}

/** A failed read, as a key of the catalogue. */
export function readWords(error: unknown): string {
  if (!isApiError(error)) return 'problem.read'
  if (error.kind === 'forbidden' || error.kind === 'step_up') return 'problem.forbidden'
  if (error.kind === 'unavailable') return 'problem.offline'
  if (error.kind === 'not_found') return 'problem.gone'
  return 'problem.read'
}

const has = (paths: readonly string[], part: string) => paths.some((path) => path.includes(part))
/** A 409 whose sentence says the state moved (never drawn: classified). */
const sentence = (error: unknown): string => (isApiError(error) ? error.message.toLowerCase() : '')

/** A cell's refusal: the path it names, else by kind. */
export function cellProblem(error: unknown, field: CellField | 'sizes'): Words {
  const paths = pathsOf(error)
  if (has(paths, 'sizes')) return words('ops.cell.sizesAddUp')
  if (has(paths, 'pieces')) return words(sentence(error).includes('live') || sentence(error).includes('ordered') ? 'ops.cell.piecesTaken' : 'ops.cell.piecesRange')
  if (has(paths, 'pricePerPiece')) return words('ops.cell.feeNumber')
  if (has(paths, 'expectedBackDate')) return words('ops.cell.dateBefore')
  if (isApiError(error) && error.kind === 'conflict' && field !== 'sizes' && sentence(error).includes('draft')) return words('ops.cell.notDraft')
  return kindWords(error)
}

/** The kit send's refusal, by the field it names. */
export function sendProblem(error: unknown): Words {
  const paths = pathsOf(error)
  const text = sentence(error)
  if (isApiError(error) && error.kind === 'forbidden' && text.includes('ddt')) return words('send.refused.ddtRight')
  if (has(paths, 'lotId')) return words(text.includes('released') || text.includes('quarantine') || text.includes('blocked') ? 'send.refused.lotNotReleased' : 'send.refused.lot')
  if (has(paths, 'hideId')) return words('send.refused.hide')
  if (has(paths, 'fromLocationId')) return words('send.refused.from')
  if (has(paths, 'quantity')) return words('send.refused.quantity')
  if (has(paths, 'pieces')) return words('send.refused.pieces')
  if (has(paths, 'bundles')) return words(text.includes('at most') ? 'send.refused.tooManyBundles' : 'send.refused.bundles')
  if (has(paths, 'transportBy')) return words('send.refused.transportBy')
  if (has(paths, 'carrier')) return words('send.refused.carrier')
  if (has(paths, 'packages')) return words('send.refused.packages')
  if (has(paths, 'grossWeightKg') || has(paths, 'netWeightKg')) return words('send.refused.weight')
  if (has(paths, 'startAt')) return words('send.refused.startAt')
  if (has(paths, 'company')) return words('send.refused.company')
  if (has(paths, 'recipient')) return words('send.refused.recipient')
  if (isApiError(error) && error.kind === 'conflict' && (text.includes('stock') || text.includes('short') || text.includes('enough'))) return words('send.refused.stock')
  return kindWords(error)
}

/** The goods-back refusal, by the field it names. */
export function receiveProblem(error: unknown): Words {
  const paths = pathsOf(error)
  const text = sentence(error)
  if (has(paths, 'bundleId')) return words('receive.refused.bundle')
  if (has(paths, 'good')) return words(text.includes('at the workshop') ? 'receive.refused.moreThanOut' : 'receive.refused.pieces')
  if (has(paths, 'toLocationId')) return words('receive.refused.toLocation')
  if (has(paths, 'returns')) return words('receive.refused.returns')
  if (has(paths, 'receivedAt')) return words('receive.refused.receivedAt')
  if (isApiError(error) && error.kind === 'conflict' && (text.includes('stock') || text.includes('short') || text.includes('enough'))) return words('receive.refused.stock')
  return kindWords(error)
}

/** Taking a kit line back: 409 while its DDT is live. */
export function returnProblem(error: unknown): Words {
  if (isApiError(error) && error.kind === 'conflict' && sentence(error).includes('ddt')) return words('returnLine.refused.ddtLive')
  return kindWords(error)
}

/** A new order's or an operation's refusal from the work order's operations (Add operation). */
export function addOperationProblem(error: unknown): Words {
  const paths = pathsOf(error)
  if (has(paths, 'pieces')) return words('addOperation.refused.pieces')
  if (has(paths, 'workOrderOperationId')) return words('addOperation.refused.operation')
  return kindWords(error)
}

// ---- answers in words -------------------------------------------------------------------------------------------------------------

export function sentWords(answer: Pick<SendKitAnswer, 'ddt'>): Words {
  if (!answer.ddt) return words('send.done.noDdt')
  return answer.ddt.pdfProblem ? words('send.done.pdfMissing', { number: answer.ddt.number }) : words('send.done.ddt', { number: answer.ddt.number })
}

/** The fee booked to the work order at the receipt: said only with the cost grain; its waiting reasons classified. */
export function receivedWords(answer: Pick<ReceiveAnswer, 'ledger' | 'order'>, can: Pick<SubcontractCan, 'cost'>): Words {
  const status = answer.order.status === 'RECEIVED' ? 'receive.done.all' : 'receive.done.part'
  if (!can.cost) return words(status)
  if (answer.ledger.waiting.length > 0) {
    const text = answer.ledger.waiting.join(' ').toLowerCase()
    return words(text.includes('currency') ? `${status}Currency` : `${status}Waiting`)
  }
  return answer.ledger.posted > 0 ? words(`${status}Posted`, { count: answer.ledger.posted }) : words(status)
}

// ---- the dialogs ---------------------------------------------------------------------------------------------------------------------

/** A place the kit's material may leave from: a stock row of the site (location, lot, hide, what is available). */
export interface SourceOption {
  key: string
  locationId: string
  locationCode: string
  lotId: string | null
  lotCode: string | null
  hideId: string | null
  hideCode: string | null
  available: string
}

export interface SendLineDraft {
  lineId: string
  include: boolean
  /** The SourceOption picked ('' none yet). */
  source: string
  quantity: string
}

export interface DdtDraft {
  issue: boolean
  reason: KitDdtReason
  reasonText: string
  transportBy: TransportBy
  carrier: string
  packages: string
  grossWeightKg: string
  appearance: string
  remarks: string
}

export const NO_DDT: DdtDraft = Object.freeze({ issue: true, reason: 'WORK_ON_ACCOUNT', reasonText: '', transportBy: 'SENDER', carrier: '', packages: '1', grossWeightKg: '', appearance: '', remarks: '' }) as DdtDraft

export interface SendDraft {
  lines: SendLineDraft[]
  /** Where each line's material may come from, by line id (read when the dialog opens). */
  sources: Part<Record<string, SourceOption[]>>
  /** Pieces that go now, per operation (typed; '' or 0 = none now). */
  pieces: Record<string, string>
  /** The work order's bundles (null: the role cannot read them, workorders.view). */
  bundles: Part<BundleOption[]> | null
  bundleIds: string[]
  ddt: DdtDraft
}

/** A fresh Send kit: every planned line in, the pieces still to send per operation, the DDT on when the role may issue it. */
export function sendDraftOf(order: SubcontractOrder, can: Pick<SubcontractCan, 'ddtIssue' | 'workOrders'>): SendDraft {
  return {
    lines: plannedLines(order).map((line) => ({ lineId: line.id, include: true, source: '', quantity: plainQuantity(line.quantity) })),
    sources: LOADING,
    pieces: Object.fromEntries(order.operations.map((operation) => [operation.id, String(Math.max(0, operation.pieces - operation.piecesSent))])),
    bundles: can.workOrders ? LOADING : null,
    bundleIds: [],
    ddt: { ...NO_DDT, issue: can.ddtIssue },
  }
}

/** "42.6000" → "42.6" (what the person reads and types). */
export const plainQuantity = (text: string): string => (text.includes('.') ? text.replace(/\.?0+$/, '') : text)

/** The stock rows a kit line may leave from: same material and colour, something available, a lot only when released. */
export function sourcesFor(rows: readonly { location: { id: string; code: string }; item: { id: string }; colour: { id: string } | null; lot: { id: string; code: string; qualityStatus: string } | null; hide: { id: string; code: string } | null; available: string }[], line: SubcontractOrder['kitLines'][number], excluded: ReadonlySet<string> = new Set()): SourceOption[] {
  return rows
    .filter((row) => row.item.id === line.item.id && (line.colour === null || row.colour?.id === line.colour.id) && Number(row.available) > 0 && !excluded.has(row.location.id))
    .filter((row) => row.lot === null || row.lot.qualityStatus === 'RELEASED')
    .filter((row) => line.item.tracking === 'NONE' || row.lot !== null)
    .map((row) => ({ key: [row.location.id, row.lot?.id ?? '', row.hide?.id ?? ''].join('|'), locationId: row.location.id, locationCode: row.location.code, lotId: row.lot?.id ?? null, lotCode: row.lot?.code ?? null, hideId: row.hide?.id ?? null, hideCode: row.hide?.code ?? null, available: plainQuantity(row.available) }))
}

const decimal = (text: string) => text.trim().replace(',', '.')
const isPositive = (text: string) => /^\d+(\.\d{1,4})?$/.test(decimal(text)) && Number(decimal(text)) > 0
const isWhole = (text: string) => /^\d+$/.test(text.trim())

/** Why Send is held, in words, or null when it may go. */
export function sendHeld(draft: SendDraft, order: SubcontractOrder): Words | null {
  if (draft.sources.value === null && draft.lines.some((line) => line.include)) return words(draft.sources.problem ? 'send.held.sourcesFailed' : 'send.held.loading')
  const lines = draft.lines.filter((line) => line.include)
  for (const line of lines) {
    const kit = order.kitLines.find((entry) => entry.id === line.lineId)
    if (!kit) continue
    if (!line.source) return words('send.held.from', { line: kit.seq })
    if (!isPositive(line.quantity)) return words('send.held.quantity', { line: kit.seq })
  }
  for (const operation of order.operations) {
    const typed = (draft.pieces[operation.id] ?? '').trim()
    if (typed === '') continue
    if (!isWhole(typed)) return words('send.held.piecesWhole', { line: operation.seq })
    if (Number(typed) > operation.pieces - operation.piecesSent) return words('send.held.piecesLeft', { line: operation.seq, left: operation.pieces - operation.piecesSent })
  }
  const pieces = Object.values(draft.pieces).reduce((sum, value) => sum + (isWhole(value) ? Number(value) : 0), 0)
  if (lines.length === 0 && pieces === 0 && draft.bundleIds.length === 0) return words('send.held.nothing')
  if (draft.ddt.issue) {
    if (draft.ddt.reason === 'OTHER' && draft.ddt.reasonText.trim() === '') return words('send.held.reasonText')
    if (draft.ddt.transportBy === 'CARRIER' && draft.ddt.carrier.trim() === '') return words('send.held.carrier')
    if (!isWhole(draft.ddt.packages) || Number(draft.ddt.packages) < 1) return words('send.held.packages')
    if (!isPositive(draft.ddt.grossWeightKg)) return words('send.held.weight')
  }
  return null
}

/** The kit send's body: the lines picked with their place, lot and hide; the pieces typed; the bundles; the DDT or none. */
export function sendBody(draft: SendDraft, order: SubcontractOrder): SendKitBody {
  const sources = draft.sources.value ?? {}
  const lines = draft.lines
    .filter((line) => line.include)
    .map((line) => {
      const source = (sources[line.lineId] ?? []).find((option) => option.key === line.source)!
      const kit = order.kitLines.find((entry) => entry.id === line.lineId)!
      return { lineId: line.lineId, fromLocationId: source.locationId, lotId: source.lotId, hideId: source.hideId, quantity: decimal(line.quantity), uom: kit.uom }
    })
  const pieces = order.operations.map((operation) => ({ operationId: operation.id, pieces: Number((draft.pieces[operation.id] ?? '').trim() || 0) })).filter((entry) => entry.pieces > 0)
  const ddt = draft.ddt.issue
    ? {
        reason: draft.ddt.reason,
        ...(draft.ddt.reason === 'OTHER' ? { reasonText: draft.ddt.reasonText.trim() } : {}),
        transportBy: draft.ddt.transportBy,
        ...(draft.ddt.transportBy === 'CARRIER' ? { carrier: { name: draft.ddt.carrier.trim() } } : {}),
        packages: Number(draft.ddt.packages),
        grossWeightKg: decimal(draft.ddt.grossWeightKg),
        ...(draft.ddt.appearance.trim() ? { appearance: draft.ddt.appearance.trim() } : {}),
        ...(draft.ddt.remarks.trim() ? { remarks: draft.ddt.remarks.trim() } : {}),
      }
    : null
  return { version: order.version, lines, pieces, bundles: draft.bundleIds.map((bundleId) => ({ bundleId })), ddt }
}

/** One line of goods back: an operation, optionally one of its bundles, the counts. */
export interface BackLineDraft {
  key: string
  operationId: string
  bundleId: string
  good: string
  defective: string
  scrapped: string
  reason: string
}

export interface ReturnDraft {
  quantity: string
  toLocationId: string
}

export interface ReceiveDraft {
  receivedOn: string
  ddtNumber: string
  ddtDate: string
  lines: BackLineDraft[]
  bundles: Part<BundleOption[]> | null
  /** Our material at the workshop (what may come back unused), and where it goes. */
  stock: Part<WorkshopStockRow[]>
  returns: Record<string, ReturnDraft>
  locations: Part<{ id: string; code: string; name: string }[]>
  note: string
}

/** A stock row's key (a return line). */
export const stockKey = (row: Pick<WorkshopStockRow, 'item' | 'colour' | 'lot' | 'hide'>): string => [row.item.id, row.colour?.id ?? '', row.lot?.id ?? '', row.hide?.id ?? ''].join('|')

/** A fresh Receive back: one line per operation still at the workshop, today, nothing returned yet. */
export function receiveDraftOf(order: SubcontractOrder, today: string, can: Pick<SubcontractCan, 'workOrders'>): ReceiveDraft {
  return {
    receivedOn: today,
    ddtNumber: '',
    ddtDate: '',
    lines: order.operations.filter((operation) => operation.atWorkshop > 0).map((operation) => ({ key: `${operation.id}:0`, operationId: operation.id, bundleId: '', good: String(operation.atWorkshop), defective: '0', scrapped: '0', reason: '' })),
    bundles: can.workOrders ? LOADING : null,
    stock: LOADING,
    returns: {},
    locations: LOADING,
    note: '',
  }
}

const count = (text: string) => (isWhole(text) ? Number(text.trim()) : NaN)

export function receiveHeld(draft: ReceiveDraft, order: SubcontractOrder, today: string): Words | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.receivedOn)) return words('receive.held.date')
  if (draft.receivedOn > today) return words('receive.held.future')
  let pieces = 0
  const perOperation = new Map<string, number>()
  for (const line of draft.lines) {
    const operation = order.operations.find((entry) => entry.id === line.operationId)
    if (!operation) continue
    const [good, defective, scrapped] = [count(line.good), count(line.defective), count(line.scrapped)]
    if ([good, defective, scrapped].some((value) => Number.isNaN(value))) return words('receive.held.whole', { line: operation.seq })
    const total = good + defective + scrapped
    if ((defective > 0 || scrapped > 0) && line.reason.trim() === '') return words('receive.held.reason', { line: operation.seq })
    perOperation.set(operation.id, (perOperation.get(operation.id) ?? 0) + total)
    pieces += total
  }
  for (const [operationId, total] of perOperation) {
    const operation = order.operations.find((entry) => entry.id === operationId)!
    if (total > operation.atWorkshop) return words('receive.held.moreThanOut', { line: operation.seq, out: operation.atWorkshop })
  }
  const returns = Object.entries(draft.returns).filter(([, entry]) => entry.quantity.trim() !== '')
  for (const [key, entry] of returns) {
    const row = draft.stock.value?.find((candidate) => stockKey(candidate) === key)
    if (!row) continue
    if (!isPositive(entry.quantity)) return words('receive.held.returnQuantity', { item: row.item.code })
    if (Number(decimal(entry.quantity)) > Number(row.onHand)) return words('receive.held.returnMore', { item: row.item.code, max: plainQuantity(row.onHand) })
    if (!entry.toLocationId) return words('receive.held.returnTo', { item: row.item.code })
  }
  if (pieces === 0 && returns.length === 0) return words('receive.held.nothing')
  if (draft.ddtDate && !draft.ddtNumber.trim()) return words('receive.held.ddtNumber')
  return null
}

/** The receipt's body: the lines with at least one piece, the returns typed, the workshop's DDT, the note. */
export function receiveBody(draft: ReceiveDraft, order: SubcontractOrder, now: string): ReceiveBody {
  const lines = draft.lines
    .map((line) => ({ operationId: line.operationId, ...(line.bundleId ? { bundleId: line.bundleId } : {}), good: count(line.good), defective: count(line.defective), scrapped: count(line.scrapped), ...(line.reason.trim() ? { reason: line.reason.trim() } : {}) }))
    .filter((line) => line.good + line.defective + line.scrapped > 0)
  const returns = Object.entries(draft.returns)
    .filter(([, entry]) => entry.quantity.trim() !== '')
    .map(([key, entry]) => {
      const row = draft.stock.value!.find((candidate) => stockKey(candidate) === key)!
      return { itemId: row.item.id, itemColourId: row.colour?.id ?? null, lotId: row.lot?.id ?? null, hideId: row.hide?.id ?? null, quantity: decimal(entry.quantity), uom: row.item.baseUom, toLocationId: entry.toLocationId }
    })
  const today = now.slice(0, 10)
  return {
    version: order.version,
    ...(draft.receivedOn && draft.receivedOn !== today ? { receivedAt: `${draft.receivedOn}T12:00:00.000Z` } : {}),
    lines,
    returns,
    ...(draft.ddtNumber.trim() ? { supplierDdt: { number: draft.ddtNumber.trim(), date: draft.ddtDate || null } } : {}),
    ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
  }
}

/** A typed kit line (Add kit line): a material, its colour, the quantity and unit. */
export interface KitLineDraft {
  query: string
  materials: MaterialOption[] | null
  materialsProblem: string | null
  material: MaterialDetail | null
  itemColourId: string
  quantity: string
  uom: string
}
export const NO_KIT_LINE: KitLineDraft = Object.freeze({ query: '', materials: null, materialsProblem: null, material: null, itemColourId: '', quantity: '', uom: '' }) as KitLineDraft

export function kitLineHeld(draft: KitLineDraft): Words | null {
  if (!draft.material) return words('kitLine.held.material')
  if (draft.material.colours.some((colour) => colour.status === 'ACTIVE') && !draft.itemColourId) return words('kitLine.held.colour')
  if (!isPositive(draft.quantity)) return words('kitLine.held.quantity')
  return null
}

/** Add operation: an operation of the work order not on this order, with its pieces (default every garment still free). */
export interface AddOperationDraft {
  outside: Part<OutsideOperations>
  operationId: string
  pieces: string
}

export function addOperationHeld(draft: AddOperationDraft, order: SubcontractOrder): Words | null {
  if (!draft.outside.value) return words(draft.outside.problem ? 'addOperation.held.failed' : 'addOperation.held.loading')
  const pick = draft.outside.value.operations.find((operation) => operation.id === draft.operationId)
  if (!pick) return words('addOperation.held.pick')
  if (order.operations.some((operation) => operation.workOrderOperation.id === pick.id)) return words('addOperation.held.already')
  const garments = draft.outside.value.cells.reduce((sum, cell) => sum + cell.quantity, 0)
  const left = garments - pick.ordered
  if (!isWhole(draft.pieces) || Number(draft.pieces) < 1 || Number(draft.pieces) > left) return words('addOperation.held.pieces', { left })
  return null
}

/** The sizes editor: the work order's cells (the most each takes) and the grid typed. */
export interface SizesDraft {
  operationId: string
  cells: Part<OutsideOperations['cells']>
  value: Record<string, Record<string, number>>
}

/** The grid as the operation's sizes (cells with pieces), and its total. */
export function sizesOf(draft: SizesDraft): { sizes: { workOrderSizeId: string; pieces: number }[]; pieces: number } {
  const sizes = (draft.cells.value ?? []).map((cell) => ({ workOrderSizeId: cell.workOrderSizeId, pieces: draft.value[cell.colourway]?.[cell.size] ?? 0 })).filter((size) => size.pieces > 0)
  return { sizes, pieces: sizes.reduce((sum, size) => sum + size.pieces, 0) }
}

export function sizesHeld(draft: SizesDraft): Words | null {
  if (!draft.cells.value) return words(draft.cells.problem ? 'sizes.held.failed' : 'sizes.held.loading')
  for (const cell of draft.cells.value) if ((draft.value[cell.colourway]?.[cell.size] ?? 0) > cell.quantity) return words('sizes.held.over', { cell: `${cell.colourway} ${cell.size}`, max: cell.quantity })
  return sizesOf(draft).pieces < 1 ? words('sizes.held.none') : null
}

export type RecordDialog =
  | { kind: 'cancel'; reason: string }
  | { kind: 'close'; note: string }
  | { kind: 'addOperation'; draft: AddOperationDraft }
  | { kind: 'removeOperation'; operationId: string }
  | { kind: 'sizes'; draft: SizesDraft }
  | { kind: 'kitLine'; draft: KitLineDraft }
  | { kind: 'removeKit'; lineIds: string[] }
  | { kind: 'returnLine'; lineId: string; reason: string }
  | { kind: 'send'; draft: SendDraft }
  | { kind: 'receive'; draft: ReceiveDraft }
  | { kind: 'annul'; ddtId: string; reason: string; typed: string }

/** The kit DDT shown in Documents: its PDF bytes, or why not. */
export interface DdtPdf {
  ddtId: string
  data: Uint8Array | null
  problem: string | null
}

export interface SubcontractRecordModel {
  prefix: string
  can: SubcontractCan
  tab: RecordTab
  order: Loaded<SubcontractOrder>
  live: LiveState
  dockOpen: boolean
  changed: { at: string } | null
  notice: { tone: 'success' | 'danger' | 'info' | 'warning'; words: Words } | null
  busy: boolean
  dialog: RecordDialog | null
  dialogProblem: Words | null
  /** A draft's cells being saved, saved or refused, by `cellKey`. */
  marks: Readonly<Record<string, SaveMark>>
  /** The live kit DDT's PDF in Documents (null: none shown). */
  pdf: DdtPdf | null
  panelsPreview?: RecordPanelsViewModel
  timeZone: string
  today: string
  /** Design cases. */
  selected?: readonly string[]
}

export interface SubcontractRecordActions {
  onRetry?: () => void
  onReload?: () => void
  onDock?: () => void
  onDismissNotice?: () => void
  onDialog?: (dialog: RecordDialog | null) => void
  onAct?: (act: 'issue' | 'reopen') => void
  onCancel?: () => void
  onClose?: () => void
  onOpenSend?: () => void
  onSend?: () => void
  onOpenReceive?: () => void
  onReceive?: () => void
  onCell?: (operationId: string, field: CellField, typed: string) => void
  onOpenSizes?: (operationId: string) => void
  onSaveSizes?: () => void
  onOpenAddOperation?: () => void
  onAddOperation?: () => void
  onRemoveOperation?: () => void
  onOpenKitLine?: () => void
  kitLine?: { onQuery?: (q: string) => void; onMaterial?: (id: string | null) => void; onSave?: () => void }
  onPlanKit?: () => void
  onRemoveKit?: () => void
  onReturnLine?: () => void
  onOpenDdt?: (ddtId: string) => void
  onPrintAgain?: (ddtId: string) => void
  onAnnul?: () => void
  onShowPdf?: (ddtId: string) => void
  onCopyNumber?: () => void
}
