import { LOCATION_CODE, normalizeLocationCode, wouldCycle } from '@nexus/factory-domain/inventory/locations/rules'
import { isApiError, issuePath } from '../../../lib/api/errors'
import type { LocationKind, LocationView, PerUnit, SiteLocations, StockOverview, StockRow, Uom } from '../../_shared/stock/api'
import { decimalValue, stockCan, type StockCan } from '../../_shared/stock/model'

/**
 * Warehouse › Settings › Locations (SCR-065; design warehouse.locations), pure: what this person may do, the site's tree
 * as list rows with the stock each place holds (from the stock overview, never a stored figure), why a place cannot be
 * archived yet, where a place may move to, the new place's form and its problems, the record's stock with or without
 * the places inside, and the address (`?site=&archived=1&q=`, the record's `?tab=overview|stock`). The words are keys of
 * `warehouse-locations` (prefix `lc.`); the shared stock words are `stock`'s. No blocks and no bin labels: both W2b (no
 * column, no LOCATION label kind).
 */

export const LOCATIONS_NAMESPACES = ['warehouse-locations'] as const

export interface LocationsCan {
  view: boolean
  manage: boolean
  /** The stock each place holds (inventory.stock.view): without it the column is absent and Archive is checked by the API. */
  stock: boolean
  /** Import locations (imports.view: the Admin › Import & export wizard). */
  importer: boolean
  cost: boolean
  base: StockCan
}

export function locationsCan(permissions: readonly string[]): LocationsCan {
  const base = stockCan(permissions)
  const held = new Set(permissions)
  return { view: base.locationsView, manage: base.locationsManage, stock: base.stockView, importer: base.locationsManage && held.has('imports.view'), cost: base.cost, base }
}

// ---- the tree as rows ---------------------------------------------------------------------------------------------------------

export interface PlaceStock {
  /** Stock keys lying here (a material · colour · lot · hide). */
  lines: number
  /** Hides lying here (leather). */
  hides: number
  /** On hand per unit (never added across units). */
  quantities: PerUnit[]
}

export interface PlaceRow {
  location: LocationView
  /** The places above it, top first (the path without itself). */
  above: { id: string; code: string }[]
  /** Active places directly inside it. */
  inside: number
  /** Every place below it (any depth, any status). */
  below: number
  /** What lies here; null when the person may not see stock. */
  stock: PlaceStock | null
  /** Why Archive is held (a key of `warehouse-locations`), or null when it may be archived. */
  archiveHeld: string | null
  archiveParams?: Readonly<Record<string, string | number>>
}

const EMPTY_STOCK: PlaceStock = { lines: 0, hides: 0, quantities: [] }

/** Σ of the stock rows per location (only stock that is there: the overview leaves out 0). */
export function stockByPlace(rows: readonly StockRow[]): Map<string, PlaceStock> {
  const result = new Map<string, { lines: number; hides: Set<string>; sums: Map<Uom, number> }>()
  for (const row of rows) {
    const entry = result.get(row.location.id) ?? { lines: 0, hides: new Set<string>(), sums: new Map<Uom, number>() }
    entry.lines += 1
    if (row.hide) entry.hides.add(row.hide.id)
    entry.sums.set(row.item.baseUom, (entry.sums.get(row.item.baseUom) ?? 0) + (decimalValue(row.onHand) ?? 0))
    result.set(row.location.id, entry)
  }
  return new Map(
    [...result].map(([id, entry]) => [id, { lines: entry.lines, hides: entry.hides.size, quantities: [...entry.sums].filter(([, value]) => value !== 0).map(([uom, value]) => ({ uom, quantity: value.toFixed(4) })) }]),
  )
}

/** The ids of a place and every place below it. */
export function withPlacesInside(locationId: string, locations: readonly Pick<LocationView, 'id' | 'parentId'>[]): Set<string> {
  const children = new Map<string, string[]>()
  for (const location of locations) if (location.parentId) children.set(location.parentId, [...(children.get(location.parentId) ?? []), location.id])
  const found = new Set<string>([locationId])
  const queue = [locationId]
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()!) ?? []) {
      if (found.has(child)) continue
      found.add(child)
      queue.push(child)
    }
  }
  return found
}

