import type { SizeGridColour, SizeGridSize, SizeGridValue } from '@nexus/ui/grid/size-grid/index'
import { formatNumber } from '../../../lib/i18n/format'
import type { Locale } from '../../../lib/i18n/locales'
import type {
  ApprovalReason,
  ApprovalRow,
  ApprovalStatus,
  PartyDetail,
  QuoteDetail,
  QuoteIssue,
  QuoteLine,
  QuoteListRow,
  QuoteStatus,
  QuoteVersionRow,
  SendCheck,
  StyleDetail,
  StyleRow,
  VersionStatus,
} from './api'

/**
 * The quotes screens' pure rules (SCR-034 list, SCR-035 record; B-W1-21, B-W1-24): what a person may see of the money
 * (their grains), what the next step is and why it is held, how lines group into style blocks and size grids, and how a
 * typed grid becomes the line writes. No fetching, no React: the tests hold them.
 */

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

/** What money the person sees: the API drops what a grain does not reach; the screens say why a column is absent. */
export interface Grains {
  price: boolean
  cost: boolean
  margin: boolean
}

export function grainsOf(permissions: readonly string[]): Grains {
  const held = new Set(permissions)
  return { price: held.has('money.price'), cost: held.has('money.cost'), margin: held.has('money.margin') }
}

export interface QuoteAbilities {
  view: boolean
  manage: boolean
  approve: boolean
  send: boolean
}

export function abilitiesOf(permissions: readonly string[]): QuoteAbilities {
  const held = new Set(permissions)
  return { view: held.has('quotes.view'), manage: held.has('quotes.manage'), approve: held.has('quotes.approve'), send: held.has('quotes.send') }
}

// ---- words and tones ----------------------------------------------------------------------------------------------------

export const STATUS_TONE: Record<QuoteStatus | VersionStatus, Tone> = {
  DRAFT: 'neutral',
  PENDING_APPROVAL: 'warning',
  APPROVED: 'info',
  SENT: 'info',
  ACCEPTED: 'success',
  DECLINED: 'danger',
  EXPIRED: 'neutral',
  SUPERSEDED: 'neutral',
  CANCELLED: 'neutral',
}

export const APPROVAL_TONE: Record<ApprovalStatus, Tone> = { PENDING: 'warning', APPROVED: 'success', REJECTED: 'danger', WITHDRAWN: 'neutral' }

/** Minor units (cents) as money in the person's language: `€ 6.240,00` / `€6,240.00`. */
export function money(minor: number | null | undefined, currency: string, locale: Locale): string {
  if (minor === null || minor === undefined) return '—'
  return formatNumber(minor / 100, locale, { style: 'currency', currency })
}

/** A unit price as the API writes it ("450", "12.5") in the person's language, 2 to 4 decimals. */
export function unitPrice(value: string | null | undefined, currency: string, locale: Locale): string {
  if (value === null || value === undefined || value === '') return '—'
  const number = Number(value)
  if (!Number.isFinite(number)) return '—'
  return formatNumber(number, locale, { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 4 })
}

/** A percentage the API writes as text ("34.5357") with one decimal: `34,5 %` / `34.5%`. */
export function percent(value: string | null | undefined, locale: Locale): string {
  if (value === null || value === undefined || value === '') return '—'
  const number = Number(value)
  if (!Number.isFinite(number)) return '—'
  return formatNumber(number / 100, locale, { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 })
}

/** A typed price in either language's way ("450,50" or "450.50") as the API takes it; null when it is not one. */
export function parsePrice(text: string): string | null {
  const trimmed = text.trim().replace(/\s/g, '').replace(/^€/, '')
  if (trimmed === '') return null
  const normalised = /,\d{1,6}$/.test(trimmed) ? trimmed.replace(/\./g, '').replace(',', '.') : trimmed.replace(/,/g, '')
  if (!/^\d{1,9}(\.\d{1,6})?$/.test(normalised)) return null
  return normalised
}

