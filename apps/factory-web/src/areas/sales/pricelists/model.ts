import { addDays } from '@nexus/factory-domain/sales/quotes/quotes'
import { activationPlan, marginPctOf, raiseByPct, type VersionFacts } from '@nexus/factory-domain/sales/pricelists/pricelists'
import { isCurrencyCode } from '@nexus/factory-domain/core/money'
import { parsePrice } from '../quotes/model'
import { PRICE_LIST_KINDS, type PriceEntry, type PriceListDetail, type PriceListKind, type PriceListRow, type PriceListState, type PriceVersion } from './api'

/**
 * Sales › Price lists & contracts (SCR-106; design sales.pricelists and its record "Price list"): the pure rules the
 * screens draw — what a person may do (and why not, in words), the saved rows and tiles as ONE filter model kept in the
 * address, which version the Prices tab shows, the New price list checks, the activation's plan and its held reasons
 * (factory-domain's own `activationPlan`), and "Raise by %" (factory-domain `raiseByPct`, to the currency's minor unit).
 * No fetching, no React: the tests hold them.
 */

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

/** A sentence of the `pricelists` catalogue with its values. */
export interface Phrase {
  key: string
  params?: Record<string, string | number>
}

export interface PriceListAbilities {
  view: boolean
  manage: boolean
  /** Giving a list to customers also needs parties.manage on each (the API checks every party). */
  partiesManage: boolean
  partiesView: boolean
  /** The style picker (Add a price). */
  styles: boolean
  threads: boolean
  price: boolean
  cost: boolean
  margin: boolean
}

export function abilitiesOf(permissions: readonly string[]): PriceListAbilities {
  const held = new Set(permissions)
  return {
    view: held.has('pricelists.view'),
    manage: held.has('pricelists.manage'),
    partiesManage: held.has('parties.manage'),
    partiesView: held.has('parties.view'),
    styles: held.has('product.styles.view'),
    threads: held.has('threads.read'),
    price: held.has('money.price'),
    cost: held.has('money.cost'),
    margin: held.has('money.margin'),
  }
}

/** Today in Rome (the sites' default zone), as YYYY-MM-DD. */
export function romeToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

export const STATE_TONE: Record<PriceListState, Tone> = { DRAFT: 'neutral', SCHEDULED: 'info', IN_FORCE: 'success', EXPIRED: 'warning', ARCHIVED: 'neutral' }
export const VERSION_TONE: Record<PriceVersion['status'], Tone> = { DRAFT: 'neutral', ACTIVE: 'success' }

// ---- the list: saved rows, tiles, filters (one filter model, in the address) ----------------------------------------------

/** Rows ▾ (design savedRows Active · Drafts · Expired · All, + Archived to reach an archived list again). */
export const LIST_ROWS = ['active', 'drafts', 'expired', 'all', 'archived'] as const
export type ListRows = (typeof LIST_ROWS)[number]
/** The tiles (design: Active · Starting in 30 days · Expiring in 30 days; Contracts is Later). */
export const LIST_TILES = ['active', 'starting', 'ending'] as const
export type ListTile = (typeof LIST_TILES)[number]

export interface ListFilters {
  rows: ListRows
  /** A tile pressed for the two date tiles (Active is a saved row). */
  soon: 'starting' | 'ending' | null
  kind: PriceListKind | null
  q: string
}

export const NO_FILTERS: ListFilters = { rows: 'all', soon: null, kind: null, q: '' }

/** The state the API filters by for a saved row (null: every list that is not archived). */
export function stateOfRows(rows: ListRows): PriceListState | null {
  return rows === 'active' ? 'IN_FORCE' : rows === 'drafts' ? 'DRAFT' : rows === 'expired' ? 'EXPIRED' : rows === 'archived' ? 'ARCHIVED' : null
}

/** The filters in the address (`?rows=drafts&soon=ending&kind=CUSTOMER&q=…`), so a filtered list can be shared. */
export function filtersOf(params: Pick<URLSearchParams, 'get'> | null): ListFilters {
  const rows = params?.get('rows') ?? ''
  const soon = params?.get('soon') ?? ''
  const kind = params?.get('kind') ?? ''
  return {
    rows: (LIST_ROWS as readonly string[]).includes(rows) ? (rows as ListRows) : 'all',
    soon: soon === 'starting' || soon === 'ending' ? soon : null,
    kind: (PRICE_LIST_KINDS as readonly string[]).includes(kind) ? (kind as PriceListKind) : null,
    q: params?.get('q') ?? '',
  }
}

export function searchOf(filters: ListFilters): string {
  const search = new URLSearchParams()
  if (filters.rows !== 'all') search.set('rows', filters.rows)
  if (filters.soon) search.set('soon', filters.soon)
  if (filters.kind) search.set('kind', filters.kind)
  if (filters.q.trim()) search.set('q', filters.q.trim())
  const text = search.toString()
  return text ? `?${text}` : ''
}