/** Why a place cannot be archived yet (the API's rule: no stock there and nothing active inside), or null. */
export function archiveHeldOf(location: Pick<LocationView, 'status'>, inside: number, stock: PlaceStock | null, can: Pick<LocationsCan, 'manage'>): { key: string; params?: Record<string, string | number> } | null {
  if (!can.manage) return { key: 'lc.held.noManage' }
  if (location.status === 'ARCHIVED') return { key: 'lc.held.archived' }
  if (stock && stock.lines > 0) return stock.hides > 0 ? { key: 'lc.held.hides', params: { count: stock.hides } } : { key: 'lc.held.stock', params: { count: stock.lines } }
  if (inside > 0) return { key: 'lc.held.inside', params: { count: inside } }
  return null
}

/** The site's tree (the API's order: depth first, children by code) as rows with their stock and their Archive state. */
export function placeRows(site: SiteLocations, overview: StockOverview | null, can: Pick<LocationsCan, 'manage' | 'stock'>): PlaceRow[] {
  const stock = overview ? stockByPlace(overview.rows.filter((row) => row.siteId === site.id)) : null
  const byId = new Map(site.locations.map((location) => [location.id, location]))
  return site.locations.map((location) => {
    const inside = site.locations.filter((other) => other.parentId === location.id && other.status === 'ACTIVE').length
    const below = withPlacesInside(location.id, site.locations).size - 1
    const above: { id: string; code: string }[] = []
    for (let parent = location.parentId ? byId.get(location.parentId) : undefined; parent; parent = parent.parentId ? byId.get(parent.parentId) : undefined) above.unshift({ id: parent.id, code: parent.code })
    const here = can.stock && stock ? (stock.get(location.id) ?? EMPTY_STOCK) : null
    const held = archiveHeldOf(location, inside, here, can)
    return { location, above, inside, below, stock: here, archiveHeld: held?.key ?? null, ...(held?.params ? { archiveParams: held.params } : {}) }
  })
}

/** The rows a search keeps: the code, the name or a code above it holds the words (a scanned bin label finds its place). */
export function searchRows(rows: readonly PlaceRow[], q: string): PlaceRow[] {
  const words = q.trim().toLowerCase()
  if (!words) return [...rows]
  return rows.filter((row) => [row.location.code, row.location.name, ...row.above.map((entry) => entry.code)].some((text) => text.toLowerCase().includes(words)))
}

/** Where a place may move to: an active place of its site that is not itself or below it; null = the top of the site. */
export function moveTargets(location: Pick<LocationView, 'id' | 'parentId'>, locations: readonly LocationView[]): LocationView[] {
  return locations.filter((other) => other.status === 'ACTIVE' && other.id !== location.id && other.id !== location.parentId && !wouldCycle(location.id, other.id, locations))
}

// ---- the new place ---------------------------------------------------------------------------------------------------------------

export interface NewPlaceForm {
  parentId: string | null
  code: string
  name: string
  kind: LocationKind
}

/** A sensible kind under a parent: a bin in a zone, a zone in a warehouse, a warehouse at the top. */
export function kindUnder(parent: Pick<LocationView, 'kind'> | null): LocationKind {
  if (!parent) return 'WAREHOUSE'
  if (parent.kind === 'WAREHOUSE') return 'ZONE'
  return 'BIN'
}

/** A code suggestion: the parent's code and the next free number ("N-MAG-A-03"), unique on the site. */
export function suggestCode(parent: Pick<LocationView, 'code' | 'id'> | null, locations: readonly Pick<LocationView, 'code' | 'parentId'>[]): string {
  const taken = new Set(locations.map((location) => location.code))
  const stem = parent ? `${parent.code}-` : 'LOC-'
  for (let n = 1; n < 1000; n++) {
    const code = `${stem}${String(n).padStart(2, '0')}`
    if (!taken.has(code) && code.length <= 40) return code
  }
  return ''
}

/** The new place's problems (keys of `warehouse-locations`), by field; empty when it may be created. */
export function newPlaceProblems(form: NewPlaceForm, locations: readonly Pick<LocationView, 'code'>[]): Partial<Record<'code' | 'name', string>> {
  const problems: Partial<Record<'code' | 'name', string>> = {}
  const code = normalizeLocationCode(form.code)
  if (!code) problems.code = 'lc.new.codeMissing'
  else if (!LOCATION_CODE.test(code)) problems.code = 'lc.new.codeShape'
  else if (locations.some((location) => location.code === code)) problems.code = 'lc.new.codeTaken'
  const name = form.name.trim()
  if (!name) problems.name = 'lc.new.nameMissing'
  else if (name.length > 120) problems.name = 'lc.new.nameLong'
  return problems
}

