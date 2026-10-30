import { isApiError, issuePath } from '../../../lib/api/errors'
import type { Locale } from '../../../lib/i18n/locales'
import type { RecordPanelsViewModel } from '../../../record-panels/model'
import type { LiveState } from '../../_shared/buying/hooks'
import type {
  Claim,
  ClaimCounts,
  ClaimFoundAt,
  ClaimKind,
  ClaimPatch,
  ClaimQuery,
  ClaimRemedy,
  ClaimRow,
  ClaimStatus,
  HideRow,
  LotRecord,
  LotRow,
  PickerReason,
  ReturnAnswer,
  ReturnDdtRequest,
  ReturnGoodsBody,
  ReturnToSupplierBody,
  SendBody,
  SendCheck,
  SupplierContact,
  TransportBy,
  AnswerBody,
} from './api'

/**
 * Purchasing › Returns & claims (SCR-131; design purchasing.claims), the pure rules every part of the page shares: what
 * this person may do (the permissions and the cost grain), the saved views the tiles and Rows ▾ open (each the API's own
 * filter, as its counts count it), the address, why a band act is held — in this app's words from the claim's facts
 * (mirroring factory-domain purchasing/claims/rules.ts claimActions), never the API's English `actions` — the Claim
 * tab's form, every dialog's draft, what holds it and the body it sends, and every refusal in our words. Words are keys
 * of the `purchasing-claims` catalogue.
 */

// ---- what this person may do -----------------------------------------------------------------------------------------------

export interface ClaimsCan {
  /** purchasing.view: the list, the counts, the record. */
  view: boolean
  /** purchasing.claims.manage: prepare, change, send, answer, close, cancel (the buyer and the warehouse). */
  manage: boolean
  /** purchasing.claims.return: the goods go back (the warehouse). */
  ret: boolean
  /** shipping.ddt.issue: the return DDT the goods travel with. */
  ddtIssue: boolean
  /** The cost grain (money.cost): values and the credit; without it the API drops them and they are not drawn. */
  cost: boolean
  /** inventory.stock.view: find a lot and its hides for Return to supplier; the receipt's number on a chip. */
  stock: boolean
  /** parties.view: the supplier's contacts for a mail with the return. */
  parties: boolean
  threads: boolean
  /** files.read: a return DDT's PDF. */
  files: boolean
}

export function claimsCan(permissions: readonly string[]): ClaimsCan {
  const held = new Set(permissions)
  return {
    view: held.has('purchasing.view'),
    manage: held.has('purchasing.claims.manage'),
    ret: held.has('purchasing.claims.return'),
    ddtIssue: held.has('shipping.ddt.issue'),
    cost: held.has('money.cost'),
    stock: held.has('inventory.stock.view'),
    parties: held.has('parties.view'),
    threads: held.has('threads.read'),
    files: held.has('files.read'),
  }
}

/**
 * Words with their values: a key of `purchasing-claims` and its parameters. A parameter that starts with `@` is itself a
 * key of the catalogue (`@statusIn.SENT` → "sent, waiting for the supplier"), translated by `say`.
 */
export interface Words {
  key: string
  params?: Readonly<Record<string, string | number>>
}
export const words = (key: string, params?: Words['params']): Words => (params ? { key, params } : { key })

export function say(t: (key: string, params?: Record<string, string | number>) => string, value: Words): string {
  if (!value.params) return t(value.key)
  const params: Record<string, string | number> = {}
  for (const [name, entry] of Object.entries(value.params)) params[name] = typeof entry === 'string' && entry.startsWith('@') ? t(entry.slice(1)) : entry
  return t(value.key, params)
}

export type Loaded<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; problem: string } | { status: 'not_found' } | { status: 'forbidden' }

/** A part read beside the page: its value, or why it is missing (both null: still loading). */
export interface Part<T> {
  value: T | null
  problem: string | null
}
export const LOADING: Part<never> = Object.freeze({ value: null, problem: null })
export const ready = <T>(value: T): Part<T> => ({ value, problem: null })

// ---- the list: saved views, filters, the address ---------------------------------------------------------------------------

export const CLAIM_VIEWS = ['open', 'draft', 'sent', 'accepted', 'rejected', 'closed', 'cancelled', 'all'] as const
export type ClaimView = (typeof CLAIM_VIEWS)[number]
const VIEW_STATUS: Readonly<Partial<Record<ClaimView, ClaimStatus>>> = { draft: 'DRAFT', sent: 'SENT', accepted: 'ACCEPTED', rejected: 'REJECTED', closed: 'CLOSED', cancelled: 'CANCELLED' }

export const viewOf = (value: string | null | undefined): ClaimView | null => ((CLAIM_VIEWS as readonly string[]).includes(value ?? '') ? (value as ClaimView) : null)

export interface ClaimFilters {
  q: string
  kind: ClaimKind | null
  /** A goods receipt's claims (`?receipt=`): every state unless a view says otherwise. */
  receipt: string | null
  /** A lot's claims (`?lot=`): every state unless a view says otherwise. */
  lot: string | null
}