/** A typed percentage 0–100 ("30", "12,5") as the API takes it; null when it is not one. */
export function parsePercent(text: string): string | null {
  const normalised = text.trim().replace(',', '.').replace(/%$/, '').trim()
  if (!/^\d{1,3}(\.\d{1,4})?$/.test(normalised)) return null
  return Number(normalised) <= 100 ? normalised : null
}

/** Whole days from `today` (YYYY-MM-DD) to `day` (YYYY-MM-DD); negative when past. */
export function daysUntil(day: string, today: string): number {
  return Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000)
}

/** Today in Rome (the sites' default zone), as YYYY-MM-DD. */
export function romeToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

// ---- the list (SCR-034) -------------------------------------------------------------------------------------------------

/** Saved filters the tiles and the Rows menu share (one filter model: a tile puts its chips in the filter row). */
export const QUOTE_TILES = ['myDrafts', 'waiting', 'sent', 'expiring', 'accepted'] as const
export type QuoteTile = (typeof QUOTE_TILES)[number]

export interface ListFilters {
  status: QuoteStatus | null
  mine: boolean
  /** Sent quotes whose offer ends within 7 days (filtered here: the API filters by status). */
  expiring: boolean
  q: string
}

export const NO_FILTERS: ListFilters = { status: null, mine: false, expiring: false, q: '' }

export function filtersOfTile(tile: QuoteTile): ListFilters {
  switch (tile) {
    case 'myDrafts':
      return { ...NO_FILTERS, status: 'DRAFT', mine: true }
    case 'waiting':
      return { ...NO_FILTERS, status: 'PENDING_APPROVAL' }
    case 'sent':
      return { ...NO_FILTERS, status: 'SENT' }
    case 'expiring':
      return { ...NO_FILTERS, status: 'SENT', expiring: true }
    case 'accepted':
      return { ...NO_FILTERS, status: 'ACCEPTED' }
  }
}

/** The tile whose filters are exactly these (aria-pressed), else null. */
export function tileOfFilters(filters: ListFilters): QuoteTile | null {
  return QUOTE_TILES.find((tile) => {
    const of = filtersOfTile(tile)
    return of.status === filters.status && of.mine === filters.mine && of.expiring === filters.expiring && filters.q.trim() === ''
  }) ?? null
}

export function activeFilterCount(filters: ListFilters): number {
  return (filters.status ? 1 : 0) + (filters.mine ? 1 : 0) + (filters.expiring ? 1 : 0) + (filters.q.trim() ? 1 : 0)
}

/** Rows the expiring filter keeps: sent, valid until today + 7 days at most, not past. */
export function isExpiring(row: Pick<QuoteListRow, 'status' | 'validUntil'>, today: string): boolean {
  if (row.status !== 'SENT' || !row.validUntil) return false
  const left = daysUntil(row.validUntil, today)
  return left >= 0 && left <= 7
}

export interface TileCount {
  /** null: not read yet (or the read failed): the tile shows "—", never 0. */
  count: number | null
  /** More than the read took (the list's page): the tile says "200+". */
  more: boolean
  /** The value of the accepted tile (price grain only). */
  value?: number | null
}

/** A tile's count from one read of its status (`more`: the read had another page). */
export function tileCount(tile: QuoteTile, rows: readonly QuoteListRow[] | null, more: boolean, today: string, me: string): TileCount {
  if (!rows) return { count: null, more: false }
  const of = filtersOfTile(tile)
  const kept = rows.filter((row) => (!of.mine || row.createdById === me) && (!of.expiring || isExpiring(row, today)))
  const value = tile === 'accepted' && kept.every((row) => row.netAmount !== undefined) ? kept.reduce((sum, row) => sum + (row.netAmount ?? 0), 0) : null
  return { count: kept.length, more, ...(tile === 'accepted' ? { value } : {}) }
}

// ---- the record (SCR-035) ----------------------------------------------------------------------------------------------

export const QUOTE_TABS = ['lines', 'price', 'terms', 'versions', 'approval', 'documents', 'activity'] as const
export type QuoteTab = (typeof QUOTE_TABS)[number]