/** A tile is a named saved filter: pressing it puts its chip in the toolbar (pressing it again takes it away). */
export function filtersOfTile(tile: ListTile, current: ListFilters): ListFilters {
  if (tile === 'active') return current.rows === 'active' && !current.soon ? { ...current, rows: 'all' } : { ...current, rows: 'active', soon: null }
  return current.soon === tile ? { ...current, soon: null } : { ...current, rows: 'all', soon: tile }
}

export function tileOf(filters: ListFilters): ListTile | null {
  if (filters.soon) return filters.soon
  return filters.rows === 'active' ? 'active' : null
}

export function activeFilterCount(filters: ListFilters): number {
  return (filters.rows !== 'all' ? 1 : 0) + (filters.soon ? 1 : 0) + (filters.kind ? 1 : 0) + (filters.q.trim() ? 1 : 0)
}

/** The rows a date tile keeps (the API answers the lists by state; starting / ending are its row flags). */
export function rowsShown(rows: readonly PriceListRow[] | null, filters: ListFilters): PriceListRow[] | null {
  if (!rows) return null
  if (filters.soon === 'starting') return rows.filter((row) => row.startsSoon)
  if (filters.soon === 'ending') return rows.filter((row) => row.endsSoon)
  return [...rows]
}

/** A tile's number: the list's total under that filter; unknown is '—', never 0. */
export function tileValue(tiles: { inForce: number; startingIn30Days: number; endingIn30Days: number } | null, tile: ListTile): string {
  if (!tiles) return '—'
  return String(tile === 'active' ? tiles.inForce : tile === 'starting' ? tiles.startingIn30Days : tiles.endingIn30Days)
}

/** The bulk reach of "Archive N": lists that are not archived and price nobody (the API refuses the others; said before the click). */
export function archiveReach(rows: readonly PriceListRow[]): { reach: PriceListRow[]; skipped: PriceListRow[] } {
  const reach = rows.filter((row) => row.status === 'ACTIVE' && row.customers === 0)
  return { reach, skipped: rows.filter((row) => !reach.includes(row)) }
}

// ---- New price list ------------------------------------------------------------------------------------------------------

export interface NewListDraft {
  companyId: string
  code: string
  name: string
  kind: PriceListKind
  currency: string
  baseListId: string
  validFrom: string
  validTo: string
  note: string
}

/** "Every company" in the New price list's company choice (sent as null). */
export const EVERY_COMPANY = 'every-company'

export function emptyNewList(companyId: string): NewListDraft {
  return { companyId, code: '', name: '', kind: 'CUSTOMER', currency: 'EUR', baseListId: '', validFrom: '', validTo: '', note: '' }
}

const CODE = /^[A-Z0-9][A-Z0-9._-]*$/

/** What stops Create draft, per field (message keys), checked as the API will. */
export function newListProblems(draft: NewListDraft, today: string): Partial<Record<keyof NewListDraft, string>> {
  const problems: Partial<Record<keyof NewListDraft, string>> = {}
  const code = draft.code.trim().toUpperCase()
  if (code === '') problems.code = 'new.problem.codeMissing'
  else if (code.length > 40 || !CODE.test(code)) problems.code = 'new.problem.code'
  if (draft.name.trim() === '') problems.name = 'new.problem.nameMissing'
  else if (draft.name.trim().length > 200) problems.name = 'new.problem.nameLong'
  if (!isCurrencyCode(draft.currency.trim().toUpperCase())) problems.currency = 'new.problem.currency'
  if (draft.kind === 'BASE' && draft.baseListId) problems.baseListId = 'new.problem.baseOfBase'
  if (draft.validFrom && draft.validFrom < today) problems.validFrom = 'new.problem.fromPast'
  if (draft.validFrom && draft.validTo && draft.validTo < draft.validFrom) problems.validTo = 'new.problem.toBefore'
  if (draft.note.trim().length > 2000) problems.note = 'new.problem.noteLong'
  return problems
}

export function newListBody(draft: NewListDraft) {
  const text = (value: string) => (value.trim() === '' ? null : value.trim())
  return {
    companyId: draft.companyId === EVERY_COMPANY || draft.companyId === '' ? null : draft.companyId,
    code: draft.code.trim().toUpperCase(),
    name: draft.name.trim(),
    kind: draft.kind,
    currency: draft.currency.trim().toUpperCase(),
    baseListId: draft.kind === 'BASE' ? null : text(draft.baseListId),
    note: text(draft.note),
    validFrom: text(draft.validFrom),
    validTo: text(draft.validTo),
  }
}