type Params = { get(name: string): string | null } | null

export function filtersOf(params: Params): ClaimFilters {
  const kind = params?.get('kind')
  return {
    q: params?.get('q') ?? '',
    kind: kind === 'RETURN' || kind === 'CLAIM' ? kind : null,
    receipt: params?.get('receipt') || null,
    lot: params?.get('lot') || null,
  }
}

/** The view with no `?view=`: the open claims, or every state for one receipt's or one lot's claims. */
export const defaultView = (filters: Pick<ClaimFilters, 'receipt' | 'lot'>): ClaimView => (filters.receipt || filters.lot ? 'all' : 'open')

/** `?view=` first, else the API's own `?status=`, else the default. */
export function viewFromAddress(params: Params): ClaimView {
  const view = viewOf(params?.get('view'))
  if (view) return view
  const status = params?.get('status')
  const byStatus = (Object.entries(VIEW_STATUS) as [ClaimView, ClaimStatus][]).find(([, value]) => value === status)
  if (byStatus) return byStatus[0]
  return defaultView(filtersOf(params))
}

/** The API's query for a view and the filters (a tile and its list agree: the counts route counts the same states). */
export function claimQuery(view: ClaimView, filters: ClaimFilters, cursor: string | null = null): ClaimQuery {
  const status = VIEW_STATUS[view]
  return {
    ...(status ? { status } : view === 'all' ? { open: false } : {}),
    ...(filters.kind ? { kind: filters.kind } : {}),
    ...(filters.receipt ? { goodsReceiptId: filters.receipt } : {}),
    ...(filters.lot ? { lotId: filters.lot } : {}),
    ...(filters.q.trim() ? { q: filters.q.trim() } : {}),
    ...(cursor ? { cursor } : {}),
  }
}

/** The list's address: the view (left out when it is the default), the filters, and the Return dialog (`?return=1`). */
export function claimsAddress(pathname: string, view: ClaimView, filters: ClaimFilters, options: { returnOpen?: boolean } = {}): string {
  const query = new URLSearchParams()
  if (view !== defaultView(filters)) query.set('view', view)
  if (filters.kind) query.set('kind', filters.kind)
  if (filters.receipt) query.set('receipt', filters.receipt)
  if (filters.lot) query.set('lot', filters.lot)
  if (filters.q.trim()) query.set('q', filters.q.trim())
  if (options.returnOpen) query.set('return', '1')
  const text = query.toString()
  return `${pathname}${text ? `?${text}` : ''}`
}

/** The tiles: named saved filters (design sec:tiles); a count unknown draws '—', 0 is an answer, tiles are never hidden. */
export const TILES: readonly { id: 'open' | 'waiting' | 'credit' | 'closed'; view: ClaimView; count: (counts: ClaimCounts) => number; hint?: string }[] = Object.freeze([
  { id: 'open', view: 'open', count: (counts) => counts.open },
  { id: 'waiting', view: 'sent', count: (counts) => counts.waitingForSupplier },
  { id: 'credit', view: 'accepted', count: (counts) => counts.creditExpected, hint: 'tile.creditHint' },
  { id: 'closed', view: 'closed', count: (counts) => counts.closedThisMonth, hint: 'tile.closedHint' },
])

export const STATUS_TONE = Object.freeze({ DRAFT: 'neutral', SENT: 'info', ACCEPTED: 'success', REJECTED: 'danger', CLOSED: 'neutral', CANCELLED: 'neutral' } as const)
export const KIND_TONE = Object.freeze({ RETURN: 'warning', CLAIM: 'info' } as const)
export const OPEN_STATUSES: readonly ClaimStatus[] = Object.freeze(['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED'])

/** The reason's words in the person's language: the CLAIM list's label (else the tenant's code) and the note. */
export function reasonWords(reason: ClaimRow['reason'], locale: Locale): { label: string | null; note: string | null } {
  const label = (locale === 'it' ? reason.labelIt : reason.labelEn) ?? reason.labelEn ?? reason.labelIt ?? reason.code
  return { label, note: reason.note }
}

// ---- the list page's model ------------------------------------------------------------------------------------------------

export interface ClaimsListModel {
  prefix: string
  can: ClaimsCan
  view: ClaimView
  filters: ClaimFilters
  /** The chips' words for `?receipt=` and `?lot=` (null: not known; the chip says "this receipt" / "this lot"). */
  chips: { receipt: string | null; lot: string | null }
  rows: { items: ClaimRow[] | null; more: boolean; problem: string | null }
  counts: ClaimCounts | null
  countsProblem: string | null
  asOf: string | null
  live: LiveState
  updates: number
  notice: { tone: 'success' | 'danger' | 'info'; words: Words } | null
  /** Return to supplier, while it is open. */
  ret: ReturnDialogModel | null
  selected?: readonly string[]
  focusRow?: number
  helpOpen?: boolean
  timeZone?: string
}