export function tabOf(asked: string | null | undefined): QuoteTab {
  return (QUOTE_TABS as readonly string[]).includes(asked ?? '') ? (asked as QuoteTab) : 'lines'
}

/** The version can change: a DRAFT current version, and the person edits quotes. */
export function isEditable(quote: Pick<QuoteDetail, 'current'>, can: Pick<QuoteAbilities, 'manage'>): boolean {
  return can.manage && quote.current.status === 'DRAFT'
}

/** Why the lines and terms are read-only (a message key), or null when they can change. */
export function readOnlyReason(quote: Pick<QuoteDetail, 'current' | 'status'>, can: Pick<QuoteAbilities, 'manage'>): string | null {
  if (!can.manage) return 'readOnly.noRight'
  switch (quote.current.status) {
    case 'DRAFT':
      return null
    case 'PENDING_APPROVAL':
      return 'readOnly.pending'
    case 'APPROVED':
      return 'readOnly.approved'
    case 'SENT':
      return 'readOnly.sent'
    case 'ACCEPTED':
      return 'readOnly.accepted'
    default:
      return 'readOnly.closed'
  }
}

/** The waiting approval request of the current version, if any. */
export function pendingRequest(quote: Pick<QuoteDetail, 'approval'>) {
  return quote.approval.requests.find((request) => request.status === 'PENDING') ?? null
}

export type NextStep = 'askApproval' | 'send' | 'decide' | 'withdraw' | 'revise' | 'none'

export interface NextStepView {
  step: NextStep
  /** Why the primary cannot run now (a message key with its params), else null. */
  held: { key: string; params?: Record<string, string | number> } | null
}

/** The primary action of the band and the summary rail, by state (design: "Next step by state"). */
export function nextStep(quote: QuoteDetail, me: string, can: QuoteAbilities): NextStepView {
  const status = quote.current.status
  if (status === 'DRAFT') {
    if (quote.approval.needed) {
      if (!can.manage) return { step: 'askApproval', held: { key: 'held.noManage' } }
      if (!quote.canAskApproval) return { step: 'askApproval', held: firstBlock(quote.issues) }
      return { step: 'askApproval', held: null }
    }
    if (!can.send) return { step: 'send', held: { key: 'held.noSend' } }
    return { step: 'send', held: null }
  }
  if (status === 'PENDING_APPROVAL') {
    const request = pendingRequest(quote)
    if (request && request.createdById === me) return { step: 'withdraw', held: can.manage ? null : { key: 'held.noManage' } }
    if (can.approve) return { step: 'decide', held: null }
    return { step: 'withdraw', held: can.manage ? null : { key: 'held.noManage' } }
  }
  if (status === 'APPROVED') return { step: 'send', held: can.send ? null : { key: 'held.noSend' } }
  if (status === 'SENT') return { step: 'revise', held: can.manage ? null : { key: 'held.noManage' } }
  return { step: 'none', held: null }
}

/** The first issue that stops the approval request (BLOCKS), as a held reason. */
export function firstBlock(issues: readonly QuoteIssue[]): NextStepView['held'] {
  const block = issues.find((issue) => issue.severity === 'BLOCKS')
  return block ? { key: `issue.${block.code}`, params: { size: block.size ?? '' } } : { key: 'held.checking' }
}

/** Why the person may not decide this request now (a message key), or null: own request, no right, margin needed. */
export function decideHeld(quote: Pick<QuoteDetail, 'approval'>, me: string, can: Pick<QuoteAbilities, 'approve'>, grains: Grains): string | null {
  const request = pendingRequest(quote)
  if (!request) return 'decide.held.NOT_WAITING'
  if (request.createdById === me) return 'decide.held.OWN_REQUEST'
  if (!can.approve) return 'decide.held.NO_RIGHT'
  if (request.reasons.includes('MARGIN_FLOOR') && !grains.margin) return 'decide.held.NEEDS_MARGIN'
  return null
}