/** The lists a new one may fall back to: active, of its company or every company, in its currency, not itself. */
export function baseChoices(lists: readonly PriceListRow[], companyId: string | null, currency: string, except?: string): PriceListRow[] {
  return lists.filter((list) => list.status === 'ACTIVE' && list.id !== except && list.currency === currency.trim().toUpperCase() && (list.companyId === null || list.companyId === companyId))
}

// ---- the record ----------------------------------------------------------------------------------------------------------

export const RECORD_TABS = ['prices', 'customers', 'versions', 'activity'] as const
export type RecordTab = (typeof RECORD_TABS)[number]

export function tabOf(asked: string | null | undefined): RecordTab {
  return (RECORD_TABS as readonly string[]).includes(asked ?? '') ? (asked as RecordTab) : 'prices'
}

/** The version the Prices tab shows: the one asked (`?version=`), else the draft being edited, else the one in force. */
export function versionToShow(list: Pick<PriceListDetail, 'versions' | 'draftVersionId' | 'shownVersion'>, asked: string | null | undefined): PriceVersion | null {
  const byId = (id: string | null | undefined) => (id ? (list.versions.find((version) => version.id === id) ?? null) : null)
  return byId(asked) ?? byId(list.draftVersionId) ?? byId(list.shownVersion?.id) ?? list.versions[0] ?? null
}

/** Why the shown prices cannot be changed (a message key), or null when they can (autosave per cell). */
export function pricesHeld(list: Pick<PriceListDetail, 'status' | 'draftVersionId'>, version: Pick<PriceVersion, 'status'> | null, can: Pick<PriceListAbilities, 'manage' | 'price'>): string | null {
  if (!can.price) return 'held.noPrice'
  if (list.status === 'ARCHIVED') return 'held.archived'
  if (!can.manage) return 'held.noManage'
  if (!version) return 'held.noVersion'
  if (version.status !== 'DRAFT') return list.draftVersionId ? 'held.activeHasDraft' : 'held.activeVersion'
  return null
}

/** Why Make next version is held, or null. One draft at a time. */
export function nextVersionHeld(list: Pick<PriceListDetail, 'status' | 'draftVersionId'>, can: Pick<PriceListAbilities, 'manage'>): string | null {
  if (!can.manage) return 'held.noManage'
  if (list.status === 'ARCHIVED') return 'held.archived'
  if (list.draftVersionId) return 'held.oneDraft'
  return null
}

/** Why customers cannot be added or removed here, or null. */
export function customersHeld(list: Pick<PriceListDetail, 'status' | 'kind'>, can: Pick<PriceListAbilities, 'manage' | 'partiesManage'>): string | null {
  if (!can.manage) return 'held.noManage'
  if (!can.partiesManage) return 'held.noPartiesManage'
  if (list.status === 'ARCHIVED') return 'held.archived'
  return null
}

/** Why Archive is held, or null (the API refuses while customers are priced from it or a list falls back to it). */
export function archiveHeld(list: Pick<PriceListDetail, 'status' | 'customers' | 'fallbackOf'>, can: Pick<PriceListAbilities, 'manage'>): Phrase | null {
  if (!can.manage) return { key: 'held.noManage' }
  if (list.status === 'ARCHIVED') return { key: 'held.archived' }
  if (list.customers.length > 0) return { key: 'held.archiveCustomers', params: { count: list.customers.length } }
  const active = list.fallbackOf.filter((other) => other.status === 'ACTIVE')
  if (active.length > 0) return { key: 'held.archiveFallback', params: { lists: active.map((other) => other.code).join(', ') } }
  return null
}

// ---- Activate version ------------------------------------------------------------------------------------------------------

export interface ActivateCheck {
  /** Why Activate is held (in words), or null. */
  held: Phrase | null
  /** The version in force at the new start, ended the day before. */
  ends: { revision: number; validTo: string } | null
}

/** The activation's plan from factory-domain's own rule, in this screen's words: back in time, a later version cut away. */
export function activateCheck(versions: readonly PriceVersion[], draftId: string, validFrom: string, validTo: string, today: string): ActivateCheck {
  if (!validFrom) return { held: { key: 'activate.held.from' }, ends: null }
  if (validFrom < today) return { held: { key: 'activate.held.past', params: { today } }, ends: null }
  if (validTo && validTo < validFrom) return { held: { key: 'activate.held.order' }, ends: null }
  const facts: VersionFacts[] = versions.map((version) => ({ id: version.id, revision: version.revision, status: version.status, validFrom: version.validFrom, validTo: version.validTo }))
  const later = versions.find((version) => version.status === 'ACTIVE' && version.validFrom !== null && version.validFrom >= validFrom && version.validFrom <= (validTo || '9999-12-31'))
  if (later) return { held: { key: 'activate.held.later', params: { revision: later.revision, date: later.validFrom! } }, ends: null }
  const plan = activationPlan(facts, draftId, validFrom, validTo || null, today)
  if (!plan.ok) return { held: { key: 'activate.held.other' }, ends: null }
  const end = plan.plan.end
  return { held: null, ends: end ? { revision: end.revision, validTo: end.validTo } : null }
}