export interface ClaimsListActions {
  onView?: (view: ClaimView) => void
  onSearch?: (q: string) => void
  onKind?: (kind: ClaimKind | null) => void
  onClearFilter?: (filter: 'receipt' | 'lot' | 'all') => void
  onMore?: () => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onOpen?: (id: string) => void
  onExport?: (ids: string[]) => void
  onDismissNotice?: () => void
  onReturn?: (open: boolean) => void
  onReturnDraft?: (draft: ReturnDraft) => void
  onReturnSearch?: (q: string) => void
  onReturnPick?: (lot: LotRow | null) => void
  onReturnContacts?: () => void
  onReturnCreate?: () => void
  onOpenDdt?: (ddtId: string) => void
}

// ---- the return DDT ---------------------------------------------------------------------------------------------------------

export interface DdtDraft {
  transportBy: TransportBy
  carrier: string
  packages: string
  grossWeightKg: string
  appearance: string
  remarks: string
}
export const NO_DDT: DdtDraft = Object.freeze({ transportBy: 'SENDER', carrier: '', packages: '1', grossWeightKg: '', appearance: '', remarks: '' }) as DdtDraft

const decimal = (text: string) => text.trim().replace(',', '.')
export const isPositive = (text: string, places = 4) => new RegExp(`^\\d+(\\.\\d{1,${places}})?$`).test(decimal(text)) && Number(decimal(text)) > 0
const isWhole = (text: string) => /^\d+$/.test(text.trim())

/** Why the DDT block is not complete, or null (who carries, the carrier's name, packages, gross weight). */
export function ddtHeld(draft: DdtDraft): Words | null {
  if (draft.transportBy === 'CARRIER' && draft.carrier.trim() === '') return words('ddt.held.carrier')
  if (!isWhole(draft.packages) || Number(draft.packages) < 1) return words('ddt.held.packages')
  if (!isPositive(draft.grossWeightKg, 3)) return words('ddt.held.weight')
  return null
}

export function ddtBody(draft: DdtDraft): ReturnDdtRequest {
  return {
    reason: 'RETURN',
    transportBy: draft.transportBy,
    ...(draft.transportBy === 'CARRIER' ? { carrier: { name: draft.carrier.trim() } } : {}),
    packages: Number(draft.packages.trim()),
    grossWeightKg: decimal(draft.grossWeightKg),
    ...(draft.appearance.trim() ? { appearance: draft.appearance.trim() } : {}),
    ...(draft.remarks.trim() ? { remarks: draft.remarks.trim() } : {}),
  }
}

// ---- Return to supplier (pop:return) -------------------------------------------------------------------------------------------

export interface ReturnDraft {
  /** The lot search as typed. */
  q: string
  /** The lots in stock it found (null: nothing searched yet). */
  found: Part<LotRow[]> | null
  lot: LotRow | null
  /** The lot's stock per place (a lot by quantity). */
  stock: Part<LotRecord['stock']>
  /** A leather lot's hides in stock. */
  hides: Part<HideRow[]>
  hideIds: string[]
  /** How much goes back from each place, by location id (a lot by quantity), in the material's base unit. */
  quantities: Record<string, string>
  reasons: Part<PickerReason[]>
  reasonCode: string
  reasonNote: string
  remedy: ClaimRemedy
  /** E-mail the supplier now (else the goods and their DDT tell it). */
  mail: boolean
  contacts: Part<SupplierContact[]> | null
  contactIds: string[]
  message: string
  ddt: DdtDraft
}

export const NO_RETURN: ReturnDraft = Object.freeze({
  q: '',
  found: null,
  lot: null,
  stock: LOADING,
  hides: LOADING,
  hideIds: [],
  quantities: {},
  reasons: LOADING,
  reasonCode: '',
  reasonNote: '',
  remedy: 'CREDIT',
  mail: false,
  contacts: null,
  contactIds: [],
  message: '',
  ddt: NO_DDT,
}) as ReturnDraft

export interface ReturnDialogModel {
  draft: ReturnDraft
  busy: boolean
  problem: Words | null
  result: ReturnAnswer | null
}

export const isHideLot = (lot: Pick<LotRow, 'item'> | null): boolean => lot?.item.tracking === 'HIDE'

/** A lot just picked: every hide in stock ticked; each place's whole stock typed. */
export function pickedLot(draft: ReturnDraft, lot: LotRow | null): ReturnDraft {
  return { ...draft, lot, stock: LOADING, hides: LOADING, hideIds: [], quantities: {}, contacts: null, contactIds: [] }
}

export function withStock(draft: ReturnDraft, stock: Part<LotRecord['stock']>): ReturnDraft {
  const quantities = stock.value ? Object.fromEntries(stock.value.filter((row) => Number(row.onHand) > 0).map((row) => [row.location.id, plain(row.onHand)])) : {}
  return { ...draft, stock, quantities }
}

export function withHides(draft: ReturnDraft, hides: Part<HideRow[]>): ReturnDraft {
  return { ...draft, hides, hideIds: hides.value ? hides.value.map((hide) => hide.id) : [] }
}