/** The margin against the floor, in one of three tones (the summary rail's meter; null without the margin grain). */
export function marginTone(marginPct: string | null | undefined, floorPct: string | null | undefined): Tone | null {
  if (marginPct === undefined || floorPct === undefined) return null
  if (marginPct === null || floorPct === null) return 'neutral'
  const margin = Number(marginPct)
  const floor = Number(floorPct)
  if (margin < 0) return 'danger'
  if (margin < floor) return 'warning'
  return 'success'
}

// ---- lines: style blocks and size grids ---------------------------------------------------------------------------------

export interface StyleBlock {
  styleId: string
  code: string
  name: string
  /** "Rev 3 released" / "Draft rev 4 — estimate" / none. */
  revision: { revision: number; status: string } | null
  lines: QuoteLine[]
}

/** Lines grouped by style, in the order the first line of each style was added. */
export function styleBlocks(lines: readonly QuoteLine[]): StyleBlock[] {
  const blocks: StyleBlock[] = []
  for (const line of [...lines].sort((a, b) => a.seq - b.seq)) {
    let block = blocks.find((entry) => entry.styleId === line.styleId)
    if (!block) {
      block = { styleId: line.styleId, code: line.style.code, name: line.style.name, revision: line.styleRevision, lines: [] }
      blocks.push(block)
    }
    block.lines.push(line)
  }
  return blocks
}

/** The quantities of a block's lines: colourway → size → pieces. */
export function gridValueOf(lines: readonly QuoteLine[]): Record<string, Record<string, number>> {
  const value: Record<string, Record<string, number>> = {}
  for (const line of lines) value[line.colourwayId] = Object.fromEntries(line.sizes.map((row) => [row.size, row.quantity]))
  return value
}

/** A block's columns and rows: the style's sizes and colourways when known (offered cells), else what the lines hold. */
export function gridShapeOf(lines: readonly QuoteLine[], style: StyleDetail | null, extraColourways: readonly string[] = []): { sizes: SizeGridSize[]; colours: SizeGridColour[] } {
  if (style) {
    const labels = new Map(style.matrix.sizes.map((size) => [size.code, size.label]))
    const sizes = style.sizes.map((code) => ({ key: code, label: labels.get(code) ?? code }))
    const wanted = new Set([...lines.map((line) => line.colourwayId), ...extraColourways])
    const colours = style.colourways
      .filter((colourway) => wanted.has(colourway.id))
      .map((colourway) => ({ key: colourway.id, label: `${colourway.code} · ${colourway.name}`, swatch: colourway.colour?.hex ?? null, offered: colourway.offeredSizes }))
    return { sizes, colours }
  }
  const sizeKeys: string[] = []
  for (const line of lines) for (const row of line.sizes) if (!sizeKeys.includes(row.size)) sizeKeys.push(row.size)
  return {
    sizes: sizeKeys.map((key) => ({ key, label: key })),
    colours: lines.map((line) => ({ key: line.colourwayId, label: `${line.colourway.code} · ${line.colourway.name}`, offered: line.sizes.map((row) => row.size) })),
  }
}

export type LineWrite =
  | { kind: 'add'; colourwayId: string; sizes: { size: string; quantity: number }[] }
  | { kind: 'edit'; lineId: string; colourwayId: string; sizes: { size: string; quantity: number }[] }
  | { kind: 'remove'; lineId: string; colourwayId: string }

const sizesOf = (row: Readonly<Record<string, number>> | undefined): { size: string; quantity: number }[] =>
  Object.entries(row ?? {})
    .filter(([, quantity]) => quantity > 0)
    .map(([size, quantity]) => ({ size, quantity }))

const sameSizes = (a: readonly { size: string; quantity: number }[], b: readonly { size: string; quantity: number }[]): boolean => {
  const key = (rows: readonly { size: string; quantity: number }[]) =>
    [...rows]
      .filter((row) => row.quantity > 0)
      .sort((x, y) => x.size.localeCompare(y.size))
      .map((row) => `${row.size}:${row.quantity}`)
      .join(',')
  return key(a) === key(b)
}