/** A refused write in this page's words (a key of `warehouse-locations`): the code taken, the parent, archive refused. */
export function locationWriteProblem(error: unknown): { key: string; field?: 'code' | 'name' | 'parent' } {
  if (!isApiError(error)) return { key: 'lc.problem.write' }
  const paths = error.issues.map(issuePath)
  if (error.kind === 'conflict' && error.code === 'conflict' && paths.length === 0 && /already has a location/i.test(error.message)) return { key: 'lc.new.codeTaken', field: 'code' }
  if (error.kind === 'conflict' && error.code === 'invalid_state') return { key: 'lc.problem.notNow' }
  if (error.kind === 'conflict') return { key: 'lc.problem.changed' }
  if (error.kind === 'invalid' && paths.some((path) => path.includes('parentId'))) return { key: 'lc.problem.parent', field: 'parent' }
  if (error.kind === 'invalid' && paths.some((path) => path.endsWith('code'))) return { key: 'lc.new.codeShape', field: 'code' }
  if (error.kind === 'invalid' && paths.some((path) => path.endsWith('name'))) return { key: 'lc.new.nameMissing', field: 'name' }
  if (error.kind === 'forbidden' || error.kind === 'step_up') return { key: 'lc.problem.forbidden' }
  if (error.kind === 'not_found') return { key: 'lc.problem.gone' }
  if (error.kind === 'unavailable') return { key: 'lc.problem.offline' }
  return { key: 'lc.problem.write' }
}

// ---- the address -------------------------------------------------------------------------------------------------------------------

export interface ListAddress {
  siteId: string | null
  archived: boolean
  q: string
}

export function listAddressOf(params: { get(name: string): string | null } | null): ListAddress {
  return { siteId: params?.get('site') ?? null, archived: params?.get('archived') === '1', q: params?.get('q') ?? '' }
}

export function listQuery(address: ListAddress): string {
  const query = new URLSearchParams()
  if (address.siteId) query.set('site', address.siteId)
  if (address.archived) query.set('archived', '1')
  if (address.q.trim()) query.set('q', address.q.trim())
  const text = query.toString()
  return text ? `?${text}` : ''
}

export const RECORD_TABS = ['overview', 'stock'] as const
export type RecordTab = (typeof RECORD_TABS)[number]
export const recordTabOf = (value: string | null | undefined): RecordTab => (RECORD_TABS.includes(value as RecordTab) ? (value as RecordTab) : 'overview')

/** The site the page shows: the address's, else the first by code (the API's sites of this company). */
export function chosenSite(sites: readonly SiteLocations[], siteId: string | null): SiteLocations | null {
  if (sites.length === 0) return null
  return sites.find((site) => site.id === siteId) ?? [...sites].sort((a, b) => a.code.localeCompare(b.code))[0]!
}

// ---- the record's stock ----------------------------------------------------------------------------------------------------------

/** The stock rows of a place, or of it and every place below it. */
export function recordStockRows(overview: StockOverview, locationId: string, locations: readonly Pick<LocationView, 'id' | 'parentId'>[], includeInside: boolean): StockRow[] {
  const ids = includeInside ? withPlacesInside(locationId, locations) : new Set([locationId])
  return overview.rows.filter((row) => ids.has(row.location.id))
}

/** The item's currency for a stock row's value (the overview's per-item totals carry it). */
export function currencyOf(overview: StockOverview | null, itemId: string): string | null {
  return overview?.items.find((entry) => entry.itemId === itemId)?.currency ?? null
}

/** Editing a place: the name (1–120) and the kind; the code never changes (printed on bin labels). */
export interface PlaceEdit {
  name: string
  kind: LocationKind
}
export const editOf = (location: Pick<LocationView, 'name' | 'kind'>): PlaceEdit => ({ name: location.name, kind: location.kind })
export function editChanges(saved: PlaceEdit, draft: PlaceEdit): number {
  return (saved.name !== draft.name.trim() ? 1 : 0) + (saved.kind !== draft.kind ? 1 : 0)
}
export const editProblem = (draft: PlaceEdit): string | null => (!draft.name.trim() ? 'lc.new.nameMissing' : draft.name.trim().length > 120 ? 'lc.new.nameLong' : null)

/** CSV columns of the list's export. */
export const CSV_COLUMNS = ['code', 'name', 'kind', 'status', 'path', 'inside', 'lines', 'hides', 'quantity'] as const