/** "42.6000" → "42.6" (what the person reads and types). */
export const plain = (text: string): string => (text.includes('.') ? text.replace(/\.?0+$/, '') : text)

/** Why "Create return" is held, in words: the rights first, then the lot, what goes, the reason, the mail, the DDT. */
export function returnHeld(draft: ReturnDraft, can: ClaimsCan): Words | null {
  if (!can.manage) return words('held.permission', { permission: 'purchasing.claims.manage' })
  if (!can.ret) return words('held.permission', { permission: 'purchasing.claims.return' })
  if (!can.ddtIssue) return words('held.permission', { permission: 'shipping.ddt.issue' })
  if (!can.stock) return words('held.permission', { permission: 'inventory.stock.view' })
  const lot = draft.lot
  if (!lot) return words('ret.held.lot')
  if (!lot.supplier) return words('ret.held.noSupplier', { lot: lot.code })
  if (isHideLot(lot)) {
    if (draft.hides.problem) return words('ret.held.readFailed')
    if (!draft.hides.value) return words('held.loading')
    if (draft.hides.value.length === 0) return words('ret.held.noHideInStock', { lot: lot.code })
    if (draft.hideIds.length === 0) return words('ret.held.noHide')
  } else {
    if (draft.stock.problem) return words('ret.held.readFailed')
    if (!draft.stock.value) return words('held.loading')
    const places = draft.stock.value.filter((row) => Number(row.onHand) > 0)
    if (places.length === 0) return words('ret.held.nothingInStock', { lot: lot.code })
    const typed = places.filter((row) => (draft.quantities[row.location.id] ?? '').trim() !== '')
    for (const row of typed) {
      const text = draft.quantities[row.location.id]!
      if (!/^\d+([.,]\d{1,4})?$/.test(text.trim())) return words('ret.held.quantity', { place: row.location.code })
      if (Number(decimal(text)) > Number(row.onHand)) return words('ret.held.tooMuch', { place: row.location.code, onHand: plain(row.onHand) })
    }
    if (!typed.some((row) => Number(decimal(draft.quantities[row.location.id]!)) > 0)) return words('ret.held.nothing')
  }
  if (draft.reasons.problem) return words('ret.held.reasonsFailed')
  if (!draft.reasonCode) return words('ret.held.reason')
  const reason = draft.reasons.value?.find((entry) => entry.code === draft.reasonCode)
  if (reason?.needsDetail && draft.reasonNote.trim() === '') return words('ret.held.note')
  if (draft.mail) {
    if (!can.parties) return words('held.permission', { permission: 'parties.view' })
    if (!draft.contacts?.value) return words(draft.contacts?.problem ? 'ret.held.contactsFailed' : 'held.loading')
    if (draft.contactIds.length === 0) return words('ret.held.contact')
  }
  return ddtHeld(draft.ddt)
}

/** The body of POST /purchasing/claims/returns: the lot (its hides named) or what goes from each place, the reason, the remedy, the mail or none, the DDT. */
export function returnBody(draft: ReturnDraft): ReturnToSupplierBody {
  const lot = draft.lot!
  const base = {
    reasonCode: draft.reasonCode,
    ...(draft.reasonNote.trim() ? { reasonNote: draft.reasonNote.trim() } : {}),
    remedy: draft.remedy,
    mail: draft.mail ? { contactIds: draft.contactIds, ...(draft.message.trim() ? { message: draft.message.trim() } : {}) } : null,
    ddt: ddtBody(draft.ddt),
  }
  if (isHideLot(lot)) return { ...base, from: { lotId: lot.id, hideIds: draft.hideIds } }
  const places = (draft.stock.value ?? []).filter((row) => Number(row.onHand) > 0)
  const whole = places.every((row) => Number(decimal(draft.quantities[row.location.id] ?? '')) === Number(row.onHand))
  if (whole) return { ...base, from: { lotId: lot.id } }
  return {
    ...base,
    lines: places
      .filter((row) => Number(decimal(draft.quantities[row.location.id] ?? '')) > 0)
      .map((row) => ({ lotId: lot.id, quantity: decimal(draft.quantities[row.location.id]!), uom: lot.item.baseUom, fromLocationId: row.location.id })),
  }
}

// ---- refusals in words ---------------------------------------------------------------------------------------------------------

const pathsOf = (error: unknown): string[] => (isApiError(error) ? error.issues.map(issuePath).map((path) => path.replace(/\./g, '/')) : [])
const has = (paths: readonly string[], part: string) => paths.some((path) => path.includes(part))
/** A refusal's sentence, read only to classify it (never drawn). */
const sentence = (error: unknown): string => (isApiError(error) ? [error.message, ...error.issues.map((issue) => issue.message ?? '')].join(' ').toLowerCase() : '')

/** A refused write, by its kind (a path the screen knows has its own words first). */
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