/**
 * What a typed grid asks of the API, colourway by colourway: a colourway with pieces and no line is added, a line whose
 * pieces changed is edited, a line left with no piece is removed (a size-grid line has at least one piece). Unchanged
 * rows ask nothing.
 */
export function lineWrites(lines: readonly QuoteLine[], typed: SizeGridValue): LineWrite[] {
  const writes: LineWrite[] = []
  for (const [colourwayId, row] of Object.entries(typed)) {
    const line = lines.find((entry) => entry.colourwayId === colourwayId)
    const sizes = sizesOf(row)
    if (!line) {
      if (sizes.length > 0) writes.push({ kind: 'add', colourwayId, sizes })
    } else if (sizes.length === 0) {
      writes.push({ kind: 'remove', lineId: line.id, colourwayId })
    } else if (!sameSizes(line.sizes, sizes)) {
      writes.push({ kind: 'edit', lineId: line.id, colourwayId, sizes })
    }
  }
  return writes
}

/** The size-grid warnings of a block's lines: a size no valid certificate covers. */
export function certificateIssues(lines: readonly QuoteLine[]): { colour: string; size: string }[] {
  return lines.flatMap((line) => line.sizes.filter((row) => row.certificate.outcome === 'refused').map((row) => ({ colour: line.colourwayId, size: row.size })))
}

/** The lowest-margin line (margin grain), or null. */
export function lowestMarginLine(lines: readonly QuoteLine[]): QuoteLine | null {
  let lowest: QuoteLine | null = null
  for (const line of lines) {
    if (line.marginPct === undefined || line.marginPct === null) continue
    if (!lowest || Number(line.marginPct) < Number(lowest.marginPct)) lowest = line
  }
  return lowest
}

export function unitsOf(lines: readonly QuoteLine[]): number {
  return lines.reduce((sum, line) => sum + line.quantity, 0)
}

// ---- terms ----------------------------------------------------------------------------------------------------------------

export interface TermsDraft {
  contactId: string
  customerRef: string
  billToAddressId: string
  shipToAddressId: string
  language: 'it' | 'en'
  validUntil: string
  firmOffer: boolean
  promiseDate: string
  paymentTerms: string
  /** B-W2a-49: the library's terms ('' = none: the typed text is printed). */
  paymentTermsId: string
  depositPct: string
  depositKind: 'ACCONTO' | 'CAPARRA'
  changeNote: string
}

export function termsDraftOf(quote: QuoteDetail): TermsDraft {
  const current = quote.current
  return {
    contactId: quote.contactId ?? '',
    customerRef: quote.customerRef ?? '',
    billToAddressId: current.billToAddressId ?? '',
    shipToAddressId: current.shipToAddressId ?? '',
    language: current.language === 'en' ? 'en' : 'it',
    validUntil: current.validUntil ?? '',
    firmOffer: current.firmOffer,
    promiseDate: current.promiseDate ?? '',
    paymentTerms: current.paymentTerms ?? '',
    paymentTermsId: current.paymentTermsId ?? '',
    depositPct: current.depositPct ?? '',
    depositKind: current.depositKind ?? 'ACCONTO',
    changeNote: current.changeNote ?? '',
  }
}

