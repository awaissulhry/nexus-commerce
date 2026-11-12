import type { LineView, OptionSite, StockRow, TransferRow, TransferView } from '@nexus/factory-domain/inventory/transfers/contracts'
import {
  LINE_STATES,
  TRANSFER_DDT_REASONS,
  TRANSFER_REFUSALS,
  TRANSFER_RESOLUTIONS,
  TRANSFER_STATUSES,
  TRANSFER_TILES,
  TRANSFER_TRANSPORT,
  typedQuantity,
  type LineState,
  type TransferDdtReason,
  type TransferRefusal,
  type TransferResolution,
  type TransferStatus,
  type TransferTile,
  type TransferTransport,
} from '@nexus/factory-domain/inventory/transfers/rules'
import { isApiError, issuePath } from '../../../lib/api/errors'

/**
 * Warehouse › In the warehouse › Transfers (SCR-360 the list, SCR-361 a transfer; design warehouse.transfers, SCR-133;
 * B-W2b-326), pure: who may do what, the list's address and tiles, the record's tabs, the tones, the New transfer, Ship,
 * Receive and Settle drafts with why each is held, the bodies the API takes, refusals said from their codes. Every word is
 * a key of `warehouse-transfers`. Quantities are in the item's base unit (the API's).
 */

export const NS = 'warehouse-transfers'
export const NAMESPACES = [NS, 'lists', 'stock'] as const

export { LINE_STATES, TRANSFER_DDT_REASONS, TRANSFER_REFUSALS, TRANSFER_RESOLUTIONS, TRANSFER_STATUSES, TRANSFER_TILES, TRANSFER_TRANSPORT }
export type { LineState, TransferDdtReason, TransferRefusal, TransferResolution, TransferStatus, TransferTile, TransferTransport }
export type { LineView, OptionSite, StockRow, TransferRow, TransferView }