/** The DDT's fields a refusal names (who carries, packages, weight), or null. */
function ddtRefusal(paths: readonly string[]): Words | null {
  if (has(paths, 'ddt/transportBy') || has(paths, 'transportBy')) return words('ddt.refused.transport')
  if (has(paths, 'carrier')) return words('ddt.held.carrier')
  if (has(paths, 'grossWeightKg')) return words('ddt.refused.weight')
  if (has(paths, 'packages')) return words('ddt.held.packages')
  if (has(paths, 'ddt')) return words('ddt.refused.other')
  return null
}

/** Return to supplier refused (POST /purchasing/claims/returns), or the goods of a claim (…/:id/return): in our words. */
export function returnRefusal(error: unknown): Words {
  const paths = pathsOf(error)
  const text = sentence(error)
  if (isApiError(error) && error.kind === 'forbidden') return words('ret.refused.forbidden')
  if (text.includes('reserved')) return words('ret.refused.reserved')
  const ddt = ddtRefusal(paths)
  if (ddt) return ddt
  if (has(paths, 'hideIds')) return words('ret.refused.hideGone')
  if (has(paths, 'from/lotId') || has(paths, 'lotId')) return words(text.includes('another supplier') ? 'ret.refused.otherSupplier' : 'ret.refused.nothingLeft')
  if (has(paths, 'reasonNote')) return words('ret.held.note')
  if (has(paths, 'reasonCode')) return words('ret.refused.reason')
  if (has(paths, 'contactIds') || has(paths, 'mail')) return words('ret.refused.mail')
  if (text.includes('places') || text.includes('name the one')) return words('ret.refused.places')
  if (text.includes('not in stock') || text.includes('holds nothing')) return words('ret.refused.nothingLeft')
  if (text.includes('went back already')) return words('ret.refused.gone')
  // The return DDT's own refusals without a path (B-W2a-17's issue): the series' date order, the company's legal details.
  if (text.includes('cannot take the next number') || (text.includes('ddt') && text.includes('series'))) return words('ret.refused.numbering')
  if (text.includes('legal name') || text.includes('registered office') || text.includes('vat number') || text.includes('registro delle imprese')) return words('ret.refused.company')
  if (isApiError(error) && error.kind === 'conflict' && (text.includes('draft') || text.includes('sent or accepted'))) return words('problem.changed')
  return kindWords(error)
}

// ---- the record ------------------------------------------------------------------------------------------------------------------

export const RECORD_TABS = ['claim', 'goods', 'credit', 'activity'] as const
export type RecordTab = (typeof RECORD_TABS)[number]
export const tabOf = (value: string | null | undefined): RecordTab => ((RECORD_TABS as readonly string[]).includes(value ?? '') ? (value as RecordTab) : 'claim')

export type ClaimAct = 'send' | 'answer' | 'returnGoods' | 'close' | 'cancel' | 'removeLines'

/** The lines whose goods are still here (no stock move out yet). */
export const linesLeft = (claim: Pick<Claim, 'lines'>) => claim.lines.filter((line) => line.move === null)

/** The band's main act by state (design "the primary, then ⋯"). */
export function primaryAct(claim: Pick<Claim, 'status' | 'kind' | 'lines'>): ClaimAct | null {
  const goodsLeft = claim.kind === 'RETURN' && linesLeft(claim).length > 0
  switch (claim.status) {
    case 'DRAFT':
    case 'REJECTED':
      return 'send'
    case 'SENT':
      return goodsLeft ? 'returnGoods' : 'answer'
    case 'ACCEPTED':
      return goodsLeft ? 'returnGoods' : 'close'
    default:
      return null
  }
}

/** The other acts the band offers in ⋯, in order (only the ones that may be done now). */
export function otherActs(claim: Claim, can: ClaimsCan): ClaimAct[] {
  const primary = primaryAct(claim)
  return (['answer', 'returnGoods', 'close', 'cancel'] as const).filter((act) => act !== primary && actHeld(claim, act, can) === null)
}

const statusIn = (status: ClaimStatus) => `@statusIn.${status}`

/**
 * Why an act is held now, in words (null: it may be done): the right first, then the claim's facts — the same rules as
 * factory-domain claimActions, said in this app's words.
 */
export function actHeld(claim: Pick<Claim, 'status' | 'kind' | 'lines' | 'remedy' | 'number'>, act: ClaimAct, can: ClaimsCan): Words | null {
  if (act === 'returnGoods') {
    if (!can.ret) return words('held.permission', { permission: 'purchasing.claims.return' })
    if (!can.ddtIssue) return words('held.permission', { permission: 'shipping.ddt.issue' })
  } else if (!can.manage) return words('held.permission', { permission: 'purchasing.claims.manage' })
  const status = claim.status
  switch (act) {
    case 'send':
      if (status !== 'DRAFT' && status !== 'REJECTED') return words('held.send.state', { status: statusIn(status) })
      if (claim.lines.length === 0) return words('held.send.noLines')
      return null
    case 'answer':
      return status === 'SENT' ? null : words('held.answer.state', { status: statusIn(status) })
    case 'close':
      if (status === 'DRAFT') return words('held.close.draft')
      return status === 'SENT' || status === 'ACCEPTED' || status === 'REJECTED' ? null : words('held.close.state', { status: statusIn(status) })
    case 'cancel':
      return status === 'DRAFT' ? null : words(status === 'SENT' || status === 'ACCEPTED' || status === 'REJECTED' ? 'held.cancel.sent' : 'held.cancel.state', { status: statusIn(status) })
    case 'removeLines':
      return status === 'DRAFT' ? null : words('held.lines.state', { status: statusIn(status) })
    case 'returnGoods':
      if (claim.kind !== 'RETURN') return words('held.return.claim')
      if (status === 'DRAFT') return words('held.return.draft')
      if (status !== 'SENT' && status !== 'ACCEPTED') return words('held.return.state', { status: statusIn(status) })
      if (linesLeft(claim).length === 0) return words('held.return.allGone')
      return null
  }
}