/** The fields that changed, as the PATCH sends them (empty text = null). */
export function termsPatch(before: TermsDraft, after: TermsDraft): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  const text = (value: string) => (value.trim() === '' ? null : value.trim())
  if (after.contactId !== before.contactId) patch.contactId = text(after.contactId)
  if (after.customerRef !== before.customerRef) patch.customerRef = text(after.customerRef)
  if (after.billToAddressId !== before.billToAddressId) patch.billToAddressId = text(after.billToAddressId)
  if (after.shipToAddressId !== before.shipToAddressId) patch.shipToAddressId = text(after.shipToAddressId)
  if (after.language !== before.language) patch.language = after.language
  if (after.validUntil !== before.validUntil) patch.validUntil = text(after.validUntil)
  if (after.firmOffer !== before.firmOffer) patch.firmOffer = after.firmOffer
  if (after.promiseDate !== before.promiseDate) patch.promiseDate = text(after.promiseDate)
  // Library terms print their own name: the typed text is sent only without them (or when it was changed by hand).
  if (after.paymentTermsId !== before.paymentTermsId) patch.paymentTermsId = text(after.paymentTermsId)
  if (after.paymentTerms !== before.paymentTerms && (after.paymentTermsId === '' || after.paymentTermsId === before.paymentTermsId)) patch.paymentTerms = text(after.paymentTerms)
  if (after.depositPct !== before.depositPct) patch.depositPct = after.depositPct.trim() === '' ? null : parsePercent(after.depositPct)
  if (after.depositKind !== before.depositKind) patch.depositKind = after.depositKind
  if (after.changeNote !== before.changeNote) patch.changeNote = text(after.changeNote)
  return patch
}

/** What stops the terms from being saved (message keys per field). */
export function termsProblems(draft: TermsDraft, today: string): Partial<Record<keyof TermsDraft, string>> {
  const problems: Partial<Record<keyof TermsDraft, string>> = {}
  if (draft.validUntil && draft.validUntil < today) problems.validUntil = 'terms.problem.validPast'
  if (draft.depositPct.trim() !== '' && parsePercent(draft.depositPct) === null) problems.depositPct = 'terms.problem.depositPct'
  return problems
}

/** A party's addresses that can be a bill-to / ship-to (active; the default first). */
export function addressChoices(party: PartyDetail | null, kind: 'bill' | 'ship') {
  if (!party) return []
  const active = party.addresses.filter((address) => address.status === 'ACTIVE')
  const isDefault = (address: (typeof active)[number]) => (kind === 'bill' ? address.isDefaultBillTo : address.isDefaultShipTo)
  return [...active].sort((a, b) => Number(isDefault(b)) - Number(isDefault(a)))
}

// ---- versions, links, approvals -------------------------------------------------------------------------------------------

/** The link card's state for the newest sent version: the live link, else the newest one's state; null: none made. */
export function linkSummary(versions: readonly QuoteVersionRow[]): { state: 'LIVE' | 'REVOKED' | 'USED_UP' | 'EXPIRED'; expiresAt: string; email: string | null; revision: number } | null {
  for (const version of versions) {
    if (version.links.length === 0) continue
    const live = version.links.find((link) => link.state === 'LIVE')
    const newest = live ?? [...version.links].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]!
    return { state: newest.state, expiresAt: newest.expiresAt, email: newest.email, revision: version.revision }
  }
  return null
}

/** The rule words of a request: margin, discount (no figure: the margin grain shows the numbers elsewhere). */
export function reasonKeys(reasons: readonly ApprovalReason[]): string[] {
  return reasons.map((reason) => `reason.${reason}`)
}

/** The approvals queue's next row after `id` (after a decision the next one opens), else the previous, else null. */
export function nextAfter(rows: readonly Pick<ApprovalRow, 'id'>[], id: string): string | null {
  const index = rows.findIndex((row) => row.id === id)
  if (index < 0) return rows[0]?.id ?? null
  return rows[index + 1]?.id ?? rows[index - 1]?.id ?? null
}

/** The send dialog's first blocking check (the Send button is held with it). */
export function firstBlockingCheck(check: Pick<SendCheck, 'checks'> | null): SendCheck['checks'][number] | null {
  return check?.checks.find((item) => item.severity === 'BLOCKS') ?? null
}

/** A style picker row's tags: released or an estimate, PPE class, made-to-measure. */
export function styleTags(style: Pick<StyleRow, 'revisionState' | 'ppeClass' | 'mtmAllowed'>): string[] {
  const tags = [style.revisionState === 'RELEASED' ? 'style.released' : style.revisionState === 'DRAFT' ? 'style.estimate' : 'style.noRevision']
  if (style.mtmAllowed) tags.push('style.mtm')
  return tags
}

