import { businessDate } from '@nexus/factory-domain/core/time'
import {
  CASE_KINDS,
  CASE_LIMITS,
  CASE_VIEWS,
  COVER_STATES,
  HELD_CODES,
  LINK_RECORD_TYPES,
  moveAllowed,
  moveHeld,
  type CaseKind,
  type CasePriority,
  type CaseView,
  type CaseWish,
  type Cover,
  type CoverDecision,
  type CoverState,
  type HeldCode,
  type MoveTarget,
} from '@nexus/factory-domain/sales/service/rules'
import { isApiError, issuePath } from '../../../lib/api/errors'
import type { CaseAction, CaseRecord, CaseRow, CaseStatus, ChangeBody, MoveBody, Moved, OpenBody, Person, WarrantyCheck } from './api'

/**
 * Warranty & service (SCR-217 the list, SCR-413 the case; B-W2b-353 on B-W2b-345's API), pure: who may do what, the page's
 * address (the tiles and saved rows are the API's own `view`, one filter model with a chip per filter), the notices from
 * the rows read, a row verb held before the click, the warranty check said in OUR words from its states and dates (never the
 * API's English sentences), the cover decision's checks, the moves and what each needs, the Case form's draft and what Apply
 * sends, New case's draft, its preview body and its create body; a refusal said by its code. No React, no API client.
 */

export const NS = 'sales-service'
export const TIME_ZONE = 'Europe/Rome'