/** The remedy is chosen when the claim is sent (a DRAFT may still leave it open). */
export const remedyMissing = (claim: Pick<Claim, 'remedy'>) => claim.remedy === null

// ---- the Claim tab's form (explicit save) -------------------------------------------------------------------------------------

export interface ClaimForm {
  kind: ClaimKind
  foundAt: ClaimFoundAt
  reasonCode: string
  reasonNote: string
  remedy: ClaimRemedy | ''
  /** The credit agreed with the supplier, typed in the currency's units ("18,90"; cost grain). */
  agreed: string
  internalNote: string
}

export type FormField = keyof ClaimForm

const minorText = (minor: number | null | undefined) => (minor === null || minor === undefined ? '' : (minor / 100).toFixed(2))

export function formOf(claim: Claim): ClaimForm {
  return {
    kind: claim.kind,
    foundAt: claim.foundAt,
    reasonCode: claim.reason.code ?? '',
    reasonNote: claim.reason.note ?? '',
    remedy: claim.remedy ?? '',
    agreed: minorText(claim.expectedCreditAmount),
    internalNote: claim.internalNote ?? '',
  }
}

/** The fields the person may change now (the API's rule by state; none without purchasing.claims.manage). */
export function editableFields(claim: Pick<Claim, 'status'>, can: Pick<ClaimsCan, 'manage' | 'cost'>): ReadonlySet<FormField> {
  if (!can.manage) return new Set()
  switch (claim.status) {
    case 'DRAFT':
      return new Set<FormField>(['kind', 'foundAt', 'reasonCode', 'reasonNote', 'remedy', 'internalNote'])
    case 'SENT':
    case 'ACCEPTED':
    case 'REJECTED':
      return new Set<FormField>(can.cost ? ['remedy', 'agreed', 'internalNote'] : ['remedy', 'internalNote'])
    default:
      return new Set<FormField>(['internalNote'])
  }
}

/** Typed money ("18,90", "18.9", "18") → minor units; null when it is no amount. */
export function minorOf(text: string): number | null {
  const cleaned = text.trim().replace(',', '.')
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null
  return Math.round(Number(cleaned) * 100)
}

/** The fields changed from the claim as read. */
export function changedFields(form: ClaimForm, claim: Claim, can: Pick<ClaimsCan, 'manage' | 'cost'>): FormField[] {
  const base = formOf(claim)
  const editable = editableFields(claim, can)
  return (Object.keys(form) as FormField[]).filter((field) => editable.has(field) && form[field].trim() !== base[field].trim())
}

/** Why Save is held (null: it may save). */
export function formHeld(form: ClaimForm, claim: Claim, can: Pick<ClaimsCan, 'manage' | 'cost'>, reasons: readonly PickerReason[] | null): Words | null {
  if (!can.manage) return words('held.permission', { permission: 'purchasing.claims.manage' })
  const changed = changedFields(form, claim, can)
  if (changed.length === 0) return words('form.held.nothing')
  if ((changed.includes('reasonCode') || changed.includes('reasonNote')) && !form.reasonCode) return words('form.held.reason')
  const reason = reasons?.find((entry) => entry.code === form.reasonCode)
  if ((changed.includes('reasonCode') || changed.includes('reasonNote')) && reason?.needsDetail && form.reasonNote.trim() === '') return words('form.held.note')
  if (changed.includes('remedy') && form.remedy === '' && claim.status !== 'DRAFT') return words('form.held.remedy')
  if (changed.includes('agreed') && form.agreed.trim() !== '' && minorOf(form.agreed) === null) return words('form.held.agreed')
  return null
}

/** The PATCH body: the version and only what changed. */
export function formPatch(form: ClaimForm, claim: Claim, can: Pick<ClaimsCan, 'manage' | 'cost'>): ClaimPatch {
  const changed = new Set(changedFields(form, claim, can))
  const text = (value: string) => (value.trim() === '' ? null : value.trim())
  return {
    version: claim.version,
    ...(changed.has('kind') ? { kind: form.kind } : {}),
    ...(changed.has('foundAt') ? { foundAt: form.foundAt } : {}),
    ...(changed.has('reasonCode') || changed.has('reasonNote') ? { reasonCode: form.reasonCode, reasonNote: text(form.reasonNote) } : {}),
    ...(changed.has('remedy') ? { remedy: form.remedy === '' ? null : form.remedy } : {}),
    ...(changed.has('agreed') ? { expectedCreditAmount: form.agreed.trim() === '' ? null : minorOf(form.agreed) } : {}),
    ...(changed.has('internalNote') ? { internalNote: text(form.internalNote) } : {}),
  }
}