/** A CSV cell: quoted when it holds a separator, a quote or a line break (RFC 4180). */
const csvCell = (value: string): string => (/[",\n\r;]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)

/**
 * The selected quotes as a CSV file ("Export N (CSV)"): the columns this person sees in the list, in their words; money
 * only with the price grain, the margin only with the margin grain (never more than the screen shows).
 */
export function quotesCsv(rows: readonly QuoteListRow[], grains: Grains, words: { header: (key: string) => string; status: (status: QuoteStatus) => string }, locale: Locale): string {
  const header = ['list.col.number', 'list.col.customer', 'terms.customerRef', 'list.col.status', 'versions.col.version', 'list.col.units', ...(grains.price ? ['list.col.net', 'list.col.gross'] : []), ...(grains.margin ? ['list.col.margin'] : []), 'list.col.validUntil'].map(words.header)
  const lines = rows.map((row) =>
    [
      row.number,
      row.partyName,
      row.customerRef ?? '',
      words.status(row.status),
      String(row.revision),
      String(row.units),
      ...(grains.price ? [money(row.netAmount, row.currency, locale), money(row.grossAmount, row.currency, locale)] : []),
      ...(grains.margin ? [row.marginPct ?? ''] : []),
      row.validUntil ?? '',
    ].map(csvCell).join(','),
  )
  return [header.map(csvCell).join(','), ...lines].join('\r\n') + '\r\n'
}

// ---- B-W2a-49: list price, duplicate, start from a past quote -------------------------------------------------------------

/** How a line's price stands against the customer's price list: at it, below or above it (by hand or a discount), or no list. */
export type ListPriceState = 'atList' | 'below' | 'above' | 'noList'

export function listPriceState(line: Pick<QuoteLine, 'unitPrice' | 'listUnitPrice'>): ListPriceState {
  if (line.listUnitPrice === null || line.listUnitPrice === undefined || line.unitPrice === undefined) return 'noList'
  const list = Number(line.listUnitPrice)
  const price = Number(line.unitPrice)
  if (!Number.isFinite(list) || !Number.isFinite(price) || price === list) return 'atList'
  return price < list ? 'below' : 'above'
}

/** The difference from the list price in percent (one decimal as text "-5.0"), or null at the list price / without one. */
export function offListPct(line: Pick<QuoteLine, 'unitPrice' | 'listUnitPrice'>): string | null {
  if (listPriceState(line) === 'atList' || listPriceState(line) === 'noList') return null
  const list = Number(line.listUnitPrice)
  if (list <= 0) return null
  return (((Number(line.unitPrice) - list) / list) * 100).toFixed(4)
}

/**
 * What a copy left out, in this screen's words (the API answers English sentences: B-W2a-30 quotes/duplicate.ts — each
 * kind is matched here and said as a `sales` key; anything else says "no longer offered").
 */
export function droppedWords(dropped: { seq: number; size: string | null; reason: string }): { key: string; params: Record<string, string | number> } {
  if (/made-to-measure/i.test(dropped.reason)) return { key: 'dup.dropped.mtm', params: { line: dropped.seq } }
  if (dropped.size !== null) return { key: 'dup.dropped.size', params: { line: dropped.seq, size: dropped.size } }
  if (/none of its sizes/i.test(dropped.reason)) return { key: 'dup.dropped.noSizes', params: { line: dropped.seq } }
  return { key: 'dup.dropped.other', params: { line: dropped.seq } }
}

/** A copy's warnings in this screen's words: today only the price basis (net ⇄ VAT included) changed between customers. */
export function warningWords(warning: string): { key: string } {
  return /VAT/.test(warning) ? { key: 'dup.warning.basis' } : { key: 'dup.warning.other' }
}

/** The New quote dialog's "Start from" (design pop:quotes.new): Blank, or a past quote (Template, Inquiry: W2b). */
export const START_FROM = ['blank', 'past'] as const
export type StartFrom = (typeof START_FROM)[number]