/** The activation's first day by default: the draft's planned day when still ahead, else today. */
export function defaultActivationDay(version: Pick<PriceVersion, 'validFrom'>, today: string): string {
  return version.validFrom && version.validFrom >= today ? version.validFrom : today
}

/** The day before (YYYY-MM-DD). */
export const dayBefore = (day: string): string => addDays(day, -1)

// ---- prices --------------------------------------------------------------------------------------------------------------

/** A typed percent for "Raise by %" ("5", "-3", "2,5"); null when it is not one (above -100, at most 4 places). */
export function parseRaisePct(text: string): string | null {
  const normalised = text.trim().replace(',', '.').replace(/%$/, '').trim()
  if (!/^[+-]?\d{1,4}(\.\d{1,4})?$/.test(normalised)) return null
  const value = Number(normalised)
  if (!Number.isFinite(value) || value <= -100 || value === 0) return null
  return normalised.replace(/^\+/, '')
}

export interface RaiseRow {
  entry: PriceEntry
  now: string
  next: string
  /** The margin at the new price (only with the cost and margin grains and a known cost). */
  marginNext: string | null
}

/** "Raise by %" over the chosen rows: each price × (1 + pct ÷ 100), rounded to the minor unit, with its new margin. */
export function raisePlan(entries: readonly PriceEntry[], ids: readonly string[], pct: string, currency: string): RaiseRow[] {
  const code = isCurrencyCode(currency) ? currency : 'EUR'
  return entries
    .filter((entry) => ids.includes(entry.id) && entry.unitPrice !== undefined)
    .map((entry) => {
      const next = raiseByPct(entry.unitPrice!, pct, code)
      return { entry, now: entry.unitPrice!, next, marginNext: entry.standardCost !== undefined ? marginPctOf(next, entry.standardCost ?? null) : null }
    })
}

/** A typed list price as the API takes it (either language's way); null when it is not one or not above 0. */
export function parseListPrice(text: string): string | null {
  const parsed = parsePrice(text)
  return parsed !== null && Number(parsed) > 0 ? parsed : null
}

/** The Prices grid's columns by grain: the price with money.price, the standard cost with money.cost, the margin with money.margin. */
export function priceColumnIds(can: Pick<PriceListAbilities, 'price' | 'cost' | 'margin'>): string[] {
  return ['style', 'colour', ...(can.price ? ['price'] : []), ...(can.cost ? ['cost'] : []), ...(can.margin ? ['margin'] : [])]
}

/** The rows of the Prices grid, ordered by style code, the style's own price ("every colourway") first. */
export function sortedEntries(entries: readonly PriceEntry[]): PriceEntry[] {
  return [...entries].sort((a, b) => (a.style.code === b.style.code ? (a.colourway?.code ?? '').localeCompare(b.colourway?.code ?? '') : a.style.code.localeCompare(b.style.code)))
}

/** The entries a search keeps (style code or name, colourway code or name). */
export function entriesMatching(entries: readonly PriceEntry[], q: string): PriceEntry[] {
  const query = q.trim().toLowerCase()
  if (!query) return [...entries]
  return entries.filter((entry) => [entry.style.code, entry.style.name, entry.colourway?.code ?? '', entry.colourway?.name ?? ''].some((text) => text.toLowerCase().includes(query)))
}

/** "Add a price": a style (and a colourway or every one) not priced yet in this version. */
export function alreadyPriced(entries: readonly PriceEntry[], styleId: string, colourwayId: string | null): boolean {
  return entries.some((entry) => entry.styleId === styleId && entry.colourwayId === colourwayId)
}

// ---- export ---------------------------------------------------------------------------------------------------------------

const csvCell = (value: string | number | null | undefined): string => {
  const text = value === null || value === undefined ? '' : String(value)
  return /[",;\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** Export N / This view (CSV): the lists as the grid shows them (no price: a list's prices are its record's). */
export function listsCsv(rows: readonly PriceListRow[], words: { header: (key: string) => string; kind: (kind: PriceListKind) => string; state: (state: PriceListState) => string }): string {
  const head = ['code', 'name', 'kind', 'currency', 'customers', 'validFrom', 'validTo', 'styles', 'version', 'state'].map((key) => csvCell(words.header(`csv.${key}`)))
  const body = rows.map((row) =>
    [row.code, row.name, words.kind(row.kind), row.currency, row.customers, row.shownVersion?.validFrom ?? '', row.shownVersion?.validTo ?? '', row.stylesPriced, row.shownVersion?.revision ?? '', words.state(row.state)].map(csvCell).join(';'),
  )
  return [head.join(';'), ...body].join('\n')
}