/** A save refused: the field it names, else by kind. */
export function formRefusal(error: unknown): Words {
  const paths = pathsOf(error)
  if (has(paths, 'body/kind')) return words('form.refused.kind')
  if (has(paths, 'reasonNote')) return words('form.held.note')
  if (has(paths, 'reasonCode')) return words('form.refused.reason')
  if (has(paths, 'remedy')) return words('form.held.remedy')
  if (has(paths, 'expectedCreditAmount')) return words('form.held.agreed')
  if (has(paths, 'goodsReceiptId') || has(paths, 'purchaseOrderId')) return words('form.refused.receipt')
  return kindWords(error)
}

// ---- the record's dialogs ---------------------------------------------------------------------------------------------------------

export interface SendDraft {
  check: Part<SendCheck>
  /** E-mail the supplier on the claim's thread (else: told another way). */
  withMail: boolean
  contactIds: string[]
  cc: string
  subject: string
  message: string
  /** Chosen now when the claim asked for nothing yet. */
  remedy: ClaimRemedy | ''
}

export function sendDraftOf(claim: Pick<Claim, 'remedy'>): SendDraft {
  return { check: LOADING, withMail: true, contactIds: [], cc: '', subject: '', message: '', remedy: claim.remedy ?? '' }
}

/** The check read: the suggested contacts ticked, the standard subject and text in the supplier's language. */
export function withCheck(draft: SendDraft, check: Part<SendCheck>): SendDraft {
  if (!check.value) return { ...draft, check }
  return { ...draft, check, contactIds: check.value.recipients.filter((entry) => entry.suggested).map((entry) => entry.contactId), subject: check.value.subject, message: check.value.message }
}

/** "anna@…; luca@…" → the addresses; the invalid ones apart. */
export function parseCc(text: string): { valid: string[]; invalid: string[] } {
  const parts = [...new Set(text.split(/[;,\s]+/).map((part) => part.trim()).filter(Boolean))]
  const ok = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254
  return { valid: parts.filter(ok).slice(0, 10), invalid: parts.filter((part) => !ok(part)) }
}

export function sendHeld(draft: SendDraft, claim: Pick<Claim, 'status' | 'kind' | 'lines' | 'remedy' | 'number'>, can: ClaimsCan): Words | null {
  const held = actHeld(claim, 'send', can)
  if (held) return held
  if (claim.remedy === null && draft.remedy === '') return words('send.held.remedy')
  if (!draft.withMail) return null
  if (draft.check.problem) return words('send.held.checkFailed')
  if (!draft.check.value) return words('held.loading')
  if (draft.check.value.recipients.length === 0) return words('send.held.noContacts')
  if (draft.contactIds.length === 0) return words('send.held.noContact')
  const cc = parseCc(draft.cc)
  if (cc.invalid.length > 0) return words('send.held.cc', { list: cc.invalid.join(', ') })
  if (draft.message.trim() === '') return words('send.held.message')
  return null
}

export function sendBody(draft: SendDraft, claim: Pick<Claim, 'version' | 'remedy'>): SendBody {
  const check = draft.check.value
  const cc = parseCc(draft.cc).valid
  return {
    version: claim.version,
    ...(claim.remedy === null && draft.remedy !== '' ? { remedy: draft.remedy } : {}),
    mail:
      draft.withMail && check
        ? {
            contactIds: draft.contactIds,
            ...(cc.length > 0 ? { cc } : {}),
            ...(draft.subject.trim() && draft.subject.trim() !== check.subject ? { subject: draft.subject.trim() } : {}),
            ...(draft.message.trim() !== check.message.trim() ? { message: draft.message.trim() } : {}),
            language: check.language,
          }
        : null,
  }
}

export interface AnswerDraft {
  outcome: 'ACCEPTED' | 'REJECTED' | ''
  answer: string
  remedy: ClaimRemedy | ''
  /** The credit agreed (cost grain), typed; empty: the lines' value. */
  agreed: string
}

export const answerDraftOf = (claim: Pick<Claim, 'remedy'>): AnswerDraft => ({ outcome: '', answer: '', remedy: claim.remedy ?? '', agreed: '' })

export function answerHeld(draft: AnswerDraft, claim: Claim, can: ClaimsCan): Words | null {
  const held = actHeld(claim, 'answer', can)
  if (held) return held
  if (draft.outcome === '') return words('answer.held.outcome')
  if (draft.answer.trim() === '') return words('answer.held.words')
  if (draft.outcome === 'ACCEPTED' && draft.remedy !== 'REPLACEMENT' && can.cost && draft.agreed.trim() !== '' && minorOf(draft.agreed) === null) return words('form.held.agreed')
  return null
}