/** A phrase of the catalogue: its key and parameters (a parameter that is itself a key is said in words first). */
export interface Phrase {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

export interface Notice extends Phrase {
  readonly tone: 'success' | 'info' | 'warning' | 'danger'
  readonly link?: { readonly href: string; readonly label: Phrase } | null
  readonly lines?: readonly Phrase[]
}

export const todayOf = (now: string | Date): string => businessDate(typeof now === 'string' ? new Date(now) : now, TIME_ZONE)

// ---- who may do what ------------------------------------------------------------------------------------------------------

export interface ServiceCan {
  /** The list and the case (sales.service.view). */
  view: boolean
  /** New case, the Case form, moves, links (sales.service.manage). */
  manage: boolean
  /** The cover decision (sales.service.decide). */
  decide: boolean
  /** Make repair also needs W2a's sales.repairs.manage; Make RMA sales.returns.manage. */
  repairs: boolean
  returns: boolean
  /** The customer pickers (parties.view). */
  parties: boolean
  /** The Activity tab's thread (threads.read). */
  threads: boolean
}

export function serviceCan(permissions: readonly string[]): ServiceCan {
  const held = new Set(permissions)
  return {
    view: held.has('sales.service.view'),
    manage: held.has('sales.service.manage'),
    decide: held.has('sales.service.decide'),
    repairs: held.has('sales.repairs.manage'),
    returns: held.has('sales.returns.manage'),
    parties: held.has('parties.view'),
    threads: held.has('threads.read'),
  }
}

/** The rights a held control may name (`right.<permission>` words). */
export const KNOWN_RIGHTS = ['sales.service.manage', 'sales.service.decide', 'sales.repairs.manage', 'sales.returns.manage', 'parties.view', 'threads.read'] as const
const right = (permission: (typeof KNOWN_RIGHTS)[number]): Phrase => ({ key: 'held.right', params: { right: `right.${permission}` } })

// ---- the list's address ---------------------------------------------------------------------------------------------------

export interface ListAddress {
  readonly view: CaseView
  readonly q: string
  readonly kind: CaseKind | null
  readonly cover: CoverState | null
  /** A garment's cases (its serial as typed or ours). */
  readonly serial: string
  /** New case open (`?new=1`). */
  readonly isNew: boolean
}

export const HOME_ADDRESS: ListAddress = Object.freeze({ view: 'open', q: '', kind: null, cover: null, serial: '', isNew: false })

/** The tiles (design service.tiles; "SLA near breach" is Later and not drawn). */
export const TILES = ['new', 'waitingCustomer', 'waitingPart'] as const satisfies readonly CaseView[]
export type Tile = (typeof TILES)[number]
/** Rows ▾: the saved rows (Open · Mine · Waiting · Closed · All) and the tiles' rows. */
export const SAVED_ROWS: readonly CaseView[] = ['open', 'mine', 'waiting', 'new', 'waitingCustomer', 'waitingPart', 'closed', 'all']

const pick = <T extends string>(value: string | null | undefined, allowed: readonly T[]): T | null => (value && (allowed as readonly string[]).includes(value) ? (value as T) : null)

export function addressOf(params: { get(name: string): string | null } | null): ListAddress {
  if (!params) return HOME_ADDRESS
  return {
    view: pick(params.get('view'), CASE_VIEWS) ?? 'open',
    q: (params.get('q') ?? '').slice(0, 100),
    kind: pick(params.get('kind'), CASE_KINDS),
    cover: pick(params.get('cover'), COVER_STATES),
    serial: (params.get('serial') ?? '').slice(0, 100),
    isNew: params.get('new') === '1',
  }
}

export function addressText(address: ListAddress): string {
  const query = new URLSearchParams()
  if (address.view !== 'open') query.set('view', address.view)
  if (address.q.trim()) query.set('q', address.q.trim())
  if (address.kind) query.set('kind', address.kind)
  if (address.cover) query.set('cover', address.cover)
  if (address.serial.trim()) query.set('serial', address.serial.trim())
  if (address.isNew) query.set('new', '1')
  const text = query.toString()
  return text ? `?${text}` : ''
}

export const listHref = (prefix: string, address: Partial<ListAddress> = {}): string => `${prefix}/sales/service${addressText({ ...HOME_ADDRESS, ...address })}`

export const isFiltered = (address: ListAddress): boolean => address.view !== 'open' || !!address.q.trim() || !!address.kind || !!address.cover || !!address.serial.trim()

/** One chip per filter (the pressed tile's too): what it says and what pressing ✕ clears. */
export interface Chip {
  readonly id: string
  readonly label: Phrase
  readonly clear: Partial<ListAddress>
}

export function chipsOf(address: ListAddress): Chip[] {
  const chips: Chip[] = []
  if (address.view !== 'open') chips.push({ id: 'view', label: { key: 'chip.view', params: { view: `view.${address.view}` } }, clear: { view: 'open' } })
  if (address.kind) chips.push({ id: 'kind', label: { key: 'chip.kind', params: { kind: `kind.${address.kind}` } }, clear: { kind: null } })
  if (address.cover) chips.push({ id: 'cover', label: { key: 'chip.cover', params: { cover: `cover.${address.cover}` } }, clear: { cover: null } })
  if (address.serial.trim()) chips.push({ id: 'serial', label: { key: 'chip.serial', params: { serial: address.serial.trim() } }, clear: { serial: '' } })
  if (address.q.trim()) chips.push({ id: 'q', label: { key: 'chip.q', params: { q: address.q.trim() } }, clear: { q: '' } })
  return chips
}

/** A tile's number: the API's count, "—" while unknown or when the count failed (never 0 for unknown). */
export const tileValue = (counts: { readonly tiles: Readonly<Record<Tile, number>> } | null, tile: Tile): string => (counts ? String(counts.tiles[tile]) : '—')

// ---- the notices (design service.notices: one Banner at a time, the most serious first) ----------------------------------------

export interface PageNotice extends Notice {
  /** Kept dismissed by this value: a new fact (another count) shows again. */
  readonly id: string
}

const isOpenStatus = (status: CaseStatus): boolean => status !== 'CLOSED'

/**
 * What the list needs but its rows lack, from the rows read (design "Data the list needs but lacks"): open cases whose cover
 * cannot be told (no delivery day), warranty claims waiting for their cover decision (they resolve only once it is decided),
 * cases that name no customer (a repair or a return needs one), and the notices counted on the first page only.
 */
export function pageNotices(rows: readonly CaseRow[] | null, more: boolean, prefix: string, dismissed: ReadonlySet<string>): PageNotice[] {
  if (!rows) return []
  const open = rows.filter((row) => isOpenStatus(row.status))
  const unknown = open.filter((row) => row.cover.state === 'UNKNOWN').length
  const undecided = open.filter((row) => row.kind === 'WARRANTY' && !row.cover.decided && row.status !== 'RESOLVED').length
  const noCustomer = open.filter((row) => !row.party).length
  const notices: PageNotice[] = []
  if (unknown > 0) notices.push({ id: `unknown:${unknown}`, tone: 'warning', key: 'notice.unknownCover', params: { count: unknown }, link: { href: listHref(prefix, { cover: 'UNKNOWN', view: 'open' }), label: { key: 'notice.unknownCoverLink' } } })
  if (undecided > 0) notices.push({ id: `undecided:${undecided}`, tone: 'warning', key: 'notice.undecided', params: { count: undecided }, link: { href: listHref(prefix, { kind: 'WARRANTY', view: 'open' }), label: { key: 'notice.undecidedLink' } } })
  if (noCustomer > 0) notices.push({ id: `noCustomer:${noCustomer}`, tone: 'info', key: 'notice.noCustomer', params: { count: noCustomer } })
  if (more) notices.push({ id: `partial:${rows.length}`, tone: 'info', key: 'notice.partial', params: { count: rows.length } })
  return notices.filter((notice) => !dismissed.has(notice.id))
}

// ---- the row verbs (design "Open, Make RMA, Make repair, Close"), held before the click ------------------------------------------

export type RowVerb = 'repair' | 'return' | 'close'

export function rowVerbHeld(row: Pick<CaseRow, 'status' | 'party' | 'kind' | 'cover'>, verb: RowVerb, can: ServiceCan, offline: boolean): Phrase | null {
  if (!can.manage) return right('sales.service.manage')
  if (verb === 'repair' && !can.repairs) return right('sales.repairs.manage')
  if (verb === 'return' && !can.returns) return right('sales.returns.manage')
  if (row.status === 'CLOSED') return { key: verb === 'close' ? 'held.ALREADY_CLOSED' : 'held.CLOSED' }
  if (verb !== 'close' && !row.party) return { key: 'held.NO_CUSTOMER' }
  if (verb === 'close') {
    const held = moveHeld({ from: row.status, to: 'CLOSED', kind: row.kind, coverDecided: row.cover.decided })
    if (held) return { key: `held.${held}` }
  }
  return offline ? { key: 'held.offline' } : null
}

// ---- the case's address -----------------------------------------------------------------------------------------------------

export const RECORD_TABS = ['case', 'warranty', 'linked', 'actions', 'activity'] as const
export type RecordTab = (typeof RECORD_TABS)[number]
/** What a row's verb opens on the case (`?do=`): its dialog. */
export const RECORD_DOS = ['repair', 'return', 'close', 'decide', 'link'] as const
export type RecordDo = (typeof RECORD_DOS)[number]

export function recordHref(prefix: string, caseId: string, tab?: RecordTab, todo?: RecordDo): string {
  const query = new URLSearchParams()
  if (tab && tab !== 'case') query.set('tab', tab)
  if (todo) query.set('do', todo)
  const text = query.toString()
  return `${prefix}/sales/service/${encodeURIComponent(caseId)}${text ? `?${text}` : ''}`
}

export const doOf = (params: { get(name: string): string | null } | null): RecordDo | null => pick(params?.get('do'), RECORD_DOS)

// ---- people ---------------------------------------------------------------------------------------------------------------------

/** A person by name inside one record or the list ("You" for the reader); "Nobody" when none; "A colleague" when unnamed. */
export function personPhrase(people: readonly Person[] | null | undefined, id: string | null, me: string): Phrase {
  if (!id) return { key: 'common.nobody' }
  if (id === me) return { key: 'common.you' }
  const found = people?.find((person) => person.id === id)
  return found ? { key: 'common.name', params: { name: found.name } } : { key: 'common.colleague' }
}

// ---- the warranty check in words ------------------------------------------------------------------------------------------------

export type CheckState = 'OK' | 'OPEN' | 'NOT_NEEDED' | 'UNKNOWN' | 'WARNING'

export interface WarrantyLine {
  readonly id: 'delivery' | 'buyer' | 'legal' | 'presumption' | 'factory'
  readonly state: CheckState
  readonly name: Phrase
  readonly text: Phrase
  /** "N days left" beside a guarantee that runs. */
  readonly more?: Phrase | null
  readonly fix?: Phrase | null
}

const daysLeft = (days: number | null): Phrase | null => (days === null ? null : days === 0 ? { key: 'check.lastDay' } : { key: 'check.daysLeft', params: { count: days } })

/**
 * The check's lines (design case.warranty "Legal 2-year guarantee or factory warranty, with why"), each a state AND words:
 * the delivery day the guarantees run from, who the customer is to the guarantee, the legal guarantee, the consumer's
 * first-year presumption, the factory guarantee. Dates are YYYY-MM-DD (said in the reader's format by the view).
 */
export function warrantyLines(check: WarrantyCheck): WarrantyLine[] {
  const lines: WarrantyLine[] = []
  lines.push(
    check.deliveredOn
      ? { id: 'delivery', state: 'OK', name: { key: 'check.delivery' }, text: { key: 'check.deliveredOn', params: { date: check.deliveredOn } } }
      : { id: 'delivery', state: 'UNKNOWN', name: { key: 'check.delivery' }, text: { key: 'check.noDelivery' }, fix: { key: 'check.noDeliveryFix' } },
  )
  lines.push({ id: 'buyer', state: check.buyer === 'CONSUMER' ? 'OK' : 'NOT_NEEDED', name: { key: 'check.buyer' }, text: { key: `buyer.${check.buyer}` } })
  const legal = check.legal
  if (legal.state === 'RUNS') lines.push({ id: 'legal', state: 'OK', name: { key: 'check.legal' }, text: { key: 'legal.RUNS', params: { date: legal.endsOn ?? '' } }, more: daysLeft(legal.daysLeft) })
  else if (legal.state === 'ENDED') lines.push({ id: 'legal', state: 'OPEN', name: { key: 'check.legal' }, text: { key: 'legal.ENDED', params: { date: legal.endsOn ?? '' } } })
  else if (legal.state === 'UNKNOWN') lines.push({ id: 'legal', state: 'UNKNOWN', name: { key: 'check.legal' }, text: { key: 'legal.UNKNOWN' }, fix: { key: 'check.noDeliveryFix' } })
  else lines.push({ id: 'legal', state: 'NOT_NEEDED', name: { key: 'check.legal' }, text: { key: check.buyer === 'BUSINESS' ? 'legal.NONE_BUSINESS' : 'legal.NONE_NOT_NAMED' } })
  if (check.presumption) {
    const until = check.presumption.until
    lines.push({
      id: 'presumption',
      state: check.presumption.applies ? 'OK' : until ? 'WARNING' : 'UNKNOWN',
      name: { key: 'check.presumption' },
      text: until ? { key: check.presumption.applies ? 'presumption.applies' : 'presumption.past', params: { date: until } } : { key: 'presumption.unknown' },
    })
  }
  const factory = check.factory
  if (factory.state === 'RUNS') lines.push({ id: 'factory', state: 'OK', name: { key: 'check.factory' }, text: { key: 'factory.RUNS', params: { date: factory.endsOn ?? '' } }, more: daysLeft(factory.daysLeft) })
  else if (factory.state === 'ENDED') lines.push({ id: 'factory', state: 'OPEN', name: { key: 'check.factory' }, text: { key: 'factory.ENDED', params: { date: factory.endsOn ?? '' } } })
  else lines.push({ id: 'factory', state: 'NOT_NEEDED', name: { key: 'check.factory' }, text: { key: 'factory.NONE' }, fix: { key: 'factory.NONE_FIX' } })
  return lines
}

/** What the customer may ask under a cover, and who answers to whom, in our words. */
export const remediesPhrase = (cover: Cover | null): Phrase => ({ key: cover ? `remedies.${cover}` : 'remedies.unknown' })
export const liablePhrase = (check: Pick<WarrantyCheck, 'buyer'>): Phrase => ({ key: `liable.${check.buyer}` })

// ---- the cover decision ------------------------------------------------------------------------------------------------------------

export interface CoverDraft {
  readonly cover: Cover
  readonly decision: CoverDecision
  readonly note: string
}

/** The decision as it starts: the decided one again, else what the check points to (none: not covered). */
export function coverDraftOf(record: Pick<CaseRecord, 'warranty'>): CoverDraft {
  const decided = record.warranty.decided
  if (decided) return { cover: decided.cover, decision: decided.decision, note: decided.note }
  const suggested = record.warranty.check.suggested ?? 'LEGAL_GUARANTEE'
  return { cover: suggested, decision: suggested === 'NONE' ? 'NOT_COVERED' : 'COVERED', note: '' }
}

/** The decision's checks (the API's coverProblems, said first): field → phrase. */
export function coverDraftProblems(draft: CoverDraft, warranty: Pick<CaseRecord['warranty'], 'legalGuaranteeEndsOn' | 'factoryGuaranteeEndsOn'>): Partial<Record<'cover' | 'note', Phrase>> {
  const problems: Partial<Record<'cover' | 'note', Phrase>> = {}
  if ((draft.decision === 'COVERED' || draft.decision === 'PARTLY') && draft.cover === 'NONE') problems.cover = { key: 'decide.problem.coveredNeedsGuarantee' }
  else if (draft.decision === 'NOT_COVERED' && draft.cover !== 'NONE') problems.cover = { key: 'decide.problem.notCoveredIsNone' }
  else if (draft.cover === 'LEGAL_GUARANTEE' && !warranty.legalGuaranteeEndsOn) problems.cover = { key: 'decide.problem.noLegalEnd' }
  else if (draft.cover === 'FACTORY_GUARANTEE' && !warranty.factoryGuaranteeEndsOn) problems.cover = { key: 'decide.problem.noFactoryEnd' }
  const note = draft.note.trim()
  if (note.length === 0) problems.note = { key: 'decide.problem.noteNeeded' }
  else if (note.length > CASE_LIMITS.coverNote) problems.note = { key: 'common.atMost', params: { count: CASE_LIMITS.coverNote } }
  return problems
}

/** What the person may want to know before deciding (the API's coverWarnings, in our words; never a refusal). */
export function coverDraftWarnings(draft: CoverDraft, check: WarrantyCheck): Phrase[] {
  const warnings: Phrase[] = []
  if (draft.cover === 'LEGAL_GUARANTEE' && check.legal.state === 'ENDED') warnings.push({ key: 'decide.warn.legalEnded', params: { date: check.legal.endsOn ?? '' } })
  if (draft.cover === 'LEGAL_GUARANTEE' && check.buyer !== 'CONSUMER') warnings.push({ key: 'decide.warn.notConsumer' })
  if (draft.cover === 'FACTORY_GUARANTEE' && check.factory.state === 'ENDED') warnings.push({ key: 'decide.warn.factoryEnded', params: { date: check.factory.endsOn ?? '' } })
  if (draft.decision === 'NOT_COVERED' && check.legal.state === 'RUNS') warnings.push({ key: 'decide.warn.refuseWhileLegal', params: { date: check.legal.endsOn ?? '' } })
  return warnings
}

// ---- the record's actions ----------------------------------------------------------------------------------------------------------

/** The API's answer for this reader: may it be done now, and why not (`held.<CODE>` words), offline included. */
export function actionHeld(record: Pick<CaseRecord, 'actions'>, action: CaseAction, offline: boolean, can?: ServiceCan): Phrase | null {
  const found = record.actions.find((entry) => entry.action === action)
  if (!found || (!found.allowed && (found.held ?? 'NO_PERMISSION') === 'NO_PERMISSION')) return can ? missingRight(action, can) : { key: 'held.NO_PERMISSION' }
  if (!found.allowed) return { key: `held.${found.held}` }
  return offline ? { key: 'held.offline' } : null
}

/** The right a held action lacks, named (`held.right`). */
function missingRight(action: CaseAction, can: ServiceCan): Phrase {
  if (action === 'decideCover') return right('sales.service.decide')
  if (!can.manage) return right('sales.service.manage')
  if (action === 'makeRepair') return right('sales.repairs.manage')
  if (action === 'makeReturn') return right('sales.returns.manage')
  return { key: 'held.NO_PERMISSION' }
}

/** The moves of the band and ⋯, each the API's action. */
export const MOVE_ACTIONS = ['open', 'waitCustomer', 'waitPart', 'resume', 'resolve', 'reopen', 'close'] as const satisfies readonly CaseAction[]
export type MoveAction = (typeof MOVE_ACTIONS)[number]
export const MOVE_TO: Readonly<Record<MoveAction, MoveTarget>> = Object.freeze({ open: 'OPEN', waitCustomer: 'WAITING_CUSTOMER', waitPart: 'WAITING_PART', resume: 'OPEN', resolve: 'RESOLVED', reopen: 'OPEN', close: 'CLOSED' })

/** The band's ONE primary: the next step the case asks for (a warranty claim's cover before it is resolved). */
export type Primary = { readonly kind: 'move'; readonly action: MoveAction } | { readonly kind: 'decide' }
export function primaryOf(record: Pick<CaseRecord, 'status' | 'kind' | 'warranty'>): Primary | null {
  switch (record.status) {
    case 'NEW':
      return { kind: 'move', action: 'open' }
    case 'OPEN':
      return record.kind === 'WARRANTY' && !record.warranty.decided ? { kind: 'decide' } : { kind: 'move', action: 'resolve' }
    case 'WAITING_CUSTOMER':
    case 'WAITING_PART':
      return { kind: 'move', action: 'resume' }
    case 'RESOLVED':
      return { kind: 'move', action: 'close' }
    case 'CLOSED':
      return null
  }
}

/** What a move asks for: what was done (resolved), why (closed without a resolution); words for the customer when the case tells them. */
export interface MoveNeeds {
  readonly resolution: boolean
  readonly reason: boolean
  readonly message: boolean
}
export function moveNeeds(from: CaseStatus, to: MoveTarget, notifyCustomer: boolean): MoveNeeds {
  return { resolution: to === 'RESOLVED', reason: to === 'CLOSED' && from !== 'RESOLVED', message: notifyCustomer }
}
/** A move goes at once when it asks for nothing (no words, no mail); otherwise a dialog asks first. */
export const moveAsks = (needs: MoveNeeds): boolean => needs.resolution || needs.reason || needs.message

export interface MoveDraft {
  readonly action: MoveAction
  readonly resolution: string
  readonly reason: string
  readonly message: string
}

export function moveDraftHeld(draft: MoveDraft, needs: MoveNeeds): Phrase | null {
  if (needs.resolution && draft.resolution.trim() === '') return { key: 'move.held.resolution' }
  if (needs.resolution && draft.resolution.trim().length > CASE_LIMITS.resolution) return { key: 'common.atMost', params: { count: CASE_LIMITS.resolution } }
  if (needs.reason && draft.reason.trim() === '') return { key: 'move.held.reason' }
  if (draft.reason.trim().length > CASE_LIMITS.closeReason) return { key: 'common.atMost', params: { count: CASE_LIMITS.closeReason } }
  if (draft.message.trim().length > CASE_LIMITS.message) return { key: 'common.atMost', params: { count: CASE_LIMITS.message } }
  return null
}

export function moveBodyOf(draft: MoveDraft, version: number, needs: MoveNeeds): MoveBody {
  const body: MoveBody = { version, to: MOVE_TO[draft.action] }
  if (needs.resolution) body.resolution = draft.resolution.trim()
  if (needs.reason || (MOVE_TO[draft.action] === 'CLOSED' && draft.reason.trim())) body.reason = draft.reason.trim() || null
  if (needs.message && draft.message.trim()) body.message = draft.message.trim()
  return body
}

/** The receipt of a move: where the case is now and whether the customer was told. */
export function movedNotice(answer: Moved): Notice {
  const lines: Phrase[] = []
  if (answer.notified?.sent) lines.push({ key: 'move.mailSent', params: { to: answer.notified.to } })
  else if (answer.notified && !answer.notified.sent) lines.push({ key: `move.mailNotSent.${answer.notified.reason}` })
  for (const warning of answer.warnings) lines.push(warningPhrase(warning.path))
  return { key: 'move.done', params: { number: answer.case.number, status: `status.${answer.case.status}` }, tone: answer.notified && !answer.notified.sent ? 'warning' : 'success', lines }
}

/** A warning the API sent with a write, in our words by its path (never its English). */
export function warningPhrase(path: string): Phrase {
  const field = path.replace(/^body\//, '').split('/')[0] ?? ''
  return { key: (WARNING_FIELDS as readonly string[]).includes(field) ? `warning.${field}` : 'warning.other' }
}
const WARNING_FIELDS = ['cover', 'decision', 'deliveredOn', 'serial', 'batchNumber', 'to', 'notifyCustomer', 'lines', 'contactId', 'partyId'] as const

// ---- the Case form (EditModeBar) ---------------------------------------------------------------------------------------------------

export interface CaseDraft {
  readonly kind: CaseKind
  readonly partyId: string
  readonly contactId: string
  readonly serial: string
  readonly batchNumber: string
  readonly size: string
  readonly problem: string
  readonly customerWants: CaseWish | ''
  readonly priority: CasePriority
  readonly ownerId: string
  readonly deliveredOn: string
  readonly legalGuaranteeEndsOn: string
  readonly factoryGuaranteeEndsOn: string
  readonly notifyCustomer: boolean
  readonly internalNote: string
}

export function caseDraftOf(record: CaseRecord): CaseDraft {
  return {
    kind: record.kind,
    partyId: record.party?.id ?? '',
    contactId: record.contact?.id ?? '',
    serial: record.serial ?? '',
    batchNumber: record.batchNumber ?? '',
    size: record.size ?? '',
    problem: record.problem,
    customerWants: record.customerWants ?? '',
    priority: record.priority,
    ownerId: record.ownerId ?? '',
    deliveredOn: record.warranty.deliveredOn ?? '',
    legalGuaranteeEndsOn: record.warranty.legalGuaranteeEndsOn ?? '',
    factoryGuaranteeEndsOn: record.warranty.factoryGuaranteeEndsOn ?? '',
    notifyCustomer: record.notifyCustomer,
    internalNote: record.internalNote ?? '',
  }
}

const orNull = (value: string): string | null => (value.trim() === '' ? null : value.trim())

/** Only what changed (a CLOSED case: the internal note alone; the customer only while nothing is linked). */
export function caseChangesOf(record: CaseRecord, draft: CaseDraft): Omit<ChangeBody, 'version'> {
  const before = caseDraftOf(record)
  const changes: Omit<ChangeBody, 'version'> = {}
  if (draft.internalNote !== before.internalNote) changes.internalNote = orNull(draft.internalNote)
  if (record.status === 'CLOSED') return changes
  if (draft.kind !== before.kind) changes.kind = draft.kind
  if (draft.partyId !== before.partyId && record.links.length === 0) changes.partyId = orNull(draft.partyId)
  if (draft.contactId !== before.contactId) changes.contactId = orNull(draft.contactId)
  if (draft.serial.trim() !== before.serial.trim()) changes.serial = orNull(draft.serial)
  if (draft.batchNumber.trim() !== before.batchNumber.trim()) changes.batchNumber = orNull(draft.batchNumber)
  if (draft.size.trim() !== before.size.trim()) changes.size = orNull(draft.size)
  if (draft.problem !== before.problem) changes.problem = draft.problem.trim()
  if (draft.customerWants !== before.customerWants) changes.customerWants = draft.customerWants || null
  if (draft.priority !== before.priority) changes.priority = draft.priority
  if (draft.ownerId !== before.ownerId) changes.ownerId = orNull(draft.ownerId)
  if (draft.deliveredOn !== before.deliveredOn) changes.deliveredOn = orNull(draft.deliveredOn)
  if (draft.legalGuaranteeEndsOn !== before.legalGuaranteeEndsOn) changes.legalGuaranteeEndsOn = orNull(draft.legalGuaranteeEndsOn)
  if (draft.factoryGuaranteeEndsOn !== before.factoryGuaranteeEndsOn) changes.factoryGuaranteeEndsOn = orNull(draft.factoryGuaranteeEndsOn)
  if (draft.notifyCustomer !== before.notifyCustomer) changes.notifyCustomer = draft.notifyCustomer
  return changes
}

export type CaseField = 'problem' | 'serial' | 'batchNumber' | 'size' | 'deliveredOn' | 'legalGuaranteeEndsOn' | 'factoryGuaranteeEndsOn' | 'internalNote' | 'notifyCustomer'

const oneLine = (value: string): boolean => !/[\r\n]/.test(value)

/** The form's checks, said before the API's (factProblems): field → phrase. `contactEmail`: the chosen contact's, for the status mails. */
export function caseDraftProblems(draft: Pick<CaseDraft, CaseField>, today: string, contactEmail: string | null): Partial<Record<CaseField, Phrase>> {
  const problems: Partial<Record<CaseField, Phrase>> = {}
  const problem = draft.problem.trim()
  if (problem.length === 0) problems.problem = { key: 'form.problem.problemNeeded' }
  else if (problem.length > CASE_LIMITS.problem) problems.problem = { key: 'common.atMost', params: { count: CASE_LIMITS.problem } }
  for (const field of ['serial', 'batchNumber'] as const) {
    const value = draft[field]
    if (value.trim() && (!oneLine(value) || value.trim().length > CASE_LIMITS.label)) problems[field] = { key: 'form.problem.oneLine', params: { count: CASE_LIMITS.label } }
  }
  if (draft.size.trim().length > CASE_LIMITS.size) problems.size = { key: 'form.problem.oneLine', params: { count: CASE_LIMITS.size } }
  if (draft.deliveredOn && draft.deliveredOn > today) problems.deliveredOn = { key: 'form.problem.deliveredFuture' }
  for (const field of ['legalGuaranteeEndsOn', 'factoryGuaranteeEndsOn'] as const) {
    if (draft[field] && draft.deliveredOn && draft[field] < draft.deliveredOn) problems[field] = { key: 'form.problem.endBeforeDelivery' }
  }
  if (draft.internalNote.trim().length > CASE_LIMITS.internalNote) problems.internalNote = { key: 'common.atMost', params: { count: CASE_LIMITS.internalNote } }
  if (draft.notifyCustomer && !contactEmail) problems.notifyCustomer = { key: 'form.problem.notifyNeedsEmail' }
  return problems
}

// ---- New case ----------------------------------------------------------------------------------------------------------------------

export const NEW_CHANNELS = ['PHONE', 'MAIL', 'OFFICE'] as const satisfies readonly OpenBody['channel'][]

export interface NewDraft extends Omit<CaseDraft, 'legalGuaranteeEndsOn' | 'internalNote'> {
  readonly channel: OpenBody['channel']
}

export const emptyNewDraft = (me: string): NewDraft => ({
  kind: 'WARRANTY',
  channel: 'PHONE',
  partyId: '',
  contactId: '',
  serial: '',
  batchNumber: '',
  size: '',
  problem: '',
  customerWants: '',
  priority: 'NORMAL',
  ownerId: me,
  deliveredOn: '',
  factoryGuaranteeEndsOn: '',
  notifyCustomer: false,
})

/** Create is held until the customer's words are said and the draft reads (the first problem said). */
export function newDraftHeld(draft: NewDraft, today: string, contactEmail: string | null): Phrase | null {
  const problems = caseDraftProblems({ ...draft, legalGuaranteeEndsOn: '', internalNote: '' }, today, contactEmail)
  return Object.values(problems)[0] ?? null
}

/** What the preview reads while the person types (the fields filled; nothing for an empty draft). */
export function previewBodyOf(draft: NewDraft, companyId: string | null): Partial<OpenBody> | null {
  if (!companyId) return null
  const body: Partial<OpenBody> = { companyId, kind: draft.kind, channel: draft.channel }
  if (draft.partyId) body.partyId = draft.partyId
  if (draft.serial.trim()) body.serial = draft.serial.trim()
  if (draft.batchNumber.trim()) body.batchNumber = draft.batchNumber.trim()
  if (draft.deliveredOn) body.deliveredOn = draft.deliveredOn
  if (draft.factoryGuaranteeEndsOn) body.factoryGuaranteeEndsOn = draft.factoryGuaranteeEndsOn
  return body.partyId || body.serial || body.batchNumber ? body : null
}

export function newBodyOf(draft: NewDraft, companyId: string): OpenBody {
  return {
    companyId,
    kind: draft.kind,
    channel: draft.channel,
    partyId: orNull(draft.partyId),
    contactId: orNull(draft.contactId),
    serial: orNull(draft.serial),
    batchNumber: orNull(draft.batchNumber),
    size: orNull(draft.size),
    problem: draft.problem.trim(),
    customerWants: draft.customerWants || null,
    priority: draft.priority,
    ownerId: orNull(draft.ownerId),
    ...(draft.deliveredOn ? { deliveredOn: draft.deliveredOn } : {}),
    ...(draft.factoryGuaranteeEndsOn ? { factoryGuaranteeEndsOn: draft.factoryGuaranteeEndsOn } : {}),
    notifyCustomer: draft.notifyCustomer,
  }
}

// ---- links ---------------------------------------------------------------------------------------------------------------------------

export { LINK_RECORD_TYPES }
export const linkTypeKey = (type: string): string => `linkType.${(LINK_RECORD_TYPES as readonly string[]).includes(type) ? type : 'other'}`

/** The note the case's own actions write (factory-domain `actionLinkNote`, English), said in our words; a person's note as typed. */
const ACTION_NOTES: readonly (readonly [RegExp, string])[] = [
  [/^Repair \S+ opened from the case\.$/, 'REPAIR'],
  [/^Return \S+ opened from the case: the goods come back\.$/, 'RETURN'],
  [/^Return \S+ opened from the case for a remake\.$/, 'REMAKE'],
  [/^Return \S+ opened from the case for a credit\.$/, 'CREDIT'],
]
export function linkNoteOf(note: string | null): { readonly via: Phrase | null; readonly words: string | null } {
  if (!note) return { via: null, words: null }
  const found = ACTION_NOTES.find(([pattern]) => pattern.test(note))
  return found ? { via: { key: `linked.via.${found[1]}` }, words: null } : { via: null, words: note }
}

/** What the case's actions open, each with the words of what it creates. */
export const RETURN_PURPOSES = ['RETURN', 'REMAKE', 'CREDIT'] as const

export interface RepairDraft {
  readonly kind: 'REPAIR' | 'ALTERATION'
  readonly problem: string
  readonly workWanted: string
  readonly received: boolean
}
export const repairDraftOf = (record: Pick<CaseRecord, 'problem'>): RepairDraft => ({ kind: 'REPAIR', problem: record.problem.slice(0, 2000), workWanted: '', received: false })
export function repairDraftHeld(draft: RepairDraft): Phrase | null {
  if (draft.problem.trim() === '') return { key: 'repair.held.problem' }
  if (draft.problem.trim().length > 2000) return { key: 'common.atMost', params: { count: 2000 } }
  if (draft.workWanted.trim().length > 2000) return { key: 'common.atMost', params: { count: 2000 } }
  return null
}

export interface ReturnDraft {
  readonly purpose: (typeof RETURN_PURPOSES)[number]
  readonly reasonCode: string
  readonly fit: string
  readonly customerRef: string
  readonly goodsDueBy: string
}
export const emptyReturnDraft = (purpose: ReturnDraft['purpose'] = 'RETURN'): ReturnDraft => ({ purpose, reasonCode: '', fit: '', customerRef: '', goodsDueBy: '' })
export function returnDraftHeld(draft: ReturnDraft, garment: CaseRecord['garment']): Phrase | null {
  if (!garment.serial?.shipment) return { key: 'return.held.noShipment' }
  if (!draft.reasonCode) return { key: 'return.held.reason' }
  if (draft.purpose === 'REMAKE' && draft.fit.trim() === '') return { key: 'return.held.fit' }
  if (draft.fit.trim().length > 4000) return { key: 'common.atMost', params: { count: 4000 } }
  return null
}

// ---- refusals -------------------------------------------------------------------------------------------------------------------------

/** The fields a refusal may name (`field.<name>` words). */
export const FIELD_NAMES = ['companyId', 'kind', 'channel', 'partyId', 'contactId', 'serial', 'batchNumber', 'size', 'problem', 'customerWants', 'priority', 'ownerId', 'deliveredOn', 'legalGuaranteeEndsOn', 'factoryGuaranteeEndsOn', 'notifyCustomer', 'internalNote', 'cover', 'decision', 'note', 'to', 'resolution', 'reason', 'message', 'recordType', 'recordId', 'lines', 'reasonCode', 'fit', 'siteId', 'workWanted', 'goodsDueBy', 'customerRef'] as const

const KIND_KEY: Readonly<Record<string, string>> = {
  signed_out: 'problem.signedOut',
  forbidden: 'problem.forbidden',
  step_up: 'problem.stepUp',
  not_found: 'problem.notFound',
  conflict: 'problem.refused',
  invalid: 'problem.invalid',
  rate_limited: 'problem.rateLimited',
  contract: 'problem.contract',
  unavailable: 'problem.unavailable',
}

export interface Refusal {
  readonly say: Phrase
  readonly lines: readonly Phrase[]
  readonly stale: boolean
}

/**
 * A refused write in our words: a held code (`held.<CODE>`), the fields named (`field.<name>`), a stale version, else its kind.
 * `linking`: a plain conflict of a link is the record linked already (the API's duplicate link).
 */
export function refusalOf(error: unknown, linking = false): Refusal {
  if (!isApiError(error)) return { say: { key: 'problem.unavailable' }, lines: [], stale: false }
  const paths = error.issues.map((issue) => issuePath(issue))
  if (error.kind === 'conflict' && paths.includes('version')) return { say: { key: 'problem.stale' }, lines: [], stale: true }
  const codes = [...new Set(paths.filter((path) => path.startsWith('held/')).map((path) => path.slice(5)))].filter((code): code is HeldCode => (HELD_CODES as readonly string[]).includes(code))
  if (codes.length > 0) return { say: { key: 'problem.held' }, lines: codes.map((code) => ({ key: `held.${code}` })), stale: false }
  const fields = [...new Set(paths.filter((path) => path.startsWith('body/')).map((path) => path.slice(5).split('/')[0] ?? ''))].filter((field) => (FIELD_NAMES as readonly string[]).includes(field))
  if (fields.length > 0) return { say: { key: 'problem.fields' }, lines: fields.map((field) => ({ key: `field.${field}` })), stale: false }
  if (error.kind === 'conflict' && linking && error.code === 'conflict') return { say: { key: 'problem.duplicate' }, lines: [], stale: false }
  return { say: { key: KIND_KEY[error.kind] ?? 'problem.internal' }, lines: [], stale: false }
}

/** A failed read in our words. */
export function readProblem(error: unknown): string {
  if (!isApiError(error)) return 'problem.unavailable'
  return error.kind === 'conflict' ? 'problem.internal' : (KIND_KEY[error.kind] ?? 'problem.internal')
}

export const PROBLEM_KEYS = [...new Set([...Object.values(KIND_KEY), 'problem.internal', 'problem.stale', 'problem.held', 'problem.fields', 'problem.duplicate'])]

/** The status mails' states said in words (`mailStatus.<STATUS>`). */
export const MAIL_STATUSES = ['QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'BOUNCED', 'COMPLAINED', 'FAILED'] as const
export const mailStatusKey = (status: string): string => `mailStatus.${(MAIL_STATUSES as readonly string[]).includes(status) ? status : 'other'}`

export { moveAllowed }