export interface Phrase {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

export interface Notice extends Phrase {
  readonly tone: 'success' | 'info' | 'warning' | 'danger'
}

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

// ---- who may do what ----------------------------------------------------------------------------------------------------

export interface TransfersCan {
  /** The list, a transfer, its DDT's PDF (inventory.stock.view). */
  view: boolean
  /** Draft, ship, receive, settle (inventory.transfers.manage; the API checks the end it acts at). */
  manage: boolean
}

export function transfersCan(permissions: readonly string[]): TransfersCan {
  const held = new Set(permissions)
  return { view: held.has('inventory.stock.view'), manage: held.has('inventory.transfers.manage') }
}

// ---- the list's address ----------------------------------------------------------------------------------------------------

export interface ListAddress {
  readonly tile: TransferTile | null
  readonly status: TransferStatus | null
  readonly from: string | null
  readonly to: string | null
  readonly q: string
  /** New transfer (`?new=1`, key c). */
  readonly isNew: boolean
}

export const HOME_ADDRESS: ListAddress = { tile: null, status: null, from: null, to: null, q: '', isNew: false }

const oneOf = <T extends string>(values: readonly T[], value: string | null): T | null => (value !== null && (values as readonly string[]).includes(value) ? (value as T) : null)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const idOf = (value: string | null): string | null => (value && UUID.test(value) ? value : null)

export function addressOf(params: { get(name: string): string | null }): ListAddress {
  return {
    tile: oneOf(TRANSFER_TILES, params.get('tile')),
    status: oneOf(TRANSFER_STATUSES, params.get('status')),
    from: idOf(params.get('from')),
    to: idOf(params.get('to')),
    q: (params.get('q') ?? '').slice(0, 100),
    isNew: params.get('new') === '1',
  }
}

export function addressText(address: ListAddress): string {
  const params = new URLSearchParams()
  if (address.tile) params.set('tile', address.tile)
  if (address.status) params.set('status', address.status)
  if (address.from) params.set('from', address.from)
  if (address.to) params.set('to', address.to)
  if (address.q.trim()) params.set('q', address.q.trim())
  if (address.isNew) params.set('new', '1')
  const text = params.toString()
  return text ? `?${text}` : ''
}

export const isFiltered = (address: ListAddress): boolean => !!(address.tile || address.status || address.from || address.to || address.q.trim())

export const listHref = (prefix: string, address: Partial<ListAddress> = {}): string => `${prefix}/warehouse/transfers${addressText({ ...HOME_ADDRESS, ...address })}`

// ---- the record --------------------------------------------------------------------------------------------------------------

export const RECORD_TABS = ['lines', 'transit', 'received'] as const
export type RecordTab = (typeof RECORD_TABS)[number]

export const recordTabOf = (params: { get(name: string): string | null }): RecordTab => oneOf(RECORD_TABS, params.get('tab')) ?? 'lines'

export const recordHref = (prefix: string, transferId: string, tab?: RecordTab): string => `${prefix}/warehouse/transfers/${encodeURIComponent(transferId)}${tab && tab !== 'lines' ? `?tab=${tab}` : ''}`

/** The design's lifecycle words: Draft / In transit / Partly received / Received / Closed (every difference settled) / Cancelled. */
export type Lifecycle = 'DRAFT' | 'IN_TRANSIT' | 'PARTLY_RECEIVED' | 'RECEIVED' | 'CLOSED' | 'CANCELLED'

export function lifecycleOf(status: TransferStatus, openDifferences: number): Lifecycle {
  if (status === 'SHIPPED') return 'IN_TRANSIT'
  if (status === 'RECEIVED') return openDifferences > 0 ? 'RECEIVED' : 'CLOSED'
  return status
}

export const LIFECYCLE_TONE: Readonly<Record<Lifecycle, Tone>> = {
  DRAFT: 'neutral',
  IN_TRANSIT: 'info',
  PARTLY_RECEIVED: 'warning',
  RECEIVED: 'warning',
  CLOSED: 'success',
  CANCELLED: 'neutral',
}

export const LINE_STATE_TONE: Readonly<Record<LineState, Tone>> = { DRAFT: 'neutral', IN_TRANSIT: 'info', RECEIVED: 'success', SHORT: 'danger', SETTLED: 'neutral' }

export const rowLifecycle = (row: Pick<TransferRow, 'status' | 'differences'>): Lifecycle => lifecycleOf(row.status, row.differences)

// ---- held with the reason -----------------------------------------------------------------------------------------------

/** An action of the API held: its refusal's words; else null. */
export function actionHeld(action: { readonly allowed: boolean; readonly refusal: TransferRefusal | null } | undefined, offline: boolean): Phrase | null {
  if (!action) return { key: 'held.reading' }
  if (!action.allowed) return { key: `refusal.${action.refusal ?? 'NOT_DRAFT'}` }
  if (offline) return { key: 'held.offline' }
  return null
}

// ---- New transfer --------------------------------------------------------------------------------------------------------------

export interface NewDraft {
  readonly fromSiteId: string | null
  readonly toSiteId: string | null
  readonly transitLocationId: string | null
  readonly fromLocationId: string | null
  readonly toLocationId: string | null
  readonly shipOn: string | null
  readonly expectedOn: string | null
  readonly note: string
}

export const emptyNewDraft = (fromSiteId: string | null = null): NewDraft => ({ fromSiteId, toSiteId: null, transitLocationId: null, fromLocationId: null, toLocationId: null, shipOn: null, expectedOn: null, note: '' })

/** The sites a draft may leave from (the caller may send from them, active, with a transit place) and go to. */
export function sendingSites(sites: readonly OptionSite[]): OptionSite[] {
  return sites.filter((site) => site.send && site.active)
}

export function newDraftHeld(draft: NewDraft, sites: readonly OptionSite[] | null, can: TransfersCan, offline: boolean): Phrase | null {
  if (!can.manage) return { key: 'held.noManage' }
  if (offline) return { key: 'held.offline' }
  if (!sites) return { key: 'held.reading' }
  const from = sites.find((site) => site.id === draft.fromSiteId)
  if (!from) return { key: 'held.pickFrom' }
  if (from.transitPlaces.length === 0) return { key: 'refusal.NO_TRANSIT_PLACE' }
  if (!draft.toSiteId) return { key: 'held.pickTo' }
  if (draft.toSiteId === draft.fromSiteId) return { key: 'refusal.SAME_SITE' }
  if (from.transitPlaces.length > 1 && !draft.transitLocationId) return { key: 'held.pickTransit' }
  if (draft.shipOn && draft.expectedOn && draft.expectedOn < draft.shipOn) return { key: 'held.expectedBeforeShip' }
  return null
}

export function newBodyOf(draft: NewDraft) {
  return {
    fromSiteId: draft.fromSiteId!,
    toSiteId: draft.toSiteId!,
    ...(draft.transitLocationId ? { transitLocationId: draft.transitLocationId } : {}),
    ...(draft.fromLocationId ? { fromLocationId: draft.fromLocationId } : {}),
    ...(draft.toLocationId ? { toLocationId: draft.toLocationId } : {}),
    ...(draft.shipOn ? { shipOn: draft.shipOn } : {}),
    ...(draft.expectedOn ? { expectedOn: draft.expectedOn } : {}),
    ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
  }
}

// ---- Ship transfer ----------------------------------------------------------------------------------------------------------------

export interface ShipDraft {
  readonly reason: TransferDdtReason
  readonly reasonText: string
  readonly transportBy: TransferTransport
  readonly carrierName: string
  readonly carrierVatNumber: string
  readonly packages: string
  readonly grossWeightKg: string
  readonly appearance: string
  readonly trackingRef: string
  readonly trackingUrl: string
  readonly expectedOn: string | null
  readonly language: 'it' | 'en'
}

export const emptyShipDraft = (transfer: Pick<TransferView, 'expectedOn' | 'interCompany'>): ShipDraft => ({
  reason: 'TRANSFER',
  reasonText: '',
  transportBy: 'SENDER',
  carrierName: '',
  carrierVatNumber: '',
  packages: '1',
  grossWeightKg: '',
  appearance: '',
  trackingRef: '',
  trackingUrl: '',
  expectedOn: transfer.expectedOn,
  language: 'it',
})

/** A decimal typed in either language ("12,5" or "12.5"), as the API writes it; else null. */
export function decimalText(text: string, zero = false): string | null {
  const value = typedQuantity(text.trim().replace(',', '.'), zero)
  return value === null ? null : text.trim().replace(',', '.')
}

export function shipHeld(draft: ShipDraft, transfer: TransferView, today: string, offline: boolean): Phrase | null {
  const held = actionHeld(transfer.actions.ship, offline)
  if (held) return held
  if (draft.transportBy === 'CARRIER' && !draft.carrierName.trim()) return { key: 'held.carrierName' }
  if (draft.reason === 'OTHER' && !draft.reasonText.trim()) return { key: 'held.reasonText' }
  const packages = Number(draft.packages)
  if (!Number.isInteger(packages) || packages < 1 || packages > 9999) return { key: 'held.packages' }
  if (decimalText(draft.grossWeightKg) === null) return { key: 'held.weight' }
  if (draft.trackingUrl.trim() && !/^https:\/\/\S+$/.test(draft.trackingUrl.trim())) return { key: 'held.trackingUrl' }
  if (draft.expectedOn && draft.expectedOn < today) return { key: 'held.expectedPast' }
  return null
}

export function shipBodyOf(draft: ShipDraft, version: number) {
  return {
    version,
    reason: draft.reason,
    ...(draft.reason === 'OTHER' ? { reasonText: draft.reasonText.trim() } : {}),
    transportBy: draft.transportBy,
    ...(draft.transportBy === 'CARRIER' ? { carrierName: draft.carrierName.trim(), ...(draft.carrierVatNumber.trim() ? { carrierVatNumber: draft.carrierVatNumber.trim() } : {}) } : {}),
    packages: Number(draft.packages),
    grossWeightKg: decimalText(draft.grossWeightKg)!,
    ...(draft.appearance.trim() ? { appearance: draft.appearance.trim() } : {}),
    ...(draft.trackingRef.trim() ? { trackingRef: draft.trackingRef.trim() } : {}),
    ...(draft.trackingUrl.trim() ? { trackingUrl: draft.trackingUrl.trim() } : {}),
    expectedOn: draft.expectedOn,
    language: draft.language,
  }
}

// ---- Receive transfer --------------------------------------------------------------------------------------------------------------

export interface ReceiveEntry {
  /** What arrives now (base unit), as typed. */
  readonly quantity: string
  readonly reason: string | null
  readonly note: string
  readonly toLocationId: string | null
}

export type ReceiveDraft = Readonly<Record<string, ReceiveEntry>>

/** Every line still in transit, with all of it arriving (a hide: whole, ticked by its scan). */
export function receiveDraftOf(transfer: TransferView): ReceiveDraft {
  const draft: Record<string, ReceiveEntry> = {}
  for (const line of transfer.lines) {
    if (line.inTransit === '0' || line.state === 'SHORT' || line.state === 'SETTLED') continue
    draft[line.id] = { quantity: line.hide ? '0' : line.inTransit, reason: null, note: '', toLocationId: null }
  }
  return draft
}

/** The lines the Receive dialog lists (still on their way). */
export const receivableLines = (transfer: TransferView): LineView[] => transfer.lines.filter((line) => line.inTransit !== '0' && line.state !== 'SHORT' && line.state !== 'SETTLED')

/** A hide scanned or typed: the line it travels on, or null. */
export const lineOfTag = (transfer: TransferView, tag: string): LineView | null => {
  const wanted = tag.trim().toUpperCase()
  return wanted ? (receivableLines(transfer).find((line) => line.hide?.code.toUpperCase() === wanted) ?? null) : null
}

/** What a line of the dialog says: short (arrives less than in transit) and needs a reason only to close it. */
export function entryShort(line: LineView, entry: ReceiveEntry | undefined): boolean {
  if (!entry) return false
  const arrives = decimalText(entry.quantity, true)
  return arrives !== null && Number(arrives) < Number(line.inTransit)
}

export function receiveHeld(draft: ReceiveDraft, transfer: TransferView, offline: boolean): Phrase | null {
  const held = actionHeld(transfer.actions.receive, offline)
  if (held) return held
  let something = false
  for (const line of receivableLines(transfer)) {
    const entry = draft[line.id]
    if (!entry) continue
    const arrives = decimalText(entry.quantity, true)
    if (arrives === null) return { key: 'held.quantity', params: { seq: line.seq } }
    if (Number(arrives) > Number(line.inTransit)) return { key: 'held.moreThanInTransit', params: { seq: line.seq } }
    if (line.hide && Number(arrives) !== 0 && arrives !== line.inTransit) return { key: 'refusal.HIDE_WHOLE' }
    if (Number(arrives) > 0 && !entry.toLocationId && !line.toLocation && !transfer.toLocation) return { key: 'held.putPlace', params: { seq: line.seq } }
    if (Number(arrives) > 0 || entry.reason) something = true
  }
  return something ? null : { key: 'refusal.NOTHING_RECEIVED' }
}

export function receiveBodyOf(draft: ReceiveDraft, transfer: TransferView) {
  const lines = receivableLines(transfer).flatMap((line) => {
    const entry = draft[line.id]
    if (!entry) return []
    const quantity = decimalText(entry.quantity, true) ?? '0'
    if (Number(quantity) === 0 && !entry.reason) return []
    return [
      {
        lineId: line.id,
        quantity,
        ...(entry.toLocationId ? { toLocationId: entry.toLocationId } : {}),
        ...(entry.reason && entryShort(line, entry) ? { differenceReasonCode: entry.reason, ...(entry.note.trim() ? { differenceNote: entry.note.trim() } : {}) } : {}),
      },
    ]
  })
  return { version: transfer.version, lines }
}

// ---- Settle a difference ----------------------------------------------------------------------------------------------------------

export interface SettleDraft {
  readonly lineId: string
  readonly resolution: TransferResolution | null
  readonly note: string
}

export function settleHeld(draft: SettleDraft, line: LineView | undefined, transfer: TransferView, offline: boolean): Phrase | null {
  const held = actionHeld(transfer.actions.settle, offline)
  if (held) return held
  if (!line || line.state !== 'SHORT') return { key: 'refusal.NOTHING_TO_SETTLE' }
  if (!draft.resolution) return { key: 'held.resolution' }
  if (draft.resolution === 'SENT_BACK' && line.receivedQuantity !== '0') return { key: 'refusal.SENT_BACK_PART' }
  return null
}

// ---- refusals and problems ------------------------------------------------------------------------------------------------------

export function refusalCode(error: unknown): string | null {
  if (!isApiError(error)) return null
  for (const issue of error.issues) {
    const path = issuePath(issue)
    if (path.startsWith('refusal/')) return path.slice('refusal/'.length)
  }
  return null
}

export const KNOWN_REFUSALS: readonly string[] = TRANSFER_REFUSALS

export const refusalPhrase = (code: string | null | undefined): Phrase => (code && KNOWN_REFUSALS.includes(code) ? { key: `refusal.${code}` } : { key: 'problem.refused' })

export function readProblem(error: unknown): string {
  if (!isApiError(error)) return 'problem.unavailable'
  switch (error.kind) {
    case 'forbidden':
      return 'problem.forbidden'
    case 'not_found':
      return 'problem.notFound'
    case 'signed_out':
      return 'problem.signedOut'
    case 'contract':
      return 'problem.contract'
    case 'rate_limited':
      return 'problem.rateLimited'
    default:
      return 'problem.unavailable'
  }
}

export interface WriteProblem extends Phrase {
  readonly paths: readonly string[]
  readonly stale: boolean
}

export function writeProblem(error: unknown): WriteProblem {
  if (!isApiError(error)) return { key: 'problem.unavailable', paths: [], stale: false }
  const code = refusalCode(error)
  if (code) return { ...refusalPhrase(code), paths: [], stale: false }
  const paths = error.issues.map((issue) => issuePath(issue).replace(/^body[/.]/, '').replace(/\./g, '/')).filter(Boolean)
  if (error.kind === 'conflict') return { key: 'problem.stale', paths: [], stale: true }
  if (error.kind === 'invalid') return { key: 'problem.invalid', paths, stale: false }
  if (error.kind === 'forbidden') return { key: 'problem.writeForbidden', paths: [], stale: false }
  if (error.kind === 'not_found') return { key: 'problem.notFound', paths: [], stale: false }
  if (error.kind === 'rate_limited') return { key: 'problem.rateLimited', paths: [], stale: false }
  return { key: 'problem.unavailable', paths: [], stale: false }
}

const KNOWN_FIELDS = ['fromSiteId', 'toSiteId', 'transitLocationId', 'fromLocationId', 'toLocationId', 'shipOn', 'expectedOn', 'note', 'quantity', 'itemId', 'lotId', 'hideId', 'carrierName', 'reasonText', 'grossWeightKg', 'packages', 'trackingUrl', 'trackingRef', 'appearance', 'lines', 'reason'] as const

/** A 400's place in our words (`lines/0/quantity` → the field it names). */
export function fieldOfPath(path: string): string {
  const parts = path.split('/')
  const field = parts[0] === 'lines' && parts.length > 2 ? parts[2]! : parts[0]!
  return (KNOWN_FIELDS as readonly string[]).includes(field) ? `field.${field}` : 'field.other'
}

/** Today in Europe/Rome (YYYY-MM-DD). */
export const todayOf = (instant: string): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instant))

/** A quantity as a person reads it, in the page's language. */
export function quantityWords(text: string | null | undefined, locale: string): string {
  if (text === null || text === undefined || text === '') return '—'
  const value = Number(text)
  return Number.isFinite(value) ? new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-GB', { maximumFractionDigits: 4 }).format(value) : text
}
