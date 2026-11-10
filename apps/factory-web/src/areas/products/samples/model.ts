import {
  BOARD_LANES,
  isOpenStage,
  MANUAL_STAGES,
  ROUND_TILES,
  SAMPLE_DECISIONS,
  SAMPLE_KINDS,
  SAMPLE_LIMITS,
  SAMPLE_REFUSALS,
  SAMPLE_STAGES,
  type ManualStage,
  type RoundTile,
  type SampleDecision,
  type SampleKind,
  type SampleStage,
} from '@nexus/factory-domain/sales/samples/rules'
import { DECISION_LIMITS, DECISION_REFUSALS } from '@nexus/factory-domain/sales/sample-decisions/rules'
import type { CreateRoundBody, UpdateRoundBody } from '@nexus/factory-domain/sales/samples/contracts'
import { isApiError, issuePath } from '../../../lib/api/errors'
import type { ApprovalView, FitView, RoundRow, RoundView, ShipmentView, StyleDetail } from './api'

/**
 * Products › Development › Samples & prototypes (SCR-110, B-W2b-261), pure: who may do what, the page's address (the same
 * filters for the board, the list and the calendar), the tiles, the board's lanes and why a card may not go to one, due
 * words, the New sample request's draft and body, the round's Request draft and what a save sends, the charge (a price)
 * typed and shown, the fit grid's rows, refusals said from their codes. Every word is a key of `products-samples`.
 */

export const NS = 'products-samples'
export const NAMESPACES = [NS, 'lists'] as const

export { BOARD_LANES, MANUAL_STAGES, ROUND_TILES, SAMPLE_DECISIONS, SAMPLE_KINDS, SAMPLE_STAGES }
export type { ManualStage, RoundTile, SampleDecision, SampleKind, SampleStage }