export function answerBody(draft: AnswerDraft, claim: Claim, can: Pick<ClaimsCan, 'cost'>): AnswerBody {
  const agreed = draft.outcome === 'ACCEPTED' && draft.remedy !== 'REPLACEMENT' && can.cost && draft.agreed.trim() !== '' ? minorOf(draft.agreed) : null
  return {
    version: claim.version,
    outcome: draft.outcome as 'ACCEPTED' | 'REJECTED',
    answer: draft.answer.trim(),
    ...(draft.remedy !== '' && draft.remedy !== claim.remedy ? { remedy: draft.remedy } : {}),
    ...(agreed !== null ? { expectedCreditAmount: agreed } : {}),
  }
}

export interface GoodsDraft {
  lineIds: string[]
  ddt: DdtDraft
}

export const goodsDraftOf = (claim: Pick<Claim, 'lines'>): GoodsDraft => ({ lineIds: linesLeft(claim).map((line) => line.id), ddt: NO_DDT })

export function goodsHeld(draft: GoodsDraft, claim: Claim, can: ClaimsCan): Words | null {
  const held = actHeld(claim, 'returnGoods', can)
  if (held) return held
  if (draft.lineIds.length === 0) return words('goods.held.none')
  return ddtHeld(draft.ddt)
}

export const goodsBody = (draft: GoodsDraft, claim: Pick<Claim, 'version'>): ReturnGoodsBody => ({ version: claim.version, lines: draft.lineIds.map((lineId) => ({ lineId })), ddt: ddtBody(draft.ddt) })

export type ClaimDialog =
  | { kind: 'send'; draft: SendDraft }
  | { kind: 'answer'; draft: AnswerDraft }
  | { kind: 'close'; note: string }
  | { kind: 'cancel'; reason: string }
  | { kind: 'removeLines'; lineIds: string[] }
  | { kind: 'returnGoods'; draft: GoodsDraft }
  /** After the goods went back: the DDT and what the return left over-reserved. */
  | { kind: 'returned'; answer: ReturnAnswer }

/** Why a simple dialog is held (close, cancel, remove lines). */
export function simpleHeld(dialog: ClaimDialog, claim: Claim, can: ClaimsCan): Words | null {
  switch (dialog.kind) {
    case 'close':
      return actHeld(claim, 'close', can) ?? (dialog.note.trim().length < 3 ? words('close.held.note') : null)
    case 'cancel':
      return actHeld(claim, 'cancel', can) ?? (dialog.reason.trim().length < 3 ? words('cancel.held.reason') : null)
    case 'removeLines':
      return actHeld(claim, 'removeLines', can) ?? (dialog.lineIds.length === 0 ? words('lines.held.none') : null)
    default:
      return null
  }
}

/** A dialog's write refused, in our words. */
export function dialogRefusal(dialog: ClaimDialog['kind'], error: unknown): Words {
  if (dialog === 'returnGoods') return returnRefusal(error)
  const paths = pathsOf(error)
  if (dialog === 'send') {
    if (has(paths, 'remedy')) return words('send.held.remedy')
    if (has(paths, 'contactIds') || has(paths, 'mail')) return words('send.refused.mail')
    if (has(paths, 'cc')) return words('send.held.cc', { list: '' })
  }
  if (dialog === 'answer' && has(paths, 'expectedCreditAmount')) return words('form.held.agreed')
  if (dialog === 'close' && has(paths, 'note')) return words('close.held.note')
  if (dialog === 'cancel' && has(paths, 'reason')) return words('cancel.held.reason')
  return kindWords(error)
}

export interface ClaimRecordModel {
  prefix: string
  can: ClaimsCan
  tab: RecordTab
  claim: Loaded<Claim>
  live: LiveState
  dockOpen: boolean
  /** Changed by someone else while a dialog or the form was open. */
  changed: { at: string } | null
  notice: { tone: 'success' | 'danger' | 'info'; words: Words } | null
  busy: boolean
  dialog: ClaimDialog | null
  dialogProblem: Words | null
  /** The Claim tab's form while it is being changed (null: as read). */
  form: ClaimForm | null
  formProblem: Words | null
  saving: boolean
  /** The CLAIM reason list (read when the form may change the reason). */
  reasons: Part<PickerReason[]>
  /** Lines ticked on the Claim tab (design cases; the view keeps its own). */
  selected?: readonly string[]
  panelsPreview?: RecordPanelsViewModel
  timeZone?: string
}

export interface ClaimRecordActions {
  onRetry?: () => void
  onReload?: () => void
  onDock?: () => void
  onDialog?: (dialog: ClaimDialog | null) => void
  onConfirm?: () => void
  onForm?: (form: ClaimForm | null) => void
  onSave?: () => void
  onOpenDdt?: (ddtId: string) => void
  onCopyNumber?: () => void
  onDismissNotice?: () => void
}