/** A phrase of the catalogue: its key and parameters. */
export interface Phrase {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

export interface Notice extends Phrase {
  readonly tone: 'success' | 'info' | 'warning' | 'danger'
}

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

// ---- who may do what --------------------------------------------------------------------------------------------------------

export interface SamplesCan {
  view: boolean
  /** New sample request, the request, moves, cancel, shipments, swatches, the next round (sales.samples.manage). */
  manage: boolean
  /** Decide on the sample (sales.samples.decide). */
  decide: boolean
  /** The fit and its comments (sales.samples.measure). */
  measure: boolean
  /** Make sample work order also needs W1's workorders.manage (the API checks it at the making site). */
  workOrders: boolean
  /** A sample work order's own page (workorders.view). */
  workOrdersView: boolean
  /** The CE test sample's result and certificate (compliance.certificates.manage). */
  certificates: boolean
  /** The charge to the customer: a price (money.price). */
  price: boolean
  /** The customer pickers (parties.view). */
  parties: boolean
  /** The style picker (product.styles.view). */
  styles: boolean
  /** The round's thread, files and history (threads.read). */
  thread: boolean
}

export function samplesCan(permissions: readonly string[]): SamplesCan {
  const held = new Set(permissions)
  const has = (permission: string) => held.has(permission)
  return {
    view: has('sales.samples.view'),
    manage: has('sales.samples.manage'),
    decide: has('sales.samples.decide'),
    measure: has('sales.samples.measure'),
    workOrders: has('workorders.manage'),
    workOrdersView: has('workorders.view'),
    certificates: has('compliance.certificates.manage'),
    price: has('money.price'),
    parties: has('parties.view'),
    styles: has('product.styles.view'),
    thread: has('threads.read'),
  }
}

// ---- the page's address --------------------------------------------------------------------------------------------------------

/** Board (the page as the design draws it), the list (`?mode=table`) or the calendar by due day (`?mode=calendar`). */
export type SamplesMode = 'board' | 'table' | 'calendar'

export interface ListAddress {
  /** A tile = a saved filter (the API's own `tile`); null: every round. */
  readonly tile: RoundTile | null
  readonly kind: SampleKind | null
  /** The customer or brand. */
  readonly party: string | null
  /** Internal rounds only (no customer). */
  readonly internal: boolean
  /** The style's rounds (the Style studio's link), pinned to one revision when `revision` is set. */
  readonly style: string | null
  readonly revision: string | null
  readonly q: string
  readonly mode: SamplesMode
  /** New sample request (`?new=1`, with `&style=` from the Style studio). */
  readonly isNew: boolean
}

export const HOME_ADDRESS: ListAddress = { tile: null, kind: null, party: null, internal: false, style: null, revision: null, q: '', mode: 'board', isNew: false }

const oneOf = <T extends string>(values: readonly T[], value: string | null): T | null => (value !== null && (values as readonly string[]).includes(value) ? (value as T) : null)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const idOf = (value: string | null): string | null => (value && UUID.test(value) ? value : null)

export function addressOf(params: { get(name: string): string | null }): ListAddress {
  const mode = params.get('mode')
  return {
    tile: oneOf(ROUND_TILES, params.get('tile')),
    kind: oneOf(SAMPLE_KINDS, params.get('kind')),
    party: idOf(params.get('party')),
    internal: params.get('internal') === '1',
    style: idOf(params.get('style')),
    revision: idOf(params.get('revision')),
    q: (params.get('q') ?? '').slice(0, 100),
    mode: mode === 'table' || mode === 'calendar' ? mode : 'board',
    isNew: params.get('new') === '1',
  }
}

export function addressText(address: ListAddress): string {
  const params = new URLSearchParams()
  if (address.tile && address.tile !== 'ALL') params.set('tile', address.tile)
  if (address.kind) params.set('kind', address.kind)
  if (address.party && !address.internal) params.set('party', address.party)
  if (address.internal) params.set('internal', '1')
  if (address.style) params.set('style', address.style)
  if (address.style && address.revision) params.set('revision', address.revision)
  if (address.q.trim()) params.set('q', address.q.trim())
  if (address.mode !== 'board') params.set('mode', address.mode)
  if (address.isNew) params.set('new', '1')
  const text = params.toString()
  return text ? `?${text}` : ''
}

/** Anything narrowing the rounds beyond "every round". */
export const isFiltered = (address: ListAddress): boolean =>
  (address.tile !== null && address.tile !== 'ALL') || !!address.kind || !!address.party || address.internal || !!address.style || !!address.q.trim()

export const listHref = (prefix: string, address: Partial<ListAddress> = {}): string => `${prefix}/products/samples${addressText({ ...HOME_ADDRESS, ...address })}`

// ---- the record's address -------------------------------------------------------------------------------------------------------

export const RECORD_TABS = ['request', 'sample', 'fit', 'approval', 'shipments', 'activity'] as const
export type RecordTab = (typeof RECORD_TABS)[number]
export const PANELS = ['thread', 'files', 'history', 'approvals', 'tasks'] as const
export type ActivityPanel = (typeof PANELS)[number]

export function recordTabOf(params: { get(name: string): string | null }): RecordTab {
  return oneOf(RECORD_TABS, params.get('tab')) ?? 'request'
}

export function panelOf(params: { get(name: string): string | null }): ActivityPanel | null {
  return oneOf(PANELS, params.get('panel'))
}

export function recordHref(prefix: string, roundId: string, tab?: RecordTab, extra?: string): string {
  const terms = [tab && tab !== 'request' ? `tab=${tab}` : null, extra ?? null].filter(Boolean).join('&')
  return `${prefix}/products/samples/${encodeURIComponent(roundId)}${terms ? `?${terms}` : ''}`
}

// ---- tiles, stages, decisions -----------------------------------------------------------------------------------------------------

/** The design's tiles (saved filters), in its order. */
export const DESIGN_TILES = ['DUE_THIS_WEEK', 'LATE', 'WAITING_DECISION', 'REJECTED_THIS_MONTH'] as const satisfies readonly RoundTile[]

export const STAGE_TONE: Readonly<Record<SampleStage, Tone>> = {
  REQUESTED: 'neutral',
  IN_MAKING: 'info',
  SENT: 'info',
  UNDER_REVIEW: 'warning',
  DECIDED: 'success',
  CANCELLED: 'neutral',
}

export const DECISION_TONE: Readonly<Record<SampleDecision, Tone>> = {
  APPROVED: 'success',
  APPROVED_WITH_COMMENTS: 'warning',
  REJECTED: 'danger',
}

export const isOpen = (stage: SampleStage): boolean => isOpenStage(stage)

/** "Fit · round 2" in the page's words. */
export const roundPhrase = (kind: SampleKind, roundNo: number): Phrase => ({ key: 'round.label', params: { kind: `kind.${kind}`, n: roundNo } })

/** When a round is due, in words and a tone (late in the danger tone). */
export function dueOf(row: Pick<RoundRow, 'dueDate' | 'daysLate' | 'stage'>, today: string): (Phrase & { tone: Tone }) | null {
  if (!row.dueDate) return null
  if (row.daysLate !== null && row.daysLate > 0) return { key: 'due.late', params: { count: row.daysLate }, tone: 'danger' }
  if (!isOpenStage(row.stage)) return { key: 'due.on', params: { date: row.dueDate }, tone: 'neutral' }
  const days = Math.round((Date.parse(`${row.dueDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000)
  if (days === 0) return { key: 'due.today', tone: 'warning' }
  if (days > 0 && days <= 7) return { key: 'due.in', params: { count: days }, tone: 'neutral' }
  return { key: 'due.on', params: { date: row.dueDate }, tone: 'neutral' }
}

/** The board card's corner: the same due words, short (the card's name keeps its line). */
export function dueShort(row: Pick<RoundRow, 'dueDate' | 'daysLate' | 'stage'>, today: string): (Phrase & { tone: Tone }) | null {
  const due = dueOf(row, today)
  return due ? { ...due, key: due.key.replace('due.', 'due.short.') } : null
}

/** The card's "Owner": the round's maker, said as "You" or "A colleague" (a name only inside the record). */
export const ownerPhrase = (createdById: string | null, me: string): Phrase => ({ key: createdById === null ? 'owner.none' : createdById === me ? 'owner.me' : 'owner.other' })

/** The site's day (Europe/Rome) of an instant. */
export function todayOf(instant: string, timeZone = 'Europe/Rome'): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instant))
  return parts
}

// ---- the board ---------------------------------------------------------------------------------------------------------------

/** Why a card may not go to a lane (null: it may). The board itself says "the same lane". */
export function boardMoveHeld(row: Pick<RoundRow, 'stage'>, lane: string, can: SamplesCan, offline: boolean): Phrase | null {
  if (lane === row.stage) return null
  if (!isOpenStage(row.stage)) return { key: row.stage === 'DECIDED' ? 'held.decided' : 'held.cancelled' }
  if (lane === 'DECIDED') return { key: 'held.decideNotDrag' }
  if (!can.manage) return { key: 'held.noManage' }
  if (offline) return { key: 'held.offline' }
  return null
}

/** Why "Decide…" is held before the Approval is read (the dialog then says the API's own reasons in our words). */
export function decideHeldOfRow(row: Pick<RoundRow, 'stage'>, can: SamplesCan, offline: boolean): Phrase | null {
  if (!isOpenStage(row.stage)) return { key: row.stage === 'DECIDED' ? 'held.decided' : 'held.cancelled' }
  if (!can.decide) return { key: 'held.noDecide' }
  if (row.stage === 'REQUESTED') return { key: 'refusal.NOTHING_MADE' }
  if (offline) return { key: 'held.offline' }
  return null
}

/** The rows on the board: a cancelled round is off it (the list shows it). */
export const boardRowsOf = <T extends Pick<RoundRow, 'stage'>>(rows: readonly T[]): T[] => rows.filter((row) => row.stage !== 'CANCELLED')

// ---- refusals and problems --------------------------------------------------------------------------------------------------

/** Every refusal code the two modules send (`refusal/<CODE>`), each with its words in the catalogue. */
export const KNOWN_REFUSALS: readonly string[] = [...new Set<string>([...SAMPLE_REFUSALS, ...DECISION_REFUSALS])]

export function refusalCode(error: unknown): string | null {
  if (!isApiError(error)) return null
  for (const issue of error.issues) {
    const path = issuePath(issue)
    if (path.startsWith('refusal/')) return path.slice('refusal/'.length)
  }
  return null
}

/** A refusal said in our words: its code (else `refusal.other`). */
export const refusalPhrase = (code: string | null | undefined): Phrase => ({ key: code && KNOWN_REFUSALS.includes(code) ? `refusal.${code}` : 'refusal.other' })

/** A failed read in words (a failed read is never drawn as an empty list). */
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
  /** The API's places of a 400 (`body/cells/0/size` → `cells/0/size`). */
  readonly paths: readonly string[]
  /** Someone changed it first: read it again. */
  readonly stale: boolean
}

/** A refused write in words: a rule's refusal by its code, a stale version, a refused field, the kind. */
export function writeProblem(error: unknown): WriteProblem {
  if (!isApiError(error)) return { key: 'problem.unavailable', paths: [], stale: false }
  const code = refusalCode(error)
  if (code) return { ...refusalPhrase(code), paths: [], stale: false }
  const paths = error.issues.map((issue) => issuePath(issue).replace(/^body[/.]/, '').replace(/\./g, '/')).filter(Boolean)
  if (error.kind === 'conflict') return { key: 'problem.stale', paths: [], stale: true }
  if (error.kind === 'invalid') return { key: 'problem.invalid', paths, stale: false }
  if (error.kind === 'forbidden') return { key: 'problem.writeForbidden', paths: [], stale: false }
  if (error.kind === 'step_up') return { key: 'problem.stepUp', paths: [], stale: false }
  if (error.kind === 'not_found') return { key: 'problem.notFound', paths: [], stale: false }
  if (error.kind === 'rate_limited') return { key: 'problem.rateLimited', paths: [], stale: false }
  return { key: 'problem.unavailable', paths: [], stale: false }
}

/** A 400's places in our words (`cells/0/size` → the field it names). */
export function fieldOfPath(path: string): string {
  const top = path.split('/')[0] ?? ''
  const known = ['styleId', 'revisionId', 'kind', 'roundNo', 'partyId', 'cells', 'dueDate', 'instructions', 'chargeAmountMinor', 'chargeCurrency', 'testZones', 'comments', 'carrierName', 'trackingNumber', 'trackingUrl', 'sentAt', 'receivedAt', 'note', 'measured', 'text', 'reason', 'lines', 'siteId']
  return known.includes(top) ? `field.${top}` : 'field.other'
}

// ---- the charge (a price) -------------------------------------------------------------------------------------------------------

const fractionDigits = (currency: string): number => {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2
  } catch {
    return 2
  }
}

/** The charge in the page's language (`95,00 €`). */
export function chargeText(minor: number, currency: string, locale: string): string {
  const digits = fractionDigits(currency)
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(minor / 10 ** digits)
  } catch {
    return `${(minor / 10 ** digits).toFixed(digits)} ${currency}`
  }
}

/** A typed charge ("95", "95,50", "1.250,00") in minor units; null for empty; 'bad' for anything else. */
export function parseCharge(text: string, currency: string): number | null | 'bad' {
  const raw = text.trim().replace(/\s/g, '')
  if (!raw) return null
  let normal = raw
  if (raw.includes(',') && raw.includes('.')) normal = raw.lastIndexOf(',') > raw.lastIndexOf('.') ? raw.replace(/\./g, '').replace(',', '.') : raw.replace(/,/g, '')
  else if (raw.includes(',')) normal = raw.replace(',', '.')
  if (!/^\d+(\.\d+)?$/.test(normal)) return 'bad'
  const digits = fractionDigits(currency)
  const [whole, part = ''] = normal.split('.')
  if (part.length > digits) return 'bad'
  const minor = Number(whole) * 10 ** digits + Number(part.padEnd(digits, '0') || '0')
  return Number.isSafeInteger(minor) && minor <= SAMPLE_LIMITS.chargeMinor ? minor : 'bad'
}

/** The charge as typed back into its field ("95,50" in Italian). */
export function chargeEditText(minor: number | null, currency: string, locale: 'it' | 'en'): string {
  if (minor === null) return ''
  const digits = fractionDigits(currency)
  const text = (minor / 10 ** digits).toFixed(digits)
  return locale === 'it' ? text.replace('.', ',') : text
}

// ---- cells: colourways × sizes ------------------------------------------------------------------------------------------------

/** The size grid's row for cells that name no colourway ("Any colourway"). */
export const ANY_COLOUR = '*'

export type Grid = Record<string, Record<string, number>>

export function gridOfCells(cells: ReadonlyArray<{ colourwayId: string | null; size: string; quantity: number }>): Grid {
  const grid: Grid = {}
  for (const cell of cells) {
    const row = cell.colourwayId ?? ANY_COLOUR
    grid[row] = { ...grid[row], [cell.size]: cell.quantity }
  }
  return grid
}

/** The cells of a grid: every cell above zero, in the colour rows' and sizes' order. */
export function cellsOfGrid(grid: Grid, colourOrder: readonly string[], sizeOrder: readonly string[]): { colourwayId?: string; size: string; quantity: number }[] {
  const cells: { colourwayId?: string; size: string; quantity: number }[] = []
  const rows = [...colourOrder, ...Object.keys(grid).filter((key) => !colourOrder.includes(key))]
  for (const row of rows) {
    const sizes = grid[row] ?? {}
    for (const size of [...sizeOrder, ...Object.keys(sizes).filter((key) => !sizeOrder.includes(key))]) {
      const quantity = sizes[size] ?? 0
      if (quantity > 0) cells.push({ ...(row === ANY_COLOUR ? {} : { colourwayId: row }), size, quantity })
    }
  }
  return cells
}

export const piecesOfGrid = (grid: Grid): number => Object.values(grid).reduce((sum, sizes) => sum + Object.values(sizes).reduce((one, quantity) => one + (quantity > 0 ? quantity : 0), 0), 0)

/** Cells compared by colourway and size (the order does not matter). */
export function sameCells(a: ReadonlyArray<{ colourwayId?: string | null; size: string; quantity: number }>, b: ReadonlyArray<{ colourwayId?: string | null; size: string; quantity: number }>): boolean {
  const text = (cells: ReadonlyArray<{ colourwayId?: string | null; size: string; quantity: number }>) =>
    cells
      .map((cell) => `${cell.colourwayId ?? ANY_COLOUR}/${cell.size}/${cell.quantity}`)
      .sort()
      .join('|')
  return text(a) === text(b)
}

// ---- New sample request -----------------------------------------------------------------------------------------------------------

export interface NewDraft {
  styleId: string | null
  /** null: the style's newest revision that is not obsolete (the API's default, "latest by default"). */
  revisionId: string | null
  kind: SampleKind
  /** Typed; empty: the next round of this kind. */
  roundNo: string
  partyId: string | null
  dueDate: string
  instructions: string
  charge: string
  currency: string
  testZones: string
  grid: Grid
}

export const emptyNewDraft = (styleId: string | null = null, revisionId: string | null = null): NewDraft => ({
  styleId,
  revisionId,
  kind: 'PROTO',
  roundNo: '',
  partyId: null,
  dueDate: '',
  instructions: '',
  charge: '',
  currency: 'EUR',
  testZones: '',
  grid: {},
})

/** The revision the API will pin when none is chosen: the newest that is not obsolete. */
export function latestRevision(style: Pick<StyleDetail, 'revisions'> | null): { id: string; revision: number; status: string } | null {
  if (!style) return null
  const usable = style.revisions.filter((revision) => revision.status !== 'OBSOLETE').sort((a, b) => b.revision - a.revision)
  return usable[0] ?? null
}

const roundNumber = (text: string): number | null | 'bad' => {
  const raw = text.trim()
  if (!raw) return null
  if (!/^\d+$/.test(raw)) return 'bad'
  const value = Number(raw)
  return value >= 1 && value <= SAMPLE_LIMITS.roundNo ? value : 'bad'
}

/** Why Create is held (null: it may be sent), first reason first. */
export function newDraftHeld(draft: NewDraft, style: StyleDetail | null, can: SamplesCan, offline: boolean): Phrase | null {
  if (!can.manage) return { key: 'held.noManage' }
  if (!draft.styleId || !style) return { key: 'new.held.style' }
  if (style.revisions.length === 0 || !latestRevision(style)) return { key: 'refusal.NO_REVISION' }
  if (style.status === 'ARCHIVED') return { key: 'refusal.STYLE_CLOSED' }
  if (roundNumber(draft.roundNo) === 'bad') return { key: 'new.held.roundNo', params: { max: SAMPLE_LIMITS.roundNo } }
  const pieces = cellsOfGrid(draft.grid, [], [])
  if (pieces.length === 0) return { key: 'new.held.cells' }
  if (pieces.length > SAMPLE_LIMITS.cells) return { key: 'new.held.tooManyCells', params: { max: SAMPLE_LIMITS.cells } }
  if (pieces.some((cell) => cell.quantity > SAMPLE_LIMITS.cellQuantity)) return { key: 'new.held.cellQuantity', params: { max: SAMPLE_LIMITS.cellQuantity } }
  if (can.price && draft.charge.trim()) {
    if (!draft.partyId) return { key: 'refusal.CHARGE_INTERNAL' }
    if (parseCharge(draft.charge, draft.currency) === 'bad') return { key: 'new.held.charge' }
  }
  if (draft.testZones.trim() && draft.kind !== 'CERTIFICATION') return { key: 'refusal.CERTIFICATION_ONLY' }
  if (offline) return { key: 'held.offline' }
  return null
}

export function newBodyOf(draft: NewDraft, style: StyleDetail, companyId: string | null, can: SamplesCan): CreateRoundBody {
  const colours = style.colourways.map((colourway) => colourway.id)
  const cells = cellsOfGrid(draft.grid, [ANY_COLOUR, ...colours], style.sizes)
  const roundNo = roundNumber(draft.roundNo)
  const charge = can.price && draft.partyId ? parseCharge(draft.charge, draft.currency) : null
  const body: Record<string, unknown> = {
    styleId: style.id,
    kind: draft.kind,
    cells,
    ...(draft.revisionId ? { revisionId: draft.revisionId } : {}),
    ...(style.companyId === null && companyId ? { companyId } : {}),
    ...(typeof roundNo === 'number' ? { roundNo } : {}),
    ...(draft.partyId ? { partyId: draft.partyId } : {}),
    ...(draft.dueDate ? { dueDate: draft.dueDate } : {}),
    ...(draft.instructions.trim() ? { instructions: draft.instructions.trim().slice(0, SAMPLE_LIMITS.instructions) } : {}),
    ...(typeof charge === 'number' ? { chargeAmountMinor: charge, chargeCurrency: draft.currency } : {}),
    ...(draft.kind === 'CERTIFICATION' && draft.testZones.trim() ? { testZones: draft.testZones.trim().slice(0, SAMPLE_LIMITS.testZones) } : {}),
  }
  return body as CreateRoundBody
}

// ---- the round's Request (EditModeBar) -------------------------------------------------------------------------------------------

export interface RequestDraft {
  revisionId: string
  roundNo: string
  dueDate: string
  instructions: string
  charge: string
  currency: string
  testZones: string
  grid: Grid
}

export function requestDraftOf(round: RoundView, locale: 'it' | 'en'): RequestDraft {
  const currency = round.chargeCurrency ?? 'EUR'
  return {
    revisionId: round.revision.id,
    roundNo: String(round.roundNo),
    dueDate: round.dueDate ?? '',
    instructions: round.instructions ?? '',
    charge: chargeEditText((round.chargeAmountMinor as number | null | undefined) ?? null, currency, locale),
    currency,
    testZones: round.testZones ?? '',
    grid: gridOfCells(round.cells),
  }
}

/** What a save sends: only the fields that changed (null when nothing did, or a typed value is not right). */
export function requestChanges(round: RoundView, draft: RequestDraft, can: SamplesCan): { body: UpdateRoundBody | null; count: number; problem: Phrase | null } {
  const body: Record<string, unknown> = { version: round.version }
  let count = 0
  if (draft.revisionId !== round.revision.id) {
    body.revisionId = draft.revisionId
    count += 1
  }
  const roundNo = roundNumber(draft.roundNo)
  if (roundNo === 'bad' || roundNo === null) return { body: null, count: count + 1, problem: { key: 'new.held.roundNo', params: { max: SAMPLE_LIMITS.roundNo } } }
  if (roundNo !== round.roundNo) {
    body.roundNo = roundNo
    count += 1
  }
  const cells = cellsOfGrid(draft.grid, [], [])
  if (!sameCells(cells, round.cells)) {
    if (cells.length === 0) return { body: null, count: count + 1, problem: { key: 'new.held.cells' } }
    if (cells.some((cell) => cell.quantity > SAMPLE_LIMITS.cellQuantity)) return { body: null, count: count + 1, problem: { key: 'new.held.cellQuantity', params: { max: SAMPLE_LIMITS.cellQuantity } } }
    body.cells = cells
    count += 1
  }
  if ((draft.dueDate || null) !== round.dueDate) {
    body.dueDate = draft.dueDate || null
    count += 1
  }
  const instructions = draft.instructions.trim() || null
  if (instructions !== (round.instructions ?? null)) {
    body.instructions = instructions
    count += 1
  }
  if (can.price) {
    const charge = parseCharge(draft.charge, draft.currency)
    if (charge === 'bad') return { body: null, count: count + 1, problem: { key: 'new.held.charge' } }
    const was = (round.chargeAmountMinor as number | null | undefined) ?? null
    if (charge !== was || (charge !== null && draft.currency !== round.chargeCurrency)) {
      if (charge !== null && !round.party) return { body: null, count: count + 1, problem: { key: 'refusal.CHARGE_INTERNAL' } }
      body.chargeAmountMinor = charge
      body.chargeCurrency = charge === null ? null : draft.currency
      count += 1
    }
  }
  const zones = draft.testZones.trim() || null
  if (zones !== (round.testZones ?? null)) {
    if (zones !== null && round.kind !== 'CERTIFICATION') return { body: null, count: count + 1, problem: { key: 'refusal.CERTIFICATION_ONLY' } }
    body.testZones = zones
    count += 1
  }
  return { body: count > 0 ? (body as UpdateRoundBody) : null, count, problem: null }
}

// ---- the fit grid -------------------------------------------------------------------------------------------------------------

export interface FitRow {
  /** The point's id, or its code for a value measured against a point the spec no longer has. */
  id: string
  pointOfMeasureId: string | null
  code: string
  name: string
  uom: string
  inSpec: boolean
  cells: Record<string, FitView['points'][number]['cells'][number]>
}

export function fitRowsOf(fit: FitView): FitRow[] {
  return fit.points.map((point) => ({
    id: point.pointOfMeasureId ?? `code:${point.code}`,
    pointOfMeasureId: point.pointOfMeasureId,
    code: point.code,
    name: point.name,
    uom: point.uom,
    inSpec: point.inSpec,
    cells: Object.fromEntries(point.cells.map((cell) => [cell.size, cell])),
  }))
}

/** May this cell be typed into: the fit is editable, the point is in the spec with a value of that size. */
export const fitCellEditable = (fit: Pick<FitView, 'editable'>, row: FitRow, size: string, can: SamplesCan, offline: boolean): boolean =>
  fit.editable && can.measure && !offline && row.inSpec && row.pointOfMeasureId !== null && !!row.cells[size]?.spec

/** Why the fit cells are drawn as text (null: they may be typed). */
export function fitHeld(fit: Pick<FitView, 'editable' | 'refusal' | 'spec'>, can: SamplesCan, offline: boolean): Phrase | null {
  if (!fit.spec) return { key: 'refusal.NO_SPEC' }
  if (!fit.editable) return refusalPhrase(fit.refusal?.code)
  if (!can.measure) return { key: 'held.noMeasure' }
  if (offline) return { key: 'held.offline' }
  return null
}

/** "+1.3" said with the page's comma. */
export const signedText = (value: string | null, locale: 'it' | 'en'): string => (value === null ? '—' : locale === 'it' ? value.replace('.', ',') : value)

// ---- the Approval tab -----------------------------------------------------------------------------------------------------------

export type ApprovalAction = keyof ApprovalView['actions']

/** The rights an approval step may name as missing, each with its words (`right.<permission>`). */
export const KNOWN_RIGHTS = ['sales.samples.view', 'sales.samples.manage', 'sales.samples.decide', 'sales.samples.measure', 'partners.approvals.ask', 'compliance.certificates.manage', 'product.changes.request', 'workorders.manage'] as const

/** "Needs the right to …" for a permission the API names (an unknown one: "Your role does not allow it"). */
export const needsPhrase = (needs: string): Phrase => ((KNOWN_RIGHTS as readonly string[]).includes(needs) ? { key: 'held.needs', params: { right: `right.${needs}` } } : { key: 'held.noRight' })

/** Why an approval action is held, in our words: the right it needs, else the refusal's code, else offline. */
export function approvalHeld(view: ApprovalView, action: ApprovalAction, offline: boolean): Phrase | null {
  const state = view.actions[action]
  if (state.allowed) return offline ? { key: 'held.offline' } : null
  if (state.needs) return needsPhrase(state.needs)
  return refusalPhrase(state.refusal?.code)
}

export interface DecideDraft {
  decision: SampleDecision | null
  comments: string
}

/** Why "Record decision" is held (comments say why for "with comments" and "rejected"). */
export function decideDraftHeld(draft: DecideDraft): Phrase | null {
  if (!draft.decision) return { key: 'decide.held.pick' }
  if (draft.decision !== 'APPROVED' && !draft.comments.trim()) return { key: 'decide.held.comments' }
  if (draft.comments.trim().length > DECISION_LIMITS.comments) return { key: 'decide.held.long', params: { max: DECISION_LIMITS.comments } }
  return null
}

// ---- shipments ---------------------------------------------------------------------------------------------------------------------

/** Why a shipment's cell may not be typed into (null: it may). Sent and received are set once each. */
export function shipmentCellHeld(round: Pick<RoundView, 'stage'>, shipment: ShipmentView, field: 'carrierName' | 'trackingNumber' | 'trackingUrl' | 'sentAt' | 'receivedAt' | 'note', can: SamplesCan, offline: boolean): Phrase | null {
  if (!can.manage) return { key: 'held.noManage' }
  if (round.stage === 'CANCELLED') return { key: 'refusal.SHIPMENT_ROUND_CANCELLED' }
  if (field === 'sentAt' && shipment.sentAt) return { key: 'refusal.SENT_ONCE' }
  if (field === 'receivedAt' && shipment.receivedAt) return { key: 'refusal.RECEIVED_ONCE' }
  if (field === 'receivedAt' && !shipment.sentAt) return { key: 'refusal.RECEIVED_BEFORE_SENT' }
  if (offline) return { key: 'held.offline' }
  return null
}

const HTTPS = /^https:\/\/\S+$/

/** A typed shipment cell checked as the API checks it (null: fine). */
export function shipmentValueProblem(field: 'carrierName' | 'trackingNumber' | 'trackingUrl' | 'note', value: string): Phrase | null {
  const text = value.trim()
  if (!text) return null
  if (field === 'trackingUrl' && !HTTPS.test(text)) return { key: 'ship.problem.url' }
  const max = field === 'carrierName' ? SAMPLE_LIMITS.carrierName : field === 'trackingNumber' ? SAMPLE_LIMITS.trackingNumber : field === 'trackingUrl' ? SAMPLE_LIMITS.trackingUrl : SAMPLE_LIMITS.shipmentNote
  return text.length > max ? { key: 'ship.problem.long', params: { max } } : null
}
